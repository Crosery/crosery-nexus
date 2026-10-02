/**
 * The Key page's reads and writes. Writes are the existing admin endpoints (`api.*`); the only new read is
 * `/api/keys/activity` (server/keysView.ts). Until the service restarts with that module it answers 404, which
 * the page shows as "用量暂不可用" instead of an error — the Key list and quotas never depend on it.
 */
import { api } from '../../api'
import { ApiError, request } from '../../api/http'
import type { ApiKeyItem, BootstrapData } from '../../types'
import type { ActivityState, KeysActivityPayload } from './keysModel'

export type KeysBoot = Pick<BootstrapData, 'keys' | 'groups' | 'quotaTimeZone' | 'gatewayModelAccess' | 'degraded' | 'degradedReason'>

export type KeysSnapshot = {
  boot: KeysBoot
  activity: KeysActivityPayload | null
  activityState: ActivityState
  activityError: unknown
}

export function fetchActivity(signal?: AbortSignal) {
  return request<KeysActivityPayload>('/api/keys/activity', { signal })
}

/** One poll for the page: the Key list (must succeed) + activity (optional, degrades on its own). */
export async function fetchKeysSnapshot(signal: AbortSignal, previous: KeysActivityPayload | null): Promise<KeysSnapshot> {
  const [boot, activity] = await Promise.allSettled([api.bootstrap<KeysBoot>(), fetchActivity(signal)])
  if (boot.status === 'rejected') throw boot.reason
  if (activity.status === 'fulfilled') return { boot: boot.value, activity: activity.value, activityState: 'ready', activityError: null }
  const missing = activity.reason instanceof ApiError && activity.reason.status === 404
  return {
    boot: boot.value,
    // a failed refresh keeps the last good numbers (shown as stale), never zeros
    activity: missing ? null : previous,
    activityState: missing ? 'unavailable' : 'error',
    activityError: activity.reason,
  }
}

export type KeyDraftPayload = {
  name: string
  note: string
  groups: string[]
  totalConcurrency: number
  groupConcurrency: Record<string, number>
}

export const keysApi = {
  create: (body: KeyDraftPayload) => api.createKey<{ key: string; item: ApiKeyItem }>(body),
  update: (id: string, body: Partial<KeyDraftPayload> & { enabled?: boolean }) => api.updateKey<{ item: ApiKeyItem }>(id, body),
  remove: (id: string) => api.deleteKey(id),
  quota: (id: string, body: { totalUsd: number; dailyUsd: number; weeklyUsd: number }) => api.updateQuota<ApiKeyItem>(id, body),
  resetQuota: (id: string, window: 'daily' | 'weekly' | 'total') => api.resetQuota<ApiKeyItem>(id, window),
  /** two-step reveal: a 60s single-use token, then the key itself (never cached, never logged) */
  async reveal(id: string): Promise<string> {
    const { token } = await api.createRevealToken(id)
    const { key } = await api.revealKey(id, token)
    return key
  },
}
