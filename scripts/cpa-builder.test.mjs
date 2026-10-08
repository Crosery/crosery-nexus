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
    printf '%s\\n' "$@" > "$CPA_PIPELINE_ROOT/docker-args"
    [ "\${FAKE_BUILD_FAIL:-}" != 1 ] || { echo 'FAIL fake build'; exit 1; }
    echo go1.26.5 > "$CPA_PIPELINE_ROOT/src/.pipeline-out/go-version"
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
    // reproducible: the pinned image, the commit's own time as BUILD_DATE, recorded with the go version
    const args = (await b.read('docker-args')).split('\n')
    const image = 'golang:1.26.5-bookworm@sha256:53eeac89074db483fdf0ab3be1df32bf6e47562263d2d0d6baa7f26acb4957dd'
    const committed = new Date(Number(b.git(b.src, 'log', '-1', '--format=%ct', 'HEAD')) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
    assert.ok(args.includes(image))
    assert.ok(args.includes(`BUILD_DATE=${committed}`), args.join(' '))
    assert.ok(['CGO_ENABLED=0', 'GOFLAGS=-buildvcs=false', 'GOOS=linux', 'GOARCH=amd64'].every(arg => args.includes(arg)))
    assert.deepEqual(stored.build, { go: 'go1.26.5', buildDate: committed, image })
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

test('builder: a Go image that is not pinned by digest is refused before anything runs', async t => {
  const b = await builder(t)
  for (const image of ['golang:1.26.5-bookworm', 'golang:latest@sha256:abc']) {
    const out = spawnSync('bash', [script], { env: { ...b.env, CPA_GO_IMAGE: image }, encoding: 'utf8', timeout: 15_000 })
    assert.equal(out.status, 2, image)
    assert.match(out.stderr, /pinned by digest/)
  }
  assert.equal(await b.read('calls'), '')
  const mirror = `mirror.example/library/golang:1.26.5-bookworm@sha256:${'5'.repeat(64)}`
  const { code } = await b.run({ CPA_GO_IMAGE: mirror })
  assert.equal(code, 0)
  assert.ok((await b.read('docker-args')).split('\n').includes(mirror))
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

/* ── the patch series: deploy = <tag> + whatever *.patch files the series directory holds ── */

async function series(b, tag, patches) {
  const dir = path.join(b.root, 'patches', tag)
  await fs.rm(dir, { recursive: true, force: true })
  await fs.mkdir(dir, { recursive: true })
  const sums = []
  for (const [name, text] of patches) {
    await fs.writeFile(path.join(dir, name), text)
    sums.push(`${createHash('sha256').update(text).digest('hex')}  ${name}`)
  }
  await fs.writeFile(path.join(dir, 'SHA256SUMS'), `${sums.join('\n')}\n`)
  return dir
}

/** format-patch of the fork commit plus `extra` more commits on top of it, from a scratch clone */
async function porting(b, extra = []) {
  const work = path.join(b.root, '..', `port-${extra.length}`)
  b.git(b.root, 'clone', '-q', b.src, work)
  b.git(work, 'checkout', '-q', '-b', 'port', b.fork)
  for (const [file, text, message] of extra) {
    await fs.writeFile(path.join(work, file), text)
    b.git(work, 'add', file)
    b.git(work, 'commit', '-qm', message)
  }
  const out = path.join(work, '.patches')
  b.git(work, 'format-patch', '-q', '-o', out, 'v7.3.15..port')
  const names = (await fs.readdir(out)).sort()
  return { head: b.git(work, 'rev-parse', 'HEAD'), patches: await Promise.all(names.map(async name => [name, await fs.readFile(path.join(out, name), 'utf8')])) }
}

test('builder: deploy is rebuilt from the newest series directory, every patch in it, same HEAD as the porting repo', async t => {
  const b = await builder(t)
  const one = await porting(b)
  assert.equal(one.head, b.fork)
  await series(b, 'v7.3.15', one.patches)
  // an older series next to it is ignored
  await series(b, 'v7.3.9', [['0001-old.patch', 'not applied\n']])
  b.git(b.src, 'reset', '-q', '--hard', 'v7.3.15') // whatever deploy was, the series decides
  const first = await b.run()
  assert.equal(first.code, 0, first.log)
  assert.equal(b.git(b.src, 'rev-parse', 'deploy^1'), b.fork, 'the series HEAD reproduces the porting repo commit, then upstream is merged')
  assert.equal(b.git(b.src, 'show', 'HEAD:config.txt'), 'fork patch')
  assert.equal(b.git(b.src, 'show', 'HEAD:upstream.txt'), 'new release')
  const candidate = JSON.parse(await b.read(`state/candidates/${first.report.candidate.version}/candidate.json`))
  assert.deepEqual([candidate.series, candidate.patches], ['v7.3.15', 1])
  // unchanged series: deploy is not rebuilt (the merge stays)
  const head = b.git(b.src, 'rev-parse', 'deploy')
  assert.equal((await b.run()).code, 0)
  assert.equal(b.git(b.src, 'rev-parse', 'deploy'), head)

  // a patch is added to the series (the same directory): rebuilt with it, the old branch kept as deploy-prev
  const two = await porting(b, [['catalog.txt', 'reload\n', 'feat: reload the catalog']])
  await series(b, 'v7.3.15', two.patches)
  const second = await b.run()
  assert.equal(second.code, 0, second.log)
  assert.equal(b.git(b.src, 'rev-parse', 'deploy^1'), two.head)
  assert.equal(b.git(b.src, 'rev-parse', 'deploy-prev'), head)
  assert.equal(b.git(b.src, 'show', 'HEAD:catalog.txt'), 'reload')
  assert.notEqual(second.report.candidate.version, first.report.candidate.version)
  assert.match(second.preview, /cpa-upload\n/)
})

test('builder: a series that does not check out or does not apply stops the round; deploy stays as it was', async t => {
  const b = await builder(t)
  const { patches } = await porting(b)
  const deploy = b.git(b.src, 'rev-parse', 'deploy')
  const expectHeld = async (text, prepare) => {
    await prepare()
    const out = await b.run()
    assert.equal(out.code, 1)
    assert.equal(out.report.status, 'held')
    assert.match(out.report.reasons[0].text, text)
    assert.equal(b.git(b.src, 'rev-parse', 'deploy'), deploy)
    assert.equal(b.git(b.src, 'status', '--porcelain'), '')
    assert.doesNotMatch(`${out.calls}${out.preview}`, /docker|cpa-upload|cpa-stage/)
  }
  const dir = path.join(b.root, 'patches', 'v7.3.15')
  await expectHeld(/校验不过/, async () => { await series(b, 'v7.3.15', patches); await fs.appendFile(path.join(dir, patches[0][0]), ' ') })
  await expectHeld(/对不上/, async () => { await series(b, 'v7.3.15', patches); await fs.writeFile(path.join(dir, '0002-unlisted.patch'), 'x\n') })
  await expectHeld(/基底不是上游 tag/, async () => { await fs.rm(path.join(b.root, 'patches'), { recursive: true }); await series(b, 'v7.3.99', patches) })
  const broken = patches[0][1].replace('+fork patch', '+fork patch\n+second line').replace('@@ -1 +1 @@', '@@ -1,2 +1,3 @@')
  await expectHeld(/打不上/, async () => { await fs.rm(path.join(b.root, 'patches'), { recursive: true }); await series(b, 'v7.3.15', [[patches[0][0], broken]]) })
  assert.equal(b.git(b.src, 'branch', '--show-current'), 'deploy')
})
