import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  applyCandidate, autoPaths, decideMagpie, emptyState, readState, rehearsalFingerprint, rehearseCandidate, rollbackApplied, runAuto, sha256File, signinActive,
} from './magpie-autoupdate.mjs'
import { normalizeConfig } from './magpie-autoupdate-policy.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const baseline = JSON.parse(readFileSync(path.join(root, 'deploy/magpie/upstream/api.json'), 'utf8'))
const BASE = baseline.revision
const CAND = 'c'.repeat(40)
const at = (h, m = 0) => new Date(2026, 9, 3, h, m).getTime()

async function world({ status = {} } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mau-'))
  const paths = autoPaths(path.join(dir, 'up'), path.join(dir, 'console'))
  await fs.mkdir(path.join(paths.consoleRuntime, 'bin'), { recursive: true })
  await fs.mkdir(paths.home, { recursive: true })
  await fs.mkdir(paths.runtime, { recursive: true })
  await fs.writeFile(paths.binary, 'old-kernel', { mode: 0o755 })
  await fs.writeFile(path.join(paths.home, 'accounts.json'), 'old-home')
  await fs.writeFile(paths.manifest, JSON.stringify({ socket: path.join(dir, 'k.sock'), gatewayPort: 1, consolePort: 2 }))
  const artifact = `candidates/${CAND}-${'0'.repeat(16)}`
  await fs.mkdir(path.join(paths.runtime, artifact), { recursive: true })
  await fs.writeFile(path.join(paths.runtime, artifact, 'api.json'), JSON.stringify({ ...baseline, revision: CAND }))
  await fs.writeFile(paths.status, JSON.stringify({ version: 1, status: 'review_required', baselineRevision: BASE, candidateRevision: CAND, latestRelease: 'v0.1.679', artifact, ...status }))
  return { dir, paths, close: () => fs.rm(dir, { recursive: true, force: true }) }
}

const facts = (over = {}) => ({
  now: at(2), config: normalizeConfig(null), state: emptyState(), local: { manifest: true, binary: true }, running: BASE,
  baselineRevision: BASE, fingerprint: 'fp', signin: false,
  status: { version: 1, status: 'review_required', baselineRevision: BASE, candidateRevision: CAND, latestRelease: 'v0.1.679' }, ...over,
})
const rehearsed = (verdict, over = {}) => ({ ...emptyState(), rehearsal: { revision: CAND, fingerprint: 'fp', verdict, reasons: verdict === 'held' ? [{ code: 'login-agents', text: '登录方式变了：移除 dimagent' }] : [] }, ...over })

test('decide: every stop has its own word, and only an eligible candidate in the window applies', () => {
  const why = over => decideMagpie(facts(over)).why
  assert.equal(why({ config: normalizeConfig({ magpie: { enabled: false } }) }), 'disabled')
  assert.equal(why({ local: { manifest: false, binary: false } }), 'no-local-kernel', 'production runs CPA mode: nothing to update')
  assert.equal(why({ status: null }), 'no-status')
  assert.equal(why({ status: { ...facts().status, status: 'unchanged' } }), 'up-to-date')
  assert.equal(why({ running: CAND }), 'up-to-date')
  assert.equal(why({ running: null }), 'kernel-offline')
  assert.equal(why({ running: 'd'.repeat(40) }), 'running-unknown', 'a hand-installed kernel is never replaced')
  assert.equal(why({ state: { ...emptyState(), nextAttemptAt: new Date(at(3)).toISOString() } }), 'backoff')
  assert.equal(why({}), 'rehearse')
  assert.equal(why({ state: rehearsed('held') }), 'held')
  assert.equal(why({ state: rehearsed('held'), fingerprint: 'changed' }), 'rehearse', 'a fixed overlay re-rehearses the held candidate')
  assert.equal(why({ state: rehearsed('eligible') }), 'window')
  assert.equal(why({ state: rehearsed('eligible'), now: at(4) }), 'apply')
  assert.equal(why({ state: rehearsed('eligible'), now: at(4), signin: true }), 'signin')
  assert.equal(why({ state: rehearsed('eligible', { attempts: { [CAND]: 1 } }), now: at(4) }), 'attempted')
  assert.equal(why({ state: rehearsed('eligible', { applied: { revision: 'e'.repeat(40) } }), running: 'e'.repeat(40), now: at(4) }), 'apply', 'a previously auto-applied kernel may move on')
  const wait = decideMagpie(facts({ state: rehearsed('eligible') }))
  assert.equal(wait.window, '03:00–06:00')
  assert.equal(Date.parse(wait.nextWindowAt), at(3))
})

test('auto: rehearses a new candidate once; a held verdict sticks until the inputs change', async () => {
  const w = await world()
  try {
    let rehearsals = 0
    const rehearse = async () => { rehearsals += 1; return { revision: CAND, release: 'v0.1.679', verdict: 'held', fingerprint: await rehearsalFingerprint(), reasons: [{ code: 'settings-drift', text: '网关设置有变化：新增 25 项' }], stages: [] } }
    const first = await runAuto({ paths: w.paths, deps: { now: () => at(2), runningRevision: async () => BASE, rehearse } })
    assert.equal(first.magpie.why, 'held')
    const state = await readState(w.paths.state)
    assert.equal(state.result, 'held')
    assert.match(state.reasons[0].text, /网关设置有变化/)
    await runAuto({ paths: w.paths, deps: { now: () => at(4), runningRevision: async () => BASE, rehearse } })
    assert.equal(rehearsals, 1)
  } finally { await w.close() }
})

test('auto: eligible waits for the window, applies once inside it, never twice for the same revision', async () => {
  const w = await world()
  try {
    const fingerprint = await rehearsalFingerprint()
    const rehearse = async () => ({ revision: CAND, release: 'v0.1.679', verdict: 'eligible', fingerprint, reasons: [], stages: [], binary: { path: '/x', sha256: 'y' } })
    let applies = 0
    const apply = async () => { applies += 1; return { result: 'rolled-back', backup: '/b', reasons: [{ code: 'health', text: '替换后没通过健康检查' }] } }
    const deps = now => ({ now: () => now, runningRevision: async () => BASE, rehearse, apply })
    assert.equal((await runAuto({ paths: w.paths, deps: deps(at(2)) })).magpie.why, 'window')
    assert.equal((await readState(w.paths.state)).result, 'eligible')
    await fs.writeFile(w.paths.lease, JSON.stringify({ live: 1, until: new Date(at(5)).toISOString(), pid: process.pid }))
    assert.equal((await runAuto({ paths: w.paths, deps: deps(at(4)) })).magpie.why, 'signin')
    await fs.rm(w.paths.lease)
    const busy = await runAuto({ paths: w.paths, deps: { ...deps(at(4)), lock: async () => { throw new Error('Upstream check is locked by a live process') } } })
    assert.deepEqual([busy.magpie.action, busy.magpie.why, applies], ['wait', 'busy', 0])
    assert.equal((await readState(w.paths.state)).attempts[CAND], undefined, 'a busy lock does not spend the one attempt')
    const applied = await runAuto({ paths: w.paths, deps: deps(at(4)) })
    assert.equal(applied.magpie.action, 'apply')
    assert.equal(applies, 1)
    const state = await readState(w.paths.state)
    assert.equal(state.attempts[CAND], 1)
    assert.equal(state.lastApply.result, 'rolled-back')
    assert.ok(Date.parse(state.nextAttemptAt) > at(4), 'a failed apply backs off')
    const later = await runAuto({ paths: w.paths, deps: deps(at(4) + 24 * 3600_000) })
    assert.equal(later.magpie.why, 'attempted')
    assert.equal(applies, 1)
  } finally { await w.close() }
})

test('auto: an infra failure in the rehearsal backs off instead of holding the candidate', async () => {
  const w = await world()
  try {
    const rehearse = async () => { const error = new Error('git fetch failed'); error.stage = 'checkout'; throw error }
    const first = await runAuto({ paths: w.paths, deps: { now: () => at(2), runningRevision: async () => BASE, rehearse } })
    assert.equal(first.magpie.why, 'error')
    const state = await readState(w.paths.state)
    assert.match(state.reasons[0].text, /checkout/)
    assert.equal((await runAuto({ paths: w.paths, deps: { now: () => at(2) + 60_000, runningRevision: async () => BASE, rehearse } })).magpie.why, 'backoff')
  } finally { await w.close() }
})

test('auto --dry-run decides without writing state', async () => {
  const w = await world()
  try {
    const plan = await runAuto({ dryRun: true, paths: w.paths, deps: { now: () => at(2), runningRevision: async () => BASE } })
    assert.equal(plan.magpie.why, 'rehearse')
    await assert.rejects(fs.access(w.paths.state))
  } finally { await w.close() }
})

test('the sign-in lease of a console that is gone does not block', async () => {
  const w = await world()
  try {
    await fs.writeFile(w.paths.lease, JSON.stringify({ live: 2, until: new Date(Date.now() + 600_000).toISOString(), pid: 2 ** 22 - 7 }))
    assert.equal(await signinActive(w.paths.lease), false)
    await fs.writeFile(w.paths.lease, JSON.stringify({ live: 1, until: new Date(Date.now() - 1).toISOString(), pid: process.pid }))
    assert.equal(await signinActive(w.paths.lease), false)
    await fs.writeFile(w.paths.lease, JSON.stringify({ live: 1, until: new Date(Date.now() + 600_000).toISOString(), pid: process.pid }))
    assert.equal(await signinActive(w.paths.lease), true)
  } finally { await w.close() }
})

async function staged(w, text = 'new-kernel') {
  const file = path.join(w.dir, 'staged-kernel')
  await fs.writeFile(file, text, { mode: 0o755 })
  return { revision: CAND, verdict: 'eligible', binary: { path: file, sha256: await sha256File(file) } }
}

test('apply: backup, atomic install, restart, health → applied', async () => {
  const w = await world()
  try {
    let kicks = 0
    const result = await applyCandidate({ revision: CAND, rehearsal: await staged(w), previous: BASE, paths: w.paths,
      deps: { kickstart: async () => { kicks += 1 }, liveHealth: async ({ revision }) => ({ ok: revision === CAND, checks: [] }) } })
    assert.equal(result.result, 'applied')
    assert.equal(kicks, 1)
    assert.equal(await fs.readFile(w.paths.binary, 'utf8'), 'new-kernel')
    assert.equal(await fs.readFile(path.join(result.backup, 'magpie-kernel'), 'utf8'), 'old-kernel')
    assert.equal(await fs.readFile(path.join(result.backup, 'home/accounts.json'), 'utf8'), 'old-home')
    assert.equal(JSON.parse(await fs.readFile(path.join(result.backup, 'backup.json'), 'utf8')).revision, BASE)
  } finally { await w.close() }
})

test('apply: a failed health check restores binary and kernel HOME and restarts again', async () => {
  const w = await world()
  try {
    const kicks = []
    const result = await applyCandidate({ revision: CAND, rehearsal: await staged(w), previous: BASE, paths: w.paths, deps: {
      // the new kernel rewrites its HOME, then never becomes healthy
      kickstart: async () => { kicks.push(await fs.readFile(w.paths.binary, 'utf8')); if (kicks.length === 1) await fs.writeFile(path.join(w.paths.home, 'accounts.json'), 'migrated-by-new') },
      liveHealth: async ({ revision }) => ({ ok: revision === BASE, checks: [{ name: 'gateway', ok: revision === BASE, detail: 'HTTP 502' }] }),
    } })
    assert.equal(result.result, 'rolled-back')
    assert.deepEqual(kicks, ['new-kernel', 'old-kernel'])
    assert.equal(await fs.readFile(w.paths.binary, 'utf8'), 'old-kernel')
    assert.equal(await fs.readFile(path.join(w.paths.home, 'accounts.json'), 'utf8'), 'old-home')
    assert.match(result.reasons[0].text, /gateway HTTP 502/)
    const leftovers = (await fs.readdir(w.paths.consoleRuntime)).filter(name => name.startsWith('home.failed-'))
    assert.equal(leftovers.length, 1, 'the failed HOME is kept for inspection, not deleted')
  } finally { await w.close() }
})

test('apply refuses a staged binary that changed after the rehearsal, before touching anything', async () => {
  const w = await world()
  try {
    const rehearsal = await staged(w)
    await fs.writeFile(rehearsal.binary.path, 'tampered')
    await assert.rejects(applyCandidate({ revision: CAND, rehearsal, previous: BASE, paths: w.paths, deps: { kickstart: async () => assert.fail('no restart'), liveHealth: async () => ({ ok: true, checks: [] }) } }), /changed since the rehearsal/)
    assert.equal(await fs.readFile(w.paths.binary, 'utf8'), 'old-kernel')
  } finally { await w.close() }
})

test('rehearse: contract drift holds without building in fast mode; full mode still builds and reports every reason', async () => {
  const w = await world()
  try {
    const lock = action => action()
    const quiet = { addedAgents: [], removedAgents: [], riskChanged: [], signinChanged: [], changedAgents: [], copyChanged: [], settingsCopyChanged: [] }
    const base = { lock, checkout: async () => w.dir, modules: async () => {}, catalog: async () => quiet }
    let builds = 0
    const build = async ({ out }) => { builds += 1; await fs.writeFile(path.join(out, 'magpie-kernel'), 'built'); return { code: 0, tail: [] } }
    const drift = { settings: async () => ({ addedSettings: ['otel'], removedSettings: [], changedSettings: [] }) }
    const fast = await rehearseCandidate({ revision: CAND, full: false, paths: w.paths, deps: { ...base, ...drift, build } })
    assert.equal(fast.verdict, 'held')
    assert.equal(builds, 0)
    const failing = await rehearseCandidate({ revision: CAND, full: true, paths: w.paths, deps: { ...base, ...drift,
      build: async () => ({ code: 1, tail: ['Error: Pinned kernel seam changed; review the overlay'] }) } })
    assert.deepEqual(failing.reasons.map(reason => reason.code), ['settings-drift', 'build'])
    assert.match(failing.reasons[1].text, /：Pinned kernel seam changed/)
    assert.deepEqual(failing.stages.map(stage => [stage.name, stage.ok]), [['checkout', true], ['settings', true], ['catalog', true], ['modules', true], ['build', false]])
    const smoky = await rehearseCandidate({ revision: CAND, paths: w.paths, deps: { ...base, settings: async () => ({ addedSettings: [], removedSettings: [], changedSettings: [] }), build,
      smoke: async () => ({ ok: false, checks: [{ name: 'keychain is off', ok: false, detail: 'keychain=true' }] }) } })
    assert.deepEqual(smoky.reasons.map(reason => reason.code), ['smoke'])
    assert.equal(smoky.binary, null)
    const stale = path.join(w.paths.stage, 'aaaaaaaaaaaa')
    await fs.mkdir(stale, { recursive: true })
    await fs.writeFile(path.join(stale, 'magpie-kernel'), 'old candidate')
    const clean = await rehearseCandidate({ revision: CAND, paths: w.paths, deps: { ...base, settings: async () => ({ addedSettings: [], removedSettings: [], changedSettings: [] }), build,
      smoke: async ({ revision }) => ({ ok: revision === CAND, checks: [{ name: 'health', ok: true }] }) } })
    assert.equal(clean.verdict, 'eligible')
    assert.equal(clean.binary.sha256, await sha256File(clean.binary.path))
    assert.deepEqual(clean.stages.map(stage => stage.name), ['checkout', 'settings', 'catalog', 'modules', 'build', 'smoke'])
    await assert.rejects(fs.stat(stale), { code: 'ENOENT' }, 'a superseded staged build is removed')
  } finally { await w.close() }
})

test('rehearse refuses a candidate the check did not publish', async () => {
  const w = await world({ status: { candidateRevision: 'd'.repeat(40) } })
  try {
    await assert.rejects(rehearseCandidate({ revision: CAND, paths: w.paths, deps: { lock: action => action() } }), /does not describe this candidate/)
  } finally { await w.close() }
})

test('apply: a launchctl failure after the install still restores binary + HOME and restarts again', async () => {
  const w = await world()
  try {
    const kicks = []
    const result = await applyCandidate({ revision: CAND, rehearsal: await staged(w), previous: BASE, paths: w.paths, deps: {
      kickstart: async () => {
        kicks.push(await fs.readFile(w.paths.binary, 'utf8'))
        if (kicks.length === 1) { await fs.writeFile(path.join(w.paths.home, 'accounts.json'), 'migrated-by-new'); throw new Error('launchctl: Could not find service') }
      },
      liveHealth: async ({ revision }) => ({ ok: revision === BASE, checks: [] }),
    } })
    assert.equal(result.result, 'rolled-back')
    assert.deepEqual(kicks, ['new-kernel', 'old-kernel'])
    assert.equal(await fs.readFile(w.paths.binary, 'utf8'), 'old-kernel')
    assert.equal(await fs.readFile(path.join(w.paths.home, 'accounts.json'), 'utf8'), 'old-home')
    assert.equal(result.reasons[0].code, 'restart')
    assert.match(result.reasons[0].text, /重启没成功：launchctl: Could not find service/)
    const staging = (await fs.readdir(w.paths.consoleRuntime)).filter(name => name.startsWith('home.restore-'))
    assert.deepEqual(staging, [], 'the restored HOME was renamed into place')
  } finally { await w.close() }
})

test('apply: a rollback that cannot restart is reported as rollback-failed, not thrown', async () => {
  const w = await world()
  try {
    let kicks = 0
    const result = await applyCandidate({ revision: CAND, rehearsal: await staged(w), previous: BASE, paths: w.paths, deps: {
      kickstart: async () => { kicks += 1; if (kicks === 2) throw new Error('launchctl: service disabled') },
      liveHealth: async () => ({ ok: false, checks: [{ name: 'kernel', ok: false, detail: 'HTTP 0' }] }),
    } })
    assert.equal(result.result, 'rollback-failed')
    assert.equal(kicks, 2)
    assert.equal(await fs.readFile(w.paths.binary, 'utf8'), 'old-kernel', 'the old binary is back even though the restart failed')
    assert.match(result.reasons[0].items.join(' '), /回滚 rollback launchctl: service disabled/)
  } finally { await w.close() }
})

test('auto: window, sign-in lease and the switch are decided again under the lock, right before the apply', async () => {
  const w = await world()
  try {
    const fingerprint = await rehearsalFingerprint()
    const rehearse = async () => ({ revision: CAND, release: 'v0.1.679', verdict: 'eligible', fingerprint, reasons: [], stages: [], binary: { path: '/x', sha256: 'y' } })
    let applies = 0
    const apply = async ({ onCommit }) => { await onCommit(); applies += 1; return { result: 'applied', backup: '/b', checks: [] } }
    const base = { runningRevision: async () => BASE, rehearse, apply }
    await runAuto({ paths: w.paths, deps: { ...base, now: () => at(2) } })
    // a sign-in starts while the job waits for the lock
    const leaseFirst = action => fs.writeFile(w.paths.lease, JSON.stringify({ live: 1, until: new Date(at(5)).toISOString(), pid: process.pid })).then(() => action())
    const signin = await runAuto({ paths: w.paths, deps: { ...base, now: () => at(4), lock: leaseFirst } })
    assert.deepEqual([signin.magpie.why, applies], ['signin', 0])
    await fs.rm(w.paths.lease)
    // the owner switches it off in the meantime
    const offFirst = action => fs.writeFile(w.paths.config, JSON.stringify({ magpie: { enabled: false } })).then(() => action())
    assert.deepEqual([(await runAuto({ paths: w.paths, deps: { ...base, now: () => at(4), lock: offFirst } })).magpie.why, applies], ['disabled', 0])
    await fs.rm(w.paths.config)
    // the window closes while the job waits
    let clock = at(5, 59)
    const lateFirst = action => { clock = at(6, 1); return action() }
    assert.deepEqual([(await runAuto({ paths: w.paths, deps: { ...base, now: () => clock, lock: lateFirst } })).magpie.why, applies], ['window', 0])
    assert.equal((await readState(w.paths.state)).attempts[CAND], undefined, 'none of these spent the attempt')
    const done = await runAuto({ paths: w.paths, deps: { ...base, now: () => at(4) } })
    assert.deepEqual([done.magpie.result, applies], ['applied', 1])
    const state = await readState(w.paths.state)
    assert.equal(state.attempts[CAND], 1)
    assert.equal(state.applied.revision, CAND)
    assert.equal(state.applied.previous, BASE)
  } finally { await w.close() }
})

test('auto: a staged build that vanished before the apply does not spend the attempt; it is rehearsed again after a backoff', async () => {
  const w = await world()
  try {
    const fingerprint = await rehearsalFingerprint()
    const rehearse = async () => ({ revision: CAND, release: 'v0.1.679', verdict: 'eligible', fingerprint, reasons: [], stages: [], binary: { path: path.join(w.dir, 'gone'), sha256: 'y' } })
    await runAuto({ paths: w.paths, deps: { now: () => at(2), runningRevision: async () => BASE, rehearse } })
    const result = await runAuto({ paths: w.paths, deps: { now: () => at(4), runningRevision: async () => BASE, rehearse } })
    assert.equal(result.magpie.why, 'error')
    const state = await readState(w.paths.state)
    assert.equal(state.attempts[CAND], undefined)
    assert.equal(state.rehearsal.verdict, 'error')
    assert.match(state.reasons[0].text, /替换前检查没过/)
    assert.equal(await fs.readFile(w.paths.binary, 'utf8'), 'old-kernel')
    assert.equal(decideMagpie({ now: Date.parse(state.nextAttemptAt) + 1, config: normalizeConfig(null), state, status: { version: 1, status: 'review_required', baselineRevision: BASE, candidateRevision: CAND },
      local: { manifest: true, binary: true }, running: BASE, baselineRevision: BASE, fingerprint, signin: false }).why, 'rehearse')
  } finally { await w.close() }
})

test('manual rollback: only the auto-applied kernel, only while it is the one running; HOME of that moment comes back', async () => {
  const w = await world()
  try {
    const lock = action => action()
    await assert.rejects(rollbackApplied({ paths: w.paths, deps: { lock, kickstart: async () => assert.fail('no restart') } }), /No auto-applied kernel/)
    const applied = await applyCandidate({ revision: CAND, rehearsal: await staged(w), previous: BASE, paths: w.paths,
      deps: { kickstart: async () => {}, liveHealth: async () => ({ ok: true, checks: [] }) } })
    await fs.writeFile(path.join(w.paths.home, 'accounts.json'), 'written-by-new')
    await fs.writeFile(w.paths.state, JSON.stringify({ ...emptyState(), applied: { revision: CAND, release: 'v0.1.679', at: new Date().toISOString(), previous: BASE, backup: applied.backup },
      lastApply: { revision: CAND, at: new Date().toISOString(), result: 'applied', backup: applied.backup } }))
    const other = 'd'.repeat(40)
    await assert.rejects(rollbackApplied({ paths: w.paths, deps: { lock, runningRevision: async () => other, kickstart: async () => assert.fail('no restart') } }), /not the auto-applied/)
    assert.equal(await fs.readFile(w.paths.binary, 'utf8'), 'new-kernel')
    let kicks = 0
    const done = await rollbackApplied({ paths: w.paths, deps: { lock, runningRevision: async () => CAND, kickstart: async () => { kicks += 1 }, liveHealth: async ({ revision }) => ({ ok: revision === BASE, checks: [] }) } })
    assert.equal(done.rollback, 'ok')
    assert.equal(kicks, 1)
    assert.equal(await fs.readFile(w.paths.binary, 'utf8'), 'old-kernel')
    assert.equal(await fs.readFile(path.join(w.paths.home, 'accounts.json'), 'utf8'), 'old-home')
    const kept = (await fs.readdir(w.paths.consoleRuntime)).filter(name => name.startsWith('home.failed-'))
    assert.equal(await fs.readFile(path.join(w.paths.consoleRuntime, kept[0], 'accounts.json'), 'utf8'), 'written-by-new', 'the HOME it replaced is kept aside')
    const state = await readState(w.paths.state)
    assert.equal(state.applied, null)
    assert.equal(state.lastApply.result, 'rolled-back-manually')
  } finally { await w.close() }
})
