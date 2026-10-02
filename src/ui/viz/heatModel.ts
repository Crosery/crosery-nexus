/**
 * Contribution-graph model (GitHub style) for the usage heatmap: weeks are columns (Monday first), seven rows,
 * one square per calendar day (Asia/Shanghai, as served). Pure functions only — no DOM — so the layout rules are
 * testable on their own.
 *
 * Levels follow the quartiles of the non-zero days in view (GitHub's rule), so one huge day does not wash every
 * other day out to the faintest step; with fewer than four active days they fall back to the share of the peak.
 */

export type HeatMetric = 'tokens' | 'requests' | 'cost'
export type HeatYear = 'recent' | number

/** One day as both `/api/usage-daily` and `/api/me/usage/daily` return it. */
export type HeatDayData = {
  day: string
  requests: number
  errors: number
  tokens: number
  costUsd: number | null
  freshInput: number
  output: number
  cacheRead: number
  cacheWrite: number
  topModels: Array<{ model: string; tokens: number }>
}

export type HeatSeries = {
  range: { year: HeatYear; from: string; to: string; timeZone: string; offsetMinutes: number }
  history: { retainedFrom: string; firstDay: string | null; retentionDays: number }
  years: number[]
  days: HeatDayData[]
  totals: { requests: number; errors: number; tokens: number; costUsd: number | null; costEstimated: boolean; unpricedRequests: number }
}

export type HeatLevel = 0 | 1 | 2 | 3 | 4

export type HeatCell = {
  date: string
  col: number
  /** 0 = Monday … 6 = Sunday */
  row: number
  /** `void` = before the retention window: no record kept, not "no calls" */
  kind: 'day' | 'void'
  level: HeatLevel
  value: number
  data: HeatDayData | null
  today: boolean
}

export type HeatGraph = {
  cols: number
  cells: HeatCell[]
  months: Array<{ col: number; label: string }>
  /** interactive dates, ascending */
  dates: string[]
  byDate: Map<string, HeatCell>
  peak: HeatCell | null
}

const DAY_MS = 86_400_000
const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日']

export const dayMs = (day: string) => Date.parse(`${day}T00:00:00.000Z`)
export const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10)
export const addDays = (day: string, count: number) => isoDay(dayMs(day) + count * DAY_MS)
/** Monday-first row of a calendar day. */
export const weekRow = (day: string) => (new Date(dayMs(day)).getUTCDay() + 6) % 7
export const spanDays = (from: string, to: string) => Math.round((dayMs(to) - dayMs(from)) / DAY_MS) + 1

export function heatValue(day: HeatDayData | null | undefined, metric: HeatMetric): number {
  if (!day) return 0
  const value = metric === 'requests' ? day.requests : metric === 'cost' ? day.costUsd : day.tokens
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/** Upper bounds of levels 1–3 (level 4 is everything above the last one). */
export function heatThresholds(values: number[]): number[] {
  const active = values.filter((value) => value > 0).sort((a, b) => a - b)
  if (!active.length) return []
  const max = active[active.length - 1]
  if (active.length < 4) return [max * 0.25, max * 0.5, max * 0.75]
  const at = (q: number) => active[Math.min(active.length - 1, Math.floor(q * (active.length - 1)))]
  return [at(0.25), at(0.5), at(0.75)]
}

export function heatLevelOf(value: number, thresholds: number[]): HeatLevel {
  if (!(value > 0) || !thresholds.length) return 0
  let level = 1
  for (const bound of thresholds) if (value > bound) level += 1
  return Math.min(4, level) as HeatLevel
}

export function buildHeatGraph(series: HeatSeries | null | undefined, metric: HeatMetric, today: string): HeatGraph {
  const empty: HeatGraph = { cols: 0, cells: [], months: [], dates: [], byDate: new Map(), peak: null }
  if (!series || !series.range.from || !series.range.to || series.range.from > series.range.to) return empty
  const { from, to } = series.range
  const start = addDays(from, -weekRow(from))
  const cols = Math.floor((dayMs(to) - dayMs(start)) / (7 * DAY_MS)) + 1
  const byDay = new Map(series.days.map((day) => [day.day, day]))
  const thresholds = heatThresholds(series.days.map((day) => heatValue(day, metric)))
  const cells: HeatCell[] = []
  const byDate = new Map<string, HeatCell>()
  const dates: string[] = []
  let peak: HeatCell | null = null
  for (let ms = dayMs(from), end = dayMs(to); ms <= end; ms += DAY_MS) {
    const date = isoDay(ms)
    const kind = date < series.history.retainedFrom ? 'void' : 'day'
    const data = kind === 'day' ? byDay.get(date) ?? null : null
    const value = heatValue(data, metric)
    const cell: HeatCell = {
      date,
      col: Math.floor((ms - dayMs(start)) / (7 * DAY_MS)),
      row: weekRow(date),
      kind,
      level: kind === 'day' ? heatLevelOf(value, thresholds) : 0,
      value,
      data,
      today: date === today,
    }
    cells.push(cell)
    if (kind === 'day') {
      byDate.set(date, cell)
      dates.push(date)
      if (value > 0 && (!peak || value > peak.value)) peak = cell
    }
  }
  // a month is labelled over the first column whose Monday falls in it; a label needs 3 columns of room
  const months: Array<{ col: number; label: string }> = []
  for (let col = 0; col < cols; col += 1) {
    const monday = addDays(start, col * 7)
    const month = Number(monday.slice(5, 7))
    const prev = col === 0 ? null : Number(addDays(start, (col - 1) * 7).slice(5, 7))
    if (col === 0 || month !== prev) months.push({ col, label: `${month}月` })
  }
  const spaced = months.filter((m, i) => i === months.length - 1 || months[i + 1].col - m.col >= 3)
  return { cols, cells, months: spaced, dates, byDate, peak }
}

/* ── words ──────────────────────────────────────────────────────────────────────────────────────── */

/** 9月28日 周日 */
export function dayTitle(day: string): string {
  return `${Number(day.slice(5, 7))}月${Number(day.slice(8, 10))}日 周${WEEKDAYS[weekRow(day)]}`
}

/** 9/01 → 9/28 (adds the year when the span crosses one) */
export function spanTitle(from: string, to: string): string {
  const short = (day: string) => `${Number(day.slice(5, 7))}/${day.slice(8, 10)}`
  return from.slice(0, 4) === to.slice(0, 4) ? `${short(from)} → ${short(to)}` : `${from.slice(0, 4)}/${short(from)} → ${to.slice(0, 4)}/${short(to)}`
}

export type HeatAggregate = {
  days: number
  requests: number
  errors: number
  tokens: number
  costUsd: number | null
  freshInput: number
  output: number
  cacheRead: number
  cacheWrite: number
}

/** Sum of the recorded days in [from, to] (inclusive, either order). Cost stays null when nothing in it is priced. */
export function aggregateSpan(series: HeatSeries | null | undefined, a: string, b: string): HeatAggregate {
  const [from, to] = a <= b ? [a, b] : [b, a]
  const out: HeatAggregate = { days: spanDays(from, to), requests: 0, errors: 0, tokens: 0, costUsd: null, freshInput: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  for (const day of series?.days ?? []) {
    if (day.day < from || day.day > to) continue
    out.requests += day.requests
    out.errors += day.errors
    out.tokens += day.tokens
    out.freshInput += day.freshInput
    out.output += day.output
    out.cacheRead += day.cacheRead
    out.cacheWrite += day.cacheWrite
    if (day.costUsd !== null) out.costUsd = (out.costUsd ?? 0) + day.costUsd
  }
  return out
}

/** [start, end) of a calendar day as epoch ms, from the series' fixed zone offset. */
export function dayBounds(day: string, offsetMinutes: number): { start: number; end: number } {
  const start = dayMs(day) - offsetMinutes * 60_000
  return { start, end: start + DAY_MS }
}

/** The value as one short phrase: `2.38B token` · `1,234 次请求` · `$12.30`; nothing recorded → `无调用`. */
export function heatValueText(value: number, metric: HeatMetric, fmt: { compact: (v: number) => string; int: (v: number) => string; usd: (v: number) => string }): string {
  if (!(value > 0)) return '无调用'
  if (metric === 'requests') return `${fmt.int(value)} 次请求`
  if (metric === 'cost') return fmt.usd(value)
  return `${fmt.compact(value)} token`
}

/** The plate title, GitHub style: `过去一年 5.08B token` · `2026 年 1,234 次请求` · `过去一年 ≈ $1,284.30`. */
export function heatSummary(series: HeatSeries | null | undefined, metric: HeatMetric, year: HeatYear, fmt: { compact: (v: number) => string; int: (v: number) => string; usd: (v: number) => string }): string {
  const lead = year === 'recent' ? '过去一年' : `${year} 年`
  if (!series) return lead
  const t = series.totals
  const value = metric === 'requests' ? t.requests : metric === 'cost' ? t.costUsd ?? 0 : t.tokens
  if (!(value > 0)) return `${lead} 无调用`
  return `${lead} ${heatValueText(value, metric, fmt)}`
}
