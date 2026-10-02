/**
 * `GET /api/keys/activity` — per-Key traffic for the admin Key page (DESIGN §6.3): last-24h hourly bars,
 * a rolling 7-day total with 7 × 24h bars, top models, the main error kinds and the latest errors.
 *
 * Read-only and additive. Every number comes from the existing aggregates with the same channel scope as the
 * admin usage reports: ALL traffic of the Key by default, including channels that have since been removed (the
 * same population as `/api/me*` and the quota ledger); `?currentOnly=1` narrows to the current channels. The
 * window is the `usage_hourly_rollup` window `hour_ms >= now − 7d`, so the Key page, /usage and /me agree for
 * one Key. Spend is NOT here: the Key page reads it from the quota ledger in `/api/bootstrap` (`quotaState`).
 * Nothing calls an upstream; one computation per 15 s is shared by every open tab.
 */
import type express from 'express'
import { activeProviderValues, parseCurrentOnly, scopedProviderPredicate } from './currentChannels.js'
import type { ConsoleGroup } from './groups.js'
import { canonicalModelId, canonicalModelSql } from './modelIdentity.js'
import { RequestCoordinator } from './requestCoordinator.js'
import type { ReadOperation } from './sqliteReadWorker.js'

type Reader = {
  run(operations: readonly ReadOperation[]): Promise<unknown[]>
}

export const ACTIVITY_HOURS = 24
export const ACTIVITY_DAYS = 7
export const TOP_MODELS = 3
export const ERROR_KINDS = 3
export const RECENT_ERRORS = 5
const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS

export type KeyActivity = {
  id: string
  /** hourly buckets, oldest first; the last one is the current (partial) hour */
  h24: { requests: number[]; errors: number[] }
  d7: {
    requests: number
    errors: number
    tokens: number
    /** 7 rolling 24h buckets, oldest first; they sum to `requests` / `errors` */
    daily: Array<{ requests: number; errors: number }>
    topModels: Array<{ model: string; requests: number; tokens: number }>
    errorKinds: Array<{ status: number | null; category: string | null; count: number }>
  }
  recentErrors: Array<{ at: string; model: string; status: number | null; category: string | null }>
}

export type KeysActivityPayload = {
  /** provider scope of every count: `all` (default, removed channels included) or the opt-in `current_channels` */
  scope: 'all' | 'current_channels'
  hours: number
  /** start of the first hourly bucket */
  hourStart: string
  days: number
  /** start of the rolling 7-day window (= now − 7 × 24h) */
  since: string
  keys: KeyActivity[]
  generatedAt: string
}

type Row = Record<string, unknown>
const num = (value: unknown): number => {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}
const statusOrNull = (value: unknown): number | null => {
  const n = Number(value)
  return Number.isInteger(n) && n > 0 ? n : null
}
const textOrNull = (value: unknown): string | null => {
  const text = String(value ?? '').trim()
  return text ? text : null
}

/** Pure loader over any reader (the report read pool in production, a plain connection in tests). */
export async function loadKeysActivity(reader: Reader, groups: ConsoleGroup[], now = Date.now(), currentOnly = false): Promise<KeysActivityPayload> {
  const since = now - ACTIVITY_DAYS * DAY_MS
  const hourStart = Math.floor(now / HOUR_MS) * HOUR_MS - (ACTIVITY_HOURS - 1) * HOUR_MS
  const active = scopedProviderPredicate(groups, 'provider', currentOnly)
  const scoped = `key_hash != '' AND hour_ms >= ? AND ${active.sql}`
  const scopedParams = [since, ...active.params]
  const model = canonicalModelSql()

  const [keyRows, hourRows, modelRows, kindRows, errorRows] = await reader.run([
    { method: 'all', sql: 'SELECT key_hash k FROM api_keys ORDER BY key_hash', params: [] },
    {
      method: 'all',
      sql: `SELECT key_hash k, hour_ms h, SUM(request_count) n,
          SUM(CASE WHEN success=0 THEN request_count ELSE 0 END) e, COALESCE(SUM(total_tokens),0) t
        FROM usage_hourly_rollup WHERE ${scoped} GROUP BY key_hash, hour_ms`,
      params: scopedParams,
    },
    {
      method: 'all',
      sql: `SELECT key_hash k, ${model} m, SUM(request_count) n, COALESCE(SUM(total_tokens),0) t
        FROM usage_hourly_rollup WHERE ${scoped} GROUP BY key_hash, m`,
      params: scopedParams,
    },
    {
      method: 'all',
      sql: `SELECT key_hash k, status_code s, error_category c, SUM(request_count) n
        FROM usage_hourly_rollup WHERE ${scoped} AND success=0 GROUP BY key_hash, s, c`,
      params: scopedParams,
    },
    {
      // newest first per key; the (success, timestamp_ms) index bounds the scan to this window's failures
      method: 'all',
      sql: `SELECT k, ts, m, s, c FROM (
          SELECT key_hash k, timestamp_ms ts, ${model} m, status_code s, error_category c,
            ROW_NUMBER() OVER (PARTITION BY key_hash ORDER BY timestamp_ms DESC, id DESC) rn
          FROM usage_events
          WHERE success = 0 AND timestamp_ms >= ? AND key_hash IS NOT NULL AND key_hash != '' AND ${active.sql}
        ) WHERE rn <= ${RECENT_ERRORS} ORDER BY k, ts DESC`,
      params: [since, ...active.params],
    },
  ])

  const byKey = new Map<string, KeyActivity>()
  for (const row of keyRows as Row[]) {
    const id = String(row.k)
    byKey.set(id, {
      id,
      h24: { requests: Array(ACTIVITY_HOURS).fill(0), errors: Array(ACTIVITY_HOURS).fill(0) },
      d7: {
        requests: 0,
        errors: 0,
        tokens: 0,
        daily: Array.from({ length: ACTIVITY_DAYS }, () => ({ requests: 0, errors: 0 })),
        topModels: [],
        errorKinds: [],
      },
      recentErrors: [],
    })
  }

  for (const row of hourRows as Row[]) {
    const entry = byKey.get(String(row.k))
    if (!entry) continue // usage of a deleted Key
    const hour = num(row.h)
    const requests = num(row.n)
    const errors = num(row.e)
    entry.d7.requests += requests
    entry.d7.errors += errors
    entry.d7.tokens += num(row.t)
    const day = Math.min(ACTIVITY_DAYS - 1, Math.max(0, Math.floor((hour - since) / DAY_MS)))
    entry.d7.daily[day].requests += requests
    entry.d7.daily[day].errors += errors
    if (hour >= hourStart) {
      const slot = Math.round((hour - hourStart) / HOUR_MS)
      if (slot >= 0 && slot < ACTIVITY_HOURS) {
        entry.h24.requests[slot] += requests
        entry.h24.errors[slot] += errors
      }
    }
  }

  const models = new Map<string, Map<string, { model: string; requests: number; tokens: number }>>()
  for (const row of modelRows as Row[]) {
    const id = String(row.k)
    if (!byKey.has(id)) continue
    const name = canonicalModelId(String(row.m ?? ''))
    const perKey = models.get(id) ?? new Map()
    const current = perKey.get(name) ?? { model: name, requests: 0, tokens: 0 }
    current.requests += num(row.n)
    current.tokens += num(row.t)
    perKey.set(name, current)
    models.set(id, perKey)
  }
  for (const [id, perKey] of models) {
    byKey.get(id)!.d7.topModels = [...perKey.values()]
      .filter((entry) => entry.requests > 0)
      .sort((a, b) => b.requests - a.requests || b.tokens - a.tokens || (a.model < b.model ? -1 : 1))
      .slice(0, TOP_MODELS)
  }

  const kinds = new Map<string, KeyActivity['d7']['errorKinds']>()
  for (const row of kindRows as Row[]) {
    const id = String(row.k)
    if (!byKey.has(id)) continue
    const list = kinds.get(id) ?? []
    list.push({ status: statusOrNull(row.s), category: textOrNull(row.c), count: num(row.n) })
    kinds.set(id, list)
  }
  for (const [id, list] of kinds) {
    byKey.get(id)!.d7.errorKinds = list
      .filter((entry) => entry.count > 0)
      .sort((a, b) => b.count - a.count || (a.status ?? 0) - (b.status ?? 0))
      .slice(0, ERROR_KINDS)
  }

  for (const row of errorRows as Row[]) {
    const entry = byKey.get(String(row.k))
    if (!entry || entry.recentErrors.length >= RECENT_ERRORS) continue
    entry.recentErrors.push({
      at: new Date(num(row.ts)).toISOString(),
      model: canonicalModelId(String(row.m ?? '')),
      status: statusOrNull(row.s),
      category: textOrNull(row.c),
    })
  }

  return {
    scope: currentOnly ? 'current_channels' : 'all',
    hours: ACTIVITY_HOURS,
    hourStart: new Date(hourStart).toISOString(),
    days: ACTIVITY_DAYS,
    since: new Date(since).toISOString(),
    keys: [...byKey.values()],
    generatedAt: new Date(now).toISOString(),
  }
}

type Deps = {
  usageReader: Reader
  /** current channel groups (read only for `?currentOnly=1`); defaults to the persisted reporting groups */
  groups?: () => Promise<ConsoleGroup[]>
  now?: () => number
}

export function registerKeysViewRoutes(app: Pick<express.Express, 'get'>, deps: Deps) {
  const groups = deps.groups ?? (async () => (await import('./channels.js')).listGroupsForReporting())
  const now = deps.now ?? Date.now
  const cache = new RequestCoordinator<KeysActivityPayload>({ ttlMs: 15_000, staleWhileRevalidateMs: 60_000, now })
  app.get('/api/keys/activity', async (req, res) => {
    const currentOnly = parseCurrentOnly(req.query.currentOnly)
    // The default (all channels) needs no channel list at all; only the opt-in filter depends on the control plane.
    let current: ConsoleGroup[] = []
    if (currentOnly) {
      try {
        current = await groups()
      } catch {
        res.status(503).json({ error: '渠道信息暂不可用 · 稍后再试', code: 'reporting_unavailable' })
        return
      }
    }
    try {
      const policy = currentOnly ? `current:${activeProviderValues(current).join(',')}` : 'all'
      const payload = await cache.run(`keys-activity:v2:${policy}`, () => loadKeysActivity(deps.usageReader, current, now(), currentOnly))
      res.setHeader('Cache-Control', 'private, max-age=15')
      res.json(payload)
    } catch (error) {
      // fixed text for the browser; the DB / worker message stays in the server log
      console.warn(`[keys-activity] 读取失败：${error instanceof Error ? error.message : '未知错误'}`)
      res.status(503).json({ error: 'Key 用量暂不可用', code: 'activity_unavailable' })
    }
  })
}
