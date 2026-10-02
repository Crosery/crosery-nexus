import { config } from './config.js'
import { db, transaction } from './db.js'
import { listGroups } from './channels.js'
import { getCPAKeys, getChannelAccess, getModelAccess, hashKey, isUnsupportedManagementEndpoint, maskKey, popUsage, putChannelAccess, putModelAccess } from './cpa.js'
import { resolveGroupForModel } from './groups.js'
import { isActiveProvider } from './currentChannels.js'
import { markKeyModelAccess } from './managementCapability.js'
import { buildKeyAccessPlan, sameKeyAccess } from './keyModelAccess.js'
import { buildKeyChannelAccessPlan, mergeChannelAccess } from './keyChannelAccess.js'
import { extractKeySlug } from './keyNaming.js'
import { extractUsageDiagnostics, resolveCacheReadTokens, resolveCacheWriteTokens } from './usageDetails.js'
import { normalizeTokens } from './cacheStats.js'
import { priceRequest } from './pricing.js'
import { cutoffEpochMs, epochMsForTimestamp } from './timeRange.js'
import { broadcast, toLiveEvent, type LiveUsageEvent } from './liveStream.js'
import { NginxUnlimitedSync } from './nginxUnlimitedSync.js'
import { reconcileNginxUnlimitedPolicy } from './nginxUnlimitedReconciler.js'
import { enforceQuotas } from './quotaEnforcer.js'
import { DataPlaneRelay, nextLegacyUsageRequestId } from './dataPlane.js'
import { ReportingGroupStore } from './reportingGroups.js'
import type { UsageRecord } from './cpa.js'
import type { ConsoleGroup } from './groups.js'

const insertUsage = db.prepare(`
  INSERT OR IGNORE INTO usage_events (
    request_id, timestamp, timestamp_ms, key_hash, provider, model, model_group, endpoint,
    success, status_code, latency_ms, ttft_ms, input_tokens, output_tokens,
    reasoning_tokens, cached_tokens, cache_write_tokens, total_tokens, error_detail, error_category, upstream_request_id,
    source, auth_index, reasoning_effort, service_tier, response_headers_json,
    user_agent, client_type, client_ip, cost_usd
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`)

const insertQuotaUsage = db.prepare(`
  INSERT OR IGNORE INTO quota_usage_events (
    request_id, timestamp, timestamp_ms, key_hash, provider, model, input_tokens, output_tokens, cached_tokens, cache_write_tokens, cost_usd
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`)

const nginxUnlimitedSync = new NginxUnlimitedSync({
  enabled: config.nginxUnlimitedSyncEnabled,
  policyPath: config.nginxUnlimitedPolicyPath,
  statusPath: config.nginxUnlimitedStatusPath,
  timeoutMs: config.nginxUnlimitedSyncTimeoutMs,
})
const reportingGroupStore = new ReportingGroupStore(db)

const dataPlaneRelay = new DataPlaneRelay(db, {
  enabled: config.dataPlaneEnabled,
  baseUrl: config.dataPlaneBaseUrl,
  token: config.dataPlaneToken,
  timeoutMs: config.dataPlaneTimeoutMs,
  batchSize: config.dataPlaneBatchSize,
  intervalMs: config.dataPlaneRelayIntervalMs,
  backoffBaseMs: config.dataPlaneBackoffBaseMs,
  backoffMaxMs: config.dataPlaneBackoffMaxMs,
})

export async function reconcileNginxUnlimitedAccess() {
  const result = await reconcileNginxUnlimitedPolicy(db, nginxUnlimitedSync)
  if (result.applied) {
    console.info(JSON.stringify({
      category: '[AUDIT]',
      event: 'nginx_unlimited_policy.applied',
      stage: 'sync',
      outcome: 'ok',
      unlimited_key_count: result.unlimitedKeyCount,
    }))
  }
  return result
}

export async function syncKeysFromCPA() {
  const keys = await getCPAKeys()
  const now = new Date().toISOString()
  const known = new Set(keys.map(hashKey))
  const insert = db.prepare(`
    INSERT INTO api_keys (key_hash, key_value, name, note, enabled, groups_json, total_concurrency, group_concurrency_json, created_at, updated_at)
    VALUES (?, ?, ?, '', 1, '[]', 4, '{}', ?, ?)
    ON CONFLICT(key_hash) DO UPDATE SET key_value = excluded.key_value, enabled = 1, updated_at = excluded.updated_at
  `)
  const backfillUsageKey = db.prepare(`
    UPDATE usage_events SET key_hash = ?
    WHERE key_hash IS NULL
      AND EXISTS (SELECT 1 FROM quota_usage_events q WHERE q.request_id = usage_events.request_id AND q.key_hash = ?)
  `)
  const latestUsage = db.prepare(`
    SELECT timestamp FROM usage_events
    WHERE key_hash = ?
    ORDER BY timestamp_ms DESC LIMIT 1
  `)
  const updateLastUsed = db.prepare('UPDATE api_keys SET last_used_at = ? WHERE key_hash = ?')
  const hasNullKeys = Boolean(db.prepare('SELECT 1 FROM usage_events WHERE key_hash IS NULL LIMIT 1').get())
  transaction(() => {
    keys.forEach((key, index) => {
      const keyHash = hashKey(key)
      const existing = db.prepare('SELECT name FROM api_keys WHERE key_hash = ?').get(keyHash) as { name?: string } | undefined
      const slug = extractKeySlug(key)
      insert.run(keyHash, key, existing?.name || (slug ? slug : `API Key ${index + 1} · ${maskKey(key)}`), now, now)
      // Collector may see a new CPA key before this reconciliation. Its durable
      // quota row keeps the hash while usage_events temporarily stays NULL to
      // satisfy the FK without storing or exposing an unverified management key.
      if (hasNullKeys && backfillUsageKey.run(keyHash, keyHash).changes > 0) {
        const latest = latestUsage.get(keyHash) as { timestamp?: string } | undefined
        if (latest?.timestamp) updateLastUsed.run(latest.timestamp, keyHash)
      }
    })
    const rows = db.prepare('SELECT key_hash FROM api_keys WHERE enabled = 1').all() as Array<{ key_hash: string }>
    for (const row of rows) {
      if (!known.has(row.key_hash)) db.prepare('UPDATE api_keys SET enabled = 0, updated_at = ? WHERE key_hash = ?').run(now, row.key_hash)
    }
  })
}

/**
 * 每轮都以实时启用渠道重建所有 Key 权限。这样渠道关闭、模型禁用、OAuth 凭据停用后，
 * 最迟一个同步周期内会从用户 Key 的模型目录和请求权限里消失。
 */
let accessReconciliation: Promise<unknown> = Promise.resolve()

export function reconcileKeyModelAccess() {
  // 定时同步与面板保存共用队列；必须排到后再取授权快照，防止旧任务撤销新授权结果。
  const next = accessReconciliation.then(reconcileKeyAccessOnce)
  accessReconciliation = next.catch(() => undefined)
  return next
}

async function reconcileKeyAccessOnce() {
  const groups = await listGroups()
  const rows = db.prepare('SELECT key_value, enabled, groups_json FROM api_keys').all() as Array<{
    key_value: string
    enabled: number
    groups_json: string
  }>
  const accessRows = rows.map((row) => ({
    keyValue: row.key_value,
    enabled: Boolean(row.enabled),
    groups: (() => { try { return JSON.parse(row.groups_json) as string[] } catch { return [] } })(),
  }))
  const plan = buildKeyAccessPlan(groups, accessRows)

  const updateGroups = db.prepare('UPDATE api_keys SET groups_json=?, updated_at=? WHERE key_value=?')
  const now = new Date().toISOString()
  transaction(() => {
    for (const row of rows) {
      const normalized = plan.normalizedGroups.get(row.key_value) || []
      let current: string[] = []
      try { current = JSON.parse(row.groups_json) as string[] } catch { /* normalized below */ }
      if (JSON.stringify(current) !== JSON.stringify(normalized)) {
        updateGroups.run(JSON.stringify(normalized), now, row.key_value)
      }
    }
  })

  // 先收紧渠道池，模型接口故障不能阻止撤销 Mox；渠道能力缺失也不允许静默降级。
  const [currentChannels, configuredKeys] = await Promise.all([getChannelAccess(), getCPAKeys()])
  const channelPlan = buildKeyChannelAccessPlan(groups, accessRows, currentChannels, new Set(configuredKeys))
  const desired = mergeChannelAccess(currentChannels, channelPlan)
  if (!sameKeyAccess(currentChannels, desired)) await putChannelAccess(desired)

  try {
    const current = await getModelAccess()
    if (!sameKeyAccess(current, plan.access)) await putModelAccess(plan.access)
    markKeyModelAccess('available')
  } catch (error) {
    // CPA v7.2.140 起上游删掉了 api-key-model-access。渠道/账号/模型开关的主操作
    // 在这一步之前就已经落到网关了，不能让一个网关根本没有的能力把整个写操作报成失败。
    // 网关真的故障（5xx 等）仍然必须抛出去，否则会把「没同步成功」伪装成「已同步」。
    if (!isUnsupportedManagementEndpoint(error)) throw error
    markKeyModelAccess('unavailable')
  }

  return plan.access
}

export async function collectUsage() {
  // A fresh install may not have a validated provider snapshot yet. Do not
  // consume the destructive Usage Queue until reconciliation has persisted one;
  // the next one-second tick will retry without losing model grouping or SSE.
  const storedGroups = reportingGroupStore.read()
  if (!storedGroups) return 0
  const records = await popUsage(500)
  if (!records.length) return 0
  // The one-second collector must never fan out to CPA control-plane APIs.
  // The reconciliation loop refreshes this validated snapshot independently.
  return persistUsageRecords(records, storedGroups.groups)
}

/** Both CPA queue and native Responses settle through the same atomic ledger/outbox. */
export function persistUsageRecords(records: UsageRecord[], groups: ConsoleGroup[]) {
  const updateLastUsed = db.prepare('UPDATE api_keys SET last_used_at = ? WHERE key_hash = ?')
  const keyNameOf = db.prepare('SELECT name FROM api_keys WHERE key_hash = ?')
  // 事务内只做写入；广播放到提交之后，避免长连接写阻塞事务
  const live: LiveUsageEvent[] = []
  transaction(() => {
    for (const record of records) {
      const keyHash = record.api_key ? hashKey(record.api_key) : null
      const keyRow = keyHash ? (keyNameOf.get(keyHash) as { name?: string } | undefined) : undefined
      const timestamp = record.timestamp || new Date().toISOString()
      const tokens = record.tokens || {}
      const model = record.alias || record.model || 'unknown'
      const provider = record.provider || 'unknown'
      const modelGroup = resolveGroupForModel(model, provider, groups)
      const diagnostics = extractUsageDiagnostics(record)
      const cacheReadTokens = resolveCacheReadTokens(record)
      const cacheWriteTokens = resolveCacheWriteTokens(record)
      // 单条成本在入库时按「请求时刻的价格段 + 整条 prompt 的长上下文分档」结算；
      // 事后按当前单价重算会把促销期前后的账单混在一起。未定价模型存 NULL。
      const billed = normalizeTokens({
        model,
        provider,
        modelGroup,
        inputTokens: tokens.input_tokens || 0,
        outputTokens: tokens.output_tokens || 0,
        cachedTokens: cacheReadTokens,
        cacheWriteTokens,
      })
      const costUsd = priceRequest(model, {
        newInputTokens: billed.freshInputTokens,
        outputTokens: billed.outputTokens,
        cacheReadTokens: billed.cacheReadTokens,
        cacheWriteTokens: billed.cacheWriteTokens,
        promptTokens: billed.promptTokens,
        at: timestamp,
      })
      const requestId = String(record.request_id || '').trim() || nextLegacyUsageRequestId(db, {
        timestamp: record.timestamp || null,
        keyHash,
        provider,
        model,
        modelGroup,
        endpoint: record.endpoint || '',
        failed: Boolean(record.failed),
        statusCode: record.fail?.status_code || (record.failed ? 500 : 200),
        latencyMs: record.latency_ms || 0,
        ttftMs: record.ttft_ms || 0,
        inputTokens: tokens.input_tokens || 0,
        outputTokens: tokens.output_tokens || 0,
        reasoningTokens: tokens.reasoning_tokens || 0,
        cachedTokens: cacheReadTokens,
        cacheWriteTokens,
        totalTokens: tokens.total_tokens || 0,
        errorCategory: diagnostics.errorCategory,
        upstreamRequestId: diagnostics.upstreamRequestId,
        source: diagnostics.source,
        authIndex: diagnostics.authIndex,
        clientType: diagnostics.clientType,
      })
      const inserted = insertUsage.run(
        requestId,
        timestamp,
        epochMsForTimestamp(timestamp),
        // The queue is destructive and may race the slower key reconciliation.
        // Keep the event with a nullable FK; quota_usage_events retains the hash
        // so syncKeysFromCPA can attach it after CPA confirms the key exists.
        keyRow ? keyHash : null,
        provider,
        model,
        modelGroup,
        record.endpoint || '',
        record.failed ? 0 : 1,
        record.fail?.status_code || (record.failed ? 500 : 200),
        record.latency_ms || 0,
        record.ttft_ms || 0,
        tokens.input_tokens || 0,
        tokens.output_tokens || 0,
        tokens.reasoning_tokens || 0,
        cacheReadTokens,
        cacheWriteTokens,
        tokens.total_tokens || 0,
        diagnostics.errorDetail,
        diagnostics.errorCategory,
        diagnostics.upstreamRequestId,
        diagnostics.source,
        diagnostics.authIndex,
        diagnostics.reasoningEffort,
        diagnostics.serviceTier,
        diagnostics.responseHeadersJson,
        diagnostics.userAgent,
        diagnostics.clientType,
        diagnostics.clientIp,
        costUsd,
      )
      if (keyHash) {
        // 额度账本独立于明细保留期，保证总额度不会在清理历史用量后自动变小。
        insertQuotaUsage.run(requestId, timestamp, epochMsForTimestamp(timestamp), keyHash, provider, model, tokens.input_tokens || 0, tokens.output_tokens || 0, cacheReadTokens, cacheWriteTokens, costUsd)
        if (keyRow) updateLastUsed.run(timestamp, keyHash)
      }
      // insertUsage 是 INSERT OR IGNORE：重复 request_id 时 changes=0，
      // 而 lastInsertRowid 仍保留上一次的陈旧值，所以只能以 changes 为准。
      // 不判断就会把重复投递的记录再推一遍给前端。
      if (inserted.changes === 0) continue
      // The local usage insert and outbox insert share this transaction. Remote
      // delivery is intentionally deferred until after commit and never blocks
      // CPA collection, quota enforcement, or management operations.
      dataPlaneRelay.enqueue({
        requestId,
        timestamp,
        timestampMs: epochMsForTimestamp(timestamp),
        keyHash,
        provider,
        model,
        modelGroup,
        endpoint: record.endpoint || '',
        success: !record.failed,
        statusCode: record.fail?.status_code || (record.failed ? 500 : 200),
        latencyMs: record.latency_ms || 0,
        ttftMs: record.ttft_ms || 0,
        inputTokens: tokens.input_tokens || 0,
        outputTokens: tokens.output_tokens || 0,
        reasoningTokens: tokens.reasoning_tokens || 0,
        cachedTokens: cacheReadTokens,
        cacheWriteTokens,
        totalTokens: tokens.total_tokens || 0,
        errorCategory: diagnostics.errorCategory,
        source: diagnostics.source,
        authIndex: diagnostics.authIndex,
        clientType: diagnostics.clientType,
      })
      // 已移除渠道（不在当前分组）的新流量照样推送，但带 `removed` 标记：缓存页的首帧回放默认含全部渠道，
      // 实时流必须同一口径；只看当前渠道（currentOnly）的订阅者在 liveStream 里按标记滤掉。
      const removed = !isActiveProvider(provider, groups)
      live.push({ removed, ...toLiveEvent({
        requestId,
        timestamp,
        model,
        endpoint: record.endpoint || '',
        keyName: keyRow?.name ?? null,
        keyHash: keyRow ? keyHash : null,
        source: diagnostics.source,
        success: !record.failed,
        latencyMs: record.latency_ms || 0,
        inputTokens: tokens.input_tokens || 0,
        outputTokens: tokens.output_tokens || 0,
        cachedTokens: cacheReadTokens,
        cacheWriteTokens,
        provider,
        modelGroup,
        statusCode: record.fail?.status_code || (record.failed ? 500 : 200),
        ttftMs: record.ttft_ms || 0,
        reasoningTokens: tokens.reasoning_tokens || 0,
        totalTokens: tokens.total_tokens || 0,
        clientType: diagnostics.clientType,
        userAgent: diagnostics.userAgent,
      }) })
    }
  })
  broadcast(live)
  dataPlaneRelay.requestFlush()
  return records.length
}

export function pruneUsage() {
  const cutoff = cutoffEpochMs(config.usageRetentionDays, 'days')
  db.prepare('DELETE FROM usage_events WHERE timestamp_ms < ?').run(cutoff)
  db.prepare('DELETE FROM usage_hourly_rollup WHERE hour_ms < ?').run(cutoff)
}

type CycleTask = () => Promise<void>

/** Prevents timer ticks from starting a second copy while the previous cycle is pending. */
export function createSingleFlightCycle(task: CycleTask): () => Promise<boolean> {
  let running = false
  return async () => {
    if (running) return false
    running = true
    try {
      await task()
      return true
    } finally {
      running = false
    }
  }
}

type ReconciliationSteps = {
  syncKeys: () => Promise<void>
  reconcileModelAccess: () => Promise<unknown>
  enforceQuotaLimits: () => Promise<unknown>
  reconcileNginx: () => Promise<unknown>
  prune: () => void
}

/** The low-frequency control-plane cycle deliberately excludes Usage Queue collection. */
export async function runReconciliationSteps(steps: ReconciliationSteps = {
  syncKeys: syncKeysFromCPA,
  reconcileModelAccess: reconcileKeyModelAccess,
  enforceQuotaLimits: enforceQuotas,
  reconcileNginx: reconcileNginxUnlimitedAccess,
  prune: pruneUsage,
}) {
  await steps.syncKeys()
  await steps.reconcileModelAccess()
  await steps.enforceQuotaLimits()
  await steps.reconcileNginx()
  steps.prune()
}

function logCycleError(event: string, stage: string, error: unknown) {
  console.error(JSON.stringify({
    category: '[ERROR]',
    event,
    stage,
    code: error instanceof Error && 'code' in error ? String(error.code) : 'SYNC_FAILED',
    outcome: 'error',
    cause: error instanceof Error ? error.message.slice(0, 300) : 'unknown',
  }))
}

const collectUsageSingleFlight = createSingleFlightCycle(async () => {
  try {
    await collectUsage()
  } catch (error) {
    logCycleError('usage_collect.failed', 'usage_collect', error)
  }
})

const reconciliationSingleFlight = createSingleFlightCycle(async () => {
  try {
    await runReconciliationSteps()
  } catch (error) {
    logCycleError('sync.failed', 'reconcile', error)
  }
})

export const runUsageCollectorCycle = () => collectUsageSingleFlight()
export const runSyncCycle = () => reconciliationSingleFlight()

type IntervalHandle = ReturnType<typeof setInterval>
type IntervalScheduler = (callback: () => void, intervalMs: number) => IntervalHandle

export function scheduleSyncCycles(options: {
  usageCollectIntervalMs: number
  syncIntervalMs: number
  runUsageCollector: () => Promise<unknown>
  runReconciliation: () => Promise<unknown>
  schedule?: IntervalScheduler
}) {
  const schedule = options.schedule ?? setInterval
  void options.runUsageCollector()
  void options.runReconciliation()
  const usageCollector = schedule(() => { void options.runUsageCollector() }, options.usageCollectIntervalMs)
  const reconciliation = schedule(() => { void options.runReconciliation() }, options.syncIntervalMs)
  usageCollector.unref?.()
  reconciliation.unref?.()
  return { usageCollector, reconciliation }
}

export function startSync() {
  dataPlaneRelay.start()
  return scheduleSyncCycles({
    usageCollectIntervalMs: config.usageCollectIntervalMs,
    syncIntervalMs: config.syncIntervalMs,
    runUsageCollector: runUsageCollectorCycle,
    runReconciliation: runSyncCycle,
  })
}
