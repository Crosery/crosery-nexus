import { ApiError, request } from '../../api/http'
import type { ChannelHealthPayload } from './channelModel'

/**
 * GET /api/channel-health (server/channelHealth.ts). A server that predates the route answers 404 through the
 * `/api` fallthrough; that is "not available yet", not an error — the page keeps working without health columns.
 */
export type HealthResult = { available: true; payload: ChannelHealthPayload } | { available: false }

export async function fetchChannelHealth(hours: string, signal?: AbortSignal): Promise<HealthResult> {
  try {
    const payload = await request<ChannelHealthPayload>(`/api/channel-health?hours=${encodeURIComponent(hours)}`, { signal })
    return { available: true, payload }
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return { available: false }
    throw error
  }
}
