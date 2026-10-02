/**
 * `GET /api/cache-summary` — the 用量 · 缓存 tab (DESIGN §6.0 data truth, §6.7).
 *
 * Source is the hourly rollup (`usage_hourly_rollup`, the read worker falls back to raw events when it is
 * missing), with the same channel scope (all traffic by default, `currentOnly=1` = current channels only) and the
 * shared usage filters as the other usage reports. Token semantics come from `cacheStats.ts` (Anthropic: input / cache read / cache write are three
 * parallel segments; OpenAI-style: cached ⊂ input), so the rate here equals the one the old cache pages showed.
 *
 * Two rules the old page broke:
 * - **Hit rate counts only cache-capable models.** A model is cache-capable when its price card has a
 *   cache-read discount, or when it reported any cache read / write in the last max(window, 30) days in the
 *   same channel scope (all keys, all clients — a filter never changes what a model can do). Everything else is
 *   listed as "不支持缓存 · N 个模型 · 不计入" instead of a red 0%.
 * - **Savings are net of the write premium**: read tokens × (input − cache-read price) minus write tokens ×
 *   (cache-write price − input price), each at the price in force in the hour the requests happened (rows keep
 *   their hour; the money is folded into display buckets afterwards). Tiered prices use the average prompt of
 *   the hour × model × channel × client group, so the figure is an estimate (≈). Unpriced models are counted,
 *   never priced 0.
 *
 * Every other 缓存命中率 / 缓存净节省 surface (the usage workspace ledger, mix and facet badge, the dashboard) reads
 * these same rows through `buildCacheSummary`, so one filter shows one figure everywhere.
 *
 * Window: [from, end of the current hour) — rollup hours after the current one (a clock-skewed row) are not
 * counted, so totals always equal the sum of the trend. Over-ceiling counts need per-request prompt lengths,
 * so that one figure reads raw events with the same bounds.
 */
import type express from 'express'
import type { ConsoleGroup } from './groups.js'
import type { ReadOperation } from './sqliteReadWorker.js'
import { CACHE_WRITE_CEILING, cacheDialectFor } from './cacheStats.js'
import { cacheWritePrice, getModelPricing, ratesFor } from './pricing.js'
import { canonicalModelSql } from './modelIdentity.js'
import { clientLabel } from './clientAgent.js'
import { scopedProviderPredicate } from './currentChannels.js'
import { RequestCoordinator } from './requestCoordinator.js'
import {
  bucketStart, groupsKey, parseUsageScope, rejectBadFilter, scopeFilterSql, scopePlan,
  type BucketPlan, type InsightRouteDeps, type Reader, type UsageScope,
} from './perfReports.js'

const HOUR = 3_600_000
const DAY = 24 * HOUR
/** Evidence window for "this model uses the cache" — longer than a 24h/7d view so capability is stable. */
export const CAPABILITY_EVIDENCE_DAYS = 30
const NATIVE_ANTHROPIC = ['claude', 'claude-api-key', 'anthropic', 'anthropic-api-key']

export type CacheRollupRow = RollupRow
type RollupRow = {
  /** hour start (epoch ms) of the rows folded into this one */
  h: number
  m: string
  p: string
  c: string
  n: number
  input: number
  uncached: number
  cached: number
  cw: number
}

type Segments = { requests: number; freshInputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }

type Money = { readUsd: number; writeUsd: number; pricedRequests: number; unpricedRequests: number; freeRequests: number }

export type CacheStat = Segments & {
  promptTokens: number
  hitRate: number | null
  /** net savings (read saving − write premium); null when no request in the group is priced */
  savingsUsd: number | null
  unpricedRequests: number
}

export type CacheSummary = {
  days: number
  from: string
  to: string
  bucketMs: number
  timeZone: string
  filters: Omit<UsageScope, 'days'>
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
      /** every priced request is on a zero-price model: there is nothing to save */
      free: boolean
      approx: true
    }
  }
  excluded: { models: number; requests: number; items: Array<{ model: string; requests: number }> }
  trend: Array<{ t: number } & CacheStat>
  byModel: Array<{ id: string; label: string; dialect: 'anthropic' | 'openai' | 'mixed'; overCeilingRequests: number } & CacheStat>
  byClient: Array<{ id: string; label: string } & CacheStat>
  generatedAt: string
}

const num = (v: unknown) => {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : 0
}

/** Rollup row → normalized prompt segments (the dialect decides what `input_tokens` means). */
export function segmentsOf(row: Pick<RollupRow, 'm' | 'p' | 'n' | 'input' | 'uncached' | 'cached' | 'cw'>): Segments & { dialect: 'anthropic' | 'openai' } {
  const dialect = cacheDialectFor(row.m, { provider: row.p })
  return {
    dialect,
    requests: num(row.n),
    freshInputTokens: dialect === 'anthropic' ? num(row.input) : num(row.uncached),
    cacheReadTokens: num(row.cached),
    cacheWriteTokens: dialect === 'anthropic' ? num(row.cw) : 0,
  }
}

/** Price card says reads are discounted (or writes have their own rate): the model is built for caching. */
export function priceDeclaresCache(model: string, at?: number): boolean {
  const pricing = getModelPricing(model, at)
  if (!pricing) return false
  return pricing.cacheRead < pricing.input || (pricing.cacheWrite !== undefined && pricing.cacheWrite !== pricing.input)
}

/** Net savings of one rollup group at the price in force at `at`; null when the model is unpriced. */
export function savingsFor(model: string, seg: Segments, at: number): { readUsd: number; writeUsd: number; free: boolean } | null {
  const pricing = getModelPricing(model, at)
  if (!pricing) return null
  const prompt = seg.freshInputTokens + seg.cacheReadTokens + seg.cacheWriteTokens
  const rates = ratesFor(pricing, seg.requests > 0 ? prompt / seg.requests : undefined)
  const readUsd = (seg.cacheReadTokens * Math.max(0, rates.input - rates.cacheRead)) / 1_000_000
  const writeUsd = (seg.cacheWriteTokens * Math.max(0, cacheWritePrice(rates) - rates.input)) / 1_000_000
  return { readUsd, writeUsd, free: rates.input === 0 && rates.output === 0 }
}

const emptySegments = (): Segments => ({ requests: 0, freshInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })
const emptyMoney = (): Money => ({ readUsd: 0, writeUsd: 0, pricedRequests: 0, unpricedRequests: 0, freeRequests: 0 })

function finish(seg: Segments, money: Money): CacheStat {
  const promptTokens = seg.freshInputTokens + seg.cacheReadTokens + seg.cacheWriteTokens
  return {
    ...seg,
    promptTokens,
    hitRate: promptTokens > 0 ? seg.cacheReadTokens / promptTokens : null,
    savingsUsd: money.pricedRequests > 0 ? money.readUsd - money.writeUsd : null,
    unpricedRequests: money.unpricedRequests,
  }
}

export function buildCacheSummary(input: {
  rows: RollupRow[]
  /** canonical models with cache read/write in the evidence window */
  evidence: Iterable<string>
  overCeiling: Array<{ m: string; n: number }>
  scope: UsageScope
  plan: BucketPlan
  timeZone: string
  now: number
}): CacheSummary {
  const { rows, scope, plan } = input
  const evidence = new Set(input.evidence)
  const capable = new Map<string, boolean>()
  const isCapable = (model: string) => {
    let known = capable.get(model)
    if (known === undefined) {
      known = evidence.has(model) || priceDeclaresCache(model, input.now)
      capable.set(model, known)
    }
    return known
  }

  type Acc = { seg: Segments; money: Money; dialects?: Set<string> }
  const acc = (): Acc => ({ seg: emptySegments(), money: emptyMoney() })
  const total = acc()
  const buckets = new Map<number, Acc>()
  const models = new Map<string, Acc>()
  const clients = new Map<string, Acc>()
  const excluded = new Map<string, number>()
  const unpricedModels = new Set<string>()

  const fold = (target: Acc, seg: Segments, money: Money | null) => {
    target.seg.requests += seg.requests
    target.seg.freshInputTokens += seg.freshInputTokens
    target.seg.cacheReadTokens += seg.cacheReadTokens
    target.seg.cacheWriteTokens += seg.cacheWriteTokens
    if (!money) return
    target.money.readUsd += money.readUsd
    target.money.writeUsd += money.writeUsd
    target.money.pricedRequests += money.pricedRequests
    target.money.unpricedRequests += money.unpricedRequests
    target.money.freeRequests += money.freeRequests
  }
  const into = <K>(map: Map<K, Acc>, key: K) => {
    let entry = map.get(key)
    if (!entry) {
      entry = acc()
      map.set(key, entry)
    }
    return entry
  }

  for (const row of rows) {
    const model = String(row.m || 'unknown')
    const { dialect, ...seg } = segmentsOf(row)
    if (seg.requests <= 0) continue
    if (!isCapable(model)) {
      excluded.set(model, (excluded.get(model) ?? 0) + seg.requests)
      continue
    }
    const hour = Number(row.h)
    const bucket = Math.floor((hour + plan.offsetMs) / plan.bucketMs)
    // priced at the hour the requests happened, not at the display bucket's start (a bucket can straddle a price change)
    const saved = savingsFor(model, seg, hour)
    const money: Money = saved
      ? { readUsd: saved.readUsd, writeUsd: saved.writeUsd, pricedRequests: seg.requests, unpricedRequests: 0, freeRequests: saved.free ? seg.requests : 0 }
      : { ...emptyMoney(), unpricedRequests: seg.requests }
    if (!saved) unpricedModels.add(model)
    fold(total, seg, money)
    fold(into(buckets, bucket), seg, money)
    const m = into(models, model)
    fold(m, seg, money)
    ;(m.dialects ??= new Set()).add(dialect)
    fold(into(clients, String(row.c || 'legacy-unknown')), seg, money)
  }

  const over = new Map(input.overCeiling.map((row) => [String(row.m), num(row.n)]))
  const overTotal = [...over.entries()].filter(([model]) => models.has(model)).reduce((sum, [, n]) => sum + n, 0)
  const byPrompt = <T extends CacheStat & { id: string }>(a: T, b: T) => b.promptTokens - a.promptTokens || b.requests - a.requests || a.id.localeCompare(b.id)

  const trend: CacheSummary['trend'] = []
  for (let index = plan.first; index <= plan.last; index += 1) {
    const entry = buckets.get(index) ?? acc()
    trend.push({ t: bucketStart(plan, index), ...finish(entry.seg, entry.money) })
  }

  const totalStat = finish(total.seg, total.money)
  const priced = total.money.pricedRequests
  return {
    days: scope.days,
    from: new Date(plan.fromMs).toISOString(),
    to: new Date(plan.toMs).toISOString(),
    bucketMs: plan.bucketMs,
    timeZone: input.timeZone,
    filters: { keyId: scope.keyId, model: scope.model, client: scope.client, provider: scope.provider, currentOnly: Boolean(scope.currentOnly) },
    basis: '命中 = 缓存读 ÷ (新输入 + 缓存读 + 缓存写) · 只计支持缓存的模型',
    ceiling: CACHE_WRITE_CEILING,
    capability: {
      evidenceDays: Math.max(scope.days, CAPABILITY_EVIDENCE_DAYS),
      rule: `价格表有缓存读折扣，或近 ${Math.max(scope.days, CAPABILITY_EVIDENCE_DAYS)} 天出现过缓存读写`,
    },
    totals: {
      ...totalStat,
      overCeilingRequests: overTotal,
      savings: {
        netUsd: totalStat.savingsUsd,
        readUsd: priced > 0 ? total.money.readUsd : null,
        writeUsd: priced > 0 ? total.money.writeUsd : null,
        pricedRequests: priced,
        unpricedRequests: total.money.unpricedRequests,
        unpricedModels: unpricedModels.size,
        free: priced > 0 && total.money.freeRequests === priced,
        approx: true,
      },
    },
    excluded: {
      models: excluded.size,
      requests: [...excluded.values()].reduce((sum, n) => sum + n, 0),
      items: [...excluded.entries()]
        .map(([model, requests]) => ({ model, requests }))
        .sort((a, b) => b.requests - a.requests || a.model.localeCompare(b.model))
        .slice(0, 50),
    },
    trend,
    byModel: [...models.entries()]
      .map(([id, entry]) => ({
        id,
        label: id,
        dialect: (entry.dialects && entry.dialects.size === 1 ? [...entry.dialects][0] : 'mixed') as 'anthropic' | 'openai' | 'mixed',
        overCeilingRequests: over.get(id) ?? 0,
        ...finish(entry.seg, entry.money),
      }))
      .sort(byPrompt),
    byClient: [...clients.entries()]
      .map(([id, entry]) => ({ id, label: clientLabel(id), ...finish(entry.seg, entry.money) }))
      .sort(byPrompt),
    generatedAt: new Date(input.now).toISOString(),
  }
}

/** Prompt length of one raw event in the cache dialect of its channel (same rule as `normalizeTokens`). */
const PROMPT_SQL = `(CASE WHEN lower(trim(provider)) IN (${NATIVE_ANTHROPIC.map((p) => `'${p}'`).join(', ')})
  THEN input_tokens + cached_tokens + cache_write_tokens ELSE MAX(input_tokens, cached_tokens) END)`

/** End of the window: the end of the current hour, so the current hour's rollup row counts and later hours do not. */
export const windowEndMs = (now: number) => Math.floor(now / HOUR) * HOUR + HOUR

/**
 * Successful rollup rows in [fromMs, endMs), one per hour × model × channel × client. `+success` keeps the planner
 * on the hour-range indexes (`idx_uhr_hour*`) instead of `idx_uhr_cache (success, …)`, whose leading column
 * matches nearly every row and makes the cost grow with retained history.
 */
export function cacheRowsOperation(groups: ConsoleGroup[], scope: UsageScope, fromMs: number, endMs: number): ReadOperation {
  const rollup = scopeFilterSql(groups, scope, 'rollup')
  return {
    method: 'all',
    sql: `SELECT (hour_ms / ${HOUR}) * ${HOUR} h, ${canonicalModelSql()} m, lower(trim(provider)) p, client_type c,
        SUM(request_count) n, SUM(input_tokens) input, SUM(uncached_input_tokens) uncached,
        SUM(cached_tokens) cached, SUM(cache_write_tokens) cw
      FROM usage_hourly_rollup
      WHERE hour_ms >= ? AND hour_ms < ? AND +success = 1 AND ${rollup.sql}
      GROUP BY h, m, p, c`,
    params: [fromMs, endMs, ...rollup.params],
  }
}

/**
 * Capability evidence: models with any cache read / write on successful requests in the channel scope during the
 * max(days, 30) days before `anchorMs` (key and client filters deliberately ignored). The cutoff is floored to
 * the hour, so the rollup hour that holds the cutoff counts as a whole: evidence up to 59 minutes older than the
 * nominal window still counts (never less than the window).
 */
export function cacheEvidenceOperation(groups: ConsoleGroup[], scope: Pick<UsageScope, 'days' | 'currentOnly'>, anchorMs: number): ReadOperation {
  const active = scopedProviderPredicate(groups, 'provider', Boolean(scope.currentOnly))
  const evidenceFrom = Math.floor((anchorMs - Math.max(scope.days, CAPABILITY_EVIDENCE_DAYS) * DAY) / HOUR) * HOUR
  return {
    method: 'all',
    sql: `SELECT ${canonicalModelSql()} m
      FROM usage_hourly_rollup
      WHERE hour_ms >= ? AND hour_ms < ? AND +success = 1 AND ${active.sql}
      GROUP BY m
      HAVING SUM(cached_tokens) + SUM(cache_write_tokens) > 0`,
    params: [evidenceFrom, windowEndMs(anchorMs), ...active.params],
  }
}

export function cacheSummaryOperations(groups: ConsoleGroup[], scope: UsageScope, plan: BucketPlan, now: number): ReadOperation[] {
  const events = scopeFilterSql(groups, scope, 'events')
  const endMs = windowEndMs(now)
  // plan.fromMs is a whole hour (the workspace window), so `hour_ms >= from` and raw `timestamp_ms >= from` agree
  return [
    cacheRowsOperation(groups, scope, plan.fromMs, endMs),
    cacheEvidenceOperation(groups, scope, now),
    {
      method: 'all',
      sql: `SELECT ${canonicalModelSql()} m, COUNT(*) n
        FROM usage_events
        WHERE timestamp_ms >= ? AND timestamp_ms < ? AND success = 1 AND ${events.sql} AND ${PROMPT_SQL} > ${CACHE_WRITE_CEILING}
        GROUP BY m`,
      params: [plan.fromMs, endMs, ...events.params],
    },
  ]
}

export async function loadCacheSummary(reader: Reader, groups: ConsoleGroup[], scope: UsageScope, options: { timeZone: string; now?: number }) {
  const { plan, clock: now } = scopePlan(scope, options.now ?? Date.now(), options.timeZone)
  const [rows, evidence, overCeiling] = await reader.run(cacheSummaryOperations(groups, scope, plan, now))
  return buildCacheSummary({
    rows: rows as RollupRow[],
    evidence: (evidence as Array<{ m: string }>).map((row) => String(row.m)),
    overCeiling: overCeiling as Array<{ m: string; n: number }>,
    scope,
    plan,
    timeZone: options.timeZone,
    now,
  })
}

/** Admin-only by the global session guard. */
export function registerCacheSummaryRoutes(app: express.Express, deps: InsightRouteDeps) {
  // keys carry every filter value: bounded so filter browsing cannot grow the cache for the process lifetime
  const coordinator = new RequestCoordinator<CacheSummary>({ ttlMs: 20_000, staleWhileRevalidateMs: 5 * 60_000, maxEntries: 100 })
  app.get('/api/cache-summary', async (req, res) => {
    let scope: UsageScope
    try {
      scope = parseUsageScope(req.query as Record<string, unknown>, deps.retentionDays, { timeZone: deps.timeZone, now: deps.now?.() })
    } catch (error) {
      if (rejectBadFilter(error, res)) return
      throw error
    }
    try {
      const groups = await deps.groups()
      const key = JSON.stringify(['cache-summary:v2', scope, groupsKey(groups)])
      const payload = await coordinator.run(key, () => loadCacheSummary(deps.reader, groups, scope, { timeZone: deps.timeZone, now: deps.now?.() }))
      res.setHeader('Cache-Control', 'private, max-age=20, stale-while-revalidate=300')
      res.json(payload)
    } catch (error) {
      console.warn(`[cache-summary] 读取失败：${error instanceof Error ? error.message : '未知错误'}`)
      res.status(503).json({ error: '缓存报表暂时读不出来', code: 'report_unavailable' })
    }
  })
}
