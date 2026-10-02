import assert from 'node:assert/strict'
import test from 'node:test'
import {
  axisMs, bandX, bucketLabel, bucketRange, bucketTick, hasNarrowing, hitBasisWords, logPos, logTicks, mergeLive,
  savingsWords, scopeFromQuery, scopeQuery, spreadText, windowLabel, type LiveEvent,
} from '../src/features/usage/tabs/insight/model.js'

/* 用量 · 缓存 / 性能 tabs: the pure helpers behind the plates (src/features/usage/tabs/insight/model.ts). */

const HOUR = 3_600_000
// 2026-10-02 12:00 Asia/Shanghai
const NOON = Date.UTC(2026, 9, 2, 4, 0, 0)

test('scope: the shared filter bar rule — 24h/7d/30d/90d, anything else 7 d; empty filters stay out of the query', () => {
  assert.deepEqual(scopeFromQuery({}), { days: 7, keyId: '', model: '', client: '', provider: '', currentOnly: false })
  assert.equal(scopeFromQuery({ days: '30' }).days, 30)
  assert.equal(scopeFromQuery({ days: '14' }).days, 7)
  assert.equal(scopeFromQuery({ days: ['1', '90'] }).days, 1)
  assert.equal(scopeFromQuery({ hours: '24' }).days, 7)
  const s = scopeFromQuery({ days: '1', model: ' gpt-5 ', keyId: 'k1', client: null, provider: 'mox' })
  assert.deepEqual(s, { days: 1, keyId: 'k1', model: 'gpt-5', client: '', provider: 'mox', currentOnly: false })
  assert.equal(scopeQuery(s), 'days=1&keyId=k1&model=gpt-5&provider=mox')
  assert.equal(scopeQuery(scopeFromQuery({}), { limit: 50 }), 'days=7&limit=50')
  assert.equal(hasNarrowing(s), true)
  assert.equal(hasNarrowing(scopeFromQuery({ days: '30' })), false)
  // 渠道口径：缺省全部渠道（不进查询）；只认 currentOnly=1 / true 为「只看当前渠道」，且算一种收窄
  const current = scopeFromQuery({ days: '7', currentOnly: '1' })
  assert.equal(current.currentOnly, true)
  assert.equal(scopeQuery(current), 'days=7&currentOnly=1')
  assert.equal(hasNarrowing(current), true)
  assert.equal(scopeFromQuery({ currentOnly: 'yes' }).currentOnly, false)
  assert.equal(windowLabel(1), '近 24 小时')
  assert.equal(windowLabel(7), '近 7 天')
})

test('time words: bucket size, axis ticks on the console wall clock, readout ranges end at now for the open bucket', () => {
  assert.equal(bucketLabel(HOUR), '每小时')
  assert.equal(bucketLabel(6 * HOUR), '每 6 小时')
  assert.equal(bucketLabel(24 * HOUR), '每天')
  const midnight = Date.UTC(2026, 9, 1, 16, 0, 0) // 10/02 00:00 Shanghai
  assert.equal(bucketTick(midnight, 6 * HOUR), '10/02')
  assert.equal(bucketTick(NOON, 6 * HOUR), '12:00')
  assert.equal(bucketTick(NOON, HOUR), '12:00')
  assert.equal(bucketTick(NOON, 24 * HOUR), '10/02')
  assert.equal(bucketRange(NOON - 6 * HOUR, 6 * HOUR, NOON + 30 * 60_000), '10/02 06:00–12:00')
  assert.equal(bucketRange(NOON, 6 * HOUR, NOON + 30 * 60_000), '10/02 12:00–12:30 截至现在')
  assert.equal(bucketRange(NOON + 6 * HOUR, 6 * HOUR, NOON + 24 * HOUR), '10/02 18:00–24:00')
  assert.equal(bucketRange(midnight, 24 * HOUR, NOON), '10/02 截至现在')
  assert.equal(bucketRange(midnight - 24 * HOUR, 24 * HOUR, NOON), '10/01 全天')
  assert.equal(bucketTick(Number.NaN, HOUR), '—')
})

test('chart geometry: band centres, 1-2-5 log ticks covering the data, positions clamp, axis labels stay short', () => {
  assert.equal(bandX(0, 4, 400), 50)
  assert.equal(bandX(3, 4, 400), 350)
  assert.equal(bandX(0, 0, 400), 0)
  const t = logTicks(1_610, 88_000)
  assert.equal(t.lo, 1_000)
  assert.equal(t.hi, 100_000)
  assert.ok(t.ticks.length <= 6 && t.ticks.includes(1_000) && t.ticks.includes(100_000))
  assert.deepEqual(logTicks(1_000, 10_000).ticks, [1_000, 2_000, 5_000, 10_000])
  assert.equal(logPos(1_000, 1_000, 100_000), 0)
  assert.equal(logPos(10_000, 1_000, 100_000), 0.5)
  assert.equal(logPos(1e9, 1_000, 100_000), 1)
  assert.equal(logPos(0, 1_000, 100_000), null)
  assert.equal(logPos(null, 1_000, 100_000), null)
  assert.equal(axisMs(500), '500ms')
  assert.equal(axisMs(1_000), '1s')
  assert.equal(axisMs(200_000), '200s')
  assert.equal(axisMs(2_000_000), '33.3m')
  assert.equal(spreadText({ p50: 1_610, p95: 13_300 }), '1.61s / 13.3s')
  assert.equal(spreadText(null), '—')
})

const ev = (id: string, at: string): LiveEvent => ({
  requestId: id, timestamp: at, model: 'm', keyName: null, clientType: 'omp', latencyMs: 1, freshInputTokens: 1, cacheReadTokens: 0,
  cacheWriteTokens: 0, outputTokens: 1, promptTokens: 1, hitRate: 0, costUsd: null, overCeiling: false,
})

test('live stream: newest first, a replayed history never duplicates rows, capped', () => {
  const history = [ev('a', '1'), ev('b', '2'), ev('c', '3')] // the server replays oldest first
  const first = mergeLive([], history)
  assert.deepEqual(first.map((e) => e.requestId), ['c', 'b', 'a'])
  const again = mergeLive(first, [ev('b', '2'), ev('d', '4')])
  assert.deepEqual(again.map((e) => e.requestId), ['d', 'b', 'c', 'a'])
  assert.equal(mergeLive(again, [ev('e', '5')], 3).length, 3)
})

const savings = (patch: Partial<Parameters<typeof savingsWords>[0]> = {}) => ({
  netUsd: 12.5, readUsd: 14, writeUsd: 1.5, pricedRequests: 10, unpricedRequests: 0, unpricedModels: 0, free: false, approx: true, ...patch,
})
const usd = (v: number) => `$${v.toFixed(2)}`

test('money words: never a $0.00 headline — unpriced is —, free is 免费, partial pricing says what is left out', () => {
  assert.deepEqual(savingsWords(savings(), usd), { value: '$12.50', sub: '已扣写入成本', approx: true })
  assert.deepEqual(savingsWords(savings({ unpricedRequests: 40, unpricedModels: 2 }), usd), { value: '$12.50', sub: '未定价 2 个模型 · 40 次不计', approx: true })
  assert.deepEqual(savingsWords(savings({ pricedRequests: 0, netUsd: null, unpricedRequests: 7, unpricedModels: 1 }), usd), { value: '—', sub: '未定价 1 个模型 · 7 次不计', approx: false })
  assert.deepEqual(savingsWords(savings({ pricedRequests: 0, netUsd: null }), usd), { value: '—', sub: '没有缓存请求', approx: false })
  assert.equal(savingsWords(savings({ free: true, netUsd: 0 }), usd).value, '免费')
  assert.equal(hitBasisWords({ byModel: [{}, {}] as never, excluded: { models: 3, requests: 9, items: [] } }), '计 2 个模型 · 不支持缓存 3 个不计')
  assert.equal(hitBasisWords({ byModel: [{}] as never, excluded: { models: 0, requests: 0, items: [] } }), '计 1 个模型')
})
