export type Group = { id: string; name: string; color: string; match: string[] }

export type ApiKeyItem = {
  id: string
  name: string
  note: string
  maskedKey: string
  enabled: boolean
  groups: string[]
  totalConcurrency: number
  groupConcurrency: Record<string, number>
  createdAt: string
  updatedAt: string
  lastUsedAt?: string
}

export type BootstrapData = {
  keys: ApiKeyItem[]
  groups: Group[]
  models: string[]
  retentionDays: number
}

export type AnalyticsData = {
  days: number
  summary: { requests: number; tokens: number; avgLatency: number; errorRate: number }
  trend: Array<{ bucket: string; requests: number; tokens: number; errors: number }>
  groups: Array<{ name: string; requests: number; tokens: number }>
  models: Array<{ name: string; requests: number; tokens: number }>
  keyUsage: Array<{ id: string; name: string; requests: number; tokens: number; errorRate: number }>
  requests: Array<{
    requestId: string
    timestamp: string
    provider: string
    model: string
    endpoint: string
    success: number
    statusCode: number
    latencyMs: number
    ttftMs: number
    inputTokens: number
    outputTokens: number
    reasoningTokens: number
    cachedTokens: number
    totalTokens: number
    errorDetail: string
    upstreamRequestId: string
    source: string
    authIndex: string
    reasoningEffort: string
    serviceTier: string
    keyName: string
  }>
}
