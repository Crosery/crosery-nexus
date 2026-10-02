/**
 * Payload types the 概览 page reads. `OverviewPayload` mirrors `GET /api/overview` (server/overviewRoutes.ts,
 * CONTRACTS "Change (overview)"); the rest narrow the existing admin endpoints to the fields this page uses.
 */
import type { AccountQuota } from '../../types'

export type OverviewRange = '1h' | '6h' | '24h'
/** scope source: `live` = /api/pulse (90 s), the rest = /api/overview */
export type ScopeRange = 'live' | OverviewRange

export type OverviewPayload = {
  range: OverviewRange
  spanMs: number
  bucketMs: number
  from: number
  to: number
  gateway: {
    series: { requests: number[]; errors: number[]; p95Ms: Array<number | null> }
    requests: number
    errors: number
    successRate: number | null
    peak: { rpm: number; at: number } | null
    p50Ms: number | null
    p95Ms: number | null
    ttftP50Ms: number | null
    activeKeys: number
  }
  channels: {
    spanMs: number
    bucketMs: number
    from: number
    to: number
    rows: OverviewChannelRow[]
  }
  keys: {
    bucketMs: number
    from: number
    rows: Array<{ id: string; requests: number[]; errors: number[]; total: number; totalErrors: number }>
  }
  generatedAt: string
}

export type OverviewChannelRow = {
  provider: string
  name: string
  requests: number
  errors: number
  p95Ms: number | null
  ticks: number[]
  bad: number[]
  lastAt: number | null
  /** no longer a current channel (history only); null/absent = unknown */
  removed?: boolean | null
}

/** One CPA auth file as `/api/monitor` returns it (only the fields this page reads). */
export type MonitorAccount = {
  name?: string
  email?: string
  account?: string
  type?: string
  provider?: string
  auth_index?: string | number
  disabled?: boolean
  status?: string
  status_message?: string
  unavailable?: boolean
  next_retry_after?: string | null
  quota?: { error?: string } | null
  normalizedQuota?: AccountQuota | null
}
