/**
 * `GET /api/overview?range=1h|6h|24h` — the admin 概览 page's gateway scope, per-channel health strips and
 * per-Key 24h micro-bars (Console v3 DESIGN §6.2, CONTRACTS "Change (overview)").
 *
 * Read-only. The population is every request the gateway logged in the local `usage_events` ingest table —
 * the same population as `/api/pulse`, the header trace and (since 2026-10-02) the default all-channel scope of
 * the usage reports. Channel rows of providers that are no longer current carry `removed: true`.
 * Per-Key hours come from the existing `usage_hourly_rollup` (one row per hour × key × …), so the 24h strip
 * is a cheap indexed read. Nothing here calls an upstream, and results are cached per range for a few
 * seconds so N open dashboards cost one query burst per TTL.
 *
 * Windows: `1h` / `6h` are rolling and end at now − 2 s (live telemetry). `24h` uses the usage ledger's window —
 * from the first whole hour after now − 24 h (`usageWorkspaceWindow(1)`, the same as `/api/dashboard?days=1`
 * and the 03 近 24 小时 plate) up to now, no lag, 24 hour buckets with the current one partial — so the dashboard
 * never shows two different "24h" request counts. Latency percentiles (nearest rank, computed in SQL) count only requests that
 * reported a duration: `latency_ms` / `ttft_ms` = 0 means "not reported", as on the 性能 tab. Channel rows are
 * keyed by the channel id (`openai-compatible-x` folds into `x`), so one channel is never split in two.
 */
import type express from 'express'
import { isActiveProvider } from './currentChannels.js'
import type { ConsoleGroup } from './groups.js'
import type { ReadOperation } from './sqliteReadWorker.js'
import { usageWorkspaceWindow } from './usageReports.js'

export type OverviewRange = '1h' | '6h' | '24h'

/**
 * One sample is one whole unit (1 min / 1 min / 1 h) so a scope cursor reads `−12m` / `−3h` directly.
 * 6h at one-minute resolution is 360 samples, sent as parallel arrays (≈5 KB).
 */
export const OVERVIEW_RANGES: Record<OverviewRange, { spanMs: number; bucketMs: number; ttlMs: number }> = {
  '1h': { spanMs: 3_600_000, bucketMs: 60_000, ttlMs: 5_000 },
  '6h': { spanMs: 6 * 3_600_000, bucketMs: 60_000, ttlMs: 15_000 },
  '24h': { spanMs: 24 * 3_600_000, bucketMs: 3_600_000, ttlMs: 30_000 },
}
/** Channel health: 36 ticks × 5 min = the last 3 hours. */
export const CHANNEL_SPAN_MS = 3 * 3_600_000
export const CHANNEL_BUCKET_MS = 5 * 60_000
const HOUR_MS = 3_600_000
const KEY_HOURS = 24
const SIDE_TTL_MS = 15_000
/** Usage rows land after the collector's next tick; the newest seconds are always incomplete (as /api/pulse). */
export const OVERVIEW_LAG_MS = 2_000

export type OverviewReader = { run(operations: readonly ReadOperation[]): Promise<unknown[]> }


export type OverviewPayload = {
  range: OverviewRange
  spanMs: number
  bucketMs: number
  /** window [from, to) in epoch ms; buckets oldest first. 1h/6h: rolling, to = now − 2 s; 24h: from the first whole hour after now − 24h, to = now */
  from: number
  to: number
  gateway: {
    /** per bucket, oldest first; bucket i starts at `from + i × bucketMs` */
    series: { requests: number[]; errors: number[]; p95Ms: Array<number | null> }
    requests: number
    errors: number
    /** null when the window has no requests (never a fake 0%) */
    successRate: number | null
    /** busiest bucket as requests/min, with the bucket's start time */
    peak: { rpm: number; at: number } | null
    /** nearest-rank percentiles over successful requests */
    p50Ms: number | null
    p95Ms: number | null
    /** time to first token, successful requests that reported one */
    ttftP50Ms: number | null
    /** distinct Keys with at least one request in the window */
    activeKeys: number
  }
  channels: {
    spanMs: number
    bucketMs: number
    from: number
    to: number
    rows: Array<{
      /** raw usage provider, lower-cased (`openai-compatible-openrouter`, `codex`); the busiest spelling when aliases fold */
      provider: string
      /** short channel name (`openrouter`) — matches /api/channels names for compat channels */
      name: string
      requests: number
      errors: number
      p95Ms: number | null
      /** per 5-min bucket, oldest first */
      ticks: number[]
      bad: number[]
      lastAt: number | null
      /** the provider is no longer a current channel (shown as 已移除); null = channel list unreadable / not asked */
      removed?: boolean | null
    }>
  }
  keys: {
    bucketMs: number
    /** start of the oldest hour; the last bucket is the current (partial) hour */
    from: number
    rows: Array<{ id: string; requests: number[]; errors: number[]; total: number; totalErrors: number }>
  }
  generatedAt: string
}

type Row = Record<string, unknown>
const num = (value: unknown): number => {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

/** Nearest-rank percentile of a list sorted ascending; null when empty. */
export function percentile(sorted: readonly number[], p: number): number | null {
  if (!sorted.length) return null
  const rank = Math.max(1, Math.ceil(sorted.length * p))
  return sorted[Math.min(sorted.length, rank) - 1]
}

export function shortChannelName(provider: string): string {
  const value = provider.trim().toLowerCase()
  return value.startsWith('openai-compatible-') ? value.slice('openai-compatible-'.length) : value || 'unknown'
}

export function parseOverviewRange(raw: unknown): OverviewRange | null {
  if (raw === undefined || raw === null || raw === '') return '1h'
  const value = String(Array.isArray(raw) ? raw[0] : raw)
  return Object.hasOwn(OVERVIEW_RANGES, value) ? (value as OverviewRange) : null
}

/** Channel id of a usage row in SQL: lower-cased, `openai-compatible-x` → `x`, empty → `unknown` (= shortChannelName). */
const CHANNEL_SQL = `(CASE WHEN trim(provider) = '' THEN 'unknown'
  WHEN lower(trim(provider)) LIKE 'openai-compatible-%' THEN substr(lower(trim(provider)), ${'openai-compatible-'.length + 1})
  ELSE lower(trim(provider)) END)`

/** `(n + 1) / 2` and `(95 * n + 99) / 100` are the integer ⌈0.5n⌉ and ⌈0.95n⌉ (nearest rank, as `percentile`). */
const P50 = (rank: string, count: string) => `MAX(CASE WHEN ${rank} = (${count} + 1) / 2 THEN v END)`
const P95 = (rank: string, count: string) => `MAX(CASE WHEN ${rank} = (95 * ${count} + 99) / 100 THEN v END)`

function bucketOps(start: number, end: number, bucketMs: number): ReadOperation[] {
  return [
    {
      method: 'all',
      sql: `SELECT CAST((timestamp_ms - ?) / ? AS INTEGER) AS b, COUNT(*) AS n,
          SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) AS e
        FROM usage_events WHERE timestamp_ms >= ? AND timestamp_ms < ? GROUP BY b`,
      params: [start, bucketMs, start, end],
    },
    {
      // window p50 / p95 (b = -1) and per-bucket p95 over successful requests that reported a latency
      method: 'all',
      sql: `WITH base AS (
          SELECT CAST((timestamp_ms - ?) / ? AS INTEGER) AS b, latency_ms AS v FROM usage_events
          WHERE success = 1 AND latency_ms > 0 AND timestamp_ms >= ? AND timestamp_ms < ?
        ), r AS (
          SELECT b, v, ROW_NUMBER() OVER (ORDER BY v) ra, COUNT(*) OVER () ca,
            ROW_NUMBER() OVER (PARTITION BY b ORDER BY v) rb, COUNT(*) OVER (PARTITION BY b) cb
          FROM base
        )
        SELECT -1 AS b, MAX(ca) AS n, ${P50('ra', 'ca')} AS p50, ${P95('ra', 'ca')} AS p95 FROM r
        UNION ALL SELECT b, MAX(cb), NULL, ${P95('rb', 'cb')} FROM r GROUP BY b`,
      params: [start, bucketMs, start, end],
    },
    {
      method: 'get',
      sql: `SELECT MAX(c) AS n, ${P50('r', 'c')} AS p50 FROM (
          SELECT ttft_ms AS v, ROW_NUMBER() OVER (ORDER BY ttft_ms) r, COUNT(*) OVER () c FROM usage_events
          WHERE success = 1 AND ttft_ms > 0 AND timestamp_ms >= ? AND timestamp_ms < ?
        )`,
      params: [start, end],
    },
    {
      method: 'get',
      sql: `SELECT COUNT(DISTINCT key_hash) AS k FROM usage_events
        WHERE timestamp_ms >= ? AND timestamp_ms < ? AND key_hash IS NOT NULL AND key_hash != ''`,
      params: [start, end],
    },
  ]
}

const positiveOrNull = (value: unknown): number | null => {
  const n = Number(value)
  return value !== null && value !== undefined && Number.isFinite(n) && n > 0 ? n : null
}

/** Window start of a range at `at`: 24h = the ledger's whole-hour cut, else rolling from `end`. */
export function overviewStart(range: OverviewRange, at: number, end: number): number {
  return range === '24h' ? usageWorkspaceWindow(1, at).fromMs : end - OVERVIEW_RANGES[range].spanMs
}

export function buildGateway(
  range: OverviewRange,
  start: number,
  end: number,
  counts: Row[],
  latencies: Row[],
  ttft: Row | undefined,
  activeKeys: number,
): Pick<OverviewPayload, 'range' | 'spanMs' | 'bucketMs' | 'from' | 'to' | 'gateway'> {
  const { spanMs, bucketMs } = OVERVIEW_RANGES[range]
  const n = Math.round(spanMs / bucketMs)
  const series: OverviewPayload['gateway']['series'] = { requests: Array(n).fill(0), errors: Array(n).fill(0), p95Ms: Array(n).fill(null) }
  let requests = 0
  let errors = 0
  for (const row of counts) {
    const b = num(row.b)
    if (b < 0 || b >= n) continue
    series.requests[b] += num(row.n)
    series.errors[b] += num(row.e)
    requests += num(row.n)
    errors += num(row.e)
  }
  let p50Ms: number | null = null
  let p95Ms: number | null = null
  for (const row of latencies) {
    const b = num(row.b)
    if (b === -1) {
      p50Ms = positiveOrNull(row.p50)
      p95Ms = positiveOrNull(row.p95)
    } else if (b >= 0 && b < n) {
      series.p95Ms[b] = positiveOrNull(row.p95)
    }
  }
  let busiest = -1
  for (let i = 0; i < series.requests.length; i += 1) {
    if (series.requests[i] > 0 && (busiest < 0 || series.requests[i] > series.requests[busiest])) busiest = i
  }
  const peak: OverviewPayload['gateway']['peak'] = busiest < 0
    ? null
    : { rpm: Math.round((series.requests[busiest] / (bucketMs / 60_000)) * 10) / 10, at: start + busiest * bucketMs }
  return {
    range,
    spanMs,
    bucketMs,
    from: start,
    to: end,
    gateway: {
      series,
      requests,
      errors,
      successRate: requests > 0 ? (requests - errors) / requests : null,
      peak,
      p50Ms,
      p95Ms,
      ttftP50Ms: positiveOrNull(ttft?.p50),
      activeKeys,
    },
  }
}

/**
 * `counts` rows: `{ ch, p, b, n, e, last }` (ch = channel id, p = raw lower-cased provider); `latencies` rows:
 * `{ ch, p95 }`. One row per channel id, so `x` and `openai-compatible-x` are one channel.
 */
export function buildChannels(end: number, counts: Row[], latencies: Row[]): OverviewPayload['channels'] {
  const start = end - CHANNEL_SPAN_MS
  const n = CHANNEL_SPAN_MS / CHANNEL_BUCKET_MS
  const rows = new Map<string, OverviewPayload['channels']['rows'][number] & { spellings: Map<string, number> }>()
  const rowFor = (id: string) => {
    let row = rows.get(id)
    if (!row) {
      row = { provider: id, name: id, requests: 0, errors: 0, p95Ms: null, ticks: Array(n).fill(0), bad: Array(n).fill(0), lastAt: null, spellings: new Map() }
      rows.set(id, row)
    }
    return row
  }
  for (const r of counts) {
    const b = num(r.b)
    if (b < 0 || b >= n) continue
    const provider = String(r.p ?? '').trim().toLowerCase() || 'unknown'
    const row = rowFor(String(r.ch ?? '') || shortChannelName(provider))
    row.ticks[b] += num(r.n)
    row.bad[b] += num(r.e)
    row.requests += num(r.n)
    row.errors += num(r.e)
    row.spellings.set(provider, (row.spellings.get(provider) ?? 0) + num(r.n))
    const last = num(r.last)
    if (last && (row.lastAt === null || last > row.lastAt)) row.lastAt = last
  }
  for (const r of latencies) {
    const row = rows.get(String(r.ch ?? ''))
    if (row) row.p95Ms = positiveOrNull(r.p95)
  }
  return {
    spanMs: CHANNEL_SPAN_MS,
    bucketMs: CHANNEL_BUCKET_MS,
    from: start,
    to: end,
    rows: [...rows.values()]
      .map(({ spellings, ...row }) => ({
        ...row,
        provider: [...spellings].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? row.provider,
      }))
      .sort((a, b) => b.requests - a.requests || a.name.localeCompare(b.name)),
  }
}

export function buildKeys(now: number, rows: Row[]): OverviewPayload['keys'] {
  const from = Math.floor(now / HOUR_MS) * HOUR_MS - (KEY_HOURS - 1) * HOUR_MS
  const fromHour = from / HOUR_MS
  const byKey = new Map<string, OverviewPayload['keys']['rows'][number]>()
  for (const r of rows) {
    const id = String(r.k ?? '')
    const i = num(r.h) - fromHour
    if (!id || i < 0 || i >= KEY_HOURS) continue
    let entry = byKey.get(id)
    if (!entry) {
      entry = { id, requests: Array(KEY_HOURS).fill(0), errors: Array(KEY_HOURS).fill(0), total: 0, totalErrors: 0 }
      byKey.set(id, entry)
    }
    entry.requests[i] += num(r.n)
    entry.errors[i] += num(r.e)
    entry.total += num(r.n)
    entry.totalErrors += num(r.e)
  }
  return { bucketMs: HOUR_MS, from, rows: [...byKey.values()].sort((a, b) => b.total - a.total || a.id.localeCompare(b.id)) }
}

type Cached<T> = { at: number; value: Promise<T> }

export function createOverviewReader(reader: OverviewReader, now: () => number = Date.now) {
  const byRange = new Map<OverviewRange, Cached<ReturnType<typeof buildGateway>>>()
  let side: Cached<Pick<OverviewPayload, 'channels' | 'keys'>> | null = null

  function fresh<T>(entry: Cached<T> | null | undefined, ttl: number, at: number): entry is Cached<T> {
    return Boolean(entry && at - entry.at < ttl && at >= entry.at)
  }

  function gateway(range: OverviewRange, at: number) {
    const hit = byRange.get(range)
    if (fresh(hit, OVERVIEW_RANGES[range].ttlMs, at)) return hit.value
    // 24h is the ledger window [cut, now): the ledger has no lag, so neither does this count (1h / 6h stay lagged)
    const end = range === '24h' ? at : at - OVERVIEW_LAG_MS
    const start = overviewStart(range, at, end)
    const { bucketMs } = OVERVIEW_RANGES[range]
    const value = reader.run(bucketOps(start, end, bucketMs)).then(([counts, latencies, ttft, keys]) =>
      buildGateway(range, start, end, counts as Row[], latencies as Row[], ttft as Row | undefined, num((keys as Row | undefined)?.k)))
    byRange.set(range, { at, value })
    value.catch(() => byRange.delete(range))
    return value
  }

  function sides(at: number) {
    if (fresh(side, SIDE_TTL_MS, at)) return side.value
    const end = at - OVERVIEW_LAG_MS
    const start = end - CHANNEL_SPAN_MS
    const keyFrom = Math.floor(at / HOUR_MS) * HOUR_MS - (KEY_HOURS - 1) * HOUR_MS
    const value = reader.run([
      {
        method: 'all',
        sql: `SELECT ${CHANNEL_SQL} AS ch, lower(trim(provider)) AS p, CAST((timestamp_ms - ?) / ? AS INTEGER) AS b, COUNT(*) AS n,
            SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) AS e, MAX(timestamp_ms) AS last
          FROM usage_events WHERE timestamp_ms >= ? AND timestamp_ms < ? GROUP BY ch, p, b`,
        params: [start, CHANNEL_BUCKET_MS, start, end],
      },
      {
        // per-channel nearest-rank p95 in SQL, over successful requests that reported a latency
        method: 'all',
        sql: `SELECT ch, ${P95('rn', 'c')} AS p95 FROM (
            SELECT ch, v, ROW_NUMBER() OVER (PARTITION BY ch ORDER BY v) rn, COUNT(*) OVER (PARTITION BY ch) c
            FROM (SELECT ${CHANNEL_SQL} AS ch, latency_ms AS v FROM usage_events
              WHERE success = 1 AND latency_ms > 0 AND timestamp_ms >= ? AND timestamp_ms < ?)
          ) GROUP BY ch`,
        params: [start, end],
      },
      {
        // hour index computed from hour_ms so the read worker's no-rollup fallback (hour_ms → timestamp_ms)
        // still lands each event in its hour
        method: 'all',
        sql: `SELECT key_hash AS k, CAST(hour_ms / ${HOUR_MS} AS INTEGER) AS h, SUM(request_count) AS n,
            SUM(CASE WHEN success = 0 THEN request_count ELSE 0 END) AS e
          FROM usage_hourly_rollup WHERE hour_ms >= ? AND key_hash != '' GROUP BY k, h`,
        params: [keyFrom],
      },
    ]).then(([channelCounts, channelLatencies, keyRows]) => ({
      channels: buildChannels(end, channelCounts as Row[], channelLatencies as Row[]),
      keys: buildKeys(at, keyRows as Row[]),
    }))
    side = { at, value }
    value.catch(() => { side = null })
    return value
  }

  return {
    async read(range: OverviewRange): Promise<OverviewPayload> {
      const at = now()
      const [g, s] = await Promise.all([gateway(range, at), sides(at)])
      return { ...g, ...s, generatedAt: new Date(at).toISOString() }
    },
  }
}

/** Marks channel rows whose provider is no longer a current channel. The counts themselves never depend on it. */
export function markRemovedChannels(payload: OverviewPayload, groups: ConsoleGroup[] | null): OverviewPayload {
  return {
    ...payload,
    channels: {
      ...payload.channels,
      rows: payload.channels.rows.map((row) => ({ ...row, removed: groups ? !isActiveProvider(row.provider, groups) : null })),
    },
  }
}

export function registerOverviewRoutes(app: express.Express, deps: { reader: OverviewReader; groups?: () => Promise<ConsoleGroup[]> }) {
  const overview = createOverviewReader(deps.reader)
  app.get('/api/overview', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    const range = parseOverviewRange(req.query.range)
    if (!range) return void res.status(400).json({ error: '时间范围只能是 1h、6h 或 24h', code: 'invalid_range' })
    try {
      const payload = await overview.read(range)
      const groups = deps.groups ? await deps.groups().catch(() => null) : null
      res.json(markRemovedChannels(payload, groups))
    } catch {
      // fixed text: a raw DB / worker error message is not for the browser
      res.status(503).json({ error: '概览数据暂不可用', code: 'overview_unavailable' })
    }
  })
}
