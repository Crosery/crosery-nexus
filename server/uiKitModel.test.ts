import assert from 'node:assert/strict'
import test from 'node:test'
import { fmtAgo, fmtClock, fmtCompact, fmtDate, fmtDelta, fmtDuration, fmtInt, fmtPct, fmtTime, fmtUsd, splitUnit } from '../src/ui/fmt.js'
import { areaPath, buildHeatGrid, heatLevel, linePath, meterModel, niceAxis, snapMeterWidth, timeX } from '../src/ui/viz/model.js'
import { isCharacterSpec, matchShortcut } from '../src/ui/composables/useShortcuts.js'
import { resolveDataState } from '../src/ui/composables/useLive.js'
import { printDelay } from '../src/ui/composables/usePrintIn.js'
import { fmtCountdownClock } from '../src/ui/composables/useNow.js'
import { buildResetConfirm, describeResetOutcome, type ResetOutcome } from '../src/ui/feedback/resetOutcome.js'

/*
 * Console v3 UI kit — the pure parts (formatting, chart geometry, shortcut matching, data-state rules,
 * print-in timing, reset copy). SFC rendering is covered by the build + visual QA, not here.
 */

const at = (iso: string) => new Date(iso).getTime()

test('fmt: unknown is never a fake zero', () => {
  for (const fn of [fmtInt, fmtCompact, fmtPct, fmtDuration]) assert.equal(fn(null), '—')
  assert.equal(fmtUsd(undefined), '—')
  assert.equal(fmtDelta(Number.NaN), '—')
})

test('fmt: compact units from 10,000 up, thousands separators below', () => {
  assert.equal(fmtCompact(9412), '9,412')
  assert.equal(fmtCompact(35_400), '35.4k')
  assert.equal(fmtCompact(248_600_000), '248.6M')
  assert.equal(fmtCompact(10_950_000_000), '10.95B')
  assert.equal(fmtCompact(-12_000), '-12k')
})

test('fmt: money, percent, durations, deltas', () => {
  assert.equal(fmtUsd(1284.3), '$1,284.30')
  assert.equal(fmtUsd(0.004), '<$0.01')
  assert.equal(fmtUsd(5, { approx: true }), '≈ $5.00')
  assert.equal(fmtPct(0.714), '71.4%')
  assert.equal(fmtDuration(849), '849ms')
  assert.equal(fmtDuration(1820), '1.82s')
  assert.equal(fmtDuration(83_700), '83.7s')
  assert.equal(fmtDuration(412_000), '412s')
  assert.equal(fmtDelta(0.062), '▲ 6.2%')
  assert.equal(fmtDelta(-0.003, 'pp'), '▼ 0.3pp')
  assert.equal(fmtDelta(0, 'abs'), '· 0')
  assert.deepEqual(splitUnit('34.2%'), { value: '34.2', unit: '%' })
})

test('fmt: times are Asia/Shanghai, today without the date', () => {
  const t = at('2026-10-02T06:32:08Z') // 14:32:08 CST, a Friday
  assert.equal(fmtClock(t, at('2026-10-02T10:00:00Z')), '14:32:08')
  assert.equal(fmtClock(t, at('2026-10-03T10:00:00Z')), '10/02 14:32:08')
  assert.equal(fmtTime(t, at('2026-10-02T10:00:00Z')), '14:32')
  assert.equal(fmtDate(t), '2026-10-02 周五')
  assert.equal(fmtAgo(t - 180_000, t), '3m 前')
  assert.equal(fmtAgo(t + 7_200_000, t), '2h 后')
})

test('countdown clock: mm:ss under an hour, h:mm:ss above, never negative', () => {
  assert.equal(fmtCountdownClock(252_000), '04:12')
  assert.equal(fmtCountdownClock(5_272_000), '1:27:52')
  assert.equal(fmtCountdownClock(-5), '00:00')
})

test('tick meter: widths snap to 4px, ratio may exceed 1, redline at 90%', () => {
  assert.equal(snapMeterWidth(85), 84)
  assert.equal(snapMeterWidth(3), 8)
  const half = meterModel(0.5, 84)
  assert.equal(half.ticks, 21)
  assert.equal(half.lit, 11)
  assert.equal(half.over, false)
  assert.equal(meterModel(0.9, 84).over, true)
  const over = meterModel(1.4, 84)
  assert.equal(over.lit, 21)
  assert.equal(over.full, true)
  assert.equal(Math.round(over.pct ?? 0), 140)
  assert.equal(meterModel(null, 84).pct, null)
})

test('paths: null samples break the line instead of dropping to zero', () => {
  const box = { w: 30, h: 10, pad: 0, extent: { min: 0, max: 3 } }
  assert.equal(linePath([1, null, 2, 3], box), 'M0.0 6.7M20.0 3.3L30.0 0.0')
  assert.equal(areaPath([1, null, 2, 3], box), 'M20.0 10L20.0 3.3L30.0 0.0L30.0 10Z')
  const axis = niceAxis(0, 87, 4)
  assert.equal(axis.ticks[0], 0)
  assert.ok(axis.max >= 87)
  assert.equal(timeX(50, 0, 100, 200), 100)
  assert.equal(timeX(150, 0, 100, 200), null)
})

test('heatmap: levels by share of the busiest day; Monday-first weeks; peak and range bracket', () => {
  assert.equal(heatLevel(0, 100), 0)
  assert.equal(heatLevel(25, 100), 1)
  assert.equal(heatLevel(26, 100), 2)
  assert.equal(heatLevel(75, 100), 3)
  assert.equal(heatLevel(100, 100), 4)
  // 2026-09-28 is a Monday; 14 days = exactly two week columns
  const days = Array.from({ length: 14 }, (_, i) => ({
    date: new Date(Date.UTC(2026, 8, 28 + i)).toISOString().slice(0, 10),
    value: i === 9 ? 1000 : 100,
    requests: 100,
    errors: i === 3 ? 5 : 0,
  }))
  const grid = buildHeatGrid(days, { rangeDays: 7 })
  assert.equal(grid.weeks.length, 2)
  assert.equal(grid.weeks[0][0].date, '2026-09-28')
  assert.equal(grid.peakIndex, 9)
  assert.equal(grid.weeks[1][2].peak, true)
  assert.equal(grid.weeks[1][2].level, 4)
  assert.equal(grid.weeks[0][3].failRate, 0.05)
  assert.equal(grid.rangeStartCol, 1)
  assert.deepEqual(grid.weekTotals, [700, 1600])
  assert.ok(grid.months.some((m) => m.label === '10月'))
})

test('shortcuts: mod+k per platform, character keys reject modifiers, ? ignores Shift', () => {
  const key = (k: string, mods: Partial<Record<'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey', boolean>> = {}) => ({
    key: k, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods,
  })
  assert.equal(matchShortcut(key('k', { metaKey: true }), 'mod+k', true), true)
  assert.equal(matchShortcut(key('k', { ctrlKey: true }), 'mod+k', true), false)
  assert.equal(matchShortcut(key('k', { ctrlKey: true }), 'mod+k', false), true)
  assert.equal(matchShortcut(key('t'), 't'), true)
  assert.equal(matchShortcut(key('T', { shiftKey: true }), 't'), false)
  assert.equal(matchShortcut(key('t', { ctrlKey: true }), 't'), false)
  assert.equal(matchShortcut(key('?', { shiftKey: true }), '?'), true)
  assert.equal(isCharacterSpec('1'), true)
  assert.equal(isCharacterSpec('mod+k'), false)
})

test('data state: loading / error / forbidden / stale / empty per DESIGN §5.1', () => {
  const base = { hasData: false, loading: true, error: null, empty: false, ageMs: null, intervalMs: 15_000 }
  assert.equal(resolveDataState(base), 'loading')
  assert.equal(resolveDataState({ ...base, loading: false, error: new Error('请求失败 502') }), 'error')
  assert.equal(resolveDataState({ ...base, error: new Error('请求失败 403') }), 'forbidden')
  assert.equal(resolveDataState({ ...base, hasData: true, loading: false, error: new Error('timeout') }), 'stale')
  assert.equal(resolveDataState({ ...base, hasData: true, loading: false, ageMs: 31_000 }), 'stale')
  assert.equal(resolveDataState({ ...base, hasData: true, loading: false, ageMs: 1_000, empty: true }), 'empty')
  assert.equal(resolveDataState({ ...base, hasData: true, loading: false, ageMs: 1_000 }), 'ready')
})

test('print-in: blocks print as the scanline passes them (40ms at the header → 420ms at the fold)', () => {
  assert.equal(printDelay(52, 900), 40)
  assert.equal(printDelay(0, 900), 40)
  assert.equal(printDelay(900, 900), 420)
  assert.equal(printDelay(476, 900), 230)
})

test('reset outcomes: nine distinct toasts with the right tone', () => {
  const outcomes: ResetOutcome[] = ['ok', 'partial', 'no_window', 'no_credit', 'redeemed', 'cooldown', 'unsupported', 'unavailable', 'unknown']
  const titles = outcomes.map((o) => describeResetOutcome(o, { remaining: 1, retryInMs: 252_000, recoverAt: at('2026-10-02T04:37:00Z') }).title)
  assert.equal(new Set(titles).size, outcomes.length)
  assert.equal(titles[0], '✓ 已重置 · 剩 1 次')
  assert.equal(titles[5], '◇ 重置冷却中 · 04:12 后可再试')
  // fmtTime adds MM/DD when recoverAt is not today (the fixture date is fixed, the clock is not)
  assert.match(titles[1], /^◇ 额度已重置，但网关冷却未清除 · 约 (?:\d{2}\/\d{2} )?\d{2}:\d{2}/)
  assert.equal(describeResetOutcome('unavailable').tone, 'bad')
  assert.equal(describeResetOutcome('partial').tone, 'warn')
  assert.equal(describeResetOutcome('no_credit').tone, 'note')
})

test('reset confirm: title, facts with the earliest credit, irreversible consequence', () => {
  const c = buildResetConfirm({
    account: 'zhang.wei.ops+codex-team@example.com',
    service: 'Codex · Pro',
    creditIndex: 1,
    creditExpiresAt: at('2026-10-04T14:30:00Z'),
    creditsBefore: 2,
    windows: ['5h'],
  })
  assert.equal(c.title, '用 1 次重置？')
  assert.deepEqual(c.facts.map((f) => f.k), ['账号', '服务', '将使用', '剩余', '影响'])
  assert.equal(c.facts[0].v, 'zhang.wei.ops+codex-team@…')
  assert.equal(c.facts[2].v, '第 1 次 · 10/04 22:30 过期')
  assert.equal(c.facts[3].v, '2 → 1 次')
  assert.equal(c.facts[4].v, '5h 窗口归零 · 会尝试清除网关冷却')
  assert.equal(c.consequence, '不可撤销')
  assert.equal(c.confirmText, '使用 1 次重置')
})
