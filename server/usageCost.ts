/**
 * Cost of usage rows whose requests carry no recorded `cost_usd` (unpriced at ingestion, or history not yet
 * backfilled by `scripts/backfill-cost.mjs`). Shared by the usage workspace and the key user's `/me` pages so
 * a total, its ranks and its days add up the same way.
 *
 * Rule: every recorded `cost_usd` is kept as is. Only the requests without one are estimated, at the price in
 * force in the hour they happened, with the long-context tier chosen by that slice's average prompt — the
 * request detail page prices one request the same way (one request per slice gives the same figure). A slice
 * whose model has no price is counted as unpriced, never priced at $0; a tokenless slice (failed before any
 * token) costs 0.
 *
 * Where the numbers come from (no new storage): `usage_hourly_rollup` rows with `cost_usd_count = 0` hold
 * exactly the tokens of their unledgered requests, priced at their hour. Two kinds of hour are re-read from the
 * NULL-cost events themselves (`uncostedEventsOperation`), still aggregated in SQL:
 * - a rollup row that is only partly ledgered (`0 < cost_usd_count < request_count`) mixes both — a model
 *   priced mid-hour, a partial backfill;
 * - the model has long-context tiers at that hour: an average prompt could pick the wrong tier, so the events
 *   are grouped by prompt band (which tier thresholds the prompt exceeds) and every request in a band gets the
 *   tier it would get alone.
 * Both are rare (cost_usd is written at ingestion with the tier for every model priced then).
 */
import { cacheDialectFor } from './cacheStats.js'
import { clientTypeSql } from './clientAgent.js'
import { canonicalModelSql } from './modelIdentity.js'
import { estimateCost, getModelPricing, getPriceHistory, pricedModelIds } from './pricing.js'
import type { ReadOperation } from './sqliteReadWorker.js'

const HOUR_MS = 3_600_000
/** More separate hour ranges than this are read as one envelope and filtered in JS. */
const MAX_RANGES = 64

export type CostPart = { usd: number | null; unpricedRequests: number; estimated: boolean }

/** Requests without a recorded cost, one hour × one set of row dimensions. `cc` is the ledgered count (0 or partial). */
export type UncostedRow = {
  h: number
  k: string
  m: string
  p: string
  c: string
  s: number
  sc: number
  ec: string
  n: number
  cc: number
  i: number
  ui: number
  o: number
  cr: number
  cw: number
  t: number
}

const num = (value: unknown) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

/** Estimate one slice of unledgered requests (see the module rule). */
export function estimateUncosted(slice: Pick<UncostedRow, 'h' | 'm' | 'p' | 'n' | 'i' | 'ui' | 'o' | 'cr' | 'cw' | 't'>): CostPart {
  const requests = num(slice.n)
  if (requests <= 0) return { usd: 0, unpricedRequests: 0, estimated: false }
  const tokens = num(slice.t) + num(slice.i) + num(slice.o) + num(slice.cr) + num(slice.cw)
  if (tokens <= 0) return { usd: 0, unpricedRequests: 0, estimated: false }
  const dialect = cacheDialectFor(String(slice.m || ''), { provider: String(slice.p || '') })
  const fresh = dialect === 'anthropic' ? num(slice.i) : num(slice.ui)
  const write = dialect === 'anthropic' ? num(slice.cw) : 0
  const prompt = fresh + num(slice.cr) + write
  const usd = estimateCost(String(slice.m || ''), fresh, num(slice.o), num(slice.cr), write, {
    at: num(slice.h) > 0 ? num(slice.h) : undefined,
    promptTokens: prompt / requests,
  })
  return usd === null ? { usd: null, unpricedRequests: requests, estimated: false } : { usd, unpricedRequests: 0, estimated: true }
}

/** The recorded part of an aggregated row: its ledger sum when any request has one, else nothing yet. */
export function ledgerPart(row: { n: number; cs: number; cc: number }): CostPart {
  const ledgered = num(row.cc)
  return { usd: ledgered > 0 || num(row.n) <= 0 ? num(row.cs) : null, unpricedRequests: 0, estimated: false }
}

/** Sum of parts: null only when no part has a value. */
export function addParts(parts: CostPart[]): CostPart {
  let usd = 0
  let priced = false
  let unpricedRequests = 0
  let estimated = false
  for (const part of parts) {
    if (part.usd !== null) {
      usd += part.usd
      priced = true
    }
    unpricedRequests += part.unpricedRequests
    if (part.estimated) estimated = true
  }
  return { usd: priced ? usd : null, unpricedRequests, estimated }
}

const tieredAt = (model: string, hourMs: number) => Boolean(getModelPricing(model, hourMs)?.tiers?.length)

/**
 * Hours (epoch ms of the hour start) whose NULL-cost events are read separately: a partly ledgered row, or an
 * unledgered row of a model with long-context tiers in force that hour.
 */
export function hoursNeedingEvents(rows: Array<Pick<UncostedRow, 'h' | 'm' | 'n' | 'cc' | 't' | 'i' | 'o' | 'cr' | 'cw'>>): number[] {
  const hours = new Set<number>()
  for (const row of rows) {
    const hour = num(row.h)
    if (hours.has(hour)) continue
    const partly = num(row.cc) > 0 && num(row.cc) < num(row.n)
    // tokenless = the same test as `estimateUncosted` (CPA may send total_tokens 0 with real input / output)
    const tokens = num(row.t) + num(row.i) + num(row.o) + num(row.cr) + num(row.cw)
    if (partly || (tokens > 0 && tieredAt(String(row.m || ''), hour))) hours.add(hour)
  }
  return [...hours].sort((a, b) => a - b)
}

/** Every long-context threshold any price card uses (now or in its history); integers, never user input. */
export function tierThresholds(): number[] {
  const values = new Set<number>()
  for (const model of pricedModelIds()) {
    for (const entry of getPriceHistory(model)) for (const tier of entry.tiers ?? []) if (Number.isFinite(tier.above) && tier.above >= 0) values.add(Math.trunc(tier.above))
  }
  return [...values].sort((a, b) => a - b)
}

/** Prompt of one event in its cache dialect (`normalizeTokens`: anthropic = three segments; else cached ⊂ input). */
const promptSql = (alias: string) => `(CASE WHEN lower(trim(${alias}.provider)) IN ('claude','claude-api-key','anthropic','anthropic-api-key')
  THEN ${alias}.input_tokens + ${alias}.cached_tokens + ${alias}.cache_write_tokens ELSE MAX(${alias}.input_tokens, ${alias}.cached_tokens) END)`

/**
 * Rollup rows (PK grain) with at least one unledgered request in [fromMs, endMs). `where` is a rollup predicate
 * over unaliased columns. `(hour_ms / 3600000) * 3600000` keeps the hour when the read worker rewrites a
 * missing rollup onto raw events.
 */
export function uncostedRollupOperation(where: { sql: string; params: ReadonlyArray<string | number> }, fromMs: number, endMs: number): ReadOperation {
  return {
    method: 'all',
    sql: `SELECT (hour_ms / ${HOUR_MS}) * ${HOUR_MS} h, key_hash k, ${canonicalModelSql()} m, lower(trim(provider)) p, client_type c,
        success s, status_code sc, error_category ec, request_count n, cost_usd_count cc,
        input_tokens i, uncached_input_tokens ui, output_tokens o, cached_tokens cr, cache_write_tokens cw, total_tokens t
      FROM usage_hourly_rollup
      WHERE hour_ms >= ? AND hour_ms < ? AND cost_usd_count < request_count AND ${where.sql}`,
    params: [fromMs, endMs, ...where.params],
  }
}

/**
 * NULL-cost events of the given hours, grouped like the rollup rows plus the prompt band (how many tier
 * thresholds the prompt exceeds), so a band's average prompt picks the same tier as each of its requests.
 * `where` is an events predicate written against the alias `u`. Many scattered hours are read as one envelope;
 * `resolveUncosted` keeps only the hours asked for.
 */
export function uncostedEventsOperation(where: { sql: string; params: ReadonlyArray<string | number> }, hours: number[]): ReadOperation | null {
  if (!hours.length) return null
  const ranges: Array<[number, number]> = []
  for (const hour of hours) {
    const last = ranges.at(-1)
    if (last && last[1] === hour) last[1] = hour + HOUR_MS
    else ranges.push([hour, hour + HOUR_MS])
  }
  const bounded = ranges.length > MAX_RANGES ? [[ranges[0][0], ranges.at(-1)![1]] as [number, number]] : ranges
  const thresholds = tierThresholds()
  const band = thresholds.length ? thresholds.map((above) => `(${promptSql('u')} > ${above})`).join(' + ') : '0'
  return {
    method: 'all',
    sql: `SELECT (u.timestamp_ms / ${HOUR_MS}) * ${HOUR_MS} h, COALESCE(u.key_hash, '') k, ${canonicalModelSql('u')} m,
        lower(trim(u.provider)) p, ${clientTypeSql('u')} c, u.success s, u.status_code sc, u.error_category ec,
        COUNT(*) n, 0 cc, COALESCE(SUM(u.input_tokens),0) i, COALESCE(SUM(MAX(u.input_tokens - u.cached_tokens, 0)),0) ui,
        COALESCE(SUM(u.output_tokens),0) o, COALESCE(SUM(u.cached_tokens),0) cr, COALESCE(SUM(u.cache_write_tokens),0) cw,
        COALESCE(SUM(u.total_tokens),0) t, ${band} band
      FROM usage_events u
      WHERE u.cost_usd IS NULL AND (${bounded.map(() => '(u.timestamp_ms >= ? AND u.timestamp_ms < ?)').join(' OR ')}) AND ${where.sql}
      GROUP BY h, k, m, p, c, s, sc, ec, band`,
    params: [...bounded.flat(), ...where.params],
  }
}

/**
 * The unledgered slices to price: whole rollup rows where nothing is ledgered, NULL-cost events for the hours
 * `hoursNeedingEvents` names. `events` is the result of `uncostedEventsOperation(…, hoursNeedingEvents(rollup))`.
 */
export function resolveUncosted(rollup: UncostedRow[], events: UncostedRow[] | null | undefined): UncostedRow[] {
  const mixed = new Set(hoursNeedingEvents(rollup))
  const normalize = (row: UncostedRow): UncostedRow => ({ ...row, k: String(row.k ?? ''), m: String(row.m ?? ''), p: String(row.p ?? ''), c: String(row.c ?? '') })
  const out = rollup.filter((row) => !mixed.has(num(row.h))).map(normalize)
  for (const row of events ?? []) if (mixed.has(num(row.h))) out.push(normalize(row))
  return out
}
