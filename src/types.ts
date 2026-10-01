export type Group = { id: string; name: string; color: string; kind: 'compat' | 'oauth'; models: string[] }

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
  quota: KeyQuota
  blockedReason: string
  quotaState: KeyQuotaState
}

export type KeyQuota = { totalUsd: number; dailyUsd: number; weeklyUsd: number }

export type QuotaWindowState = {
  limitUsd: number
  spentUsd: number
  ratio: number | null
  exceeded: boolean
  startsAt: string
  /** 日/周额度的下一个自然刷新时间；总额度为 null，仅可手动重置。 */
  resetsAt: string | null
}

export type KeyQuotaState = {
  unlimited: boolean
  total: QuotaWindowState
  daily: QuotaWindowState
  weekly: QuotaWindowState
  exceeded: boolean
  exceededWindow: 'total' | 'daily' | 'weekly' | null
}

export type ChannelModel = { id: string; enabled: boolean; upstreams: number }

export type ChannelItem = {
  stale: boolean
  name: string
  baseUrl: string
  keyCount: number
  enabled: boolean
  models: ChannelModel[]
}

export type CredentialItem = {
  name: string
  type: string
  disabled: boolean
  status: string
  label: string
  modelCount: number
  models: string[]
  /** '' 继承网关全局代理，'direct' 强制直连，其余为该账号专用代理地址。 */
  proxyUrl: string
}

export type ProxyPreset = { label: string; url: string }

export type DiscoveredModel = { id: string; alias: string }

export type ChannelsData = {
  channels: ChannelItem[]
  credentials: CredentialItem[]
  proxyPresets: ProxyPreset[]
  globalProxy: string
}

export type ModelSource = {
  channel: string
  kind: 'compat' | 'oauth'
  enabled: boolean
  upstreams: number
  channelEnabled: boolean
}

export type ModelEntry = {
  id: string
  pricing: ModelPricing | null
  sources: ModelSource[]
  enabledSources: number
  contested: boolean
}

export type ModelIndexData = {
  models: ModelEntry[]
  channels: ChannelItem[]
  credentials: CredentialItem[]
}

/**
 * 网关是否真的在执行 Key 级模型隔离。'unavailable' 表示网关没有这个能力
 * （CPA v7.2.140 起上游移除了 api-key-model-access），分组配置仍会保存，
 * 但不会在网关生效——UI 必须说清楚，不能让人以为限制还在。
 */
export type GatewayModelAccess = 'unknown' | 'available' | 'unavailable'

export type CpaVersionInfo = {
  engine?: 'cpa' | 'magpie'
  version: string
  commit: string
  buildDate: string
  latestVersion?: string
  hasUpdate?: boolean
  upstream?: import('../packages/contracts/magpie-upstream').MagpieUpstreamStatus
  rtk?: {
    connected: boolean
    path?: string | null
    version?: string | null
    gain?: {
      commands: number
      input: number
      saved: number
      pct: number
    } | null
    days?: Array<{
      date: string
      commands: number
      input: number
      saved: number
      pct: number
    }>
    latest?: string | null
    agents?: Array<{
      id: string
      name: string
      icon: string
      on: boolean
      blocked?: string
    }>
    url?: string
  }
}

export type ConsoleVersionInfo = {
  version: string
  releaseId?: string
  releaseDate?: string
}

export type VersionsData = {
  cpa: CpaVersionInfo
  console: ConsoleVersionInfo
}

export type ModelSyncResult = {
  ok: boolean
  result: {
    addedModels: string[]
    totalModels: number
    channelCount: number
    source: string
    syncedAt: string
  }
}

export type RtkPlaneId = 'kernel' | 'relay' | 'local'

/** 未配置 / 配置了但不可达 / 未授权 / 路由不存在 / 可用 —— UI 必须如实区分。 */
export type RtkPlaneState = 'available' | 'not_configured' | 'unreachable' | 'unauthorized' | 'not_supported'

export type RtkPlaneProbe = {
  id: RtkPlaneId
  available: boolean
  configured: boolean
  state: RtkPlaneState
  reason: string
  detail?: string
}

export type RtkAgentStatus = {
  id: string
  name: string
  icon: string
  on: boolean
  supported: boolean
  plane: RtkPlaneId
  installed?: boolean
  blocked?: string
}

export type RtkBackupSummary = { id: string; at: string; files: string[] }

export type RTKStatusResponse = {
  /** 权威读取平面：kernel → relay → local，第一个真正应答的。 */
  plane: RtkPlaneId
  planes: RtkPlaneProbe[]
  connected: boolean
  path: string | null
  version: string | null
  gain: {
    commands: number
    input: number
    saved: number
    pct: number
  } | null
  days: Array<{
    date: string
    commands: number
    input: number
    saved: number
    pct: number
  }>
  latest: string | null
  agents: RtkAgentStatus[]
  /** 本机（控制台所在机器）的 agent 开关状态，独立于权威平面。 */
  localAgents: RtkAgentStatus[]
  local: { connected: boolean; path: string | null; version: string | null }
  backups: RtkBackupSummary[]
  writeMode: 'local' | 'confirm' | 'off'
  remoteWriteEnabled: boolean
  kernelWriteEnabled: boolean
  installEnabled: boolean
  install?: string
  url: string
  /** 权威平面读取失败并回退时的原因，如实展示。 */
  error?: string
}

export type RTKToggleResponse = RTKStatusResponse & {
  ok: true
  mechanism?: 'rtk-cli' | 'hooks-json'
  backup?: string
  fallbackReason?: string
  collateralRestored?: string[]
}

export type RTKRollbackResponse = RTKStatusResponse & { ok: true; backupId: string; restored: string[] }

export type OAuthStartResult = {
  status: string
  url: string
  state: string
  user_code?: string
  flow?: string
  expires_in?: number
  provider: string
}

export type OAuthStatusResult = {
  status: 'ok' | 'wait' | 'error' | string
  error?: string
}

export type BootstrapData = {
  keys: ApiKeyItem[]
  groups: Group[]
  models: string[]
  retentionDays: number
  quotaTimeZone: string
  gatewayModelAccess: GatewayModelAccess
  credentialUploadLimits: { maxBytes: number; maxEntries: number; maxEntryBytes: number; maxExpandedBytes: number }
  /** CPA 控制面暂不可用时为 true：Key 与额度仍是本地最新，分组/模型目录沿用上次结果。 */
  degraded?: boolean
  degradedReason?: string
  versions?: VersionsData
}

export type RequestDetailItem = {
  requestId: string
  timestamp: string
  provider?: string
  modelGroup?: string
  model: string
  endpoint: string
  success: number | boolean
  statusCode?: number
  latencyMs: number
  ttftMs?: number
  inputTokens?: number
  outputTokens?: number
  reasoningTokens?: number
  cachedTokens?: number
  cacheWriteTokens?: number
  totalTokens?: number
  errorDetail?: string
  errorCategory?: string
  upstreamRequestId?: string
  source?: string
  authIndex?: string
  reasoningEffort?: string
  serviceTier?: string
  clientType?: string
  userAgent?: string
  clientIp?: string
  keyName?: string | null
  freshInputTokens?: number
  cacheReadTokens?: number
  promptTokens?: number
  hitRate?: number | null
  costUsd?: number | null
}

export type AnalyticsData = {
  days: number
  summary: { requests: number; tokens: number; avgLatency: number; errorRate: number }
  trend: Array<{ bucket: string; requests: number; tokens: number; errors: number }>
  groups: Array<{ name: string; requests: number; tokens: number }>
  models: Array<{ name: string; requests: number; tokens: number }>
  keyUsage: Array<{ id: string; name: string; requests: number; tokens: number; errorRate: number }>
  latency: Array<{ name: string; requests: number; avgLatency: number; avgTtft: number; p95: number }>
  statusCodes: Array<{ code: number; count: number }>
  errorCategories: Array<{ category: string; count: number }>
  /** 调用方分布：哪些客户端在用、各自多少请求与 token */
  clients: Array<{ type: string; label: string; requests: number; tokens: number; avgLatency: number; errorRate: number }>
  requests: RequestDetailItem[]
}

export type DashboardData = Pick<AnalyticsData, 'days' | 'summary' | 'trend'> & {
  generatedAt?: string
  sourceWatermark?: string | null
  stale?: boolean
  source?: 'data-plane' | 'sqlite'
}

export type ChartsData = Pick<AnalyticsData, 'days' | 'trend' | 'groups' | 'models' | 'latency' | 'statusCodes' | 'errorCategories'>

export type UsageProviderOverview = {
  id: string
  label: string
  hasData: boolean
  requests: number
  totalTokens: number
  newInputTokens: number
  outputTokens: number
  cacheTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  estimatedCostUsd: number | null
  hasPartialCost: boolean
  topModel: string | null
  models: number
}

export type UsageDailyPoint = {
  day: string
  totalTokens: number
  intensity: 0 | 1 | 2 | 3 | 4
  requests: number
  newInputTokens: number
  outputTokens: number
  cacheTokens: number
  cacheWriteTokens: number
  errors: number
  estimatedCostUsd: number | null
  topModels: Array<{ model: string; totalTokens: number }>
}

export type UsageOverviewData = {
  days: number
  trackingSince: string | null
  totalTokens: number
  newInputTokens: number
  outputTokens: number
  cacheTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  requests: number
  activeDays: number
  estimatedCostUsd: number | null
  hasPartialCost: boolean
  cacheShare: number | null
  providers: UsageProviderOverview[]
  daily: UsageDailyPoint[]
  bestDay: UsageDailyPoint | null
  unpricedModels: string[]
  models: Array<{
    model: string
    provider: string
    requests: number
    newInputTokens: number
    outputTokens: number
    cacheTokens: number
    cacheWriteTokens: number
    reasoningTokens: number
    totalTokens: number
    activeDays: number
    costUsd?: number | null
  }>
}

export type QuotaSeverity = 'normal' | 'warning' | 'critical'

export type QuotaWindow = {
  id: string
  label: string
  usedPercent: number
  resetsAt: string | null
  windowSeconds: number | null
  severity: QuotaSeverity
  scope: string | null
}

export type AccountQuota = {
  plan: string
  tier: string
  resetCredits: { available: number; applicable: number; entries: Array<{ id: string; expiresAt: string }> } | null
  windows: QuotaWindow[]
  error: string | null
}

export type ModelPricingTier = {
  above: number
  input: number
  output: number
  cacheRead: number
  cacheWrite?: number
}

export type ModelPricing = {
  /** 美元 / 每百万 token。图片模型使用 API 返回的文本、图像输入与图像输出 token 结算。 */
  input: number
  output: number
  cacheRead: number
  cacheWrite?: number
  tiers?: ModelPricingTier[]
  from?: string
  until?: string
  note?: string
  unit: 'token'
}

export type ModelCost = {
  model: string
  pricing: ModelPricing | null
  requests: number
  newInputTokens: number
  outputTokens: number
  cacheTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  totalTokens: number
  inputCostUsd: number | null
  outputCostUsd: number | null
  cacheCostUsd: number | null
  cacheWriteCostUsd: number | null
  totalCostUsd: number | null
  priced: boolean
}

export type BreakdownTotals = {
  requests: number
  newInputTokens: number
  outputTokens: number
  cacheTokens: number
  cacheWriteTokens: number
  totalTokens: number
  inputCostUsd: number
  outputCostUsd: number
  cacheCostUsd: number
  cacheWriteCostUsd: number
  totalCostUsd: number
}

export type UsagePageCoreData = UsageOverviewData & {
  keyId: string
  quotaTimeZone: string
}

export type UsageKeySummary = {
  id: string
  name: string
  totals: BreakdownTotals
  hasUnpricedModels: boolean
}

export type UsageKeySummariesData = {
  days: number
  keySummaries: UsageKeySummary[]
}

export type UsagePageData = UsagePageCoreData & UsageKeySummariesData

export type UsageBreakdownData = {
  days: number
  keyId: string
  quotaTimeZone: string
  models: ModelCost[]
  totals: BreakdownTotals
  unpricedModels: string[]
  keys: Array<{ id: string; name: string; models: ModelCost[]; totals: BreakdownTotals; unpricedModels: string[] }>
}

export type CacheGroupStat = {
  label: string
  dialect: 'anthropic' | 'openai' | 'mixed'
  requests: number
  freshInputTokens: number
  cacheReadTokens: number
  /** Anthropic 缓存写入段，按 1.25x 输入价计费 */
  cacheWriteTokens: number
  outputTokens: number
  promptTokens: number
  hitRate: number | null
  costUsd: number | null
  wastedUsd: number | null
  overCeilingRequests: number
}

export type CacheWorstRequest = {
  timestamp: string
  model: string
  endpoint: string
  keyName: string | null
  source: string
  freshInputTokens: number
  cacheReadTokens: number
  promptTokens: number
  hitRate: number | null
  costUsd: number | null
  wastedUsd: number | null
  overCeiling: boolean
  latencyMs: number
}

export type CacheAnalyticsData = {
  days: number
  model: string
  models: string[]
  ceiling: number
  overall: CacheGroupStat
  byModel: CacheGroupStat[]
  byChannel: CacheGroupStat[]
  byEndpoint: CacheGroupStat[]
  byContextBand: CacheGroupStat[]
  /** 按调用方（Pi / Claude Code / Codex …）聚合 */
  byClient: CacheGroupStat[]
  worstRequests: CacheWorstRequest[]
}

export type TrendBucket = {
  bucket: string
  requests: number
  freshInputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  hitRate: number | null
  costUsd: number | null
  wastedUsd: number | null
}

export type CacheTrendProvider = { id: string; label: string; requests: number }

export type CacheTrendData = {
  hours: number
  model: string
  client?: string
  keyId?: string
  provider?: string
  clients?: Array<{ type: string; label: string; requests: number }>
  /** 当前模型 + Key 口径下各渠道的请求量，供渠道筛选器展示 */
  providers?: CacheTrendProvider[]
  models: string[]
  bucketSeconds: number
  points: TrendBucket[]
}

export type LiveUsageEvent = {
  requestId: string
  timestamp: string
  provider?: string
  modelGroup?: string
  model: string
  endpoint: string
  statusCode?: number
  ttftMs?: number
  keyName: string | null
  /** api_keys.key_hash；未关联 Key 时为 null */
  keyHash?: string | null
  source: string
  /** 调用方分类与原始 UA */
  clientType: string
  userAgent: string
  success: boolean
  latencyMs: number
  /** 原始 CPA token 字段，详情面板同时展示原始输入/输出与归一化缓存口径。 */
  inputTokens: number
  cachedTokens: number
  reasoningTokens: number
  totalTokens: number
  freshInputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  outputTokens: number
  promptTokens: number
  hitRate: number | null
  costUsd: number | null
  overCeiling: boolean
}

export type QuotaShareKey = {
  keyId: string
  keyName: string
  requests: number
  promptTokens: number
  outputTokens: number
  /** 占本窗口全部 Key token 体量的比例，0–1 */
  share: number
}

export type QuotaShareWindow = { windowStart: number; keys: QuotaShareKey[] }

export type MonitorData = {
  accounts?: Array<Record<string, any>>
  /** 各上游套餐窗口内，每个 Key 的 token 消耗占比 */
  quotaShare?: Partial<Record<'codex' | 'claude' | 'antigravity', QuotaShareWindow>> | null
}
