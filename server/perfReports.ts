/**
 * `GET /api/usage-performance` — the 用量 · 性能 tab (DESIGN §6.7).
 *
 * Reads the same local `usage_events` table as the other usage reports, with the same channel scope (all
 * traffic by default, removed channels included and marked; `currentOnly=1` narrows to the current channels)
 * and the shared usage filters (days · keyId · model · client · provider). It never calls an upstream.
 *
 * Percentiles are exact nearest-rank (rank = ⌈p·n⌉, the same rule as `/api/pulse`) over successful requests
 * with a positive measurement: a 0 ms latency or TTFT means "not reported" (non-streaming calls have no first
 * token), so it is excluded instead of dragging p50 to zero. One window-function pass per metric yields the
 * overall, per-model, per-channel and per-bucket figures.
 *
 * Request / error counts come from the hourly rollup (every bucket is a whole number of hours), the same rows the
 * 总览 ledger sums, so the totals match it and the latency read stays the only raw-event scan. The window is
 * [from, end of the current hour) on both tables: a row stamped later than the current hour is not counted, so
 * totals always equal the sum of the trend.
 *
 * The window/bucket/filter helpers here are shared with `cacheSummary.ts` so both tabs cut time the same way.
 */
import type express from 'express'
import type { ConsoleGroup } from './groups.js'
import type { ReadOperation } from './sqliteReadWorker.js'
import { activeProviderValues, scopedProviderPredicate } from './currentChannels.js'
import { canonicalModelSql, channelLabel } from './modelIdentity.js'
import { clientTypeSql } from './clientAgent.js'
import { providerAliases } from './liveStream.js'
import { RequestCoordinator } from './requestCoordinator.js'
import { isRemovedChannel, usageChannelSql, usageFilterWindow, usageWorkspaceWindow } from './usageReports.js'
import { parseUsageWorkspaceFilter, UsageFilterError, type UsageClock } from './usageWorkspaceRoutes.js'

export type Reader = { run(operations: readonly ReadOperation[]): Promise<unknown[]> }

const HOUR = 3_600_000
const DAY = 24 * HOUR

/* ── shared scope: window, buckets, filters ─────────────────────────────────────────────────────── */

export type UsageScope = {
  days: number
  keyId: string
  model: string
  client: string
  provider: string
  /** true = 只看当前渠道（显式筛选）；缺省 / false = 全部渠道，含已移除渠道的历史 */
  currentOnly?: boolean
  /** 自定义跨度（配置时区的日历日，含首尾）；见 parseUsageWindowSpan。`days` 此时是跨度天数 */
  from?: string
  to?: string
}

/**
 * The shared 用量 filter bar, parsed by the same rule as the other three tabs (`parseUsageWorkspaceFilter`):
 * window 24h / 7d / 30d / 90d within retention, anything else → 7 d; over-long or control-character filter
 * values throw `UsageFilterError` (the route answers 400 `invalid_filter`). Channel ids compare lower-cased.
 */
export function parseUsageScope(query: Record<string, unknown>, retentionDays: number, clock: UsageClock = {}): UsageScope {
  const filter = parseUsageWorkspaceFilter(query, retentionDays, clock)
  const scope: UsageScope = { days: filter.days, keyId: filter.keyId, model: filter.model, client: filter.client, provider: filter.provider.toLowerCase(), currentOnly: Boolean(filter.currentOnly) }
  if (filter.from && filter.to) {
    scope.from = filter.from
    scope.to = filter.to
  }
  return scope
}

/** 400 for a filter value the shared parser refuses; true when the response was sent. */
export function rejectBadFilter(error: unknown, res: express.Response): boolean {
  if (!(error instanceof UsageFilterError)) return false
  res.status(400).json({ error: error.message, code: 'invalid_filter', field: error.field })
  return true
}

/** Offset of `timeZone` from UTC at `at`, in ms (Asia/Shanghai → +8h). Unknown zones fall back to UTC. */
export function tzOffsetMs(timeZone: string, at: number): number {
  try {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', {
        timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
      }).formatToParts(at).map((part) => [part.type, part.value]),
    )
    const wall = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour) % 24, Number(parts.minute), Number(parts.second))
    const offset = wall - Math.floor(at / 1000) * 1000
    return Number.isFinite(offset) ? offset : 0
  } catch {
    return 0
  }
}

export type BucketPlan = {
  fromMs: number
  toMs: number
  bucketMs: number
  /** local-time offset used to align 6h / 1d buckets to the wall clock (fixed at `toMs`) */
  offsetMs: number
  /** bucket index (SQL `CAST((ts + offset) / bucket AS INTEGER)`) of the first and last bucket */
  first: number
  last: number
}

/** 24h → hourly, 7d → 6-hourly, longer → daily; buckets follow the console time zone's wall clock. */
export function bucketPlan(days: number, now: number, timeZone: string): BucketPlan {
  const bucketMs = days <= 1 ? HOUR : days <= 7 ? 6 * HOUR : DAY
  const offsetMs = tzOffsetMs(timeZone, now)
  // the workspace window (总览 / 请求 use it too): from the first whole hour after now − N·24h
  const { fromMs } = usageWorkspaceWindow(days, now)
  return {
    fromMs,
    toMs: now,
    bucketMs,
    offsetMs,
    first: Math.floor((fromMs + offsetMs) / bucketMs),
    last: Math.floor((now + offsetMs) / bucketMs),
  }
}

/**
 * 一个 scope 的分桶计划与「时钟」：滚动窗口时钟 = now；自定义跨度时窗口从 from 那天 00:00 起，时钟停在跨度最后
 * 一刻（跨度含今天则仍是 now），调用方把它当 now 用，窗口终点、末桶与「截至」就都落在跨度里。
 */
export function scopePlan(scope: UsageScope, now: number, timeZone: string): { plan: BucketPlan; clock: number } {
  if (!scope.from || !scope.to) return { plan: bucketPlan(scope.days, now, timeZone), clock: now }
  const window = usageFilterWindow(scope, now, timeZone)
  const clock = Math.min(now, window.endMs - 1)
  const plan = bucketPlan(scope.days, clock, timeZone)
  return { plan: { ...plan, fromMs: window.fromMs, first: Math.floor((window.fromMs + plan.offsetMs) / plan.bucketMs) }, clock }
}

export const bucketStart = (plan: BucketPlan, index: number) => index * plan.bucketMs - plan.offsetMs

/** SQL for the bucket index; both numbers are integers computed here, never user input. */
export const bucketSql = (plan: BucketPlan, column: string) =>
  `CAST((${column} + ${Math.trunc(plan.offsetMs)}) / ${Math.trunc(plan.bucketMs)} AS INTEGER)`

/**
 * WHERE fragments for the shared filters. `source` picks the column flavour: the hourly rollup stores the
 * already-recovered client type, raw events need `clientTypeSql()` to show the same identity.
 */
export function scopeFilterSql(groups: ConsoleGroup[], scope: Pick<UsageScope, 'keyId' | 'model' | 'client' | 'provider' | 'currentOnly'>, source: 'events' | 'rollup') {
  const active = scopedProviderPredicate(groups, 'provider', Boolean(scope.currentOnly))
  const clauses = [active.sql]
  const params: string[] = [...active.params]
  if (scope.keyId) {
    clauses.push('key_hash = ?')
    params.push(scope.keyId)
  }
  if (scope.model) {
    clauses.push(`(model = ? OR ${canonicalModelSql()} = ?)`)
    params.push(scope.model, scope.model)
  }
  if (scope.client) {
    clauses.push(`${source === 'rollup' ? 'client_type' : clientTypeSql()} = ?`)
    params.push(scope.client)
  }
  const aliases = providerAliases(scope.provider)
  if (aliases.length) {
    clauses.push(`lower(trim(provider)) IN (${aliases.map(() => '?').join(', ')})`)
    params.push(...aliases)
  }
  return { sql: clauses.join(' AND '), params }
}

/** Cache key part that changes when the set of current channels changes. */
export const groupsKey = (groups: ConsoleGroup[]) => activeProviderValues(groups).join(',')

/*
 * ── error categories: the 用量 workspace words (usage/shared/format.ts CATEGORY_LABEL) + whose problem it is ──
 * The one table for every usage surface: 总览 / 请求 failures (usageReports.ts) read the same owner words.
 */

export const ERROR_CATEGORIES: Record<string, { label: string; owner: string }> = {
  rate_limited: { label: '上游限流', owner: '可重试' },
  quota_exhausted: { label: '上游额度用尽', owner: '需换号' },
  auth_failed: { label: '鉴权失败', owner: '需授权' },
  upstream_5xx: { label: '上游故障', owner: '上游' },
  upstream_eof: { label: '上游断开', owner: '上游' },
  client_cancelled: { label: '客户端取消', owner: '客户端' },
  context_too_large: { label: '上下文过长', owner: '客户端' },
  wrong_endpoint: { label: '入口不对', owner: '客户端' },
  other: { label: '其他', owner: '待查' },
}

export const errorCategoryWords = (category: string) =>
  (Object.hasOwn(ERROR_CATEGORIES, category) ? ERROR_CATEGORIES[category] : null) ?? { label: category, owner: '待查' }

/* ── percentiles ────────────────────────────────────────────────────────────────────────────────── */

/** Nearest-rank index (1-based) of the p-th percentile among n sorted values: ⌈p·n⌉, at least 1. */
export const nearestRank = (n: number, p: number) => Math.max(1, Math.ceil((p * n) - 1e-9))

export type Spread = { n: number; p50: number | null; p95: number | null }

type PercentileRow = { dim: 'a' | 'm' | 'p' | 'b'; k: string | number | null; n: number | null; p50: number | null; p95: number | null }

/**
 * One pass over the filtered successful requests; four window partitions (all · model · channel · bucket).
 * `(n + 1) / 2` and `(95 * n + 99) / 100` are integer ⌈0.5n⌉ and ⌈0.95n⌉.
 */
export function percentileOperation(groups: ConsoleGroup[], scope: UsageScope, plan: BucketPlan, metric: 'latency_ms' | 'ttft_ms'): ReadOperation {
  const filter = scopeFilterSql(groups, scope, 'events')
  const endMs = Math.floor(plan.toMs / HOUR) * HOUR + HOUR
  const channel = usageChannelSql(groups, 'provider')
  const pick = (r: string, c: string) =>
    `MAX(${c}) n, MAX(CASE WHEN ${r} = (${c} + 1) / 2 THEN v END) p50, MAX(CASE WHEN ${r} = (95 * ${c} + 99) / 100 THEN v END) p95`
  return {
    method: 'all',
    sql: `
      WITH base AS MATERIALIZED (
        SELECT ${bucketSql(plan, 'timestamp_ms')} b, ${canonicalModelSql()} m, ${channel.sql} p, ${metric} v
        FROM usage_events
        WHERE timestamp_ms >= ? AND timestamp_ms < ? AND success = 1 AND ${metric} > 0 AND ${filter.sql}
      ),
      r AS MATERIALIZED (
        SELECT b, m, p, v,
          ROW_NUMBER() OVER (ORDER BY v) ra, COUNT(*) OVER () ca,
          ROW_NUMBER() OVER (PARTITION BY m ORDER BY v) rm, COUNT(*) OVER (PARTITION BY m) cm,
          ROW_NUMBER() OVER (PARTITION BY p ORDER BY v) rp, COUNT(*) OVER (PARTITION BY p) cp,
          ROW_NUMBER() OVER (PARTITION BY b ORDER BY v) rb, COUNT(*) OVER (PARTITION BY b) cb
        FROM base
      )
      SELECT 'a' dim, '' k, ${pick('ra', 'ca')} FROM r
      UNION ALL SELECT 'm', m, ${pick('rm', 'cm')} FROM r GROUP BY m
      UNION ALL SELECT 'p', p, ${pick('rp', 'cp')} FROM r GROUP BY p
      UNION ALL SELECT 'b', b, ${pick('rb', 'cb')} FROM r GROUP BY b`,
    params: [...channel.params, plan.fromMs, endMs, ...filter.params],
  }
}

/* ── report ─────────────────────────────────────────────────────────────────────────────────────── */

/** `h` = hour start (epoch ms); the bucket is derived from it */
type CountRow = { h: number; m: string; p: string; s: number; c: number; e: string; n: number }

export type PerfGroup = {
  id: string
  label: string
  /** byChannel only: the channel is no longer a current channel (全部渠道口径下的历史，页面标「已移除」) */
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
  timeZone: string
  filters: Omit<UsageScope, 'days'>
  basis: string
  totals: { requests: number; errors: number; successRate: number | null; latency: Spread | null; ttft: Spread | null }
  trend: Array<{ t: number; requests: number; errors: number; errorRate: number | null; latency: Spread | null; ttft: Spread | null }>
  byChannel: PerfGroup[]
  byModel: PerfGroup[]
  errors: Array<{ category: string; label: string; owner: string; count: number; share: number; codes: Array<{ code: number; count: number }> }>
  generatedAt: string
}

const spreadOf = (row: PercentileRow | undefined): Spread | null => {
  const n = Number(row?.n) || 0
  if (!row || n <= 0) return null
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  return { n, p50: num(row.p50), p95: num(row.p95) }
}

const indexBy = (rows: PercentileRow[], dim: PercentileRow['dim']) => {
  const map = new Map<string, PercentileRow>()
  for (const row of rows) if (row.dim === dim) map.set(String(row.k ?? ''), row)
  return map
}

export function buildPerformanceReport(input: {
  counts: CountRow[]
  latency: PercentileRow[]
  ttft: PercentileRow[]
  groups: ConsoleGroup[]
  scope: UsageScope
  plan: BucketPlan
  timeZone: string
  now: number
}): PerformanceReport {
  const { counts, latency, ttft, groups, scope, plan } = input
  type Tally = { requests: number; errors: number }
  const tally = () => ({ requests: 0, errors: 0 })
  const total = tally()
  const byBucket = new Map<number, Tally>()
  const byModel = new Map<string, Tally>()
  const byChannel = new Map<string, Tally>()
  const errors = new Map<string, { count: number; codes: Map<number, number> }>()
  const add = <K>(map: Map<K, Tally>, key: K, n: number, failed: boolean) => {
    const entry = map.get(key) ?? tally()
    entry.requests += n
    if (failed) entry.errors += n
    map.set(key, entry)
  }

  for (const row of counts) {
    const n = Number(row.n) || 0
    if (n <= 0) continue
    const failed = Number(row.s) === 0
    // p is already the folded channel id (usageChannelSql), the same key the percentile partitions use
    const channel = String(row.p || 'unknown')
    total.requests += n
    if (failed) total.errors += n
    add(byBucket, Math.floor((Number(row.h) + plan.offsetMs) / plan.bucketMs), n, failed)
    add(byModel, String(row.m || 'unknown'), n, failed)
    add(byChannel, channel, n, failed)
    if (failed) {
      const category = String(row.e || 'other')
      const entry = errors.get(category) ?? { count: 0, codes: new Map<number, number>() }
      entry.count += n
      const code = Number(row.c) || 0
      entry.codes.set(code, (entry.codes.get(code) ?? 0) + n)
      errors.set(category, entry)
    }
  }

  const latencyBy = { m: indexBy(latency, 'm'), p: indexBy(latency, 'p'), b: indexBy(latency, 'b') }
  const ttftBy = { m: indexBy(ttft, 'm'), p: indexBy(ttft, 'p'), b: indexBy(ttft, 'b') }
  const rate = (t: Tally) => (t.requests > 0 ? (t.requests - t.errors) / t.requests : null)

  const groupList = (map: Map<string, Tally>, dim: 'm' | 'p', label: (id: string) => string): PerfGroup[] =>
    [...map.entries()]
      .map(([id, t]) => ({
        id,
        label: label(id),
        requests: t.requests,
        errors: t.errors,
        successRate: rate(t),
        latency: spreadOf(latencyBy[dim].get(id)),
        ttft: spreadOf(ttftBy[dim].get(id)),
      }))
      .sort((a, b) => b.requests - a.requests || a.id.localeCompare(b.id))

  const trend: PerformanceReport['trend'] = []
  for (let index = plan.first; index <= plan.last; index += 1) {
    const t = byBucket.get(index) ?? tally()
    trend.push({
      t: bucketStart(plan, index),
      requests: t.requests,
      errors: t.errors,
      errorRate: t.requests > 0 ? t.errors / t.requests : null,
      latency: spreadOf(latencyBy.b.get(String(index))),
      ttft: spreadOf(ttftBy.b.get(String(index))),
    })
  }

  const errorTotal = [...errors.values()].reduce((sum, e) => sum + e.count, 0)
  const all = (rows: PercentileRow[]) => rows.find((row) => row.dim === 'a')

  return {
    days: scope.days,
    from: new Date(plan.fromMs).toISOString(),
    to: new Date(plan.toMs).toISOString(),
    bucketMs: plan.bucketMs,
    timeZone: input.timeZone,
    filters: { keyId: scope.keyId, model: scope.model, client: scope.client, provider: scope.provider, currentOnly: Boolean(scope.currentOnly) },
    basis: '成功请求 · 最近秩 P50 / P95 · 0ms 记为未上报',
    totals: { requests: total.requests, errors: total.errors, successRate: rate(total), latency: spreadOf(all(latency)), ttft: spreadOf(all(ttft)) },
    trend,
    byChannel: groupList(byChannel, 'p', channelLabel).map((entry) => ({ ...entry, removed: isRemovedChannel(entry.id, groups) })),
    byModel: groupList(byModel, 'm', (id) => id),
    errors: [...errors.entries()]
      .map(([category, e]) => ({
        category,
        ...errorCategoryWords(category),
        count: e.count,
        share: errorTotal > 0 ? e.count / errorTotal : 0,
        codes: [...e.codes.entries()].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count || a.code - b.code),
      }))
      .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category)),
    generatedAt: new Date(input.now).toISOString(),
  }
}

export async function loadPerformanceReport(reader: Reader, groups: ConsoleGroup[], scope: UsageScope, options: { timeZone: string; now?: number }) {
  const { plan, clock: now } = scopePlan(scope, options.now ?? Date.now(), options.timeZone)
  const filter = scopeFilterSql(groups, scope, 'rollup')
  const channel = usageChannelSql(groups, 'provider')
  const endMs = Math.floor(now / HOUR) * HOUR + HOUR
  const [counts, latency, ttft] = await reader.run([
    {
      method: 'all',
      sql: `SELECT (hour_ms / ${HOUR}) * ${HOUR} h, ${canonicalModelSql()} m, ${channel.sql} p,
          success s, status_code c, CASE WHEN error_category = '' THEN 'other' ELSE error_category END e, SUM(request_count) n
        FROM usage_hourly_rollup
        WHERE hour_ms >= ? AND hour_ms < ? AND ${filter.sql}
        GROUP BY h, m, p, s, c, e`,
      params: [...channel.params, plan.fromMs, endMs, ...filter.params],
    },
    percentileOperation(groups, scope, plan, 'latency_ms'),
    percentileOperation(groups, scope, plan, 'ttft_ms'),
  ])
  return buildPerformanceReport({
    counts: counts as CountRow[],
    latency: latency as PercentileRow[],
    ttft: ttft as PercentileRow[],
    groups,
    scope,
    plan,
    timeZone: options.timeZone,
    now,
  })
}

/* ── route ──────────────────────────────────────────────────────────────────────────────────────── */

export type InsightRouteDeps = {
  reader: Reader
  groups: () => Promise<ConsoleGroup[]>
  timeZone: string
  retentionDays: number
  now?: () => number
}

/** Admin-only by the global session guard (every `/api/*` outside `/api/me*` is 403 for key sessions). */
export function registerPerfRoutes(app: express.Express, deps: InsightRouteDeps) {
  // keys carry every filter value: bounded so filter browsing cannot grow the cache for the process lifetime
  const coordinator = new RequestCoordinator<PerformanceReport>({ ttlMs: 20_000, staleWhileRevalidateMs: 5 * 60_000, maxEntries: 100 })
  app.get('/api/usage-performance', async (req, res) => {
    let scope: UsageScope
    try {
      scope = parseUsageScope(req.query as Record<string, unknown>, deps.retentionDays, { timeZone: deps.timeZone, now: deps.now?.() })
    } catch (error) {
      if (rejectBadFilter(error, res)) return
      throw error
    }
    try {
      const groups = await deps.groups()
      const key = JSON.stringify(['perf:v2', scope, groupsKey(groups)])
      const payload = await coordinator.run(key, () => loadPerformanceReport(deps.reader, groups, scope, { timeZone: deps.timeZone, now: deps.now?.() }))
      res.setHeader('Cache-Control', 'private, max-age=20, stale-while-revalidate=300')
      res.json(payload)
    } catch (error) {
      console.warn(`[usage-performance] 读取失败：${error instanceof Error ? error.message : '未知错误'}`)
      res.status(503).json({ error: '性能报表暂时读不出来', code: 'report_unavailable' })
    }
  })
}
