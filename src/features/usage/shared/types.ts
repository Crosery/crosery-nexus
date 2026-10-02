/**
 * Payloads of the 用量 workspace endpoints (server/usageReports.ts — loadUsageWorkspace*; CONTRACTS
 * "Change (usage-a)"). Every number on the 总览 and 请求 tabs comes from these, under one window and one
 * channel scope, so the tabs and the dashboard agree for the same filter.
 */
import type { AnalyticsData, RequestDetailItem } from '../../../types'
import type { HeatSeries } from '../../../ui/viz/heatModel'

/** `span` = the custom from/to window (calendar days, inclusive) when one is in effect; null / absent = rolling `days`. */
export type UsageWindow = { days: number; from: string; to: string; timeZone: string; span?: { from: string; to: string } | null }

type ScopeChannels = { requests: number; channels: Array<{ id: string; label: string; requests: number }> }

export type UsageScope = {
  /** all = every channel, removed ones included (default); current = only the current channels (opt-in filter) */
  kind: 'all' | 'current'
  /** number of current channels (live CPA groups) */
  channels: number
  /** requests in the same window and filter on channels that are no longer current: counted when kind=all */
  removed?: ScopeChannels
  /** the removed-channel requests left out (kind=current only; zero for kind=all) */
  excluded: ScopeChannels
}

export type UsageLedger = {
  requests: number
  errors: number
  errorRate: number | null
  tokens: number
  costUsd: number | null
  costEstimated: boolean
  hasPartialCost: boolean
  unpricedRequests: number
  unpricedModels: string[]
  /** = 缓存 tab totals.hitRate (successful requests on cache-capable models) */
  cacheHitRate: number | null
  /** = 缓存 tab excluded.models (models that cannot cache, left out of the rate) */
  cacheIdleModels: number
  activeKeys: number
  enabledKeys: number
  totalKeys: number
  avgLatencyMs: number | null
}

export type UsageRank = {
  id: string
  label: string
  requests: number
  tokens: number
  errors: number
  costUsd: number | null
  partialCost: boolean
}

export type UsageFailure = { category: string; owner: string; count: number; codes: Array<{ code: number; count: number }> }

export type UsageDay = {
  day: string
  requests: number
  errors: number
  tokens: number
  costUsd: number | null
  freshInput: number
  output: number
  cacheRead: number
  cacheWrite: number
  topModels: Array<{ model: string; tokens: number }>
}

export type UsageOverviewData = {
  view: 'workspace'
  window: UsageWindow
  scope: UsageScope
  ledger: UsageLedger
  previous: Pick<UsageLedger, 'requests' | 'errors' | 'errorRate' | 'tokens' | 'costUsd' | 'cacheHitRate' | 'activeKeys'> | null
  mix: { freshInput: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number; cacheSavingsUsd: number | null }
  daily: UsageDay[]
  models: UsageRank[]
  keys: Array<UsageRank & { enabled: boolean | null }>
  /** `removed` = the channel is no longer current (history in the all-channel scope) */
  channels: Array<UsageRank & { removed?: boolean }>
  clients: UsageRank[]
  failures: UsageFailure[]
  generatedAt: string
}

export type UsageRequestRow = RequestDetailItem & {
  timestampMs: number
  keyId: string | null
  channel: string
  costEstimated: boolean
}

/** AnalyticsData superset served by `/api/analytics?view=workspace`. */
export type UsageRequestsData = Omit<AnalyticsData, 'errorCategories' | 'requests'> & {
  view: 'workspace'
  window: UsageWindow
  query: { status: '' | 'ok' | 'error'; category: string; day: string; page: number; pageSize: number }
  summary: AnalyticsData['summary'] & { errors: number }
  errorCategories: UsageFailure[]
  total: number
  requests: UsageRequestRow[]
  generatedAt: string
}

export type UsageFacetOption = { value: string; label: string; count: number; current?: boolean; removed?: boolean }

export type UsageFacetsData = {
  view: 'workspace'
  window: UsageWindow
  scope: UsageScope
  totals: { requests: number; cacheHitRate: number | null; unpricedModels: string[] }
  keys: UsageFacetOption[]
  models: UsageFacetOption[]
  channels: UsageFacetOption[]
  clients: UsageFacetOption[]
  generatedAt: string
}

/** `/api/usage-daily` (server/usageReports.ts loadUsageWorkspaceDaily): the heatmap's year of days. */
export type UsageDailyData = HeatSeries & { view: 'workspace'; generatedAt: string }
