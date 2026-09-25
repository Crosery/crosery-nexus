import crypto from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import cookieParser from 'cookie-parser'
import { parseUsageSnapshot, type UsageSnapshot } from '../packages/contracts/index.js'
import { config } from './config.js'
import { addAudit, db } from './db.js'
import { apiCall, cancelOAuthSession, CLAUDE_PROFILE_URL, CLAUDE_USAGE_URL, claimClaudeResetCredit, claudeHeaders, consumeCodexResetCredit, getAuthFileProxy, getCodexResetCredits, getConsoleVersion, getCPAKeys, getCpaVersion, getGlobalProxy, getOAuthStatus, hashKey, isUnsupportedManagementEndpoint, listAuthFiles, maskKey, replaceCPAKeys, startOAuthLogin, submitOAuthCallback, uploadAuthFile } from './cpa.js'
import { createChannel, discoverChannelModels, invalidateGatewaySnapshot, listChannels, listCredentials, listGroups, listGroupsForReporting, listModelIndex, pruneStaleChannels, removeChannel, removeCredential, setChannelEnabled, setChannelModelEnabled, setCredentialEnabled, setCredentialProxy, setModelSourceEnabled } from './channels.js'
import { isAuthenticated, login, logout, requireAuth } from './auth.js'
import { getKeyModelAccessState } from './managementCapability.js'
import { reconcileKeyModelAccess, reconcileNginxUnlimitedAccess, startSync } from './sync.js'
import { validatePolicy } from './policy.js'
import { buildNamedAPIKey, deriveKeySlug } from './keyNaming.js'
import { activeProviderPredicate, activeProviderValues } from './currentChannels.js'
import { canonicalModelSql } from './modelIdentity.js'
import { NEW_INPUT_SQL } from './tokenSql.js'
import { buildUsageBreakdown, type BreakdownRow } from './usageBreakdown.js'
import { buildCacheAnalytics, type CacheEventRow } from './cacheAnalytics.js'
import { addBufferedClient, clientCount, heartbeat } from './liveStream.js'
import { clientTypeSql } from './clientAgent.js'
import { isMonitoredAccountType, normalizeAccountQuota } from './accountQuota.js'
import { fetchAntigravityAccountQuota } from './antigravityQuota.js'
import { ClaudeQuotaCache } from './claudeQuotaCache.js'
import { normalizeResetCredits, resolveChatgptAccountId } from './codexAccount.js'
import { validateQuota, type KeyQuotaState } from './quota.js'
import { enforceQuotas, quotaStateFor, quotaStatesForAsync, resetQuotaWindow, type KeyQuotaRow } from './quotaEnforcer.js'
import { consumeKeyRevealToken, issueKeyRevealToken } from './keySecrets.js'
import { normalizeProxyUrl } from './proxyPresets.js'
import { boundedInteger, readBearerToken } from './publicUsage.js'
import { CredentialUploadError, prepareCredentialUpload } from './credentialUpload.js'
import { uploadCredentialBatch } from './credentialUploadBatch.js'
import { mergeCredentialUploadItems } from './credentialUploadMerge.js'
import { MultipartUploadError, receiveUploadFile } from './multipartUpload.js'
import { UploadGate, UploadGateBusyError } from './uploadGate.js'
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
import { loadModelCatalog, visibleModelIds, refreshGatewayPricing } from './modelCatalog.js'
import { startNativeResponsesServer } from './nativeResponses.js'

const app = express()
const credentialUploadGate = new UploadGate()
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
const reportCacheKey = {
  usagePage: (days: number, keyId: string, policyHash: string) => `usage-page:v4:${days}:${keyId}:${policyHash}`,
  usageKeys: (days: number, policyHash: string) => `usage-key-summaries:v2:${days}:${policyHash}`,
  charts: (days: number, keyId: string, policyHash: string) => `charts:v2:${days}:${keyId}:${policyHash}`,
  chartLatency: (days: number, keyId: string, policyHash: string) => `charts-latency:v2:${days}:${keyId}:${policyHash}`,
  cacheTrend: (hours: number, model: string, clientType: string, keyId: string, provider: string, policyHash: string) =>
    `cache-trend:v3:${hours}:${model}:${clientType}:${keyId}:${provider}:${policyHash}`,
  usageBreakdown: (days: number, keyId: string, policyHash: string) => `usage-breakdown:v2:${days}:${keyId}:${policyHash}`,
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
const claudeQuotaCache = new ClaudeQuotaCache({
  usageTtlMs: config.claudeQuotaUsageTtlMs,
  profileTtlMs: config.claudeQuotaProfileTtlMs,
  rateLimitCooldownMs: config.claudeQuotaRateLimitCooldownMs,
  maxRateLimitCooldownMs: config.claudeQuotaMaxRateLimitCooldownMs,
})
const antigravityQuotaCoordinator = new RequestCoordinator<Awaited<ReturnType<typeof fetchAntigravityAccountQuota>>>({
  ttlMs: 5 * 60_000,
  staleWhileRevalidateMs: 10 * 60_000,
})
app.disable('x-powered-by')
app.use(express.json({ limit: '1mb' }))
app.use(cookieParser())

app.get('/api/session', (req, res) => res.json({ authenticated: isAuthenticated(req) }))
app.post('/api/login', (req, res) => {
  try {
    if (!login(String(req.body?.username || ''), String(req.body?.password || ''), res)) return res.status(401).json({ error: '管理员账号或密码不正确' })
    addAudit('login', 'console')
    res.json({ ok: true })
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : '登录失败' })
  }
})
app.post('/api/logout', (_req, res) => { logout(res); res.json({ ok: true }) })

const parseJson = <T>(value: string, fallback: T): T => {
  try { return JSON.parse(value) as T } catch { return fallback }
}

const publicUsageKey = (req: express.Request) => {
  const token = readBearerToken(req.header('authorization'))
  if (!token) return null
  return db.prepare('SELECT * FROM api_keys WHERE key_value = ?').get(token) as KeyQuotaRow | undefined
}

/**
 * 业务 API Key 的自助用量接口。部署在 console 域名的 /v1 路径，避开网关服务；
 * 只按 Authorization 中的 Key 查询它自己，并且不返回控制台管理字段或其他 Key。
 */
app.get('/v1/usage', async (req, res) => {
  const key = publicUsageKey(req)
  if (!key || (!key.enabled && !key.quota_blocked_reason)) return res.status(401).json({ error: { message: '无效或不可用的 API Key', type: 'invalid_api_key' } })
  const days = boundedInteger(req.query.days, 30, 1, config.usageRetentionDays)
  const active = activeProviderPredicate(await listGroupsForReporting(), 'provider')
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
  res.json({
    object: 'usage_summary',
    days,
    key: { name: key.name },
    trackingSince: tracking?.since ?? null,
    quotaTimeZone: config.quotaTimeZone,
    quota: quotaStateFor(key),
    blockedReason: key.quota_blocked_reason || null,
    ...breakdown,
  })
})

app.get('/v1/usage/requests', (req, res) => {
  const key = publicUsageKey(req)
  if (!key || (!key.enabled && !key.quota_blocked_reason)) return res.status(401).json({ error: { message: '无效或不可用的 API Key', type: 'invalid_api_key' } })
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

app.use('/api', requireAuth)

app.post('/api/credentials/upload', async (req, res) => {
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

app.patch('/api/keys/:id/quota', async (req, res) => {
  const row = db.prepare('SELECT * FROM api_keys WHERE key_hash = ?').get(req.params.id) as Record<string, unknown> | undefined
  if (!row) return res.status(404).json({ error: 'Key 不存在' })
  try {
    const quota = validateQuota({
      totalUsd: Number(req.body?.totalUsd ?? row.quota_total_usd) || 0,
      dailyUsd: Number(req.body?.dailyUsd ?? row.quota_daily_usd) || 0,
      weeklyUsd: Number(req.body?.weeklyUsd ?? row.quota_weekly_usd) || 0,
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
  const controlPlane = await Promise.allSettled([
    catalogCoordinator.run('models', () => listModelIndex().catch((error) => {
      if (isUnsupportedManagementEndpoint(error)) return null
      throw error
    })),
    listGroups(),
  ])
  const [catalogResult, groupsResult] = controlPlane
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
  const [cpaVer, consoleVer] = await Promise.all([
    getCpaVersion().catch(() => ({ version: 'unknown', commit: '', buildDate: '' })),
    Promise.resolve(getConsoleVersion()),
  ])
  res.json({
    keys, groups, models, retentionDays: config.usageRetentionDays, quotaTimeZone: config.quotaTimeZone,
    degraded, degradedReason: degraded ? degradedReason : '',
    // 网关侧 Key 级模型隔离是否真的生效。CPA v7.2.140 起上游删掉了该能力，
    // 分组配置仍然保留，但不能让 UI 继续把它显示成已经在网关生效的限制。
    gatewayModelAccess: getKeyModelAccessState(),
    credentialUploadLimits: {
      maxBytes: config.credentialUploadMaxBytes,
      maxEntries: config.credentialUploadMaxEntries,
      maxEntryBytes: config.credentialUploadMaxEntryBytes,
      maxExpandedBytes: config.credentialUploadMaxExpandedBytes,
    },
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

app.post('/api/keys', async (req, res) => {
  try {
  const name = String(req.body?.name || '').trim()
  if (!name) return res.status(400).json({ error: '请输入显示名称' })
  const slug = deriveKeySlug(String(req.body?.slug || name))
  const value = buildNamedAPIKey(slug, crypto.randomBytes(16).toString('hex'))
  // 新 Key 必须明确选渠道，不能因总开关开启而自动获得 Mox 等全部上游。
  const groups = Array.isArray(req.body?.groups) ? req.body.groups : []
  const totalConcurrency = req.body?.totalConcurrency === 0 ? 0 : Number(req.body?.totalConcurrency || 4)
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
  const totalConcurrency = Number(req.body?.totalConcurrency ?? row.total_concurrency)
  const groupConcurrency = typeof req.body?.groupConcurrency === 'object' ? req.body.groupConcurrency : parseJson(String(row.group_concurrency_json), {})
  validatePolicy({ enabled, groups, totalConcurrency, groupConcurrency })
  const value = String(row.key_value)
  const keys = await getCPAKeys()
  const hasKey = keys.includes(value)
  if (enabled && !hasKey) await replaceCPAKeys([...keys, value])
  if (!enabled && hasKey) await replaceCPAKeys(keys.filter((key) => key !== value))
  const now = new Date().toISOString()
  // 人工启用时清掉超额停用标记，否则下一轮对账会把它当成「额度停用」反复处理
  db.prepare('UPDATE api_keys SET name=?,note=?,enabled=?,groups_json=?,total_concurrency=?,group_concurrency_json=?,quota_blocked_reason=?,updated_at=? WHERE key_hash=?')
    .run(name, note, enabled ? 1 : 0, JSON.stringify(groups), totalConcurrency, JSON.stringify(groupConcurrency), enabled ? '' : String(row.quota_blocked_reason || ''), now, req.params.id)
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
  const days = Math.max(1, Math.min(config.usageRetentionDays, Number(req.query.days || 30)))
  const keyId = String(req.query.keyId || '')
  const reporting = await reportingContext()
  const payload = await analyticsCoordinator.run(`usage-overview:${days}:${keyId}:${reporting.policyHash}`, async () =>
    loadUsageOverviewReport(usageReader, reporting.groups, days, keyId))
  res.setHeader('Cache-Control', 'private, max-age=20, stale-while-revalidate=300')
  res.json(payload)
})

app.get('/api/usage-page', async (req, res) => {
  const days = Math.max(1, Math.min(config.usageRetentionDays, Number(req.query.days || 7)))
  const keyId = String(req.query.keyId || '')
  const reporting = await reportingContext()
  const payload = await reportSnapshots.run(reportCacheKey.usagePage(days, keyId, reporting.policyHash), REPORT_FRESH_MS, async () =>
    loadUsagePageReport(usageReader, reporting.groups, days, keyId, config.quotaTimeZone))
  res.setHeader('Cache-Control', 'private, max-age=20, stale-while-revalidate=300')
  res.json(payload)
})

app.get('/api/usage-key-summaries', async (req, res) => {
  const days = Math.max(1, Math.min(config.usageRetentionDays, Number(req.query.days || 7)))
  const reporting = await reportingContext()
  const payload = await reportSnapshots.run(reportCacheKey.usageKeys(days, reporting.policyHash), REPORT_FRESH_MS, async () =>
    loadUsageKeySummariesReport(usageReader, reporting.groups, days))
  res.setHeader('Cache-Control', 'private, max-age=20, stale-while-revalidate=300')
  res.json(payload)
})

/** 首页只需要摘要与趋势；不要为了首屏把请求明细和 p95 全部聚合一遍。 */
app.get('/api/dashboard', async (req, res) => {
  const days = Math.max(1, Math.min(config.usageRetentionDays, Number(req.query.days || 7)))
  const keyId = String(req.query.keyId || '')
  const reporting = await reportingContext()
  const relayIntegrity = config.dataPlaneDashboardReadMode === 'snapshot'
    ? readDataPlaneRelayStatus(db, config.dataPlaneEnabled)
    : null
  const snapshotGate = relayIntegrity && relayAllowsDashboardSnapshots(relayIntegrity) ? 'ready' : 'blocked'
  const payload = await analyticsCoordinator.run(`dashboard:${days}:${keyId}:${reporting.policyHash}:${config.dataPlaneDashboardReadMode}:${snapshotGate}`, async () => {
    const latest = config.dataPlaneDashboardReadMode === 'snapshot'
      ? db.prepare('SELECT timestamp_ms timestampMs FROM usage_events ORDER BY timestamp_ms DESC LIMIT 1').get() as { timestampMs?: number } | undefined
      : undefined
    const snapshot = config.dataPlaneDashboardReadMode === 'snapshot'
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
    const report = await loadDashboardReport(usageReader, reporting.groups, days, keyId)
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
  const days = Math.max(1, Math.min(config.usageRetentionDays, Number(req.query.days || 7)))
  const keyId = String(req.query.keyId || '')
  const reporting = await reportingContext()
  const payload = await analyticsCoordinator.run(`analytics:${days}:${keyId}:${reporting.policyHash}`, async () =>
    loadAnalyticsReport(latencyReader, reporting.groups, days, keyId))
  res.setHeader('Cache-Control', 'private, max-age=20, stale-while-revalidate=300')
  res.json(payload)
})

app.get('/api/charts', async (req, res) => {
  const days = Math.max(1, Math.min(config.usageRetentionDays, Number(req.query.days || 7)))
  const keyId = String(req.query.keyId || '')
  const reporting = await reportingContext()
  const payload = await reportSnapshots.run(reportCacheKey.charts(days, keyId, reporting.policyHash), REPORT_FRESH_MS, async () =>
    loadChartsReport(usageReader, reporting.groups, days, keyId))
  res.setHeader('Cache-Control', 'private, max-age=20, stale-while-revalidate=300')
  res.json(payload)
})

app.get('/api/charts-latency', async (req, res) => {
  const days = Math.max(1, Math.min(config.usageRetentionDays, Number(req.query.days || 7)))
  const keyId = String(req.query.keyId || '')
  const reporting = await reportingContext()
  const payload = await reportSnapshots.run(reportCacheKey.chartLatency(days, keyId, reporting.policyHash), REPORT_FRESH_MS, async () =>
    loadChartsLatencyReport(latencyReader, reporting.groups, days, keyId))
  res.setHeader('Cache-Control', 'private, max-age=20, stale-while-revalidate=300')
  res.json(payload)
})

app.get('/api/monitor', async (_req, res) => {
  const payload = await monitorCoordinator.run('monitor', async () => {
    const auths = await listAuthFiles()
    const accounts = await Promise.all((auths.files || []).filter((file) => isMonitoredAccountType(file.type)).map(async (file) => {
    const type = String(file.type)
    let quota: unknown = null
    try {
      if (type === 'claude') {
        const authIndex = String(file.auth_index)
        const snapshot = await claudeQuotaCache.read(
          authIndex,
          {
            usage: () => apiCall(authIndex, CLAUDE_USAGE_URL, { header: claudeHeaders() }),
            profile: () => apiCall(authIndex, CLAUDE_PROFILE_URL, { header: claudeHeaders() }),
          },
          {
            usageNextRetryAfter: file.next_retry_after,
            usageUnavailable: file.unavailable === true,
          },
        )
        quota = {
          ...(snapshot.usage ? { usage: snapshot.usage } : {}),
          ...(snapshot.profile ? { profile: snapshot.profile } : {}),
          error: [snapshot.usageError, snapshot.profileError].filter(Boolean).join('；') || undefined,
        }
      } else if (type === 'antigravity') {
        const authIndex = String(file.auth_index)
        quota = await antigravityQuotaCoordinator.run(`antigravity:${authIndex}`, () => fetchAntigravityAccountQuota(file))
      } else {
        const result = await apiCall(String(file.auth_index), 'https://chatgpt.com/backend-api/wham/usage')
        const body = result.body ?? result.body_text
        const parsedBody = typeof body === 'string' ? JSON.parse(body) : body
        const statusCode = Number(result.status_code ?? result.statusCode ?? 0)
        if (statusCode < 200 || statusCode >= 300) throw new Error(`上游返回 HTTP ${statusCode}`)
        quota = parsedBody
      }
    } catch (error) {
      quota = { error: error instanceof Error ? error.message : '读取失败' }
    }
    let resetCredits: ReturnType<typeof normalizeResetCredits> | null = null
    if (type === 'codex') {
      // 主动重置额度在单独的 wham 端点，usage 里只有计数没有过期时间
      try {
        const credits = await getCodexResetCredits(String(file.auth_index), resolveChatgptAccountId(file) || undefined)
        resetCredits = normalizeResetCredits(credits.body ?? credits.body_text)
      } catch {
        resetCredits = null
      }
    }
      return { ...file, quota, normalizedQuota: normalizeAccountQuota(type, quota, resetCredits) }
    }))
    // 套餐额度不按美元计量，附带本窗口各 Key 的 token 占比，回答「额度是被谁用掉的」。
    // 占比查询失败不能拖垮账号状态本身。
    const quotaShare = await loadMonitorQuotaShare(usageReader, accounts, Date.now(), 'usage_hourly_rollup').catch((error) => {
      console.warn(`[monitor] 各 Key 额度占比读取失败：${error instanceof Error ? error.message : '未知错误'}`)
      return null
    })
    return { accounts, quotaShare }
  })
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
    addAudit('reset-codex-quota', `${file.name || authIndex}`)
    monitorCoordinator.clear('monitor')
    const credits = await getCodexResetCredits(authIndex, accountId)
    res.json({ ok: true, resetCredits: normalizeResetCredits(credits.body ?? credits.body_text) })
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : '重置失败' })
  }
})

/** `fresh=1` 由页面刷新按钮触发：先丢掉网关快照，保证 CPA 官方面板里的改动立刻可见。 */
const wantsFresh = (req: express.Request) => ['1', 'true'].includes(String(req.query.fresh || ''))

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
    addAudit('reset-claude-quota', `${file.name || authIndex}`)
    claudeQuotaCache.clear(authIndex)
    monitorCoordinator.clear('monitor')
    res.json({ ok: true, result: outcome, cleared: claimBody.cleared ?? [] })
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
    const protocol = req.body?.protocol === 'claude' ? 'claude' : 'openai'
    const result = await discoverChannelModels(protocol, String(req.body?.baseUrl || ''), String(req.body?.apiKey || ''))
    res.json(result)
  } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : '模型扫描失败' }) }
})

app.post('/api/channels', async (req, res) => {
  try {
    const protocol = req.body?.protocol === 'claude' ? 'claude' : 'openai'
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
  const days = Math.max(1, Math.min(config.usageRetentionDays, Number(req.query.days || 30)))
  const keyId = String(req.query.keyId || '')
  const reporting = await reportingContext()
  const payload = await reportSnapshots.run(reportCacheKey.usageBreakdown(days, keyId, reporting.policyHash), REPORT_FRESH_MS, async () =>
    loadUsageBreakdownReport(usageReader, reporting.groups, days, keyId, config.quotaTimeZone))
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
  const groups = await listGroupsForReporting()
  const active = activeProviderPredicate(groups, 'u.provider')
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
    WHERE hour_ms >= ? AND success = 1 AND ${activeProviderPredicate(groups, 'provider').sql}
    ORDER BY model
  ` : `
    SELECT DISTINCT ${canonicalModelSql()} model FROM usage_events
    WHERE timestamp_ms >= ? AND success = 1 AND ${activeProviderPredicate(groups, 'provider').sql}
    ORDER BY model
  `).all(cutoffEpochMs(days, 'days'), ...activeProviderPredicate(groups, 'provider').params) as Array<{ model: string }>

  res.setHeader('Cache-Control', 'no-store')
  res.json({ days, model, models: models.map((m) => m.model), ...buildCacheAnalytics(rows, groups) })
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
  const reporting = await reportingContext()
  const payload = await reportSnapshots.run(reportCacheKey.cacheTrend(hours, model, clientType, keyId, provider, reporting.policyHash), REPORT_FRESH_MS, async () =>
    loadCacheTrendReport(usageReader, reporting.groups, hours, model, clientType, keyId, provider))
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
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // nginx 默认会缓冲代理响应，不关掉的话 SSE 帧会被攒着一起发
    'X-Accel-Buffering': 'no',
  })
  res.write('retry: 2000\n\n')
  let closed = false
  const client = addBufferedClient(res, model, clientType, keyId, provider)
  req.on('close', () => {
    closed = true
    client.remove()
    if (!res.writableEnded) res.end()
  })

  try {
    // Send SSE headers before a cold reporting-group fallback can wait on CPA.
    const groups = await listGroupsForReporting()
    const history = await loadCacheLiveHistory(usageReader, groups, limit, model, clientType, keyId, provider)
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
    clients: clientCount(),
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
    res.json(await listModelIndex())
  } catch (error) { res.status(502).json({ error: error instanceof Error ? error.message : '读取模型失败' }) }
})

app.patch('/api/model-index/:model/sources/:channel', async (req, res) => {
  try {
    const kind = req.body?.kind === 'oauth' ? 'oauth' : 'compat'
    await setModelSourceEnabled(req.params.model, req.params.channel, kind, Boolean(req.body?.enabled))
    invalidateControlPlaneCaches()
    await reconcileKeyModelAccess()
    addAudit(req.body?.enabled ? 'enable_model_source' : 'disable_model_source', `${req.params.model}@${req.params.channel}`)
    res.json({ ok: true })
  } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : '操作失败' }) }
})

app.patch('/api/credentials/:name', async (req, res) => {
  try {
    const enabled = Boolean(req.body?.enabled)
    await setCredentialEnabled(req.params.name, enabled)
    invalidateControlPlaneCaches()
    await reconcileKeyModelAccess()
    addAudit(enabled ? 'enable_credential' : 'disable_credential', req.params.name)
    res.json({ ok: true })
  } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : '操作失败' }) }
})

app.delete('/api/credentials/:name', async (req, res) => {
  try {
    await removeCredential(req.params.name)
    invalidateControlPlaneCaches()
    await reconcileKeyModelAccess()
    addAudit('delete_credential', req.params.name)
    res.json({ ok: true })
  } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : '删除失败' }) }
})

app.get('/api/credentials/:name/proxy', async (req, res) => {
  try {
    const proxyUrl = await credentialProxyCoordinator.run(req.params.name, () => getAuthFileProxy(req.params.name))
    res.setHeader('Cache-Control', 'private, max-age=60, stale-while-revalidate=300')
    res.json({ proxyUrl })
  } catch (error) { res.status(502).json({ error: error instanceof Error ? error.message : '读取代理失败' }) }
})

app.patch('/api/credentials/:name/proxy', async (req, res) => {
  try {
    const proxyUrl = normalizeProxyUrl(String(req.body?.proxyUrl ?? ''))
    if (proxyUrl === null) {
      res.status(400).json({ error: '代理地址必须是 http/https/socks5 开头的完整地址，或填 direct 强制直连' })
      return
    }
    await setCredentialProxy(req.params.name, proxyUrl)
    credentialProxyCoordinator.clear(req.params.name)
    invalidateControlPlaneCaches()
    addAudit('update_credential_proxy', req.params.name, proxyUrl || 'inherit')
    res.json({ ok: true, proxyUrl })
  } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : '操作失败' }) }
})


app.get('/api/version', async (_req, res) => {
  try {
    const [cpa, consoleVersion] = await Promise.all([
      getCpaVersion(true),
      Promise.resolve(getConsoleVersion()),
    ])
    res.json({ cpa, console: consoleVersion })
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : '获取版本失败' })
  }
})

app.post('/api/cpa/oauth/start', async (req, res) => {
  try {
    const provider = String(req.body?.provider || '').trim()
    if (!provider) return res.status(400).json({ error: '请选择提供商' })
    const result = await startOAuthLogin(provider)
    res.json(result)
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : '发起 OAuth 登录失败' })
  }
})

app.get('/api/cpa/oauth/status', async (req, res) => {
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
    const redirectUrl = String(req.body?.redirectUrl || '').trim()
    if (!provider || !redirectUrl) return res.status(400).json({ error: '缺少 provider 或 redirectUrl' })
    const result = await submitOAuthCallback(provider, redirectUrl)
    invalidateControlPlaneCaches()
    addAudit('oauth_callback_submit', `provider=${provider}`)
    res.json(result)
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : '提交回调失败' })
  }
})

app.post('/api/cpa/oauth/cancel', async (req, res) => {
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
app.use(express.static(dist, { maxAge: '1h', immutable: true, index: false }))
app.use((_req, res) => {
  res.setHeader('Cache-Control', 'no-cache')
  res.sendFile(path.join(dist, 'index.html'))
})

startSync()
if (config.nativeResponsesEnabled) startNativeResponsesServer()
// nginx 默认 60s 空闲即断开代理连接，25s 心跳保证 SSE 长连接不被切断
setInterval(heartbeat, 25_000).unref()
app.listen(config.port, config.host, () => {
  console.log(`Crosery API Console listening on http://${config.host}:${config.port}`)
  // Let schema migration, collector startup and the first health check settle
  // before analytical workers begin reading a large production database.
  setTimeout(warmDefaultReportsSafely, 2_000).unref()
  setInterval(warmDefaultReportsSafely, REPORT_WARM_INTERVAL_MS).unref()
  // 网关价格补进本地价格表，用量入库时才能给静态表缺失的模型结算成本。
  // 拉取失败不影响启动；30 分钟一轮跟随上游改价。
  void refreshGatewayPricing().then((added) => {
    if (added) console.log(JSON.stringify({ category: '[AUDIT]', event: 'pricing.gateway_merge', stage: 'startup', outcome: 'ok', added }))
  })
  setInterval(() => {
    void refreshGatewayPricing().then((added) => {
      if (added) console.log(JSON.stringify({ category: '[AUDIT]', event: 'pricing.gateway_merge', stage: 'periodic', outcome: 'ok', added }))
    })
  }, 30 * 60_000).unref()
})
