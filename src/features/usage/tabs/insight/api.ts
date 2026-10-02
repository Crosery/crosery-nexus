import { request } from '../../../../api/http'
import { errorStatus } from '../../../../lib/errors'
import { scopeQuery, type CacheSummary, type PerformanceReport, type UsageScope } from './model'

/**
 * Report endpoints of the 缓存 / 性能 tabs (CONTRACTS · Change usage-b). A 404 means the running console
 * server predates these routes (they ship with the next service restart): the tabs show "not yet available"
 * and stop polling instead of an error loop.
 */
export const insightApi = {
  cacheSummary: (scope: UsageScope, signal?: AbortSignal) => request<CacheSummary>(`/api/cache-summary?${scopeQuery(scope)}`, { signal }),
  performance: (scope: UsageScope, signal?: AbortSignal) => request<PerformanceReport>(`/api/usage-performance?${scopeQuery(scope)}`, { signal }),
  /** SSE: history replay + increments; filters as the summary, never the time window. */
  cacheLiveUrl: (scope: UsageScope, limit = 50) => {
    const params = new URLSearchParams({ limit: String(limit) })
    for (const key of ['model', 'client', 'keyId', 'provider'] as const) if (scope[key]) params.set(key, scope[key])
    if (scope.currentOnly) params.set('currentOnly', '1')
    return `/api/cache-live?${params.toString()}`
  },
}

export const isNotDeployed = (error: unknown) => errorStatus(error) === 404
