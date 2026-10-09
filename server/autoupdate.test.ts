import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import express from 'express'
import {
  AutoConfigError, autoupdatePathsFor, buildAutoupdateView, readAutoConfig, readScheduler, registerAutoupdateRoutes, rtkStateDir,
  writeAutoConfig, type AutoupdateFacts,
} from './autoupdate.js'

const repo = path.resolve(import.meta.dirname, '..')
const NOW = new Date(2026, 9, 3, 2, 14).getTime()
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'autoupdate-'))

const facts = (over: Partial<AutoupdateFacts> = {}): AutoupdateFacts => ({
  config: readAutoConfig('/nonexistent/autoupdate.json'), scheduler: 'auto', rtkLocal: '0.50.0',
  rtkState: { latest: 'v0.51.0' }, ...over,
})
const rtk = (over: Partial<AutoupdateFacts> = {}) => buildAutoupdateView(facts(over), NOW).rtk

test('state dir: RTK_STATE_DIR, else ~/.agents/crosery/rtk', () => {
  assert.equal(rtkStateDir({ RTK_STATE_DIR: '/srv/rtk' }, '/home/x'), '/srv/rtk')
  assert.equal(rtkStateDir({}, '/home/x'), '/home/x/.agents/crosery/rtk')
})

test('config: missing = ON; writes validate strictly and land 0600; a leftover key from older releases is ignored', () => {
  const dir = temp()
  try {
    const file = path.join(dir, 'autoupdate.json')
    assert.deepEqual(readAutoConfig(file), { version: 1, rtk: { enabled: true } })
    fs.writeFileSync(file, JSON.stringify({ version: 1, magpie: { enabled: false, window: { start: '01:00', end: '04:30' } }, rtk: { enabled: true } }))
    assert.deepEqual(readAutoConfig(file), { version: 1, rtk: { enabled: true } })
    const next = writeAutoConfig(file, { rtk: { enabled: false } }, NOW)
    assert.equal(next.rtk.enabled, false)
    assert.equal(fs.statSync(file).mode & 0o777, 0o600)
    assert.equal(readAutoConfig(file).rtk.enabled, false)
    for (const bad of [null, [], { rtk: { enabled: 1 } }, { rtk: { enabled: true, extra: 1 } }, { magpie: { enabled: true } }, { other: true }]) {
      assert.throws(() => writeAutoConfig(file, bad), AutoConfigError, JSON.stringify(bad))
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('the scheduled job reads what the console wrote (same dir, same file)', () => {
  const dir = temp()
  try {
    writeAutoConfig(path.join(dir, 'autoupdate.json'), { rtk: { enabled: false } })
    const out = execFileSync(process.execPath, [path.join(repo, 'scripts/rtk-autoupdate.mjs'), 'auto'], {
      encoding: 'utf8', env: { ...process.env, RTK_STATE_DIR: dir, RTK_BIN: path.join(dir, 'none'), AUTOUPDATE_ROLE: 'preview' },
    })
    assert.equal(JSON.parse(out).why, 'disabled')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('rtk line: off, brew, held for breaking, upgraded, pending, failed verification, no scheduler', () => {
  assert.equal(rtk({ config: { ...facts().config, rtk: { enabled: false } } }).line, '已关闭 · 只检查新版本，不下载、不替换')
  assert.equal(rtk({ rtkState: { method: 'homebrew' } }).line, 'Homebrew 安装的 rtk · 自动升级走 brew upgrade rtk')
  assert.equal(rtk().line, '可升级 v0.51.0 · 本机 0.50.0 · 下一轮定时任务升级')
  assert.equal(rtk({ rtkState: { latest: 'v0.51.0', why: 'breaking', reasons: [{ code: 'breaking', text: 'v0.51.0 声明了破坏性变更 · 看过发布说明再用 cradmin rtk upgrade --accept-breaking' }] } }).line,
    '停在待复核：v0.51.0 声明了破坏性变更 · 看过发布说明再用 cradmin rtk upgrade --accept-breaking')
  assert.equal(rtk({ rtkLocal: '0.51.0', rtkState: { latest: 'v0.51.0', why: 'upgraded', lastUpgrade: { from: '0.50.0', to: '0.51.0', at: new Date(NOW - 7200_000).toISOString(), result: 'upgraded' } } }).line,
    '上次 00:14 自动升级到 0.51.0')
  const failed = rtk({ rtkState: { latest: 'v0.51.0', why: 'verify-failed', reasons: [{ code: 'checksum-mismatch', text: 'v0.51.0 没通过校验：sha256 不符' }] } })
  assert.equal(failed.tone, 'bad')
  assert.match(failed.line, /^v0\.51\.0 没通过校验，不再自动重试/)
  assert.equal(rtk({ rtkState: null }).line, '还没取到 rtk 最新版本')
  assert.equal(rtk({ scheduler: 'missing' }).line, '没有安装定时任务 · 开着也不会自动升级')
  assert.equal(rtk({ scheduler: 'unsupported' }).state, 'no-scheduler')
})

test('scheduler mode: the installed systemd timer on Linux, read-only', () => {
  const dir = temp()
  try {
    const unit = path.join(dir, 'crosery-rtk-autoupdate.timer')
    assert.equal(readScheduler(unit, 'darwin'), 'unsupported')
    assert.equal(readScheduler(unit, 'linux'), 'missing')
    fs.writeFileSync(unit, '[Timer]\n')
    assert.equal(readScheduler(unit, 'linux'), 'auto')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('routes: GET view, PUT audited and validated, a non-rtk target is refused, an rtk upgrade needs confirm', async () => {
  const dir = temp()
  const app = express()
  app.use(express.json())
  const audits: string[] = []
  const runs: Array<{ script: string; args: string[] }> = []
  let upgradeOutcome: Record<string, unknown> = { why: 'upgraded', reasons: [] }
  registerAutoupdateRoutes(app, {
    addAudit: (action, target, detail) => audits.push(`${action} ${target} ${detail ?? ''}`),
    repoRoot: repo, rtkLocal: async () => '0.50.0',
    paths: () => autoupdatePathsFor(dir, path.join(dir, 'none.timer')),
    runScript: async (script, args) => {
      runs.push({ script: path.basename(script), args })
      if (args[0] === 'upgrade') return { code: upgradeOutcome.why === 'upgraded' ? 0 : 1, stdout: JSON.stringify(upgradeOutcome), stderr: '' }
      return { code: 0, stdout: JSON.stringify({ why: 'ready' }), stderr: '' }
    },
  })
  const server = app.listen(0, '127.0.0.1')
  await new Promise(resolve => server.once('listening', resolve))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const call = async (method: string, route: string, body?: unknown) => {
    const response = await fetch(base + route, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: response.status, body: await response.json() as Record<string, any> }
  }
  try {
    const view = await call('GET', '/api/autoupdate')
    assert.equal(view.status, 200)
    assert.deepEqual(Object.keys(view.body), ['rtk'])
    assert.equal(view.body.rtk.enabled, true)
    assert.equal((await call('PUT', '/api/autoupdate', { magpie: { enabled: false } })).status, 400)
    const put = await call('PUT', '/api/autoupdate', { rtk: { enabled: false } })
    assert.equal(put.status, 200)
    assert.equal(put.body.rtk.state, 'off')
    assert.equal(audits.at(-1), 'autoupdate_config local rtk=off')
    assert.equal((await call('POST', '/api/autoupdate/run', { target: 'magpie', dryRun: true })).status, 400)
    assert.equal((await call('POST', '/api/autoupdate/run', { target: 'rtk', dryRun: false })).status, 403)
    assert.equal((await call('POST', '/api/autoupdate/run', { target: 'x' })).status, 400)
    assert.equal(runs.length, 0, 'nothing ran for a refused request')
    const dry = await call('POST', '/api/autoupdate/run', { target: 'rtk', dryRun: true })
    assert.equal(dry.status, 200)
    assert.deepEqual(runs.at(-1), { script: 'rtk-autoupdate.mjs', args: ['plan'] })
    const upgraded = await call('POST', '/api/autoupdate/run', { target: 'rtk', dryRun: false, confirm: true })
    assert.deepEqual(runs.at(-1), { script: 'rtk-autoupdate.mjs', args: ['upgrade', '--confirm'] })
    assert.equal(upgraded.status, 200)
    // only an upgrade that landed is 2xx; held and failed ones keep their structured result
    upgradeOutcome = { why: 'breaking', reasons: [{ code: 'breaking', text: 'v0.51.0 声明了破坏性变更' }] }
    const held = await call('POST', '/api/autoupdate/run', { target: 'rtk', dryRun: false, confirm: true })
    assert.deepEqual([held.status, held.body.code, held.body.error, held.body.result.why], [409, 'upgrade_held', 'v0.51.0 声明了破坏性变更', 'breaking'])
    upgradeOutcome = { why: 'rolled-back', reasons: [{ code: 'post-swap', text: 'installed rtk reports nothing, expected 0.51.0; restored 0.50.0' }] }
    const rolledBack = await call('POST', '/api/autoupdate/run', { target: 'rtk', dryRun: false, confirm: true })
    assert.deepEqual([rolledBack.status, rolledBack.body.code], [502, 'upgrade_failed'])
    assert.match(rolledBack.body.error, /restored 0\.50\.0/)
  } finally {
    server.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
