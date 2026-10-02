/**
 * Pure geometry/model helpers for the viz kit (no DOM, unit-tested in server/uiKitModel.test.ts).
 */

/* ── tick meter ─────────────────────────────────────────────────────────────────────────────── */

/** Meters tick 2px on / 2px off, so widths snap to a multiple of 4 (no moiré at DPR 1). */
export function snapMeterWidth(width: number): number {
  return Math.max(8, Math.round((Number.isFinite(width) ? width : 84) / 4) * 4)
}

export type MeterModel = { ticks: number; lit: number; ratio: number; pct: number | null; over: boolean; full: boolean }

/** ratio may exceed 1 (over quota): the bar stays full, the label shows the real percentage. */
export function meterModel(ratio: number | null | undefined, width: number, redline = 0.9): MeterModel {
  const ticks = snapMeterWidth(width) / 4
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) {
    return { ticks, lit: 0, ratio: 0, pct: null, over: false, full: false }
  }
  const clamped = Math.max(0, Math.min(1, ratio))
  return {
    ticks,
    lit: Math.round(clamped * ticks),
    ratio: clamped,
    pct: ratio * 100,
    over: ratio >= redline,
    full: ratio >= 1,
  }
}

/* ── lines ──────────────────────────────────────────────────────────────────────────────────── */

export type Extent = { min: number; max: number }

export function extentOf(values: Array<number | null | undefined>, zero = true): Extent {
  let min = zero ? 0 : Infinity
  let max = zero ? 0 : -Infinity
  for (const v of values) {
    if (v === null || v === undefined || !Number.isFinite(v)) continue
    if (v < min) min = v
    if (v > max) max = v
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 1 }
  if (max === min) return { min, max: min + 1 }
  return { min, max }
}

export type PathBox = { w: number; h: number; pad?: number; extent?: Extent }

/** Polyline through the samples; null samples break the line (a gap, never a fake 0). */
export function linePath(values: Array<number | null | undefined>, box: PathBox): string {
  const pts = points(values, box)
  let d = ''
  let pen = false
  for (const p of pts) {
    if (!p) {
      pen = false
      continue
    }
    d += `${pen ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`
    pen = true
  }
  return d
}

/** Closed area under the line down to the baseline (only for contiguous runs). */
export function areaPath(values: Array<number | null | undefined>, box: PathBox): string {
  const pts = points(values, box)
  const base = box.h
  let d = ''
  let run: Array<[number, number]> = []
  const flush = () => {
    if (run.length > 1) {
      d += `M${run[0][0].toFixed(1)} ${base}` + run.map((p) => `L${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join('') + `L${run[run.length - 1][0].toFixed(1)} ${base}Z`
    }
    run = []
  }
  for (const p of pts) {
    if (p) run.push(p)
    else flush()
  }
  flush()
  return d
}

export function points(values: Array<number | null | undefined>, box: PathBox): Array<[number, number] | null> {
  const pad = box.pad ?? 1
  const ext = box.extent ?? extentOf(values)
  const n = values.length
  const span = ext.max - ext.min || 1
  return values.map((v, i) => {
    if (v === null || v === undefined || !Number.isFinite(v)) return null
    const x = n <= 1 ? box.w : (i / (n - 1)) * box.w
    const y = box.h - pad - ((v - ext.min) / span) * (box.h - pad * 2)
    return [x, y]
  })
}

/** "Nice" axis ticks (1/2/5 × 10^k) covering [min, max]. */
export function niceTicks(min: number, max: number, count = 4): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return [min]
  const raw = (max - min) / Math.max(1, count)
  const mag = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag
  const out: number[] = []
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) out.push(Number(v.toPrecision(12)))
  return out
}

/** Axis covering [min, max] with nice ticks; the top tick is ≥ max so the line never leaves the plot. */
export function niceAxis(min: number, max: number, count = 4): { ticks: number[]; min: number; max: number } {
  const lo = Number.isFinite(min) ? min : 0
  const hi = Number.isFinite(max) && max > lo ? max : lo + 1
  const ticks = niceTicks(lo, hi, count)
  const step = ticks.length > 1 ? ticks[1] - ticks[0] : hi - lo
  let top = ticks[ticks.length - 1]
  if (top < hi) {
    top = Number((top + step).toPrecision(12))
    ticks.push(top)
  }
  if (ticks[0] > lo) ticks.unshift(Number((ticks[0] - step).toPrecision(12)))
  return { ticks, min: ticks[0], max: top }
}

/* ── heatmap ────────────────────────────────────────────────────────────────────────────────── */

export type HeatDay = { date: string; value: number | null; errors?: number | null; requests?: number | null }
export type HeatLevel = 0 | 1 | 2 | 3 | 4
export type HeatCell = {
  date: string
  /** index into the input array, -1 for padding cells outside the data */
  i: number
  level: HeatLevel
  value: number | null
  failRate: number | null
  peak: boolean
  inRange: boolean
}

export type HeatGrid = {
  /** columns (weeks), each Monday → Sunday */
  weeks: HeatCell[][]
  months: Array<{ col: number; label: string }>
  weekTotals: number[]
  /** mean value per weekday row (Mon … Sun) over cells with data */
  weekdayMeans: number[]
  peakIndex: number
  max: number
  /** first column of the selected range bracket, -1 when no range */
  rangeStartCol: number
}

/** Same thresholds as the server (usageOverview getIntensity): share of the busiest day. */
export function heatLevel(value: number | null | undefined, max: number): HeatLevel {
  if (!value || value <= 0 || !Number.isFinite(value) || max <= 0) return 0
  const r = value / max
  if (r <= 0.25) return 1
  if (r <= 0.5) return 2
  if (r <= 0.75) return 3
  return 4
}

const DAY_MS = 86_400_000

function parseDay(date: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(date)
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null
}

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

/** Monday-first row index for a UTC midnight timestamp. */
function rowOf(ms: number): number {
  return (new Date(ms).getUTCDay() + 6) % 7
}

export function buildHeatGrid(days: HeatDay[], options: { rangeDays?: number } = {}): HeatGrid {
  const parsed = days
    .map((d, i) => ({ d, i, ms: parseDay(d.date) }))
    .filter((x): x is { d: HeatDay; i: number; ms: number } => x.ms !== null)
    .sort((a, b) => a.ms - b.ms)
  const empty: HeatGrid = { weeks: [], months: [], weekTotals: [], weekdayMeans: [0, 0, 0, 0, 0, 0, 0], peakIndex: -1, max: 0, rangeStartCol: -1 }
  if (!parsed.length) return empty

  const byMs = new Map(parsed.map((x) => [x.ms, x]))
  let max = 0
  let peakIndex = -1
  for (const x of parsed) {
    const v = x.d.value ?? 0
    if (v > max) {
      max = v
      peakIndex = x.i
    }
  }
  const first = parsed[0].ms
  const last = parsed[parsed.length - 1].ms
  const start = first - rowOf(first) * DAY_MS
  const end = last + (6 - rowOf(last)) * DAY_MS
  const rangeStart = options.rangeDays && options.rangeDays > 0 ? last - (options.rangeDays - 1) * DAY_MS : null

  const weeks: HeatCell[][] = []
  const weekTotals: number[] = []
  const rowSums = [0, 0, 0, 0, 0, 0, 0]
  const rowCounts = [0, 0, 0, 0, 0, 0, 0]
  const months: Array<{ col: number; label: string }> = []
  let rangeStartCol = -1
  let lastLabelCol = -10

  for (let ms = start, col = 0; ms <= end; ms += 7 * DAY_MS, col += 1) {
    const week: HeatCell[] = []
    let total = 0
    for (let r = 0; r < 7; r += 1) {
      const dayMs = ms + r * DAY_MS
      const hit = byMs.get(dayMs)
      const value = hit ? hit.d.value ?? null : null
      const requests = hit?.d.requests ?? null
      const errors = hit?.d.errors ?? null
      const failRate = requests && requests > 0 && errors !== null ? errors / requests : null
      const inRange = rangeStart !== null && dayMs >= rangeStart && dayMs <= last
      if (inRange && rangeStartCol < 0) rangeStartCol = col
      if (hit && value !== null) {
        total += value
        rowSums[r] += value
        rowCounts[r] += 1
      }
      week.push({
        date: isoDay(dayMs),
        i: hit ? hit.i : -1,
        level: hit ? heatLevel(value, max) : 0,
        value,
        failRate,
        peak: hit ? hit.i === peakIndex && max > 0 : false,
        inRange,
      })
      const dom = new Date(dayMs).getUTCDate()
      if (dom === 1 && col - lastLabelCol >= 3) {
        months.push({ col, label: `${new Date(dayMs).getUTCMonth() + 1}月` })
        lastLabelCol = col
      }
    }
    weeks.push(week)
    weekTotals.push(total)
  }
  if (!months.length || months[0].col > 2) {
    months.unshift({ col: 0, label: `${new Date(first).getUTCMonth() + 1}月` })
  }
  const weekdayMeans = rowSums.map((sum, r) => (rowCounts[r] ? sum / rowCounts[r] : 0))
  return { weeks, months, weekTotals, weekdayMeans, peakIndex, max, rangeStartCol }
}

/* ── lanes ──────────────────────────────────────────────────────────────────────────────────── */

/** Map an instant into [0, width] over the window [from, to]; returns null outside. */
export function timeX(at: number, from: number, to: number, width: number): number | null {
  if (!Number.isFinite(at) || to <= from) return null
  if (at < from || at > to) return null
  return ((at - from) / (to - from)) * width
}
