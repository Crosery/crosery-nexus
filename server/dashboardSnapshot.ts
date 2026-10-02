import { createHash } from 'node:crypto'

import { SNAPSHOT_PERIODS, type SnapshotPeriod, type UsageDimension, type UsageSnapshot, type UsageSummary } from '../packages/contracts/index.js'
import type { SnapshotValue } from './snapshotStore.js'

export type DashboardPayload = {
  days: number
  /**
   * `activeKeys` is part of the `/api/dashboard` contract (Change usage-a). The data-plane snapshot carries no
   * per-Key dimension, so snapshot mode answers `null` (= not known here), never a fake 0.
   */
  summary: { requests: number; tokens: number; avgLatency: number; errorRate: number; activeKeys: number | null }
  trend: Array<{ bucket: string; requests: number; tokens: number; errors: number }>
  generatedAt: string
  sourceWatermark: string | null
  stale: boolean
  source: 'data-plane'
}

type SnapshotReader = {
  read(snapshotKey: string, endpoint: string, freshForMs: number): Promise<SnapshotValue<UsageSnapshot> | null>
}

export type DashboardRelayIntegrity = {
  pending: number
  deadLetters: number
}

type RelayIntegrityReader = () => DashboardRelayIntegrity

function snapshotPeriod(days: number): SnapshotPeriod | null {
  return SNAPSHOT_PERIODS.includes(days as SnapshotPeriod) ? days as SnapshotPeriod : null
}

const additiveMetrics = [
  'requests', 'errors', 'totalTokens', 'inputTokens', 'outputTokens',
  'cachedTokens', 'cacheWriteTokens', 'reasoningTokens',
] as const satisfies ReadonlyArray<keyof UsageSummary>

const normalizedProvider = (value: string) => value.trim().toLowerCase()

export function relayAllowsDashboardSnapshots(integrity: DashboardRelayIntegrity): boolean {
  return integrity.pending === 0 && integrity.deadLetters === 0
}

export function providerPolicyHash(activeProviders: readonly string[]): string {
  const canonical = [...new Set(activeProviders.map(normalizedProvider).filter(Boolean))].sort()
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 20)
}

function dimensionsConserveSummary(summary: UsageSummary, providers: readonly UsageDimension[]): boolean {
  for (const metric of additiveMetrics) {
    if (providers.reduce((total, provider) => total + provider[metric], 0) !== summary[metric]) return false
  }
  const requests = summary.requests
  const latency = providers.reduce((total, provider) => total + provider.averageLatencyMs * provider.requests, 0)
  const ttft = providers.reduce((total, provider) => total + provider.averageTtftMs * provider.requests, 0)
  const tolerance = 1e-6
  return Math.abs((requests ? latency / requests : 0) - summary.averageLatencyMs) <= tolerance
    && Math.abs((requests ? ttft / requests : 0) - summary.averageTtftMs) <= tolerance
}

export function dashboardSnapshotIsSuitable(
  snapshot: SnapshotValue<UsageSnapshot>,
  activeProviders: readonly string[],
  latestLocalUsageAt: number | null,
  maxWatermarkLagMs: number,
  relayIntegrity: DashboardRelayIntegrity,
  now = Date.now(),
): boolean {
  if (!relayAllowsDashboardSnapshots(relayIntegrity)) return false
  if (snapshot.generatedAt > now + 30_000) return false
  const allowed = new Set(activeProviders.map(normalizedProvider).filter(Boolean))
  if (snapshot.value.providers.some((provider) => {
    const name = normalizedProvider(provider.name)
    return name === '__other__' || !allowed.has(name)
  })) return false
  if (!dimensionsConserveSummary(snapshot.value.summary, snapshot.value.providers)) return false
  if (latestLocalUsageAt === null) return true
  const watermark = snapshot.value.sourceWatermark ? Date.parse(snapshot.value.sourceWatermark) : Number.NaN
  return Number.isFinite(watermark) && latestLocalUsageAt - watermark <= maxWatermarkLagMs
}

export function dashboardFromSnapshot(snapshot: SnapshotValue<UsageSnapshot>): DashboardPayload {
  const { value } = snapshot
  return {
    days: value.days,
    summary: {
      requests: value.summary.requests,
      tokens: value.summary.totalTokens,
      avgLatency: value.summary.averageLatencyMs,
      errorRate: value.summary.requests > 0 ? value.summary.errors / value.summary.requests : 0,
      activeKeys: null,
    },
    trend: value.trend.map((point) => ({
      bucket: point.bucket.slice(0, 13),
      requests: point.requests,
      tokens: point.totalTokens,
      errors: point.errors,
    })),
    generatedAt: new Date(snapshot.generatedAt).toISOString(),
    sourceWatermark: value.sourceWatermark,
    stale: snapshot.stale,
    source: 'data-plane',
  }
}

/** Only the precomputed all-key periods are eligible for the data-plane fast path. */
export async function readDashboardSnapshot(
  snapshots: SnapshotReader,
  days: number,
  keyId: string,
  activeProviders: readonly string[],
  latestLocalUsageAt: number | null,
  readRelayIntegrity: RelayIntegrityReader,
  freshForMs: number,
  maxWatermarkLagMs: number,
): Promise<DashboardPayload | null> {
  const period = snapshotPeriod(days)
  if (!period || keyId) return null
  if (!relayAllowsDashboardSnapshots(readRelayIntegrity())) return null
  const policyHash = providerPolicyHash(activeProviders)
  const snapshot = await snapshots.read(
    `dashboard:v1:${period}:all:${policyHash}`,
    `/internal/v1/snapshots/${period}`,
    freshForMs,
  )
  return snapshot && dashboardSnapshotIsSuitable(
    snapshot,
    activeProviders,
    latestLocalUsageAt,
    maxWatermarkLagMs,
    readRelayIntegrity(),
  )
    ? dashboardFromSnapshot(snapshot)
    : null
}
