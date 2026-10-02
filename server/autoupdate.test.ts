import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import express from 'express'
import { MAGPIE_API_REVISION } from '../packages/contracts/magpie-upstream.generated.js'
import {
  AutoConfigError, autoRowWords, autoupdatePathsFor, buildAutoupdateView, readAutoConfig, readScheduler, registerAutoupdateRoutes,
  writeAutoConfig, writeSigninLease, type AutoupdateFacts,
} from './autoupdate.js'
import { readMagpieUpstreamStatus } from './magpieUpstream.js'
import { readMagpieGateway } from './magpieVersion.js'

const repo = path.resolve(import.meta.dirname, '..')
const CAND = 'c'.repeat(40)
const NEXT = 'e'.repeat(40)
const NOW = new Date(2026, 9, 3, 2, 14).getTime()
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'autoupdate-'))

const facts = (over: Partial<AutoupdateFacts> = {}): AutoupdateFacts => ({
  config: readAutoConfig('/nonexistent/autoupdate.json'), scheduler: 'auto', magpieLocal: true, running: MAGPIE_API_REVISION, rtkLocal: '0.50.0',
  magpieState: null, rtkState: null,
  upstream: { version: 1, status: 'review_required', candidateRevision: CAND, latestRelease: 'v0.1.679', rtkRelease: 'v0.51.0' }, ...over,
})
const magpie = (over: Partial<AutoupdateFacts> = {}) => buildAutoupdateView(facts(over), NOW).magpie
const rtk = (over: Partial<AutoupdateFacts> = {}) => buildAutoupdateView(facts(over), NOW).rtk

test('config: missing = ON with 03:00–06:00; writes validate strictly and land 0600', () => {
  const dir = temp()
  try {
    const file = path.join(dir, 'autoupdate.json')
    assert.deepEqual(readAutoConfig(file), { version: 1, magpie: { enabled: true, window: { start: '03:00', end: '06:00' } }, rtk: { enabled: true } })
    const next = writeAutoConfig(file, { magpie: { enabled: false, window: { start: '01:00', end: '04:30' } } }, NOW)
    assert.equal(next.magpie.enabled, false)
    assert.equal(next.rtk.enabled, true, 'an omitted switch keeps its value')
    assert.equal(fs.statSync(file).mode & 0o777, 0o600)
    assert.deepEqual(readAutoConfig(file).magpie.window, { start: '01:00', end: '04:30' })
    for (const bad of [null, [], { magpie: { enabled: 'yes' } }, { rtk: { enabled: 1 } }, { magpie: { window: { start: '3:00', end: '06:00' } } }, { other: true }, { magpie: { enabled: true, extra: 1 } }]) {
      assert.throws(() => writeAutoConfig(file, bad), AutoConfigError, JSON.stringify(bad))
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('the scheduled job reads what the console wrote (same file, same defaults)', () => {
  const dir = temp()
  try {
    writeAutoConfig(path.join(dir, 'autoupdate.json'), { magpie: { enabled: false, window: { start: '02:00', end: '05:00' } }, rtk: { enabled: false } })
    const out = execFileSync(process.execPath, [path.join(repo, 'scripts/magpie-autoupdate.mjs'), 'status'], {
      encoding: 'utf8', env: { ...process.env, MAGPIE_UPSTREAM_RUNTIME: dir, MAGPIE_CONSOLE_RUNTIME: path.join(dir, 'console') },
    })
    const status = JSON.parse(out)
    assert.deepEqual(status.config.magpie, { enabled: false, window: { start: '02:00', end: '05:00' } })
    assert.equal(status.config.rtk.enabled, false)
    assert.equal(status.decision.why, 'disabled')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('the sign-in lease the console writes is what the job checks; an empty list removes it', () => {
  const dir = temp()
  try {
    const lease = path.join(dir, 'signin-active.json')
    writeSigninLease(lease, [{ deadline: Date.now() + 600_000 }])
    const check = () => execFileSync(process.execPath, ['--input-type=module', '-e',
      `import { signinActive } from ${JSON.stringify(path.join(repo, 'scripts/magpie-autoupdate.mjs'))}; console.log(await signinActive(${JSON.stringify(lease)}))`], { encoding: 'utf8' }).trim()
    assert.equal(check(), 'true')
    writeSigninLease(lease, [])
    assert.equal(fs.existsSync(lease), false)
    assert.equal(check(), 'false')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('magpie line: one honest sentence per state', () => {
  assert.equal(magpie({ magpieLocal: false }).line, '仅本机 Magpie 网关 · 这里的网关是 CPA，没有内核可更新')
  assert.equal(magpie({ magpieLocal: false }).available, false)
  assert.equal(magpie({ config: { ...facts().config, magpie: { ...facts().config.magpie, enabled: false } } }).line, '已关闭 · 只检查上游，不演练、不替换')
  assert.equal(magpie({ scheduler: 'check-only' }).line, '定时任务还是只检查的旧版本 · 重装后才会自动更新')
  assert.equal(magpie({ scheduler: 'missing' }).state, 'no-scheduler')
  assert.equal(magpie().line, `候选 ${CAND.slice(0, 7)} 等下一轮定时任务演练`)
  const held = magpie({ magpieState: { candidate: CAND, why: 'held', reasons: [{ code: 'catalog-drift', text: '账号目录有变化：新增 qoder-cn' }, { code: 'settings-drift', text: '网关设置有变化：新增 25 项' }] } })
  assert.equal(held.line, '停在待复核：账号目录有变化：新增 qoder-cn（另有 1 项）')
  assert.equal(held.tone, 'warn')
  assert.equal(magpie({ magpieState: { candidate: CAND, why: 'window', result: 'eligible' } }).line, 'ccccccc 演练通过 · 等 03:00–06:00 窗口替换')
  assert.equal(magpie({ magpieState: { candidate: CAND, why: 'signin', result: 'eligible' } }).line, 'ccccccc 演练通过 · 等登录结束再替换')
  const applied = magpie({ running: CAND, magpieState: { candidate: CAND, why: 'applied', applied: { revision: CAND, release: 'v0.1.679', at: new Date(NOW - 3600_000).toISOString() } } })
  assert.equal(applied.line, '上次 01:14 自动替换到 ccccccc · v0.1.679 · 下次窗口 03:00–06:00')
  const rolled = magpie({ magpieState: { candidate: CAND, why: 'attempted', reasons: [{ code: 'health', text: '替换后 60 秒内没通过健康检查：gateway HTTP 502' }],
    lastApply: { revision: CAND, at: new Date(NOW - 600_000).toISOString(), result: 'rolled-back' } } })
  assert.equal(rolled.line, '02:04 替换 ccccccc 失败已回滚：替换后 60 秒内没通过健康检查：gateway HTTP 502 · 不再自动重试这个版本')
  assert.equal(rolled.tone, 'bad')
  const manual = magpie({ magpieState: { candidate: CAND, why: 'attempted', reasons: [], lastApply: { revision: CAND, at: new Date(NOW - 600_000).toISOString(), result: 'rolled-back-manually' } } })
  assert.equal(manual.line, '02:04 已手动回滚 ccccccc · 不再自动替换这个版本')
  assert.equal(manual.tone, 'warn')
  assert.equal(magpie({ upstream: { status: 'unchanged', candidateRevision: MAGPIE_API_REVISION } }).state, 'up-to-date')
  // a newer candidate after an auto-apply: the newer one's state wins
  const moved = magpie({ running: CAND, upstream: { status: 'review_required', candidateRevision: NEXT }, magpieState: { candidate: NEXT, why: 'held', reasons: [{ code: 'x', text: '登录方式变了：移除 dimagent' }], applied: { revision: CAND, at: new Date(NOW).toISOString() } } })
  assert.equal(moved.state, 'held')
  assert.equal(autoRowWords(held, '待复核 ccccccc'), '检查 · 自动更新开 · ccccccc 停在待复核')
  assert.equal(autoRowWords(magpie({ scheduler: 'check-only' }), '待复核 ccccccc'), '检查 · 自动更新未生效 · 待复核 ccccccc')
})

test('rtk line: off, brew, held for breaking, upgraded, pending, failed verification', () => {
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
  assert.equal(rtk({ scheduler: 'check-only' }).line, '定时任务还是只检查的旧版本 · 重装后才会自动升级')
})

test('scheduler mode comes from the installed plist, read-only', () => {
  const dir = temp()
  try {
    assert.equal(readScheduler(dir, 'darwin'), 'missing')
    assert.equal(readScheduler(dir, 'linux'), 'unsupported')
    fs.writeFileSync(path.join(dir, 'com.crosery.magpie-upstream-check.plist'), '<array><string>node</string><string>check</string></array>')
    assert.equal(readScheduler(dir, 'darwin'), 'check-only')
    fs.writeFileSync(path.join(dir, 'com.crosery.magpie-upstream-check.plist'), '<array><string>node</string><string>scheduled</string></array>')
    assert.equal(readScheduler(dir, 'darwin'), 'auto')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('an auto-applied kernel is not a baseline mismatch; the gateway policy says auto-update is on', () => {
  const dir = temp()
  try {
    const statusFile = path.join(dir, 'status.json')
    fs.writeFileSync(statusFile, JSON.stringify({ version: 1, status: 'review_required', baselineRevision: MAGPIE_API_REVISION, candidateRevision: CAND, checkedAt: new Date(NOW).toISOString(),
      diff: { addedRoutes: [], removedRoutes: [], changedRoutes: [], changedSchemas: [], implementationFiles: [], addedLoginAgents: [], removedLoginAgents: [] } }), { mode: 0o600 })
    assert.equal(readMagpieUpstreamStatus(CAND, statusFile).status, 'baseline_mismatch')
    fs.writeFileSync(path.join(dir, 'autoupdate-magpie.json'), JSON.stringify({ version: 1, applied: { revision: CAND, at: new Date(NOW).toISOString() } }))
    assert.equal(readMagpieUpstreamStatus(CAND, statusFile).status, 'review_required')

    const agents = path.join(dir, 'agents')
    fs.mkdirSync(agents)
    fs.writeFileSync(path.join(agents, 'com.crosery.magpie-upstream-check.plist'), '<dict><key>ProgramArguments</key><array><string>scheduled</string></array><key>StartInterval</key><integer>1800</integer></dict>')
    const paths = { upstreamDir: dir, updateRoot: path.join(dir, 'bin'), launchAgentsDir: agents, binary: 'magpie-kernel' }
    const on = readMagpieGateway({ engine: 'magpie', version: CAND.slice(0, 7), commit: CAND, buildDate: '' }, paths, NOW)
    if (process.platform === 'darwin') {
      assert.equal(on.policy.autoApply, true)
      assert.equal(on.policy.text, '每 30 分钟检查上游 · 新候选自动演练，契约兼容才在 03:00–06:00 自动替换 · 替换前备份，失败自动回滚')
    }
    writeAutoConfig(path.join(dir, 'autoupdate.json'), { magpie: { enabled: false } })
    const off = readMagpieGateway({ engine: 'magpie', version: CAND.slice(0, 7), commit: CAND, buildDate: '' }, paths, NOW)
    assert.equal(off.policy.autoApply, false)
    assert.match(off.policy.text, /只出候选，不自动替换/)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('routes: GET view, PUT audited and validated, a real magpie run is refused, an rtk upgrade needs confirm', async () => {
  const dir = temp()
  const app = express()
  app.use(express.json())
  const audits: string[] = []
  const runs: Array<{ script: string; args: string[] }> = []
  let upgradeOutcome: Record<string, unknown> = { why: 'upgraded', reasons: [] }
  registerAutoupdateRoutes(app, {
    addAudit: (action, target, detail) => audits.push(`${action} ${target} ${detail ?? ''}`),
    repoRoot: repo, magpieLocal: () => true, running: async () => MAGPIE_API_REVISION, rtkLocal: async () => '0.50.0',
    paths: () => autoupdatePathsFor(dir, path.join(dir, 'agents')),
    runScript: async (script, args) => {
      runs.push({ script: path.basename(script), args })
      if (args[0] === 'upgrade') return { code: upgradeOutcome.why === 'upgraded' ? 0 : 1, stdout: JSON.stringify(upgradeOutcome), stderr: '' }
      return { code: 0, stdout: JSON.stringify({ dryRun: true, magpie: { why: 'rehearse' }, why: 'ready' }), stderr: '' }
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
    assert.equal(view.body.magpie.enabled, true)
    assert.equal(view.body.rtk.enabled, true)
    assert.equal((await call('PUT', '/api/autoupdate', { magpie: { enabled: 'no' } })).status, 400)
    const put = await call('PUT', '/api/autoupdate', { rtk: { enabled: false } })
    assert.equal(put.status, 200)
    assert.equal(put.body.rtk.state, 'off')
    assert.match(audits.at(-1) ?? '', /^autoupdate_config local magpie=on window=03:00-06:00 rtk=off/)
    const refused = await call('POST', '/api/autoupdate/run', { target: 'magpie', dryRun: false })
    assert.equal(refused.status, 409)
    assert.equal(refused.body.code, 'scheduled_only')
    assert.equal((await call('POST', '/api/autoupdate/run', { target: 'rtk', dryRun: false })).status, 403)
    assert.equal((await call('POST', '/api/autoupdate/run', { target: 'x' })).status, 400)
    assert.equal(runs.length, 0, 'nothing ran for a refused request')
    const dry = await call('POST', '/api/autoupdate/run', { target: 'magpie', dryRun: true })
    assert.equal(dry.status, 200)
    assert.deepEqual(runs.at(-1), { script: 'magpie-autoupdate.mjs', args: ['auto', '--dry-run'] })
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
