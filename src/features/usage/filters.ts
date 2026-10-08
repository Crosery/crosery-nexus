import type { LocationQuery } from 'vue-router'

/**
 * Query keys every 用量 tab understands. Tab switches keep these and drop the rest (page, q, request, sort),
 * which belong to one tab's list.
 */
export const SHARED_USAGE_KEYS = ['days', 'from', 'to', 'keyId', 'hours', 'model', 'client', 'provider', 'currentOnly'] as const

export function sharedUsageQuery(query: LocationQuery): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of SHARED_USAGE_KEYS) {
    const raw = query[key]
    const value = Array.isArray(raw) ? raw[0] : raw
    if (typeof value === 'string' && value !== '') out[key] = value
  }
  return out
}

/**
 * The one set of defaults for the shared filter bar (DESIGN §6.7): every tab reads the same keys with the same
 * defaults, so a clean `/usage/*` link means "近 7 天 · 全部 Key · 全部模型 · 全部渠道（含已移除的历史）· 全部客户端" on
 * all four tabs. `currentOnly=1` is the opt-in 「只看当前渠道」. `hours` stays a shared key only so old
 * `/cache?hours=` links survive the redirect; the window is `days`.
 */
export const USAGE_FILTER_DEFAULTS = { days: '7', from: '', to: '', keyId: '', model: '', provider: '', client: '', currentOnly: '' } as const

export const USAGE_DAYS = [1, 7, 30, 90] as const
export type UsageDays = (typeof USAGE_DAYS)[number]

export const USAGE_RANGE_ITEMS = [
  { value: '1', label: '24h' },
  { value: '7', label: '7d' },
  { value: '30', label: '30d' },
  { value: '90', label: '90d' },
]

/** Unknown or legacy window values fall back to the default 7 days (the server does the same). */
export function usageDays(raw: string | null | undefined): UsageDays {
  const value = Number(raw)
  return (USAGE_DAYS as readonly number[]).includes(value) ? (value as UsageDays) : 7
}

/**
 * `from` / `to` = a custom window of Asia/Shanghai calendar days (YYYY-MM-DD, inclusive), set from the heatmap's
 * 「按这段时间查看」. Both or neither; when set it overrides `days` on every tab (the server caps it to retention and
 * answers `window.span`). '' = the rolling `days` window, so old links keep working.
 */
export type UsageFilter = { days: UsageDays; from: string; to: string; keyId: string; model: string; provider: string; client: string; currentOnly: boolean }

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/
/** A custom span only when both ends are calendar-day keys; ordered. */
export function usageSpan(from: string | null | undefined, to: string | null | undefined): { from: string; to: string } | null {
  if (!from || !to || !DAY_KEY.test(from) || !DAY_KEY.test(to)) return null
  return from <= to ? { from, to } : { from: to, to: from }
}

/** `currentOnly` in the URL: only `1` / `true` narrow to the current channels (the server reads it the same way). */
export const isCurrentOnly = (raw: string | null | undefined) => raw === '1' || raw === 'true'

export function usageFilterFrom(state: Record<string, string>): UsageFilter {
  const span = usageSpan(state.from, state.to)
  return {
    days: usageDays(state.days),
    from: span?.from ?? '',
    to: span?.to ?? '',
    keyId: state.keyId ?? '',
    model: state.model ?? '',
    provider: state.provider ?? '',
    client: state.client ?? '',
    currentOnly: isCurrentOnly(state.currentOnly),
  }
}

/**
 * The rolling window the server did not serve: it keeps windows inside retention and answers the default 7d for one
 * it cannot (90d with 30 days kept). The applied days when the answer is for another window than asked, else null.
 */
export function refusedWindow(asked: UsageFilter, window: { days: number; span?: unknown } | null | undefined): UsageDays | null {
  if (asked.from || !window || window.span) return null
  return window.days === asked.days ? null : usageDays(String(window.days))
}

/** "近 7 天" / "近 24 小时" — the window named on every plate. */
export function windowLabel(days: number): string {
  return days === 1 ? '近 24 小时' : `近 ${days} 天`
}

/** 9/01 → 9/28 (year added when it is not this one) — the custom-window chip and plate labels. */
export function spanLabel(span: { from: string; to: string }, thisYear = new Date().getFullYear()): string {
  const part = (day: string) => `${String(day.slice(0, 4)) === String(thisYear) ? '' : `${day.slice(0, 4)}/`}${Number(day.slice(5, 7))}/${day.slice(8, 10)}`
  return span.from === span.to ? part(span.from) : `${part(span.from)} → ${part(span.to)}`
}

/** The window as plates name it: the custom span when the server answered one, else 近 N 天. */
export function windowText(window: { days: number; span?: { from: string; to: string } | null } | null | undefined, fallbackDays: number): string {
  return window?.span ? spanLabel(window.span) : windowLabel(window?.days ?? fallbackDays)
}
