import assert from 'node:assert/strict'
import test from 'node:test'

import { aggregateSpan, buildHeatGraph, dayBounds, dayTitle, heatLevelOf, heatSummary, heatThresholds, spanTitle, type HeatDayData, type HeatSeries } from '../src/ui/viz/heatModel.js'
import { refusedWindow, sharedUsageQuery, spanLabel, usageFilterFrom, usageSpan, windowText } from '../src/features/usage/filters.js'
import { scopeFromQuery, scopeQuery } from '../src/features/usage/tabs/insight/model.js'

/**
 * Front-end rules of the usage contribution graph (src/ui/viz/heatModel.ts) and of the shared custom window
 * (src/features/usage/filters.ts, insight/model.ts): grid geometry, levels, words, span sums, URL keys.
 */

const day = (date: string, tokens: number, extra: Partial<HeatDayData> = {}): HeatDayData => ({
  day: date, requests: tokens > 0 ? 1 : 0, errors: 0, tokens, costUsd: tokens > 0 ? tokens / 1e6 : null,
  freshInput: tokens / 2, output: tokens / 4, cacheRead: tokens / 4, cacheWrite: 0, topModels: [], ...extra,
})
const series = (days: HeatDayData[], range = { from: '2025-09-29', to: '2026-10-02' }, retainedFrom = '2026-07-05'): HeatSeries => ({
  range: { year: 'recent', ...range, timeZone: 'Asia/Shanghai', offsetMinutes: 480 },
  history: { retainedFrom, firstDay: days.find((d) => d.requests > 0)?.day ?? null, retentionDays: 90 },
  years: [2026],
  days,
  totals: { requests: days.reduce((s, d) => s + d.requests, 0), errors: 0, tokens: days.reduce((s, d) => s + d.tokens, 0), costUsd: null, costEstimated: false, unpricedRequests: 0 },
})

test('图：最近一年 53 列（周一起），保留期之前是无记录的空格，只有记录内的日子可交互；今天与峰值', () => {
  const days = [day('2026-09-28', 2_380_000_000), day('2026-09-29', 1_460_000_000), day('2026-10-01', 10)]
  const graph = buildHeatGraph(series(days), 'tokens', '2026-10-02')
  assert.equal(graph.cols, 53)
  assert.equal(graph.cells[0].date, '2025-09-29')
  assert.deepEqual([graph.cells[0].col, graph.cells[0].row], [0, 0])
  const today = graph.byDate.get('2026-10-02')!
  assert.deepEqual([today.col, today.row, today.today], [52, 4, true], '10/02 是周五，最后一列')
  assert.equal(graph.cells.filter((c) => c.kind === 'void').length, graph.cells.findIndex((c) => c.date === '2026-07-05'))
  assert.equal(graph.dates[0], '2026-07-05')
  assert.equal(graph.dates.length, 90)
  assert.equal(graph.peak?.date, '2026-09-28')
  assert.equal(graph.byDate.get('2026-09-28')!.level, 4)
  assert.equal(graph.byDate.get('2026-09-30')!.level, 0, '没有调用的日子是 0 级')
  assert.equal(graph.months[0].label, '10月', '9月只占第一列（放不下标签），从 10 月标起')
  assert.ok(graph.months.every((m, i) => i === 0 || m.col - graph.months[i - 1].col >= 3), '月份标签至少隔 3 列')
  // 年视图：1/1 前面那几格不画（不是空格），列从 1/1 所在那周的周一起
  const year = buildHeatGraph(series(days, { from: '2026-01-01', to: '2026-10-02' }), 'tokens', '2026-10-02')
  assert.equal(year.cells[0].date, '2026-01-01')
  assert.equal(year.cells[0].row, 3, '2026-01-01 是周四')
  assert.equal(buildHeatGraph(null, 'tokens', '2026-10-02').cols, 0)
})

test('色阶：非零日的四分位（GitHub 规则），不足 4 个活跃日时按峰值占比', () => {
  const t = heatThresholds([0, 1, 2, 3, 4, 5, 6, 7, 8, 100])
  assert.deepEqual(t, [3, 5, 7], '9 个活跃日：第 2 / 4 / 6 个')
  assert.deepEqual([1, 3, 4, 6, 8, 100].map((v) => heatLevelOf(v, t)), [1, 1, 2, 3, 4, 4])
  assert.equal(heatLevelOf(0, t), 0)
  assert.deepEqual(heatThresholds([100, 0]), [25, 50, 75])
  assert.equal(heatLevelOf(100, heatThresholds([100])), 4, '只有一个活跃日：最深')
  assert.deepEqual(heatThresholds([]), [])
})

test('文字与跨度：日标题、跨度标题、跨度合计、某天的 [起, 止)', () => {
  assert.equal(dayTitle('2026-09-28'), '9月28日 周一')
  assert.equal(spanTitle('2026-09-01', '2026-09-28'), '9/01 → 9/28')
  assert.equal(spanTitle('2025-12-30', '2026-01-02'), '2025/12/30 → 2026/1/02')
  const s = series([day('2026-09-28', 100), day('2026-09-29', 50), day('2026-09-30', 0)])
  const sum = aggregateSpan(s, '2026-09-30', '2026-09-28')
  assert.deepEqual([sum.days, sum.requests, sum.tokens], [3, 2, 150])
  assert.ok(Math.abs((sum.costUsd ?? NaN) - 150 / 1e6) < 1e-15)
  assert.equal(aggregateSpan(s, '2026-09-30', '2026-09-30').costUsd, null, '没有定价的跨度花费是 null')
  assert.deepEqual(dayBounds('2026-10-01', 480), { start: Date.parse('2026-09-30T16:00:00.000Z'), end: Date.parse('2026-10-01T16:00:00.000Z') })
  const fmt = { compact: (v: number) => `${v}c`, int: (v: number) => `${v}i`, usd: (v: number) => `$${v}` }
  assert.equal(heatSummary(s, 'tokens', 'recent', fmt), '过去一年 150c token')
  assert.equal(heatSummary(s, 'requests', 2026, fmt), '2026 年 2i 次请求')
  assert.equal(heatSummary(series([]), 'tokens', 'recent', fmt), '过去一年 无调用')
})

test('共享窗口：from/to 是共享键；两端都是日期才生效（反了对调）；标签与旧 days 并存', () => {
  assert.deepEqual(sharedUsageQuery({ from: '2026-09-01', to: '2026-09-28', page: '3', days: '30' }), { days: '30', from: '2026-09-01', to: '2026-09-28' })
  assert.deepEqual(usageSpan('2026-09-28', '2026-09-01'), { from: '2026-09-01', to: '2026-09-28' })
  assert.equal(usageSpan('2026-09-01', ''), null)
  assert.equal(usageSpan('2026-9-1', '2026-09-28'), null)
  const f = usageFilterFrom({ days: '30', from: '2026-09-01', to: '2026-09-28' })
  assert.deepEqual([f.days, f.from, f.to], [30, '2026-09-01', '2026-09-28'])
  assert.deepEqual([usageFilterFrom({ days: '7', from: 'x', to: '' }).from, usageFilterFrom({}).to], ['', ''])
  assert.equal(spanLabel({ from: '2026-09-01', to: '2026-09-28' }, 2026), '9/01 → 9/28')
  assert.equal(spanLabel({ from: '2026-09-28', to: '2026-09-28' }, 2026), '9/28')
  assert.equal(spanLabel({ from: '2025-12-30', to: '2026-01-02' }, 2026), '2025/12/30 → 1/02')
  assert.equal(windowText({ days: 28, span: { from: '2026-09-01', to: '2026-09-28' } }, 7).includes('→'), true)
  assert.equal(windowText({ days: 30, span: null }, 7), '近 30 天')
  assert.equal(windowText(null, 1), '近 24 小时')
  // 缓存 / 性能页签：跨度换掉 days 参数，没有跨度时与旧链接逐字相同
  const scope = scopeFromQuery({ days: '30', from: '2026-09-01', to: '2026-09-28', model: 'm' })
  assert.equal(scopeQuery(scope), 'from=2026-09-01&to=2026-09-28&model=m')
  assert.equal(scopeQuery(scopeFromQuery({ days: '30', from: '2026-09-01' })), 'days=30')
})

test('超出保留期的窗口：服务端回 7d 时认出来，自定义时间段与相同窗口不算', () => {
  const asked = usageFilterFrom({ days: '90' })
  assert.equal(refusedWindow(asked, { days: 7, span: null }), 7)
  assert.equal(refusedWindow(asked, { days: 90, span: null }), null)
  assert.equal(refusedWindow(usageFilterFrom({ days: '7' }), { days: 7, span: null }), null)
  assert.equal(refusedWindow(usageFilterFrom({ from: '2026-09-01', to: '2026-09-03' }), { days: 3, span: { from: '2026-09-01', to: '2026-09-03' } }), null)
  assert.equal(refusedWindow(asked, null), null)
})
