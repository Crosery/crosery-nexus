import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('../deploy/kernels/cpa-builder/run.sh', import.meta.url))
const TOOLS = ['cpa-coordinator.mjs', 'cpa-acceptance.mjs', 'autoupdate-common.mjs']

// Real local Git history and the real coordinator; only Docker, smoke and the two SSH gates are stand-ins. No remote access.
async function builder(t, { tag = 'v8.0.12', conflict = false } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cpa-builder-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const root = path.join(dir, 'pipeline')
  const src = path.join(root, 'src')
  const upstream = path.join(dir, 'upstream')
  const bin = path.join(dir, 'bin')
  for (const p of [upstream, bin, path.join(root, 'tools')]) await fs.mkdir(p, { recursive: true })
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    CPA_PIPELINE_ROOT: root, CPA_PIPELINE_PREVIEW: path.join(bin, 'gate-preview'), CPA_PIPELINE_PRODUCTION: path.join(bin, 'gate-production'),
    CPA_ACCEPT_BASE_URL: 'http://127.0.0.1:9', CPA_ACCEPT_KEY: 'sk-fixture-accept-000000', CPA_ACCEPT_MODELS: 'm1', PATH: `${bin}:${process.env.PATH}` }
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git(upstream, 'init', '-q', '-b', 'main')
  await fs.writeFile(path.join(upstream, 'config.txt'), 'base\n')
  git(upstream, 'add', 'config.txt')
  git(upstream, 'commit', '-qm', 'base')
  git(upstream, 'tag', 'v7.3.15')
  git(root, 'clone', '-q', '--origin', 'upstream', upstream, src)
  git(src, 'checkout', '-qb', 'deploy')
  await fs.writeFile(path.join(src, 'config.txt'), 'fork patch\n')
  git(src, 'commit', '-qam', 'fork patch')
  const fork = git(src, 'rev-parse', 'HEAD')
  const change = conflict ? 'config.txt' : 'upstream.txt'
  await fs.writeFile(path.join(upstream, change), 'new release\n')
  git(upstream, 'add', change)
  git(upstream, 'commit', '-qm', 'release')
  git(upstream, 'tag', tag)
  git(upstream, 'tag', 'v99.0.0-rc1')

  const executable = (name, body) => fs.writeFile(path.join(bin, name), `#!/bin/bash\n${body}`, { mode: 0o755 })
  await fs.symlink(process.execPath, path.join(bin, 'node'))
  await executable('flock', 'exit 0\n')
  await executable('sha256sum', 'exec shasum -a 256 "$@"\n')
  await executable('docker', `
    echo docker >> "$CPA_PIPELINE_ROOT/calls"
    [ "\${FAKE_BUILD_FAIL:-}" != 1 ] || { echo 'FAIL fake build'; exit 1; }
    for arg in "$@"; do case "$arg" in VERSION=*) version=\${arg#VERSION=};; esac; done
    printf '#!/bin/bash\\necho "CLIProxyAPI Version: %s, Commit: fixture"\\n' "$version" > "$CPA_PIPELINE_ROOT/src/.pipeline-out/cli-proxy-api"
    chmod 755 "$CPA_PIPELINE_ROOT/src/.pipeline-out/cli-proxy-api"
    echo 'tests passed'
  `)
  for (const role of ['preview', 'production']) {
    const upper = role.toUpperCase()
    await executable(`gate-${role}`, `
      echo "$*" >> "$CPA_PIPELINE_ROOT/calls-${role}"
      case "$1" in
        cpa-state) state=\${FAKE_${upper}_STATE:-}; [ -n "$state" ] || state='{"installed":{"version":"7.3.15-patched.fixture"}}'; printf '%s\\n' "$state";;
        cpa-upload) cat > "$CPA_PIPELINE_ROOT/upload-${role}.gz"; [ "\${FAKE_UPLOAD_FAIL:-}" != ${role} ];;
        cpa-stage*) :;;
        cpa-report) cat > "$CPA_PIPELINE_ROOT/received-${role}.json";;
        cpa-promotion) record=\${FAKE_PROMOTION:-}; printf '%s\\n' "\${record:-null}";;
        cpa-accept|cpa-promote|rtk-promote) cat > "$CPA_PIPELINE_ROOT/$1-${role}.json";;
        rtk-state) echo '{}';;
        *) exit 2;;
      esac
    `)
  }
  for (const name of TOOLS) await fs.copyFile(fileURLToPath(new URL(`./${name}`, import.meta.url)), path.join(root, 'tools', name))
  await fs.writeFile(path.join(root, 'tools', 'cpa-smoke.mjs'), `
    const ok = process.env.FAKE_SMOKE_FAIL !== '1'
    console.log(JSON.stringify({ ok, checks: [{ name: 'fixture-smoke', ok }] }))
    process.exit(ok ? 0 : 1)
  `)
  const read = async name => fs.readFile(path.join(root, name), 'utf8').catch(() => '')
  const run = async (over = {}) => {
    for (const name of ['calls', 'calls-preview', 'calls-production', 'received-preview.json', 'received-production.json']) await fs.rm(path.join(root, name), { force: true })
    const out = spawnSync('bash', [script], { env: { ...env, ...over }, encoding: 'utf8', timeout: 30_000 })
    assert.equal(out.error, undefined)
    const report = await read('received-preview.json')
    const production = await read('received-production.json')
    return { code: out.status, stderr: out.stderr, report: report ? JSON.parse(report) : null, production: production ? JSON.parse(production) : null,
      calls: await read('calls'), preview: await read('calls-preview'), prod: await read('calls-production'), log: await read('logs/pipeline.log') }
  }
  return { root, src, upstream, fork, git, run, read, env }
}

for (const tag of ['v7.3.20', 'v7.4.0', 'v8.0.12']) {
  test(`builder: follows latest stable ${tag}, including minor/major; uploads to preview only; never installs`, async t => {
    const b = await builder(t, { tag })
    const { code, report, production, calls, preview, prod } = await b.run()
    assert.equal(code, 0)
    assert.equal(report.status, 'built')
    assert.equal(report.upstreamLatest, tag)
    assert.equal(report.base, tag)
    assert.equal(report.line, tag.slice(0, tag.lastIndexOf('.')))
    assert.equal(report.heldNewer, null)
    const version = `${tag.slice(1)}-patched.${b.git(b.src, 'rev-parse', '--short=8', 'HEAD')}`
    assert.equal(report.candidate.version, version)
    assert.deepEqual(report.preview, { version, stage: 'uploaded', soakUntil: null, at: report.preview.at, reason: null })
    assert.equal(b.git(b.src, 'show', 'HEAD:config.txt'), 'fork patch')
    assert.equal(b.git(b.src, 'show', 'HEAD:upstream.txt'), 'new release')
    assert.match(calls, /docker\n/)
    assert.match(preview, /cpa-upload\n/)
    assert.match(preview, new RegExp(`cpa-stage ${version.replaceAll('.', '\\.')}\n`))
    assert.doesNotMatch(prod, /cpa-upload|cpa-stage|cpa-promote/, 'production gets nothing before preview accepted it')
    assert.equal(production.candidate.version, version, 'production still sees the round')
    assert.doesNotMatch(`${preview}${prod}`, /cpa-install/)
    const stored = JSON.parse(await b.read(`state/candidates/${version}/candidate.json`))
    assert.equal(stored.sha256, report.candidate.sha256)
    const uploaded = gunzipSync(await fs.readFile(path.join(b.root, 'upload-preview.gz')))
    assert.equal(createHash('sha256').update(uploaded).digest('hex'), stored.sha256, 'the gate receives the stored binary, gzip-compressed')
    // the next round: built before (same commit) → no docker; staged on preview already → no second upload
    const cached = await b.run({ FAKE_PREVIEW_STATE: JSON.stringify({ installed: { version: '7.3.15-patched.fixture' }, staged: { version } }) })
    assert.equal(cached.code, 0)
    assert.equal(cached.report.status, 'built')
    assert.equal(cached.calls, '')
    assert.doesNotMatch(cached.preview, /cpa-upload/)
  })
}

test('builder: merge conflict is aborted, fork kept, candidate not uploaded', async t => {
  const b = await builder(t, { conflict: true })
  const { code, report, production, calls, preview } = await b.run()
  assert.equal(code, 1)
  assert.equal(report.status, 'merge-conflict')
  assert.equal(production.status, 'merge-conflict', 'both consoles see why')
  assert.equal(report.heldNewer.tag, 'v8.0.12')
  assert.equal(report.candidate, null)
  assert.equal(b.git(b.src, 'rev-parse', 'HEAD'), b.fork)
  assert.equal(b.git(b.src, 'status', '--porcelain'), '')
  assert.match(report.reasons[0].text, /config.txt$/)
  assert.doesNotMatch(`${calls}${preview}`, /docker|cpa-upload|cpa-stage/)
})

for (const [failure, value, status] of [['FAKE_BUILD_FAIL', '1', 'build-failed'], ['FAKE_SMOKE_FAIL', '1', 'smoke-failed'], ['FAKE_UPLOAD_FAIL', 'preview', 'upload-failed']]) {
  test(`builder: ${status} stops before anything is staged`, async t => {
    const b = await builder(t)
    const { code, report, preview, prod } = await b.run({ [failure]: value })
    assert.equal(code, 1)
    assert.equal(report.status, status)
    assert.doesNotMatch(`${preview}${prod}`, /cpa-stage|cpa-install/)
    if (status !== 'upload-failed') assert.doesNotMatch(preview, /cpa-upload/)
  })
}

test('builder: fetch failure does not build cached upstream tags', async t => {
  const b = await builder(t)
  b.git(b.src, 'remote', 'set-url', 'upstream', path.join(b.root, 'missing'))
  const { code, report, calls, preview } = await b.run()
  assert.equal(code, 1)
  assert.equal(report.status, 'fetch-failed')
  assert.doesNotMatch(`${calls}${preview}`, /docker|cpa-upload|cpa-stage/)
})

test('builder: failed checkout preserves unfinished edits and never builds another branch', async t => {
  const b = await builder(t)
  b.git(b.src, 'checkout', '-qb', 'scratch', 'v7.3.15')
  await fs.writeFile(path.join(b.src, 'config.txt'), 'unfinished local edit\n')
  const { code, report, calls, preview } = await b.run()
  assert.equal(code, 1)
  assert.equal(report.status, 'held')
  assert.equal(b.git(b.src, 'branch', '--show-current'), 'scratch')
  assert.equal(await fs.readFile(path.join(b.src, 'config.txt'), 'utf8'), 'unfinished local edit\n')
  assert.doesNotMatch(`${calls}${preview}`, /docker|cpa-upload|cpa-stage/)
})

test('builder: no gate targets in pipeline.env → fails before building anything', async t => {
  const b = await builder(t)
  const out = spawnSync('bash', [script], { env: { ...b.env, CPA_PIPELINE_PRODUCTION: '' }, encoding: 'utf8', timeout: 15_000 })
  assert.notEqual(out.status, 0)
  assert.match(out.stderr, /CPA_PIPELINE_PRODUCTION is not set/)
  assert.equal(await b.read('calls'), '')
  // the targets may also come from pipeline.env next to the pipeline (never from the repo)
  await fs.writeFile(path.join(b.root, 'pipeline.env'), `CPA_PIPELINE_PRODUCTION=${path.join(b.root, '..', 'bin', 'gate-production')}\n`)
  const { code } = await b.run({ CPA_PIPELINE_PRODUCTION: '' })
  assert.equal(code, 0)
})

test('builder: an accepted trial on preview is delivered to production with its record; a record for another build delivers nothing', async t => {
  const b = await builder(t)
  const first = await b.run()
  const version = first.report.candidate.version
  const sha256 = first.report.candidate.sha256
  const run = ok => ({ at: '2026-10-08T01:00:00.000Z', ok, checks: [] })
  const trial = { version, sha256, status: 'accepted', installedAt: '2026-10-07T00:00:00.000Z', soakUntil: '2026-10-08T00:00:00.000Z', acceptedAt: '2026-10-08T01:00:00.000Z' }
  const record = { version: 1, kind: 'cpa-promotion', candidate: { version, sha256 }, installedAt: trial.installedAt, soakMs: 86_400_000,
    acceptance: { first: run(true), soak: run(true) }, acceptedAt: trial.acceptedAt }
  const out = await b.run({ FAKE_PREVIEW_STATE: JSON.stringify({ installed: { version }, trial }), FAKE_PROMOTION: JSON.stringify(record) })
  assert.equal(out.code, 0, out.log)
  assert.match(out.prod, new RegExp(`cpa-upload\ncpa-stage ${version.replaceAll('.', '\\.')}\ncpa-promote\ncpa-report\n`))
  assert.deepEqual(JSON.parse(await b.read('cpa-promote-production.json')), record)
  assert.equal(out.production.preview.stage, 'delivered')
  // the record is for another build of that version: nothing goes to production
  const other = await b.run({ FAKE_PREVIEW_STATE: JSON.stringify({ installed: { version }, trial }), FAKE_PROMOTION: JSON.stringify({ ...record, candidate: { version, sha256: 'f'.repeat(64) } }) })
  assert.equal(other.code, 1)
  assert.doesNotMatch(other.prod, /cpa-upload/)
})
