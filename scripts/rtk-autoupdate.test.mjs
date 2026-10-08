import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  assetName, breakingNotes, detectInstall, functionalCheck, latestStable, parseChecksums, parseRtkPromotion, rtkPaths, rtkPromotionProblems, rtkRole, rtkRuntime,
  runVersion, upgradeRtk,
} from './rtk-autoupdate.mjs'

const BREAKING = '## [0.2.0]\n\n### ⚠ BREAKING CHANGES\n\n* **cli:** callers must pass the script explicitly, e.g. `rtk test --shell sh`.\n\n### Features\n\n* x'
// a stand-in rtk: `--version`, and `json <file>` (the servers' functional check) echoes the file back
const script = version => `#!/bin/sh\nif [ "$1" = json ]; then cat "$2"; exit 0; fi\necho "rtk ${version}"\n`

/** A throwaway rtk install + a fake GitHub (releases API with ETag, download host) on 127.0.0.1. */
async function fixture({ local = '0.1.0', latest = '0.2.0', breakingIn = null, checksums = true, digest = true, badSum = false, signature = false, apiStatus = 200, short = null } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rtk-au-'))
  const target = path.join(dir, 'bin/rtk')
  await fs.mkdir(path.dirname(target))
  await fs.writeFile(target, script(local), { mode: 0o755 })
  const pkg = path.join(dir, 'pkg')
  await fs.mkdir(pkg)
  await fs.writeFile(path.join(pkg, 'rtk'), script(latest), { mode: 0o755 })
  const tarball = path.join(dir, 'asset.tar.gz')
  execFileSync('/usr/bin/tar', ['-czf', tarball, '-C', pkg, 'rtk'])
  const archive = readFileSync(tarball)
  const sum = createHash('sha256').update(archive).digest('hex')
  const name = assetName()
  let apiHits = 0
  let base = ''
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/api/releases')) {
      apiHits += 1
      if (apiStatus !== 200) { res.writeHead(apiStatus, { 'retry-after': '120' }); res.end('{}'); return }
      if (req.headers['if-none-match'] === '"v1"') { res.writeHead(304); res.end(); return }
      const assets = [{ name, size: archive.length, digest: digest ? `sha256:${sum}` : null, browser_download_url: `${base}/dl/${name}` }]
      if (checksums) assets.push({ name: 'checksums.txt', size: 100, browser_download_url: `${base}/dl/checksums.txt` })
      if (signature) assets.push({ name: 'checksums.txt.sig', size: 10, browser_download_url: `${base}/dl/checksums.txt.sig` })
      res.writeHead(200, { 'content-type': 'application/json', etag: '"v1"' })
      res.end(JSON.stringify([
        { tag_name: `v${latest}`, body: breakingIn === latest ? BREAKING : 'fixes only', assets },
        { tag_name: 'v0.1.5', body: breakingIn === '0.1.5' ? BREAKING : 'fixes', assets: [] },
        { tag_name: 'v0.1.0', body: BREAKING, assets: [] },
      ]))
      return
    }
    // short: a transfer cut by the network — 'clean' ends a chunked body early, 'length' sends fewer bytes than announced
    if (req.url === `/dl/${name}` && short?.cut) {
      const half = archive.subarray(0, Math.floor(archive.length / 2))
      if (short.cut === 'clean') { res.writeHead(200); res.end(half) } else { res.writeHead(200, { 'content-length': archive.length }); res.write(half); res.socket.destroy() }
      return
    }
    if (req.url === `/dl/${name}`) { res.writeHead(200); res.end(archive); return }
    if (req.url === '/dl/checksums.txt') { res.writeHead(200); res.end(`${badSum ? '0'.repeat(64) : sum}  ${name}\n`); return }
    res.writeHead(404); res.end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`
  const runtime = path.join(dir, 'runtime')
  await fs.mkdir(runtime, { mode: 0o700 })
  await fs.writeFile(path.join(runtime, 'status.json'), JSON.stringify({ version: 1, rtkRelease: `v${latest}` }))
  const paths = rtkPaths(runtime)
  return {
    dir, target, paths, hits: () => apiHits,
    sum, name,
    // the Mac's behaviour unless a test picks a server role (the default role depends on the platform)
    deps: { env: { RTK_BIN: target }, home: dir, api: `${base}/api/releases`, allowHosts: ['127.0.0.1'], role: 'standalone' },
    async close() { server.close(); await fs.rm(dir, { recursive: true, force: true }) },
  }
}

test('checksums, breaking notes and the platform asset are parsed the way rtk publishes them', () => {
  const sums = parseChecksums(`${'a'.repeat(64)}  rtk-aarch64-apple-darwin.tar.gz\n${'b'.repeat(64)} *rtk.x86_64.rpm\n`)
  assert.equal(sums.get('rtk-aarch64-apple-darwin.tar.gz'), 'a'.repeat(64))
  assert.equal(sums.get('rtk.x86_64.rpm'), 'b'.repeat(64))
  assert.equal(assetName('darwin', 'arm64'), 'rtk-aarch64-apple-darwin.tar.gz')
  assert.equal(assetName('linux', 'x64'), 'rtk-x86_64-unknown-linux-musl.tar.gz')
  assert.equal(assetName('win32', 'x64'), null)
  const notes = breakingNotes([{ tag: 'v0.51.0', body: BREAKING }, { tag: 'v0.50.0', body: BREAKING }, { tag: 'v0.52.0', body: BREAKING, prerelease: true }], '0.50.0', 'v0.51.0')
  assert.deepEqual(notes.map(item => item.tag), ['v0.51.0'])
  assert.match(notes[0].note, /^cli: callers must pass the script explicitly/)
})

test('plan downloads and verifies against checksums.txt and the API digest, and changes nothing', async () => {
  const f = await fixture()
  try {
    const plan = await upgradeRtk({ mode: 'plan', paths: f.paths, deps: f.deps })
    assert.equal(plan.action, 'upgrade', JSON.stringify(plan))
    assert.deepEqual(plan.plan.verifiedBy, ['checksums.txt', 'GitHub asset digest'])
    assert.equal(plan.plan.from, '0.1.0')
    assert.equal(plan.plan.to, '0.2.0')
    assert.equal(await runVersion(f.target), '0.1.0')
    await assert.rejects(fs.access(f.paths.state), 'a plan records nothing')
    await upgradeRtk({ mode: 'plan', paths: f.paths, deps: f.deps })
    assert.equal(f.hits(), 1, 'the release list is cached once it knows the latest tag')
  } finally { await f.close() }
})

test('auto upgrades: backup, atomic swap, --version verified; the next run is up to date', async () => {
  const f = await fixture()
  try {
    const result = await upgradeRtk({ mode: 'auto', paths: f.paths, deps: f.deps })
    assert.equal(result.why, 'upgraded', JSON.stringify(result))
    assert.equal(await runVersion(f.target), '0.2.0')
    const state = JSON.parse(await fs.readFile(f.paths.state, 'utf8'))
    assert.equal(state.lastUpgrade.result, 'upgraded')
    assert.equal(await runVersion(state.lastUpgrade.backup), '0.1.0', 'the backup is the old binary')
    assert.equal((await upgradeRtk({ mode: 'auto', paths: f.paths, deps: f.deps })).why, 'up-to-date')
  } finally { await f.close() }
})

test('a checksum mismatch, missing checksums or an unverifiable signature refuse, and leave rtk alone', async () => {
  for (const [options, code] of [[{ badSum: true }, 'checksum-mismatch'], [{ checksums: false, digest: false }, 'no-checksum'], [{ signature: true }, 'signature']]) {
    const f = await fixture(options)
    try {
      const result = await upgradeRtk({ mode: 'auto', paths: f.paths, deps: f.deps })
      assert.equal(result.why, 'verify-failed', JSON.stringify(result))
      assert.equal(result.reasons[0].code, code)
      assert.equal(await runVersion(f.target), '0.1.0')
      assert.equal((await upgradeRtk({ mode: 'auto', paths: f.paths, deps: f.deps })).why, 'attempted', 'a release that failed verification is not retried automatically')
    } finally { await f.close() }
  }
})

test('only the API digest is enough when checksums.txt is absent', async () => {
  const f = await fixture({ checksums: false })
  try {
    const plan = await upgradeRtk({ mode: 'plan', paths: f.paths, deps: f.deps })
    assert.deepEqual(plan.plan.verifiedBy, ['GitHub asset digest'])
  } finally { await f.close() }
})

test('a breaking release in the range is held by auto; a manual upgrade with acceptBreaking goes through', async () => {
  const f = await fixture({ breakingIn: '0.1.5' })
  try {
    const held = await upgradeRtk({ mode: 'auto', paths: f.paths, deps: f.deps })
    assert.equal(held.why, 'breaking')
    assert.match(held.reasons[0].text, /^v0\.1\.5 声明了破坏性变更 · .*--accept-breaking$/)
    assert.match(held.reasons[0].items[0], /^v0\.1\.5: cli: callers must pass/)
    assert.equal(await runVersion(f.target), '0.1.0')
    const plan = await upgradeRtk({ mode: 'plan', paths: f.paths, deps: f.deps })
    assert.equal(plan.action, 'hold', 'the dry run still verifies, and says it would hold')
    assert.equal((await upgradeRtk({ mode: 'upgrade', paths: f.paths, deps: f.deps })).why, 'breaking')
    assert.equal((await upgradeRtk({ mode: 'upgrade', acceptBreaking: true, paths: f.paths, deps: f.deps })).why, 'upgraded')
    assert.equal(await runVersion(f.target), '0.2.0')
  } finally { await f.close() }
})

test('a binary that fails --version after the swap is rolled back and not retried', async () => {
  const f = await fixture()
  try {
    let calls = 0
    const real = await fs.realpath(f.target)
    const version = async binary => {
      if (binary === real && ++calls === 2) return null // the post-swap check
      return runVersion(binary)
    }
    const now = Date.now()
    const result = await upgradeRtk({ mode: 'auto', paths: f.paths, deps: { ...f.deps, version, now: () => now } })
    assert.equal(result.why, 'rolled-back', JSON.stringify(result))
    assert.equal(await runVersion(f.target), '0.1.0')
    const state = JSON.parse(await fs.readFile(f.paths.state, 'utf8'))
    assert.equal(state.lastUpgrade.result, 'rolled-back')
    assert.equal((await upgradeRtk({ mode: 'auto', paths: f.paths, deps: { ...f.deps, now: () => now + 60_000 } })).why, 'backoff')
    assert.equal((await upgradeRtk({ mode: 'auto', paths: f.paths, deps: { ...f.deps, now: () => now + 7 * 3600_000 } })).why, 'attempted')
  } finally { await f.close() }
})

test('GitHub rate limiting is honoured: the wait is recorded and the next run sends nothing', async () => {
  const f = await fixture({ apiStatus: 403 })
  try {
    const now = Date.now()
    const result = await upgradeRtk({ mode: 'auto', paths: f.paths, deps: { ...f.deps, now: () => now } })
    assert.equal(result.why, 'rate-limited')
    const state = JSON.parse(await fs.readFile(f.paths.state, 'utf8'))
    assert.equal(Date.parse(state.retryNotBefore), now + 120_000)
    assert.equal((await upgradeRtk({ mode: 'auto', paths: f.paths, deps: { ...f.deps, now: () => now + 60_000 } })).why, 'backoff')
    assert.equal(f.hits(), 1)
  } finally { await f.close() }
})

test('a Homebrew install is upgraded with brew, said so in the plan; disabled config does nothing', async () => {
  const f = await fixture()
  try {
    const cellar = path.join(f.dir, 'Cellar/rtk/0.1.0/bin/rtk')
    await fs.mkdir(path.dirname(cellar), { recursive: true })
    await fs.writeFile(cellar, script('0.1.0'), { mode: 0o755 })
    const link = path.join(f.dir, 'hb-rtk')
    await fs.symlink(cellar, link)
    assert.equal((await detectInstall({ env: { RTK_BIN: link }, home: f.dir })).method, 'homebrew')
    const plan = await upgradeRtk({ mode: 'plan', paths: f.paths, deps: { ...f.deps, env: { RTK_BIN: link } } })
    assert.equal(plan.action, 'brew')
    assert.equal(plan.command, 'brew upgrade rtk')
    await fs.writeFile(f.paths.config, JSON.stringify({ rtk: { enabled: false } }))
    assert.equal((await upgradeRtk({ mode: 'auto', paths: f.paths, deps: f.deps })).why, 'disabled')
    assert.equal(f.hits(), 0, 'neither the plan for brew nor a disabled run asks GitHub')
  } finally { await f.close() }
})

test('a Homebrew install that brew cannot upgrade yet backs off instead of running brew every round', async () => {
  const f = await fixture()
  try {
    const cellar = path.join(f.dir, 'Cellar/rtk/0.1.0/bin/rtk')
    await fs.mkdir(path.dirname(cellar), { recursive: true })
    await fs.writeFile(cellar, script('0.1.0'), { mode: 0o755 })
    const link = path.join(f.dir, 'hb-rtk')
    await fs.symlink(cellar, link)
    let brews = 0
    const deps = now => ({ ...f.deps, env: { RTK_BIN: link }, brew: async () => { brews += 1; return true }, now: () => now })
    const now = Date.now()
    assert.equal((await upgradeRtk({ mode: 'auto', paths: f.paths, deps: deps(now) })).why, 'error', 'the formula still has 0.1.0')
    assert.equal((await upgradeRtk({ mode: 'auto', paths: f.paths, deps: deps(now + 60_000) })).why, 'backoff')
    assert.equal(brews, 1)
    const state = JSON.parse(await fs.readFile(f.paths.state, 'utf8'))
    assert.ok(Date.parse(state.nextAttemptAt) >= now + 30 * 60_000)
    assert.equal((await upgradeRtk({ mode: 'auto', paths: f.paths, deps: deps(now + 31 * 60_000) })).why, 'error')
    assert.equal(brews, 2, 'retried after the backoff, not counted as the one attempt')
  } finally { await f.close() }
})

test('a target that is replaced while the release downloads is not overwritten, and the attempt is not spent', async () => {
  const f = await fixture()
  try {
    const now = Date.now()
    const version = async binary => {
      // the extracted binary is checked after the download: swap the installed file under the upgrader at that moment
      if (binary.includes(`${path.sep}unpacked${path.sep}`)) {
        const other = `${f.target}.other`
        await fs.writeFile(other, script('0.1.1'), { mode: 0o755 })
        await fs.rename(other, f.target)
      }
      return runVersion(binary)
    }
    const result = await upgradeRtk({ mode: 'auto', paths: f.paths, deps: { ...f.deps, version, now: () => now } })
    assert.equal(result.why, 'error', JSON.stringify(result))
    assert.equal(result.reasons[0].code, 'changed')
    assert.equal(await runVersion(f.target), '0.1.1', 'the file that took its place is left alone')
    const state = JSON.parse(await fs.readFile(f.paths.state, 'utf8'))
    assert.equal(state.attempts['v0.2.0'], undefined)
    assert.ok(Date.parse(state.nextAttemptAt) > now)
  } finally { await f.close() }
})

/* ── servers: preview trial, production promotion ───────────────────── */

const HOUR = 3_600_000
const POLICY = { soakMs: 24 * HOUR, maxAgeMs: 7 * 24 * HOUR }

test('role and state dir: explicit role wins, a Mac stays standalone, any other host is production; RTK_STATE_DIR before the old name', () => {
  assert.equal(rtkRole({ AUTOUPDATE_ROLE: 'preview' }, 'linux'), 'preview')
  assert.equal(rtkRole({}, 'linux'), 'production')
  assert.equal(rtkRole({ AUTOUPDATE_ROLE: 'staging' }, 'linux'), 'production')
  assert.equal(rtkRole({}, 'darwin'), 'standalone')
  assert.equal(rtkRole({ AUTOUPDATE_ROLE: 'production' }, 'darwin'), 'production')
  assert.equal(rtkRuntime({ RTK_STATE_DIR: '/srv/rtk', MAGPIE_UPSTREAM_RUNTIME: '/old' }, '/home/x'), '/srv/rtk')
  assert.equal(rtkRuntime({ MAGPIE_UPSTREAM_RUNTIME: '/old' }, '/home/x'), '/old')
  assert.equal(rtkRuntime({}, '/home/x'), '/home/x/.agents/crosery/magpie-upstream')
  assert.equal(latestStable([{ tag: 'v0.9.0' }, { tag: 'v0.10.0' }, { tag: 'v0.11.0', prerelease: true }, { tag: 'v1.0.0', draft: true }]), 'v0.10.0')
})

test('functional check: the real rtk json round trip, in a throwaway HOME', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rtk-fc-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  await fs.writeFile(path.join(dir, 'good'), script('0.2.0'), { mode: 0o755 })
  await fs.writeFile(path.join(dir, 'bad'), '#!/bin/sh\necho "rtk 0.2.0"\n', { mode: 0o755 })
  await fs.writeFile(path.join(dir, 'crash'), '#!/bin/sh\nexit 3\n', { mode: 0o755 })
  assert.equal((await functionalCheck(path.join(dir, 'good'))).ok, true)
  assert.match((await functionalCheck(path.join(dir, 'bad'))).detail, /输出不对/)
  assert.match((await functionalCheck(path.join(dir, 'crash'))).detail, /rtk json 失败/)
})

test('preview: latest from the releases list (no upstream check), trial with checks every run, one at a time, accepted after the soak', async () => {
  const f = await fixture()
  try {
    let clock = Date.UTC(2026, 9, 9, 3)
    const deps = () => ({ ...f.deps, role: 'preview', policy: POLICY, now: () => clock })
    await fs.rm(f.paths.status)
    const upgraded = await upgradeRtk({ mode: 'auto', paths: f.paths, deps: deps() })
    assert.equal(upgraded.why, 'upgraded', JSON.stringify(upgraded))
    let state = JSON.parse(await fs.readFile(f.paths.state, 'utf8'))
    assert.deepEqual([state.role, state.trial.status, state.trial.version, state.trial.sha256, state.trial.checks.length], ['preview', 'soaking', '0.2.0', f.sum, 1])
    assert.equal(state.trial.soakUntil, new Date(Date.UTC(2026, 9, 9, 3) + 24 * HOUR).toISOString(), 'the console shows when the soak ends')
    clock += 6 * HOUR
    // a newer release meanwhile does not interrupt the trial
    const cache = JSON.parse(await fs.readFile(f.paths.cache, 'utf8'))
    await fs.writeFile(f.paths.cache, JSON.stringify({ ...cache, fetchedAt: new Date(clock).toISOString(), releases: [{ tag: 'v0.3.0', draft: false, prerelease: false, body: '', assets: [] }, ...cache.releases] }))
    const soaking = await upgradeRtk({ mode: 'auto', paths: f.paths, deps: deps() })
    assert.deepEqual([soaking.why, soaking.soakUntil], ['soaking', new Date(Date.UTC(2026, 9, 9, 3) + 24 * HOUR).toISOString()])
    clock += 19 * HOUR
    const accepted = await upgradeRtk({ mode: 'auto', paths: f.paths, deps: deps() })
    assert.equal(accepted.why, 'accepted')
    state = JSON.parse(await fs.readFile(f.paths.state, 'utf8'))
    assert.deepEqual([state.accepted.version, state.accepted.status, state.accepted.checks.length], ['0.2.0', 'accepted', 3])
    // what the coordinator forwards from this state is what production accepts
    const record = parseRtkPromotion({ version: 1, kind: 'rtk-promotion', candidate: { version: state.accepted.version, tag: state.accepted.tag, sha256: state.accepted.sha256, asset: state.accepted.asset },
      installedAt: state.accepted.installedAt, checks: state.accepted.checks, acceptedAt: state.accepted.acceptedAt })
    assert.deepEqual(rtkPromotionProblems({ record, asset: f.name, now: clock, policy: POLICY }), [])
  } finally { await f.close() }
})

test('preview: a failing check during the trial restores the previous binary and rejects the version for good', async () => {
  const f = await fixture()
  try {
    let clock = Date.UTC(2026, 9, 9, 3)
    let broken = false
    const deps = () => ({ ...f.deps, role: 'preview', policy: POLICY, now: () => clock, functional: async binary => (broken ? { ok: false, detail: 'rtk json 失败：boom' } : functionalCheck(binary)) })
    assert.equal((await upgradeRtk({ mode: 'auto', paths: f.paths, deps: deps() })).why, 'upgraded')
    broken = true
    clock += 2 * HOUR
    const failed = await upgradeRtk({ mode: 'auto', paths: f.paths, deps: deps() })
    assert.deepEqual([failed.why, failed.result], ['trial-failed', 'rolled-back'])
    assert.match(failed.reasons[0].text, /检查没过：rtk json 失败：boom，已换回 0\.1\.0/)
    assert.equal(await runVersion(f.target), '0.1.0')
    broken = false
    clock += 30 * HOUR
    assert.equal((await upgradeRtk({ mode: 'auto', paths: f.paths, deps: deps() })).why, 'attempted', 'a rejected trial is not installed again')
  } finally { await f.close() }
})

test('preview and production: a binary that fails the functional check right after the swap is put back at once', async () => {
  const f = await fixture()
  try {
    const result = await upgradeRtk({ mode: 'auto', paths: f.paths, deps: { ...f.deps, role: 'preview', functional: async () => ({ ok: false, detail: 'rtk json 输出不对' }) } })
    assert.equal(result.why, 'rolled-back')
    assert.match(result.reasons[0].text, /functional check failed \(rtk json 输出不对\); restored 0\.1\.0/)
    assert.equal(await runVersion(f.target), '0.1.0')
  } finally { await f.close() }
})

test('production: never the latest by itself; only the promoted version with the very archive preview accepted', async () => {
  const f = await fixture()
  try {
    const now = Date.UTC(2026, 9, 9, 3)
    const deps = { ...f.deps, role: 'production', policy: POLICY, now: () => now }
    const record = (over = {}) => ({ version: 1, kind: 'rtk-promotion', candidate: { version: '0.2.0', tag: 'v0.2.0', sha256: f.sum, asset: f.name },
      installedAt: new Date(now - 48 * HOUR).toISOString(), checks: [{ at: new Date(now - 48 * HOUR).toISOString(), ok: true }, { at: new Date(now - 23 * HOUR).toISOString(), ok: true }],
      acceptedAt: new Date(now - 23 * HOUR).toISOString(), ...over })
    const waiting = await upgradeRtk({ mode: 'auto', paths: f.paths, deps })
    assert.deepEqual([waiting.why, waiting.reasons[0].code], ['not-promoted', 'not-promoted'])
    assert.equal(await runVersion(f.target), '0.1.0')
    for (const [over, code] of [
      [{ acceptedAt: new Date(now - 8 * 24 * HOUR).toISOString() }, 'stale'],
      [{ checks: [{ at: new Date(now - 48 * HOUR).toISOString(), ok: true }, { at: new Date(now - 40 * HOUR).toISOString(), ok: true }] }, 'soak'],
      [{ checks: [{ at: new Date(now - 47 * HOUR).toISOString(), ok: true }, { at: new Date(now - 23 * HOUR).toISOString(), ok: false }] }, 'checks'],
      [{ candidate: { version: '0.2.0', tag: 'v0.2.0', sha256: f.sum, asset: 'rtk-aarch64-unknown-linux-gnu.tar.gz' } }, 'asset'],
    ]) {
      await fs.writeFile(f.paths.promotion, JSON.stringify(record(over)))
      const refused = await upgradeRtk({ mode: 'auto', paths: f.paths, deps })
      assert.deepEqual([refused.why, refused.reasons.map(item => item.code).includes(code)], ['not-promoted', true], code)
      assert.equal(await runVersion(f.target), '0.1.0')
    }
    // a record for another archive: downloaded, verified against GitHub, then refused before the swap, and not retried
    await fs.writeFile(f.paths.promotion, JSON.stringify(record({ candidate: { version: '0.2.0', tag: 'v0.2.0', sha256: 'e'.repeat(64), asset: f.name } })))
    const mismatch = await upgradeRtk({ mode: 'auto', paths: f.paths, deps })
    assert.deepEqual([mismatch.why, mismatch.reasons[0].code], ['verify-failed', 'promotion-mismatch'])
    assert.equal(await runVersion(f.target), '0.1.0')
    assert.equal((await upgradeRtk({ mode: 'auto', paths: f.paths, deps })).why, 'attempted', 'a version that failed verification is not retried by itself')
    // the right record: installed, with backup, sha256 and the record it relied on
    const g = await fixture()
    try {
      await fs.writeFile(g.paths.promotion, JSON.stringify({ ...record(), candidate: { version: '0.2.0', tag: 'v0.2.0', sha256: g.sum, asset: g.name } }))
      const done = await upgradeRtk({ mode: 'auto', paths: g.paths, deps: { ...g.deps, role: 'production', policy: POLICY, now: () => now } })
      assert.equal(done.why, 'upgraded', JSON.stringify(done))
      assert.equal(await runVersion(g.target), '0.2.0')
      const state = JSON.parse(await fs.readFile(g.paths.state, 'utf8'))
      assert.deepEqual([state.lastUpgrade.sha256, state.lastUpgrade.promotedAt, state.trial], [g.sum, record().acceptedAt, null])
    } finally { await g.close() }
  } finally { await f.close() }
})

test('cli: runs when started through a symlinked release path (systemd uses /opt/crosery-api-console-current)', async t => {
  const { fileURLToPath } = await import('node:url')
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rtk-cli-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const link = path.join(dir, 'current')
  await fs.symlink(path.dirname(fileURLToPath(import.meta.url)), link)
  const out = execFileSync(process.execPath, [path.join(link, 'rtk-autoupdate.mjs'), 'status'], {
    encoding: 'utf8', env: { ...process.env, RTK_STATE_DIR: path.join(dir, 'state'), RTK_BIN: path.join(dir, 'none'), AUTOUPDATE_ROLE: 'preview' },
  })
  const status = JSON.parse(out)
  assert.deepEqual([status.role, status.install.method], ['preview', 'missing'])
})

test('a download cut short is the network: retried after a backoff, never "failed verification"', async () => {
  for (const cut of ['clean', 'length']) {
    const short = { cut }
    const f = await fixture({ short })
    try {
      let clock = Date.UTC(2026, 9, 9, 3)
      const deps = { ...f.deps, now: () => clock }
      const result = await upgradeRtk({ mode: 'auto', paths: f.paths, deps })
      assert.equal(result.why, 'error', `${cut}: ${JSON.stringify(result)}`)
      assert.match(result.reasons[0].text, /下载失败/)
      assert.equal(await runVersion(f.target), '0.1.0')
      const state = JSON.parse(await fs.readFile(f.paths.state, 'utf8'))
      assert.equal(state.attempts['v0.2.0'] ?? 0, 0, 'the attempt is not spent')
      assert.ok(Date.parse(state.nextAttemptAt) > clock)
      // the network is back after the backoff: the same release goes in
      short.cut = null
      clock = Date.parse(state.nextAttemptAt) + 1000
      assert.equal((await upgradeRtk({ mode: 'auto', paths: f.paths, deps })).why, 'upgraded')
    } finally { await f.close() }
  }
})
