import type { MeConnect, MeModels, MeOverview, MeRequestsPage, MeUsage, MeUsageDaily } from '../types'
import { qs, request } from './http'

/**
 * Key-user endpoints (C2). The server filters every one by the session's key and never accepts a keyId
 * from the query; an admin session gets 403 `not_key_session`.
 */
export const meApi = {
  overview: (signal?: AbortSignal) => request<MeOverview>('/api/me', { signal }),
  usage: (days: 7 | 30 | 90 = 7, signal?: AbortSignal) => request<MeUsage>(`/api/me/usage${qs({ days })}`, { signal }),
  /** heatmap: a year of days (`recent` = the last 53 weeks), this key only */
  usageDaily: (year: 'recent' | number = 'recent', signal?: AbortSignal) =>
    request<MeUsageDaily>(`/api/me/usage/daily${qs({ year: year === 'recent' ? undefined : year })}`, { signal }),
  /** `before` exclusive upper bound, `after` inclusive lower bound (one day: its start and the next day's start) */
  requests: (options: { limit?: number; before?: string | null; after?: string | null; status?: 'all' | 'error' } = {}, signal?: AbortSignal) =>
    request<MeRequestsPage>(`/api/me/requests${qs({ limit: options.limit, before: options.before, after: options.after, status: options.status === 'error' ? 'error' : undefined })}`, { signal }),
  models: (signal?: AbortSignal) => request<MeModels>('/api/me/models', { signal }),
  connect: (signal?: AbortSignal) => request<MeConnect>('/api/me/connect', { signal }),
}
