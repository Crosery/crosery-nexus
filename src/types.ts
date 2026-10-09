import type { ModelKind } from './lib/modelKind.js'

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
  /** RTK 中转压缩：只对开启的 Key 生效（服务端旧版本没有这个字段）。 */
  rtkCompress?: boolean
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
  /** 上游协议：'responses' = Responses 原生中继渠道；'claude' = 挂在 Anthropic 端点；其余 'openai'。 */
  protocol?: 'openai' | 'claude' | 'responses'
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

/** 单个价格来源的单价（task-79；金额单位由 `unit` 说明，缺失字段一律 undefined，不补 0）。 */
export type PriceSourceEntry = {
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
  unit?: string
  sourceId?: string
  fetchedAt?: number
}

export type ModelEntry = {
  id: string
  pricing: ModelPricing | null
  sources: ModelSource[]
  enabledSources: number
  contested: boolean
  /** 双源价格：openrouter / models.dev 各自保存，缺失即缺席（**不写 0 冒充免费**）。 */
  pricingSources?: Partial<Record<'models.dev' | 'openrouter', PriceSourceEntry>>
  /** 两个来源都没有价格 ⇒ true。UI 写「未收录」而不是 0。 */
  unpriced?: boolean
  /** 仅出现在目录、网关上不可用 ⇒ false。 */
  availableOnGateway?: boolean
  /** 按输出分的模型类型（server/modelKind.ts）；旧服务端没有这个字段。 */
  kind?: ModelKind
}

export type ModelIndexData = {
  models: ModelEntry[]
  channels: ChannelItem[]
  credentials: CredentialItem[]
  /** 双源价格的整体状态（task-79）：来源 ok/entries/fetchedAt、降级原因、加载时间。 */
  sourceStatus?: {
    sources?: Partial<Record<'models.dev' | 'openrouter', { ok?: boolean; fetchedAt?: number; entries?: number; error?: string }>>
    loadedAt?: number | null
    degraded?: string[]
    models?: number
  }
}

/**
 * 网关是否真的在执行 Key 级模型隔离。'unavailable' 表示网关没有这个能力
 * （CPA v7.2.140 起上游移除了 api-key-model-access），分组配置仍会保存，
 * 但不会在网关生效——UI 必须说清楚，不能让人以为限制还在。
 */
export type GatewayModelAccess = 'unknown' | 'available' | 'unavailable'

export type CpaVersionInfo = {
  version: string
  commit: string
  buildDate: string
  latestVersion?: string
  hasUpdate?: boolean
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


/** 「自动更新」（`GET/PUT /api/autoupdate`，server/autoupdate.ts）：开关 + 定时任务记下的结果，一句话说清。 */
export type AutoTone = 'ok' | 'warn' | 'bad' | 'idle'
export type AutoReason = { code: string; text: string }
export type AutoSchedulerMode = 'auto' | 'check-only' | 'missing' | 'unsupported'
export type RtkAutoView = {
  available: boolean
  enabled: boolean
  scheduler: AutoSchedulerMode
  state: 'off' | 'no-scheduler' | 'check-only' | 'missing' | 'homebrew' | 'up-to-date' | 'pending' | 'held' | 'upgraded' | 'error' | 'unknown'
  tone: AutoTone
  line: string
  brief: string
  local: string | null
  latest: string | null
  method: string | null
  reasons: AutoReason[]
  lastUpgrade: { from: string | null; to: string; at: string; result: string } | null
  checkedAt: string | null
}
export type AutoupdateView = { rtk: RtkAutoView }

/** 「网关内核」（`GET/PUT /api/kernels`，server/kernels.ts，中转站）：CPA 的上游、候选、自动更新与回滚。 */
export type KernelWindow = { start: string; end: string; tz: string; label: string }
export type KernelView = {
  id: 'cpa'
  name: string
  role: 'serving'
  roleText: string
  env: 'preview' | 'production' | null
  version: string | null
  online: boolean | null
  upstream: { latest: string | null; line: string | null; heldNewer: string | null; checkedAt: string | null } | null
  candidate: { label: string; tone: AutoTone; text: string } | null
  enabled: boolean
  state: string
  tone: AutoTone
  line: string
  reasons: AutoReason[]
  last: { text: string; tone: AutoTone; at: string } | null
  rollback: { to: string } | null
  checkedAt: string | null
  /** CPA 候选走到哪：预发布试运行 → 浸泡/验收通过 → 正式已暂存 → 已装上 / 没过 */
  pipeline: { stage: string; tone: AutoTone; text: string } | null
  checks: { last: string | null; next: string | null }
  error: { text: string; at: string | null } | null
}
export type KernelsView = { available: boolean; reason: string | null; env: 'preview' | 'production' | null; scheduler: 'installed' | 'missing' | 'stale'; window: KernelWindow; kernels: KernelView[] }

/* ── C1 session & login (CONTRACTS.md) ─────────────────────────────────────────────────────────── */

export type SessionRole = 'admin' | 'key'

export type SessionInfo =
  | { authenticated: false }
  | { authenticated: true; role: SessionRole; user?: { name: string }; key?: { name: string; masked: string; ref?: string } }

export type LoginResult = { ok: true; role: SessionRole }

/** 401 / 429 bodies of POST /api/login. */
export type LoginErrorCode = 'invalid_credentials' | 'key_invalid' | 'key_disabled' | 'rate_limited'

/* ── C2 key-user data (/api/me*) ────────────────────────────────────────────────────────────────── */

export type MeQuotaWindow = {
  limitUsd: number | null
  spentUsd: number
  ratio: number | null
  resetsAt: string | null
  exceeded: boolean
}

export type MeHourPoint = { hour: string; requests: number; errors: number; tokens: number; costUsd: number | null }

export type MeOverview = {
  key: {
    name: string
    masked: string
    /** opaque per-key id (same as /api/session `key.ref`); absent on a server not yet restarted */
    ref?: string
    enabled: boolean
    blockedReason: string | null
    /** always [] for key users: channel names are internal topology */
    groups: string[]
    /** 0 / null = 不限 */
    totalConcurrency: number | null
    createdAt: string
    lastUsedAt: string | null
  }
  quota: { timeZone: string; daily: MeQuotaWindow; weekly: MeQuotaWindow; total: MeQuotaWindow }
  today: { requests: number; errors: number; tokens: number; costUsd: number | null; unpricedRequests: number; hourly: MeHourPoint[] }
  generatedAt: string
  /** channel groups unreadable → `today` is unfiltered */
  degraded?: 'provider_filter_unavailable'
}

export type MeUsageTotals = { requests: number; errors: number; tokens: number; costUsd: number | null; unpricedRequests: number }

export type MeUsage = {
  days: number
  daily: UsageDailyPoint[]
  totals: MeUsageTotals
  models: Array<{ model: string; requests: number; tokens: number; costUsd: number | null; errors: number }>
  trackingSince: string | null
}

/**
 * `/api/me/usage/daily?year=recent|YYYY` — the heatmap's year of days for the session key only (same engine as the
 * admin `/api/usage-daily`; shape = ui/viz/heatModel HeatSeries).
 */
export type MeUsageDaily = {
  range: { year: 'recent' | number; from: string; to: string; timeZone: string; offsetMinutes: number }
  history: { retainedFrom: string; firstDay: string | null; retentionDays: number }
  years: number[]
  days: Array<{
    day: string; requests: number; errors: number; tokens: number; costUsd: number | null
    freshInput: number; output: number; cacheRead: number; cacheWrite: number
    topModels: Array<{ model: string; tokens: number }>
  }>
  totals: { requests: number; errors: number; tokens: number; costUsd: number | null; costEstimated: boolean; unpricedRequests: number }
  generatedAt: string
}

export type MeRequestItem = {
  id: string
  timestamp: string
  model: string
  endpoint: string
  success: boolean
  status: number | null
  latencyMs: number | null
  ttftMs: number | null
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number | null
  costUsd: number | null
  errorCategory: string | null
  requestId: string | null
}

export type MeRequestsPage = { items: MeRequestItem[]; nextBefore: string | null }

export type MeModelPricing = {
  inputPerM: number
  outputPerM: number
  cacheReadPerM: number | null
  cacheWritePerM: number | null
  source: 'models.dev' | 'openrouter' | 'gateway' | null
}

export type MeModel = {
  id: string
  name: string | null
  family: string | null
  contextWindow: number | null
  maxOutput: number | null
  reasoning: boolean | null
  /** by output (server/modelKind.ts); absent on servers before the field existed */
  kind?: ModelKind
  pricing: MeModelPricing | null
  /** {0,0} when unused; null only when channel groups cannot be read */
  used7d: { requests: number; tokens: number } | null
}

export type MeModels = { models: MeModel[]; reason?: null | 'key_blocked' | 'gateway_unavailable'; generatedAt: string }

export type MeConnect = { baseUrl: string; anthropicBaseUrl: string | null; masked: string }

/* ── C3 sync center ─────────────────────────────────────────────────────────────────────────────── */

export type SyncResult = 'ok' | 'partial' | 'error' | 'skipped'
export type SyncJobState = 'idle' | 'running' | 'backoff' | 'disabled' | 'error' | 'unknown'

export type SyncJob = {
  id: string
  label: string
  kind: 'in-process' | 'external'
  intervalMs: number | null
  lastRunAt: string | null
  lastFinishedAt: string | null
  nextRunAt: string | null
  state: SyncJobState
  lastResult: SyncResult | null
  lastError: string | null
  summary: string | null
  backoffUntil: string | null
  backoffLevel: number
  requests24h: number | null
  history: Array<{ at: string; result: SyncResult; durationMs: number | null }>
  canRunNow: boolean
  runCooldownUntil: string | null
}

export type SyncPolicy = {
  globalUpstreamConcurrency: number
  minIntervalPerHostMs: number
  backoff: { factor: number; baseMs?: number; maxMs: number }
  jitterPct: number
}

export type SyncStatus = { policy: SyncPolicy; jobs: SyncJob[]; generatedAt: string }

export type SyncRunAccepted = { accepted: true; jobId: string }

/* ── RTK relay (GET/POST /api/rtk/relay, server/rtkRelay.ts) ─────────────────────────────────────── */

export type RtkRelayTally = { savedTokens: number; requests: number; errors: number }

export type RtkRelayStatus = {
  /** global switch; a Key is compressed only when it also opted in */
  enabled: boolean
  /** the relay process (crosery-rtk-relay unit) as its status file reports it; down = expected here but not running */
  listener: {
    state: 'off' | 'listening' | 'draining' | 'stopped' | 'failed' | 'down'
    port: number
    target: string
    error: string
    inFlight: number
    updatedAt: number | null
  }
  optedInKeys: number
  /** saved = estimated input tokens removed (UTF-8 bytes / 4); errors = compression skipped, request forwarded as is */
  today: RtkRelayTally
  total: RtkRelayTally
}

/* ── C4 RTK global switch ───────────────────────────────────────────────────────────────────────── */

export type RtkGlobalStatus = {
  /** null = mixed / unknown */
  on: boolean | null
  plane: RtkPlaneId | null
  agents: { supported: number; on: number }
  savings: { pct: number | null; tokens: number | null } | null
  writable: boolean
  reason: string | null
  /** only with reason `rtk_binary_missing`: the manual install command */
  installHint?: string
}

/* ── C6 gateway pulse (header live edge + statusline) ───────────────────────────────────────────── */

export type PulseData = {
  windowSec: number
  /** one entry per second, oldest first; `t` = epoch milliseconds of the second's start */
  samples: Array<{ t: number; rps: number; err: number }>
  /** requests per minute over the last 5 minutes; null when there is no usage source */
  rpm: number | null
  p95Ms: number | null
  /** success ratio 0–1 over the last 5 minutes; null with no requests */
  successRate: number | null
  generatedAt: string
}

/* ─────────────── Proxy pool (/api/proxies, PROXY-SPEC). Every value is masked server-side. ─────────────── */

export type ProxyKind = 'url' | 'mihomo'
export type ProxyProtocol = 'http' | 'https' | 'socks5' | 'ss' | 'ssr' | 'vmess' | 'vless' | 'trojan' | 'hysteria2' | 'tuic' | 'wireguard'
export type ProxySourceKind = 'manual' | 'clash' | 'uri' | 'subscription' | 'migrated' | 'preset' | 'pool-import'
export type ProxyScope = 'anywhere' | 'consumer-host' | 'console-host'
export type ProxyKernelState = 'unavailable' | 'idle' | 'starting' | 'running' | 'degraded' | 'failed' | 'stopped'

export type ProxyKernelView = {
  state: ProxyKernelState
  version?: string | null
  /** zh, scrubbed */
  reason?: string | null
  bindFailed?: string[]
  /** further kernel-module fields (pid, adopted, crashes, nextRestartAt, …), primitives only */
  [key: string]: unknown
}

/** check states: ok, auth-expected (✓) / region-blocked, challenge, blocked, service-error, proxy-auth-failed, proxy-down, upstream, dns, tls, timeout (✗) */
export type ProxyHealthCell = {
  state: string
  ms: number | null
  at: string
  hosts: Array<{ host: string; state: string; ms: number | null; status: number | null }>
}

export type ProxyHealth = {
  exit: { ip?: string; country?: string; state?: string; ms?: number; at: string } | null
  services: Record<string, ProxyHealthCell>
  lastAt?: string
}

export type ProxyEntryView = {
  id: string
  name: string
  nameAuto: boolean
  kind: ProxyKind
  protocol: ProxyProtocol
  /** `socks5://***@host:port` (url) or `vmess://host:port` (node) */
  display: string
  server: string
  serverPort: number
  /** local socks5 port of a mihomo entry */
  port: number | null
  scope: ProxyScope
  assignable: boolean
  unassignableReason: string | null
  source: ProxySourceKind
  subscriptionId: string | null
  /** 订阅中已移除 */
  stale: boolean
  /** 外部本机 */
  external: boolean
  tags: string[]
  enabled: boolean
  validity: 'ok' | 'invalid' | 'unverified'
  invalidReason: string | null
  usedBy: { total: number; byProvider: Record<string, number> }
  health: ProxyHealth | null
  createdAt: string
  updatedAt: string
}

export type ProxySubscriptionView = {
  id: string
  name: string
  /** `https://host/***` */
  maskedUrl: string
  intervalH: number
  lastFetchAt: string | null
  nextAt: string | null
  failures: number
  error: string | null
  info: { upload?: number; download?: number; total?: number; expire?: number } | null
  nodeCount: number
}

export type ProxyPoolData = {
  backend: 'cpa'
  cpaSameHost: boolean
  kernel: ProxyKernelView
  ports: { base: number; count: number; last: number; listenerAuth: boolean }
  /** why the pool file is read-only (unknown version, corrupt), or null */
  readOnly: string | null
  summary: { entries: number; enabled: number; mihomo: number; needsKernel: number; inUse: number; accountsLinked: number; invalid: number; subscriptions: number }
  entries: ProxyEntryView[]
  subscriptions: ProxySubscriptionView[]
  migration: { firstRunAt: string | null; firstRunImported: number | null; lastScanAt: string | null; pending: { exits: number; accounts: number; at: string } | null; ignored: number }
  default: { mode: 'inherit' | 'direct' | 'url' | 'invalid' | 'unknown' | 'unsupported'; entryId: string | null; masked: string | null; at: string | null }
  signinNote: string
}

export type ProxyOption = {
  id: string
  name: string
  protocol: ProxyProtocol
  country: string | null
  assignable: boolean
  reason: string | null
  /** service → check state */
  health: Record<string, string>
  usedBy: number
  tags: string[]
}

export type ProxyOptionsData = { builtins: Array<{ id: 'inherit' | 'direct'; name: string }>; options: ProxyOption[] }

export type ProxyAccountRow = {
  /** `cpa:<credential>`, `cpa:global` */
  ref: string
  kind: 'credential' | 'global'
  provider: string
  name: string
  label: string
  disabled: boolean
  mode: 'inherit' | 'direct' | 'url' | 'invalid' | 'unknown'
  masked: string | null
  entryId: string | null
  entryName: string | null
  /** CPA mode: when the value was last read (null = live) */
  observedAt: string | null
  assignable: boolean
  restorable: boolean
}

export type ProxyAccountsData = { backend: 'cpa'; cpaSameHost: boolean; signinNote: string; accounts: ProxyAccountRow[] }

export type ProxyPreviewRow = {
  key: string
  name: string
  type: string
  protocol: ProxyProtocol | null
  kind: ProxyKind | null
  server: string | null
  serverPort: number | null
  external: boolean
  status: 'new' | 'duplicate' | 'update' | 'unsupported' | 'invalid' | 'info'
  reason: string | null
  entryId: string | null
  duplicateOf: string | null
  subscriptionKey: string | null
}

export type ProxyPreviewSubscription = {
  key: string
  name: string
  maskedUrl: string
  source: 'pasted' | 'provider' | 'export'
  ok: boolean
  error: string | null
  nodeCount: number
  info: ProxySubscriptionView['info']
  intervalH: number
  insecureHttp: boolean
  existingId: string | null
}

export type ProxyPreview = {
  previewId: string
  expiresAt: string
  format: 'export' | 'clash' | 'uri' | 'base64' | 'subscription'
  counts: Record<ProxyPreviewRow['status'], number>
  byProtocol: Record<string, number>
  /** mihomo rows that need the kernel to be usable */
  needsKernel: number
  kernelAvailable: boolean
  ignoredSections: string[]
  notes: string[]
  rows: ProxyPreviewRow[]
  subscriptions: ProxyPreviewSubscription[]
  assignments: number
}

export type ProxyImportResult = {
  added: number
  updated: number
  skipped: number
  ids: string[]
  subscriptions: Array<{ key: string; id: string; added: number; updated: number; removed: number; stale: number }>
  /** export files: accounts to re-assign (dry-run; send the pending ones to assign) */
  assignPlan: Array<{ account: string; accountRef: string; entryId: string; status: 'linked' | 'pending' }>
  entries: ProxyEntryView[]
}

export type ProxyAssignResult = {
  target?: string
  results: Array<{ account: string; status: 'updated' | 'unchanged' | 'failed' | 'restored'; code?: string; error?: string }>
  updated: number
  failed: number
  warnings?: string[]
}

export type ProxyMigrationExit = {
  key: string
  name: string
  maskedUrl: string
  action: 'create' | 'link' | 'unchanged' | 'skip'
  reason: string | null
  external: boolean
  source: 'migrated' | 'preset'
  entryId: string | null
  accounts: { total: number; byProvider: Record<string, number> }
  /** non-account references: global / channel / key */
  others: string[]
}

export type ProxyMigrationPreview = {
  dryRun: true
  scanId: string | null
  at: string
  totals: { accounts: number; inherit: number; direct: number; url: number; invalid: number; exits: number; create: number; link: number; unchanged: number; skip: number }
  inheritByProvider: Record<string, number>
  directByProvider: Record<string, number>
  sources: { credentials: number; readErrors: number; channelError: boolean; presets: number }
  exits: ProxyMigrationExit[]
  cooldownMs: number
}

export type ProxyMigrationApplied = { dryRun: false; summary: string; created: number; linked: number; unlinked: number }

export type ProxyAssignTarget = 'inherit' | 'direct' | string

/* ───── account egress (/accounts): GET /api/proxies/egress, …/egress/account (server/proxyEgress.ts) ───── */
export type EgressService = 'claude' | 'openai' | 'google'
export type EgressMode = 'inherit' | 'direct' | 'url' | 'invalid' | 'unknown'
export type EgressCheck = { state: string; ms: number | null; at: string | null }
export type EgressEntry = {
  id: string
  name: string
  kind: ProxyKind
  protocol: ProxyProtocol
  country: string | null
  /** the exit probe's own failure (proxy down…), null when it answered or never ran */
  exitState: string | null
  checks: Partial<Record<EgressService, EgressCheck>>
  checkedAt: string | null
  assignable: boolean
  reason: string | null
  usedBy: number
}
/** an account's exit as the pool knows it; `masked` = `scheme://***@host:port` for addresses */
export type EgressAccount = { mode: EgressMode; entryId: string | null; masked: string | null; at: string | null }
export type EgressData = {
  backend: 'cpa'
  cpaSameHost: boolean
  kernel: { state: ProxyKernelState }
  /** whether accounts here can take their own exit */
  accountProxy: { supported: boolean; reason: string | null }
  /** what 继承 resolves to: CPA's global proxy */
  default: { mode: EgressMode; entryId: string | null }
  signin: { via: 'cpa-global'; exit: { mode: EgressMode | 'unsupported'; entryId: string | null }; perSignin: false; note: string }
  entries: EgressEntry[]
  /** `cpa:<credential>` */
  accounts: Record<string, EgressAccount>
  /** index-aligned with /api/channels proxyPresets: the pool entry holding the same address, if any */
  presets: Array<{ label: string; entryId: string | null }>
}
/** the authoritative one-account read: never the URL itself */
export type EgressRead = EgressAccount & { ref: string; entryName: string | null; preset: number | null }

/** POST /api/credentials/upload (CPA engine): one row per file in the upload; credential contents never come back. */
export type CredentialUploadResult = {
  traceId: string
  total: number
  uploaded: number
  skipped: number
  failed: number
  items: Array<{ name: string; label?: string; ok: boolean; skipped?: boolean; code?: string; message?: string }>
}
