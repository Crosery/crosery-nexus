import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import express from 'express'
import {
  KernelConfigError, buildKernelsView, kernelPaths, probeWords, readKernelConfig, readKernelFacts, registerKernelRoutes, writeKernelConfig, zonedClock,
} from './kernels.js'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kernels-'))
// Beijing 2026-10-03 hh:mm
const bj = (h: number, m = 0) => Date.UTC(2026, 9, 3, h - 8, m)
const NOW = bj(12)
const at = (ms: number) => new Date(ms).toISOString()
const RUNNING = '7.3.20-patched.1a2b3c4d'

const facts = (cpa: Record<string, unknown> | null, over: Record<string, unknown> = {}) => ({
  config: readKernelConfig('/nonexistent/kernel-autoupdate.json'), scheduler: 'installed' as const, cpa, magpie: null, cpaRunning: RUNNING, ...over,
})
const tick = (decision: Record<string, unknown>, over: Record<string, unknown> = {}) => ({ version: 1, kernel: 'cpa', checkedAt: at(NOW - 60_000), decision, ...over })
const cpaView = (state: Record<string, unknown> | null, over: Record<string, unknown> = {}) => buildKernelsView(facts(state, over), NOW).kernels[0]

test('config: same defaults as the applier; strict PUT; the time zone is not editable here', () => {
  const dir = temp()
  const file = path.join(dir, 'kernel-autoupdate.json')
  assert.deepEqual(readKernelConfig(file), { version: 1, cpa: { enabled: true }, magpie: { enabled: true }, window: { start: '05:00', end: '07:00', tz: 'Asia/Shanghai' } })
  writeKernelConfig(file, { cpa: { enabled: false }, window: { start: '04:30', end: '06:30' } })
  assert.deepEqual(readKernelConfig(file).window, { start: '04:30', end: '06:30', tz: 'Asia/Shanghai' })
  assert.equal(readKernelConfig(file).cpa.enabled, false)
  for (const bad of [null, { rtk: {} }, { cpa: { enabled: 'yes' } }, { cpa: { enabled: true, x: 1 } }, { window: { start: '5:00', end: '07:00' } }, { window: { start: '05:00', end: '07:00', tz: 'UTC' } }]) {
    assert.throws(() => writeKernelConfig(file, bad), KernelConfigError)
  }
  // the applier reads the same file the same way
  const out = execFileSync(process.execPath, ['--input-type=module', '-e',
    `import { normalizeConfig, readJSON } from ${JSON.stringify(path.join(repo, 'scripts/kernel-applier.mjs'))}; console.log(JSON.stringify(normalizeConfig(await readJSON(${JSON.stringify(file)}))))`], { encoding: 'utf8' })
  const applier = JSON.parse(out)
  assert.deepEqual({ cpa: applier.cpa, magpie: applier.magpie, window: applier.window }, { cpa: { enabled: false }, magpie: { enabled: true }, window: { start: '04:30', end: '06:30', tz: 'Asia/Shanghai' } })
  fs.rmSync(dir, { recursive: true, force: true })
})

test('clock: in the window time zone', () => {
  assert.equal(zonedClock(bj(5, 12), NOW, 'Asia/Shanghai'), '05:12')
  assert.equal(zonedClock(bj(5, 12) + 86_400_000, NOW, 'Asia/Shanghai'), '10/04 05:12')
})

test('CPA view: the line says what the applier decided, in the owner\'s words', () => {
  assert.match(cpaView(null).line, /还没跑过/)
  assert.match(cpaView(null, { scheduler: 'missing' }).line, /没有安装内核更新定时任务/)
  assert.match(cpaView(tick({ why: 'up-to-date' }), { config: { ...readKernelConfig('/x'), cpa: { enabled: false } } }).line, /^已关闭/)
  assert.match(cpaView(tick({ why: 'up-to-date' }, { checkedAt: at(NOW - 3_600_000) })).line, /60 分钟没跑了/)
  assert.equal(cpaView(tick({ why: 'window', version: '7.3.21-patched.9' })).line, '7.3.21-patched.9 演练通过 · 等 05:00–07:00（北京时间）替换')
  assert.match(cpaView(tick({ why: 'hold-file' })).line, /补丁锁/)
  const rolled = cpaView(tick({ why: 'attempted', version: '7.3.21-patched.9' }, {
    lastApply: { version: '7.3.21-patched.9', at: at(bj(5, 10)), action: 'apply', result: 'rolled-back', reasons: [{ code: 'rolled-back', text: '管理API/Console或AGY兼容回归' }] },
  }))
  assert.equal(rolled.tone, 'bad')
  assert.match(rolled.line, /替换失败，已自动回滚 · 不再自动重试这个版本/)
  assert.equal(rolled.last?.text, '05:10 替换 7.3.21-patched.9 后验收没过，已自动回滚')
  const backoff = cpaView(tick({ why: 'backoff', version: '7.3.21-patched.9', retryAt: at(bj(5, 40)) }, {
    lastApply: { version: '7.3.21-patched.9', at: at(bj(5, 10)), action: 'apply', result: 'refused', reasons: [{ code: 'refused', text: 'AGY基线失败，线上未改动' }] },
  }))
  assert.equal(backoff.line, '上次没替换成（AGY基线失败，线上未改动） · 05:40 再试')
})

test('CPA view: upstream, candidate and one-click rollback (across a major only while config.yaml is legacy)', () => {
  const builder = { status: 'built', checkedAt: at(NOW), upstreamLatest: 'v8.0.12', line: 'v7.3', heldNewer: { tag: 'v8.0.12', text: '跨 major' },
    candidate: { version: '7.3.21-patched.9', sha256: 'a'.repeat(64), checks: [{ name: 'models', ok: true }, { name: 'write', ok: true }] } }
  const view = cpaView(tick({ why: 'up-to-date' }, { builder, staged: { version: '7.3.21-patched.9' },
    applied: { version: RUNNING, previous: '7.3.15-patched.498fcc2b', backup: '/var/backups/cpa/x', at: at(bj(5, 10)) } }))
  assert.deepEqual(view.upstream, { latest: 'v8.0.12', line: 'v7.3', heldNewer: 'v8.0.12', checkedAt: at(NOW) })
  assert.deepEqual(view.candidate, { label: '7.3.21-patched.9', tone: 'ok', text: 'go test · 冒烟 2/2 通过 · 已暂存到中转站' })
  assert.deepEqual(view.rollback, { to: '7.3.15-patched.498fcc2b' })
  const across = { applied: { version: '8.0.12-patched.5', previous: RUNNING } }
  assert.deepEqual(cpaView(tick({ why: 'up-to-date' }, { ...across, configLayout: 'legacy' })).rollback, { to: RUNNING })
  assert.equal(cpaView(tick({ why: 'up-to-date' }, { ...across, configLayout: 'v8' })).rollback, null)
  assert.equal(cpaView(tick({ why: 'up-to-date' }, across)).rollback, null)
  const conflict = cpaView(tick({ why: 'held' }, { builder: { status: 'merge-conflict', checkedAt: at(NOW), reasons: [{ code: 'merge', text: '合并 v7.3.22 冲突：internal/config/config.go' }] } }))
  assert.equal(conflict.candidate?.tone, 'bad')
  assert.equal(conflict.candidate?.text, '合并 v7.3.22 冲突：internal/config/config.go')
})

const CAND = '8.0.22-patched.1a2b3c4d'
const SHA = 'b'.repeat(64)

test('CPA view on preview: the trial in the owner\'s words; a rejection says what was restored', () => {
  const trial = (over: Record<string, unknown>) => ({ env: 'preview', trial: { version: CAND, sha256: SHA, previous: RUNNING, installedAt: at(bj(9)), soakMs: 86_400_000, soakUntil: at(bj(9) + 86_400_000), status: 'installed', rejected: null, ...over } })
  const installed = buildKernelsView(facts(tick({ why: 'up-to-date', version: CAND }, trial({}))), NOW)
  assert.equal(installed.env, 'preview')
  assert.equal(installed.kernels[0].roleText, '接流量 · 预发布')
  assert.equal(installed.kernels[0].pipeline?.text, `${CAND} 已在预发布试运行 · 等首次验收`)
  assert.equal(cpaView(tick({ why: 'up-to-date' }, trial({ status: 'soaking' }))).pipeline?.text, `${CAND} 首次验收通过 · 浸泡到 10/04 09:00 再验收`)
  assert.equal(cpaView(tick({ why: 'up-to-date' }, trial({ status: 'accepted' }))).pipeline?.text, `${CAND} 两次验收通过（浸泡 24 小时）· 记录交给正式`)
  const reject = { at: at(bj(11)), code: 'acceptance', reason: '首次验收没过：stream 没有 [DONE]', rollback: 'rolled-back' }
  const rejected = cpaView(tick({ why: 'up-to-date' }, { ...trial({ status: 'rejected', rejected: reject }),
    lastApply: { version: CAND, at: reject.at, action: 'reject', result: 'rolled-back', reasons: [{ code: 'acceptance', text: reject.reason }] } }))
  assert.deepEqual(rejected.pipeline, { stage: 'rejected', tone: 'bad', text: `${CAND} 没过：首次验收没过：stream 没有 [DONE] · 已换回 ${RUNNING}` })
  assert.equal(rejected.last?.text, `11:00 ${CAND} 在预发布没过（首次验收没过：stream 没有 [DONE]），已换回 ${RUNNING}`)
  assert.deepEqual(rejected.error, { text: '首次验收没过：stream 没有 [DONE]', at: reject.at })
  const voided = cpaView(tick({ why: 'up-to-date' }, trial({ status: 'rejected', rejected: { ...reject, code: 'replaced', reason: '运行中的已不是它', rollback: 'voided' } })))
  assert.equal(voided.pipeline?.tone, 'warn')
  assert.match(voided.pipeline?.text ?? '', /没有回滚（已被换掉）$/)
  const adopted = cpaView(tick({ why: 'up-to-date' }, { ...trial({}), lastApply: { version: CAND, at: at(bj(9)), action: 'adopt', result: 'adopted', reasons: [] } }))
  assert.deepEqual(adopted.last, { text: `09:00 把手工装上的 ${CAND} 接入预发布试运行`, tone: 'ok', at: at(bj(9)) })
  assert.equal(adopted.error, null)
  assert.match(cpaView(tick({ why: 'trial-active', version: '8.0.23-patched.2', trial: CAND }, trial({}))).line, new RegExp(`^${CAND} 还在试运行 · 8\\.0\\.23-patched\\.2 等它结束`))
})

test('CPA view on production: staged with the preview record, then installed; an unusable record is held with its reason', () => {
  const promotion = { candidate: { version: CAND, sha256: SHA }, acceptedAt: at(bj(9, 30)) }
  const staged = cpaView(tick({ why: 'window', version: CAND }, { env: 'production', promotion, staged: { version: CAND, sha256: SHA } }))
  assert.equal(staged.roleText, '接流量 · 正式')
  assert.deepEqual(staged.pipeline, { stage: 'staged', tone: 'ok', text: `${CAND} 预发布两次验收通过 · 已暂存到正式，等 05:00–07:00（北京时间）替换` })
  const installed = cpaView(tick({ why: 'up-to-date' }, { env: 'production', promotion, staged: { version: CAND }, installed: { version: CAND } }))
  assert.equal(installed.pipeline?.text, `${CAND} 已装上 · 预发布验收于 09:30`)
  const waiting = cpaView(tick({ why: 'not-promoted', version: CAND, reasons: [{ code: 'no-record', text: '没有预发布的记录' }] }, { env: 'production', staged: { version: CAND } }))
  assert.equal(waiting.tone, 'idle')
  assert.equal(waiting.line, `${CAND} 已暂存 · 等预发布两次验收的记录`)
  assert.equal(waiting.error, null)
  const stale = { why: 'not-promoted', version: CAND, at: at(NOW - 60_000), reasons: [{ code: 'stale', text: '预发布的记录超过 7 天' }] }
  const held = cpaView(tick(stale, { env: 'production', promotion, staged: { version: CAND } }))
  assert.equal(held.state, 'held')
  assert.equal(held.line, `${CAND} 的预发布记录不能用：预发布的记录超过 7 天`)
  assert.equal(held.pipeline?.tone, 'warn')
  assert.deepEqual(held.error, { text: '预发布的记录超过 7 天', at: stale.at })
  // earlier stages come from the coordinator's word on preview
  const soaking = cpaView(tick({ why: 'up-to-date' }, { env: 'production', builder: { status: 'built', checkedAt: at(NOW), preview: { version: CAND, stage: 'soaking', soakUntil: at(bj(20)) } } }))
  assert.deepEqual(soaking.pipeline, { stage: 'soaking', tone: 'idle', text: `${CAND} 在预发布浸泡，到 20:00 再验收` })
  const failed = cpaView(tick({ why: 'up-to-date' }, { env: 'production', builder: { status: 'built', checkedAt: at(NOW), preview: { version: CAND, stage: 'rejected', reason: '浸泡后验收没过：tool' } } }))
  assert.equal(failed.pipeline?.text, `${CAND} 在预发布没过：浸泡后验收没过：tool`)
})

test('CPA view: checks show the last tick and the next; an install says how the real requests went and how fast it was restored', () => {
  const view = cpaView(tick({ why: 'up-to-date' }))
  assert.deepEqual(view.checks, { last: at(NOW - 60_000), next: at(NOW + 9 * 60_000) })
  const verify = { ok: false, results: [{ type: 'claude', ok: true }, { type: 'codex', ok: false, detail: '502' }, { type: 'antigravity', ok: null, skipped: 'no-probe-key' }] }
  assert.equal(probeWords({ verify }), '真实请求 1/2 通过（codex 没过） · 跳过 antigravity（没有探测 Key）')
  assert.equal(probeWords({ verify: { ok: true, results: [] } }), '没有 OAuth 账号，免真实请求')
  assert.equal(probeWords({}), '')
  const rolled = cpaView(tick({ why: 'attempted', version: CAND }, {
    lastApply: { version: CAND, at: at(bj(5, 10)), action: 'apply', result: 'rolled-back', restoreSeconds: 12, probes: { verify }, reasons: [{ code: 'verify', text: 'codex 探针 502' }] },
  }))
  assert.equal(rolled.last?.text, `05:10 替换 ${CAND} 后验收没过，12 秒内换回旧版本 · 真实请求 1/2 通过（codex 没过） · 跳过 antigravity（没有探测 Key）`)
  assert.deepEqual(rolled.error, { text: 'codex 探针 502', at: at(bj(5, 10)) })
})

test('routes: GET/PUT; rollback is queued only with confirm and only when there is something to roll back', async () => {
  const dir = temp()
  const paths = kernelPaths(dir, path.join(dir, 'crosery-kernel-update.timer'))
  fs.writeFileSync(paths.timerUnit, '')
  fs.mkdirSync(paths.states, { recursive: true })
  fs.writeFileSync(path.join(paths.states, 'cpa.json'), JSON.stringify({ version: 1, kernel: 'cpa', checkedAt: at(Date.now()), decision: { why: 'up-to-date' },
    applied: { version: RUNNING, previous: '7.3.15-patched.498fcc2b', backup: '/var/backups/cpa/x', at: at(Date.now()) } }))
  let available = true
  const audits: string[] = []
  const app = express()
  app.use(express.json())
  registerKernelRoutes(app, { addAudit: (a, t, d) => audits.push(`${a} ${t} ${d ?? ''}`), paths: () => paths, available: () => available, cpaRunning: async () => RUNNING })
  const server = app.listen(0, '127.0.0.1')
  await new Promise(resolve => server.once('listening', resolve))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const call = async (method: string, route: string, body?: unknown) => {
    const response = await fetch(base + route, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: response.status, body: await response.json() as Record<string, any> }
  }
  try {
    const view = await call('GET', '/api/kernels')
    assert.equal(view.status, 200)
    assert.deepEqual(view.body.kernels.map((k: { id: string; role: string }) => `${k.id}:${k.role}`), ['cpa:serving', 'magpie:standby'])
    assert.equal(view.body.kernels[0].version, RUNNING)
    assert.equal((await call('PUT', '/api/kernels', { cpa: { enabled: 'off' } })).status, 400)
    const put = await call('PUT', '/api/kernels', { magpie: { enabled: false } })
    assert.equal(put.status, 200)
    assert.equal(put.body.kernels[1].state, 'off')
    assert.match(audits.at(-1) ?? '', /^kernel_autoupdate_config relay cpa=on magpie=off window=05:00-07:00 Asia\/Shanghai/)
    assert.equal((await call('POST', '/api/kernels/rollback', { kernel: 'cpa' })).status, 403)
    assert.equal(fs.existsSync(paths.requests), false)
    assert.equal((await call('POST', '/api/kernels/rollback', { kernel: 'magpie', confirm: true })).status, 409)
    const queued = await call('POST', '/api/kernels/rollback', { kernel: 'cpa', confirm: true })
    assert.equal(queued.status, 202)
    assert.equal(queued.body.to, '7.3.15-patched.498fcc2b')
    const request = JSON.parse(fs.readFileSync(path.join(paths.requests, 'rollback-cpa.json'), 'utf8'))
    assert.equal(request.confirm, true)
    // what the console queues is what the applier takes
    const taken = execFileSync(process.execPath, ['--input-type=module', '-e',
      `import { takeRequests } from ${JSON.stringify(path.join(repo, 'scripts/kernel-applier.mjs'))}; console.log(JSON.stringify(await takeRequests({ requests: ${JSON.stringify(paths.requests)} })))`], { encoding: 'utf8' })
    assert.deepEqual(JSON.parse(taken).map((item: { kernel: string; action: string }) => `${item.action}:${item.kernel}`), ['rollback:cpa'])
    available = false
    const off = await call('GET', '/api/kernels')
    assert.equal(off.body.available, false)
    assert.equal((await call('PUT', '/api/kernels', { cpa: { enabled: true } })).status, 409)
  } finally {
    server.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('facts: a missing timer unit is "missing"; unreadable state files are ignored', () => {
  const dir = temp()
  const paths = kernelPaths(dir, path.join(dir, 'none.timer'))
  fs.mkdirSync(paths.states, { recursive: true })
  fs.writeFileSync(path.join(paths.states, 'cpa.json'), '{not json')
  const read = readKernelFacts(paths, null)
  assert.equal(read.scheduler, 'missing')
  assert.equal(read.cpa, null)
  fs.rmSync(dir, { recursive: true, force: true })
})
