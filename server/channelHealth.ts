/**
 * `GET /api/channel-health?hours=3|24|168` — per-channel health for the /channels page (DESIGN §6.4).
 *
 * Read-only and additive. Nothing here calls an upstream:
 * - traffic figures come from the local `usage_events` ingest table through the existing reporting read pool
 *   (worker connection, so a 7-day scan never blocks the event loop);
 * - "last discovery" comes from the model-discovery job's persisted state in the sync registry
 *   (`DiscoveryState.channels[name]` / `.hosts[host]`, written by `syncUpstreamModels`).
 *
 * Channel ↔ usage mapping follows `currentChannels.ts`: a compat channel `x` records usage either as `x` or as
 * `openai-compatible-x`, compared case-insensitively. Usage rows are history; they never create a channel —
 * the channel list is the caller's (`listChannels()`, the same loader `/api/channels` uses).
 *
 * Definitions (stated once, so the page and any later consumer agree):
 * - requests / errors / successRate: every usage row in [now − hours, now); successRate = ok / all, null when 0.
 *   `clientCancelled` is the subset of errors the caller caused (`error_category = client_cancelled`, HTTP 499):
 *   still counted in errors (same 失败 as every other page), but never a reason to call the upstream unhealthy.
 * - p95Ms: nearest-rank 95th percentile of `latency_ms` over successful rows in the window (same rule as
 *   `/api/pulse`); null when there were no successes.
 * - recent: the same counts over the last hour.
 * - slots: HEALTH_SLOTS equal buckets across the window, oldest first; `n` = rows, `bad` = failures excluding
 *   client cancellations (the strip marks only what the upstream did).
 * - lastRequestAt / lastError: newest row / newest failure in the whole retained history (not windowed).
 */
import type express from 'express'
import { modelDiscoveryUrls } from './channelDiscovery.js'
import type { DiscoveryState } from './modelSync.js'
import { RequestCoordinator } from './requestCoordinator.js'
import type { ReadOperation } from './sqliteReadWorker.js'
import { sanitizeSyncError } from './syncRegistry.js'

export const HEALTH_WINDOW_HOURS = [3, 24, 168] as const
export const HEALTH_DEFAULT_HOURS = 24
export const HEALTH_SLOTS = 36
export const HEALTH_RECENT_MS = 60 * 60_000
const HOUR_MS = 60 * 60_000
const CACHE_MS = 15_000
const DETAIL_MAX = 200

export type HealthWindowHours = (typeof HEALTH_WINDOW_HOURS)[number]

type Reader = { run(operations: readonly ReadOperation[]): Promise<unknown[]> }

/** The fields this module needs from `listChannels()` (ChannelView). */
export type HealthChannelInput = { name: string; baseUrl: string; enabled: boolean }

export type ChannelDiscoveryView = {
  lastProbeAt: string | null
  nextProbeAt: string | null
  /** HTTP status of the last probe; null for network errors / never probed */
  lastStatus: number | null
  /** `http_401` · `network` · `no_models` · `credential_unavailable` · `invalid_base_url` · null */
  lastError: string | null
  /** model ids the upstream returned on the last successful probe */
  discovered: number | null
  /** the channel's upstream host is in discovery backoff until then (future only) */
  hostBackoffUntil: string | null
}

export type ChannelHealthItem = {
  name: string
  enabled: boolean
  requests: number
  errors: number
  clientCancelled: number
  successRate: number | null
  p95Ms: number | null
  recent: { requests: number; errors: number; clientCancelled: number }
  slots: Array<{ n: number; bad: number }>
  lastRequestAt: string | null
  lastError: { at: string; status: number | null; category: string | null; detail: string | null } | null
  /** null = the discovery job keeps no state for this channel (disabled, no base URL, or never scheduled) */
  discovery: ChannelDiscoveryView | null
}

export type ChannelHealthPayload = {
  hours: number
  from: string
  to: string
  slotMs: number
  recentMs: number
  channels: ChannelHealthItem[]
  generatedAt: string
}

export function parseHealthHours(raw: unknown): HealthWindowHours | null {
  if (raw === undefined || raw === null || raw === '') return HEALTH_DEFAULT_HOURS
  const value = Number(raw)
  return (HEALTH_WINDOW_HOURS as readonly number[]).includes(value) ? (value as HealthWindowHours) : null
}

/** Lower-case usage `provider` values that belong to a channel (mirrors `activeProviderValues` for compat). */
export function providerAliases(name: string): string[] {
  const id = String(name || '').trim().toLowerCase()
  if (!id) return []
  const prefix = 'openai-compatible-'
  return id.startsWith(prefix) ? [id, id.slice(prefix.length)] : [id, `${prefix}${id}`]
}

const iso = (value: unknown): string | null => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? new Date(value).toISOString() : null)
const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : Number(value) || 0)
const COUNTS = `COUNT(*) n, SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) err,
  SUM(CASE WHEN success = 0 AND error_category = 'client_cancelled' THEN 1 ELSE 0 END) cxl`
const marks = (count: number) => Array.from({ length: count }, () => '?').join(', ')

function discoveryView(state: DiscoveryState | null, channel: HealthChannelInput, now: number): ChannelDiscoveryView | null {
  const entry = state?.channels?.[channel.name]
  if (!entry) return null
  let hostBackoffUntil: string | null = null
  try {
    const host = new URL(modelDiscoveryUrls('openai', channel.baseUrl)[0]).host
    const until = state?.hosts?.[host]?.backoffUntil
    if (typeof until === 'number' && until > now) hostBackoffUntil = iso(until)
  } catch {
    // an invalid base URL is reported by the probe itself (`lastError: invalid_base_url`)
  }
  return {
    lastProbeAt: iso(entry.lastProbeAt),
    nextProbeAt: iso(entry.nextProbeAt),
    lastStatus: typeof entry.lastStatus === 'number' ? entry.lastStatus : null,
    lastError: typeof entry.lastError === 'string' && entry.lastError ? entry.lastError : null,
    discovered: typeof entry.discovered === 'number' ? entry.discovered : null,
    hostBackoffUntil,
  }
}

function cleanDetail(raw: unknown): string | null {
  const text = sanitizeSyncError(String(raw ?? '')).replace(/\s+/g, ' ').trim()
  return text ? text.slice(0, DETAIL_MAX) : null
}

/**
 * Builds and runs the read batch. Exported for tests (pass an in-memory reader); the route goes through
 * `createChannelHealthService`, which adds caching and single-flight.
 */
export async function loadChannelHealth(
  reader: Reader,
  channels: readonly HealthChannelInput[],
  discovery: DiscoveryState | null,
  hours: HealthWindowHours,
  now = Date.now(),
): Promise<ChannelHealthPayload> {
  const to = now
  const from = to - hours * HOUR_MS
  const slotMs = Math.round((hours * HOUR_MS) / HEALTH_SLOTS)
  const recentFrom = to - HEALTH_RECENT_MS

  // alias → channel; the first channel claiming an alias keeps it (same-name compat duplicates cannot exist)
  const owner = new Map<string, string>()
  const aliasesOf = new Map<string, string[]>()
  for (const channel of channels) {
    const own: string[] = []
    for (const alias of providerAliases(channel.name)) {
      if (owner.has(alias)) continue
      owner.set(alias, channel.name)
      own.push(alias)
    }
    aliasesOf.set(channel.name, own)
  }
  const all = [...owner.keys()]

  const items = new Map<string, ChannelHealthItem>()
  for (const channel of channels) {
    if (items.has(channel.name)) continue
    items.set(channel.name, {
      name: channel.name,
      enabled: channel.enabled,
      requests: 0,
      errors: 0,
      clientCancelled: 0,
      successRate: null,
      p95Ms: null,
      recent: { requests: 0, errors: 0, clientCancelled: 0 },
      slots: Array.from({ length: HEALTH_SLOTS }, () => ({ n: 0, bad: 0 })),
      lastRequestAt: null,
      lastError: null,
      discovery: discoveryView(discovery, channel, now),
    })
  }

  if (all.length) {
    // One CASE maps every alias to its channel, so grouping happens per channel inside SQLite.
    const caseParams: string[] = []
    const cases = [...aliasesOf].filter(([, list]) => list.length).map(([name, list]) => {
      caseParams.push(...list, name)
      return `WHEN lower(trim(provider)) IN (${marks(list.length)}) THEN ?`
    })
    const channelExpr = `(CASE ${cases.join(' ')} END)`
    const inAll = `lower(trim(provider)) IN (${marks(all.length)})`
    const named = [...aliasesOf].filter(([, list]) => list.length)

    const operations: ReadOperation[] = [
      {
        method: 'all',
        sql: `SELECT ${channelExpr} c, ${COUNTS}
          FROM usage_events WHERE timestamp_ms >= ? AND timestamp_ms < ? AND ${inAll} GROUP BY c`,
        params: [...caseParams, from, to, ...all],
      },
      {
        method: 'all',
        sql: `SELECT ${channelExpr} c, ${COUNTS}
          FROM usage_events WHERE timestamp_ms >= ? AND timestamp_ms < ? AND ${inAll} GROUP BY c`,
        params: [...caseParams, recentFrom, to, ...all],
      },
      {
        method: 'all',
        // node:sqlite binds JS numbers as REAL, so the bucket index is cast back to an integer
        sql: `SELECT ${channelExpr} c, CAST((timestamp_ms - ?) / ? AS INTEGER) slot, ${COUNTS}
          FROM usage_events WHERE timestamp_ms >= ? AND timestamp_ms < ? AND ${inAll} GROUP BY c, slot`,
        params: [...caseParams, from, slotMs, from, to, ...all],
      },
      {
        // nearest-rank p95 per channel over successful rows that reported a latency (rank = ceil(0.95·n), integer
        // arithmetic); latency_ms = 0 means "not reported" (the 性能 / pulse rule), not a measured 0 ms
        method: 'all',
        sql: `SELECT c, v FROM (
            SELECT c, v, ROW_NUMBER() OVER (PARTITION BY c ORDER BY v) rn, COUNT(*) OVER (PARTITION BY c) n
            FROM (SELECT ${channelExpr} c, latency_ms v FROM usage_events
              WHERE success = 1 AND latency_ms > 0 AND timestamp_ms >= ? AND timestamp_ms < ? AND ${inAll})
          ) WHERE rn = MAX(1, (n * 95 + 99) / 100)`,
        params: [...caseParams, from, to, ...all],
      },
      // Newest row per channel: the hourly rollup (hundreds of rows) finds the hour, then a one-hour index range
      // on usage_events pins the millisecond — no full scan for channels that went quiet long ago.
      ...named.map(([, list]): ReadOperation => ({
        method: 'get',
        sql: `SELECT MAX(timestamp_ms) last FROM usage_events
          WHERE timestamp_ms >= (SELECT MAX(hour_ms) FROM usage_hourly_rollup WHERE lower(trim(provider)) IN (${marks(list.length)}))
            AND timestamp_ms < ? AND lower(trim(provider)) IN (${marks(list.length)})`,
        params: [...list, to, ...list],
      })),
      // Newest failure per channel: walks idx_usage_success_timestamp_ms newest-first.
      ...named.map(([, list]): ReadOperation => ({
        method: 'get',
        sql: `SELECT timestamp_ms at, status_code status, error_category category, substr(error_detail, 1, 600) detail
          FROM usage_events WHERE success = 0 AND timestamp_ms < ? AND lower(trim(provider)) IN (${marks(list.length)})
          ORDER BY timestamp_ms DESC LIMIT 1`,
        params: [to, ...list],
      })),
    ]

    const results = await reader.run(operations)
    const [windowRows, recentRows, slotRows, p95Rows] = results as Array<Array<Record<string, unknown>>>
    for (const row of windowRows ?? []) {
      const item = items.get(String(row.c))
      if (!item) continue
      item.requests = num(row.n)
      item.errors = num(row.err)
      item.clientCancelled = num(row.cxl)
      item.successRate = item.requests > 0 ? (item.requests - item.errors) / item.requests : null
    }
    for (const row of recentRows ?? []) {
      const item = items.get(String(row.c))
      if (item) item.recent = { requests: num(row.n), errors: num(row.err), clientCancelled: num(row.cxl) }
    }
    for (const row of slotRows ?? []) {
      const item = items.get(String(row.c))
      const slot = num(row.slot)
      if (!item || slot < 0 || slot >= HEALTH_SLOTS) continue
      item.slots[slot] = { n: num(row.n), bad: Math.max(0, num(row.err) - num(row.cxl)) }
    }
    for (const row of p95Rows ?? []) {
      const item = items.get(String(row.c))
      if (item && row.v !== null && row.v !== undefined) item.p95Ms = num(row.v)
    }
    const tail = results.slice(4) as Array<Record<string, unknown> | undefined>
    named.forEach(([name], index) => {
      const item = items.get(name)
      if (!item) return
      const last = tail[index]
      item.lastRequestAt = iso(last?.last)
      const failure = tail[named.length + index]
      if (failure && failure.at !== null && failure.at !== undefined) {
        item.lastError = {
          at: iso(num(failure.at)) ?? new Date(0).toISOString(),
          status: typeof failure.status === 'number' && failure.status > 0 ? failure.status : null,
          category: typeof failure.category === 'string' && failure.category ? failure.category : null,
          detail: cleanDetail(failure.detail),
        }
      }
    })
  }

  return {
    hours,
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    slotMs,
    recentMs: HEALTH_RECENT_MS,
    channels: [...items.values()],
    generatedAt: new Date(now).toISOString(),
  }
}

export type ChannelHealthDeps = {
  reader: Reader
  listChannels: () => Promise<readonly HealthChannelInput[]>
  /** the model-discovery job's persisted state; defaults to the process sync registry */
  discovery?: () => DiscoveryState | null | Promise<DiscoveryState | null>
  now?: () => number
}

async function defaultDiscovery(): Promise<DiscoveryState | null> {
  const { syncRegistry } = await import('./syncRegistry.js')
  return syncRegistry.has('model-discovery') ? (syncRegistry.jobData('model-discovery') as DiscoveryState) : null
}

/** Which half failed: the channel list (control plane) or the local usage read. */
export class ChannelHealthError extends Error {
  readonly code: 'channels_unavailable' | 'health_unavailable'
  constructor(code: 'channels_unavailable' | 'health_unavailable', cause: unknown) {
    super(code === 'channels_unavailable' ? '读取渠道失败' : '读取渠道健康失败', { cause })
    this.name = 'ChannelHealthError'
    this.code = code
  }
}

/** 15 s cache + single-flight per (window, channel set): N open tabs cost one read batch per window. */
export function createChannelHealthService(deps: ChannelHealthDeps) {
  const coordinator = new RequestCoordinator<ChannelHealthPayload>({ ttlMs: CACHE_MS })
  const now = deps.now ?? Date.now
  return {
    async read(hours: HealthWindowHours): Promise<ChannelHealthPayload> {
      let channels: HealthChannelInput[]
      try {
        channels = (await deps.listChannels()).map(({ name, baseUrl, enabled }) => ({ name: String(name), baseUrl: String(baseUrl || ''), enabled: Boolean(enabled) }))
      } catch (error) {
        throw new ChannelHealthError('channels_unavailable', error)
      }
      // the key changes when a channel is added, removed, toggled or re-pointed, so the page never shows a stale set
      const key = `${hours}|${channels.map((c) => `${c.name}:${c.enabled ? 1 : 0}:${c.baseUrl}`).join(',')}`
      return coordinator.run(key, async () => {
        try {
          const discovery = await (deps.discovery ?? defaultDiscovery)()
          return await loadChannelHealth(deps.reader, channels, discovery ?? null, hours, now())
        } catch (error) {
          throw new ChannelHealthError('health_unavailable', error)
        }
      })
    },
  }
}

export function registerChannelHealthRoutes(app: express.Express, deps: ChannelHealthDeps) {
  const service = createChannelHealthService(deps)
  app.get('/api/channel-health', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    const hours = parseHealthHours(req.query.hours)
    if (hours === null) {
      return res.status(400).json({ error: `hours 只能是 ${HEALTH_WINDOW_HOURS.join(' / ')}`, code: 'invalid_hours' })
    }
    try {
      res.json(await service.read(hours))
    } catch (error) {
      const code = error instanceof ChannelHealthError ? error.code : 'health_unavailable'
      res.status(code === 'channels_unavailable' ? 502 : 503).json({ error: code === 'channels_unavailable' ? '读取渠道失败' : '读取渠道健康失败', code })
    }
  })
}
