import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { coordinatorConfig, hostReport, planRound, previewStage, rtkForward, runRound } from './cpa-coordinator.mjs'

const V = '8.0.21-patched.aaaaaaaa'
const W = '8.0.22-patched.bbbbbbbb'
const OLD = '8.0.13-patched.7b53aee6'
const sha = text => createHash('sha256').update(text).digest('hex')
const NOW = Date.UTC(2026, 9, 9, 12)
const HOUR = 3_600_000
const ENV = { CPA_PIPELINE_PREVIEW: 'ssh preview-gate', CPA_PIPELINE_PRODUCTION: 'ssh production-gate', CPA_ACCEPT_BASE_URL: 'https://api.example.com', CPA_ACCEPT_KEY: 'sk-accept-000000', CPA_ACCEPT_MODELS: 'm1,m2' }
const built = version => ({ version: 1, kernel: 'cpa', status: 'built', checkedAt: new Date(NOW).toISOString(), candidate: { version, sha256: sha(version), tag: 'v8.0.21', checks: [] }, reasons: [] })
const store = (...versions) => new Map(versions.map(version => [version, { version, sha256: sha(version), binary: `/store/${version}` }]))
const trial = (status, over = {}) => ({ version: V, sha256: sha(V), status, installedAt: new Date(NOW - 2 * HOUR).toISOString(), soakUntil: new Date(NOW + 22 * HOUR).toISOString(), acceptance: { first: null, soak: null }, ...over })

test('config: both gate targets and the acceptance settings are required, no defaults', () => {
  assert.deepEqual(coordinatorConfig(ENV).preview, ['ssh', 'preview-gate'])
  assert.throws(() => coordinatorConfig({ ...ENV, CPA_PIPELINE_PREVIEW: ' ' }), /CPA_PIPELINE_PREVIEW is not set/)
  assert.throws(() => coordinatorConfig({ ...ENV, CPA_ACCEPT_KEY: '' }), /CPA_ACCEPT_KEY not set/)
})

test('plan: a fresh build goes to preview only; production gets nothing without preview\'s acceptance', () => {
  const plan = planRound({ report: built(V), store: store(V), preview: { installed: { version: OLD } }, production: { installed: { version: OLD } }, now: NOW })
  assert.deepEqual(plan, [{ kind: 'upload-preview', version: V, sha256: sha(V) }])
  // already staged there, already running there, already tried there, or not in the local store: nothing
  assert.deepEqual(planRound({ report: built(V), store: store(V), preview: { installed: { version: OLD }, staged: { version: V } }, production: {}, now: NOW }), [])
  assert.deepEqual(planRound({ report: built(V), store: store(V), preview: { installed: { version: V } }, production: {}, now: NOW }), [])
  assert.deepEqual(planRound({ report: built(V), store: store(V), preview: { installed: { version: OLD }, attempts: { [V]: 1 } }, production: {}, now: NOW }), [])
  assert.deepEqual(planRound({ report: built(V), store: store(), preview: { installed: { version: OLD } }, production: {}, now: NOW }), [])
  assert.deepEqual(planRound({ report: built(V), store: store(V), preview: null, production: {}, now: NOW }), [], 'preview did not answer')
  assert.deepEqual(planRound({ report: { ...built(V), status: 'merge-conflict', candidate: null }, store: store(V), preview: { installed: { version: OLD } }, production: {}, now: NOW }), [])
})

test('plan: acceptance right after install and again once the soak is over; one candidate in flight at a time', () => {
  const preview = over => ({ installed: { version: V }, ...over })
  assert.deepEqual(planRound({ report: built(W), store: store(V, W), preview: preview({ trial: trial('installed') }), production: {}, now: NOW }), [{ kind: 'accept', phase: 'first', version: V, sha256: sha(V) }])
  assert.deepEqual(planRound({ report: built(W), store: store(V, W), preview: preview({ trial: trial('soaking') }), production: {}, now: NOW }), [], 'soaking: nothing until the soak is over')
  assert.deepEqual(planRound({ report: built(W), store: store(V, W), preview: preview({ trial: trial('soaking') }), production: {}, now: NOW + 23 * HOUR }), [{ kind: 'accept', phase: 'soak', version: V, sha256: sha(V) }])
  assert.deepEqual(planRound({ report: built(W), store: store(V, W), preview: { installed: { version: OLD }, trial: trial('installed') }, production: {}, now: NOW }), [], 'not running the trial version: no acceptance')
  // accepted: deliver it, and only then take the next build
  const accepted = preview({ trial: trial('accepted') })
  assert.deepEqual(planRound({ report: built(W), store: store(V, W), preview: accepted, production: { installed: { version: OLD } }, now: NOW }).map(item => item.kind), ['promote', 'upload-preview'])
  assert.deepEqual(planRound({ report: built(W), store: store(V, W), preview: accepted, production: null, now: NOW }), [], 'production did not answer: the slot stays taken')
  assert.deepEqual(planRound({ report: built(W), store: store(V, W), preview: accepted, production: { installed: { version: OLD }, promotion: { candidate: { version: V } } }, now: NOW }).map(item => item.kind), ['upload-preview'])
  assert.deepEqual(planRound({ report: built(W), store: store(V, W), preview: accepted, production: { installed: { version: OLD }, attempts: { [V]: 1 } }, now: NOW }), [], 'production already tried it once')
  assert.deepEqual(planRound({ report: built(W), store: store(V, W), preview: preview({ trial: trial('rejected') }), production: {}, now: NOW }).map(item => item.kind), ['upload-preview'])
})

test('reports: both hosts get the round, each with its own up-to-date, and where the candidate stands on preview', () => {
  assert.equal(hostReport(built(V), { installed: { version: V } }, null).status, 'up-to-date')
  assert.equal(hostReport(built(V), { installed: { version: OLD } }, null).status, 'built')
  assert.deepEqual(previewStage({ preview: { trial: trial('soaking') }, production: {}, uploaded: null, now: NOW }), { version: V, stage: 'soaking', soakUntil: trial('soaking').soakUntil, at: new Date(NOW).toISOString(), reason: null })
  assert.equal(previewStage({ preview: { trial: trial('accepted') }, production: { promotion: { candidate: { version: V } } }, uploaded: null, now: NOW }).stage, 'delivered')
  assert.equal(previewStage({ preview: { trial: trial('rejected', { rejected: { reason: '首次验收没过' } }) }, production: {}, uploaded: null, now: NOW }).reason, '首次验收没过')
  assert.equal(previewStage({ preview: {}, production: {}, uploaded: W, now: NOW }).stage, 'uploaded')
})

test('rtk: only an accepted preview trial is forwarded, once, and never to a production already at that version', () => {
  const last = { version: '0.51.0', tag: 'v0.51.0', sha256: 'c'.repeat(64), asset: 'rtk-x86_64-unknown-linux-musl.tar.gz', status: 'accepted', installedAt: 'a', checks: [], acceptedAt: 'b' }
  // preview may already be soaking the next version: the accepted one is forwarded all the same
  const accepted = { trial: { ...last, version: '0.52.0', status: 'soaking' }, accepted: last }
  assert.equal(rtkForward({ preview: accepted, production: { local: '0.50.0' } }).candidate.version, '0.51.0')
  assert.equal(rtkForward({ preview: { trial: { ...last, status: 'soaking' } }, production: { local: '0.50.0' } }), null)
  assert.equal(rtkForward({ preview: accepted, production: { local: '0.51.0' } }), null)
  assert.equal(rtkForward({ preview: accepted, production: { local: '0.50.0', promotion: { candidate: { version: '0.51.0' } } } }), null)
  assert.equal(rtkForward({ preview: accepted, production: null }), null)
})

/** In-memory gates: what each host answers, and what it received. */
function gates({ preview, production, promotion = null, fail = {} }) {
  const calls = { preview: [], production: [] }
  const received = { preview: {}, production: {} }
  const gate = async (prefix, command, { input = '', file = null } = {}) => {
    const role = prefix[1] === 'preview-gate' ? 'preview' : 'production'
    calls[role].push(command)
    if (fail[`${role}:${command.split(' ')[0]}`]) return { code: 2, stdout: 'denied', stderr: '' }
    if (command === 'cpa-state') return { code: 0, stdout: JSON.stringify(role === 'preview' ? preview : production), stderr: '' }
    if (command === 'rtk-state') return { code: 0, stdout: '{}', stderr: '' }
    if (command === 'cpa-promotion') return { code: 0, stdout: JSON.stringify(promotion), stderr: '' }
    // the real gateCall streams `file` gzip-compressed; the in-memory gate reads it as is
    received[role][command.split(' ')[0]] = file ? await fs.readFile(file, 'utf8') : input
    return { code: 0, stdout: 'ok', stderr: '' }
  }
  return { gate, calls, received }
}

async function pipelineRoot(t, report, versions) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cpa-coord-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  await fs.mkdir(path.join(root, 'state/candidates'), { recursive: true })
  await fs.writeFile(path.join(root, 'state/report.json'), JSON.stringify(report))
  for (const [version, body] of Object.entries(versions)) {
    const dir = path.join(root, 'state/candidates', version)
    await fs.mkdir(dir)
    await fs.writeFile(path.join(dir, 'cli-proxy-api'), body)
    await fs.writeFile(path.join(dir, 'candidate.json'), JSON.stringify({ version, sha256: sha(version) }))
  }
  return root
}

test('round: acceptance result goes to preview as its record; the key never does', async t => {
  const root = await pipelineRoot(t, built(W), { [V]: V, [W]: W })
  const g = gates({ preview: { installed: { version: V }, trial: trial('installed') }, production: { installed: { version: OLD } } })
  const accept = async options => {
    assert.deepEqual([options.baseUrl, options.models, options.expectVersion], ['https://api.example.com', 'm1,m2', V])
    return { ok: false, ranAt: new Date(NOW).toISOString(), checks: [{ name: 'm1 SSE', ok: false, detail: '流没有 [DONE]' }], summary: '1/7 项没过：m1 SSE' }
  }
  const out = await runRound({ root, env: ENV, deps: { gate: g.gate, accept, now: () => NOW } })
  const record = JSON.parse(g.received.preview['cpa-accept'])
  assert.deepEqual([record.kind, record.phase, record.candidate, record.ok], ['cpa-acceptance', 'first', { version: V, sha256: sha(V) }, false])
  assert.equal(JSON.stringify(record).includes('sk-accept'), false)
  assert.match(await fs.readFile(path.join(root, 'state/acceptance.jsonl'), 'utf8'), /"phase":"first"/)
  assert.equal(g.calls.preview.includes(`cpa-stage ${W}`), false, 'the trial holds the slot')
  assert.equal(JSON.parse(g.received.production['cpa-report']).preview.stage, 'installed')
  assert.deepEqual(out.errors, [])
})

test('round: promotion sends the very binary preview accepted plus its record; a failed delivery keeps the next build back', async t => {
  const record = { version: 1, kind: 'cpa-promotion', candidate: { version: V, sha256: sha(V) } }
  const states = { preview: { installed: { version: V }, trial: trial('accepted') }, production: { installed: { version: OLD } }, promotion: record }
  const root = await pipelineRoot(t, built(W), { [V]: V, [W]: W })
  const ok = gates(states)
  const out = await runRound({ root, env: ENV, deps: { gate: ok.gate, now: () => NOW } })
  assert.deepEqual(out.errors, [])
  assert.deepEqual(ok.calls.production.slice(1, 5), ['cpa-upload', `cpa-stage ${V}`, 'cpa-promote', 'cpa-report'])
  assert.equal(ok.received.production['cpa-upload'], V)
  assert.deepEqual(JSON.parse(ok.received.production['cpa-promote']), record)
  assert.equal(ok.received.preview['cpa-upload'], W, 'delivered: the next build goes to preview')
  assert.equal(JSON.parse(ok.received.preview['cpa-report']).preview.stage, 'uploaded')

  const down = gates({ ...states, fail: { 'production:cpa-stage': true } })
  const failed = await runRound({ root, env: ENV, deps: { gate: down.gate, now: () => NOW } })
  assert.match(failed.errors.join(), /promote 8\.0\.21-patched\.aaaaaaaa to production failed at cpa-stage/)
  assert.equal(down.calls.preview.includes('cpa-upload'), false, 'not delivered: preview keeps the accepted one in flight')

  // the store copy no longer matches what preview accepted: refuse to deliver it
  await fs.writeFile(path.join(root, 'state/candidates', V, 'cli-proxy-api'), 'tampered')
  const tampered = gates(states)
  const refused = await runRound({ root, env: ENV, deps: { gate: tampered.gate, now: () => NOW } })
  assert.match(refused.errors.join(), /does not match the sha256 preview accepted/)
  assert.equal(tampered.calls.production.includes('cpa-upload'), false)
})
