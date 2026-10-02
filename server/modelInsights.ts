/**
 * `GET /api/models/insights` — the evidence layer behind the admin `/models` page (CONTRACTS C7). Read-only.
 *
 * Nothing here is a new store or a new sync path; it reads what the console already keeps:
 * - usage: `usage_hourly_rollup` with the same channel scope (all traffic by default, removed channels included and
 *   marked `removed` in the channel split; `?currentOnly=1` = current channels only), canonical-model grouping and
 *   window helper as `/api/usage-overview`, so request counts reconcile with the usage workspace;
 * - spec: `loadModelCatalog()` (the loader behind `/api/me/models`), then the shared catalog adapter
 *   (`readSharedCatalog()`, models + the dual-source pricing rows) for context / output / reasoning;
 * - probes: the model-discovery job's persisted per-channel probe state in the sync registry.
 * Unknown stays `null` (never a fake 0); a part that cannot be read is listed in `degraded` instead of failing
 * the whole response.
 */
import type express from 'express'
import { listGroupsForReporting } from './channels.js'
import { config } from './config.js'
import { activeProviderValues, parseCurrentOnly, scopedProviderPredicate } from './currentChannels.js'
import { providerPolicyHash } from './dashboardSnapshot.js'
import type { ConsoleGroup } from './groups.js'
import { loadModelCatalog, type CatalogModel } from './modelCatalog.js'
import { canonicalModelSql } from './modelIdentity.js'
import { readSharedCatalog, type DiscoveryState, type SharedCatalog } from './modelSync.js'
import { normalizeModelForPricing } from './pricing.js'
import { boundedInteger } from './publicUsage.js'
import { RequestCoordinator } from './requestCoordinator.js'
import type { ReadOperation } from './sqliteReadWorker.js'
import { syncRegistry } from './syncRegistry.js'
import { cutoffEpochMs, usageWindow } from './timeRange.js'
import { isRemovedChannel, usageChannelSql } from './usageReports.js'

type Reader = { run(operations: readonly ReadOperation[]): Promise<unknown[]> }

export type ModelUsageEvidence = {
  model: string
  requests: number
  errors: number
  /** errors / requests is left to the client; null-safe because requests ≥ 1 for every row */
  lastOkHour: string | null
  lastErrorHour: string | null
  topError: { status: number; category: string; requests: number } | null
  /**
   * The most frequent error on the current channels only (removed channels left out), with its count there. The
   * page's verdict (可用 / 注意 / 不可用) judges current channels, so the cause it names comes from here; null when
   * the current channels had no failure.
   */
  liveTopError: { status: number; category: string; requests: number } | null
  /**
   * `removed` = the channel is no longer a current channel (history kept in the default all-channel scope);
   * `lastOkHour` per channel lets the page judge availability on the current channels only.
   */
  channels: Array<{ channel: string; requests: number; errors: number; removed: boolean; lastOkHour: string | null }>
}

export type ModelSpec = {
  model: string
  name: string | null
  contextWindow: number | null
  maxOutput: number | null
  /** null = no source states it either way */
  reasoning: boolean | null
  efforts: string[]
  /** where context / output came from: gateway catalog, shared catalog, or a pricing source row */
  specSource: 'gateway' | 'catalog' | 'openrouter' | 'models.dev' | null
}

export type ChannelProbe = {
  channel: string
  lastProbeAt: string | null
  nextProbeAt: string | null
  status: number | null
  error: string | null
  discovered: number | null
  backoffUntil: string | null
}

export type ModelInsightsPayload = {
  days: number
  from: string
  /** null = could not be read (see `degraded`); [] = read, no traffic */
  usage: ModelUsageEvidence[] | null
  specs: ModelSpec[]
  probes: ChannelProbe[]
  degraded: string[]
  generatedAt: string
}

const positive = (...values: unknown[]): number | null => {
  for (const value of values) {
    const number = typeof value === 'number' ? value : Number.NaN
    if (Number.isFinite(number) && number > 0) return number
  }
  return null
}
const iso = (value: unknown): string | null => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? new Date(value).toISOString() : null)
const canonical = (id: unknown) => normalizeModelForPricing(String(id ?? ''))

type UsageRow = { model: string; channel: string; requests: number; errors: number; lastOkHour: number | null; lastErrorHour: number | null }
/** `channel` = folded channel id (usageChannelSql); absent on rows from older callers (counted as current). */
type ErrorRow = { model: string; channel?: string; status: number; category: string; requests: number }

/** Rollup rows → one evidence row per canonical model, busiest first; channel split kept for the detail sheet. */
export function buildUsageEvidence(rows: UsageRow[], errorRows: ErrorRow[], groups: ConsoleGroup[] | null = null): ModelUsageEvidence[] {
  type Split = { channel: string; requests: number; errors: number; removed: boolean; okMs: number }
  const byModel = new Map<string, Omit<ModelUsageEvidence, 'channels'> & { channels: Split[]; okMs: number; errMs: number }>()
  for (const row of rows) {
    const model = canonical(row.model)
    if (!model) continue
    const requests = Number(row.requests) || 0
    if (requests <= 0) continue
    const errors = Math.min(requests, Number(row.errors) || 0)
    const entry = byModel.get(model) ?? { model, requests: 0, errors: 0, lastOkHour: null, lastErrorHour: null, topError: null, liveTopError: null, channels: [], okMs: 0, errMs: 0 }
    entry.requests += requests
    entry.errors += errors
    entry.okMs = Math.max(entry.okMs, Number(row.lastOkHour) || 0)
    entry.errMs = Math.max(entry.errMs, Number(row.lastErrorHour) || 0)
    const channel = String(row.channel || 'unknown')
    const okMs = Number(row.lastOkHour) || 0
    const split = entry.channels.find((item) => item.channel === channel)
    if (split) {
      split.requests += requests
      split.errors += errors
      split.okMs = Math.max(split.okMs, okMs)
    } else {
      entry.channels.push({ channel, requests, errors, removed: groups ? isRemovedChannel(channel, groups) : false, okMs })
    }
    byModel.set(model, entry)
  }
  const top = new Map<string, ErrorRow>()
  const liveTop = new Map<string, ErrorRow>()
  for (const row of errorRows) {
    const model = canonical(row.model)
    const requests = Number(row.requests) || 0
    if (!model || requests <= 0) continue
    const status = Number(row.status) || 0
    const category = String(row.category || '')
    const key = `${model}\u0000${status}\u0000${category}`
    const live = row.channel === undefined || !groups || !isRemovedChannel(String(row.channel || 'unknown'), groups)
    for (const map of live ? [top, liveTop] : [top]) {
      const current = map.get(key)
      if (current) current.requests += requests
      else map.set(key, { model, status, category, requests })
    }
  }
  const pick = (map: Map<string, ErrorRow>, field: 'topError' | 'liveTopError') => {
    for (const row of map.values()) {
      const entry = byModel.get(row.model)
      if (!entry) continue
      const best = entry[field]
      if (!best || row.requests > best.requests || (row.requests === best.requests && row.status < best.status)) {
        entry[field] = { status: row.status, category: row.category, requests: row.requests }
      }
    }
  }
  pick(top, 'topError')
  pick(liveTop, 'liveTopError')
  return [...byModel.values()]
    .map(({ okMs, errMs, ...entry }) => ({
      ...entry,
      lastOkHour: iso(okMs),
      lastErrorHour: iso(errMs),
      channels: entry.channels
        .sort((a, b) => b.requests - a.requests || a.channel.localeCompare(b.channel))
        .map(({ okMs, ...split }) => ({ ...split, lastOkHour: iso(okMs) })),
    }))
    .sort((a, b) => b.requests - a.requests || a.model.localeCompare(b.model))
}

/**
 * Spec per canonical model. Precedence: the gateway catalog (what `/api/me/models` shows) → the shared catalog
 * model → a dual-source pricing row (openrouter, then models.dev). Reasoning is only `false` when a source
 * says so; a model nobody describes stays `null`.
 */
export function buildModelSpecs(catalog: CatalogModel[], shared: SharedCatalog | null): ModelSpec[] {
  type Draft = ModelSpec
  const specs = new Map<string, Draft>()
  const draft = (model: string): Draft => {
    let entry = specs.get(model)
    if (!entry) {
      entry = { model, name: null, contextWindow: null, maxOutput: null, reasoning: null, efforts: [], specSource: null }
      specs.set(model, entry)
    }
    return entry
  }

  for (const item of catalog) {
    const model = canonical(item.id)
    if (!model) continue
    const context = positive(item.context_length)
    const output = positive(item.max_completion_tokens)
    const levels = item.thinking?.levels?.filter((level) => typeof level === 'string' && level) ?? []
    if (context === null && output === null && !item.thinking) continue
    const entry = draft(model)
    entry.contextWindow = context
    entry.maxOutput = output
    if (context !== null || output !== null) entry.specSource = 'gateway'
    if (item.thinking) entry.reasoning = true
    if (levels.length) entry.efforts = [...new Set(levels)]
  }

  for (const item of shared?.models ?? []) {
    const model = canonical(item?.id)
    if (!model) continue
    const entry = draft(model)
    if (!entry.name && typeof item.name === 'string' && item.name.trim()) entry.name = item.name.trim()
    if (entry.contextWindow === null && entry.maxOutput === null) {
      entry.contextWindow = positive(item.contextWindow)
      entry.maxOutput = positive(item.maxTokens)
      if (entry.contextWindow !== null || entry.maxOutput !== null) entry.specSource = 'catalog'
    }
    if (entry.reasoning === null && typeof item.supportsReasoning === 'boolean') entry.reasoning = item.supportsReasoning
    if (!entry.efforts.length && Array.isArray(item.efforts)) entry.efforts = [...new Set(item.efforts.filter((level) => typeof level === 'string' && level))]
    if (entry.efforts.length && entry.reasoning === null) entry.reasoning = true
  }

  const rows = [...(shared?.pricing?.rows ?? [])].sort((a, b) => (a?.source === 'openrouter' ? 0 : 1) - (b?.source === 'openrouter' ? 0 : 1))
  for (const row of rows) {
    const model = canonical(row?.id)
    if (!model || (row.source !== 'openrouter' && row.source !== 'models.dev')) continue
    const context = positive(row.contextWindow)
    const output = positive(row.maxTokens)
    const name = typeof row.name === 'string' && row.name.trim() ? row.name.trim() : null
    if (context === null && output === null && !name) continue
    const entry = draft(model)
    if (!entry.name && name) entry.name = name
    if (entry.contextWindow === null && entry.maxOutput === null && (context !== null || output !== null)) {
      entry.contextWindow = context
      entry.maxOutput = output
      entry.specSource = row.source
    }
  }

  return [...specs.values()]
    .filter((entry) => entry.contextWindow !== null || entry.maxOutput !== null || entry.reasoning !== null || entry.name !== null)
    .sort((a, b) => a.model.localeCompare(b.model))
}

/** Per-channel `/models` probe outcome from the discovery job; a channel's host backoff is folded in. */
export function buildChannelProbes(state: DiscoveryState | null | undefined): ChannelProbe[] {
  const hosts = state?.hosts ?? {}
  const hostOf = (url: unknown) => {
    try { return typeof url === 'string' && url ? new URL(url).host : '' } catch { return '' }
  }
  return Object.entries(state?.channels ?? {})
    .map(([channel, probe]) => {
      const host = hosts[hostOf(probe?.workingUrl)]
      const status = typeof probe?.lastStatus === 'number' && Number.isFinite(probe.lastStatus) ? probe.lastStatus : null
      const error = typeof probe?.lastError === 'string' && probe.lastError ? probe.lastError.slice(0, 200) : null
      return {
        channel,
        lastProbeAt: iso(probe?.lastProbeAt),
        nextProbeAt: iso(probe?.nextProbeAt),
        status,
        error,
        discovered: typeof probe?.discovered === 'number' && Number.isFinite(probe.discovered) ? probe.discovered : null,
        backoffUntil: iso(host?.backoffUntil),
      }
    })
    .sort((a, b) => a.channel.localeCompare(b.channel))
}

export type ModelInsightsDeps = {
  reader: Reader
  groups: () => Promise<ConsoleGroup[]>
  catalog: () => Promise<CatalogModel[]>
  shared: () => SharedCatalog | null
  discovery: () => DiscoveryState | null
  now?: () => number
}

/** Usage SQL in the exact shape of `loadUsageOverviewReport` (same filter, same canonical model expression). */
export function modelUsageOperations(groups: ConsoleGroup[], days: number, now: number, currentOnly = false): ReadOperation[] {
  const { where, params } = usageWindow(days, '', 'hour_ms', now)
  const active = scopedProviderPredicate(groups, 'provider', currentOnly)
  const channel = usageChannelSql(groups, 'provider')
  const modelSql = canonicalModelSql()
  return [
    {
      method: 'all',
      sql: `
        SELECT ${modelSql} model, ${channel.sql} channel,
          SUM(request_count) requests,
          SUM(CASE WHEN success=0 THEN request_count ELSE 0 END) errors,
          MAX(CASE WHEN success=1 THEN hour_ms END) lastOkHour,
          MAX(CASE WHEN success=0 THEN hour_ms END) lastErrorHour
        FROM usage_hourly_rollup WHERE ${where} AND ${active.sql}
        GROUP BY ${modelSql}, ${channel.sql}
      `,
      params: [...channel.params, ...params, ...active.params, ...channel.params],
    },
    {
      method: 'all',
      sql: `
        SELECT ${modelSql} model, ${channel.sql} channel, status_code status, error_category category, SUM(request_count) requests
        FROM usage_hourly_rollup WHERE ${where} AND ${active.sql} AND success = 0
        GROUP BY ${modelSql}, ${channel.sql}, status_code, error_category
      `,
      params: [...channel.params, ...params, ...active.params, ...channel.params],
    },
  ]
}

export function createModelInsights(deps: ModelInsightsDeps) {
  const now = deps.now ?? Date.now
  const cache = new RequestCoordinator<ModelInsightsPayload>({ ttlMs: 30_000, staleWhileRevalidateMs: 2 * 60_000, now })

  async function compute(days: number, groups: ConsoleGroup[] | null, currentOnly: boolean): Promise<ModelInsightsPayload> {
    const at = now()
    const degraded: string[] = []

    let usage: ModelUsageEvidence[] | null = null
    if (groups) {
      try {
        const [rows, errorRows] = await deps.reader.run(modelUsageOperations(groups, days, at, currentOnly))
        usage = buildUsageEvidence(rows as UsageRow[], errorRows as ErrorRow[], groups)
      } catch {
        degraded.push('usage_unavailable')
      }
    } else {
      degraded.push('reporting_groups_unavailable')
    }

    let catalog: CatalogModel[] = []
    try {
      catalog = await deps.catalog()
    } catch {
      degraded.push('catalog_unavailable')
    }
    let shared: SharedCatalog | null = null
    try {
      shared = deps.shared()
    } catch {
      shared = null
    }
    if (!shared) degraded.push('shared_catalog_missing')

    let probes: ChannelProbe[] = []
    try {
      probes = buildChannelProbes(deps.discovery())
    } catch {
      degraded.push('probes_unavailable')
    }

    return {
      days,
      from: new Date(cutoffEpochMs(days, 'days', at)).toISOString(),
      usage,
      specs: buildModelSpecs(catalog, shared),
      probes,
      degraded,
      generatedAt: new Date(at).toISOString(),
    }
  }

  return {
    async read(days: number, currentOnly = false): Promise<ModelInsightsPayload> {
      let groups: ConsoleGroup[] | null = null
      try {
        groups = await deps.groups()
      } catch {
        groups = null
      }
      const policy = groups ? providerPolicyHash(activeProviderValues(groups)) : 'no-groups'
      return cache.run(`${days}:${currentOnly ? 'current' : 'all'}:${policy}`, () => compute(days, groups, currentOnly))
    },
  }
}

export function registerModelInsightsRoutes(app: express.Express, deps: { usageReader: Reader }) {
  const insights = createModelInsights({
    reader: deps.usageReader,
    groups: () => listGroupsForReporting(),
    catalog: () => loadModelCatalog(),
    shared: () => readSharedCatalog(),
    discovery: () => syncRegistry.jobData('model-discovery') as DiscoveryState,
  })
  app.get('/api/models/insights', async (req, res) => {
    const days = boundedInteger(req.query.days, 7, 1, Math.max(1, config.usageRetentionDays))
    try {
      const payload = await insights.read(days, parseCurrentOnly(req.query.currentOnly))
      res.setHeader('Cache-Control', 'private, max-age=20')
      res.json(payload)
    } catch {
      res.status(503).json({ error: '模型证据暂不可用', code: 'insights_unavailable' })
    }
  })
}
