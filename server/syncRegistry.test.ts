import './testDataDir.js'

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { allowFreshInvalidation, createLimiter, mapWithConcurrency, sanitizeSyncError, SyncRegistry, type SyncOutcome } from './syncRegistry.js'

type FakeTimer = { callback: () => void; ms: number; cleared: boolean }

function harness(file: string | null = null, start = 1_000_000) {
  const clock = { now: start }
  const timers: FakeTimer[] = []
  const registry = new SyncRegistry({
    file,
    now: () => clock.now,
    random: () => 0.5,
    setTimer: (callback, ms) => {
      const timer: FakeTimer = { callback, ms, cleared: false }
      timers.push(timer)
      return timer as unknown as ReturnType<typeof setTimeout>
    },
    clearTimer: (timer) => { (timer as unknown as FakeTimer).cleared = true },
    log: () => undefined,
  })
  return { registry, clock, timers }
}

const tempFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sync-registry-')), 'sync-state.json')

test('同一任务单飞：定时器、监听、手动同时触发只跑一次', async () => {
  const { registry } = harness()
  let calls = 0
  let release: () => void = () => undefined
  const gate = new Promise<void>((resolve) => { release = resolve })
  registry.register({
    id: 'job', label: '任务', kind: 'in-process', intervalMs: 60_000,
    run: async () => { calls += 1; await gate; return { result: 'ok', summary: 'done' } },
  })
  const first = registry.run('job', 'timer')
  const second = registry.run('job', 'watch')
  assert.equal(first, second)
  assert.equal(registry.requestRun('job').status, 409)
  release()
  await first
  assert.equal(calls, 1)
})

test('手动运行有服务端冷却；外部任务与未知任务不可运行', async () => {
  const { registry, clock } = harness()
  let calls = 0
  registry.register({
    id: 'job', label: '任务', kind: 'in-process', intervalMs: 60_000, manualCooldownMs: 120_000,
    run: async () => { calls += 1; return { result: 'ok' } },
  })
  registry.register({ id: 'ext', label: '外部', kind: 'external', read: () => ({ intervalMs: null, lastRunAt: null, state: 'unknown', lastResult: null }) })

  const accepted = registry.requestRun('job')
  assert.deepEqual(accepted, { status: 202, body: { accepted: true, jobId: 'job' } })
  await registry.run('job', 'manual')
  const cooled = registry.requestRun('job')
  assert.equal(cooled.status, 429)
  assert.equal(cooled.body.code, 'cooldown')
  assert.equal(cooled.body.retryAfterSec, 120)
  const status = await registry.status()
  const view = status.jobs.find(job => job.id === 'job')!
  assert.equal(view.canRunNow, false)
  assert.ok(view.runCooldownUntil)

  clock.now += 120_000
  assert.equal(registry.requestRun('job').status, 202)
  await registry.run('job', 'manual')
  assert.equal(calls, 2)

  assert.deepEqual(registry.requestRun('ext'), { status: 400, body: { accepted: false, code: 'not_runnable', error: '该任务不能从控制台触发' } })
  assert.equal(registry.requestRun('nope').status, 404)
})

test('出错按任务级指数退避（服从 retryAfter），成功后清零；skipBackoff 时不叠加', async () => {
  const { registry, clock } = harness()
  const outcomes: SyncOutcome[] = [
    { result: 'error', error: 'boom' },
    { result: 'error', error: 'boom again', retryAfterMs: 30 * 60_000 },
    { result: 'ok' },
    { result: 'error', error: 'host-level', skipBackoff: true },
  ]
  registry.register({ id: 'job', label: '任务', kind: 'in-process', intervalMs: 60_000, run: async () => outcomes.shift()! })

  await registry.run('job', 'timer')
  let view = (await registry.status()).jobs[0]
  assert.equal(view.state, 'backoff')
  assert.equal(view.backoffLevel, 1)
  assert.equal(Date.parse(view.backoffUntil!) - clock.now, 60_000)

  await registry.run('job', 'timer')
  view = (await registry.status()).jobs[0]
  assert.equal(view.backoffLevel, 2)
  assert.equal(Date.parse(view.backoffUntil!) - clock.now, 30 * 60_000, 'Retry-After 比指数档更长时以它为准')

  await registry.run('job', 'timer')
  view = (await registry.status()).jobs[0]
  assert.equal(view.backoffLevel, 0)
  assert.equal(view.backoffUntil, null)

  await registry.run('job', 'timer')
  view = (await registry.status()).jobs[0]
  assert.equal(view.state, 'error')
  assert.equal(view.backoffUntil, null)
  assert.equal(view.lastError, 'host-level')
})

test('silent 运行不进历史；手动运行永远记录', async () => {
  const { registry } = harness()
  registry.register({ id: 'job', label: '任务', kind: 'in-process', intervalMs: 60_000, run: async () => ({ result: 'skipped', silent: true }) })
  await registry.run('job', 'timer')
  let view = (await registry.status()).jobs[0]
  assert.equal(view.history.length, 0)
  assert.equal(view.lastRunAt, null)
  await registry.run('job', 'manual')
  view = (await registry.status()).jobs[0]
  assert.equal(view.history.length, 1)
  assert.equal(view.lastResult, 'skipped')
})

test('历史只保留 24h、最多 96 条；requests24h 按小时桶滚动', async () => {
  const { registry, clock } = harness()
  registry.register({ id: 'job', label: '任务', kind: 'in-process', intervalMs: 60_000, run: async (context) => { context.countRequests(2); return { result: 'ok' } } })
  for (let index = 0; index < 120; index += 1) {
    await registry.run('job', 'timer')
    clock.now += 10 * 60_000
  }
  const view = (await registry.status()).jobs[0]
  assert.ok(view.history.length <= 96)
  assert.ok(view.history.every(entry => Date.parse(entry.at) >= clock.now - 24 * 60 * 60_000))
  // 120 轮 × 10 分钟 = 20h，全部在窗口内；每轮 2 次
  assert.equal(view.requests24h, 240)
  clock.now += 26 * 60 * 60_000
  assert.equal((await registry.status()).jobs[0].requests24h, 0)
})

test('状态落盘后重启可见；重启不重置节拍；坏文件按空状态起步', async () => {
  const file = tempFile()
  const first = harness(file)
  first.registry.register({
    id: 'job', label: '任务', kind: 'in-process', intervalMs: 30 * 60_000,
    run: async (context) => { context.countRequests(3); context.data.cursor = 'abc'; return { result: 'ok', summary: '3 模型' } },
  })
  first.registry.start()
  assert.equal(first.timers.at(-1)!.ms, 0, '首次启动没有历史，按 initialDelay 立即排一次')
  await first.registry.run('job', 'timer')
  first.registry.stop()

  const second = harness(file, first.clock.now + 5 * 60_000)
  second.registry.register({ id: 'job', label: '任务', kind: 'in-process', intervalMs: 30 * 60_000, run: async () => ({ result: 'ok' }) })
  const view = (await second.registry.status()).jobs[0]
  assert.equal(view.summary, '3 模型')
  assert.equal(view.requests24h, 3)
  assert.equal(view.history.length, 1)
  assert.equal(second.registry.jobData('job').cursor, 'abc')
  second.registry.start()
  const armed = second.timers.at(-1)!.ms
  assert.ok(armed > 20 * 60_000 && armed <= 30 * 60_000, `重启 5 分钟后应继续等剩余节拍，实际 ${armed}`)

  fs.writeFileSync(file, '{not json')
  const third = harness(file)
  third.registry.register({ id: 'job', label: '任务', kind: 'in-process', intervalMs: 60_000, run: async () => ({ result: 'ok' }) })
  assert.equal((await third.registry.status()).jobs[0].lastRunAt, null)
})

test('observe 记录请求驱动的刷新，失败照样抛给调用方', async () => {
  const { registry } = harness()
  registry.register({ id: 'quota', label: '额度', kind: 'in-process', intervalMs: null, scheduled: false, run: async () => ({ result: 'ok' }) })
  const value = await registry.observe('quota', async () => ({ accounts: 3 }), (payload) => ({ result: 'ok', summary: `${payload.accounts} 账号` }))
  assert.deepEqual(value, { accounts: 3 })
  await assert.rejects(registry.observe('quota', async () => { throw new Error('cpa down') }, () => ({ result: 'ok' })), /cpa down/)
  const view = (await registry.status()).jobs[0]
  assert.equal(view.history.length, 2)
  assert.equal(view.lastResult, 'error')
  assert.equal(view.nextRunAt, null)
})

test('外部任务只读：按观察到的 lastRunAt 补记历史，错误文案去掉凭据', async () => {
  const { registry, clock } = harness()
  let lastRunAt = clock.now - 60_000
  registry.register({
    id: 'ext', label: '外部', kind: 'external',
    read: () => ({ intervalMs: 1_800_000, lastRunAt, state: 'error', lastResult: 'error', lastError: 'Authorization: Bearer sk-abcdefghijklmnop failed' }),
  })
  let view = (await registry.status()).jobs[0]
  assert.equal(view.kind, 'external')
  assert.equal(view.canRunNow, false)
  assert.equal(view.history.length, 1)
  assert.ok(!view.lastError!.includes('abcdefghijklmnop'))
  view = (await registry.status()).jobs[0]
  assert.equal(view.history.length, 1, '同一个 lastRunAt 不重复记')
  lastRunAt = clock.now
  view = (await registry.status()).jobs[0]
  assert.equal(view.history.length, 2)
})

test('fresh 失效开关服务端限流：每 key 每分钟最多一次', () => {
  const now = 5_000_000
  assert.equal(allowFreshInvalidation('test-key', 60_000, now), true)
  assert.equal(allowFreshInvalidation('test-key', 60_000, now + 1_000), false)
  assert.equal(allowFreshInvalidation('other-key', 60_000, now + 1_000), true)
  assert.equal(allowFreshInvalidation('test-key', 60_000, now + 60_000), true)
})

test('有界并发扇出：同时在跑的不超过上限且保持顺序', async () => {
  let active = 0
  let peak = 0
  const result = await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7], 3, async (value) => {
    active += 1
    peak = Math.max(peak, active)
    await new Promise(resolve => setTimeout(resolve, 5))
    active -= 1
    return value * 2
  })
  assert.deepEqual(result, [2, 4, 6, 8, 10, 12, 14])
  assert.equal(peak, 3)
})

/* ────────────────────────── review-sync-balance ────────────────────────── */

test('SB-11 requests24h 是 5 分钟桶的滑动窗口：25 小时前的请求不再算进来', async () => {
  const { registry, clock } = harness()
  registry.register({ id: 'job', label: '任务', kind: 'in-process', intervalMs: 60_000, run: async () => ({ result: 'ok' }) })
  clock.now = 10 * 60 * 60_000 + 59 * 60_000 // 某小时的第 59 分钟
  registry.countRequests('job', 5)
  clock.now += 24 * 60 * 60_000 + 10 * 60_000 // 24h10m 之后：旧整点桶仍会把它算进来
  registry.countRequests('job', 1)
  assert.equal((await registry.status()).jobs[0].requests24h, 1)
})

test('SB-13 手动运行默认服从任务级退避（429 code:backoff），声明 manualBypassesBackoff 的任务照常放行', async () => {
  const { registry, clock } = harness()
  registry.register({ id: 'strict', label: '严格', kind: 'in-process', intervalMs: 60_000, run: async () => ({ result: 'error', error: 'down' }) })
  registry.register({ id: 'lenient', label: '宽松', kind: 'in-process', intervalMs: 60_000, manualBypassesBackoff: true, run: async () => ({ result: 'error', error: 'down' }) })
  await registry.run('strict', 'timer')
  await registry.run('lenient', 'timer')
  const jobs = (await registry.status()).jobs
  const strict = jobs.find(job => job.id === 'strict')!
  assert.equal(strict.state, 'backoff')
  assert.equal(strict.canRunNow, false, '视图与准入一致')
  assert.equal(strict.runCooldownUntil, strict.backoffUntil)
  const rejected = registry.requestRun('strict')
  assert.equal(rejected.status, 429)
  assert.equal(rejected.body.code, 'backoff')
  assert.equal(rejected.body.retryAfterSec, 60)
  assert.equal(jobs.find(job => job.id === 'lenient')!.canRunNow, true)
  assert.equal(registry.requestRun('lenient').status, 202)
  clock.now += 61_000
  assert.equal(registry.requestRun('strict').status, 202)
})

test('SB-04 admitManual：放行时记 manualAt，冷却内拒绝；与 requestRun 共用同一个冷却', async () => {
  const { registry } = harness()
  registry.register({ id: 'job', label: '任务', kind: 'in-process', intervalMs: 60_000, manualCooldownMs: 300_000, run: async () => ({ result: 'ok' }) })
  assert.equal(registry.admitManual('job'), null)
  await registry.run('job', 'manual')
  const second = registry.admitManual('job')
  assert.equal(second?.status, 429)
  assert.equal(second?.body.code, 'cooldown')
  assert.equal(registry.requestRun('job').status, 429)
})

test('SB-16 全局上游闸门：同时在途的任务不超过上限', async () => {
  const limiter = createLimiter(2)
  let active = 0
  let peak = 0
  await Promise.all(Array.from({ length: 7 }, () => limiter.run(async () => {
    active += 1
    peak = Math.max(peak, active)
    await new Promise(resolve => setTimeout(resolve, 3))
    active -= 1
  })))
  assert.equal(peak, 2)
  assert.equal(limiter.active, 0)
  await assert.rejects(limiter.run(async () => { throw new Error('boom') }), /boom/)
  assert.equal(limiter.active, 0, '失败也释放名额')
})

test('SB-19 状态文件里的离谱时间不能让状态接口抛错；任务私有数据在登记时清洗', async () => {
  const file = tempFile()
  fs.writeFileSync(file, JSON.stringify({ version: 1, jobs: {
    job: { lastRunAt: 1e20, nextRunAt: -5, backoffUntil: 9e15, history: [{ at: 1e20, result: 'ok' }, null, { at: 5, result: 'ok' }], requests: { 1: -3, 2: 4 }, data: { keep: 1, drop: null } },
  } }))
  const { registry } = harness(file)
  let sanitized: Record<string, unknown> | null = null
  registry.register({
    id: 'job', label: '任务', kind: 'in-process', intervalMs: 60_000,
    sanitizeData: (data) => { delete data.drop; sanitized = data },
    run: async () => ({ result: 'ok' }),
  })
  const view = (await registry.status()).jobs[0]
  assert.equal(view.lastRunAt, null)
  assert.equal(view.backoffUntil, null)
  assert.deepEqual(registry.jobData('job'), { keep: 1 })
  assert.equal(sanitized, registry.jobData('job'), '原地清洗，引用不变')
})

test('SB-22 / SB-08 外部任务：自带退避显示 backoff；过了预定时间一个周期还没新结果显示 unknown + 逾期', async () => {
  const { registry, clock } = harness()
  let snapshot = { intervalMs: 1_800_000, lastRunAt: clock.now - 60_000, nextRunAt: clock.now + 3 * 3_600_000, state: 'error' as const, lastResult: 'error' as const,
    backoffUntil: clock.now + 3 * 3_600_000 as number | null, backoffLevel: 3, summary: '失败于 public-metadata' }
  registry.register({ id: 'ext', label: '外部', kind: 'external', read: () => snapshot })
  let view = (await registry.status()).jobs[0]
  assert.equal(view.state, 'backoff')
  assert.equal(view.backoffLevel, 3)
  assert.equal(Date.parse(view.backoffUntil!), clock.now + 3 * 3_600_000)

  snapshot = { ...snapshot, state: 'idle' as never, lastResult: 'ok' as never, backoffUntil: null, backoffLevel: 0, nextRunAt: clock.now - 1_900_000, summary: '无变化' }
  view = (await registry.status()).jobs[0]
  assert.equal(view.state, 'unknown', '锁残留等原因导致停摆，不能继续显示 idle')
  assert.equal(view.summary, '无变化 · 逾期未运行')
})

/* ────────────────────────── review-sync-balance 复核（Codex 确认轮） ────────────────────────── */

test('SB-11 迁移：旧文件的整点桶按整小时寿命计入，不被当成 5 分钟桶提前丢掉；新文件带桶宽标记、重复载入不再挪动', async () => {
  const file = tempFile()
  const hour = 10 * 60 * 60_000
  // 旧版本：10:59 的 5 次请求记在 10:00 的整点桶里；没有 requestBucketMs。
  fs.writeFileSync(file, JSON.stringify({ version: 1, jobs: { job: { history: [], requests: { [hour]: 5 }, data: {} } } }))
  const later = hour + 59 * 60_000 + 23 * 60 * 60_000 + 11 * 60_000 // 第二天 10:10：距那些请求 23h11m
  const first = harness(file, later)
  first.registry.register({ id: 'job', label: '任务', kind: 'in-process', intervalMs: 60_000, run: async () => ({ result: 'ok' }) })
  assert.equal((await first.registry.status()).jobs[0].requests24h, 5, '仍在 24h 内的旧计数不能丢')
  first.registry.flush()
  const saved = JSON.parse(fs.readFileSync(file, 'utf8')).jobs.job
  assert.equal(saved.requestBucketMs, 5 * 60_000)

  const second = harness(file, later)
  second.registry.register({ id: 'job', label: '任务', kind: 'in-process', intervalMs: 60_000, run: async () => ({ result: 'ok' }) })
  assert.equal((await second.registry.status()).jobs[0].requests24h, 5)
  second.clock.now = hour + 60 * 60_000 + 24 * 60 * 60_000 // 那一整小时滑出窗口
  assert.equal((await second.registry.status()).jobs[0].requests24h, 0)
})

test('SB-13 冷却与退避同时生效：Retry-After 取更晚的那个，code 跟着它走', async () => {
  const { registry, clock } = harness()
  let fail = false
  registry.register({ id: 'strict', label: '严格', kind: 'in-process', intervalMs: 60_000, manualCooldownMs: 300_000, run: async () => (fail ? { result: 'error', error: 'down', retryAfterMs: 3_600_000 } : { result: 'ok' }) })
  assert.equal(registry.requestRun('strict').status, 202)
  await registry.run('strict', 'manual') // 单飞：等的就是上面放行的那次运行
  fail = true
  await registry.run('strict', 'timer') // 1h 退避，覆盖 5 分钟手动冷却
  const rejected = registry.admitManual('strict')
  assert.equal(rejected?.status, 429)
  assert.equal(rejected?.body.code, 'backoff')
  assert.equal(rejected?.body.retryAfterSec, 3600)
  const view = (await registry.status()).jobs[0]
  assert.equal(Date.parse(view.runCooldownUntil!), clock.now + 3_600_000, '视图与准入一致')
})

test('SB-19 根级时间按时钟夹住：未来的 manualAt / lastRunAt 不能冻结手动运行，任务级退避不超过策略上限', async () => {
  const file = tempFile()
  const now = 50_000_000
  const year = 365 * 24 * 60 * 60_000
  fs.writeFileSync(file, JSON.stringify({ version: 1, jobs: {
    job: { manualAt: now + year, lastRunAt: now + year, lastFinishedAt: now + year, backoffUntil: now + year, backoffLevel: 2, history: [{ at: now + year, result: 'ok' }], requests: {}, data: {} },
  } }))
  const { registry, clock } = harness(file, now)
  registry.register({ id: 'job', label: '任务', kind: 'in-process', intervalMs: 60_000, manualCooldownMs: 300_000, run: async () => ({ result: 'ok' }) })
  const view = (await registry.status()).jobs[0]
  assert.equal(Date.parse(view.lastRunAt!), now)
  assert.equal(view.history.length, 0, '未来的历史条目丢弃')
  assert.equal(Date.parse(view.backoffUntil!), now + 6 * 60 * 60_000, '退避最长 backoff.maxMs')
  assert.equal(Date.parse(view.runCooldownUntil!), now + 6 * 60 * 60_000)
  clock.now = now + 6 * 60 * 60_000 + 1
  assert.equal(registry.admitManual('job'), null, '夹住之后到点即可手动运行，而不是等一年')
})

test('任务错误：裸 fetch failed 写成一句话，其它原样（凭据照旧打码），重复清洗不变', () => {
  assert.equal(sanitizeSyncError('fetch failed'), '网络没连上（fetch failed）')
  assert.equal(sanitizeSyncError(sanitizeSyncError('fetch failed')), '网络没连上（fetch failed）')
  assert.equal(sanitizeSyncError('CPA 502: boom'), 'CPA 502: boom')
  assert.equal(sanitizeSyncError('upstream rejected sk-abcdefgh12345'), 'upstream rejected sk-***')
})
