import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('../deploy/kernels/cpa-builder/run.sh', import.meta.url))

// Real local Git history; only Docker, smoke and the SSH gate are stand-ins. No remote access.
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
    CPA_PIPELINE_ROOT: root, CPA_PIPELINE_VPS: path.join(bin, 'gate'), PATH: `${bin}:${process.env.PATH}` }
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
  await executable('gate', `
    echo "$*" >> "$CPA_PIPELINE_ROOT/calls"
    case "$1" in
      cpa-version) echo 'CLIProxyAPI Version: 7.3.15-patched.fixture, Commit: fixture';;
      cpa-state) printf '{"staged":{"version":"%s"}}\\n' "\${FAKE_STAGED:-}";;
      cpa-upload) cat >/dev/null; [ "\${FAKE_UPLOAD_FAIL:-}" != 1 ];;
      cpa-stage*) :;;
      cpa-report) cat > "$CPA_PIPELINE_ROOT/received.json";;
      *) exit 2;;
    esac
  `)
  await fs.writeFile(path.join(root, 'tools', 'cpa-smoke.mjs'), `
    const ok = process.env.FAKE_SMOKE_FAIL !== '1'
    console.log(JSON.stringify({ ok, checks: [{ name: 'fixture-smoke', ok }] }))
    process.exit(ok ? 0 : 1)
  `)
  const run = async (over = {}) => {
    const out = spawnSync('bash', [script], { env: { ...env, ...over }, encoding: 'utf8', timeout: 15_000 })
    assert.equal(out.error, undefined)
    return { code: out.status, report: JSON.parse(await fs.readFile(path.join(root, 'received.json'), 'utf8')),
      calls: await fs.readFile(path.join(root, 'calls'), 'utf8') }
  }
  return { root, src, upstream, fork, git, run }
}

for (const tag of ['v7.3.20', 'v7.4.0', 'v8.0.12']) {
  test(`builder: follows latest stable ${tag}, including minor/major; never installs`, async t => {
    const b = await builder(t, { tag })
    const { code, report, calls } = await b.run()
    assert.equal(code, 0)
    assert.equal(report.status, 'built')
    assert.equal(report.upstreamLatest, tag)
    assert.equal(report.base, tag)
    assert.equal(report.line, tag.slice(0, tag.lastIndexOf('.')))
    assert.equal(report.heldNewer, null)
    assert.equal(report.candidate.version, `${tag.slice(1)}-patched.${b.git(b.src, 'rev-parse', '--short=8', 'HEAD')}`)
    assert.equal(b.git(b.src, 'show', 'HEAD:config.txt'), 'fork patch')
    assert.equal(b.git(b.src, 'show', 'HEAD:upstream.txt'), 'new release')
    assert.match(calls, /docker\n/)
    assert.match(calls, /cpa-upload\n/)
    assert.match(calls, /cpa-stage /)
    assert.doesNotMatch(calls, /cpa-install/)
    const cached = await b.run({ FAKE_STAGED: report.candidate.version })
    assert.equal(cached.code, 0)
    assert.equal(cached.report.status, 'built')
    assert.equal(cached.calls.split('\n').filter(c => c === 'docker').length, 1)
  })
}

test('builder: merge conflict is aborted, fork kept, candidate not uploaded', async t => {
  const b = await builder(t, { conflict: true })
  const { code, report, calls } = await b.run()
  assert.equal(code, 1)
  assert.equal(report.status, 'merge-conflict')
  assert.equal(report.heldNewer.tag, 'v8.0.12')
  assert.equal(report.candidate, null)
  assert.equal(b.git(b.src, 'rev-parse', 'HEAD'), b.fork)
  assert.equal(b.git(b.src, 'status', '--porcelain'), '')
  assert.match(report.reasons[0].text, /config.txt$/)
  assert.doesNotMatch(calls, /docker|cpa-upload|cpa-stage/)
})

for (const [failure, status] of [['FAKE_BUILD_FAIL', 'build-failed'], ['FAKE_SMOKE_FAIL', 'smoke-failed'], ['FAKE_UPLOAD_FAIL', 'upload-failed']]) {
  test(`builder: ${status} stops before stage/install`, async t => {
    const b = await builder(t)
    const { code, report, calls } = await b.run({ [failure]: '1' })
    assert.equal(code, 1)
    assert.equal(report.status, status)
    assert.doesNotMatch(calls, /cpa-stage|cpa-install/)
    if (status !== 'upload-failed') assert.doesNotMatch(calls, /cpa-upload/)
  })
}

test('builder: fetch failure does not build cached upstream tags', async t => {
  const b = await builder(t)
  b.git(b.src, 'remote', 'set-url', 'upstream', path.join(b.root, 'missing'))
  const { code, report, calls } = await b.run()
  assert.equal(code, 1)
  assert.equal(report.status, 'fetch-failed')
  assert.doesNotMatch(calls, /docker|cpa-upload|cpa-stage/)
})

test('builder: failed checkout preserves unfinished edits and never builds another branch', async t => {
  const b = await builder(t)
  b.git(b.src, 'checkout', '-qb', 'scratch', 'v7.3.15')
  await fs.writeFile(path.join(b.src, 'config.txt'), 'unfinished local edit\n')
  const { code, report, calls } = await b.run()
  assert.equal(code, 1)
  assert.equal(report.status, 'held')
  assert.equal(b.git(b.src, 'branch', '--show-current'), 'scratch')
  assert.equal(await fs.readFile(path.join(b.src, 'config.txt'), 'utf8'), 'unfinished local edit\n')
  assert.doesNotMatch(calls, /docker|cpa-upload|cpa-stage/)
})
