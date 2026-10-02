import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { assetName, breakingNotes, detectInstall, parseChecksums, rtkPaths, runVersion, upgradeRtk } from './rtk-autoupdate.mjs'

const BREAKING = '## [0.2.0]\n\n### ⚠ BREAKING CHANGES\n\n* **cli:** callers must pass the script explicitly, e.g. `rtk test --shell sh`.\n\n### Features\n\n* x'
const script = version => `#!/bin/sh\necho "rtk ${version}"\n`

/** A throwaway rtk install + a fake GitHub (releases API with ETag, download host) on 127.0.0.1. */
async function fixture({ local = '0.1.0', latest = '0.2.0', breakingIn = null, checksums = true, digest = true, badSum = false, signature = false, apiStatus = 200 } = {}) {
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
    deps: { env: { RTK_BIN: target }, home: dir, api: `${base}/api/releases`, allowHosts: ['127.0.0.1'] },
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
