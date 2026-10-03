import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import {
  applierPaths, classifyInstall, decideCpa, decideMagpie, emptyState, normalizeConfig, parseCpaReport, parseMagpieReport,
  readState, runAuto, sameMajor, windowState, withLock,
} from './kernel-applier.mjs'

// 2026-10-03 in Beijing time (UTC+8, no DST): the default window is 05:00–07:00 there
const bj = (h, m = 0) => Date.UTC(2026, 9, 3, h - 8, m)
const sha = text => createHash('sha256').update(text).digest('hex')
const RUNNING = '7.3.15-patched.498fcc2b'
const NEXT = '7.3.20-patched.1a2b3c4d'
const MAJOR = '8.0.12-patched.5e6f7a8b'

const config = (over = {}) => normalizeConfig(over)
const staged = (version, over = {}) => ({ ...emptyState('cpa'), staged: { version, sha256: 'a'.repeat(64), at: new Date(bj(1)).toISOString() }, ...over })

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
  assert.equal(decideCpa({ ...base, state: staged(MAJOR) }).why, 'major')
  assert.equal(decideCpa({ ...base, state: staged(NEXT, { attempts: { [NEXT]: 1 } }) }).why, 'attempted')
  assert.equal(decideCpa({ ...base, state: staged(NEXT, { nextAttemptAt: new Date(bj(5, 30)).toISOString() }) }).why, 'backoff')
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

async function relay({ running = RUNNING, install = { code: 0 } } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kar-'))
  const env = { KERNEL_DATA_DIR: path.join(dir, 'data'), KERNEL_LIB_DIR: path.join(dir, 'lib'), CPA_BINARY: path.join(dir, 'cli-proxy-api'),
    CPA_INSTALL: path.join(dir, 'install.sh'), CPA_HOLD_FILE: path.join(dir, 'hold'), MAGPIE_STANDBY_DIR: path.join(dir, 'magpie') }
  const paths = applierPaths(env)
  await fs.mkdir(paths.cpa.inbox, { recursive: true })
  await fs.mkdir(paths.magpie.inbox, { recursive: true })
  await fs.mkdir(paths.requests, { recursive: true })
  const world = { running, active: true, installs: [], install }
  const versionOf = async file => { try { return (await fs.readFile(file, 'utf8')).trim() } catch { return '' } }
  // binaries in this world are text files holding their version; `--version` reads them
  const runner = async (command, args) => {
    if (command === 'systemctl') return { code: 0, stdout: world.active ? 'active\n' : 'inactive\n', stderr: '' }
    if (command === paths.cpa.install) {
      world.installs.push(args)
      const result = typeof world.install === 'function' ? world.install(args) : world.install
      if (result.code === 0) world.running = await versionOf(args[0])
      return { code: result.code, stdout: result.stdout ?? `开始安装 ${RUNNING} -> ${args[1]}（备份 ${path.join(dir, 'backup.bin')}）\n安装成功\n`, stderr: '' }
    }
    if (args[0] === '--version') {
      const version = command === paths.cpa.binary ? world.running : await versionOf(command)
      return { code: 0, stdout: `CLIProxyAPI Version: ${version}, Commit: x, BuiltAt: y\n`, stderr: '' }
    }
    throw new Error(`unexpected command ${command}`)
  }
  const drop = async (version, { body = version, report = {} } = {}) => {
    await fs.writeFile(path.join(paths.cpa.inbox, `${version}.bin`), body)
    await fs.writeFile(path.join(paths.cpa.inbox, 'report.json'), JSON.stringify({
      version: 1, kernel: 'cpa', status: 'built', checkedAt: new Date(bj(1)).toISOString(), upstreamLatest: 'v7.3.20', line: 'v7.3', base: 'v7.3.20',
      candidate: { version, sha256: sha(version), tag: 'v7.3.20', checks: [] }, ...report,
    }))
  }
  return { dir, paths, world, runner, drop, close: () => fs.rm(dir, { recursive: true, force: true }) }
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
  assert.equal(second.cpa.why, 'apply')
  assert.deepEqual(r.world.installs[0], [path.join(r.paths.cpa.staged, NEXT, 'cli-proxy-api'), NEXT])
  const after = await readState(r.paths, 'cpa')
  assert.equal(after.lastApply.result, 'applied')
  assert.deepEqual([after.applied.version, after.applied.previous], [NEXT, RUNNING])
  assert.equal(after.installed.version, NEXT)

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
  assert.equal((await runAuto({ paths: q.paths, deps: { run: q.runner, now: () => clock } })).cpa.why, 'apply')
  assert.equal((await readState(q.paths, 'cpa')).lastApply.result, 'applied')
  await r.close()
  await q.close()
})

test('auto: a new major is staged but never installed automatically; the hold file stops everything', async () => {
  const r = await relay()
  await r.drop(MAJOR)
  assert.equal((await runAuto({ paths: r.paths, deps: { run: r.runner, now: () => bj(5, 10) } })).cpa.why, 'major')
  await r.drop(NEXT)
  await fs.writeFile(r.paths.cpa.hold, 'Locked on purpose: local patches\n')
  assert.equal((await runAuto({ paths: r.paths, deps: { run: r.runner, now: () => bj(5, 10) } })).cpa.why, 'hold-file')
  assert.equal(r.world.installs.length, 0)
  await r.close()
})

test('rollback request: same major goes back through the install script; across a major it is refused', async () => {
  const r = await relay()
  await r.drop(NEXT)
  const deps = { run: r.runner, now: () => bj(5, 10) }
  await runAuto({ paths: r.paths, deps })
  await fs.writeFile(path.join(r.dir, 'backup.bin'), RUNNING)
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
  m.world.running = MAJOR
  await fs.writeFile(path.join(m.paths.requests, 'rollback-cpa.json'), JSON.stringify({ confirm: true }))
  const refused = await runAuto({ paths: m.paths, deps: { run: m.runner, now: () => bj(12) } })
  assert.equal(refused.log[0].result, 'refused')
  assert.match((await readState(m.paths, 'cpa')).lastApply.reasons[0].text, /跨大版本/)
  assert.equal(m.world.installs.length, 0)
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
