import type { RtkGlobalStatus, RtkRelayStatus, SyncRunAccepted, SyncStatus } from '../types'
import { request } from './http'
import { RtkApiError } from './admin'

/** Sync center (C3). `run` rejects with ApiError: 429 `cooldown` (retryAfterSec), 409 `running`, 400 `not_runnable` / `disabled`, 404 `not_found`. */
export const syncApi = {
  status: (signal?: AbortSignal) => request<SyncStatus>('/api/sync/status', { signal }),
  run: (id: string) => request<SyncRunAccepted>(`/api/sync/${encodeURIComponent(id)}/run`, { method: 'POST' }),
}

/** RTK global switch state (C4); gate failures reject with RtkApiError. */
export const rtkGlobalApi = {
  get: (signal?: AbortSignal) =>
    request<RtkGlobalStatus>('/api/rtk/global', { signal }, (status, message, body, retry) => new RtkApiError(status, message, body, retry)),
}

/** RTK relay (server/rtkRelay.ts): listener state, the global compression switch and the savings ledger. */
export const rtkRelayApi = {
  get: (signal?: AbortSignal) => request<RtkRelayStatus>('/api/rtk/relay', { signal }),
  set: (enabled: boolean) => request<RtkRelayStatus>('/api/rtk/relay', { method: 'POST', body: JSON.stringify({ enabled }) }),
}
