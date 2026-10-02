/**
 * Pure helpers for the 用量 · 缓存 / 性能 tabs (no DOM; unit-tested in server/usageInsightModel.test.ts).
 * Payload types mirror server/cacheSummary.ts and server/perfReports.ts (CONTRACTS · Change usage-b).
 */
import { clockParts, fmtDuration, NONE } from '../../../../ui/fmt.js'
import { usageFilterFrom } from '../../filters.js'

/* ── shared filters (URL) ───────────────────────────────────────────────────────────────────────── */

/** The filter bar's own rule and words (usage-a · ../../filters.ts): same keys, same defaults, same window label. */
export { windowLabel } from '../../filters.js'

/** `from` / `to`: the shared custom window (filters.ts usageSpan); '' / absent = rolling `days`. */
export type UsageScope = { days: number; keyId: string; model: string; client: string; provider: string; currentOnly?: boolean; from?: string; to?: string }

type QueryValue = string | null | Array<string | null> | undefined

const first = (value: QueryValue) => {
  const raw = Array.isArray(value) ? value[0] : value
  return typeof raw === 'string' ? raw.trim() : ''
}

/** The shared usage filters as every 用量 tab reads them: window 24h/7d/30d/90d (anything else → 7 d). */
export function scopeFromQuery(query: Record<string, QueryValue>): UsageScope {
  const f = usageFilterFrom({ days: first(query.days), from: first(query.from), to: first(query.to), keyId: first(query.keyId), model: first(query.model), provider: first(query.provider), client: first(query.client), currentOnly: first(query.currentOnly) })
  const scope: UsageScope = { days: f.days, keyId: f.keyId, model: f.model, client: f.client, provider: f.provider, currentOnly: f.currentOnly }
  if (f.from && f.to) {
    scope.from = f.from
    scope.to = f.to
  }
  return scope
}

/** `?days=7&model=…` for the report endpoints (empty filters omitted). */
export function scopeQuery(scope: UsageScope, extra: Record<string, string | number> = {}): string {
  const params = new URLSearchParams()
  if (scope.from && scope.to) {
    params.set('from', scope.from)
    params.set('to', scope.to)
  } else params.set('days', String(scope.days))
  for (const key of ['keyId', 'model', 'client', 'provider'] as const) if (scope[key]) params.set(key, scope[key])
  if (scope.currentOnly) params.set('currentOnly', '1')
  for (const [key, value] of Object.entries(extra)) params.set(key, String(value))
  return params.toString()
}

export const hasNarrowing = (scope: UsageScope) => Boolean(scope.keyId || scope.model || scope.client || scope.provider || scope.currentOnly)

/** 每小时 · 每 6 小时 · 每天 */
export function bucketLabel(bucketMs: number): string {
  const hours = Math.round(bucketMs / 3_600_000)
  if (hours >= 24) return '每天'
  return hours <= 1 ? '每小时' : `每 ${hours} 小时`
}

/* ── time labels ────────────────────────────────────────────────────────────────────────────────── */

/** Axis tick for a bucket start: 14:00 (hourly) · 09/28 12:00 (6h, compact drops the time on 00:00) · 09/28 (daily). */
export function bucketTick(t: number, bucketMs: number): string {
  const p = clockParts(t)
  if (!p) return NONE
  if (bucketMs >= 86_400_000) return `${p.month}/${p.day}`
  if (bucketMs >= 6 * 3_600_000) return p.hour === '00' ? `${p.month}/${p.day}` : `${p.hour}:00`
  return p.hour === '00' ? `${p.month}/${p.day}` : `${p.hour}:00`
}

/** Readout range of one bucket: 09/30 12:00–18:00 · 09/30 全天 · 14:00–15:00; the open bucket ends at "now". */
export function bucketRange(t: number, bucketMs: number, now: number): string {
  const a = clockParts(t)
  if (!a) return NONE
  const endMs = t + bucketMs
  const open = endMs > now
  if (bucketMs >= 86_400_000) return `${a.month}/${a.day}${open ? ' 截至现在' : ' 全天'}`
  const b = clockParts(open ? now : endMs)
  const end = b ? (open ? `${b.hour}:${b.minute}` : b.hour === '00' && a.hour !== '00' ? '24:00' : `${b.hour}:00`) : ''
  return `${a.month}/${a.day} ${a.hour}:00–${end}${open ? ' 截至现在' : ''}`
}

/* ── chart geometry ─────────────────────────────────────────────────────────────────────────────── */

/** TimeChart input: one series per line (same unit, one axis); `bar`/`hot` feed the volume strip. */
export type ChartSeries = { key: string; label: string; tone?: 'k1' | 'k2' | 'k3'; dashed?: boolean }
export type ChartPoint = { t: number; v: Record<string, number | null>; bar?: number | null; hot?: number | null }

/* ── chart geometry (cont.) ─────────────────────────────────────────────────────────────────────────────── */

/** Band layout: point i sits at the centre of its bucket, so lines and the bar strip share x. */
export const bandX = (index: number, count: number, width: number) => (count <= 0 ? 0 : ((index + 0.5) / count) * width)

/** Log-scale ticks for a ms axis (1-2-5 per decade, trimmed to ≤ maxTicks), covering [min, max]. */
export function logTicks(min: number, max: number, maxTicks = 6): { ticks: number[]; lo: number; hi: number } {
  const lo0 = Math.max(1, Number.isFinite(min) && min > 0 ? min : 1)
  const hi0 = Math.max(lo0 * 1.5, Number.isFinite(max) && max > 0 ? max : lo0 * 10)
  const steps = [1, 2, 5]
  const all: number[] = []
  for (let exp = Math.floor(Math.log10(lo0)); exp <= Math.ceil(Math.log10(hi0)); exp += 1) {
    for (const s of steps) all.push(s * 10 ** exp)
  }
  const lo = [...all].reverse().find((v) => v <= lo0) ?? all[0]
  const hi = all.find((v) => v >= hi0) ?? all[all.length - 1]
  let ticks = all.filter((v) => v >= lo && v <= hi)
  // thin to decades (then 1-3-10) when there are too many labels
  if (ticks.length > maxTicks) ticks = ticks.filter((v) => /^1/.test(String(v)) || v === lo || v === hi)
  if (ticks.length > maxTicks) ticks = ticks.filter((_, i, list) => i % 2 === 0 || i === list.length - 1)
  return { ticks, lo, hi }
}

/** Position in [0, 1] of `v` on a log axis [lo, hi]; null for missing / non-positive values. */
export function logPos(v: number | null | undefined, lo: number, hi: number): number | null {
  if (v === null || v === undefined || !Number.isFinite(v) || v <= 0) return null
  const span = Math.log10(hi) - Math.log10(lo) || 1
  return Math.max(0, Math.min(1, (Math.log10(v) - Math.log10(lo)) / span))
}

/** Compact ms label for axes: 100ms · 1s · 20s · 200s (seconds up to 1000s, then minutes). */
export function axisMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 1_000_000) return `${Number((ms / 1000).toPrecision(3))}s`
  return `${Number((ms / 60_000).toPrecision(3))}m`
}

/** "1.61s / 13.3s" — p50 / p95, or — when unknown. */
export function spreadText(spread: { p50: number | null; p95: number | null } | null | undefined): string {
  if (!spread) return NONE
  return `${fmtDuration(spread.p50)} / ${fmtDuration(spread.p95)}`
}

/* ── payloads ───────────────────────────────────────────────────────────────────────────────────── */

export type Spread = { n: number; p50: number | null; p95: number | null }

export type PerfGroup = {
  id: string
  label: string
  /** byChannel only: no longer a current channel (history in the default all-channel scope) */
  removed?: boolean
  requests: number
  errors: number
  successRate: number | null
  latency: Spread | null
  ttft: Spread | null
}

export type PerformanceReport = {
  days: number
  from: string
  to: string
  bucketMs: number
  basis: string
  totals: { requests: number; errors: number; successRate: number | null; latency: Spread | null; ttft: Spread | null }
  trend: Array<{ t: number; requests: number; errors: number; errorRate: number | null; latency: Spread | null; ttft: Spread | null }>
  byChannel: PerfGroup[]
  byModel: PerfGroup[]
  errors: Array<{ category: string; label: string; owner: string; count: number; share: number; codes: Array<{ code: number; count: number }> }>
  generatedAt: string
}

export type CacheStat = {
  requests: number
  freshInputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  promptTokens: number
  hitRate: number | null
  savingsUsd: number | null
  unpricedRequests: number
}

export type CacheSummary = {
  days: number
  from: string
  to: string
  bucketMs: number
  basis: string
  ceiling: number
  capability: { evidenceDays: number; rule: string }
  totals: CacheStat & {
    overCeilingRequests: number
    savings: {
      netUsd: number | null
      readUsd: number | null
      writeUsd: number | null
      pricedRequests: number
      unpricedRequests: number
      unpricedModels: number
      free: boolean
      approx: boolean
    }
  }
  excluded: { models: number; requests: number; items: Array<{ model: string; requests: number }> }
  trend: Array<{ t: number } & CacheStat>
  byModel: Array<{ id: string; label: string; dialect: string; overCeilingRequests: number } & CacheStat>
  byClient: Array<{ id: string; label: string } & CacheStat>
  generatedAt: string
}

/** Live stream event (server/liveStream.ts LiveUsageEvent, the fields this tab reads). */
export type LiveEvent = {
  requestId: string
  timestamp: string
  model: string
  keyName: string | null
  clientType: string
  latencyMs: number
  ttftMs?: number
  freshInputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  outputTokens: number
  promptTokens: number
  hitRate: number | null
  costUsd: number | null
  overCeiling: boolean
}

/** Newest first, de-duplicated by request id, capped. History replays arrive oldest first. */
export function mergeLive(current: LiveEvent[], incoming: LiveEvent[], cap = 50): LiveEvent[] {
  const seen = new Set<string>()
  const out: LiveEvent[] = []
  for (const event of [...[...incoming].reverse(), ...current]) {
    const id = event.requestId || `${event.timestamp}|${event.model}|${event.promptTokens}`
    if (seen.has(id)) continue
    seen.add(id)
    out.push(event)
    if (out.length >= cap) break
  }
  return out
}

/* ── money / savings words (DESIGN §6.0 rule 3: never $0.00 or n/a as a headline) ───────────────── */

export type MoneyWords = { value: string; sub: string; approx: boolean }

export function savingsWords(s: CacheSummary['totals']['savings'], fmt: (v: number, approx: boolean) => string): MoneyWords {
  if (s.pricedRequests === 0) {
    return { value: NONE, sub: s.unpricedRequests > 0 ? `未定价 ${s.unpricedModels} 个模型 · ${s.unpricedRequests} 次不计` : '没有缓存请求', approx: false }
  }
  if (s.free) return { value: '免费', sub: '免费模型 · 缓存不省钱', approx: false }
  const partly = s.unpricedRequests > 0
  return {
    value: fmt(s.netUsd ?? 0, true),
    sub: partly ? `未定价 ${s.unpricedModels} 个模型 · ${s.unpricedRequests} 次不计` : '已扣写入成本',
    approx: true,
  }
}

/** Hit-rate readout sub-line: what is counted and what is not. */
export function hitBasisWords(summary: Pick<CacheSummary, 'byModel' | 'excluded'>): string {
  const counted = `计 ${summary.byModel.length} 个模型`
  return summary.excluded.models > 0 ? `${counted} · 不支持缓存 ${summary.excluded.models} 个不计` : counted
}

/** Failure-rate threshold past which a bucket / row is an attention mark. */
export const ERROR_RATE_ATTN = 0.05
/** Success rate below which a channel / model row reads signal-ink. */
export const SUCCESS_ATTN = 0.95
