/**
 * `GET /api/connect` — the admin 帮助 page's gateway address (admin only: the session guard answers a key session
 * with 403 `forbidden_role`; key users read the same value from `/api/me/connect`).
 *
 * Same source as the key user's connect page (`gatewayBaseUrl()`), so both pages always print one Base URL.
 * Config only: no database, no gateway, no upstream call.
 */
import type express from 'express'
import { config } from './config.js'
import { gatewayBaseUrl } from './meRoutes.js'

export type ConnectInfo = {
  /** OpenAI-compatible base, always ending in `/vN` */
  baseUrl: string
  /** `baseUrl` without `/v1` (Anthropic SDK / Claude Code), null when the base is not `/v1` */
  anthropicBaseUrl: string | null
  /** false = PUBLIC_GATEWAY_BASE_URL is unset and `baseUrl` is the local gateway fallback */
  configured: boolean
}

export function connectInfo(): ConnectInfo {
  const baseUrl = gatewayBaseUrl()
  return {
    baseUrl,
    anthropicBaseUrl: baseUrl.endsWith('/v1') ? baseUrl.slice(0, -3) : null,
    configured: Boolean(config.publicGatewayBaseUrl),
  }
}

export function registerConnectRoutes(app: express.Express) {
  app.get('/api/connect', (_request, response) => {
    response.setHeader('Cache-Control', 'no-store')
    response.json(connectInfo())
  })
}
