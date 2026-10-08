import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import {
  accountTypes, applierPaths, applyAcceptance, applyCpa, classifyInstall, configAuthDir, configLayout, decideCpa, decideMagpie, emptyState, ingestCpa,
  normalizeConfig, parseAcceptance, parseCpaReport, parseMagpieReport, parseProbeModels, parsePromotion, pickProbeModel, probeCommand, promotionProblems,
  promotionRecord, readProbeKeys, readState, runAuto, runProbes, sameMajor, startTrial, trialTick, windowState, withLock,
} from './kernel-applier.mjs'

// 2026-10-03 in Beijing time (UTC+8, no DST): the default window is 05:00–07:00 there
const bj = (h, m = 0) => Date.UTC(2026, 9, 3, h - 8, m)
const sha = text => createHash('sha256').update(text).digest('hex')
const RUNNING = '7.3.15-patched.498fcc2b'
const NEXT = '7.3.20-patched.1a2b3c4d'
const MAJOR = '8.0.12-patched.5e6f7a8b'

const config = (over = {}) => normalizeConfig(over)
const HOUR = 3_600_000
const POLICY = { soakMs: 24 * HOUR, maxAgeMs: 7 * 24 * HOUR }
const at = ms => new Date(ms).toISOString()
/** preview's record for `version` (installed two days before the 2026-10-03 window, soaked 25 h, both runs green) */
const promoted = (version, sha256 = 'a'.repeat(64), over = {}) => {
  const installed = bj(1) - 48 * HOUR
  const run = (ms, ok = true) => ({ at: at(ms), ranAt: at(ms), ok, checks: [{ name: 'x', ok }], summary: ok ? '全部通过' : '没过' })
  return { version: 1, kind: 'cpa-promotion', candidate: { version, sha256 }, installedAt: at(installed), soakMs: 24 * HOUR,
    acceptance: { first: run(installed + HOUR), soak: run(installed + 25 * HOUR) }, acceptedAt: at(installed + 25 * HOUR), ...over }
}
const staged = (version, over = {}) => ({ ...emptyState('cpa'), staged: { version, sha256: 'a'.repeat(64), at: new Date(bj(1)).toISOString() }, promotion: promoted(version), ...over })

test('config: missing = on, default window 05:00–07:00 Asia/Shanghai; bad windows fall back', () => {
  const value = normalizeConfig(null)
  assert.equal(value.cpa.enabled, true)
  assert.equal(value.magpie.enabled, true)
  assert.deepEqual(value.window, { start: '05:00', end: '07:00', tz: 'Asia/Shanghai' })
  assert.equal(normalizeConfig({ cpa: { enabled: false } }).cpa.enabled, false)
  assert.deepEqual(normalizeConfig({ window: { start: '05:00', end: '05:00' } }).window, value.window)
  assert.deepEqual(normalizeConfig({ window: { start: '05:00', end: '06:00', tz: 'Mars/Base' } }).window, value.window)
  assert.deepEqual(normalizeConfig({ window: { start: '17:00', end: '19:00', tz: 'America/New_York' } }).window, { start: '17:00', end: '19:00', tz: 'America/New_York' })
})

test('window: wall clock of its own time zone, wraps past midnight, next start', () => {
  const window = { start: '05:00', end: '07:00', tz: 'Asia/Shanghai' }
  assert.equal(windowState(bj(5, 0), window).inside, true)
  assert.equal(windowState(bj(6, 59), window).inside, true)
  assert.equal(windowState(bj(7, 0), window).inside, false)
  assert.equal(windowState(bj(4, 59), window).inside, false)
  assert.equal(windowState(bj(4, 0), window).nextStart, bj(5, 0))
  assert.equal(windowState(bj(5, 0), window).nextStart, bj(5, 0) + 86_400_000)
  const night = { start: '23:00', end: '01:00', tz: 'Asia/Shanghai' }
  assert.equal(windowState(bj(23, 30), night).inside, true)
  assert.equal(windowState(bj(0, 30), night).inside, true)
  assert.equal(windowState(bj(1, 0), night).inside, false)
})

test('config layout: migrated markers never look legacy; missing or ambiguous files fail closed', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kacl-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'config.yaml')
  assert.equal(await configLayout(file), null)
  for (const [body, expected] of [
    ['api-keys: []\n', 'legacy'],
    ['# config-version: 8\napi-keys: []\n', 'legacy'],
    ['config-version: 8\napi-keys: []\n', 'v8'],
    ['config-version: 8 # migrated\n', 'v8'],
    ['﻿"config-version": 8\r\n', 'v8'],
    ["'config-version': 8\n", 'v8'],
    ['config-version: invalid\n', null],
    ['config-version: 8\nconfig-version: 7\n', null],
    ['{config-version: 8, access: {api-keys: []}}\n', null],
    ['', null],
  ]) {
    await fs.writeFile(file, body)
    assert.equal(await configLayout(file), expected, JSON.stringify(body))
  }
})

test('versions: major compare', () => {
  assert.equal(sameMajor(RUNNING, NEXT), true)
  assert.equal(sameMajor(RUNNING, MAJOR), false)
  assert.equal(sameMajor(RUNNING, null), false)
})

test('decideCpa: every reason not to apply, then apply only inside the window', () => {
  const base = { now: bj(5, 10), config: config(), running: RUNNING, hold: null }
  assert.equal(decideCpa({ ...base, config: config({ cpa: { enabled: false } }), state: staged(NEXT) }).why, 'disabled')
  assert.equal(decideCpa({ ...base, state: emptyState('cpa') }).why, 'no-candidate')
  assert.equal(decideCpa({ ...base, state: { ...emptyState('cpa'), builder: { status: 'merge-conflict', reasons: [{ code: 'merge', text: 'x' }] } } }).why, 'held')
  assert.equal(decideCpa({ ...base, state: staged(RUNNING) }).why, 'up-to-date')
  assert.equal(decideCpa({ ...base, state: staged('7.3.14-patched.0') }).why, 'up-to-date')
  assert.equal(decideCpa({ ...base, running: null, state: staged(NEXT) }).why, 'offline')
  assert.equal(decideCpa({ ...base, hold: 'Locked on purpose', state: staged(NEXT) }).why, 'hold-file')
  assert.equal(decideCpa({ ...base, state: staged(MAJOR) }).why, 'apply')
  assert.equal(decideCpa({ ...base, state: staged(NEXT, { attempts: { [NEXT]: 1 } }) }).why, 'attempted')
  assert.equal(decideCpa({ ...base, state: staged(NEXT, { nextAttemptAt: new Date(bj(5, 30)).toISOString() }) }).why, 'backoff')
  const today = { action: 'apply', result: 'applied', at: new Date(bj(5, 5)).toISOString(), version: '7.3.16-patched.0' }
  assert.equal(decideCpa({ ...base, now: bj(6), state: staged(NEXT, { lastApply: today }) }).why, 'daily')
  assert.equal(decideCpa({ ...base, now: bj(5, 10) + 86_400_000, state: staged(NEXT, { lastApply: today }) }).why, 'apply')
  assert.equal(decideCpa({ ...base, now: bj(6), state: staged(NEXT, { lastApply: { ...today, result: 'refused' } }) }).why, 'apply')
  const outside = decideCpa({ ...base, now: bj(12), state: staged(NEXT) })
  assert.deepEqual([outside.action, outside.why, outside.nextWindowAt], ['wait', 'window', new Date(bj(5) + 86_400_000).toISOString()])
  const inside = decideCpa({ ...base, state: staged(NEXT) })
  assert.deepEqual([inside.action, inside.version], ['apply', NEXT])
})

test('decideMagpie: standby needs no window, once per revision', () => {
  const rev = 'b'.repeat(40)
  const state = { ...emptyState('magpie'), staged: { revision: rev, sha256: 'a'.repeat(64) } }
  assert.equal(decideMagpie({ config: config({ magpie: { enabled: false } }), state }).why, 'disabled')
  assert.equal(decideMagpie({ config: config(), state }).action, 'apply')
  assert.equal(decideMagpie({ config: config(), state: { ...state, installed: { revision: rev } } }).why, 'up-to-date')
  assert.equal(decideMagpie({ config: config(), state: { ...state, attempts: { [rev]: 1 } } }).why, 'attempted')
})

test('reports: strict shapes; a "built" report needs a candidate', () => {
  const ok = { version: 1, kernel: 'cpa', status: 'built', checkedAt: '2026-10-03T00:00:00Z', upstreamLatest: 'v8.1.0', line: 'v8.0', base: 'v8.0.12',
    heldNewer: { tag: 'v8.1.0', text: '跨 minor' }, candidate: { version: MAJOR, sha256: 'c'.repeat(64), tag: 'v8.0.12', checks: [{ name: 'models', ok: true }] } }
  assert.equal(parseCpaReport(ok).candidate.version, MAJOR)
  const checks = Array.from({ length: 42 }, (_, i) => ({ name: `smoke-${i}`, ok: i !== 41 }))
  assert.deepEqual(parseCpaReport({ ...ok, candidate: { ...ok.candidate, checks } }).candidate.checks, checks)
  assert.equal(parseCpaReport({ ...ok, candidate: null }), null)
  assert.equal(parseCpaReport({ ...ok, status: 'rm -rf' }), null)
  assert.equal(parseCpaReport({ ...ok, candidate: { ...ok.candidate, version: '8.0.12; reboot' } }), null)
  assert.equal(parseCpaReport({ ...ok, status: 'held', candidate: null }).status, 'held')
  assert.equal(parseMagpieReport({ version: 1, kernel: 'magpie', status: 'built', checkedAt: '2026-10-03T00:00:00Z', candidate: { revision: 'b'.repeat(40), sha256: 'c'.repeat(64) } }).candidate.revision, 'b'.repeat(40))
})

test('classifyInstall: cpa-install-binary.sh outcomes', () => {
  const backup = '/var/backups/cpa/cli-proxy-api.7.3.15.20261003T050000.1'
  assert.equal(classifyInstall({ code: 0, stdout: `开始安装 a -> b（备份 ${backup}）\n安装成功 a -> b（…）\n` }).result, 'applied')
  assert.equal(classifyInstall({ code: 0, stdout: `开始安装 a -> b（备份 ${backup}）\n` }).backup, backup)
  assert.equal(classifyInstall({ code: 0, stdout: '线上已是 b，跳过\n' }).result, 'up-to-date')
  assert.equal(classifyInstall({ code: 1, stdout: '本地补丁hold生效，拒绝流水线安装\n' }).result, 'refused')
  assert.equal(classifyInstall({ code: 1, stdout: 'AGY基线失败，线上未改动；先修复现有故障再升级\n' }).result, 'refused')
  assert.equal(classifyInstall({ code: 1, stdout: `开始安装 a -> b（备份 ${backup}）\n停止期间配置发生变更，二进制未改动，取消安装\n` }).result, 'refused')
  assert.equal(classifyInstall({ code: 1, stdout: `开始安装 a -> b（备份 ${backup}）\n管理API/Console或AGY兼容回归；准备回滚到 a（备份 x）\n已回滚到 a，验收通过\n` }).result, 'rolled-back')
  assert.equal(classifyInstall({ code: 1, stdout: `开始安装 a -> b（备份 ${backup}）\n严重：配置/AGY凭据已变更，停止自动回滚\n` }).result, 'rollback-failed')
})

test('lock: a live holder makes the second run busy; a dead holder is taken over', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kal-'))
  const lock = path.join(dir, 'applier.lock')
  await withLock(lock, async () => {
    await assert.rejects(withLock(lock, async () => 1), /busy/)
  })
  await fs.writeFile(lock, '999999')
  assert.equal(await withLock(lock, async () => 7), 7)
  await fs.rm(dir, { recursive: true, force: true })
})

/* ── a whole relay in a temp dir: fake systemctl, fake cpa-install-binary.sh ── */

async function relay({ running = RUNNING, install = { code: 0 }, role = 'production' } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kar-'))
  const env = { KERNEL_DATA_DIR: path.join(dir, 'data'), KERNEL_LIB_DIR: path.join(dir, 'lib'), CPA_BINARY: path.join(dir, 'cli-proxy-api'),
    CPA_INSTALL: path.join(dir, 'install.sh'), CPA_HOLD_FILE: path.join(dir, 'hold'), CPA_CONFIG: path.join(dir, 'config.yaml'), MAGPIE_STANDBY_DIR: path.join(dir, 'magpie'),
    AUTOUPDATE_ROLE: role }
  const paths = applierPaths(env)
  await fs.mkdir(paths.cpa.inbox, { recursive: true })
  await fs.mkdir(paths.magpie.inbox, { recursive: true })
  await fs.mkdir(paths.requests, { recursive: true })
  // `probe`: what the hook would have written for each phase (the real hook is tested on its own below)
  const world = { running, active: true, installs: [], install, probe: { baseline: true, verify: true } }
  const versionOf = async file => { try { return (await fs.readFile(file, 'utf8')).trim() } catch { return '' } }
  // binaries in this world are text files holding their version; `--version` reads them
  const runner = async (command, args) => {
    if (command === 'systemctl') return { code: 0, stdout: world.active ? 'active\n' : 'inactive\n', stderr: '' }
    if (command === paths.cpa.install) {
      world.installs.push(args)
      const out = args.includes('--') ? args[args.indexOf('--out') + 1] : null
      if (out) {
        for (const [phase, ok] of Object.entries(world.probe)) {
          await fs.writeFile(path.join(out, `probe-${phase}.json`), JSON.stringify({ version: 1, phase, at: at(bj(5, 10)), ok, results: [{ type: 'claude', service: 'claude', model: 'm', ok }] }))
        }
      }
      const result = typeof world.install === 'function' ? await world.install(args) : world.install
      if (result.code === 0) world.running = await versionOf(args[0])
      return { code: result.code, stdout: result.stdout ?? `开始安装 ${RUNNING} -> ${args[1]}（备份 ${path.join(dir, 'backup.bin')}）\n换上 ${args[1]}（swap-at=1791000000）\n安装成功\n`, stderr: '' }
    }
    if (args[0] === '--version') {
      const version = command === paths.cpa.binary ? world.running : await versionOf(command)
      return { code: 0, stdout: `CLIProxyAPI Version: ${version}, Commit: x, BuiltAt: y\n`, stderr: '' }
    }
    throw new Error(`unexpected command ${command}`)
  }
  /** the coordinator's delivery: binary + report, and on production preview's promotion record for it */
  const drop = async (version, { body = version, report = {}, promote = role === 'production', promotion = {} } = {}) => {
    await fs.writeFile(path.join(paths.cpa.inbox, `${version}.bin`), body)
    if (promote) await fs.writeFile(path.join(paths.cpa.inbox, 'promotion.json'), JSON.stringify(promoted(version, sha(version), promotion)))
    await fs.writeFile(path.join(paths.cpa.inbox, 'report.json'), JSON.stringify({
      version: 1, kernel: 'cpa', status: 'built', checkedAt: new Date(bj(1)).toISOString(), upstreamLatest: 'v7.3.20', line: 'v7.3', base: 'v7.3.20',
      candidate: { version, sha256: sha(version), tag: 'v7.3.20', checks: [] }, ...report,
    }))
  }
  /** the coordinator's acceptance run against preview */
  const accept = async (version, phase, ok = true, ranAt = bj(1)) => {
    await fs.writeFile(path.join(paths.cpa.inbox, 'acceptance.json'), JSON.stringify({
      version: 1, kind: 'cpa-acceptance', phase, candidate: { version, sha256: sha(version) }, ranAt: at(ranAt), ok,
      checks: [{ name: 'm1 SSE', ok }], summary: ok ? '7 项全部通过' : '1/7 项没过：m1 SSE',
    }))
  }
  const installsOf = version => world.installs.filter(args => args[1] === version)
  return { dir, paths, world, runner, drop, accept, installsOf, close: () => fs.rm(dir, { recursive: true, force: true }) }
}

test('auto: a drop is verified and staged, waits for the window, installs once through the install script', async () => {
  const r = await relay()
  await r.drop(NEXT)
  let clock = bj(3)
  const deps = { run: r.runner, now: () => clock }
  const first = await runAuto({ paths: r.paths, deps })
  assert.equal(first.cpa.why, 'window')
  const state = await readState(r.paths, 'cpa')
  assert.equal(state.staged.version, NEXT)
  assert.equal(state.builder.upstreamLatest, 'v7.3.20')
  assert.equal(r.world.installs.length, 0)

  clock = bj(5, 10)
  const second = await runAuto({ paths: r.paths, deps })
  assert.deepEqual(second.log.find(item => item.kernel === 'cpa'), { kernel: 'cpa', action: 'apply', version: NEXT, result: 'applied' })
  assert.equal(second.cpa.why, 'up-to-date')
  assert.deepEqual(r.world.installs[0].slice(0, 3), [path.join(r.paths.cpa.staged, NEXT, 'cli-proxy-api'), NEXT, '--'])
  assert.deepEqual(r.world.installs[0].slice(-3, -1), ['probe', '--out'], 'every automatic install carries the real-request hook')
  const after = await readState(r.paths, 'cpa')
  assert.equal(after.lastApply.result, 'applied')
  assert.deepEqual([after.applied.version, after.applied.previous], [NEXT, RUNNING])
  assert.equal(after.installed.version, NEXT)
  assert.equal(after.decision.why, 'up-to-date')

  clock = bj(5, 20)
  assert.equal((await runAuto({ paths: r.paths, deps })).cpa.why, 'up-to-date')
  assert.equal(r.world.installs.length, 1)
  await r.close()
})

test('auto: a tampered drop is never staged', async () => {
  const r = await relay()
  await r.drop(NEXT, { body: 'something else' })
  await runAuto({ paths: r.paths, deps: { run: r.runner, now: () => bj(5, 10) } })
  const state = await readState(r.paths, 'cpa')
  assert.equal(state.staged, null)
  assert.equal(state.builder.status, 'upload-failed')
  assert.deepEqual(await fs.readdir(r.paths.cpa.inbox), [])
  assert.equal(r.world.installs.length, 0)
  await r.close()
})

test('auto: a rolled-back install spends the attempt; a refused one is retried after a pause', async () => {
  const r = await relay({ install: { code: 1, stdout: '开始安装 a -> b（备份 /var/backups/cpa/x）\n管理API/Console或AGY兼容回归；准备回滚到 a（备份 /var/backups/cpa/x）\n已回滚到 a\n' } })
  await r.drop(NEXT)
  let clock = bj(5, 10)
  const deps = { run: r.runner, now: () => clock }
  await runAuto({ paths: r.paths, deps })
  let state = await readState(r.paths, 'cpa')
  assert.equal(state.lastApply.result, 'rolled-back')
  assert.equal(state.attempts[NEXT], 1)
  clock = bj(6, 30)
  assert.equal((await runAuto({ paths: r.paths, deps })).cpa.why, 'attempted')
  assert.equal(r.world.installs.length, 1)

  const q = await relay({ install: { code: 1, stdout: 'AGY基线失败，线上未改动；先修复现有故障再升级\n' } })
  await q.drop(NEXT)
  clock = bj(5, 10)
  await runAuto({ paths: q.paths, deps: { run: q.runner, now: () => clock } })
  state = await readState(q.paths, 'cpa')
  assert.equal(state.lastApply.result, 'refused')
  assert.equal(state.attempts[NEXT], undefined)
  clock = bj(5, 20)
  assert.equal((await runAuto({ paths: q.paths, deps: { run: q.runner, now: () => clock } })).cpa.why, 'backoff')
  clock = bj(5, 45)
  q.world.install = { code: 0 }
  assert.equal((await runAuto({ paths: q.paths, deps: { run: q.runner, now: () => clock } })).log.find(item => item.kernel === 'cpa')?.result, 'applied')
  assert.equal((await readState(q.paths, 'cpa')).lastApply.result, 'applied')
  await r.close()
  await q.close()
})

test('auto: a new major goes in like any release (in the window, through the install script); the hold file stops everything', async () => {
  const r = await relay()
  await fs.writeFile(r.paths.cpa.config, 'api-keys: []\n')
  await r.drop(MAJOR)
  for (const hold of ['Locked on purpose: local patches\n', '']) {
    await fs.writeFile(r.paths.cpa.hold, hold)
    assert.equal((await runAuto({ paths: r.paths, deps: { run: r.runner, now: () => bj(5, 10) } })).cpa.why, 'hold-file')
    assert.equal(r.world.installs.length, 0)
  }
  await fs.rm(r.paths.cpa.hold)
  await fs.mkdir(r.paths.cpa.hold)
  assert.equal((await runAuto({ paths: r.paths, deps: { run: r.runner, now: () => bj(5, 10) } })).cpa.why, 'hold-file')
  assert.equal(r.world.installs.length, 0)
  assert.equal((await applyCpa({ paths: r.paths, state: await readState(r.paths, 'cpa'), version: MAJOR, deps: { run: r.runner } })).result, 'refused')
  assert.equal(r.world.installs.length, 0)
  await fs.rmdir(r.paths.cpa.hold)
  const out = await runAuto({ paths: r.paths, deps: { run: r.runner, now: () => bj(5, 10) } })
  assert.equal(out.log.find(item => item.kernel === 'cpa')?.result, 'applied')
  assert.equal(r.world.running, MAJOR)
  const state = await readState(r.paths, 'cpa')
  assert.deepEqual([state.applied.version, state.applied.previous, state.configLayout], [MAJOR, RUNNING, 'legacy'])
  await r.close()
})

test('auto: post-install layout is refreshed before offering a cross-major rollback', async t => {
  const r = await relay()
  t.after(r.close)
  await fs.writeFile(r.paths.cpa.config, 'api-keys: []\n')
  r.world.install = async () => {
    await fs.writeFile(r.paths.cpa.config, 'config-version: 8\n')
    return { code: 0 }
  }
  await r.drop(MAJOR)
  await runAuto({ paths: r.paths, deps: { run: r.runner, now: () => bj(5, 10) } })
  assert.equal((await readState(r.paths, 'cpa')).configLayout, 'v8')
})

test('rollback request: back through the install script; across a major only while config.yaml is still legacy', async () => {
  const r = await relay()
  await r.drop(NEXT)
  const deps = { run: r.runner, now: () => bj(5, 10) }
  await runAuto({ paths: r.paths, deps })
  await fs.writeFile(path.join(r.dir, 'backup.bin'), RUNNING)
  await fs.writeFile(r.paths.cpa.hold, '')
  await fs.writeFile(path.join(r.paths.requests, 'rollback-cpa.json'), JSON.stringify({ confirm: true }))
  const held = await runAuto({ paths: r.paths, deps })
  assert.equal(held.log[0].result, 'refused')
  assert.equal(r.world.installs.length, 1)
  await fs.rm(r.paths.cpa.hold)
  await fs.writeFile(path.join(r.paths.requests, 'rollback-cpa.json'), JSON.stringify({ confirm: true, at: new Date(bj(5, 15)).toISOString() }))
  await fs.writeFile(path.join(r.paths.requests, 'anything-else.json'), '{}')
  const out = await runAuto({ paths: r.paths, deps: { ...deps, now: () => bj(5, 20) } })
  assert.equal(out.log[0].result, 'applied')
  assert.deepEqual(r.world.installs.at(-1), [path.join(r.dir, 'backup.bin'), RUNNING])
  assert.deepEqual(await fs.readdir(r.paths.requests), [])
  const state = await readState(r.paths, 'cpa')
  assert.equal(state.lastApply.result, 'rolled-back-manually')
  assert.equal(state.applied, null)
  assert.equal(out.cpa.why, 'attempted')

  const m = await relay({ running: RUNNING })
  await fs.mkdir(m.paths.states, { recursive: true })
  await fs.writeFile(path.join(m.paths.states, 'cpa.json'), JSON.stringify({ ...emptyState('cpa'), applied: { version: MAJOR, previous: RUNNING, backup: path.join(m.dir, 'b') } }))
  await fs.writeFile(path.join(m.dir, 'b'), RUNNING)
  m.world.running = MAJOR
  await fs.writeFile(m.paths.cpa.config, 'config-version: 8\napi-keys: []\n')
  await fs.writeFile(path.join(m.paths.requests, 'rollback-cpa.json'), JSON.stringify({ confirm: true }))
  const refused = await runAuto({ paths: m.paths, deps: { run: m.runner, now: () => bj(12) } })
  assert.equal(refused.log[0].result, 'refused')
  assert.match((await readState(m.paths, 'cpa')).lastApply.reasons[0].text, /迁移成新格式（v8）/)
  assert.equal(m.world.installs.length, 0)
  await fs.rm(m.paths.cpa.config)
  await fs.writeFile(path.join(m.paths.requests, 'rollback-cpa.json'), JSON.stringify({ confirm: true }))
  const missing = await runAuto({ paths: m.paths, deps: { run: m.runner, now: () => bj(12, 1) } })
  assert.equal(missing.log[0].result, 'refused')
  assert.match((await readState(m.paths, 'cpa')).lastApply.reasons[0].text, /无法确认 config.yaml 仍是旧格式/)
  assert.equal(m.world.installs.length, 0)
  await fs.writeFile(m.paths.cpa.config, 'api-keys: []\n')
  await fs.writeFile(path.join(m.paths.requests, 'rollback-cpa.json'), JSON.stringify({ confirm: true }))
  const back = await runAuto({ paths: m.paths, deps: { run: m.runner, now: () => bj(12, 5) } })
  assert.equal(back.log[0].result, 'applied')
  assert.deepEqual(m.world.installs.at(-1), [path.join(m.dir, 'b'), RUNNING])
  assert.equal(m.world.running, RUNNING)
  await r.close()
  await m.close()
})

test('magpie standby: staged → smoke → current; a failed smoke leaves current alone; rollback flips back', async () => {
  const r = await relay()
  const one = '1'.repeat(40)
  const two = '2'.repeat(40)
  const drop = async revision => {
    await fs.writeFile(path.join(r.paths.magpie.inbox, `${revision}.bin`), `kernel ${revision}`)
    await fs.writeFile(path.join(r.paths.magpie.inbox, 'report.json'), JSON.stringify({ version: 1, kernel: 'magpie', status: 'built', checkedAt: new Date(bj(1)).toISOString(), candidate: { revision, sha256: sha(`kernel ${revision}`) } }))
  }
  let smokeOk = true
  const deps = { run: r.runner, now: () => bj(12), smoke: async () => ({ ok: smokeOk, checks: [{ name: 'health', ok: smokeOk }] }) }
  await drop(one)
  await runAuto({ paths: r.paths, deps })
  assert.equal(await fs.readlink(path.join(r.paths.magpie.root, 'current')), path.join('releases', one.slice(0, 12)))
  await drop(two)
  smokeOk = false
  await runAuto({ paths: r.paths, deps })
  assert.equal(await fs.readlink(path.join(r.paths.magpie.root, 'current')), path.join('releases', one.slice(0, 12)))
  assert.equal((await readState(r.paths, 'magpie')).lastApply.result, 'failed')
  // a new build of the same revision is not retried automatically; a fixed one arrives as a new revision
  const three = '3'.repeat(40)
  smokeOk = true
  await drop(three)
  await runAuto({ paths: r.paths, deps })
  let state = await readState(r.paths, 'magpie')
  assert.deepEqual([state.installed.revision, state.applied.previous, state.applied.previousRevision], [three, one.slice(0, 12), one])
  await fs.writeFile(path.join(r.paths.requests, 'rollback-magpie.json'), JSON.stringify({ confirm: true }))
  await runAuto({ paths: r.paths, deps })
  assert.equal(await fs.readlink(path.join(r.paths.magpie.root, 'current')), path.join('releases', one.slice(0, 12)))
  state = await readState(r.paths, 'magpie')
  assert.equal(state.lastApply.result, 'rolled-back-manually')
  assert.equal(state.installed.revision, one)
  assert.equal(state.decision.why, 'attempted')
  await r.close()
})

test('cli: runs when started through a symlinked release path (systemd uses /opt/crosery-api-console-current)', async () => {
  const { execFileSync } = await import('node:child_process')
  const { fileURLToPath } = await import('node:url')
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kac-'))
  const link = path.join(dir, 'current')
  await fs.symlink(path.dirname(fileURLToPath(import.meta.url)), link)
  const out = execFileSync(process.execPath, [path.join(link, 'kernel-applier.mjs'), 'auto', '--dry-run'], {
    encoding: 'utf8', env: { ...process.env, KERNEL_DATA_DIR: path.join(dir, 'data'), KERNEL_LIB_DIR: path.join(dir, 'lib'), CPA_BINARY: path.join(dir, 'none'), CPA_SERVICE: 'crosery-test-none' },
  })
  assert.equal(JSON.parse(out).dryRun, true)
  await fs.rm(dir, { recursive: true, force: true })
})

/* ── promotion: preview → production ─────────────────────────────────── */

test('promotion record: production refuses anything that is not a matching, soaked, twice-accepted, fresh record', () => {
  const stagedAt = { version: NEXT, sha256: 'a'.repeat(64) }
  const now = bj(5, 10)
  const problems = record => promotionProblems({ record: record && parsePromotion(record), staged: stagedAt, now, policy: POLICY }).map(item => item.code)
  assert.deepEqual(problems(promoted(NEXT)), [])
  assert.deepEqual(problems(null), ['no-record'])
  assert.deepEqual(problems(promoted(NEXT, 'b'.repeat(64))), ['mismatch'])
  assert.deepEqual(problems(promoted(MAJOR)), ['mismatch'])
  const base = promoted(NEXT)
  const installed = Date.parse(base.installedAt)
  const run = (ms, ok = true) => ({ at: at(ms), ok, checks: [] })
  assert.deepEqual(problems({ ...base, acceptance: { ...base.acceptance, soak: run(installed + 25 * HOUR, false) } }), ['acceptance'])
  assert.deepEqual(problems({ ...base, acceptance: { ...base.acceptance, first: run(installed + HOUR, false) } }), ['acceptance'])
  // measured soak, not the soak the record claims
  assert.deepEqual(problems({ ...base, soakMs: 48 * HOUR, acceptance: { first: run(installed + HOUR), soak: run(installed + 23 * HOUR) } }), ['soak'])
  assert.deepEqual(problems({ ...base, acceptance: { first: run(installed + 26 * HOUR), soak: run(installed + 25 * HOUR) } }), ['order'])
  assert.deepEqual(problems({ ...base, acceptedAt: at(now - 8 * 24 * HOUR) }), ['stale'])
  assert.deepEqual(problems({ ...base, acceptedAt: at(now + HOUR) }), ['future'])
  // a stricter production policy wins over what preview used
  assert.deepEqual(promotionProblems({ record: parsePromotion(base), staged: stagedAt, now, policy: { ...POLICY, soakMs: 48 * HOUR } }).map(item => item.code), ['soak'])
  assert.equal(parsePromotion({ ...base, kind: 'other' }), null)
  assert.equal(parsePromotion({ ...base, candidate: { version: '8.0.12; reboot', sha256: 'a'.repeat(64) } }), null)
  assert.equal(parsePromotion({ ...base, acceptance: { first: base.acceptance.first } }), null)
  // decideCpa puts the record gate before the window: production never even waits for the window without one
  const decided = decideCpa({ now: bj(5, 10), config: config(), running: RUNNING, hold: null, state: staged(NEXT, { promotion: null }), policy: POLICY })
  assert.deepEqual([decided.action, decided.why, decided.reasons[0].code], ['none', 'not-promoted', 'no-record'])
  assert.equal(decideCpa({ now: bj(12), config: config(), running: RUNNING, hold: null, state: staged(NEXT), policy: POLICY }).why, 'window')
})

test('preview decide: no window, no daily limit, one trial at a time', () => {
  const base = { now: bj(12), config: config(), running: RUNNING, hold: null, role: 'preview', policy: POLICY }
  assert.deepEqual([decideCpa({ ...base, state: staged(NEXT, { promotion: null }) }).action, decideCpa({ ...base, state: staged(NEXT) }).why], ['apply', 'apply'])
  const trial = startTrial({ version: NEXT, sha256: 'a'.repeat(64), previous: RUNNING, at: at(bj(11)), policy: POLICY })
  assert.equal(decideCpa({ ...base, running: NEXT, state: staged('7.3.21-patched.0', { trial }) }).why, 'trial-active')
  assert.equal(decideCpa({ ...base, running: NEXT, state: staged('7.3.21-patched.0', { trial: { ...trial, status: 'accepted' } }) }).why, 'apply')
  assert.equal(decideCpa({ ...base, state: staged(NEXT, { attempts: { [NEXT]: 1 } }) }).why, 'attempted')
  assert.equal(decideCpa({ ...base, hold: 'x', state: staged(NEXT) }).why, 'hold-file')
})

test('preview trial: first acceptance → soak → soak acceptance only after the soak → accepted; mismatches are ignored', () => {
  const sha256 = sha(NEXT)
  let trial = startTrial({ version: NEXT, sha256, previous: RUNNING, backup: '/b', at: at(bj(5)), policy: POLICY })
  assert.equal(trial.soakUntil, at(bj(5) + 24 * HOUR))
  const record = (phase, ok = true, over = {}) => parseAcceptance({ version: 1, kind: 'cpa-acceptance', phase, candidate: { version: NEXT, sha256 }, ranAt: at(bj(5)), ok, checks: [], summary: ok ? 'ok' : 'SSE 没过', ...over })
  assert.match(applyAcceptance({ trial, record: record('first', true, { candidate: { version: NEXT, sha256: 'f'.repeat(64) } }), now: bj(6) }).note, /ignored/)
  assert.match(applyAcceptance({ trial, record: record('soak'), now: bj(6) }).note, /before the first/)
  trial = applyAcceptance({ trial, record: record('first'), now: bj(6) }).trial
  assert.equal(trial.status, 'soaking')
  assert.match(applyAcceptance({ trial, record: record('first'), now: bj(7) }).note, /already recorded/)
  assert.match(applyAcceptance({ trial, record: record('soak'), now: bj(5) + 23 * HOUR }).note, /too early/)
  const done = applyAcceptance({ trial, record: record('soak'), now: bj(5) + 24 * HOUR + 60_000 })
  assert.equal(done.trial.status, 'accepted')
  const promotion = parsePromotion(promotionRecord(done.trial))
  assert.ok(promotion, 'what preview writes is what production parses')
  assert.deepEqual(promotionProblems({ record: promotion, staged: { version: NEXT, sha256 }, now: bj(5) + 30 * HOUR, policy: POLICY }), [])
  const failed = applyAcceptance({ trial, record: record('soak', false), now: bj(5) + 25 * HOUR })
  assert.equal(failed.reject.code, 'acceptance')
  assert.match(failed.reject.reason, /浸泡后验收没过：SSE 没过/)
  // the candidate must keep running: offline twice in a row rejects it, another binary in its place voids it
  const once = trialTick({ trial, running: null })
  assert.equal(once.reject, undefined)
  assert.equal(trialTick({ trial: once.trial, running: null }).reject.code, 'offline')
  assert.equal(trialTick({ trial: once.trial, running: NEXT, runningSha: sha256 }).trial.offlineTicks, 0)
  assert.equal(trialTick({ trial, running: RUNNING }).reject.noRollback, true)
  assert.equal(trialTick({ trial, running: NEXT, runningSha: 'e'.repeat(64) }).reject.code, 'replaced')
})

test('auto (preview): installs at once, soaks, takes both acceptance runs, writes the promotion record; a newer build waits', async t => {
  const r = await relay({ role: 'preview' })
  t.after(r.close)
  let clock = bj(12)
  const deps = { run: r.runner, now: () => clock }
  await r.drop(NEXT)
  const first = await runAuto({ paths: r.paths, deps })
  assert.deepEqual(first.log.find(item => item.kernel === 'cpa'), { kernel: 'cpa', action: 'apply', version: NEXT, result: 'applied' }, 'no window on preview')
  let state = await readState(r.paths, 'cpa')
  assert.deepEqual([state.env, state.trial.status, state.trial.version, state.trial.sha256], ['preview', 'installed', NEXT, sha(NEXT)])
  assert.equal(state.lastApply.probes.verify.ok, true)

  const NEWER = '7.3.21-patched.5e5e5e5e'
  await r.drop(NEWER)
  assert.equal((await runAuto({ paths: r.paths, deps })).cpa.why, 'trial-active')
  assert.equal(r.installsOf(NEWER).length, 0)

  await r.accept(NEXT, 'first')
  clock = bj(13)
  await runAuto({ paths: r.paths, deps })
  assert.equal((await readState(r.paths, 'cpa')).trial.status, 'soaking')
  await r.accept(NEXT, 'soak')
  clock = bj(12) + 20 * HOUR
  await runAuto({ paths: r.paths, deps })
  assert.equal((await readState(r.paths, 'cpa')).trial.status, 'soaking', 'a soak run before the soak is over does not count')
  await assert.rejects(fs.access(r.paths.cpa.promotion))
  await r.accept(NEXT, 'soak')
  clock = bj(12) + 24 * HOUR + 5 * 60_000
  const accepted = await runAuto({ paths: r.paths, deps })
  assert.deepEqual(accepted.log.find(item => item.action === 'accept'), { kernel: 'cpa', action: 'accept', version: NEXT, result: 'accepted' })
  const record = parsePromotion(JSON.parse(await fs.readFile(r.paths.cpa.promotion, 'utf8')))
  assert.deepEqual([record.candidate.version, record.candidate.sha256, record.acceptance.first.ok, record.acceptance.soak.ok], [NEXT, sha(NEXT), true, true])
  // the trial is over: the newer build that waited goes in on the same tick
  assert.deepEqual(accepted.log.find(item => item.action === 'apply'), { kernel: 'cpa', action: 'apply', version: NEWER, result: 'applied' })
  state = await readState(r.paths, 'cpa')
  assert.deepEqual([state.trial.version, state.trial.status], [NEWER, 'installed'])
})

test('auto (preview): a failed acceptance rolls preview back through the install script and rejects the candidate for good', async t => {
  const r = await relay({ role: 'preview' })
  t.after(r.close)
  const deps = { run: r.runner, now: () => bj(12) }
  await r.drop(NEXT)
  await runAuto({ paths: r.paths, deps })
  await fs.writeFile(path.join(r.dir, 'backup.bin'), RUNNING)
  await r.accept(NEXT, 'first', false)
  const out = await runAuto({ paths: r.paths, deps: { ...deps, now: () => bj(13) } })
  assert.deepEqual(out.log.find(item => item.action === 'reject'), { kernel: 'cpa', action: 'reject', version: NEXT, result: 'rolled-back', reason: 'acceptance' })
  assert.deepEqual(r.world.installs.at(-1), [path.join(r.dir, 'backup.bin'), RUNNING], 'the restore goes through the same install transaction')
  assert.equal(r.world.running, RUNNING)
  const state = await readState(r.paths, 'cpa')
  assert.deepEqual([state.trial.status, state.trial.rejected.rollback, state.lastApply.action, state.lastApply.result], ['rejected', 'rolled-back', 'reject', 'rolled-back'])
  assert.match(state.lastApply.reasons[0].text, /首次验收没过/)
  assert.equal(state.installed.version, RUNNING)
  assert.equal(out.cpa.why, 'attempted', 'a rejected candidate is never installed again')
  await assert.rejects(fs.access(r.paths.cpa.promotion), 'no promotion record for a rejected candidate')
})

test('auto (preview): offline on two ticks rejects and rolls back; a binary swapped by hand voids the trial without touching it', async t => {
  const r = await relay({ role: 'preview' })
  t.after(r.close)
  const deps = { run: r.runner, now: () => bj(12) }
  await r.drop(NEXT)
  await runAuto({ paths: r.paths, deps })
  await fs.writeFile(path.join(r.dir, 'backup.bin'), RUNNING)
  r.world.active = false
  await runAuto({ paths: r.paths, deps })
  assert.equal((await readState(r.paths, 'cpa')).trial.offlineTicks, 1)
  const out = await runAuto({ paths: r.paths, deps })
  assert.equal(out.log.find(item => item.action === 'reject')?.reason, 'offline')

  const q = await relay({ role: 'preview' })
  t.after(q.close)
  await q.drop(NEXT)
  await runAuto({ paths: q.paths, deps: { run: q.runner, now: () => bj(12) } })
  q.world.running = '7.3.19-patched.hand'
  const installs = q.world.installs.length
  const voided = await runAuto({ paths: q.paths, deps: { run: q.runner, now: () => bj(13) } })
  assert.equal(voided.log.find(item => item.action === 'reject')?.result, 'voided')
  assert.equal(q.world.installs.length, installs, 'nothing restored over a binary someone else installed')
})

test('auto (production): installs only what the promotion record covers, in the window, with the real-request record kept', async t => {
  const r = await relay()
  t.after(r.close)
  // a report candidate without a record is not even staged on production
  await r.drop(NEXT, { promote: false })
  assert.equal((await runAuto({ paths: r.paths, deps: { run: r.runner, now: () => bj(5, 10) } })).cpa.why, 'no-candidate')
  assert.equal((await readState(r.paths, 'cpa')).staged, null)
  // a record for a binary with another sha256 (rebuilt after preview accepted it) stages nothing either
  await fs.writeFile(path.join(r.paths.cpa.inbox, `${NEXT}.bin`), 'rebuilt')
  await fs.writeFile(path.join(r.paths.cpa.inbox, 'promotion.json'), JSON.stringify(promoted(NEXT, sha(NEXT))))
  await runAuto({ paths: r.paths, deps: { run: r.runner, now: () => bj(5, 10) } })
  assert.equal((await readState(r.paths, 'cpa')).staged, null)
  // a stale record: staged, never installed
  await r.drop(NEXT, { promotion: { acceptedAt: at(bj(5) - 8 * 24 * HOUR) } })
  const stale = await runAuto({ paths: r.paths, deps: { run: r.runner, now: () => bj(5, 10) } })
  assert.deepEqual([stale.cpa.why, stale.cpa.reasons[0].code], ['not-promoted', 'stale'])
  assert.equal(r.world.installs.length, 0)
  // the fresh record arrives on its own (the coordinator sends it before the report)
  await fs.writeFile(path.join(r.paths.cpa.inbox, 'promotion.json'), JSON.stringify(promoted(NEXT, sha(NEXT))))
  const out = await runAuto({ paths: r.paths, deps: { run: r.runner, now: () => bj(5, 20) } })
  assert.equal(out.log.find(item => item.kernel === 'cpa')?.result, 'applied')
  const state = await readState(r.paths, 'cpa')
  assert.deepEqual([state.lastApply.swapAt, state.lastApply.probes.baseline.ok, state.lastApply.probes.verify.ok], [new Date(1791000000_000).toISOString(), true, true])
  assert.equal(state.promotion.candidate.version, NEXT)
})

test('auto (production): real requests failing after the swap → the install script restored the old binary; the version is spent', async t => {
  const backup = '/var/backups/cpa/cli-proxy-api.x'
  const r = await relay({ install: { code: 1, stdout: [
    `开始安装 ${RUNNING} -> ${NEXT}（备份 ${backup}）`, `换上 ${NEXT}（swap-at=1791000000）`,
    `真实请求验证没过（failed: claude ✗ HTTP 502）；准备回滚到 ${RUNNING}（备份 ${backup}）`, '旧二进制已换回（restore-at=1791000012）', `已回滚到 ${RUNNING}，旧版本应答且兼容门禁通过；配置未覆盖`,
  ].join('\n') } })
  t.after(r.close)
  r.world.probe = { baseline: true, verify: false, restored: true }
  await r.drop(NEXT)
  await runAuto({ paths: r.paths, deps: { run: r.runner, now: () => bj(5, 10) } })
  const state = await readState(r.paths, 'cpa')
  assert.deepEqual([state.lastApply.result, state.lastApply.restoreSeconds, state.attempts[NEXT]], ['rolled-back', 12, 1])
  assert.ok(state.lastApply.restoreSeconds <= 30)
  assert.match(state.lastApply.reasons[0].text, /真实请求验证没过（failed: claude ✗ HTTP 502）/)
  assert.deepEqual([state.lastApply.probes.verify.ok, state.lastApply.probes.restored.ok], [false, true])
  assert.equal((await runAuto({ paths: r.paths, deps: { run: r.runner, now: () => bj(5, 50) + 86_400_000 } })).cpa.why, 'attempted')
})

test('ingest: acceptance only on preview, promotion only on production; unreadable files are dropped', async t => {
  const p = await relay({ role: 'production' })
  const v = await relay({ role: 'preview' })
  t.after(p.close)
  t.after(v.close)
  await p.accept(NEXT, 'first')
  const onProduction = await ingestCpa(p.paths, emptyState('cpa'), {})
  assert.equal(onProduction.acceptance, null)
  assert.match(onProduction.notes.join(), /acceptance record ignored on production/)
  await fs.writeFile(path.join(v.paths.cpa.inbox, 'promotion.json'), JSON.stringify(promoted(NEXT)))
  await v.accept(NEXT, 'first')
  const onPreview = await ingestCpa(v.paths, emptyState('cpa'), {})
  assert.equal(onPreview.state.promotion, null)
  assert.equal(onPreview.acceptance.phase, 'first')
  await fs.writeFile(path.join(v.paths.cpa.inbox, 'acceptance.json'), '{"version":1,"kind":"cpa-acceptance","phase":"later"}')
  assert.match((await ingestCpa(v.paths, emptyState('cpa'), {})).notes.join(), /invalid acceptance.json/)
  assert.deepEqual(await fs.readdir(v.paths.cpa.inbox), [])
})

/* ── real requests per OAuth account type ───────────────────────────── */

test('probe inputs: account types from the auth dir, probe keys, models, auth-dir from config.yaml', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kap-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const auth = path.join(dir, 'auth')
  await fs.mkdir(auth)
  const files = { 'claude-a.json': { type: 'claude', access_token: 'secret' }, 'claude-b.json': { type: 'claude' }, 'codex-a.json': { type: 'codex' },
    'agy-off.json': { type: 'antigravity', disabled: true }, 'weird.json': { type: '../x' }, 'notes.txt': { type: 'gemini' } }
  for (const [name, body] of Object.entries(files)) await fs.writeFile(path.join(auth, name), JSON.stringify(body))
  await fs.writeFile(path.join(auth, 'broken.json'), '{')
  assert.deepEqual(await accountTypes(auth), [{ type: 'claude', accounts: 2 }, { type: 'codex', accounts: 1 }])
  assert.deepEqual(await accountTypes(path.join(dir, 'none')), [])
  const config = path.join(dir, 'config.yaml')
  await fs.writeFile(config, 'port: 8317\nauth-dir: "~/.cli-proxy-api" # creds\n')
  assert.equal(await configAuthDir(config), path.join(os.homedir(), '.cli-proxy-api'))
  await fs.writeFile(config, 'port: 8317\n')
  assert.equal(await configAuthDir(config), null)
  const keys = path.join(dir, 'system-keys.json')
  await fs.writeFile(keys, JSON.stringify({ version: 1, lockout: 'x', probes: { claude: 'sk-probe-claude-000000', codex: 'short', 'bad name': 'sk-probe-000000000' } }))
  assert.deepEqual(await readProbeKeys(keys), { claude: 'sk-probe-claude-000000' })
  await fs.writeFile(keys, JSON.stringify({ version: 2, probes: { claude: 'sk-probe-claude-000000' } }))
  assert.deepEqual(await readProbeKeys(keys), {})
  assert.deepEqual(parseProbeModels('claude=claude-haiku-4-5, codex = gpt-5-codex-mini ,bad,=x,y='), { claude: 'claude-haiku-4-5', codex: 'gpt-5-codex-mini' })
  assert.equal(pickProbeModel(['claude-opus-4-1', 'claude-haiku-4-5', 'claude-sonnet-4-5']), 'claude-haiku-4-5')
  assert.equal(pickProbeModel(['gpt-image-1', 'gpt-5']), 'gpt-5')
  assert.equal(pickProbeModel([]), null)
})

test('probes: one request per type in parallel, skipped types say why, failures carry no key, the deadline bounds everything', async () => {
  const keys = { claude: 'sk-probe-claude-000000', codex: 'sk-probe-codex-0000000' }
  const types = [{ type: 'claude' }, { type: 'codex' }, { type: 'antigravity' }]
  const seen = []
  let inflight = 0
  let peak = 0
  const fetchImpl = async (url, init) => {
    seen.push({ url, auth: init.headers.authorization, model: init.body ? JSON.parse(init.body).model : null })
    inflight += 1
    peak = Math.max(peak, inflight)
    await new Promise(resolve => setTimeout(resolve, 5))
    inflight -= 1
    if (url.endsWith('/v1/models')) return new Response(JSON.stringify({ data: [{ id: 'gpt-5' }, { id: 'gpt-5-codex-mini' }] }))
    if (init.headers.authorization.includes('codex')) return new Response(JSON.stringify({ error: { message: `upstream rejected sk-probe-codex-0000000` } }), { status: 502 })
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }))
  }
  const outcome = await runProbes({ types, keys, models: { claude: 'claude-haiku-4-5' }, base: 'http://127.0.0.1:8317', deadline: Date.now() + 20_000, fetchImpl, sleep: async () => {} })
  assert.equal(outcome.ok, false)
  const by = Object.fromEntries(outcome.results.map(item => [item.type, item]))
  assert.deepEqual([by.claude.ok, by.claude.model, by.claude.status], [true, 'claude-haiku-4-5', 200])
  assert.deepEqual([by.codex.ok, by.codex.model, by.codex.attempt], [false, 'gpt-5-codex-mini', 2], 'a failure is retried once while time is left')
  assert.match(by.codex.detail, /HTTP 502 upstream rejected \*\*\*/)
  assert.deepEqual([by.antigravity.ok, by.antigravity.skipped], [null, 'no-probe-key'])
  assert.equal(JSON.stringify(outcome).includes('sk-probe'), false)
  assert.ok(peak >= 2, 'types are probed in parallel')
  assert.ok(seen.every(item => item.url.startsWith('http://127.0.0.1:8317/v1/')))
  // only skipped or no types at all: nothing failed
  assert.equal((await runProbes({ types: [{ type: 'antigravity' }], keys, base: 'x', deadline: Date.now() + 1000, fetchImpl })).ok, true)
  assert.equal((await runProbes({ types: [], keys, base: 'x', deadline: Date.now() + 1000, fetchImpl })).ok, true)
  // injected clock: with the budget already gone nothing is sent and the type fails
  const late = await runProbes({ types: [{ type: 'claude' }], keys, models: { claude: 'm' }, base: 'x', deadline: 1_000, now: () => 5_000, fetchImpl: async () => assert.fail('no request without budget') })
  assert.deepEqual([late.ok, late.results[0].detail], [false, '没有剩余时间'])
  // a hanging upstream is cut at the deadline, not at the per-request timeout
  const started = Date.now()
  const hung = await runProbes({ types: [{ type: 'claude' }], keys, models: { claude: 'm' }, base: 'x', deadline: started + 1_200,
    fetchImpl: (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason))) })
  assert.equal(hung.ok, false)
  assert.ok(Date.now() - started < 3_000, `took ${Date.now() - started} ms`)
})

test('probe command: writes the phase record the applier reads; verify reuses the baseline models; no key in the file', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kapc-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const auth = path.join(dir, 'auth')
  await fs.mkdir(auth)
  await fs.writeFile(path.join(auth, 'c.json'), JSON.stringify({ type: 'claude' }))
  const paths = applierPaths({ KERNEL_DATA_DIR: path.join(dir, 'data'), KERNEL_LIB_DIR: path.join(dir, 'lib'), CPA_AUTH_DIR: auth, CPA_PROBE_BASE_URL: 'http://gw.test' })
  await fs.mkdir(paths.data, { recursive: true })
  await fs.writeFile(paths.systemKeys, JSON.stringify({ version: 1, probes: { claude: 'sk-probe-claude-000000' } }))
  const out = path.join(dir, 'run')
  const models = []
  const fetchImpl = async (url, init) => {
    if (url.endsWith('/v1/models')) return new Response(JSON.stringify({ data: [{ id: 'claude-haiku-4-5' }, { id: 'claude-opus-4-1' }] }))
    models.push(JSON.parse(init.body).model)
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }))
  }
  const baseline = await probeCommand({ paths, out, phase: 'baseline', budgetS: '20', deps: { fetch: fetchImpl } })
  assert.equal(baseline.ok, true)
  const verify = await probeCommand({ paths, out, phase: 'verify', budgetS: '20', deps: { fetch: async (url, init) => (url.endsWith('/v1/models') ? assert.fail('verify reuses the baseline model') : fetchImpl(url, init)) } })
  assert.deepEqual([verify.ok, verify.types, models], [true, [{ type: 'claude', accounts: 1 }], ['claude-haiku-4-5', 'claude-haiku-4-5']])
  const written = await fs.readFile(path.join(out, 'probe-verify.json'), 'utf8')
  assert.equal(written.includes('sk-probe'), false)
  await assert.rejects(probeCommand({ paths, out, phase: 'whenever', budgetS: '5' }), /--phase/)
})
