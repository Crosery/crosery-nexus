/**
 * Number / time formatting per DESIGN.md §2.5 (pages format through these, not toFixed/toLocaleString).
 * - null / undefined / NaN → '—' (unknown is never a fake 0)
 * - thousands separators always; compact units from 10,000 up: 35.4k · 248.6M · 10.95B
 * - durations pick their unit: 849ms · 1.82s · 83.7s
 * - money $1,284.30; estimates carry '≈'
 * - times are Asia/Shanghai: 14:32:08 today, 09/30 22:02:06 otherwise
 */
export const TIME_ZONE = 'Asia/Shanghai'
export const NONE = '—'

type Num = number | null | undefined

const ok = (value: Num): value is number => typeof value === 'number' && Number.isFinite(value)

const intFmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })

export function fmtInt(value: Num): string {
  return ok(value) ? intFmt.format(Math.round(value)) : NONE
}

export function fmtNum(value: Num, digits = 2): string {
  if (!ok(value)) return NONE
  return new Intl.NumberFormat('en-US', { minimumFractionDigits: 0, maximumFractionDigits: digits }).format(value)
}

/** 9,412 · 35.4k · 248.6M · 10.95B (compact only at ≥10,000). */
export function fmtCompact(value: Num): string {
  if (!ok(value)) return NONE
  const abs = Math.abs(value)
  const sign = value < 0 ? '-' : ''
  if (abs < 10_000) return fmtInt(value)
  if (abs < 1e6) return `${sign}${trim((abs / 1e3).toFixed(1))}k`
  if (abs < 1e9) return `${sign}${trim((abs / 1e6).toFixed(1))}M`
  return `${sign}${trim((abs / 1e9).toFixed(2))}B`
}

function trim(text: string): string {
  return text.replace(/\.0+$/, '').replace(/(\.\d*[1-9])0+$/, '$1')
}

/** $1,284.30 · <$0.01 for dust · '—' when unknown. `approx` prefixes ≈ (partly unpriced). */
export function fmtUsd(value: Num, options: { approx?: boolean; digits?: number } = {}): string {
  if (!ok(value)) return NONE
  const prefix = options.approx ? '≈ ' : ''
  const abs = Math.abs(value)
  if (abs > 0 && abs < 0.01 && options.digits === undefined) return `${prefix}${value < 0 ? '-' : ''}<$0.01`
  const digits = options.digits ?? 2
  const text = new Intl.NumberFormat('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(abs)
  return `${prefix}${value < 0 ? '-' : ''}$${text}`
}

/**
 * A per-row spend figure (DESIGN §6.0 rule 3): unknown, or nothing spent in the window, is —, never a `$0.00`
 * headline; real money keeps its value (including <$0.01).
 */
export function fmtSpend(value: Num): string {
  return ok(value) && value !== 0 ? fmtUsd(value) : NONE
}

/** 0.714 → 71.4% (ratio in, percent out). */
export function fmtPct(ratio: Num, digits = 1): string {
  if (!ok(ratio)) return NONE
  return `${(ratio * 100).toFixed(digits)}%`
}

/** 849ms · 1.82s · 83.7s · 412s. */
export function fmtDuration(ms: Num): string {
  if (!ok(ms)) return NONE
  if (ms < 1000) return `${Math.round(ms)}ms`
  const s = ms / 1000
  if (s < 10) return `${s.toFixed(2)}s`
  if (s < 100) return `${s.toFixed(1)}s`
  return `${Math.round(s)}s`
}

export type DeltaUnit = 'pct' | 'pp' | 'abs'

/** ▲ 6.2% · ▼ 0.3pp · ▲ 12. For 'pct' pass the relative change as a ratio (0.062). */
export function fmtDelta(value: Num, unit: DeltaUnit = 'pct', digits = 1): string {
  if (!ok(value)) return NONE
  const arrow = value > 0 ? '▲' : value < 0 ? '▼' : '·'
  const abs = Math.abs(value)
  if (unit === 'pct') return `${arrow} ${(abs * 100).toFixed(digits)}%`
  if (unit === 'pp') return `${arrow} ${(abs * 100).toFixed(digits)}pp`
  return `${arrow} ${fmtNum(abs, digits)}`
}

type Instant = string | number | Date | null | undefined

function toDate(value: Instant): Date | null {
  if (value === null || value === undefined || value === '') return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

const partsFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TIME_ZONE, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
})

export type ClockParts = { year: string; month: string; day: string; hour: string; minute: string; second: string; weekday: number }

const WEEKDAY_INDEX: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 0 }

/** Wall-clock parts in Asia/Shanghai. weekday: 0 = Sunday … 6 = Saturday. */
export function clockParts(value: Instant): ClockParts | null {
  const date = toDate(value)
  if (!date) return null
  const out: Record<string, string> = {}
  for (const part of partsFmt.formatToParts(date)) out[part.type] = part.value
  return {
    year: out.year, month: out.month, day: out.day,
    hour: out.hour === '24' ? '00' : out.hour, minute: out.minute, second: out.second,
    weekday: WEEKDAY_INDEX[out.weekday] ?? 0,
  }
}

/** YYYY-MM-DD in Asia/Shanghai (the day key the usage endpoints use). */
export function dayKey(value: Instant): string {
  const p = clockParts(value)
  return p ? `${p.year}-${p.month}-${p.day}` : ''
}

/** 14:32:08 if `value` is today (Shanghai), else 09/30 22:02:06. */
export function fmtClock(value: Instant, now: Instant = Date.now()): string {
  const p = clockParts(value)
  if (!p) return NONE
  const time = `${p.hour}:${p.minute}:${p.second}`
  return dayKey(value) === dayKey(now) ? time : `${p.month}/${p.day} ${time}`
}

/** 14:32 · or 09/30 14:32 when not today. */
export function fmtTime(value: Instant, now: Instant = Date.now()): string {
  const p = clockParts(value)
  if (!p) return NONE
  const time = `${p.hour}:${p.minute}`
  return dayKey(value) === dayKey(now) ? time : `${p.month}/${p.day} ${time}`
}

const WEEKDAY_ZH = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/** 2026-10-02 周五 */
export function fmtDate(value: Instant): string {
  const p = clockParts(value)
  return p ? `${p.year}-${p.month}-${p.day} ${WEEKDAY_ZH[p.weekday]}` : NONE
}

/** 2s 前 · 3m 前 · 2h 前 · 4d 前 (terse, mono-friendly). Future instants read 后. */
export function fmtAgo(value: Instant, now: Instant = Date.now()): string {
  const date = toDate(value)
  const ref = toDate(now)
  if (!date || !ref) return NONE
  const diff = ref.getTime() - date.getTime()
  const suffix = diff >= 0 ? '前' : '后'
  const s = Math.round(Math.abs(diff) / 1000)
  if (s < 60) return `${s}s ${suffix}`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ${suffix}`
  const h = Math.round(m / 60)
  if (h < 48) return `${h}h ${suffix}`
  return `${Math.round(h / 24)}d ${suffix}`
}

/** Split a formatted figure into its number and unit suffix so the unit can be set smaller (34.2% → 34.2 + %). */
export function splitUnit(text: string): { value: string; unit: string } {
  const match = /^(.*?[\d.,]+)\s?(%|pp|ms|s|k|M|B|x|×)?$/.exec(text)
  if (!match) return { value: text, unit: '' }
  return { value: match[1], unit: match[2] ?? '' }
}
