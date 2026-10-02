/**
 * The page's reads. Same endpoints as `api.monitor` / `api.channels`, plus an AbortSignal for useLive. Every read
 * revalidates (`no-cache`): /api/monitor answers `max-age=60, stale-while-revalidate=600`, so a plain fetch after a
 * write — or the first poll when a background tab comes back — could show a copy up to ~10 min old stamped as now.
 * The server keeps its own snapshot caches, so revalidating costs no upstream call.
 */
import { request } from '../../api/http'
import type { ChannelsData, MonitorData } from '../../types'
import type { SplitPayload } from './model'

/** `channelsError` / `monitorError`: the endpoint that failed while the other one answered (the page still renders) */
export type AccountsPayload = SplitPayload<ChannelsData, MonitorData>

export async function loadAccounts(signal: AbortSignal): Promise<AccountsPayload> {
  const init: RequestInit = { signal, cache: 'no-cache' }
  const [channels, monitor] = await Promise.allSettled([
    request<ChannelsData>('/api/channels', init),
    request<MonitorData>('/api/monitor', init),
  ])
  if (channels.status === 'rejected' && monitor.status === 'rejected') {
    // both down: surface the credential-list error (it carries the auth / role status first)
    throw channels.reason
  }
  const at = Date.now()
  return {
    channels: channels.status === 'fulfilled' ? channels.value : null,
    monitor: monitor.status === 'fulfilled' ? monitor.value : null,
    channelsError: channels.status === 'rejected' ? channels.reason : null,
    monitorError: monitor.status === 'rejected' ? monitor.reason : null,
    at,
    channelsAt: channels.status === 'fulfilled' ? at : null,
    monitorAt: monitor.status === 'fulfilled' ? at : null,
  }
}

/**
 * The authoritative per-account proxy (GET /api/credentials/:name/proxy). The route answers
 * `Cache-Control: private, max-age=60`, so the read revalidates instead of showing the copy from before a PATCH;
 * the server keeps its own 60 s per-credential cache, cleared on every write.
 */
export function loadCredentialProxy(name: string): Promise<{ proxyUrl: string }> {
  return request<{ proxyUrl: string }>(`/api/credentials/${encodeURIComponent(name)}/proxy`, { cache: 'no-cache' })
}
