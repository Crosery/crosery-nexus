import crypto from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import cookieParser from 'cookie-parser'
import { parseUsageSnapshot, type UsageSnapshot } from '../packages/contracts/index.js'
import { config } from './config.js'
import { addAudit, db } from './db.js'
import { addProviderApiKey, apiCall, cancelOAuthSession, CLAUDE_PROFILE_URL, CLAUDE_USAGE_URL, claimClaudeResetCredit, claudeHeaders, clearAuthFileCooldown, consumeCodexResetCredit, getAuthFileProxy, getCodexResetCredits, getConsoleVersion, getCPAKeys, getCpaVersion, getGlobalProxy, getOAuthStatus, hashKey, isUnsupportedManagementEndpoint, listAuthFiles, maskKey, pinProbeKeyChannels, registerProbeKeys, replaceCPAKeys, startOAuthLogin, submitOAuthCallback, uploadAuthFile } from './cpa.js'
import { createChannel, discoverChannelModels, invalidateGatewaySnapshot, listChannels, listCredentials, listGroupCatalog, listGroups, listGroupsForReporting, listModelIndex, pruneStaleChannels, removeChannel, removeCredential, setChannelEnabled, setChannelModelEnabled, setCredentialEnabled, setCredentialProxy, setModelSourceEnabled } from './channels.js'
import { createSessionGuard, setKeySessionLookup } from './auth.js'
import { errorResponseBody, keyLoginRateLimitKey, publicUsageKnownGood, publicUsageRateLimiter } from './security.js'
import { findKeyByPresentedValue, keySessionState } from './keySession.js'
import { loginRoute, logoutRoute, sessionProbe } from './sessionRoutes.js'
import { createMeRouter } from './meRoutes.js'
import { registerPulseRoutes } from './pulseRoutes.js'
import { registerChannelHealthRoutes } from './channelHealth.js'
import { parseChannelProtocol } from './channelDiscovery.js'
import { registerModelInsightsRoutes } from './modelInsights.js'
import { registerKeysViewRoutes } from './keysView.js'
import { registerConnectRoutes } from './connectRoutes.js'
import { registerPerfRoutes } from './perfReports.js'
import { registerCacheSummaryRoutes } from './cacheSummary.js'
import { registerOverviewRoutes } from './overviewRoutes.js'
import { registerUsageWorkspaceRoutes } from './usageWorkspaceRoutes.js'
import { registerMagpieVersionRoutes } from './magpieVersion.js'
import { registerAutoupdateRoutes } from './autoupdate.js'
import { kernelPaths, registerKernelRoutes } from './kernels.js'
import { accountsService, registerAccountsRoutes } from './accountsRoutes.js'
import { createGatewaySettingsService, registerGatewaySettingsRoutes } from './gatewaySettings.js'
import { proxyService, registerProxyRoutes } from './proxyRoutes.js'
import { installCredentialProxyHook, registerProxyPoolJobs } from './proxyPoolJobs.js'
import { installProxyChecks } from './proxyCheckPool.js'
import { startManagedMihomo } from './mihomoPool.js'

/** 已知错误 reason（task-66）：`请求格式不正确` 以前无法区分「JSON 坏」与「业务拒绝」。 */
const knownErrorReason = (error: unknown, status: number): string | undefined => {
  const type = String((error as { type?: unknown })?.type || '')
  if (type === 'entity.parse.failed') return 'invalid_json'
  if (type === 'entity.too.large') return 'payload_too_large'
  if (status === 413) return 'payload_too_large'
  return undefined
}

/** 机器可读的 reason（形如 `credential_not_found` 的纯代码）才放进响应体，其它错误文案不进。 */
const reasonField = (error: unknown): { reason?: string } => {
  const message = error instanceof Error ? error.message : ''
  return /^[a-z][a-z0-9_]{2,63}$/.test(message) ? { reason: message } : {}
}

/** 路由错误响应：错误自带 4xx/5xx 状态就用它（例如「本地控制面不支持」是 501，不该被压成 400）。 */
const errorStatusOr = (error: unknown, fallback: number): number => {
  const status = Number((error as { status?: unknown })?.status)
  return Number.isInteger(status) && status >= 400 && status < 600 ? status : fallback
}
import { assertAuthFileName, authFilePath } from './magpieControl.js'
import { getKeyModelAccessState } from './managementCapability.js'
import { reconcileKeyModelAccess, reconcileNginxUnlimitedAccess, startSync, withKeyAccessLock } from './sync.js'
import { modelAvailabilityEnabled, probeChatModel, runModelAvailabilityRound } from './modelAvailability.js'
import { DEFAULT_OPEN_MODELS, defaultOpenModels, getCustomSharedModels, saveCustomSharedModels } from './keyModelAccess.js'
import { TOTAL_CONCURRENCY_RULE, validatePolicy } from './policy.js'
import { staticCacheControl, staticCompression } from './compression.js'
import { buildNamedAPIKey, deriveKeySlug } from './keyNaming.js'
import { activeProviderPredicate, activeProviderValues, parseCurrentOnly, scopedProviderPredicate } from './currentChannels.js'
import { canonicalModelSql } from './modelIdentity.js'
import { NEW_INPUT_SQL } from './tokenSql.js'
import { buildUsageBreakdown, type BreakdownRow } from './usageBreakdown.js'
import { buildCacheAnalytics, type CacheEventRow } from './cacheAnalytics.js'
import { addBufferedClient, clientCount, hasClientCapacity, heartbeat, sseClientLimit } from './liveStream.js'
import { clientTypeSql } from './clientAgent.js'
import { isMonitoredAccountType, normalizeAccountQuota } from './accountQuota.js'
import { accountQuotaSupport, clearAccountQuota, readAccountQuota, summarizeAccountQuota } from './accountQuotaReader.js'
import { maskProxyUserinfo, projectMonitorAccount } from './accountProjection.js'
import { normalizeResetCredits, resolveChatgptAccountId } from './codexAccount.js'
import { allowFreshInvalidation, mapWithConcurrency, syncRegistry } from './syncRegistry.js'
import { installSyncCenter } from './syncRoutes.js'
import { validateQuota, type KeyQuotaState } from './quota.js'
import { enforceQuotas, quotaStateFor, quotaStatesForAsync, resetQuotaWindow, type KeyQuotaRow } from './quotaEnforcer.js'
import { consumeKeyRevealToken, issueKeyRevealToken } from './keySecrets.js'
import { normalizeProxyUrl } from './proxyPresets.js'
import { boundedInteger, readBearerToken } from './publicUsage.js'
import { currentPublicRelease } from './releaseInfo.js'
import { cutoffEpochMs } from './timeRange.js'
import { RequestCoordinator } from './requestCoordinator.js'
import { SQLiteReadPool } from './sqliteReadWorker.js'
import { loadAnalyticsReport, loadCacheTrendReport, loadChartsLatencyReport, loadChartsReport, loadDashboardReport, loadUsageBreakdownReport, loadUsageKeySummariesReport, loadUsageOverviewReport, loadUsagePageReport } from './usageReports.js'
import { DataPlaneSnapshotClient, readDataPlaneRelayStatus } from './dataPlane.js'
import { providerPolicyHash, readDashboardSnapshot, relayAllowsDashboardSnapshots } from './dashboardSnapshot.js'
import { SnapshotStore } from './snapshotStore.js'
import { loadCacheLiveHistory } from './cacheLiveHistory.js'
import { ReportSnapshotCache } from './reportSnapshotCache.js'
import { loadMonitorQuotaShare } from './monitorQuotaShare.js'
import { loadModelCatalog, visibleModelIds, refreshSharedPricingIfStale } from './modelCatalog.js'
import { mergePriceSourceEntries } from './modelIndex.js'
import { pricingSourceStatus } from './pricing.js'
import { CredentialUploadError, prepareCredentialUpload } from './credentialUpload.js'
import { uploadCredentialBatch } from './credentialUploadBatch.js'
import { mergeCredentialUploadItems } from './credentialUploadMerge.js'
import { MultipartUploadError, receiveUploadFile } from './multipartUpload.js'
import { UploadGate, UploadGateBusyError } from './uploadGate.js'
import { startNativeResponsesServer } from './nativeResponses.js'
import { alignedCutoffMs, rollupHealthV2Operations, summarizeRollupHealthV2 } from './usageRollup.js'

const app = express()
const analyticsCoordinator = new RequestCoordinator<Record<string, unknown>>({
  ttlMs: 20_000,
  staleWhileRevalidateMs: 5 * 60_000,
})
const catalogCoordinator = new RequestCoordinator<Awaited<ReturnType<typeof listModelIndex>> | null>({ ttlMs: 15_000, staleWhileRevalidateMs: 5 * 60_000 })
const globalProxyCoordinator = new RequestCoordinator<string>({ ttlMs: 15_000, staleWhileRevalidateMs: 5 * 60_000 })
const credentialProxyCoordinator = new RequestCoordinator<string>({ ttlMs: 60_000, staleWhileRevalidateMs: 5 * 60_000 })
const monitorCoordinator = new RequestCoordinator<Record<string, unknown>>({ ttlMs: 60_000, staleWhileRevalidateMs: 10 * 60_000 })
const reportDatabaseFile = path.join(config.dataDir, 'console.db')
const usageReader = new SQLiteReadPool(reportDatabaseFile, config.reportReadWorkers)
const latencyReader = new SQLiteReadPool(reportDatabaseFile, 1)
const REPORT_FRESH_MS = 20_000
const REPORT_WARM_INTERVAL_MS = 15_000
const reportSnapshots = new ReportSnapshotCache(db, { maxStaleMs: 5 * 60_000 })
/**
 * 报表快照键（持久化在 SQLite）。v→+1 + 口径段（2026-10-02）：默认口径从「只看当前渠道」改成「全部渠道」，
 * 旧版本号下按当前渠道算出的快照不会被新口径读到；`current` / `all` 两种口径各自缓存。
 */
const scopeTag = (currentOnly: boolean) => (currentOnly ? 'current' : 'all')
const reportCacheKey = {
  usagePage: (days: number, keyId: string, policyHash: string, currentOnly = false) => `usage-page:v5:${scopeTag(currentOnly)}:${days}:${keyId}:${policyHash}`,
  usageKeys: (days: number, policyHash: string, currentOnly = false) => `usage-key-summaries:v3:${scopeTag(currentOnly)}:${days}:${policyHash}`,
  charts: (days: number, keyId: string, policyHash: string, currentOnly = false) => `charts:v3:${scopeTag(currentOnly)}:${days}:${keyId}:${policyHash}`,
  chartLatency: (days: number, keyId: string, policyHash: string, currentOnly = false) => `charts-latency:v3:${scopeTag(currentOnly)}:${days}:${keyId}:${policyHash}`,
  cacheTrend: (hours: number, model: string, clientType: string, keyId: string, provider: string, policyHash: string, currentOnly = false) =>
    `cache-trend:v4:${scopeTag(currentOnly)}:${hours}:${model}:${clientType}:${keyId}:${provider}:${policyHash}`,
  usageBreakdown: (days: number, keyId: string, policyHash: string, currentOnly = false) => `usage-breakdown:v3:${scopeTag(currentOnly)}:${days}:${keyId}:${policyHash}`,
}
const dataPlaneSnapshots = new DataPlaneSnapshotClient(
  new SnapshotStore<UsageSnapshot>(db, parseUsageSnapshot, { maxStaleMs: config.dataPlaneSnapshotMaxStaleMs }),
  {
    enabled: config.dataPlaneEnabled,
    baseUrl: config.dataPlaneBaseUrl,
    token: config.dataPlaneToken,
    timeoutMs: config.dataPlaneSnapshotTimeoutMs,
  },
)
const reportingContext = async () => {
  const groups = await listGroupsForReporting()
  const providers = activeProviderValues(groups)
  return { groups, providers, policyHash: providerPolicyHash(providers) }
}
const warmDefaultReports = async () => {
  const days = Math.min(7, config.usageRetentionDays)
  const reporting = await reportingContext()
  const core = await Promise.allSettled([
    reportSnapshots.run(reportCacheKey.usagePage(days, '', reporting.policyHash), REPORT_FRESH_MS, () =>
      loadUsagePageReport(usageReader, reporting.groups, days, '', config.quotaTimeZone)),
    reportSnapshots.run(reportCacheKey.charts(days, '', reporting.policyHash), REPORT_FRESH_MS, () =>
      loadChartsReport(usageReader, reporting.groups, days, '')),
    reportSnapshots.run(reportCacheKey.cacheTrend(24, '', '', '', '', reporting.policyHash), REPORT_FRESH_MS, () =>
      loadCacheTrendReport(usageReader, reporting.groups, 24, '', '', '', '')),
  ])
  const secondary = await Promise.allSettled([
    reportSnapshots.run(reportCacheKey.usageKeys(days, reporting.policyHash), REPORT_FRESH_MS, () =>
      loadUsageKeySummariesReport(usageReader, reporting.groups, days)),
    reportSnapshots.run(reportCacheKey.chartLatency(days, '', reporting.policyHash), REPORT_FRESH_MS, () =>
      loadChartsLatencyReport(latencyReader, reporting.groups, days, '')),
    // 账号页整页载荷与 /api/monitor 走同一个协调器与同一个任务观测：预热让「TTL 过期的第一打」
    // 落在后台定时循环里，而不是落在点开账号页的用户身上（冷扇出实测 11s，≈ 上游超时）。
    monitorCoordinator.run('monitor', () => syncRegistry.observe('account-quota', loadMonitorPayload, summarizeAccountQuota)),
  ])
  if ([...core, ...secondary].some((result) => result.status === 'rejected')) {
    console.warn('[report-warmup] 部分默认报表预热失败，将在首次请求时重试')
  }
}
let reportWarmup: Promise<void> | null = null
const warmDefaultReportsSafely = () => {
  if (reportWarmup) return
  reportWarmup = warmDefaultReports()
    .catch(() => {
      console.warn('[report-warmup] 默认报表预热失败，将在下个周期重试')
    })
    .finally(() => { reportWarmup = null })
}
const invalidateControlPlaneCaches = () => {
  invalidateGatewaySnapshot()
  catalogCoordinator.clear()
  monitorCoordinator.clear()
  analyticsCoordinator.clear()
}
app.disable('x-powered-by')
// 限流按来源 IP 计数：控制台部署在 127.0.0.1 上的 nginx 之后，
// 只有信任回环代理才能从 X-Forwarded-For 读到真实客户端地址（否则所有请求都是 127.0.0.1）。
app.set('trust proxy', 'loopback')
app.use(express.json({ limit: '1mb' }))
app.use(cookieParser())

/**
 * 全局鉴权守卫（task-58：把「恰好所有敏感路由都在 `/api` 下」改成**默认拒绝**）。
 *
 * 挂在**所有路由之前**，判定顺序与白名单理由见 `server/auth.ts` 的 `createSessionGuard`：
 * 公开白名单 → 有效会话 → 已撤销会话清 Cookie → 受保护前缀（`/api/*`）→ 命中已注册路由 → 放行静态/SPA 回退。
 * 后者保证 SPA 深链接仍返回 index.html 而不是 401 页面；前者保证将来新增的任何路由默认需要登录。
 * 结构性断言测试见 `server/authDefaultDeny.test.ts`。
 */
// Key 会话（role=key）每次请求回库确认 Key 仍存在且未被人工停用；守卫与 /api/me* 共用这一个判定。
setKeySessionLookup(keySessionState)
app.use(createSessionGuard(app))


// 会话/登录/登出（admin 与 API Key 用户共用同一入口，契约 C1）：处理器在 server/sessionRoutes.ts。
app.get('/api/session', sessionProbe)
app.post('/api/login', loginRoute)
app.post('/api/logout', logoutRoute)
// API Key 用户的只读数据面（契约 C2）：一律按会话里的 Key 过滤，见 server/meRoutes.ts。
app.use('/api/me', createMeRouter({ usageReader }))
// 控制台页眉实时边与状态栏的网关读数（契约 C6，只读本地 usage_events，每秒最多算一次）。
registerPulseRoutes(app, db)
registerChannelHealthRoutes(app, { reader: usageReader, listChannels })
registerModelInsightsRoutes(app, { usageReader })
registerKeysViewRoutes(app, { usageReader })
registerConnectRoutes(app)
registerPerfRoutes(app, { reader: latencyReader, groups: listGroupsForReporting, timeZone: config.quotaTimeZone, retentionDays: config.usageRetentionDays })
registerCacheSummaryRoutes(app, { reader: usageReader, groups: listGroupsForReporting, timeZone: config.quotaTimeZone, retentionDays: config.usageRetentionDays })
registerOverviewRoutes(app, { reader: usageReader, groups: listGroupsForReporting })
registerUsageWorkspaceRoutes(app, { usageReader, latencyReader, reportingContext, retentionDays: config.usageRetentionDays, timeZone: config.quotaTimeZone })
// 账号（ACCOUNTS-ALIGN）：magpie + local 下是 Magpie 内核的账号与登录；CPA 模式下这些路由只列目录，账号仍走下面的旧入口。
registerAccountsRoutes(app, accountsService())
// 网关功能（#gateway-features）：Magpie 的脱敏 / 识图 / 生图设置，经内核 /internal/settings 读写；CPA 模式如实返回不可用。
registerGatewaySettingsRoutes(app, createGatewaySettingsService())
// 代理池（PROXY-SPEC）：/api/proxies/* 仅管理员（默认拒绝守卫），响应全部脱敏；账号的 proxy_url 仍是唯一事实来源。
registerProxyRoutes(app, proxyService())

const parseJson = <T>(value: string, fallback: T): T => {
  try { return JSON.parse(value) as T } catch { return fallback }
}

/**
 * `/v1/usage` 的 provider 过滤条件（task-73 R26-B）。
 *
 * 修前这里直接 `activeProviderPredicate(await listGroupsForReporting(), 'provider')`：
 * 管理面一抖动（`CPA_MANAGEMENT_KEY 未配置`、上游 5xx）整个自助接口就 **500**，
 * 而这不是用户的错，客户端还会当成服务端故障重试。
 *
 * 现在：拿不到分组就**降级为不过滤**（`1 = 1`），并把降级事实显式返回给调用方。
 * 语义差异是"可能包含当前已停用渠道的历史用量"——只多不少，且仍然只查**该 Key 自己**的
 * `key_hash`，不存在跨 Key 泄漏；管理面正常时返回的条件与修前完全一致。
 */
const resolveActiveProviderFilter = async (): Promise<{
  active: { sql: string; params: string[] }
  degraded: { reason: string; note: string } | null
}> => {
  try {
    return { active: activeProviderPredicate(await listGroupsForReporting(), 'provider'), degraded: null }
  } catch {
    // 控制面的原始错误文本不回给 Key 持有者（可能带内部地址/诊断），只给原因与语义说明。
    return {
      active: { sql: '1 = 1', params: [] },
      degraded: {
        reason: 'provider_filter_unavailable',
        note: '无法读取渠道分组，本次结果未按 provider 过滤（可能包含已停用渠道的历史用量）',
      },
    }
  }
}

/**
 * `/v1/usage*` 的 Key 自鉴权：与控制台 Key 登录同一套查找（sha256 主键 + 定长比较，不再 `WHERE key_value = ?`），
 * 并按来源 IP 限制带错 Key 的次数（`publicUsageRateLimiter`）。失败时已写好响应并返回 null。
 * 地址被锁时，此前在这个地址成功过的 Key 照常放行（`publicUsageKnownGood`）：同一出口上别人配错的客户端
 * 不该把正在跑的状态栏一起锁 15 分钟；没在这里成功过的 Key 不论真假都 429，锁定期间不泄漏有效性。
 * 长度界放宽到存量 Key 的范围（旧实现是 `key_value = ?` 精确匹配，不能让过短/过长的已存 Key 失效）。
 */
const PUBLIC_USAGE_KEY_BOUNDS = { min: 1, max: 8192 }
const publicUsageKey = (req: express.Request, res: express.Response): KeyQuotaRow | null => {
  const limitKey = keyLoginRateLimitKey(req)
  const token = readBearerToken(req.header('authorization'))
  const found = token ? findKeyByPresentedValue(token, PUBLIC_USAGE_KEY_BOUNDS) : null
  const key = found && (found.enabled || found.quota_blocked_reason) ? found : null
  const decision = publicUsageRateLimiter.check(limitKey)
  if (!decision.allowed && !(key && publicUsageKnownGood.has(limitKey, key.key_hash))) {
    res.setHeader('Retry-After', String(decision.retryAfterSeconds))
    res.status(429).json({ error: { message: '尝试过于频繁，请稍后再试', type: 'rate_limited' } })
    return null
  }
  if (!key) {
    if (token) publicUsageRateLimiter.recordFailure(limitKey)
    res.status(401).json({ error: { message: '无效或不可用的 API Key', type: 'invalid_api_key' } })
    return null
  }
  publicUsageKnownGood.remember(limitKey, key.key_hash)
  return key
}

/**
 * 业务 API Key 的自助用量接口。部署在 console 域名的 /v1 路径，避开网关服务；
 * 只按 Authorization 中的 Key 查询它自己，并且不返回控制台管理字段或其他 Key。
 */
app.get('/v1/usage', async (req, res) => {
  const key = publicUsageKey(req, res)
  if (!key) return
  const days = boundedInteger(req.query.days, 30, 1, config.usageRetentionDays)
  // task-73 R26-B：管理面不可用时**降级为不过滤**，而不是把用户的请求打成 500。
  // 降级事实必须可见（header + 响应字段），绝不静默改变数据语义。
  const { active, degraded } = await resolveActiveProviderFilter()
  const hasRollup = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='usage_hourly_rollup'").get())
  const rows = db.prepare(hasRollup ? `
    SELECT ${canonicalModelSql()} model, SUM(request_count) requests,
      COALESCE(SUM(CASE WHEN lower(trim(provider)) IN ('claude','claude-api-key','anthropic','anthropic-api-key') THEN input_tokens ELSE uncached_input_tokens END),0) newInputTokens,
      COALESCE(SUM(output_tokens),0) outputTokens,
      COALESCE(SUM(cached_tokens),0) cacheTokens,
      COALESCE(SUM(cache_write_tokens),0) cacheWriteTokens,
      COALESCE(SUM(reasoning_tokens),0) reasoningTokens,
      COALESCE(SUM(total_tokens),0) totalTokens
    FROM usage_hourly_rollup
    WHERE key_hash = ? AND hour_ms >= ? AND ${active.sql}
    GROUP BY ${canonicalModelSql()}
  ` : `
    SELECT ${canonicalModelSql()} model, COUNT(*) requests,
      COALESCE(SUM(${NEW_INPUT_SQL()}),0) newInputTokens,
      COALESCE(SUM(output_tokens),0) outputTokens,
      COALESCE(SUM(cached_tokens),0) cacheTokens,
      COALESCE(SUM(cache_write_tokens),0) cacheWriteTokens,
      COALESCE(SUM(reasoning_tokens),0) reasoningTokens,
      COALESCE(SUM(total_tokens),0) totalTokens
    FROM usage_events
    WHERE key_hash = ? AND timestamp_ms >= ? AND ${active.sql}
    GROUP BY ${canonicalModelSql()}
  `).all(key.key_hash, cutoffEpochMs(days, 'days'), ...active.params) as BreakdownRow[]
  const breakdown = buildUsageBreakdown(rows)
  const tracking = db.prepare(hasRollup
    ? `SELECT MIN(hour_text || ':00:00.000Z') since FROM usage_hourly_rollup WHERE key_hash = ? AND ${active.sql}`
    : `SELECT MIN(timestamp) since FROM usage_events WHERE key_hash = ? AND ${active.sql}`
  ).get(key.key_hash, ...active.params) as { since: string | null }
  res.setHeader('Cache-Control', 'no-store')
  if (degraded) res.setHeader('X-Usage-Degraded', degraded.reason)
  res.json({
    object: 'usage_summary',
    days,
    key: { name: key.name },
    trackingSince: tracking?.since ?? null,
    quotaTimeZone: config.quotaTimeZone,
    quota: quotaStateFor(key),
    blockedReason: key.quota_blocked_reason || null,
    // 只在降级时出现：管理面正常时响应体与修前**逐字节一致**
    ...(degraded ? { degraded } : {}),
    ...breakdown,
  })
})

app.get('/v1/usage/requests', (req, res) => {
  const key = publicUsageKey(req, res)
  if (!key) return
  const days = boundedInteger(req.query.days, 7, 1, config.usageRetentionDays)
  const limit = boundedInteger(req.query.limit, 50, 1, 200)
  const items = db.prepare(`
    SELECT timestamp, model, endpoint, success, status_code statusCode, latency_ms latencyMs,
      ttft_ms ttftMs, input_tokens inputTokens, output_tokens outputTokens,
      reasoning_tokens reasoningTokens, cached_tokens cachedTokens, total_tokens totalTokens,
      upstream_request_id upstreamRequestId
    FROM usage_events
    WHERE key_hash = ? AND timestamp_ms >= ?
    ORDER BY timestamp_ms DESC LIMIT ?
  `).all(key.key_hash, cutoffEpochMs(days, 'days'), limit)
  res.setHeader('Cache-Control', 'no-store')
  res.json({ object: 'usage_request_list', days, items })
})

/*
 * Bulk credential import (JSON or ZIP of CPA auth files). CPA engine only: under Magpie, accounts sign in from the
 * accounts page instead. The relay console has used it for xAI batches of ~200 files.
 */
const credentialUploadGate = new UploadGate()
if (config.gatewayEngine === 'cpa') app.post('/api/credentials/upload', async (req, res) => {
  const traceId = crypto.randomUUID()
  const startedAt = Date.now()
  res.setHeader('Cache-Control', 'no-store')
  try {
    const responseBody = await credentialUploadGate.run(async () => {
      const file = await receiveUploadFile(req, config.credentialUploadMaxBytes)
      const credentials = await prepareCredentialUpload(file, {
        maxEntries: config.credentialUploadMaxEntries,
        maxEntryBytes: config.credentialUploadMaxEntryBytes,
        maxUncompressedBytes: config.credentialUploadMaxExpandedBytes,
      })
      console.info(JSON.stringify({
        category: '[AUDIT]', event: 'credential_upload.start', trace_id: traceId,
        stage: 'upload', filename: path.basename(file.filename), entries: credentials.length,
      }))
      const existingNames = new Set((await listAuthFiles()).files.map((item) => String(item.name || '')).filter(Boolean))
      const skippedItems = credentials.filter((credential) => existingNames.has(credential.name))
      const pendingCredentials = credentials.filter((credential) => !existingNames.has(credential.name))
      const result = await uploadCredentialBatch(pendingCredentials, {
        concurrency: config.credentialUploadConcurrency,
        upload: async (credential) => {
          try {
            await uploadAuthFile(credential.name, credential.raw)
          } catch (error) {
            console.error(JSON.stringify({
              category: '[ERROR]', event: 'credential_upload.item_failed', trace_id: traceId,
              stage: 'cpa_upload', name: credential.name,
              cause: error instanceof Error ? error.message.replace(/(access|refresh|id)[_-]?token[^ ]*/gi, '$1_token=[redacted]').slice(0, 400) : 'unknown',
            }))
            throw error
          }
        },
      })
      const items = mergeCredentialUploadItems(credentials, result.items, existingNames)
      if (result.uploaded) invalidateControlPlaneCaches()
      const total = credentials.length
      const skipped = skippedItems.length
      addAudit('upload_credentials', 'xai', JSON.stringify({
        traceId, filename: path.basename(file.filename), total, uploaded: result.uploaded, skipped, failed: result.failed,
      }))
      console.info(JSON.stringify({
        category: '[AUDIT]', event: 'credential_upload.finish', trace_id: traceId,
        stage: 'complete', duration_ms: Date.now() - startedAt, outcome: result.failed ? 'partial' : 'ok',
        total, uploaded: result.uploaded, skipped, failed: result.failed,
      }))
      return { status: result.failed ? 207 : 200, body: { traceId, total, uploaded: result.uploaded, skipped, failed: result.failed, items } }
    })
    res.status(responseBody.status).json(responseBody.body)
  } catch (error) {
    const known = error instanceof CredentialUploadError || error instanceof MultipartUploadError || error instanceof UploadGateBusyError
    const code = known ? error.code : 'UPLOAD_INTERNAL_ERROR'
    const stage = error instanceof CredentialUploadError ? error.stage : error instanceof MultipartUploadError ? 'receive' : error instanceof UploadGateBusyError ? 'queue' : 'upload'
    const message = known ? error.message : '凭据上传失败，请按 trace ID 查询服务日志'
    const rootCause = error instanceof Error && error.cause instanceof Error ? error.cause.message : ''
    console.error(JSON.stringify({
      category: '[ERROR]', event: 'credential_upload.failed', trace_id: traceId,
      stage, code, duration_ms: Date.now() - startedAt, outcome: 'error',
      cause: error instanceof Error ? error.message.slice(0, 400) : 'unknown',
      root_cause: rootCause.slice(0, 400),
    }))
    addAudit('upload_credentials_failed', 'xai', JSON.stringify({ traceId, code, stage }))
    const status = error instanceof UploadGateBusyError ? 409 : known ? 400 : 500
    res.status(status).json({ error: { code, category: 'UPLOAD', message, stage, traceId, retryable: error instanceof UploadGateBusyError } })
  }
})

// 发布身份（版本、tag、提交号、环境）：scripts/release.mjs 与外部验收据此确认线上运行的就是这次发布的提交。
app.get('/api/public/release', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  res.json(currentPublicRelease())
})

/**
 * Public agent catalog. It is deliberately outside the console-login middleware:
 * callers authenticate with the same gateway API key they will use for requests,
 * and the returned model list is restricted to that key's visible /v1/models.
 */
app.get('/api/public/model-catalog', async (req, res) => {
  const apiKey = readBearerToken(req.header('authorization'))
  if (!apiKey) return res.status(401).json({ error: '缺少 API Key' })
  const visible = await visibleModelIds(apiKey)
  if (!visible) return res.status(401).json({ error: 'API Key 无效或网关暂不可用' })
  try {
    const catalog = await loadModelCatalog(visible)
    res.setHeader('Cache-Control', 'private, max-age=60')
    return res.json({ object: 'model_catalog', generatedAt: new Date().toISOString(), models: catalog })
  } catch (error) {
    return res.status(502).json({ error: error instanceof Error ? error.message : '模型目录暂不可用' })
  }
})

function publicKeyRow(row: Record<string, unknown>, quotaState = quotaStateFor(row as unknown as KeyQuotaRow)) {
  const value = String(row.key_value || '')
  return {
    id: row.key_hash,
    name: row.name,
    note: row.note,
    maskedKey: maskKey(value),
    enabled: Boolean(row.enabled),
    groups: parseJson(String(row.groups_json || '[]'), [] as string[]),
    totalConcurrency: row.total_concurrency,
    groupConcurrency: parseJson(String(row.group_concurrency_json || '{}'), {} as Record<string, number>),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at,
    quota: {
      totalUsd: Number(row.quota_total_usd) || 0,
      dailyUsd: Number(row.quota_daily_usd) || 0,
      weeklyUsd: Number(row.quota_weekly_usd) || 0,
    },
    blockedReason: String(row.quota_blocked_reason || ''),
    quotaState,
  }
}

/**
 * 额度金额的显式解析（R7-C，形状与 `parseTotalConcurrency` 一致）。
 *
 * 旧写法 `Number(body ?? row) || 0` 有两个方向相反的静默改写：
 * - `''` / `'abc'` → `Number(...)` 是 0 或 NaN，`|| 0` 一律变成 **0 = 不限额**（用户什么都没填，却解除了限制）；
 * - 缺字段与显式 0 无法区分。
 *
 * 现在：空串/非数字 → 400；数值原样交给 `validateQuota` 做范围与跨字段校验；
 * 缺字段（PATCH）→ 保持原值。**显式 0 仍然是合法的「不限额」**（UI 的「无额度限制」开关发的就是 0）。
 */
function parseQuotaAmount(raw: unknown, fallback: number): number {
  if (raw === undefined || raw === null) return fallback
  if (typeof raw === 'string' && raw.trim() === '') {
    throw new Error('额度不能为空：填 0 表示不限额')
  }
  const value = Number(raw)
  if (!Number.isFinite(value)) throw new Error('额度必须是数字：0 表示不限额，上限 1000000')
  return value
}

app.patch('/api/keys/:id/quota', async (req, res) => {
  const row = db.prepare('SELECT * FROM api_keys WHERE key_hash = ?').get(req.params.id) as Record<string, unknown> | undefined
  if (!row) return res.status(404).json({ error: 'Key 不存在' })
  try {
    const quota = validateQuota({
      totalUsd: parseQuotaAmount(req.body?.totalUsd, Number(row.quota_total_usd) || 0),
      dailyUsd: parseQuotaAmount(req.body?.dailyUsd, Number(row.quota_daily_usd) || 0),
      weeklyUsd: parseQuotaAmount(req.body?.weeklyUsd, Number(row.quota_weekly_usd) || 0),
    })
    db.prepare('UPDATE api_keys SET quota_total_usd=?,quota_daily_usd=?,quota_weekly_usd=?,updated_at=? WHERE key_hash=?')
      .run(quota.totalUsd, quota.dailyUsd, quota.weeklyUsd, new Date().toISOString(), req.params.id)
    addAudit('update-quota', String(row.name), JSON.stringify(quota))
    // 改完立刻结算：调高额度应该马上解封，调低应该马上生效。
    // 额度停用/恢复会改变 enabled，因此同步刷新入口不限速豁免。
    await enforceQuotas()
    await reconcileNginxUnlimitedAccess()
    const updated = db.prepare('SELECT * FROM api_keys WHERE key_hash = ?').get(req.params.id) as Record<string, unknown>
    res.json(publicKeyRow(updated))
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : '额度保存失败' })
  }
})

app.post('/api/keys/:id/quota/reset', async (req, res) => {
  const row = db.prepare('SELECT * FROM api_keys WHERE key_hash = ?').get(req.params.id) as Record<string, unknown> | undefined
  if (!row) return res.status(404).json({ error: 'Key 不存在' })
  const window = String(req.body?.window || '')
  if (!['total', 'daily', 'weekly'].includes(window)) return res.status(400).json({ error: '额度窗口无效' })
  try {
    resetQuotaWindow(req.params.id, window as 'total' | 'daily' | 'weekly')
    addAudit('reset-quota', String(row.name), window)
    await enforceQuotas()
    await reconcileNginxUnlimitedAccess()
    const updated = db.prepare('SELECT * FROM api_keys WHERE key_hash = ?').get(req.params.id) as Record<string, unknown>
    res.json(publicKeyRow(updated))
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : '重置失败' })
  }
})

/**
 * Key 列表与额度状态全部来自本地库，不依赖 CPA；分组与模型目录才需要控制面。
 * CPA 重启或变慢时不能让整个 bootstrap 失败——否则页面会一直拿不到 Key 与额度条，
 * 只能靠人工刷新碰运气。控制面部分失败就退回上次持久化的分组，并标记 degraded。
 */
app.get('/api/bootstrap', async (_req, res) => {
  const keyRows = db.prepare('SELECT * FROM api_keys ORDER BY enabled DESC, created_at DESC').all() as Array<Record<string, unknown>>
  // 额度走读线程池；线程池冷启动或异常时退回主线程同步计算，保证每个 Key 都带完整 quotaState。
  const quotaStates = await quotaStatesForAsync(keyRows as unknown as KeyQuotaRow[]).catch(() => new Map<string, KeyQuotaState>())
  const keys = keyRows.map((row) => publicKeyRow(row, quotaStates.get(String(row.key_hash)) ?? quotaStateFor(row as unknown as KeyQuotaRow)))
  let degraded = false
  let degradedReason = ''
  // 网关版本与控制面并发读：串在后面时，网关故障会让 bootstrap 再多等两轮请求超时。
  const controlPlane = await Promise.allSettled([
    catalogCoordinator.run('models', () => listModelIndex().catch((error) => {
      if (isUnsupportedManagementEndpoint(error)) return null
      throw error
    })),
    listGroups(),
    getCpaVersion(),
  ])
  const [catalogResult, groupsResult, cpaVersionResult] = controlPlane
  let groups = groupsResult.status === 'fulfilled' ? groupsResult.value : null
  if (!groups) {
    const message = groupsResult.status === 'rejected' && groupsResult.reason instanceof Error ? groupsResult.reason.message : '控制面暂不可用'
    degraded = true
    degradedReason = `渠道分组读取失败，已沿用上次结果：${message}`
    groups = await listGroupsForReporting().catch(() => [] as Awaited<ReturnType<typeof listGroups>>)
  }
  let catalog: string[] | null = null
  if (catalogResult.status === 'fulfilled' && catalogResult.value) {
    // bootstrap 与模型总览使用同一个模型 ID 空间，包含已停用来源，便于解释和恢复。
    catalog = catalogResult.value.models.map((model) => model.id)
  } else if (catalogResult.status === 'rejected' && !degraded) {
    degraded = true
    degradedReason = `模型目录读取失败，已从渠道分组推导：${catalogResult.reason instanceof Error ? catalogResult.reason.message : '控制面暂不可用'}`
  }
  // 旧版 CPA 没有 /model-index；控制台仍可从已登记的渠道/账号组安全构造模型清单。
  const models = catalog ?? [...new Set(groups.flatMap((group) => group.models))].sort()
  res.setHeader('Cache-Control', 'no-store')
  const cpaVer = cpaVersionResult.status === 'fulfilled' ? cpaVersionResult.value : { version: 'unknown', commit: '', buildDate: '' }
  const consoleVer = getConsoleVersion()
  res.json({
    keys, groups, models, retentionDays: config.usageRetentionDays, quotaTimeZone: config.quotaTimeZone,
    degraded, degradedReason: degraded ? degradedReason : '',
    // 网关侧 Key 级模型隔离是否真的生效。CPA v7.2.140 起上游删掉了该能力，
    // 分组配置仍然保留，但不能让 UI 继续把它显示成已经在网关生效的限制。
    gatewayModelAccess: getKeyModelAccessState(),
    versions: {
      cpa: cpaVer,
      console: consoleVer,
    },
  })
})

app.post('/api/keys/:id/reveal-token', (req, res) => {
  const row = db.prepare('SELECT key_value FROM api_keys WHERE key_hash = ?').get(req.params.id) as { key_value?: string } | undefined
  if (!row?.key_value) return res.status(404).json({ error: 'Key 不存在' })
  res.json({ token: issueKeyRevealToken(req.params.id, row.key_value), expiresIn: 60 })
})

app.get('/api/keys/:id/reveal', (req, res) => {
  const key = consumeKeyRevealToken(String(req.query.token || ''), req.params.id)
  if (!key) return res.status(410).json({ error: '复制令牌已失效，请重新点击复制' })
  res.setHeader('Cache-Control', 'no-store')
  res.json({ key })
})

/**
 * 总并发的显式解析：**不再静默改写用户输入**（R6-B 的服务端一半）。
 *
 * 旧行为有两个方向相反的静默改写：
 * - POST：`Number(v || 4)` —— 空串/缺字段被悄悄变成 **4**（用户从没输入过这个数字）；
 * - PATCH：`Number(v ?? row.total_concurrency)` —— 空串被 `Number('')` 变成 **0 = 不限速**（更危险）。
 *
 * 现在：空串一律 400；POST 缺字段也 400（不再有隐式默认值）；PATCH 缺字段才表示「保持原值」。
 * 文案与 `server/policy.ts:10` 的规则同源。
 */

function parseTotalConcurrency(raw: unknown, fallback?: number): number {
  if (raw === undefined || raw === null) {
    if (fallback !== undefined) return fallback
    throw new Error(`请填写总并发数：${TOTAL_CONCURRENCY_RULE}`)
  }
  if (typeof raw === 'string' && raw.trim() === '') {
    throw new Error(`总并发数不能为空：${TOTAL_CONCURRENCY_RULE}`)
  }
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0 || value > 500) throw new Error(TOTAL_CONCURRENCY_RULE)
  return value
}

app.post('/api/keys', async (req, res) => {
  try {
  const name = String(req.body?.name || '').trim()
  if (!name) return res.status(400).json({ error: '请输入显示名称' })
  const slug = deriveKeySlug(String(req.body?.slug || name))
  const value = buildNamedAPIKey(slug, crypto.randomBytes(16).toString('hex'))
  // 新 Key 必须明确选渠道，不能因总开关开启而自动获得 Mox 等全部上游。
  const groups = Array.isArray(req.body?.groups) ? req.body.groups : []
  const totalConcurrency = parseTotalConcurrency(req.body?.totalConcurrency)
  const groupConcurrency = typeof req.body?.groupConcurrency === 'object' ? req.body.groupConcurrency : {}
  validatePolicy({ enabled: true, groups, totalConcurrency, groupConcurrency })
  const cpaKeys = await getCPAKeys()
  await replaceCPAKeys([...cpaKeys, value])
  const now = new Date().toISOString()
  db.prepare(`INSERT INTO api_keys (key_hash,key_value,name,note,enabled,groups_json,total_concurrency,group_concurrency_json,created_at,updated_at) VALUES (?,?,?,?,1,?,?,?,?,?)`)
    .run(hashKey(value), value, name, String(req.body?.note || ''), JSON.stringify(groups), totalConcurrency, JSON.stringify(groupConcurrency), now, now)
  await reconcileKeyModelAccess()
  addAudit('create_key', name, JSON.stringify({ slug, groups, totalConcurrency }))
  await reconcileNginxUnlimitedAccess()
  res.status(201).json({ key: value, item: publicKeyRow(db.prepare('SELECT * FROM api_keys WHERE key_hash = ?').get(hashKey(value)) as Record<string, unknown>) })
  } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : '创建失败' }) }
})

app.patch('/api/keys/:id', async (req, res) => {
  try {
  const row = db.prepare('SELECT * FROM api_keys WHERE key_hash = ?').get(req.params.id) as Record<string, unknown> | undefined
  if (!row) return res.status(404).json({ error: 'Key 不存在' })
  const name = String(req.body?.name ?? row.name).trim()
  const note = String(req.body?.note ?? row.note)
  const enabled = req.body?.enabled === undefined ? Boolean(row.enabled) : Boolean(req.body.enabled)
  const groups = Array.isArray(req.body?.groups) ? req.body.groups : parseJson(String(row.groups_json), [] as string[])
  const totalConcurrency = parseTotalConcurrency(req.body?.totalConcurrency, Number(row.total_concurrency))
  const groupConcurrency = typeof req.body?.groupConcurrency === 'object' ? req.body.groupConcurrency : parseJson(String(row.group_concurrency_json), {})
  validatePolicy({ enabled, groups, totalConcurrency, groupConcurrency })
  const value = String(row.key_value)
  const keys = await getCPAKeys()
  const hasKey = keys.includes(value)
  if (enabled && !hasKey) await replaceCPAKeys([...keys, value])
  if (!enabled && hasKey) await replaceCPAKeys(keys.filter((key) => key !== value))
  const now = new Date().toISOString()
  // 人工启用时清掉超额停用标记，否则下一轮对账会把它当成「额度停用」反复处理；
  // 显式 `enabled:false` 是人工停用，同样清掉：否则它仍被当作额度停用（Key 会话照常、对账还会自动恢复它）。
  const manualDisable = req.body?.enabled === false
  db.prepare('UPDATE api_keys SET name=?,note=?,enabled=?,groups_json=?,total_concurrency=?,group_concurrency_json=?,quota_blocked_reason=?,updated_at=? WHERE key_hash=?')
    .run(name, note, enabled ? 1 : 0, JSON.stringify(groups), totalConcurrency, JSON.stringify(groupConcurrency), enabled || manualDisable ? '' : String(row.quota_blocked_reason || ''), now, req.params.id)
  await reconcileKeyModelAccess()
  addAudit('update_key', name, JSON.stringify({ enabled, groups, totalConcurrency }))
  await reconcileNginxUnlimitedAccess()
  res.json({ item: publicKeyRow(db.prepare('SELECT * FROM api_keys WHERE key_hash = ?').get(req.params.id) as Record<string, unknown>) })
  } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : '保存失败' }) }
})

app.delete('/api/keys/:id', async (req, res) => {
  const row = db.prepare('SELECT * FROM api_keys WHERE key_hash = ?').get(req.params.id) as Record<string, unknown> | undefined
  if (!row) return res.status(404).json({ error: 'Key 不存在' })
  const value = String(row.key_value)
  await replaceCPAKeys((await getCPAKeys()).filter((key) => key !== value))
  db.prepare('DELETE FROM api_keys WHERE key_hash = ?').run(req.params.id)
  await reconcileKeyModelAccess()
  addAudit('delete_key', String(row.name))
  await reconcileNginxUnlimitedAccess()
  res.json({ ok: true })
})

app.get('/api/usage-overview', async (req, res) => {
  const days = boundedInteger(req.query.days, 30, 1, config.usageRetentionDays)
  const keyId = String(req.query.keyId || '')
  const currentOnly = parseCurrentOnly(req.query.currentOnly)
  const reporting = await reportingContext()
  const payload = await analyticsCoordinator.run(`usage-overview:${scopeTag(currentOnly)}:${days}:${keyId}:${reporting.policyHash}`, async () =>
    loadUsageOverviewReport(usageReader, reporting.groups, days, keyId, Date.now(), currentOnly))
  res.setHeader('Cache-Control', 'private, max-age=20, stale-while-revalidate=300')
  res.json(payload)
})

app.get('/api/usage-page', async (req, res) => {
  const days = boundedInteger(req.query.days, 7, 1, config.usageRetentionDays)
  const keyId = String(req.query.keyId || '')
  const currentOnly = parseCurrentOnly(req.query.currentOnly)
  const reporting = await reportingContext()
  const payload = await reportSnapshots.run(reportCacheKey.usagePage(days, keyId, reporting.policyHash, currentOnly), REPORT_FRESH_MS, async () =>
    loadUsagePageReport(usageReader, reporting.groups, days, keyId, config.quotaTimeZone, Date.now(), currentOnly))
  res.setHeader('Cache-Control', 'private, max-age=20, stale-while-revalidate=300')
  res.json(payload)
})

app.get('/api/usage-key-summaries', async (req, res) => {
  const days = boundedInteger(req.query.days, 7, 1, config.usageRetentionDays)
  const currentOnly = parseCurrentOnly(req.query.currentOnly)
  const reporting = await reportingContext()
  const payload = await reportSnapshots.run(reportCacheKey.usageKeys(days, reporting.policyHash, currentOnly), REPORT_FRESH_MS, async () =>
    loadUsageKeySummariesReport(usageReader, reporting.groups, days, Date.now(), currentOnly))
  res.setHeader('Cache-Control', 'private, max-age=20, stale-while-revalidate=300')
  res.json(payload)
})

/** 首页只需要摘要与趋势；不要为了首屏把请求明细和 p95 全部聚合一遍。 */
app.get('/api/dashboard', async (req, res) => {
  const days = boundedInteger(req.query.days, 7, 1, config.usageRetentionDays)
  const keyId = String(req.query.keyId || '')
  const currentOnly = parseCurrentOnly(req.query.currentOnly)
  const reporting = await reportingContext()
  // 数据面快照按「当前渠道」白名单预算；只在显式「只看当前渠道」时可用，默认的全部渠道口径一律读本地 SQLite。
  const useSnapshot = config.dataPlaneDashboardReadMode === 'snapshot' && currentOnly
  const relayIntegrity = useSnapshot
    ? readDataPlaneRelayStatus(db, config.dataPlaneEnabled)
    : null
  const snapshotGate = relayIntegrity && relayAllowsDashboardSnapshots(relayIntegrity) ? 'ready' : 'blocked'
  const payload = await analyticsCoordinator.run(`dashboard:${scopeTag(currentOnly)}:${days}:${keyId}:${reporting.policyHash}:${config.dataPlaneDashboardReadMode}:${snapshotGate}`, async () => {
    const latest = useSnapshot
      ? db.prepare('SELECT timestamp_ms timestampMs FROM usage_events ORDER BY timestamp_ms DESC LIMIT 1').get() as { timestampMs?: number } | undefined
      : undefined
    const snapshot = useSnapshot
      ? await readDashboardSnapshot(
          dataPlaneSnapshots,
          days,
          keyId,
          reporting.providers,
          Number.isFinite(latest?.timestampMs) ? Number(latest?.timestampMs) : null,
          () => readDataPlaneRelayStatus(db, config.dataPlaneEnabled),
          config.dataPlaneSnapshotFreshMs,
          config.dataPlaneSnapshotMaxLagMs,
        )
      : null
    if (snapshot) return snapshot
    const report = await loadDashboardReport(usageReader, reporting.groups, days, keyId, Date.now(), currentOnly)
    return {
      ...report,
      generatedAt: new Date().toISOString(),
      sourceWatermark: null,
      stale: false,
      source: 'sqlite',
    }
  })
  res.setHeader('Cache-Control', 'private, max-age=20, stale-while-revalidate=300')
  res.setHeader('X-Data-Source', String(payload.source || 'unknown'))
  res.json(payload)
})

app.get('/api/analytics', async (req, res) => {
  const days = boundedInteger(req.query.days, 7, 1, config.usageRetentionDays)
  const keyId = String(req.query.keyId || '')
  const currentOnly = parseCurrentOnly(req.query.currentOnly)
  const reporting = await reportingContext()
  const payload = await analyticsCoordinator.run(`analytics:${scopeTag(currentOnly)}:${days}:${keyId}:${reporting.policyHash}`, async () =>
    loadAnalyticsReport(latencyReader, reporting.groups, days, keyId, Date.now(), currentOnly))
  res.setHeader('Cache-Control', 'private, max-age=20, stale-while-revalidate=300')
  res.json(payload)
})

app.get('/api/charts', async (req, res) => {
  const days = boundedInteger(req.query.days, 7, 1, config.usageRetentionDays)
  const keyId = String(req.query.keyId || '')
  const currentOnly = parseCurrentOnly(req.query.currentOnly)
  const reporting = await reportingContext()
  const payload = await reportSnapshots.run(reportCacheKey.charts(days, keyId, reporting.policyHash, currentOnly), REPORT_FRESH_MS, async () =>
    loadChartsReport(usageReader, reporting.groups, days, keyId, Date.now(), currentOnly))
  res.setHeader('Cache-Control', 'private, max-age=20, stale-while-revalidate=300')
  res.json(payload)
})

app.get('/api/charts-latency', async (req, res) => {
  const days = boundedInteger(req.query.days, 7, 1, config.usageRetentionDays)
  const keyId = String(req.query.keyId || '')
  const currentOnly = parseCurrentOnly(req.query.currentOnly)
  const reporting = await reportingContext()
  const payload = await reportSnapshots.run(reportCacheKey.chartLatency(days, keyId, reporting.policyHash, currentOnly), REPORT_FRESH_MS, async () =>
    loadChartsLatencyReport(latencyReader, reporting.groups, days, keyId, Date.now(), currentOnly))
  res.setHeader('Cache-Control', 'private, max-age=20, stale-while-revalidate=300')
  res.json(payload)
})

/**
 * 一次整页额度刷新。上游请求只发生在 readAccountQuota 里（每账号 TTL + 失败冷却，见 accountQuotaReader.ts），
 * 账号间扇出有并发上限；整页缓存过期后的后台刷新因此只会打到真正到期的账号。
 */
const loadMonitorPayload = async () => {
  const auths = await listAuthFiles()
  const files = (auths.files || []).filter((file) => isMonitoredAccountType(file.type))
  const accounts = await mapWithConcurrency(files, syncRegistry.policy.globalUpstreamConcurrency, async (file) => {
    const type = String(file.type)
    let quota: unknown = null
    let resetCredits: Awaited<ReturnType<typeof readAccountQuota>>['resetCredits'] = null
    try {
      ({ quota, resetCredits } = await readAccountQuota(file))
    } catch (error) {
      quota = { error: error instanceof Error ? error.message : '读取失败' }
    }
    return { ...file, quota, normalizedQuota: normalizeAccountQuota(type, quota, resetCredits) }
  })
  // 套餐额度不按美元计量，附带本窗口各 Key 的 token 占比，回答「额度是被谁用掉的」。
  // 占比查询失败不能拖垮账号状态本身。
  const quotaShare = await loadMonitorQuotaShare(usageReader, accounts, Date.now(), 'usage_hourly_rollup').catch((error) => {
    console.warn(`[monitor] 各 Key 额度占比读取失败：${error instanceof Error ? error.message : '未知错误'}`)
    return null
  })
  // 本机控制面读不了额度时整页给一个能力标记（账号的 normalizedQuota 也带 unsupported:true），页面据此整体提示。
  // 出口按字段白名单投影：凭据文件/网关记录里的 token、cookie、key 一律不进响应（也不进整页缓存）。
  return { accounts: accounts.map(projectMonitorAccount), quotaShare, quotaSupport: accountQuotaSupport() }
}

app.get('/api/monitor', async (_req, res) => {
  const payload = await monitorCoordinator.run('monitor', () => syncRegistry.observe('account-quota', loadMonitorPayload, summarizeAccountQuota))
  res.setHeader('Cache-Control', 'private, max-age=60, stale-while-revalidate=600')
  res.json(payload)
})

app.post('/api/accounts/:authIndex/reset-codex-quota', async (req, res) => {
  const authIndex = String(req.params.authIndex)
  try {
    const auths = await listAuthFiles()
    const file = (auths.files || []).find((entry: Record<string, any>) => String(entry.auth_index) === authIndex)
    if (!file) return res.status(404).json({ error: '凭据不存在' })
    if (String(file.type) !== 'codex') return res.status(400).json({ error: '只有 Codex 账号支持主动重置' })

    const accountId = resolveChatgptAccountId(file) || undefined
    const result = await consumeCodexResetCredit(authIndex, accountId)
    const statusCode = Number(result.status_code ?? result.statusCode ?? 0)
    if (statusCode < 200 || statusCode >= 300) {
      const detail = typeof result.body_text === 'string' ? result.body_text : JSON.stringify(result.body ?? '')
      return res.status(502).json({ error: `上游返回 HTTP ${statusCode}`, detail: detail.slice(0, 300) })
    }
    // 上游重置成功后，CPA 仍按重置前那次 429 的旧 resets_at 排着本地冷却（内存态、无查询/清除端点），
    // 不清掉的话「重置了但用不了」会持续到原重置点（2026-09-27 事故）。清冷却失败不推翻已成功的重置。
    let cooldownCleared = true
    try { await clearAuthFileCooldown(String(file.name)) } catch { cooldownCleared = false }
    addAudit('reset-codex-quota', `${file.name || authIndex}`, cooldownCleared ? 'cooldown-cleared' : 'cooldown-clear-failed')
    clearAccountQuota(authIndex)
    monitorCoordinator.clear('monitor')
    const credits = await getCodexResetCredits(authIndex, accountId)
    res.json({ ok: true, cooldownCleared, resetCredits: normalizeResetCredits(credits.body ?? credits.body_text) })
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : '重置失败' })
  }
})

/**
 * `fresh=1` 由页面刷新按钮触发：先丢掉网关快照，保证 CPA 官方面板里的改动立刻可见。
 * 有的页面每次加载都带 fresh=1：同一端点每分钟最多兑现一次，其余照常走 15s 快照（不会把上游扇出打满）。
 */
const wantsFresh = (req: express.Request) => ['1', 'true'].includes(String(req.query.fresh || '')) && allowFreshInvalidation(req.path)

/**
 * 兑现 Claude 的 banked reset（cedar_ember）。与 Codex 的 reset-codex-quota 对称：
 * 先读 next_grant_id 与 org uuid，再 POST reset_rate_limits；结果非 reset/already_used 一律按失败报，避免误报成功。
 */
app.post('/api/accounts/:authIndex/reset-claude-quota', async (req, res) => {
  const authIndex = String(req.params.authIndex)
  try {
    const auths = await listAuthFiles()
    const file = (auths.files || []).find((entry: Record<string, any>) => String(entry.auth_index) === authIndex)
    if (!file) return res.status(404).json({ error: '凭据不存在' })
    if (String(file.type) !== 'claude') return res.status(400).json({ error: '只有 Claude 账号支持主动重置' })

    const usage = await apiCall(authIndex, CLAUDE_USAGE_URL, { header: claudeHeaders() })
    const usageBody = typeof usage.body === 'string' ? JSON.parse(usage.body) : (usage.body ?? {})
    const program = (usageBody as Record<string, any>)?.cedar_ember ?? {}
    const grantId = typeof program.next_grant_id === 'string' ? program.next_grant_id : ''
    if (!grantId) {
      return res.status(409).json({ error: '当前没有可用的主动重置', detail: String(program.ineligible_reason || 'no_grant') })
    }

    const profile = await apiCall(authIndex, CLAUDE_PROFILE_URL, { header: claudeHeaders() })
    const profileBody = typeof profile.body === 'string' ? JSON.parse(profile.body) : (profile.body ?? {})
    const orgUuid = (profileBody as Record<string, any>)?.organization?.uuid
    if (typeof orgUuid !== 'string' || !orgUuid) return res.status(409).json({ error: '凭据缺少 organization uuid，无法重置' })

    const result = await claimClaudeResetCredit(authIndex, orgUuid, grantId)
    const statusCode = Number(result.status_code ?? result.statusCode ?? 0)
    if (statusCode < 200 || statusCode >= 300) {
      const detail = typeof result.body_text === 'string' ? result.body_text : JSON.stringify(result.body ?? '')
      return res.status(502).json({ error: `上游返回 HTTP ${statusCode}`, detail: detail.slice(0, 300) })
    }
    const claimBody = (typeof result.body === 'string' ? JSON.parse(result.body) : (result.body ?? {})) as Record<string, any>
    const outcome = String(claimBody.result || '')
    if (outcome !== 'reset' && outcome !== 'already_used') {
      return res.status(409).json({ error: `上游未执行重置（${outcome || 'unknown'}）`, detail: String(claimBody.reason || claimBody.cooldown_until || '') })
    }
    let cooldownCleared = true
    try { await clearAuthFileCooldown(String(file.name)) } catch { cooldownCleared = false }
    addAudit('reset-claude-quota', `${file.name || authIndex}`, cooldownCleared ? 'cooldown-cleared' : 'cooldown-clear-failed')
    // 同时更新落盘的冷却：只清内存的话，重启会把重置前的冷却恢复回来。
    clearAccountQuota(authIndex)
    monitorCoordinator.clear('monitor')
    res.json({ ok: true, cooldownCleared, result: outcome, cleared: claimBody.cleared ?? [] })
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : '重置失败' })
  }
})

app.get('/api/channels', async (req, res) => {
  try {
    if (wantsFresh(req)) invalidateGatewaySnapshot()
    const [channels, credentials, globalProxy] = await Promise.all([
      listChannels(),
      listCredentials(),
      globalProxyCoordinator.run('global-proxy', getGlobalProxy),
    ])
    res.json({ channels, credentials, proxyPresets: config.proxyPresets, globalProxy })
  } catch (error) { res.status(502).json({ error: error instanceof Error ? error.message : '读取渠道失败' }) }
})

app.post('/api/channels/discover', async (req, res) => {
  try {
    const protocol = parseChannelProtocol(req.body?.protocol)
    const result = await discoverChannelModels(protocol, String(req.body?.baseUrl || ''), String(req.body?.apiKey || ''))
    res.json(result)
  } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : '模型扫描失败' }) }
})

app.post('/api/channels', async (req, res) => {
  try {
    const protocol = parseChannelProtocol(req.body?.protocol)
    const result = await createChannel({
      name: String(req.body?.name || ''),
      protocol,
      baseUrl: String(req.body?.baseUrl || ''),
      apiKey: String(req.body?.apiKey || ''),
      models: req.body?.models,
    })
    invalidateControlPlaneCaches()
    await reconcileKeyModelAccess()
    addAudit('create_channel', result.name, JSON.stringify({ protocol, baseUrl: result.baseUrl, models: result.models.map((model) => model.alias) }))
    res.status(201).json(result)
  } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : '创建渠道失败' }) }
})

app.patch('/api/channels/:name', async (req, res) => {
  try {
    // task-68：目标不存在 → 404（原来一律 400「渠道不存在或已停用」，把两件事混成一条）
    if (!(await listChannels()).some(channel => channel.name === req.params.name)) {
      return res.status(404).json({ error: '渠道不存在', reason: 'channel_not_found' })
    }
    const enabled = Boolean(req.body?.enabled)
    await setChannelEnabled(req.params.name, enabled)
    invalidateControlPlaneCaches()
    await reconcileKeyModelAccess()
    addAudit(enabled ? 'enable_channel' : 'disable_channel', req.params.name)
    res.json({ ok: true })
  } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : '操作失败' }) }
})

app.delete('/api/channels/:name', async (req, res) => {
  try {
    await removeChannel(req.params.name)
    invalidateControlPlaneCaches()
    await reconcileKeyModelAccess()
    addAudit('delete_channel', req.params.name)
    res.json({ ok: true })
  } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : '删除失败' }) }
})

app.patch('/api/channels/:name/models/:model', async (req, res) => {
  try {
    // task-68：渠道不存在 → 404；渠道存在但未启用，仍由业务层给原有 400 文案
    if (!(await listChannels()).some(channel => channel.name === req.params.name)) {
      return res.status(404).json({ error: '渠道不存在', reason: 'channel_not_found' })
    }
    const enabled = Boolean(req.body?.enabled)
    await setChannelModelEnabled(req.params.name, req.params.model, enabled)
    invalidateControlPlaneCaches()
    await reconcileKeyModelAccess()
    addAudit(enabled ? 'enable_model' : 'disable_model', `${req.params.name}/${req.params.model}`)
    res.json({ ok: true })
  } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : '操作失败' }) }
})

app.post('/api/channels/prune-stale', async (_req, res) => {
  try {
    const removed = await pruneStaleChannels()
    if (removed.length) invalidateControlPlaneCaches()
    if (removed.length) addAudit('prune_stale_channels', removed.join(', '))
    res.json({ removed })
  } catch (error) { res.status(502).json({ error: error instanceof Error ? error.message : '清理失败' }) }
})

/** 按模型或按 Key 的花费明细。keyId 为空时统计全部 Key。 */
app.get('/api/usage-breakdown', async (req, res) => {
  const days = boundedInteger(req.query.days, 30, 1, config.usageRetentionDays)
  const keyId = String(req.query.keyId || '')
  const currentOnly = parseCurrentOnly(req.query.currentOnly)
  const reporting = await reportingContext()
  const payload = await reportSnapshots.run(reportCacheKey.usageBreakdown(days, keyId, reporting.policyHash, currentOnly), REPORT_FRESH_MS, async () =>
    loadUsageBreakdownReport(usageReader, reporting.groups, days, keyId, config.quotaTimeZone, Date.now(), currentOnly))
  res.setHeader('Cache-Control', 'private, max-age=20, stale-while-revalidate=300')
  res.json(payload)
})

/**
 * 缓存命中率专页数据源。
 *
 * 只取原始 token 字段，命中率与成本归一化交给 cacheAnalytics —— Anthropic 的
 * cached 与 input 并列、OpenAI 的 cached 内含于 input，在 SQL 里做加减必然算错一家。
 */
app.get('/api/cache-analytics', async (req, res) => {
  const days = boundedInteger(req.query.days, 7, 1, config.usageRetentionDays)
  const model = String(req.query.model || '')
  const currentOnly = parseCurrentOnly(req.query.currentOnly)
  const groups = await listGroupsForReporting()
  const active = scopedProviderPredicate(groups, 'u.provider', currentOnly)
  const clauses = ['u.timestamp_ms >= ?', 'u.success = 1', active.sql]
  const params: Array<string | number> = [cutoffEpochMs(days, 'days'), ...active.params]
  if (model) { clauses.push(`(u.model = ? OR ${canonicalModelSql('u')} = ?)`); params.push(model, model) }

  const hasRollup = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='usage_hourly_rollup'").get())
  const rows = db.prepare(hasRollup ? `
    SELECT u.hour_text || ':00:00.000Z' timestamp, u.model, u.endpoint, '' source, a.name keyName, '' authIndex,
      u.provider, u.model_group modelGroup,
      u.input_tokens inputTokens, u.output_tokens outputTokens, u.cached_tokens cachedTokens,
      u.cache_write_tokens cacheWriteTokens, u.cost_usd_sum costUsd, u.client_type clientType,
      (u.latency_sum_ms / NULLIF(u.request_count, 0)) latencyMs
    FROM usage_hourly_rollup u LEFT JOIN api_keys a ON a.key_hash = u.key_hash
    WHERE u.hour_ms >= ? AND u.success = 1 AND ${active.sql}
    ${model ? `AND (u.model = ? OR ${canonicalModelSql('u')} = ?)` : ''}
  ` : `
    SELECT u.timestamp, u.model, u.endpoint, u.source, a.name keyName, u.auth_index authIndex,
      u.provider, u.model_group modelGroup,
      u.input_tokens inputTokens, u.output_tokens outputTokens, u.cached_tokens cachedTokens,
      u.cache_write_tokens cacheWriteTokens, u.cost_usd costUsd, ${clientTypeSql('u')} clientType,
      u.latency_ms latencyMs
    FROM usage_events u LEFT JOIN api_keys a ON a.key_hash = u.key_hash
    WHERE ${clauses.join(' AND ')}
  `).all(...params) as CacheEventRow[]

  const models = db.prepare(hasRollup ? `
    SELECT DISTINCT ${canonicalModelSql()} model FROM usage_hourly_rollup
    WHERE hour_ms >= ? AND success = 1 AND ${scopedProviderPredicate(groups, 'provider', currentOnly).sql}
    ORDER BY model
  ` : `
    SELECT DISTINCT ${canonicalModelSql()} model FROM usage_events
    WHERE timestamp_ms >= ? AND success = 1 AND ${scopedProviderPredicate(groups, 'provider', currentOnly).sql}
    ORDER BY model
  `).all(cutoffEpochMs(days, 'days'), ...scopedProviderPredicate(groups, 'provider', currentOnly).params) as Array<{ model: string }>

  res.setHeader('Cache-Control', 'no-store')
  res.json({ days, model, models: models.map((m) => m.model), ...buildCacheAnalytics(rows, groups, currentOnly) })
})

/**
 * 缓存命中率趋势：不同时间段的总命中率。
 * 分桶粒度由 cacheTrend 按跨度自适应，SQL 只取原始字段。
 */
app.get('/api/cache-trend', async (req, res) => {
  const hours = boundedInteger(req.query.hours, 24, 1, config.usageRetentionDays * 24)
  const model = String(req.query.model || '')
  const clientType = String(req.query.client || '')
  const keyId = String(req.query.keyId || '')
  const provider = String(req.query.provider || '').trim().toLowerCase()
  const currentOnly = parseCurrentOnly(req.query.currentOnly)
  const reporting = await reportingContext()
  const payload = await reportSnapshots.run(reportCacheKey.cacheTrend(hours, model, clientType, keyId, provider, reporting.policyHash, currentOnly), REPORT_FRESH_MS, async () =>
    loadCacheTrendReport(usageReader, reporting.groups, hours, model, clientType, keyId, provider, Date.now(), currentOnly))
  res.setHeader('Cache-Control', 'private, max-age=20, stale-while-revalidate=300')
  res.json(payload)
})

/**
 * 实时请求流（SSE）。首帧回放最近若干条作为首屏，之后由同步循环广播增量。
 * 端到端延迟 = CPA 队列轮询间隔 + 广播开销。
 */
app.get('/api/cache-live', async (req, res) => {
  const limit = boundedInteger(req.query.limit, 50, 1, 200)
  const model = String(req.query.model || '')
  const clientType = String(req.query.client || '')
  const keyId = String(req.query.keyId || '')
  const provider = String(req.query.provider || '').trim().toLowerCase()
  const currentOnly = parseCurrentOnly(req.query.currentOnly)
  /**
   * 并发上限（task-76）：满了就**显式拒绝**（503 + Retry-After + 可读原因），
   * 绝不能静默丢弃——那会让客户端以为连上了却永远收不到事件。
   * 检查与注册在同一个 tick 内完成（中间没有 await），不存在竞态。
   */
  const maxClients = sseClientLimit()
  if (!hasClientCapacity(maxClients)) {
    res.setHeader('Retry-After', '5')
    res.status(503).json({
      error: `实时连接数已达上限（${clientCount()}/${maxClients}），请关闭其它页面后重试`,
      clients: clientCount(),
      limit: maxClients,
    })
    return
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // nginx 默认会缓冲代理响应，不关掉的话 SSE 帧会被攒着一起发
    'X-Accel-Buffering': 'no',
  })
  res.write('retry: 2000\n\n')
  let closed = false
  // 增量与首帧回放同一渠道口径：currentOnly 的订阅者收不到已移除渠道的新事件
  const client = addBufferedClient(res, model, clientType, keyId, provider, currentOnly)
  if (!client) {
    // 兜底：容量检查之后到注册之间不可能再插入其它客户端（同一 tick），这里只是防御
    if (!res.headersSent) {
      res.setHeader('Retry-After', '5')
      res.status(503).json({ error: `实时连接数已达上限（${clientCount()}/${maxClients}），请稍后重试`, clients: clientCount(), limit: maxClients })
    } else {
      res.end()
    }
    return
  }
  /**
   * 断开释放计数。`req.on('close')` 在**正常关闭**与**异常断开**（客户端进程被杀、网络 RST、
   * 页面崩溃）两种情况下都会触发；这条路径是"只加不减"最容易出错的地方，测试里有
   * 「连满 → 拒绝 → 粗暴断开一条 → 再连成功」的用例来钉住它。
   */
  req.on('close', () => {
    closed = true
    client.remove()
    if (!res.writableEnded) res.end()
  })

  try {
    // Send SSE headers before a cold reporting-group fallback can wait on CPA.
    const groups = await listGroupsForReporting()
    const history = await loadCacheLiveHistory(usageReader, groups, limit, model, clientType, keyId, provider, currentOnly)
    if (closed) return
    const replay = client.activate(history)
    res.write(`event: history\ndata: ${JSON.stringify(replay)}\n\n`)
  } catch {
    client.remove()
    if (!closed) {
      res.write('event: error\ndata: {"error":"实时历史暂时不可用"}\n\n')
      res.end()
    }
  }
})

app.get('/api/cache-live/status', (_req, res) => {
  res.json({
    // 当前 SSE 连接数 + 上限（task-76）：运维不必猜"是不是连满了"
    clients: clientCount(),
    limit: sseClientLimit(),
    usageCollectIntervalMs: config.usageCollectIntervalMs,
    syncIntervalMs: config.syncIntervalMs,
  })
})

app.get('/api/data-plane/status', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  res.json(readDataPlaneRelayStatus(db, config.dataPlaneEnabled))
})

app.get('/api/model-index', async (req, res) => {
  try {
    if (wantsFresh(req)) invalidateGatewaySnapshot()
    await refreshSharedPricingIfStale()
    const index = await listModelIndex()
    // task-79 ①：控制台自己的端点带上双源价格（每条模型）+ 来源整体状态；并集只在这里做
    // （`/api/public/model-catalog` 是按 Key 的视图，那里**不做**并集，避免越权展示）。
    res.json({ ...index, models: mergePriceSourceEntries(index.models), sourceStatus: pricingSourceStatus() })
  } catch (error) { res.status(502).json({ error: error instanceof Error ? error.message : '读取模型失败' }) }
})

/* ────────── task-79 ②：magpie 内核更新的服务端代跑 + 「网关 Magpie」版本模型（server/magpieVersion.ts） ────────── */
registerMagpieVersionRoutes(app, {
  getCpaVersion, getConsoleVersion, wantsFresh, addAudit,
  // 仓库根 = server/ 的上一级（之前少了这一层，脚本路径被解析成 server/scripts/…，端点永远 capability:false）
  repoRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
})

/* 「自动更新」开关与状态（server/autoupdate.ts）：只写开关、读定时任务记下的结果；替换内核只在 launchd 任务里做。 */
registerAutoupdateRoutes(app, {
  addAudit,
  repoRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
  magpieLocal: () => config.gatewayEngine === 'magpie' && config.magpieControlPlane === 'local',
  running: async () => {
    if (config.gatewayEngine !== 'magpie') return null
    const { kernelJSON } = await import('./magpieEngine.js')
    const health = await kernelJSON(config.magpieKernelSocket, '/internal/health') as { revision?: unknown }
    return typeof health.revision === 'string' && /^[a-f0-9]{40}$/.test(health.revision) ? health.revision : null
  },
  rtkLocal: async () => {
    const { findRTKBinary, readLocalPayload } = await import('./rtkService.js')
    const binary = findRTKBinary()
    return binary ? (await readLocalPayload(binary)).version : null
  },
})

/* 「网关内核」（server/kernels.ts，中转站）：CPA 接流量 + Magpie 备用；只写开关、排队回滚，替换由 crosery-kernel-update 定时任务做。 */
registerKernelRoutes(app, {
  addAudit,
  paths: () => kernelPaths(config.dataDir),
  available: () => process.platform === 'linux' && config.gatewayEngine !== 'magpie',
  cpaRunning: async () => {
    // fresh-ish (≤15 s): right after the applier swaps CPA the panel should not show the old version for a minute
    const info = await getCpaVersion(true)
    return info.version && !['offline', 'unknown'].includes(info.version) ? info.version : null
  },
})

app.patch('/api/model-index/:model/sources/:channel', async (req, res) => {
  try {
    // task-68：渠道不存在 → 404（原来报「渠道未启用，无法调整模型」）
    // 账号池来源（kind:'oauth'）的「渠道」是 provider，要对凭据的 type 校验，不能查兼容渠道表（否则恒 404）
    const kind = req.body?.kind === 'oauth' ? 'oauth' : 'compat'
    const known = kind === 'oauth'
      ? (await listCredentials()).some(credential => credential.type === req.params.channel)
      : (await listChannels()).some(channel => channel.name === req.params.channel)
    if (!known) return res.status(404).json({ error: '渠道不存在', reason: 'channel_not_found' })
    await setModelSourceEnabled(req.params.model, req.params.channel, kind, Boolean(req.body?.enabled))
    invalidateControlPlaneCaches()
    await reconcileKeyModelAccess()
    addAudit(req.body?.enabled ? 'enable_model_source' : 'disable_model_source', `${req.params.model}@${req.params.channel}`)
    res.json({ ok: true })
  } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : '操作失败' }) }
})

/**
 * 路由层入参校验（task-61，纵深防御）：`:name` 必须是 auth-files 目录下的**单段文件名**。
 * 真正的单点校验在 `magpieControl.ts:authFilePath()`；这里先拦一道，给出明确的 400 reason。
 */
const requireCredentialName = (req: express.Request, res: express.Response): string | null => {
  try {
    const safe = assertAuthFileName(req.params.name)
    // 提前跑一遍单点校验（归属 + realpath + nlink），好把 400 的 reason 说清楚；
    // 真正的强制点仍在 magpieControl.ts 内部，任何调用方都绕不过去。
    authFilePath(safe)
    return safe
  } catch (error) {
    const code = error instanceof Error && /^credential_/.test(error.message) ? error.message : 'credential_name_invalid'
    res.status(400).json({ error: '凭据名不合法或指向 auth-files 目录之外', reason: code })
    return null
  }
}

app.patch('/api/credentials/:name', async (req, res) => {
  try {
    const name = requireCredentialName(req, res)
    if (!name) return
    const enabled = Boolean(req.body?.enabled)
    await setCredentialEnabled(name, enabled)
    invalidateControlPlaneCaches()
    await reconcileKeyModelAccess()
    addAudit(enabled ? 'enable_credential' : 'disable_credential', name)
    res.json({ ok: true })
  } catch (error) {
    res.status(errorStatusOr(error, 400)).json({ error: error instanceof Error ? error.message : '操作失败', ...reasonField(error) })
  }
})

app.delete('/api/credentials/:name', async (req, res) => {
  try {
    const name = requireCredentialName(req, res)
    if (!name) return
    await removeCredential(name)
    invalidateControlPlaneCaches()
    await reconcileKeyModelAccess()
    addAudit('delete_credential', name)
    res.json({ ok: true })
  } catch (error) {
    res.status(errorStatusOr(error, 400)).json({ error: error instanceof Error ? error.message : '删除失败', ...reasonField(error) })
  }
})

app.get('/api/credentials/:name/proxy', async (req, res) => {
  try {
    const name = requireCredentialName(req, res)
    if (!name) return
    const proxyUrl = await credentialProxyCoordinator.run(name, () => getAuthFileProxy(name))
    res.setHeader('Cache-Control', 'private, max-age=60, stale-while-revalidate=300')
    res.json({ proxyUrl })
  } catch (error) {
    res.status(errorStatusOr(error, 502)).json({ error: error instanceof Error ? error.message : '读取代理失败', ...reasonField(error) })
  }
})

app.patch('/api/credentials/:name/proxy', async (req, res) => {
  try {
    const proxyUrl = normalizeProxyUrl(String(req.body?.proxyUrl ?? ''))
    if (proxyUrl === null) {
      res.status(400).json({ error: '代理地址必须是 http/https/socks5 开头的完整地址，或填 direct 强制直连' })
      return
    }
    const name = requireCredentialName(req, res)
    if (!name) return
    await setCredentialProxy(name, proxyUrl)
    credentialProxyCoordinator.clear(name)
    invalidateControlPlaneCaches()
    addAudit('update_credential_proxy', name, maskProxyUserinfo(proxyUrl) || 'inherit')
    res.json({ ok: true, proxyUrl })
  } catch (error) {
    // task-68：凭据不存在是 404（错误自带状态），不再一律 400
    res.status(errorStatusOr(error, 400)).json({ error: error instanceof Error ? error.message : '操作失败', ...reasonField(error) })
  }
})

app.get('/api/shared-models', async (_req, res) => {
  try {
    const custom = getCustomSharedModels()
    const groups = await listGroups()
    const active = defaultOpenModels(groups, custom)
    res.json({ defaultModels: DEFAULT_OPEN_MODELS, customModels: custom, activeModels: active })
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : '读取共享模型失败' })
  }
})

app.post('/api/shared-models', async (req, res) => {
  try {
    const modelId = String(req.body?.modelId || '').trim()
    if (!modelId) return res.status(400).json({ error: '模型 ID 不能为空' })
    const current = getCustomSharedModels()
    if (!current.includes(modelId)) {
      saveCustomSharedModels([...current, modelId])
      invalidateControlPlaneCaches()
      reconcileKeyModelAccess().catch(() => undefined)
      addAudit('add_shared_model', modelId)
    }
    const groups = await listGroups()
    const active = defaultOpenModels(groups, getCustomSharedModels())
    res.json({ ok: true, activeModels: active })
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : '添加共享模型失败' })
  }
})

app.delete('/api/shared-models/:modelId', async (req, res) => {
  try {
    const modelId = decodeURIComponent(req.params.modelId).trim()
    const current = getCustomSharedModels()
    saveCustomSharedModels(current.filter((m) => m !== modelId))
    invalidateControlPlaneCaches()
    reconcileKeyModelAccess().catch(() => undefined)
    addAudit('remove_shared_model', modelId)
    const groups = await listGroups()
    const active = defaultOpenModels(groups, getCustomSharedModels())
    res.json({ ok: true, activeModels: active })
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : '移除共享模型失败' })
  }
})


/**
 * OAuth provider 的**唯一校验出口**（task-73 R26-A）：`/start` 与 `/callback` 共用。
 *
 * 非法值一律 **400 + provider_not_supported**（附可选值），不允许任何一条路径把它变成 5xx：
 * 修前 `/callback` 是 400、`/start` 是 500 —— 同一份非法输入两条路径状态码不一致，
 * 5xx 会让监控误判成服务端故障，也可能被客户端重试放大。
 */
/**
 * magpie + local：本机 OAuth 模拟器已退役（它不换 token，回调只会写出伪造的凭据）。
 * 登录改走 Magpie 内核：POST /api/accounts/signin。CPA 模式（含 magpie + cpa 控制面）不经过这里，行为不变。
 */
const LOCAL_OAUTH_RETIRED = { error: '本机 magpie 模式请在「账号」里登录（Magpie 真实登录）', code: 'use_accounts_signin' } as const
const localOAuthRetired = () => config.gatewayEngine === 'magpie' && config.magpieControlPlane === 'local'

const requireOAuthProvider = async (res: express.Response, provider: string): Promise<string | null> => {
  const { isSupportedOAuthProvider, supportedOAuthProviders } = await import('./cpa.js')
  if (isSupportedOAuthProvider(provider)) return provider
  res.status(400).json({
    error: `不支持的 OAuth 提供商：${provider}。可选：${supportedOAuthProviders().join(', ')}`,
    reason: 'provider_not_supported',
  })
  return null
}

app.post('/api/cpa/oauth/start', async (req, res) => {
  try {
    const provider = String(req.body?.provider || '').trim()
    if (!provider) return res.status(400).json({ error: '请选择提供商' })
    // 与 /callback 同一个出口：非法 provider 是 400，不是 500
    const supported = await requireOAuthProvider(res, provider)
    if (!supported) return
    if (localOAuthRetired()) return res.status(410).json(LOCAL_OAUTH_RETIRED)
    const result = await startOAuthLogin(supported)
    res.json(result)
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : '发起 OAuth 登录失败' })
  }
})

app.get('/api/cpa/oauth/status', async (req, res) => {
  if (localOAuthRetired()) return res.status(404).json({ status: 'error', error: '会话已过期或不存在', code: 'signin_not_found' })
  try {
    const state = String(req.query.state || '').trim()
    if (!state) return res.status(400).json({ error: '缺少 state 参数' })
    const result = await getOAuthStatus(state)
    if (result.status === 'ok') {
      invalidateControlPlaneCaches()
      addAudit('oauth_login_success', `state=${state.slice(0, 10)}...`)
    }
    res.json(result)
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : '查询状态失败' })
  }
})

app.post('/api/cpa/oauth/callback', async (req, res) => {
  try {
    const provider = String(req.body?.provider || '').trim()
    const redirectUrl = String(req.body?.redirectUrl || req.body?.code || '').trim()
    const state = String(req.body?.state || '').trim()
    if (!provider || !redirectUrl) return res.status(400).json({ error: '缺少 provider 或回调内容/授权码' })
    // 入口白名单（task-61 F2/F4）：未知 provider 不再原样返回——它会进凭据文件名与 authUrl。
    // task-73 R26-A：与 /start 共用**同一个校验出口**，两条路径状态码不会再分叉。
    const supported = await requireOAuthProvider(res, provider)
    if (!supported) return
    // 先校验入参（400），再报能力（410）：非法输入在两种模式下得到同一个答复
    if (localOAuthRetired()) return res.status(410).json(LOCAL_OAUTH_RETIRED)
    const result = await submitOAuthCallback(supported, redirectUrl, state)
    invalidateControlPlaneCaches()
    addAudit('oauth_callback_submit', `provider=${provider}`)
    res.json(result)
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : '提交回调失败' })
  }
})

app.post('/api/cpa/credentials/api-key', async (req, res) => {
  try {
    const provider = String(req.body?.provider || '').trim()
    const apiKey = String(req.body?.apiKey || '').trim()
    if (!provider || !apiKey) return res.status(400).json({ error: '请提供有效的 provider 和 API Key' })
    const result = await addProviderApiKey(provider, apiKey)
    invalidateControlPlaneCaches()
    addAudit('add_provider_api_key', `provider=${provider}`)
    res.json(result)
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : '录入 API Key 失败' })
  }
})

app.post('/api/cpa/oauth/cancel', async (req, res) => {
  if (localOAuthRetired()) return res.status(404).json({ error: '会话已过期或不存在', code: 'signin_not_found' })
  try {
    const state = String(req.body?.state || '').trim()
    if (state) {
      await cancelOAuthSession(state)
    }
    res.json({ ok: true })
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : '取消会话失败' })
  }
})

app.post('/api/models/sync', async (_req, res) => {
  try {
    // 与 POST /api/sync/model-discovery/run 同一个准入：手动冷却期内 429（带 Retry-After），不再无限强制全量探测。
    const outcome = await syncCenter.runModelDiscovery()
    if (!('result' in outcome)) {
      if (typeof outcome.body.retryAfterSec === 'number') res.setHeader('Retry-After', String(outcome.body.retryAfterSec))
      return res.status(outcome.status).json(outcome.body)
    }
    const { result } = outcome
    invalidateControlPlaneCaches()
    addAudit('sync_upstream_models', 'all', `added=${result.addedModels.length}, total=${result.totalModels}`)
    res.json({ ok: true, result })
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : '同步上游模型失败' })
  }
})

app.get('/api/rtk/status', async (_req, res) => {
  try {
    const { readRTKStatus } = await import('./rtkService.js')
    const status = await readRTKStatus()
    // T2：日志里能看到 plane 与每个平面的状态/状态码，便于判断是「控制面不可用」还是「RTK 未安装」。
    console.log(JSON.stringify({ category: '[AUDIT]', event: 'rtk.plane', plane: status.plane,
      planes: status.planes.map(item => `${item.id}:${item.state}:${item.reason}`) }))
    res.json(status)
  } catch (error) {
    const failure = (await import('./rtkService.js')).rtkFailure(error)
    res.status(failure.status).json({ error: failure.error, ...(failure.plane ? { plane: failure.plane } : {}), ...(failure.reason ? { reason: failure.reason } : {}), ...(failure.backup ? { backup: failure.backup } : {}), ...(failure.lockLost ? { lockLost: true } : {}), ...(failure.lockLostReason ? { lockLostReason: failure.lockLostReason } : {}) })
  }
})

/**
 * rollup 漂移自检（task-64 起，task-67 扩到多维度 + 行级差异；**只读**）。
 *
 * 返回：
 * - 顶层 `rollupRequests/eventRequests/ratio/driftPct/severity`（**与 task-64 语义一致**，客户端无需改动）；
 * - `metrics[]`：requests / totalTokens / cachedTokens / latencySumMs / costUsdSum 各自 ratio + driftPct + severity；
 * - `rowDrift`：按 rollup 主键逐行比对的 `driftingRows` / `sumAbs*` / `maxAbs*` —— 用来抓**抵消型漂移**
 *   （一行 +1 一行 -1，总量相等但逐行已错）。
 * 窗口对齐到整点；`events=0 且 rollup>0` 时该维度 `ratio=null`、`driftPct=100`。只覆盖窗口内，
 * 窗口外历史漂移是设计取舍（整表检查见 scripts/rollup-rebuild.mjs check --all）。
 */
app.get('/api/usage/rollup-health', async (req, res) => {
  try {
    const windowHours = boundedInteger(req.query.hours, 24, 1, 24 * 31)
    const cutoffMs = alignedCutoffMs(windowHours)
    const [row] = await usageReader.run(rollupHealthV2Operations(cutoffMs))
    const health = summarizeRollupHealthV2((row ?? {}) as never, { windowHours, cutoffMs })
    res.setHeader('Cache-Control', 'no-store')
    res.json(health)
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'rollup 自检失败' })
  }
})

app.get('/api/rtk/planes', async (_req, res) => {
  try {
    const { resolveRtkPlane } = await import('./rtkPlane.js')
    res.json(await resolveRtkPlane({ fresh: true }))
  } catch (error) {
    const failure = (await import('./rtkService.js')).rtkFailure(error)
    res.status(failure.status).json({ error: failure.error, ...(failure.plane ? { plane: failure.plane } : {}), ...(failure.reason ? { reason: failure.reason } : {}), ...(failure.lockLost ? { lockLost: true } : {}), ...(failure.lockLostReason ? { lockLostReason: failure.lockLostReason } : {}) })
  }
})

app.post('/api/rtk/toggle', async (req, res) => {
  const agent = String(req.body?.agent || '').trim()
  const on = Boolean(req.body?.on)
  const plane = String(req.body?.plane || 'local').trim()
  const confirm = req.body?.confirm === true
  if (!agent) return res.status(400).json({ error: '缺少 agent 参数' })
  try {
    const { setRTKAgentHook } = await import('./rtkService.js')
    const result = await setRTKAgentHook(agent, on, { plane: plane as 'kernel' | 'relay' | 'local', confirm })
    // 连带改动必须进审计：事后能追责「这次操作顺带撤回/修回了哪些别的客户端」。
    const collateralParts = [
      ...(result.collateralReverted?.length ? [`reverted:${result.collateralReverted.join('+')}`] : []),
      ...(result.collateralRestored?.length ? [`restored:${result.collateralRestored.join('+')}`] : []),
    ]
    addAudit('toggle_rtk_hook', agent, `on=${on}, plane=${result.plane}, outcome=ok${result.mechanism ? `, mechanism=${result.mechanism}` : ''}, collateral=${collateralParts.length ? collateralParts.join('|') : 'none'}`)
    res.json(result)
  } catch (error) {
    const failure = (await import('./rtkService.js')).rtkFailure(error)
    addAudit('toggle_rtk_hook', agent, `on=${on}, plane=${failure.plane || plane}, outcome=error, status=${failure.status}, reason=${failure.reason || 'unknown'}`)
    res.status(failure.status).json({ error: failure.error, ...(failure.plane ? { plane: failure.plane } : {}), ...(failure.reason ? { reason: failure.reason } : {}), ...(failure.backup ? { backup: failure.backup } : {}), ...(failure.lockLost ? { lockLost: true } : {}), ...(failure.lockLostReason ? { lockLostReason: failure.lockLostReason } : {}) })
  }
})

app.post('/api/rtk/rollback', async (req, res) => {
  const confirm = req.body?.confirm === true
  const backup = req.body?.backup ? String(req.body.backup).trim() : undefined
  try {
    const { rollbackRTK } = await import('./rtkService.js')
    const result = await rollbackRTK({ backup, confirm })
    addAudit('rollback_rtk_hook', backup || 'latest', `outcome=ok, restored=${result.restored.join(',')}`)
    res.json(result)
  } catch (error) {
    const failure = (await import('./rtkService.js')).rtkFailure(error)
    addAudit('rollback_rtk_hook', backup || 'latest', `outcome=error, status=${failure.status}, reason=${failure.reason || 'unknown'}`)
    res.status(failure.status).json({ error: failure.error, ...(failure.plane ? { plane: failure.plane } : {}), ...(failure.reason ? { reason: failure.reason } : {}), ...(failure.lockLost ? { lockLost: true } : {}), ...(failure.lockLostReason ? { lockLostReason: failure.lockLostReason } : {}) })
  }
})

// install/upgrade：平面不支持时必须 501，不能静默假装成功。
const rtkBinaryRoute = (
  action: 'install' | 'upgrade',
  run: (options: { plane?: 'kernel' | 'relay' | 'local'; confirm: boolean }) => Promise<unknown>,
) => async (req: express.Request, res: express.Response) => {
  const plane = req.body?.plane ? String(req.body.plane).trim() as 'kernel' | 'relay' | 'local' : undefined
  const confirm = req.body?.confirm === true
  try {
    const result = await run({ plane, confirm })
    addAudit(`${action}_rtk`, plane || 'authoritative', 'outcome=ok')
    res.json(result)
  } catch (error) {
    const failure = (await import('./rtkService.js')).rtkFailure(error)
    addAudit(`${action}_rtk`, failure.plane || plane || 'authoritative', `outcome=error, status=${failure.status}, reason=${failure.reason || 'unknown'}`)
    res.status(failure.status).json({ error: failure.error, ...(failure.plane ? { plane: failure.plane } : {}), ...(failure.reason ? { reason: failure.reason } : {}), ...(failure.lockLost ? { lockLost: true } : {}), ...(failure.lockLostReason ? { lockLostReason: failure.lockLostReason } : {}) })
  }
}

app.post('/api/rtk/install', async (req, res) => {
  const { installRTK } = await import('./rtkService.js')
  await rtkBinaryRoute('install', installRTK)(req, res)
})

app.post('/api/rtk/upgrade', async (req, res) => {
  const { upgradeRTK } = await import('./rtkService.js')
  await rtkBinaryRoute('upgrade', upgradeRTK)(req, res)
})
// 同步中心（契约 C3）与 RTK 全局开关（C4）：任务登记与路由在 server/syncRoutes.ts。
const magpieAccountQuota = () => accountsService().magpieReady()
const syncCenter = installSyncCenter(app, {
  refreshAccountQuota: async () => {
    // magpie + local：额度来自 Magpie 账号（到期的服务才读，5 分钟下限照旧）；内核不可用时回落到原路径（报不支持）
    if (config.gatewayEngine === 'magpie' && config.magpieControlPlane === 'local') {
      const magpie = await accountsService().refreshForSync()
      if (magpie) return magpie
    }
    monitorCoordinator.clear('monitor')
    return monitorCoordinator.run('monitor', loadMonitorPayload)
  },
  magpieAccountQuota,
  onModelsChanged: invalidateControlPlaneCaches,
  dataPlaneStatus: () => readDataPlaneRelayStatus(db, config.dataPlaneEnabled),
  addAudit,
  modelAvailability: {
    enabled: modelAvailabilityEnabled,
    run: (context) => runModelAvailabilityRound({
      listCatalog: listGroupCatalog,
      ensureProbeKeys: async (services) => {
        const keys = await registerProbeKeys(services)
        await withKeyAccessLock(() => pinProbeKeyChannels(keys))
        return keys
      },
      probe: (key, model) => probeChatModel(config.cpaBaseUrl, key, model),
      audit: addAudit,
      onTransitions: async () => {
        invalidateControlPlaneCaches()
        await reconcileKeyModelAccess()
      },
    }, context),
  },
})
app.get('/api/audit', (_req, res) => res.json({ items: db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 100').all() }))
app.use('/api', (_req, res) => res.status(404).json({ error: '接口不存在' }))

const root = path.dirname(fileURLToPath(import.meta.url))
const dist = path.resolve(root, '../dist')
app.get(['/docs', '/docs/'], (_req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=300')
  res.sendFile(path.join(dist, 'docs.html'))
})
// 入口 HTML 必须每次重新验证，避免浏览器把旧 bundle 引用缓存一小时；
// 带内容哈希的 asset 可以安全长期缓存，且不再让 static middleware 截获 index.html。
// 静态文本压缩（task-50）：只接管 dist 下「可压缩扩展名 + ≥1KB」的 GET/HEAD 且无 Range 的请求；
// 其余一律 next() 交给 express.static / SPA 回退（`/`、深链接、`/docs` 都不经过压缩层）。
// 语义细节（ETag/304/immutable/Vary/内存缓存上限）见 server/compression.ts 顶部注释。
app.use(staticCompression(dist, { maxAgeSeconds: 3600 }))
const hashedAssets = path.join(dist, 'assets') + path.sep
app.use(express.static(dist, {
  maxAge: '1h', immutable: true, index: false,
  setHeaders: (res, filePath) => {
    if (filePath.startsWith(hashedAssets)) res.setHeader('Cache-Control', staticCacheControl('/assets/', 3600))
  },
}))
app.use((_req, res) => {
  res.setHeader('Cache-Control', 'no-cache')
  res.sendFile(path.join(dist, 'index.html'))
})

/**
 * 兜底错误处理（task-57 ①）：客户端只拿通用信息，**堆栈只进服务端日志**。
 *
 * 覆盖三类（全部是未认证即可触发的）：
 * - `express.json` 的 body 解析错误（`SyntaxError` 带 `status`/`statusCode` 400）；
 * - 请求体超限（`entity.too.large` → 413）；
 * - 其它未捕获异常 → 500。
 *
 * **不依赖 `NODE_ENV`**：生产当前没有设置它，Express 默认错误页正是因此把完整堆栈和
 * 绝对路径回显给客户端（红队在生产实例上复现）。这里无条件只回通用文案。
 */
app.use((error: unknown, req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (res.headersSent) return next(error)
  const status = (() => {
    const raw = (error as { status?: unknown; statusCode?: unknown })?.status ?? (error as { statusCode?: unknown })?.statusCode
    const value = Number(raw)
    return Number.isInteger(value) && value >= 400 && value < 600 ? value : 500
  })()
  const stack = error instanceof Error ? error.stack || error.message : String(error)
  // 日志保留完整堆栈与请求上下文，便于排障；响应体不包含其中任何内容。
  console.error(`[error] ${req.method} ${req.originalUrl} → ${status}\n${stack}`)
  // 已知 reason（task-66，红队第十八轮）：让客户端能区分「JSON 解析失败」「请求体过大」与业务拒绝。
  const reason = knownErrorReason(error, status)
  res.status(status).json(reason ? { ...errorResponseBody(status), reason } : errorResponseBody(status))
})

startSync()
// 代理订阅刷新与账号代理扫描（首次运行只新增出口与索引，不改任何账号）。
registerProxyPoolJobs(syncRegistry, proxyService())
void installCredentialProxyHook(proxyService()).catch(() => undefined)
// 代理巡检（6h 一轮、只查在用出口）与托管 mihomo（只在有加密节点时启动；默认随控制台重启保活，由下一个控制台核验后接管）。
installProxyChecks()
void startManagedMihomo()
// 模型发现、价格刷新的节拍与目录监听都由同步中心排程（单飞 + 退避 + 重启不重置节拍）。
syncCenter.start()
// 运行记录、requests24h 计数与账号冷却走 5s 防抖落盘：kickstart / Ctrl-C 前先写一次，再按原信号退出。
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    try { syncRegistry.flush() } catch { /* 落盘失败不能挡住退出 */ }
    process.kill(process.pid, signal)
  })
}
if (config.gatewayEngine === 'magpie') {
  const { startMagpieServer } = await import('./magpieRuntime.js')
  await startMagpieServer()
}
if (config.nativeResponsesEnabled) startNativeResponsesServer()
// nginx 默认 60s 空闲即断开代理连接，25s 心跳保证 SSE 长连接不被切断
setInterval(heartbeat, 25_000).unref()
app.listen(config.port, config.host, () => {
  console.log(`Crosery API Console listening on http://${config.host}:${config.port}`)
  // Let schema migration, collector startup and the first health check settle
  // before analytical workers begin reading a large production database.
  setTimeout(warmDefaultReportsSafely, 2_000).unref()
  setInterval(warmDefaultReportsSafely, REPORT_WARM_INTERVAL_MS).unref()
  // 网关价格（30 分钟一轮）由同步中心的 pricing 任务负责，见 server/syncRoutes.ts。
})
