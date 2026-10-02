import './testDataDir.js'

import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import test from 'node:test'
import express from 'express'

import { loadCacheSummary } from './cacheSummary.js'
import { db } from './db.js'
import type { ConsoleGroup } from './groups.js'
import { loadPerformanceReport, parseUsageScope, scopePlan } from './perfReports.js'
import type { ReadOperation } from './sqliteReadWorker.js'
import {
  loadUsageWorkspaceDaily,
  loadUsageWorkspaceFacets,
  loadUsageWorkspaceOverview,
  loadUsageWorkspaceRequests,
  usageDailyRange,
  usageFilterWindow,
  type UsageWorkspaceFilter,
} from './usageReports.js'
import { parseUsageDailyYear, parseUsageWindowSpan, parseUsageWorkspaceFilter, registerUsageWorkspaceRoutes } from './usageWorkspaceRoutes.js'

/**
 * 自定义窗口（from / to，上海日历日，含首尾）与热力图日序列：
 * - 解析：两端都是真实日期才生效，反了对调，夹到 [保留期起点, 今天]，夹完为空忽略；生效时覆盖 days，旧链接不变；
 * - 窗口：[from 00:00, to 次日 00:00 与当前小时结束取早者)，五个页签（总览 / 请求 / 筛选条 / 缓存 / 性能）同一个数；
 * - 日序列：与页面窗口无关，范围到今天，保留期之前不返回；Key / 模型 / 渠道 / 客户端口径与总览一致。
 */

const NOW = Date.parse('2026-10-02T06:20:00.000Z') // 上海 10/02 14:20
const HOUR = 3_600_000
const DAY = 24 * HOUR
const TZ = 'Asia/Shanghai'
const CLOCK = { timeZone: TZ, now: NOW }
const groups: ConsoleGroup[] = [{ id: 'codex', name: 'Codex', color: '#000', kind: 'oauth', models: ['gpt-5.6-sol'] }]
const reader = {
  async run(operations: readonly ReadOperation[]) {
    return operations.map((op) => {
      const statement = db.prepare(op.sql)
      return op.method === 'get' ? statement.get(...(op.params ?? [])) : statement.all(...(op.params ?? []))
    })
  },
}

let seq = 0
function insertEvent(at: number, key = 'key-a', options: { success?: boolean; model?: string; input?: number } = {}) {
  seq += 1
  const ok = options.success ?? true
  const input = options.input ?? 1_000
  db.prepare(`INSERT INTO usage_events
    (request_id,timestamp,timestamp_ms,key_hash,provider,model,model_group,endpoint,success,status_code,latency_ms,ttft_ms,
     input_tokens,output_tokens,reasoning_tokens,cached_tokens,cache_write_tokens,total_tokens,user_agent,client_type,client_ip,
     error_detail,error_category,upstream_request_id,source,auth_index,cost_usd)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    `span-${seq}`, new Date(at).toISOString(), at, key, 'codex', options.model ?? 'gpt-5.6-sol', 'g', 'POST /v1/responses', ok ? 1 : 0, ok ? 200 : 429,
    800, 200, input, 100, 0, 0, 0, input + 100, 'ua', 'codex-cli', '127.0.0.1', ok ? '' : 'boom', ok ? '' : 'rate_limited', `up-${seq}`, '', 'auth-1', 0.01,
  )
}
/** 上海某天某时（本地）→ UTC 毫秒 */
const sh = (day: string, hour: number) => Date.parse(`${day}T${String(hour).padStart(2, '0')}:30:00.000+08:00`)

db.exec('DELETE FROM usage_events; DELETE FROM usage_hourly_rollup; DELETE FROM api_keys')
for (const [hash, name] of [['key-a', 'Alpha'], ['key-b', 'Beta']]) {
  db.prepare(`INSERT INTO api_keys (key_hash,key_value,name,enabled,created_at,updated_at) VALUES (?,?,?,?,?,?)`)
    .run(hash, `value-${hash}`, name, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
}
// 09/26 2 条（其中 1 条失败）· 09/28 1 条（上海 00:30 = UTC 09/27 16:30）· 09/30 1 条 · 10/02 今天 2 条 · 另一把 Key 09/28 1 条
insertEvent(sh('2026-09-26', 10))
insertEvent(sh('2026-09-26', 11), 'key-a', { success: false })
insertEvent(sh('2026-09-28', 0))
insertEvent(sh('2026-09-30', 23))
insertEvent(sh('2026-10-02', 9), 'key-a', { model: 'gpt-5.6-mini', input: 5_000 })
insertEvent(sh('2026-10-02', 13))
insertEvent(sh('2026-09-28', 15), 'key-b')
// 保留期（90 天）之外的一条：不进任何窗口，也不进日序列
insertEvent(NOW - 120 * DAY)

const ALL: UsageWorkspaceFilter = { days: 7, keyId: '', model: '', provider: '', client: '' }
const options = { timeZone: TZ, retentionDays: 90, now: NOW }
const span = (from: string, to: string) => parseUsageWorkspaceFilter({ from, to }, 90, CLOCK)

test('解析 from/to：真实日期才生效，反了对调，夹到保留期与今天，夹完为空忽略；生效时覆盖 days', () => {
  assert.deepEqual(parseUsageWindowSpan({ from: '2026-09-01', to: '2026-09-28' }, 90, CLOCK), { from: '2026-09-01', to: '2026-09-28', days: 28 })
  assert.deepEqual(parseUsageWindowSpan({ from: '2026-09-28', to: '2026-09-01' }, 90, CLOCK), { from: '2026-09-01', to: '2026-09-28', days: 28 }, '反了对调')
  assert.deepEqual(parseUsageWindowSpan({ from: '2026-10-02', to: '2026-10-02' }, 90, CLOCK), { from: '2026-10-02', to: '2026-10-02', days: 1 })
  // 保留期 90 天：最早到 07/05（今天往前 89 天）；终点不超过今天
  assert.deepEqual(parseUsageWindowSpan({ from: '2026-01-01', to: '2026-12-31' }, 90, CLOCK), { from: '2026-07-05', to: '2026-10-02', days: 90 })
  assert.equal(parseUsageWindowSpan({ from: '2025-01-01', to: '2025-02-01' }, 90, CLOCK), null, '整段在保留期之前')
  assert.equal(parseUsageWindowSpan({ from: '2026-11-01', to: '2026-11-05' }, 90, CLOCK), null, '整段在今天之后')
  for (const bad of [
    { from: '2026-09-01' },
    { to: '2026-09-01' },
    { from: '2026-02-30', to: '2026-03-02' },
    { from: '2026-9-1', to: '2026-09-28' },
    { from: '2026-09-01T00:00', to: '2026-09-28' },
    { from: '9999-99-99', to: '2026-09-28' },
    { from: ['2026-09-01', 'x'], to: 'junk' },
    { from: '', to: '' },
  ]) assert.equal(parseUsageWindowSpan(bad, 90, CLOCK), null, JSON.stringify(bad))

  const filter = span('2026-09-26', '2026-09-28')
  assert.deepEqual([filter.days, filter.from, filter.to], [3, '2026-09-26', '2026-09-28'])
  assert.deepEqual(parseUsageWorkspaceFilter({ from: '2026-09-26', to: '2026-09-28', days: '90' }, 90, CLOCK).days, 3, '覆盖 days')
  const legacy = parseUsageWorkspaceFilter({ days: '30', from: 'bad', to: '2026-09-28' }, 90, CLOCK)
  assert.deepEqual([legacy.days, legacy.from, legacy.to], [30, undefined, undefined], '非法跨度忽略，旧 days 照旧')
  assert.equal('from' in parseUsageWorkspaceFilter({ days: '7' }, 90, CLOCK), false, '旧链接的筛选对象不变（缓存键也不变）')
  const scope = parseUsageScope({ from: '2026-09-26', to: '2026-09-28', keyId: 'key-a' }, 90, CLOCK)
  assert.deepEqual([scope.days, scope.from, scope.to, scope.keyId], [3, '2026-09-26', '2026-09-28', 'key-a'])
})

test('窗口：过去的跨度是整天 [from 00:00, to 次日 00:00)；含今天的跨度截至当前小时结束；前一窗口紧挨且等长', () => {
  const past = usageFilterWindow(span('2026-09-26', '2026-09-28'), NOW, TZ)
  assert.equal(new Date(past.fromMs).toISOString(), '2026-09-25T16:00:00.000Z')
  assert.equal(new Date(past.endMs).toISOString(), '2026-09-28T16:00:00.000Z')
  assert.equal(past.prevFromMs, past.fromMs - 3 * DAY)
  const live = usageFilterWindow(span('2026-10-01', '2026-10-02'), NOW, TZ)
  assert.equal(new Date(live.fromMs).toISOString(), '2026-09-30T16:00:00.000Z')
  assert.equal(new Date(live.endMs).toISOString(), '2026-10-02T07:00:00.000Z')
  assert.equal(live.toMs, NOW)
  // 缓存 / 性能的分桶计划：时钟停在跨度最后一刻，起点是 from 那天 00:00
  const { plan, clock } = scopePlan(parseUsageScope({ from: '2026-09-26', to: '2026-09-28' }, 90, CLOCK), NOW, TZ)
  assert.equal(clock, past.endMs - 1)
  assert.equal(plan.fromMs, past.fromMs)
  assert.equal(plan.bucketMs, 6 * HOUR, '3 天跨度按 6 小时分桶（与 7d 同档）')
})

test('同一跨度：总览账本 = 请求页签 = 筛选条 = 缓存页签 = 性能页签 = 日序列逐日之和', async () => {
  const filter = span('2026-09-26', '2026-09-28')
  const overview = await loadUsageWorkspaceOverview(reader, groups, filter, options)
  assert.equal(overview.ledger.requests, 4, '09/26 两条 + 09/28 两条（含 key-b）')
  assert.equal(overview.ledger.errors, 1)
  assert.deepEqual(overview.window.span, { from: '2026-09-26', to: '2026-09-28' })
  assert.equal(overview.window.from, '2026-09-25T16:00:00.000Z')
  assert.equal(overview.daily.at(-1)?.day, '2026-09-28', '账本的日序列止于跨度最后一天')
  const requests = await loadUsageWorkspaceRequests(reader, reader, groups, filter, { status: '', category: '', page: 1, pageSize: 100 }, options)
  assert.equal(requests.total, 4)
  assert.ok(requests.requests.every((row) => row.timestampMs >= Date.parse('2026-09-25T16:00:00.000Z') && row.timestampMs < Date.parse('2026-09-28T16:00:00.000Z')))
  const facets = await loadUsageWorkspaceFacets(reader, groups, filter, options)
  assert.equal(facets.totals.requests, 4)
  const scope = parseUsageScope({ from: '2026-09-26', to: '2026-09-28' }, 90, CLOCK)
  const perf = await loadPerformanceReport(reader, groups, scope, { timeZone: TZ, now: NOW })
  assert.equal(perf.totals.requests, 4)
  assert.equal(perf.trend.at(-1) && new Date(perf.trend.at(-1)!.t).toISOString() < '2026-09-28T16:00:00.000Z', true, '末桶落在跨度里')
  const cache = await loadCacheSummary(reader, groups, scope, { timeZone: TZ, now: NOW })
  assert.equal(cache.totals.requests + cache.excluded.requests, 3, '缓存页签只数成功请求')
  const daily = await loadUsageWorkspaceDaily(reader, groups, ALL, { ...options, year: 'recent' })
  const inSpan = daily.days.filter((day) => day.day >= '2026-09-26' && day.day <= '2026-09-28')
  assert.equal(inSpan.reduce((total, day) => total + day.requests, 0), overview.ledger.requests)

  // 旧链接（只有 days）不受影响
  const rolling = await loadUsageWorkspaceOverview(reader, groups, ALL, options)
  assert.equal(rolling.window.span, null)
  assert.equal(rolling.window.days, 7)
})

test('日序列：最近一年 = 53 列（周一起）到今天；保留期之前不返回；Key 口径；年份列表', async () => {
  assert.deepEqual(usageDailyRange('recent', '2026-10-02'), { from: '2025-09-29', to: '2026-10-02' })
  assert.equal(new Date('2025-09-29T00:00:00Z').getUTCDay(), 1, '起点是周一')
  assert.deepEqual(usageDailyRange(2026, '2026-10-02'), { from: '2026-01-01', to: '2026-10-02' })
  assert.deepEqual(usageDailyRange(2025, '2026-10-02'), { from: '2025-01-01', to: '2025-12-31' })

  const all = await loadUsageWorkspaceDaily(reader, groups, ALL, { ...options, year: 'recent' })
  assert.equal(all.view, 'workspace')
  assert.deepEqual(all.range, { year: 'recent', from: '2025-09-29', to: '2026-10-02', timeZone: TZ, offsetMinutes: 480 })
  assert.equal(all.history.retainedFrom, '2026-07-05')
  assert.equal(all.days.length, 90, '保留期 90 天：07/05 → 10/02')
  assert.equal(all.days[0].day, '2026-07-05')
  assert.equal(all.days.at(-1)?.day, '2026-10-02')
  assert.equal(all.totals.requests, 7, '保留期外那条不算')
  assert.equal(all.totals.errors, 1)
  assert.deepEqual(all.years, [2026])
  assert.equal(all.history.firstDay, '2026-09-26')
  const today = all.days.at(-1)!
  assert.equal(today.requests, 2)
  assert.deepEqual(today.topModels.map((m) => m.model), ['gpt-5.6-mini', 'gpt-5.6-sol'])
  assert.ok(today.freshInput > 0 && today.output > 0)
  assert.equal(all.days.find((d) => d.day === '2026-09-28')?.requests, 2, '上海 00:30 那条落在 09/28')
  assert.equal(all.days.find((d) => d.day === '2026-09-27')?.costUsd, null, '没有调用的日子花费是 null')

  const mine = await loadUsageWorkspaceDaily(reader, groups, { ...ALL, keyId: 'key-b' }, { ...options, year: 2026 })
  assert.equal(mine.totals.requests, 1)
  assert.equal(mine.range.from, '2026-01-01')
  assert.equal(mine.history.firstDay, '2026-09-28')

  const before = await loadUsageWorkspaceDaily(reader, groups, ALL, { ...options, year: 2025 })
  assert.deepEqual([before.days.length, before.totals.requests], [0, 0], '整年在保留期之前：没有日格')

  assert.equal(parseUsageDailyYear('2026', 90, CLOCK), 2026)
  assert.equal(parseUsageDailyYear('2025', 90, CLOCK), 'recent', '保留期之外的年份')
  assert.equal(parseUsageDailyYear('2025', 400, CLOCK), 2025)
  assert.equal(parseUsageDailyYear('2027', 400, CLOCK), 'recent')
  for (const bad of [undefined, '', 'recent', '26', '2026x', ['2026', '2025']]) assert.equal(parseUsageDailyYear(bad, 400, CLOCK), Array.isArray(bad) ? 2026 : 'recent')
})

test('路由：/api/usage-daily 带共享筛选；from/to 穿过总览 / 请求 / 筛选条；坏参数不报错只忽略', async () => {
  const app = express()
  registerUsageWorkspaceRoutes(app, {
    usageReader: reader,
    latencyReader: reader,
    reportingContext: async () => ({ groups, policyHash: 'test' }),
    retentionDays: 90,
    timeZone: TZ,
    now: () => NOW,
  })
  const server = app.listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const get = async <T>(path: string) => (await (await fetch(`${base}${path}`)).json()) as T
  try {
    type Daily = { view: string; range: { year: string | number }; totals: { requests: number } }
    const daily = await get<Daily>('/api/usage-daily')
    assert.deepEqual([daily.view, daily.range.year, daily.totals.requests], ['workspace', 'recent', 7])
    assert.equal((await get<Daily>('/api/usage-daily?keyId=key-b&year=2026')).totals.requests, 1)
    assert.equal((await get<Daily>('/api/usage-daily?year=1999')).range.year, 'recent')
    assert.equal((await fetch(`${base}/api/usage-daily?model=${encodeURIComponent('x\u0001')}`)).status, 400)

    type Overview = { ledger: { requests: number }; window: { days: number; span: unknown } }
    const spanned = await get<Overview>('/api/usage-overview?view=workspace&from=2026-09-26&to=2026-09-28&days=90')
    assert.deepEqual([spanned.ledger.requests, spanned.window.days, spanned.window.span], [4, 3, { from: '2026-09-26', to: '2026-09-28' }])
    const ignored = await get<Overview>('/api/usage-overview?view=workspace&from=2026-09-26&days=30')
    assert.deepEqual([ignored.window.days, ignored.window.span], [30, null])
    const requests = await get<{ total: number }>('/api/analytics?view=workspace&from=2026-09-28&to=2026-09-28&keyId=key-b')
    assert.equal(requests.total, 1)
    const facets = await get<{ totals: { requests: number } }>('/api/usage-facets?from=2026-10-02&to=2026-10-02')
    assert.equal(facets.totals.requests, 2)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})
