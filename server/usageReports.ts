import { bucketSecondsFor, buildTrend, type TrendRow } from './cacheTrend.js'
import { clientLabel, clientTypeSql } from './clientAgent.js'
import { activeProviderExpression, activeProviderId, activeProviderPredicate, activeProviderValues, scopedProviderPredicate } from './currentChannels.js'
import type { ConsoleGroup } from './groups.js'
import { canonicalModelId, canonicalModelSql, channelLabel } from './modelIdentity.js'
import { estimateCost } from './pricing.js'
import { hitRate, normalizeTokens } from './cacheStats.js'
import { buildCacheSummary, cacheEvidenceOperation, cacheRowsOperation, type CacheRollupRow, type CacheSummary } from './cacheSummary.js'
import { bucketPlan, errorCategoryWords, type UsageScope } from './perfReports.js'
import {
  addParts, estimateUncosted, hoursNeedingEvents, ledgerPart, resolveUncosted, uncostedEventsOperation, uncostedRollupOperation,
  type CostPart, type UncostedRow,
} from './usageCost.js'
import type { ReadOperation } from './sqliteReadWorker.js'
import { cutoffEpochMs, usageWindow } from './timeRange.js'
import { buildUsageBreakdown, type BreakdownRow } from './usageBreakdown.js'
import { buildUsageOverview, type UsageDailyModelRow, type UsageDailyRow, type UsageModelRow } from './usageOverview.js'

type Reader = {
  run(operations: readonly ReadOperation[]): Promise<unknown[]>
  runParallel?(operations: readonly ReadOperation[]): Promise<unknown[]>
}

const runIndependent = (reader: Reader, operations: readonly ReadOperation[]) =>
  reader.runParallel?.(operations) ?? reader.run(operations)

type InputTokenAggregate = {
  model: string
  provider?: string
  modelGroup?: string
  inputTokens: number
  uncachedInputTokens: number
}

const nativeAnthropicProviders = new Set(['claude', 'claude-api-key', 'anthropic', 'anthropic-api-key'])

/**
 * Active reports admit only named providers, so grouping by raw provider makes
 * the token dialect constant. SQL can sum both additive candidates and Node
 * chooses once per group instead of evaluating NEW_INPUT_SQL for every event.
 */
function newInputTokensForAggregate(row: InputTokenAggregate, modelIsCanonical = false): number {
  const provider = String(row.provider || '').toLowerCase()
  const sourceModel = String(row.model || '')
  const separator = sourceModel.indexOf('/')
  const model = modelIsCanonical || separator < 0 ? sourceModel : sourceModel.slice(separator + 1)
  const isAnthropic = nativeAnthropicProviders.has(provider)
    || (provider === '' && (String(row.modelGroup || '').toLowerCase() === 'claude' || model.toLowerCase().startsWith('claude')))
  return Number(isAnthropic ? row.inputTokens : row.uncachedInputTokens) || 0
}

const latencySummarySql = (modelSql: string, currentWhere: string) => `
  SELECT ${modelSql} name, COUNT(*) requests,
    COALESCE(AVG(latency_ms),0) avgLatency,
    COALESCE(AVG(ttft_ms),0) avgTtft
  FROM usage_events INDEXED BY idx_usage_latency_rollup
  WHERE ${currentWhere} AND success=1
  GROUP BY ${modelSql}
  HAVING COUNT(*) >= 3
  ORDER BY avgLatency DESC
  LIMIT 8
`

/**
 * 延迟明细（含 p95）：沿用「索引有序 + OFFSET 定位第 ⌊(n-1)×0.95⌋ 个值」的写法。
 *
 * **task-59 ② 的结论：不改**。红队怀疑 `LIMIT 1 OFFSET (COUNT(*)×0.95)`（30 天 186ms）
 * 是 analytics p95 的主因，但按生产规模复测（`scripts/perf-seed.mjs` 造数、窗口钉死）：
 * `idx_usage_latency_rollup` 的前缀就是「规范化模型 + success + latency_ms」，
 * 因此这是**索引内顺序跳过**，代价远低于排序；同一查询换成
 * `ROW_NUMBER() OVER (ORDER BY latency_ms)` 的窗口函数版本反而更慢：
 *
 * | 窗口 | 单模型行数 | 本实现 | 窗口函数版 |
 * | --- | --- | --- | --- |
 * | 1 天 | 2,482 | 12.5ms | 4.8ms |
 * | 7 天 | 15,533 | 16.3ms | 11.4ms |
 * | 30 天 | 47,282 | **18.8ms** | 25.6ms |
 * | 66 天 | 101,082 | **22.9ms** | 51.1ms |
 *
 * 交叉点在 ~2–3 万行：生产 30 天窗口单模型约 4.7 万行，本实现更快且随行数增长几乎平坦
 * （12.5→22.9ms / 40×）。语义上两者也逐值相同（边界用例见
 * `server/latencyPercentile.test.ts`）。因此这里保持原算法，并在文档里给出复测证据。
 */
const latencyDetailSql = (modelSql: string, currentWhere: string) => {
  const selected = `${modelSql} = ? AND ${currentWhere} AND success=1`
  return `
    SELECT COUNT(*) requests,
      COALESCE(AVG(latency_ms),0) avgLatency,
      COALESCE(AVG(ttft_ms),0) avgTtft,
      COALESCE((
        SELECT latency_ms
        FROM usage_events INDEXED BY idx_usage_latency_rollup
        WHERE ${selected}
        ORDER BY latency_ms
        LIMIT 1 OFFSET (
          SELECT CAST((COUNT(*) - 1) * 0.95 AS INTEGER)
          FROM usage_events INDEXED BY idx_usage_latency_rollup
          WHERE ${selected}
        )
      ),0) p95
    FROM usage_events INDEXED BY idx_usage_latency_rollup
    WHERE ${selected}
  `
}

type ChartsAggregateRow = {
  bucket: string
  provider: string
  name: string
  success: number
  code: number
  category: string
  requests: number
  tokens: number
}

const compareText = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0

function chartsReportFromAggregates(rows: ChartsAggregateRow[], groups: ConsoleGroup[]) {
  const trend = new Map<string, { bucket: string; requests: number; tokens: number; errors: number }>()
  const groupsData = new Map<string, { name: string; requests: number; tokens: number }>()
  const models = new Map<string, { name: string; requests: number; tokens: number }>()
  const statusCodes = new Map<number, { code: number; count: number }>()
  const errorCategories = new Map<string, { category: string; count: number }>()

  for (const row of rows) {
    const requests = Number(row.requests) || 0
    const tokens = Number(row.tokens) || 0
    const trendRow = trend.get(row.bucket) || { bucket: row.bucket, requests: 0, tokens: 0, errors: 0 }
    trendRow.requests += requests
    trendRow.tokens += tokens
    if (!row.success) trendRow.errors += requests
    trend.set(row.bucket, trendRow)

    const provider = activeProviderId(row.provider, groups)
    const groupRow = groupsData.get(provider) || { name: provider, requests: 0, tokens: 0 }
    groupRow.requests += requests
    groupRow.tokens += tokens
    groupsData.set(provider, groupRow)

    const modelRow = models.get(row.name) || { name: row.name, requests: 0, tokens: 0 }
    modelRow.requests += requests
    modelRow.tokens += tokens
    models.set(row.name, modelRow)

    if (!row.success) {
      const statusRow = statusCodes.get(row.code) || { code: row.code, count: 0 }
      statusRow.count += requests
      statusCodes.set(row.code, statusRow)
      const categoryRow = errorCategories.get(row.category) || { category: row.category, count: 0 }
      categoryRow.count += requests
      errorCategories.set(row.category, categoryRow)
    }
  }

  const byRequests = (left: { name: string; requests: number }, right: { name: string; requests: number }) =>
    right.requests - left.requests || compareText(left.name, right.name)
  const byCount = <T extends { count: number }>(tie: (left: T, right: T) => number) =>
    (left: T, right: T) => right.count - left.count || tie(left, right)

  return {
    trend: [...trend.values()],
    groups: [...groupsData.values()].sort(byRequests),
    models: [...models.values()].sort(byRequests).slice(0, 8),
    statusCodes: [...statusCodes.values()]
      .sort(byCount((left, right) => left.code - right.code)).slice(0, 6),
    errorCategories: [...errorCategories.values()]
      .sort(byCount((left, right) => compareText(left.category, right.category))).slice(0, 8),
  }
}

export async function loadDashboardReport(
  reader: Reader,
  groups: ConsoleGroup[],
  days: number,
  keyId: string,
  now = Date.now(),
  /** 默认统计全部渠道（含已移除渠道的历史）；true = 只看当前渠道 */
  currentOnly = false,
) {
  const { where, params } = usageWindow(days, keyId, 'hour_ms', now)
  const active = scopedProviderPredicate(groups, 'provider', currentOnly)
  const currentWhere = `${where} AND ${active.sql}`
  const currentParams = [...params, ...active.params]
  const [summary, trend, activeValue] = await reader.run([
    {
      method: 'get',
      sql: `SELECT COALESCE(SUM(request_count),0) requests, COALESCE(SUM(total_tokens),0) tokens, COALESCE(SUM(latency_sum_ms)*1.0 / NULLIF(SUM(request_count),0),0) avgLatency, COALESCE(SUM(CASE WHEN success=0 THEN request_count ELSE 0 END)*1.0 / NULLIF(SUM(request_count),0),0) errorRate FROM usage_hourly_rollup WHERE ${currentWhere}`,
      params: currentParams,
    },
    {
      method: 'all',
      sql: `SELECT hour_text bucket, SUM(request_count) requests, SUM(total_tokens) tokens, SUM(CASE WHEN success=0 THEN request_count ELSE 0 END) errors FROM usage_hourly_rollup WHERE ${currentWhere} GROUP BY hour_text ORDER BY hour_text`,
      params: currentParams,
    },
    {
      // 活跃 Key = 窗口内（同一口径）至少有一次调用、且仍存在的 Key；已启用数是另一个数，不能顶替它。
      method: 'get',
      sql: `SELECT COUNT(*) activeKeys FROM api_keys WHERE key_hash IN (SELECT DISTINCT key_hash FROM usage_hourly_rollup WHERE ${currentWhere})`,
      params: currentParams,
    },
  ])
  const activeKeys = Number((activeValue as { activeKeys?: number } | undefined)?.activeKeys) || 0
  return { days, summary: { ...(summary as Record<string, unknown>), activeKeys }, trend }
}

/** Charts render independently from request details and exact p95 calculation. */
export async function loadChartsReport(
  reader: Reader,
  groups: ConsoleGroup[],
  days: number,
  keyId: string,
  now = Date.now(),
  /** 默认统计全部渠道（含已移除渠道的历史）；true = 只看当前渠道 */
  currentOnly = false,
) {
  const { where, params } = usageWindow(days, keyId, 'timestamp_ms', now)
  const active = scopedProviderPredicate(groups, 'provider', currentOnly)
  const providerExpr = activeProviderExpression(groups, 'provider')
  const currentWhere = `${where} AND ${active.sql}`
  const currentParams = [...params, ...active.params]
  const modelSql = canonicalModelSql()

  // A selected-key chart remains on the selective key index. The default page
  // instead reads one compact covering index and folds its low-cardinality
  // aggregate in memory, avoiding five cold scans of the large event table.
  if (!keyId) {
    const [aggregateValue] = await reader.run([{
      method: 'all',
      sql: `SELECT substr(timestamp,1,13) bucket,
        lower(trim(provider)) provider,
        ${modelSql} name,
        success,
        status_code code,
        CASE WHEN error_category='' THEN 'other' ELSE error_category END category,
        COUNT(*) requests,
        SUM(total_tokens) tokens
      FROM usage_events INDEXED BY idx_usage_charts_rollup
      WHERE ${currentWhere}
      GROUP BY substr(timestamp,1,13), lower(trim(provider)), ${modelSql}, success, status_code, error_category
      ORDER BY substr(timestamp,1,13), lower(trim(provider)), ${modelSql}, success, status_code, error_category`,
      params: currentParams,
    }])
    const report = chartsReportFromAggregates(aggregateValue as ChartsAggregateRow[], groups)
    return {
      days,
      trend: report.trend,
      groups: report.groups,
      models: report.models,
      latency: [],
      statusCodes: report.statusCodes,
      errorCategories: report.errorCategories,
    }
  }

  const [trend, groupsData, models, statusCodes, errorCategories] = await runIndependent(reader, [
    {
      method: 'all',
      sql: `SELECT substr(timestamp,1,13) bucket, COUNT(*) requests, SUM(total_tokens) tokens, SUM(CASE WHEN success=0 THEN 1 ELSE 0 END) errors FROM usage_events WHERE ${currentWhere} GROUP BY bucket ORDER BY bucket`,
      params: currentParams,
    },
    {
      method: 'all',
      sql: `SELECT ${providerExpr.sql} name, COUNT(*) requests, SUM(total_tokens) tokens FROM usage_events WHERE ${currentWhere} GROUP BY ${providerExpr.sql} ORDER BY requests DESC`,
      params: [...providerExpr.params, ...currentParams, ...providerExpr.params],
    },
    {
      method: 'all',
      sql: `SELECT ${modelSql} name, COUNT(*) requests, SUM(total_tokens) tokens FROM usage_events WHERE ${currentWhere} GROUP BY ${modelSql} ORDER BY requests DESC LIMIT 8`,
      params: currentParams,
    },
    {
      method: 'all',
      sql: `SELECT status_code code, COUNT(*) count FROM usage_events WHERE ${currentWhere} AND success=0 GROUP BY status_code ORDER BY count DESC LIMIT 6`,
      params: currentParams,
    },
    {
      method: 'all',
      sql: `SELECT CASE WHEN error_category='' THEN 'other' ELSE error_category END category, COUNT(*) count FROM usage_events WHERE ${currentWhere} AND success=0 GROUP BY category ORDER BY count DESC LIMIT 8`,
      params: currentParams,
    },
  ])
  return { days, trend, groups: groupsData, models, latency: [], statusCodes, errorCategories }
}

export async function loadChartsLatencyReport(
  reader: Reader,
  groups: ConsoleGroup[],
  days: number,
  keyId: string,
  now = Date.now(),
  /** 默认统计全部渠道（含已移除渠道的历史）；true = 只看当前渠道 */
  currentOnly = false,
) {
  const { where, params } = usageWindow(days, keyId, 'timestamp_ms', now)
  const active = scopedProviderPredicate(groups, 'provider', currentOnly)
  const currentWhere = `${where} AND ${active.sql}`
  const currentParams = [...params, ...active.params]
  const modelSql = canonicalModelSql()
  const [summaryValue] = await reader.run([{
    method: 'all',
    sql: latencySummarySql(modelSql, currentWhere),
    params: currentParams,
  }])
  const summaries = summaryValue as Array<{
    name: string
    requests: number
    avgLatency: number
    avgTtft: number
  }>
  const detailValues = summaries.length
    ? await runIndependent(reader, summaries.map((row) => ({
        method: 'get' as const,
        sql: latencyDetailSql(modelSql, currentWhere),
        // SQL 里 `${selected}` 出现三次（OFFSET 子查询 + 内层 + 外层 WHERE），因此参数给三份
        params: [
          row.name, ...currentParams,
          row.name, ...currentParams,
          row.name, ...currentParams,
        ],
      })))
    : []
  type LatencyDetailRow = { requests: number; avgLatency: number; avgTtft: number; p95: number }
  const latency = summaries.map((row, index) => ({
    name: row.name,
    ...(detailValues[index] as LatencyDetailRow),
  }))
  return { days, latency }
}

export async function loadAnalyticsReport(
  reader: Reader,
  groups: ConsoleGroup[],
  days: number,
  keyId: string,
  now = Date.now(),
  /** 默认统计全部渠道（含已移除渠道的历史）；true = 只看当前渠道 */
  currentOnly = false,
) {
  const { where, params } = usageWindow(days, keyId, 'hour_ms', now)
  const active = scopedProviderPredicate(groups, 'provider', currentOnly)
  const currentWhere = `${where} AND ${active.sql}`
  const currentParams = [...params, ...active.params]
  const { where: requestWhere, params: requestWindowParams } = usageWindow(days, keyId, 'u.timestamp_ms', now, 'u.key_hash')
  const requestActive = scopedProviderPredicate(groups, 'u.provider', currentOnly)
  const requestCurrentWhere = `${requestWhere} AND ${requestActive.sql}`
  const requestParams = [...requestWindowParams, ...requestActive.params]
  // `usage_events.source` carries the upstream credential of compat channels: never select it into a report.
  // The request-details page consumes only these four datasets. Charts have
  // dedicated progressive endpoints, so recomputing their six aggregates here
  // only serializes full-window scans on the dedicated latency worker.
  const [summary, keyUsage, requests, clients] = await reader.run([
    {
      method: 'get',
      sql: `SELECT COALESCE(SUM(request_count),0) requests, COALESCE(SUM(total_tokens),0) tokens, COALESCE(SUM(latency_sum_ms)*1.0 / NULLIF(SUM(request_count),0), 0) avgLatency, COALESCE(SUM(CASE WHEN success=0 THEN request_count ELSE 0 END)*1.0 / NULLIF(SUM(request_count),0), 0) errorRate FROM usage_hourly_rollup WHERE ${currentWhere}`,
      params: currentParams,
    },
    {
      method: 'all',
      sql: `WITH key_usage AS MATERIALIZED (
        SELECT u.key_hash id, SUM(u.request_count) requests,
          COALESCE(SUM(u.total_tokens),0) tokens,
          SUM(CASE WHEN u.success=0 THEN u.request_count ELSE 0 END) errors
        FROM usage_hourly_rollup u
        WHERE u.key_hash != '' AND u.hour_ms >= ? AND ${scopedProviderPredicate(groups, 'u.provider', currentOnly).sql}
        GROUP BY u.key_hash
      )
      SELECT a.key_hash id, a.name,
        COALESCE(key_usage.requests,0) requests,
        COALESCE(key_usage.tokens,0) tokens,
        CASE WHEN COALESCE(key_usage.requests,0) = 0 THEN 0
          ELSE 1.0 * key_usage.errors / key_usage.requests END errorRate
      FROM api_keys a LEFT JOIN key_usage ON key_usage.id = a.key_hash
      ORDER BY requests DESC, a.key_hash`,
      params: [cutoffEpochMs(days, 'days', now), ...active.params],
    },
    {
      method: 'all',
      sql: `SELECT u.request_id requestId,u.timestamp,u.provider,${canonicalModelSql('u')} model,u.endpoint,u.success,u.status_code statusCode,u.latency_ms latencyMs,u.ttft_ms ttftMs,u.input_tokens inputTokens,u.output_tokens outputTokens,u.reasoning_tokens reasoningTokens,u.cached_tokens cachedTokens,u.cache_write_tokens cacheWriteTokens,u.total_tokens totalTokens,u.error_detail errorDetail,u.error_category errorCategory,u.upstream_request_id upstreamRequestId,u.auth_index authIndex,u.reasoning_effort reasoningEffort,u.service_tier serviceTier,u.user_agent userAgent,${clientTypeSql('u')} clientType,u.client_ip clientIp,a.name keyName FROM usage_events u LEFT JOIN api_keys a ON a.key_hash=u.key_hash WHERE ${requestCurrentWhere} ORDER BY u.timestamp_ms DESC LIMIT 200`,
      params: requestParams,
    },
    {
      method: 'all',
      sql: `SELECT client_type type, SUM(request_count) requests, COALESCE(SUM(total_tokens),0) tokens, COALESCE(SUM(latency_sum_ms)*1.0 / NULLIF(SUM(request_count),0), 0) avgLatency, COALESCE(SUM(CASE WHEN success=0 THEN request_count ELSE 0 END)*1.0 / NULLIF(SUM(request_count),0), 0) errorRate FROM usage_hourly_rollup WHERE ${currentWhere} GROUP BY type ORDER BY requests DESC`,
      params: currentParams,
    },
  ])

  return {
    days,
    summary,
    trend: [],
    groups: [],
    models: [],
    keyUsage,
    requests,
    latency: [],
    statusCodes: [],
    errorCategories: [],
    clients: (clients as Array<Record<string, unknown>>).map((row) => ({
      ...row,
      label: clientLabel(String(row.type || 'unknown')),
    })),
  }
}

/**
 * Display day of a rollup row: the server's local calendar day derived from `hour_ms` (the same clock
 * `buildDailySeries` lays its cells on, and `/me` uses). `day_text` is the UTC date, which put 00:00–08:00
 * Asia/Shanghai on the previous day. Works on raw events too (the read worker maps `hour_ms` → `timestamp_ms`).
 */
const LOCAL_DAY_SQL = `strftime('%Y-%m-%d', hour_ms / 1000, 'unixepoch', 'localtime')`

export async function loadUsageOverviewReport(
  reader: Reader,
  groups: ConsoleGroup[],
  days: number,
  keyId: string,
  now = Date.now(),
  /** 默认统计全部渠道（含已移除渠道的历史）；true = 只看当前渠道 */
  currentOnly = false,
) {
  const { where, params } = usageWindow(days, keyId, 'hour_ms', now)
  const active = scopedProviderPredicate(groups, 'provider', currentOnly)
  const providerExpr = activeProviderExpression(groups, 'provider')
  const currentWhere = `${where} AND ${active.sql}`
  const currentParams = [...params, ...active.params]
  const modelSql = canonicalModelSql()
  const [modelsValue, dailyValue, dailyModelsValue, trackingValue] = await reader.run([
    {
      method: 'all',
      sql: `
        SELECT ${modelSql} model, ${providerExpr.sql} provider, SUM(request_count) requests,
          COALESCE(SUM(CASE WHEN lower(trim(provider)) IN ('claude','claude-api-key','anthropic','anthropic-api-key') THEN input_tokens ELSE uncached_input_tokens END),0) newInputTokens,
          COALESCE(SUM(output_tokens),0) outputTokens,
          COALESCE(SUM(cached_tokens),0) cacheTokens,
          COALESCE(SUM(cache_write_tokens),0) cacheWriteTokens,
          COALESCE(SUM(reasoning_tokens),0) reasoningTokens,
          COALESCE(SUM(total_tokens),0) totalTokens,
          CASE WHEN SUM(cost_usd_count) = SUM(request_count) THEN COALESCE(SUM(cost_usd_sum),0) ELSE NULL END costUsd,
          COUNT(DISTINCT ${LOCAL_DAY_SQL}) activeDays
        FROM usage_hourly_rollup WHERE ${currentWhere}
        GROUP BY ${modelSql}, ${providerExpr.sql} ORDER BY totalTokens DESC
      `,
      params: [...providerExpr.params, ...currentParams, ...providerExpr.params],
    },
    {
      method: 'all',
      sql: `
        SELECT ${LOCAL_DAY_SQL} day, COALESCE(SUM(total_tokens),0) totalTokens,
          SUM(request_count) requests,
          COALESCE(SUM(CASE WHEN lower(trim(provider)) IN ('claude','claude-api-key','anthropic','anthropic-api-key') THEN input_tokens ELSE uncached_input_tokens END),0) newInputTokens,
          COALESCE(SUM(output_tokens),0) outputTokens,
          COALESCE(SUM(cached_tokens),0) cacheTokens,
          COALESCE(SUM(cache_write_tokens),0) cacheWriteTokens,
          CASE WHEN SUM(cost_usd_count) = SUM(request_count) THEN COALESCE(SUM(cost_usd_sum),0) ELSE NULL END costUsd,
          SUM(CASE WHEN success=0 THEN request_count ELSE 0 END) errors
        FROM usage_hourly_rollup WHERE ${currentWhere} GROUP BY day ORDER BY day
      `,
      params: currentParams,
    },
    {
      method: 'all',
      sql: `SELECT ${LOCAL_DAY_SQL} day, ${modelSql} model, COALESCE(SUM(total_tokens),0) totalTokens FROM usage_hourly_rollup WHERE ${currentWhere} GROUP BY day, ${modelSql} ORDER BY day, totalTokens DESC`,
      params: currentParams,
    },
    {
      method: 'get',
      sql: `SELECT MIN(hour_text || ':00:00.000Z') since FROM usage_hourly_rollup WHERE ${currentWhere}`,
      params: currentParams,
    },
  ])
  const models = modelsValue as UsageModelRow[]
  const daily = dailyValue as UsageDailyRow[]
  const dailyModels = dailyModelsValue as Array<{ day: string; model: string; totalTokens: number }>
  const tracking = trackingValue as { since?: string | null } | undefined
  const overview = buildUsageOverview(models, daily, days, new Date(now), dailyModels)
  return { days, trackingSince: tracking?.since ?? null, ...overview }
}

type UsageDailyModelAggregateRow = Omit<UsageDailyRow, 'newInputTokens'> & UsageDailyModelRow & InputTokenAggregate & {
  provider: string
  reasoningTokens: number
  firstTimestampMs: number
}

function usagePageViewsFromRows(rows: UsageDailyModelAggregateRow[], groups: ConsoleGroup[]): {
  models: UsageModelRow[]
  daily: UsageDailyRow[]
  dailyModels: UsageDailyModelRow[]
  trackingSince: string | null
} {
  const days = new Map<string, Required<Omit<UsageDailyRow, 'day'>>>()
  const models = new Map<string, UsageModelRow & { activeDaySet: Set<string> }>()
  const dailyModels = new Map<string, UsageDailyModelRow>()
  let firstTimestampMs = Number.POSITIVE_INFINITY
  for (const row of rows) {
    const normalizedModel = canonicalModelId(row.model)
    const normalizedProvider = activeProviderId(row.provider, groups)
    const newInputTokens = newInputTokensForAggregate(row)
    const modelKey = JSON.stringify([normalizedModel, normalizedProvider])
    const model = models.get(modelKey) ?? {
      model: normalizedModel,
      provider: normalizedProvider,
      requests: 0,
      newInputTokens: 0,
      outputTokens: 0,
      cacheTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
      activeDays: 0,
      activeDaySet: new Set<string>(),
      costUsd: typeof row.costUsd === 'number' && Number.isFinite(row.costUsd) ? Number(row.costUsd) : null,
    }
    model.requests += Number(row.requests) || 0
    model.newInputTokens += newInputTokens
    model.outputTokens += Number(row.outputTokens) || 0
    model.cacheTokens += Number(row.cacheTokens) || 0
    model.cacheWriteTokens = (model.cacheWriteTokens || 0) + (Number(row.cacheWriteTokens) || 0)
    model.reasoningTokens += Number(row.reasoningTokens) || 0
    model.totalTokens += Number(row.totalTokens) || 0
    if (typeof model.costUsd === 'number' && typeof row.costUsd === 'number' && Number.isFinite(row.costUsd)) model.costUsd += Number(row.costUsd)
    else model.costUsd = null
    model.activeDaySet.add(row.day)
    models.set(modelKey, model)

    const day = days.get(row.day) ?? {
      totalTokens: 0,
      requests: 0,
      newInputTokens: 0,
      outputTokens: 0,
      cacheTokens: 0,
      cacheWriteTokens: 0,
      errors: 0,
      costUsd: null,
    }
    day.totalTokens += Number(row.totalTokens) || 0
    day.requests += Number(row.requests) || 0
    day.newInputTokens += newInputTokens
    day.outputTokens += Number(row.outputTokens) || 0
    day.cacheTokens += Number(row.cacheTokens) || 0
    day.cacheWriteTokens += Number(row.cacheWriteTokens) || 0
    day.errors += Number(row.errors) || 0
    if (day.costUsd !== null && typeof row.costUsd === 'number' && Number.isFinite(row.costUsd)) day.costUsd += Number(row.costUsd)
    else day.costUsd = null
    days.set(row.day, day)

    const dailyModelKey = JSON.stringify([row.day, normalizedModel])
    const dailyModel = dailyModels.get(dailyModelKey) ?? { day: row.day, model: normalizedModel, totalTokens: 0 }
    dailyModel.totalTokens += Number(row.totalTokens) || 0
    dailyModels.set(dailyModelKey, dailyModel)
    if (Number.isFinite(row.firstTimestampMs)) firstTimestampMs = Math.min(firstTimestampMs, row.firstTimestampMs)
  }
  return {
    models: [...models.values()]
      .map(({ activeDaySet, ...model }) => ({ ...model, activeDays: activeDaySet.size }))
      .sort((left, right) => right.totalTokens - left.totalTokens),
    daily: [...days].map(([day, totals]) => ({ day, ...totals })).sort((a, b) => a.day.localeCompare(b.day)),
    dailyModels: [...dailyModels.values()],
    trackingSince: Number.isFinite(firstTimestampMs) ? new Date(firstTimestampMs).toISOString() : null,
  }
}

type BreakdownAggregateRow = Omit<BreakdownRow, 'newInputTokens'> & InputTokenAggregate

function breakdownRowFromAggregate(row: BreakdownAggregateRow): BreakdownRow {
  return {
    model: row.model,
    provider: row.provider,
    requests: Number(row.requests) || 0,
    newInputTokens: newInputTokensForAggregate(row),
    outputTokens: Number(row.outputTokens) || 0,
    cacheTokens: Number(row.cacheTokens) || 0,
    cacheWriteTokens: Number(row.cacheWriteTokens) || 0,
    reasoningTokens: Number(row.reasoningTokens) || 0,
    totalTokens: Number(row.totalTokens) || 0,
    costUsd: typeof row.costUsd === 'number' && Number.isFinite(row.costUsd) ? Number(row.costUsd) : null,
  }
}

/** Core payload for the Stats & Usage page; the slower all-key table loads separately. */
export async function loadUsagePageReport(
  reader: Reader,
  groups: ConsoleGroup[],
  days: number,
  keyId: string,
  quotaTimeZone: string,
  now = Date.now(),
  currentOnly = false,
) {
  const { where, params } = usageWindow(days, keyId, 'hour_ms', now)
  const active = scopedProviderPredicate(groups, 'provider', currentOnly)
  const currentWhere = `${where} AND ${active.sql}`
  const currentParams = [...params, ...active.params]
  let rowsValue: unknown
  try {
    ;[rowsValue] = await reader.run([{
      method: 'all',
      sql: `
        SELECT ${LOCAL_DAY_SQL} day, model, provider,
          SUM(request_count) requests, COALESCE(SUM(total_tokens),0) totalTokens,
          COALESCE(SUM(input_tokens),0) inputTokens,
          COALESCE(SUM(uncached_input_tokens),0) /* SUM(MAX(input_tokens - cached_tokens, 0)) */ uncachedInputTokens,
          COALESCE(SUM(output_tokens),0) outputTokens,
          COALESCE(SUM(cached_tokens),0) cacheTokens,
          COALESCE(SUM(cache_write_tokens),0) cacheWriteTokens,
          CASE WHEN SUM(cost_usd_count) = SUM(request_count) THEN COALESCE(SUM(cost_usd_sum),0) ELSE NULL END costUsd,
          COALESCE(SUM(reasoning_tokens),0) reasoningTokens,
          SUM(CASE WHEN success=0 THEN request_count ELSE 0 END) errors,
          MIN(first_timestamp_ms) /* MIN(timestamp_ms) firstTimestampMs */ firstTimestampMs
        FROM usage_hourly_rollup WHERE ${currentWhere}
        GROUP BY key_hash, day, model, provider
        ORDER BY day, totalTokens DESC
      `,
      params: currentParams,
    }])
  } catch (error) {
    if (error instanceof Error && error.message.includes('no such table: usage_hourly_rollup')) {
      const legacyWhere = `${usageWindow(days, keyId, 'timestamp_ms', now).where} AND ${active.sql}`
      const legacyParams = [...usageWindow(days, keyId, 'timestamp_ms', now).params, ...active.params]
      ;[rowsValue] = await reader.run([{
        method: 'all',
        sql: `
          SELECT ${LOCAL_DAY_SQL.replace('hour_ms', 'timestamp_ms')} day, model, provider,
            COUNT(*) requests, COALESCE(SUM(total_tokens),0) totalTokens,
            COALESCE(SUM(input_tokens),0) inputTokens,
            COALESCE(SUM(MAX(input_tokens - cached_tokens, 0)),0) uncachedInputTokens,
            COALESCE(SUM(output_tokens),0) outputTokens,
            COALESCE(SUM(cached_tokens),0) cacheTokens,
            COALESCE(SUM(cache_write_tokens),0) cacheWriteTokens,
            CASE WHEN COUNT(cost_usd) = COUNT(*) THEN COALESCE(SUM(cost_usd),0) ELSE NULL END costUsd,
            COALESCE(SUM(reasoning_tokens),0) reasoningTokens,
            SUM(CASE WHEN success=0 THEN 1 ELSE 0 END) errors,
            MIN(timestamp_ms) firstTimestampMs
          FROM usage_events INDEXED BY idx_usage_key_rollup WHERE ${legacyWhere}
          GROUP BY key_hash, day, model, provider
          ORDER BY day, totalTokens DESC
        `,
        params: legacyParams,
      }])
    } else {
      throw error
    }
  }
  const { models, daily, dailyModels, trackingSince } = usagePageViewsFromRows(rowsValue as UsageDailyModelAggregateRow[], groups)
  const overview = buildUsageOverview(models, daily, days, new Date(now), dailyModels)
  return {
    days,
    keyId,
    quotaTimeZone,
    trackingSince,
    ...overview,
  }
}

/** All-key cost summaries are intentionally isolated so they cannot delay the usage-page core. */
export async function loadUsageKeySummariesReport(
  reader: Reader,
  groups: ConsoleGroup[],
  days: number,
  now = Date.now(),
  currentOnly = false,
) {
  const active = scopedProviderPredicate(groups, 'u.provider', currentOnly)
  const [keyRowsValue] = await reader.run([{
    method: 'all',
    sql: `
      WITH key_usage AS MATERIALIZED (
        SELECT u.key_hash id, u.model, u.provider,
          SUM(u.request_count) requests, COALESCE(SUM(u.input_tokens),0) inputTokens,
          COALESCE(SUM(u.uncached_input_tokens),0) uncachedInputTokens,
          COALESCE(SUM(u.output_tokens),0) outputTokens,
          COALESCE(SUM(u.cached_tokens),0) cacheTokens,
          COALESCE(SUM(u.cache_write_tokens),0) cacheWriteTokens,
          COALESCE(SUM(u.reasoning_tokens),0) reasoningTokens,
          COALESCE(SUM(u.total_tokens),0) totalTokens,
          CASE WHEN SUM(u.cost_usd_count) = SUM(u.request_count) THEN COALESCE(SUM(u.cost_usd_sum),0) ELSE NULL END costUsd
        FROM usage_hourly_rollup u
        WHERE u.key_hash != '' AND u.hour_ms >= ? AND ${active.sql}
        GROUP BY u.key_hash, u.day_text, u.model, u.provider
      )
      SELECT key_usage.*, a.name FROM key_usage
      JOIN api_keys a ON a.key_hash = key_usage.id
    `,
    params: [cutoffEpochMs(days, 'days', now), ...active.params],
  }])
  const byKey = new Map<string, { id: string; name: string; rows: BreakdownRow[] }>()
  for (const row of keyRowsValue as Array<BreakdownAggregateRow & { id: string; name: string }>) {
    const entry = byKey.get(row.id) ?? { id: row.id, name: row.name, rows: [] }
    entry.rows.push(breakdownRowFromAggregate(row))
    byKey.set(row.id, entry)
  }
  const keySummaries = [...byKey.values()].map((entry) => {
    const breakdown = buildUsageBreakdown(entry.rows)
    return {
      id: entry.id,
      name: entry.name,
      totals: breakdown.totals,
      hasUnpricedModels: breakdown.unpricedModels.length > 0,
    }
  }).sort((a, b) => b.totals.totalCostUsd - a.totals.totalCostUsd)
  return { days, keySummaries }
}

export async function loadUsageBreakdownReport(
  reader: Reader,
  groups: ConsoleGroup[],
  days: number,
  keyId: string,
  quotaTimeZone: string,
  now = Date.now(),
  currentOnly = false,
) {
  const { where, params } = usageWindow(days, keyId, 'hour_ms', now)
  const active = scopedProviderPredicate(groups, 'provider', currentOnly)
  const [rowsValue, keyRowsValue] = await reader.run([
    {
      method: 'all',
      sql: `
        SELECT ${canonicalModelSql()} model, provider, SUM(request_count) requests,
          COALESCE(SUM(CASE WHEN lower(trim(provider)) IN ('claude','claude-api-key','anthropic','anthropic-api-key') THEN input_tokens ELSE uncached_input_tokens END),0) newInputTokens,
          COALESCE(SUM(output_tokens),0) outputTokens,
          COALESCE(SUM(cached_tokens),0) cacheTokens,
          COALESCE(SUM(cache_write_tokens),0) cacheWriteTokens,
          COALESCE(SUM(reasoning_tokens),0) reasoningTokens,
          COALESCE(SUM(total_tokens),0) totalTokens,
          CASE WHEN SUM(cost_usd_count) = SUM(request_count) THEN COALESCE(SUM(cost_usd_sum),0) ELSE NULL END costUsd
        FROM usage_hourly_rollup WHERE ${where} AND ${active.sql}
        GROUP BY ${canonicalModelSql()}, provider
      `,
      params: [...params, ...active.params],
    },
    {
      method: 'all',
      sql: `
        SELECT a.key_hash id, a.name, ${canonicalModelSql('u')} model, u.provider,
          SUM(u.request_count) requests,
          COALESCE(SUM(CASE WHEN lower(trim(u.provider)) IN ('claude','claude-api-key','anthropic','anthropic-api-key') THEN u.input_tokens ELSE u.uncached_input_tokens END),0) newInputTokens,
          COALESCE(SUM(u.output_tokens),0) outputTokens,
          COALESCE(SUM(u.cached_tokens),0) cacheTokens,
          COALESCE(SUM(u.cache_write_tokens),0) cacheWriteTokens,
          COALESCE(SUM(u.reasoning_tokens),0) reasoningTokens,
          COALESCE(SUM(u.total_tokens),0) totalTokens
        FROM api_keys a JOIN usage_hourly_rollup u ON u.key_hash = a.key_hash AND u.hour_ms >= ? AND ${scopedProviderPredicate(groups, 'u.provider', currentOnly).sql}
        GROUP BY a.key_hash, ${canonicalModelSql('u')}, u.provider
      `,
      params: [cutoffEpochMs(days, 'days', now), ...active.params],
    },
  ])
  const rows = rowsValue as BreakdownRow[]
  const keyRows = keyRowsValue as Array<BreakdownRow & { id: string; name: string }>
  const byKey = new Map<string, { id: string; name: string; rows: BreakdownRow[] }>()
  for (const row of keyRows) {
    const entry = byKey.get(row.id) || { id: row.id, name: row.name, rows: [] }
    entry.rows.push(row)
    byKey.set(row.id, entry)
  }
  const keys = [...byKey.values()]
    .map((entry) => ({ id: entry.id, name: entry.name, ...buildUsageBreakdown(entry.rows) }))
    .sort((a, b) => b.totals.totalCostUsd - a.totals.totalCostUsd)
  return { days, keyId, quotaTimeZone, ...buildUsageBreakdown(rows), keys }
}

/**
 * 缓存命中率趋势。
 *
 * keyId 直接进 SQL（key_hash 等值过滤，仍走 idx_usage_cache_rollup 做前缀扫描）；
 * provider 与 clientType 一样在 Node 侧裁剪，这样 `providers` / `clients` 两个
 * 筛选器的计数都能反映「当前模型 + Key」下各渠道 / 各客户端的真实请求量。
 */
export async function loadCacheTrendReport(
  reader: Reader,
  groups: ConsoleGroup[],
  hours: number,
  model: string,
  clientType: string,
  keyId = '',
  provider = '',
  now = Date.now(),
  /** 默认统计全部渠道（含已移除渠道的历史）；true = 只看当前渠道 */
  currentOnly = false,
) {
  const cutoff = cutoffEpochMs(hours, 'hours', now)
  /**
   * 下面每个 provider 一条查询（读线程的 rollup 路由按位置读 `[cutoff, cutoff, provider(, keyId)]`，形状不能变）。
   * 全部渠道口径下，provider 清单取窗口内出现过的全部写法（rollup 整点桶覆盖窗口开头那一小时）。
   */
  const providerValues = currentOnly
    ? activeProviderValues(groups)
    : ((await reader.run([{
        method: 'all',
        sql: 'SELECT lower(trim(provider)) p /* cache-trend-providers */ FROM usage_hourly_rollup WHERE hour_ms >= ? AND success = 1 GROUP BY p ORDER BY p',
        params: [Math.floor(cutoff / 3_600_000) * 3_600_000],
      }]))[0] as Array<{ p: string | null }>).map((row) => String(row.p ?? ''))
  const keyClause = keyId ? ' AND key_hash = ?' : ''
  /**
   * 预聚合粒度 = **最终展示粒度**（task-59 ①）。
   *
   * 原来这里按 `CAST(timestamp_ms / 3600000)` + `CAST(timestamp_ms / 60000)`（小时 × 分钟）分组，
   * 再由 JS 把分钟行合并成展示桶（168h → 6 小时桶、720h → 24 小时桶）。实测（生产规模临时库，
   * 168h 窗口）：分钟级分组产生 **91,549 行**，最终桶只需 **1,190 行**——77× 的无效行要跨线程搬到 JS 里再合并，
   * 这是 cache-trend 在 events 路径上最慢的原因（720h 窗口 325,795 行 → 684ms；优化后见文档）。
   *
   * 语法上仍返回 `minuteBucket` 这个名字，但值是**已经对齐到展示桶的分钟数**
   * （`floor(ts / bucketMs) * bucketMs / 60000`），因此下面 JS 的
   * `floor(minuteBucket * 60000 / bucketMs) * bucketMs` 得到的桶边界与原来**完全一致**，
   * 聚合和（COUNT/SUM）也完全一致（求和与分组粒度无关）。逐项一致性对照见
   * `docs/qa/blue/report-performance.md`。
   *
   * 参数表因此与原来**完全一致**（不新增占位符），读线程的 rollup 路由仍按位置读到
   * cutoff/provider/key。
   *
   * SQL 里的 `/* cache-trend-window-hours:<hours> *\/` 注释是给读线程的**路由判据**：
   * rollup 行只有**小时**粒度，短窗口（请求 1/5/15 分钟桶）走 rollup 会把曲线变粗，而且实测
   * 短窗口 events 路径更快（见 docs/qa/blue/report-performance.md 附录 C）；因此只有
   * `hours > 168` 的长窗口才值得路由到 rollup。注释用我们自己生成的固定格式，解析面很小。
   */
  const bucketMs = bucketSecondsFor(hours) * 1_000
  /**
   * 桶宽**内联**进 SQL（不占位）：`hours` 是路由里校验过的整数，`bucketSecondsFor` 只返回固定档位，
   * 因此没有注入面。关键是**不能**多一个占位符——读线程的 rollup 路由按位置读 params[0]/[2]/[3]，
   * 参数表必须保持 `[cutoff, cutoff, provider(, keyId)]`。
   */
  const bucketExpr = `CAST(timestamp_ms / ${bucketMs} AS INTEGER) * ${Math.round(bucketMs / 60_000)}`
  const operations = providerValues.map((activeProvider) => ({
    method: 'all' as const,
    sql: `SELECT ${bucketExpr} minuteBucket,
      ${canonicalModelSql()} model, provider,
      ${clientTypeSql()} clientType,
      MIN(timestamp_ms) firstTimestampMs, COUNT(*) requests,
      COALESCE(SUM(input_tokens),0) inputTokens,
      COALESCE(SUM(MAX(input_tokens - cached_tokens, 0)),0) uncachedInputTokens,
      COALESCE(SUM(cached_tokens),0) cacheReadTokens,
      COALESCE(SUM(cache_write_tokens),0) cacheWriteTokens,
      COALESCE(SUM(output_tokens),0) outputTokens,
      CASE WHEN COUNT(cost_usd) = COUNT(*) THEN COALESCE(SUM(cost_usd),0) ELSE NULL END costUsd
      FROM usage_events INDEXED BY idx_usage_cache_rollup /* cache-trend-window-hours:${hours} */
      WHERE timestamp_ms >= ?
        AND CAST(timestamp_ms / 3600000 AS INTEGER) >= CAST(? / 3600000 AS INTEGER)
        AND success = 1 AND lower(trim(provider)) = ?${keyClause}
      GROUP BY ${bucketExpr}, ${canonicalModelSql()},
        provider, clientType`,
    params: keyId ? [cutoff, cutoff, activeProvider, keyId] : [cutoff, cutoff, activeProvider],
  }))
  const values = operations.length ? await runIndependent(reader, operations) : []
  type CacheAggregateRow = InputTokenAggregate & {
    minuteBucket: number
    firstTimestampMs: number
    clientType: string
    requests: number
    cacheReadTokens: number
    cacheWriteTokens: number
    outputTokens: number
    costUsd: number | null
  }
  const aggregateRows = (values as CacheAggregateRow[][]).flat()
  const models = [...new Set(aggregateRows.map((row) => row.model))].sort()
  const clientsByType = new Map<string, number>()
  const requestsByProvider = new Map<string, number>()
  const providerFilter = provider ? activeProviderId(provider, groups) : ''
  type CacheRollup = TrendRow & { firstTimestampMs: number; costSum: number; costComplete: boolean }
  const rowsByBucket = new Map<string, CacheRollup>()
  for (const row of aggregateRows) {
    const type = row.clientType || 'legacy-unknown'
    const providerId = activeProviderId(String(row.provider || ''), groups)
    const modelMatches = !model || row.model === model
    const providerMatches = !providerFilter || providerId === providerFilter
    const clientMatches = !clientType || type === clientType
    // 两个筛选器的计数互相不裁剪自己：渠道计数只看模型 + 客户端，客户端计数只看模型 + 渠道。
    if (modelMatches && clientMatches) {
      requestsByProvider.set(providerId, (requestsByProvider.get(providerId) || 0) + (Number(row.requests) || 0))
    }
    if (modelMatches && providerMatches) {
      clientsByType.set(type, (clientsByType.get(type) || 0) + (Number(row.requests) || 0))
    }
    if (!modelMatches || !clientMatches || !providerMatches) continue
    const bucketStart = Math.floor((Number(row.minuteBucket) * 60_000) / bucketMs) * bucketMs
    const key = JSON.stringify([bucketStart, row.model, row.provider])
    const aggregate = rowsByBucket.get(key) ?? {
      timestamp: new Date(bucketStart).toISOString(),
      model: row.model,
      provider: row.provider,
      requests: 0,
      freshInputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
      inputTokens: 0,
      cachedTokens: 0,
      // costUsd 由 costSum + costComplete 推导（见下方累加处与输出处）：SQL 的
      // `CASE WHEN COUNT(cost_usd)=COUNT(*) THEN SUM(cost_usd) ELSE NULL END` 语义是
      // 「桶内每一行都有金额才给合计，否则整体为 null」，与分组粒度无关。
      costSum: 0,
      costComplete: true,
      firstTimestampMs: Number.POSITIVE_INFINITY,
    }
    aggregate.requests = (aggregate.requests || 0) + (Number(row.requests) || 0)
    aggregate.freshInputTokens = (aggregate.freshInputTokens || 0) + newInputTokensForAggregate(row, true)
    aggregate.cacheReadTokens = (aggregate.cacheReadTokens || 0) + (Number(row.cacheReadTokens) || 0)
    aggregate.cacheWriteTokens = (aggregate.cacheWriteTokens || 0) + (Number(row.cacheWriteTokens) || 0)
    aggregate.outputTokens += Number(row.outputTokens) || 0
    /**
     * 金额累加（task-59 ①）。原实现是「初始化就用第一行的值，然后对同一行再 += 一次」——
     * 第一行的金额被**计了两次**。分钟级分组时每组行数多、误差被稀释（实测只偏高几个百分点到
     * 1.96×，取决于每组行数），看不出问题；改成按展示桶分组后每组只有 1–2 行，误差直接变成 ~2×，
     * 被 before/after 指纹比对抓出来（见 `docs/qa/blue/report-performance.md` 的一致性对照）。
     * 这里改成「先标记完整性、再逐行累加一次」，结果与分组粒度无关，且等于桶内金额的真实合计
     * （独立 SQL `SUM(cost_usd)` 已对拍）。
     */
    if (typeof row.costUsd === 'number' && Number.isFinite(row.costUsd)) aggregate.costSum += Number(row.costUsd)
    else aggregate.costComplete = false
    aggregate.firstTimestampMs = Math.min(aggregate.firstTimestampMs, Number(row.firstTimestampMs))
    rowsByBucket.set(key, aggregate)
  }
  const rows = [...rowsByBucket.values()]
    .sort((left, right) => left.firstTimestampMs - right.firstTimestampMs)
    .map(({ firstTimestampMs: _, costSum, costComplete, ...row }) => ({
      ...row,
      costUsd: costComplete ? costSum : null,
    }))
  const clients = [...clientsByType].map(([type, requests]) => ({ type, requests }))
    .sort((left, right) => right.requests - left.requests)
  const providers = [...requestsByProvider].map(([id, requests]) => ({ id, label: channelLabel(id), requests }))
    .sort((left, right) => right.requests - left.requests)
  return {
    hours,
    model,
    client: clientType,
    keyId,
    provider,
    models,
    clients: clients.map((item) => ({
      type: item.type || 'legacy-unknown',
      label: clientLabel(item.type || 'legacy-unknown'),
      requests: item.requests,
    })),
    providers,
    ...buildTrend(rows, hours),
  }
}

/* ─────────────────────────── 用量工作台（DESIGN §6.7：总览 · 请求 · 共享筛选） ───────────────────────────
 *
 * 跨页数字对不上的根因（红队 P0 #3），这一节逐条收口：
 * 1. 「按 Key 0 把」：页面从 `/api/usage-overview` 读 `keySummaries`，而 `loadUsageOverviewReport` 从来不返回它。
 *    这里的总览由**同一批**细粒度 rollup 行同时算出账本、按 Key / 模型 / 渠道 / 客户端排行与失败构成，
 *    所以任一排行的合计都等于账本。
 * 2. 「活跃 14/14」：没有任何 loader 给出「窗口内有调用的 Key」，页面只能拿已启用数顶替。这里给 activeKeys，
 *    概览接口（loadDashboardReport）同口径附带同一个数。
 * 3. 窗口：rollup 的 `hour_ms >= now−N·24h` 实际从下一个整点开始，而事件表 `timestamp_ms >= now−N·24h` 多算了开头那
 *    不足一小时 —— 请求流水 / 错误类别（事件表）与账本（rollup）因此差出一截。这里两边共用同一个整点起点。
 * 4. 口径（2026-10-02 决定）：默认统计**全部流量**，包括后来被移除的渠道（历史就是历史，花了就是花了），与 /me、
 *    /keys、概览同一个数；走已移除渠道的部分作为 `scope.removed` 如实给出，页面写「含已移除渠道 N 次」，排行里的
 *    渠道带 `removed` 标记。「只看当前渠道」（`currentOnly`）是显式选择的筛选，此时那部分进 `scope.excluded`。
 * 5. 日界：rollup 的 day_text 是 UTC 日，页面按 Asia/Shanghai 展示；热力图的「天」在这里按配置时区切。
 * 6. 花费：已入账的 cost_usd 原样保留，只给没有入账的请求按「发生那一小时的价格 + 该片平均提示长度的长上下文分档」估算
 *    （usageCost.ts）；部分入账的组不再整组按今天的价格重估。账本、排行、热力图用同一批片，所以加得起来。
 * 7. 缓存命中率 / 缓存净节省：与缓存页签同一套（cacheSummary.buildCacheSummary：只算支持缓存的模型、只算成功请求、
 *    按小时价），总览账本、构成、筛选条徽标读的就是它，同一筛选只有一个数。
 * 8. 窗口终点：当前小时结束为止；比当前小时更晚的行（时钟漂移）不计，与缓存 / 性能页签同一规则。
 */

const WS_DAY_MS = 86_400_000
const WS_HOUR_MS = 3_600_000
export const USAGE_WORKSPACE_DAYS = [1, 7, 30, 90] as const
export const USAGE_ERROR_CATEGORIES = [
  'rate_limited', 'quota_exhausted', 'upstream_5xx', 'upstream_eof', 'auth_failed',
  'client_cancelled', 'context_too_large', 'wrong_endpoint', 'other',
] as const

export type UsageWorkspaceFilter = {
  days: number
  /** key_hash；'' = 全部 */
  keyId: string
  /** 规范化模型 id（去渠道前缀）；'' = 全部 */
  model: string
  /** 渠道 id（`openai-compatible-x` 折叠为 `x`）；'' = 全部当前渠道 */
  provider: string
  /** client_type；'' = 全部 */
  client: string
  /** true = 只看当前渠道（显式筛选）；缺省 / false = 全部渠道，含已移除渠道的历史 */
  currentOnly?: boolean
  /**
   * 自定义窗口（配置时区的日历日 YYYY-MM-DD，含首尾）：两者同时出现才生效，由 parseUsageWindowSpan 校验并夹到保留期内；
   * 此时 `days` = 跨度天数，窗口 = [from 00:00, to 次日 00:00 与当前小时结束取早者)。缺省 = 按 `days` 的滚动窗口。
   */
  from?: string
  to?: string
}

export type UsageWorkspaceWindow = {
  days: number
  fromMs: number
  toMs: number
  prevFromMs: number
  /** 查询上界（不含）：当前小时结束。rollup `hour_ms < endMs` 与事件 `timestamp_ms < endMs` 逐条等价 */
  endMs: number
}

/** 一个窗口给所有数：起点取 `now − N·24h` 之后的第一个整点，rollup（小时桶）与事件表因此逐条可比。 */
export function usageWorkspaceWindow(days: number, now = Date.now()): UsageWorkspaceWindow {
  const fromMs = Math.ceil((now - days * WS_DAY_MS) / WS_HOUR_MS) * WS_HOUR_MS
  return { days, fromMs, toMs: now, prevFromMs: fromMs - days * WS_DAY_MS, endMs: Math.floor(now / WS_HOUR_MS) * WS_HOUR_MS + WS_HOUR_MS }
}

/** 配置时区里某个日历日（YYYY-MM-DD）的 00:00，UTC 毫秒。 */
export function zoneDayStartMs(day: string, timeZone: string, at = Date.now()): number {
  return Date.parse(`${day}T00:00:00.000Z`) - zoneOffsetMs(timeZone, at)
}

/** 配置时区里 `at` 所在的日历日（YYYY-MM-DD）。 */
export function zoneDayKey(at: number, timeZone: string): string {
  return new Date(at + zoneOffsetMs(timeZone, at)).toISOString().slice(0, 10)
}

/**
 * 筛选的窗口：带 from/to 时是那几个整天（终点不超过当前小时结束，跨度含今天时就是「截至现在」）；
 * 否则是 `usageWorkspaceWindow(days)` 的滚动窗口。前一窗口总是紧挨着、等长。
 */
export function usageFilterWindow(filter: Pick<UsageWorkspaceFilter, 'days' | 'from' | 'to'>, now: number, timeZone: string): UsageWorkspaceWindow {
  if (!filter.from || !filter.to) return usageWorkspaceWindow(filter.days, now)
  const fromMs = zoneDayStartMs(filter.from, timeZone, now)
  const dayEndMs = zoneDayStartMs(filter.to, timeZone, now) + WS_DAY_MS
  const days = Math.max(1, Math.round((dayEndMs - fromMs) / WS_DAY_MS))
  const currentEnd = Math.floor(now / WS_HOUR_MS) * WS_HOUR_MS + WS_HOUR_MS
  return { days, fromMs, toMs: Math.min(now, dayEndMs), prevFromMs: fromMs - days * WS_DAY_MS, endMs: Math.min(dayEndMs, currentEnd) }
}

/** 响应里的窗口：自定义跨度时多一个 `span`（旧客户端忽略它）。 */
function windowView(filter: UsageWorkspaceFilter, fromMs: number, toMs: number, timeZone: string) {
  return {
    days: filter.days,
    from: new Date(fromMs).toISOString(),
    to: new Date(toMs).toISOString(),
    timeZone,
    span: filter.from && filter.to ? { from: filter.from, to: filter.to } : null,
  }
}

/** 时区相对 UTC 的偏移（毫秒）。Asia/Shanghai 无夏令时，按 `at` 时刻取一次即可。 */
export function zoneOffsetMs(timeZone: string, at = Date.now()): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(at))
    const part = (type: string) => Number(parts.find((item) => item.type === type)?.value)
    const local = Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'), part('second'))
    const offset = local - Math.floor(at / 1000) * 1000
    return Number.isFinite(offset) ? offset : 8 * WS_HOUR_MS
  } catch {
    return 8 * WS_HOUR_MS
  }
}

/** 渠道 id：当前分组里的写法优先；不在当前分组的兼容渠道去掉 `openai-compatible-` 前缀，和当前写法对齐。 */
export function usageChannelId(provider: string, groups: ConsoleGroup[]): string {
  const id = activeProviderId(provider, groups)
  if (groups.some((group) => group.id === id)) return id
  return id.startsWith('openai-compatible-') && id.length > 'openai-compatible-'.length ? id.slice('openai-compatible-'.length) : id
}

/**
 * `usageChannelId` 的 SQL 版本：当前分组的各种写法折成分组 id，不在当前分组的兼容渠道去掉 `openai-compatible-`
 * 前缀，空值记 `unknown`。按渠道分区的统计（分位数）用它，id 才和排行、筛选条对得上。
 */
export function usageChannelSql(groups: ConsoleGroup[], column = 'provider') {
  const raw = `lower(trim(${column}))`
  const cases: string[] = []
  const params: string[] = []
  for (const group of groups) {
    const aliases = activeProviderValues([group])
    if (!aliases.length) continue
    cases.push(`WHEN ${raw} IN (${aliases.map(() => '?').join(', ')}) THEN ?`)
    params.push(...aliases, group.id)
  }
  cases.push(`WHEN ${raw} = '' THEN 'unknown'`)
  cases.push(`WHEN ${raw} LIKE 'openai-compatible-_%' THEN substr(${raw}, ${'openai-compatible-'.length + 1})`)
  return { sql: `(CASE ${cases.join(' ')} ELSE ${raw} END)`, params }
}

function usageChannelLabel(id: string, groups: ConsoleGroup[]): string {
  return groups.find((group) => group.id === id)?.name || channelLabel(id)
}

/** 一个渠道 id 在 usage 里可能出现的全部写法（当前分组沿用 activeProviderValues 的别名规则）。 */
function usageChannelAliases(id: string, groups: ConsoleGroup[]): string[] {
  const value = id.trim().toLowerCase()
  const group = groups.find((item) => item.id.toLowerCase() === value)
  if (group) return activeProviderValues([group])
  const bare = value.startsWith('openai-compatible-') ? value.slice('openai-compatible-'.length) : value
  return [...new Set([value, bare, `openai-compatible-${bare}`])]
}

type FilterPart = 'keyId' | 'model' | 'provider' | 'client'

/**
 * 工作台的唯一筛选谓词（渠道口径 + Key / 模型 / 渠道 / 客户端），rollup 与事件表共用。
 * 渠道口径跟着 `filter.currentOnly`：缺省统计全部渠道，只有显式「只看当前渠道」时才套当前分组白名单。
 * `skip` 用来算筛选项计数：每个筛选器的计数只受**其它**筛选约束，不受自己约束。
 */
export function usageWorkspacePredicate(
  groups: ConsoleGroup[],
  filter: Pick<UsageWorkspaceFilter, FilterPart | 'currentOnly'>,
  source: 'rollup' | 'events',
  alias = '',
  skip: Partial<Record<FilterPart, boolean>> = {},
  currentOnly = Boolean(filter.currentOnly),
): { sql: string; params: string[] } {
  const p = alias ? `${alias}.` : ''
  const parts: string[] = []
  const params: string[] = []
  if (currentOnly) {
    const active = activeProviderPredicate(groups, `${p}provider`)
    parts.push(active.sql)
    params.push(...active.params)
  }
  if (filter.keyId && !skip.keyId) {
    parts.push(`${p}key_hash = ?`)
    params.push(filter.keyId)
  }
  if (filter.model && !skip.model) {
    parts.push(`${canonicalModelSql(alias)} = ?`)
    params.push(filter.model)
  }
  if (filter.provider && !skip.provider) {
    const aliases = usageChannelAliases(filter.provider, groups)
    parts.push(`lower(trim(${p}provider)) IN (${aliases.map(() => '?').join(', ')})`)
    params.push(...aliases)
  }
  if (filter.client && !skip.client) {
    parts.push(source === 'rollup' ? `${p}client_type = ?` : `${clientTypeSql(alias)} = ?`)
    params.push(filter.client)
  }
  return { sql: parts.length ? parts.join(' AND ') : '1 = 1', params }
}

/** 细粒度 rollup 行：账本、排行、失败构成都从同一批行折叠出来。 */
type WorkspaceRow = {
  k: string
  m: string
  p: string
  c: string
  s: number
  sc: number
  ec: string
  n: number
  t: number
  i: number
  ui: number
  o: number
  cr: number
  cw: number
  r: number
  l: number
  cs: number
  cc: number
}

const WORKSPACE_SUMS = `SUM(request_count) n, COALESCE(SUM(total_tokens),0) t,
  COALESCE(SUM(input_tokens),0) i, COALESCE(SUM(uncached_input_tokens),0) ui,
  COALESCE(SUM(output_tokens),0) o, COALESCE(SUM(cached_tokens),0) cr, COALESCE(SUM(cache_write_tokens),0) cw,
  COALESCE(SUM(reasoning_tokens),0) r, COALESCE(SUM(latency_sum_ms),0) l,
  COALESCE(SUM(cost_usd_sum),0) cs, COALESCE(SUM(cost_usd_count),0) cc`

function workspaceRowsSql(where: string): string {
  return `SELECT key_hash k, ${canonicalModelSql()} m, lower(trim(provider)) p, client_type c,
      success s, status_code sc, error_category ec, ${WORKSPACE_SUMS}
    FROM usage_hourly_rollup WHERE ${where}
    GROUP BY key_hash, ${canonicalModelSql()}, lower(trim(provider)), client_type, success, status_code, error_category`
}

const num = (value: unknown) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

export type WorkspaceCost = CostPart

/**
 * 一组行的花费：已入账的 cost_usd 全部保留，只估算没有入账的请求（usageCost.ts 的规则）。
 * `uncosted` = 这组里未入账请求的片（按发生小时、分档按片内平均提示长度）；不给时只知道整组的 token，
 * 就按未入账请求的占比摊出它们的 token，以今天的价格、整组平均提示长度分档估算（≈）。
 */
export function workspaceRowCost(
  row: Pick<WorkspaceRow, 'm' | 'p' | 'n' | 'i' | 'ui' | 'o' | 'cr' | 'cw' | 't' | 'cs' | 'cc'>,
  uncosted?: UncostedRow[],
): WorkspaceCost {
  const requests = num(row.n)
  const ledgerCount = num(row.cc)
  if (requests <= 0 || ledgerCount >= requests) return { usd: num(row.cs), unpricedRequests: 0, estimated: false }
  if (uncosted) return addParts([ledgerPart(row), ...uncosted.map(estimateUncosted)])
  const missing = requests - ledgerCount
  const share = missing / requests
  const part = estimateUncosted({
    h: 0, m: row.m, p: row.p, n: missing,
    i: num(row.i) * share, ui: num(row.ui) * share, o: num(row.o) * share, cr: num(row.cr) * share, cw: num(row.cw) * share, t: num(row.t) * share,
  })
  return addParts([ledgerPart(row), part])
}

/** 未入账片 + 估算结果；按自己的 Key / 模型 / 渠道 / 客户端 / 小时归到账本、排行与日格。 */
type PricedPart = UncostedRow & { cost: CostPart }

const pricedParts = (rows: UncostedRow[]): PricedPart[] => rows.map((row) => ({ ...row, cost: estimateUncosted(row) }))

const isAnthropicDialect = (provider: string) => nativeAnthropicProviders.has(String(provider || '').toLowerCase())

type Tally = {
  requests: number
  errors: number
  tokens: number
  freshInput: number
  output: number
  cacheRead: number
  cacheWrite: number
  /** 只算原生 Anthropic 的写入段：兼容口径没有独立的缓存写入（cacheStats.normalizeTokens 同一规则） */
  cacheWriteBilled: number
  reasoning: number
  latencySumMs: number
  cost: number
  priced: boolean
  estimated: boolean
  unpricedRequests: number
}

const emptyTally = (): Tally => ({
  requests: 0, errors: 0, tokens: 0, freshInput: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWriteBilled: 0,
  reasoning: 0, latencySumMs: 0, cost: 0, priced: false, estimated: false, unpricedRequests: 0,
})

/** 只记花费（未入账片的估算）：请求数与 token 已经由 rollup 行计过。 */
function addCost(tally: Tally, cost: CostPart) {
  if (cost.usd !== null) {
    tally.cost += cost.usd
    tally.priced = true
  }
  if (cost.estimated) tally.estimated = true
  tally.unpricedRequests += cost.unpricedRequests
}

function addRow(tally: Tally, row: WorkspaceRow, cost: WorkspaceCost) {
  const requests = num(row.n)
  tally.requests += requests
  if (!num(row.s)) tally.errors += requests
  tally.tokens += num(row.t)
  tally.freshInput += newInputTokensForAggregate({ model: row.m, provider: row.p, inputTokens: num(row.i), uncachedInputTokens: num(row.ui) }, true)
  tally.output += num(row.o)
  tally.cacheRead += num(row.cr)
  tally.cacheWrite += num(row.cw)
  if (isAnthropicDialect(row.p)) tally.cacheWriteBilled += num(row.cw)
  tally.reasoning += num(row.r)
  tally.latencySumMs += num(row.l)
  if (cost.usd !== null) {
    tally.cost += cost.usd
    tally.priced = true
  }
  if (cost.estimated) tally.estimated = true
  tally.unpricedRequests += cost.unpricedRequests
}

const costOf = (tally: Tally) => (tally.priced ? tally.cost : null)
const ratio = (part: number, whole: number) => (whole > 0 ? part / whole : null)

export type UsageWorkspaceLedger = {
  requests: number
  errors: number
  errorRate: number | null
  tokens: number
  costUsd: number | null
  /** 含按当前单价估算的部分（≈） */
  costEstimated: boolean
  /** 有模型未定价：花费只是已定价部分 */
  hasPartialCost: boolean
  unpricedRequests: number
  unpricedModels: string[]
  /** = 缓存页签 totals.hitRate：缓存读 ÷（新输入 + 缓存读 + 缓存写），只算成功请求、只算支持缓存的模型 */
  cacheHitRate: number | null
  /** = 缓存页签 excluded.models：不支持缓存、不计入命中率的模型数 */
  cacheIdleModels: number
  activeKeys: number
  enabledKeys: number
  totalKeys: number
  avgLatencyMs: number | null
}

/** 同一筛选下缓存页签的数（命中率、不支持缓存的模型、净节省），工作台各处原样引用。 */
type CacheFigures = Pick<CacheSummary, 'totals' | 'excluded'>

function ledgerOf(rows: WorkspaceRow[], parts: PricedPart[], keys: Map<string, { name: string; enabled: boolean }>, cache: CacheFigures) {
  const total = emptyTally()
  const unpriced = new Set<string>()
  const active = new Set<string>()
  for (const row of rows) {
    addRow(total, row, ledgerPart(row))
    if (num(row.n) > 0 && keys.has(row.k)) active.add(row.k)
  }
  for (const part of parts) {
    addCost(total, part.cost)
    if (part.cost.unpricedRequests > 0) unpriced.add(part.m || 'unknown')
  }
  let enabledKeys = 0
  for (const key of keys.values()) if (key.enabled) enabledKeys += 1
  const ledger: UsageWorkspaceLedger = {
    requests: total.requests,
    errors: total.errors,
    errorRate: ratio(total.errors, total.requests),
    tokens: total.tokens,
    costUsd: costOf(total),
    costEstimated: total.estimated,
    hasPartialCost: unpriced.size > 0,
    unpricedRequests: total.unpricedRequests,
    unpricedModels: [...unpriced].sort(),
    cacheHitRate: cache.totals.hitRate,
    cacheIdleModels: cache.excluded.models,
    activeKeys: active.size,
    enabledKeys,
    totalKeys: keys.size,
    avgLatencyMs: total.requests > 0 ? total.latencySumMs / total.requests : null,
  }
  return { ledger, total }
}

type KeyRow = { id: string; name: string; enabled: number }

function keyIndex(rows: KeyRow[]) {
  return new Map(rows.map((row) => [String(row.id), { name: String(row.name), enabled: Boolean(num(row.enabled)) }]))
}

export const usageErrorCategory = (value: unknown) => {
  const text = String(value || '').trim()
  return text && text !== 'other' ? text : 'other'
}

export type UsageWorkspaceFailure = { category: string; owner: string; count: number; codes: Array<{ code: number; count: number }> }

function failuresOf(rows: Array<Pick<WorkspaceRow, 's' | 'sc' | 'ec' | 'n'>>): UsageWorkspaceFailure[] {
  const byCategory = new Map<string, { count: number; codes: Map<number, number> }>()
  for (const row of rows) {
    if (num(row.s)) continue
    const category = usageErrorCategory(row.ec)
    const entry = byCategory.get(category) ?? { count: 0, codes: new Map<number, number>() }
    entry.count += num(row.n)
    entry.codes.set(num(row.sc), (entry.codes.get(num(row.sc)) ?? 0) + num(row.n))
    byCategory.set(category, entry)
  }
  return [...byCategory].map(([category, entry]) => ({
    category,
    // 「谁的问题」与性能页签同一张表（perfReports.ERROR_CATEGORIES）
    owner: errorCategoryWords(category).owner,
    count: entry.count,
    codes: [...entry.codes].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count || a.code - b.code),
  })).sort((a, b) => b.count - a.count || compareText(a.category, b.category))
}

export type UsageWorkspaceRank = {
  id: string
  label: string
  requests: number
  tokens: number
  errors: number
  costUsd: number | null
  /** 有未定价的请求：costUsd 只是已定价部分 */
  partialCost: boolean
}

type RankKey = Pick<WorkspaceRow, 'k' | 'm' | 'p' | 'c'>

function rankBy(rows: WorkspaceRow[], parts: PricedPart[], idOf: (row: RankKey) => string, labelOf: (id: string) => string): UsageWorkspaceRank[] {
  const map = new Map<string, Tally>()
  for (const row of rows) {
    const id = idOf(row)
    const tally = map.get(id) ?? emptyTally()
    addRow(tally, row, ledgerPart(row))
    map.set(id, tally)
  }
  // 未入账片只带花费；一个片的 Key / 模型 / 渠道 / 客户端都在 rollup 行里出现过，不会凭空多出一行
  for (const part of parts) {
    const tally = map.get(idOf(part))
    if (tally) addCost(tally, part.cost)
  }
  return [...map].map(([id, tally]) => ({
    id,
    label: labelOf(id),
    requests: tally.requests,
    tokens: tally.tokens,
    errors: tally.errors,
    costUsd: costOf(tally),
    partialCost: tally.unpricedRequests > 0,
  })).sort((a, b) => b.tokens - a.tokens || b.requests - a.requests || compareText(a.id, b.id))
}

export const DELETED_KEY_ID = '__deleted__'
export const NO_KEY_ID = '__none__'

type ScopeChannels = { requests: number; channels: Array<{ id: string; label: string; requests: number }> }

export type UsageWorkspaceScope = {
  /** all = 全部渠道（默认，含已移除渠道的历史）；current = 只看当前渠道（显式筛选）。概览、Key、模型、缓存、性能同一口径 */
  kind: 'all' | 'current'
  /** 当前渠道（CPA 实时分组）个数 */
  channels: number
  /** 同一窗口与筛选下走已移除渠道（不在当前分组）的请求：kind=all 时已计入，kind=current 时未计入 */
  removed: ScopeChannels
  /** kind=current 时未计入的请求（= removed）；kind=all 时为 0。旧客户端读这个字段 */
  excluded: ScopeChannels
}

/** 渠道是否已不在当前分组（排行里标「已移除」）。 */
export const isRemovedChannel = (id: string, groups: ConsoleGroup[]) => !groups.some((group) => group.id === id)

function scopeOf(groups: ConsoleGroup[], removedRows: Array<{ p: string; n: number }>, currentOnly: boolean): UsageWorkspaceScope {
  const byChannel = new Map<string, number>()
  for (const row of removedRows) {
    const id = usageChannelId(row.p, groups)
    byChannel.set(id, (byChannel.get(id) ?? 0) + num(row.n))
  }
  const channels = [...byChannel].map(([id, requests]) => ({ id, label: channelLabel(id), requests }))
    .sort((a, b) => b.requests - a.requests || compareText(a.id, b.id))
  const removed = { requests: channels.reduce((sum, item) => sum + item.requests, 0), channels }
  return {
    kind: currentOnly ? 'current' : 'all',
    channels: groups.length,
    removed,
    excluded: currentOnly ? removed : { requests: 0, channels: [] },
  }
}

/** 走已移除渠道（不在当前分组白名单）的历史（只受 Key / 模型 / 客户端约束；选了具体渠道时不适用）。 */
function removedOperation(groups: ConsoleGroup[], filter: UsageWorkspaceFilter, fromMs: number, endMs: number): ReadOperation | null {
  if (filter.provider) return null
  const active = activeProviderPredicate(groups, 'provider')
  const others = usageWorkspacePredicate(groups, filter, 'rollup', '', { provider: true }, false)
  return {
    method: 'all',
    sql: `SELECT lower(trim(provider)) p, SUM(request_count) n FROM usage_hourly_rollup
      WHERE hour_ms >= ? AND hour_ms < ? AND NOT (${active.sql}) AND ${others.sql}
      GROUP BY lower(trim(provider))`,
    params: [fromMs, endMs, ...active.params, ...others.params],
  }
}

/** 共享筛选 → 缓存 / 性能页签用的 scope（provider 小写，与 parseUsageScope 一致）。 */
const cacheScopeOf = (filter: UsageWorkspaceFilter): UsageScope => ({
  days: filter.days,
  keyId: filter.keyId,
  model: filter.model,
  client: filter.client,
  provider: filter.provider.toLowerCase(),
  currentOnly: Boolean(filter.currentOnly),
})

/**
 * 缓存页签那几个数（同一组读、同一个 buildCacheSummary），`range` 是窗口；`anchorMs` 决定能力证据的 30 天往前从哪算。
 * 返回读操作与组装函数，调用方把读操作并进自己的一批里。
 */
function cacheFiguresOf(groups: ConsoleGroup[], filter: UsageWorkspaceFilter, fromMs: number, endMs: number, timeZone: string, now: number) {
  const scope = cacheScopeOf(filter)
  const anchorMs = Math.min(now, endMs - 1)
  return {
    operations: [cacheRowsOperation(groups, scope, fromMs, endMs), cacheEvidenceOperation(groups, scope, anchorMs)] as ReadOperation[],
    build: (rows: unknown, evidence: unknown): CacheFigures => buildCacheSummary({
      rows: rows as CacheRollupRow[],
      evidence: (evidence as Array<{ m: string }>).map((row) => String(row.m)),
      overCeiling: [],
      scope,
      plan: { ...bucketPlan(filter.days, anchorMs, timeZone), fromMs },
      timeZone,
      now: anchorMs,
    }),
  }
}

/**
 * 未入账请求的片（usageCost.ts）：第一批读 rollup 里没入账的行；若有「部分入账」或「有长上下文分档」的小时，再读那些
 * 小时的 NULL 成本事件（按提示长度档位聚合）。平时一次也不多读。
 */
async function loadPricedParts(
  reader: Reader,
  groups: ConsoleGroup[],
  filter: UsageWorkspaceFilter,
  rollupUncosted: UncostedRow[],
): Promise<PricedPart[]> {
  const hours = hoursNeedingEvents(rollupUncosted)
  const operation = uncostedEventsOperation(usageWorkspacePredicate(groups, filter, 'events', 'u'), hours)
  const [events] = operation ? await reader.run([operation]) : [[]]
  return pricedParts(resolveUncosted(rollupUncosted, events as UncostedRow[]))
}

/**
 * 日序列：配置时区的日历日 × 模型 × 渠道（失败数单独求和），总览的账本历史与热力图日序列共用这一条读。
 * 起点是某天 00:00（整点），rollup 小时桶按时区偏移落进各自的日子。
 */
function dailyRowsOperation(where: { sql: string; params: string[] }, offset: number, fromMs: number, endMs: number): ReadOperation {
  return {
    method: 'all',
    sql: `SELECT strftime('%Y-%m-%d', hour_ms / 1000 + ?, 'unixepoch') d, ${canonicalModelSql()} m, lower(trim(provider)) p,
        SUM(CASE WHEN success=0 THEN request_count ELSE 0 END) e, ${WORKSPACE_SUMS}
      FROM usage_hourly_rollup WHERE hour_ms >= ? AND hour_ms < ? AND ${where.sql}
      GROUP BY d, ${canonicalModelSql()}, lower(trim(provider))`,
    params: [Math.round(offset / 1000), fromMs, endMs, ...where.params],
  }
}

/** 日行 + 同一段的未入账片 → 从 `fromMs` 那天起连续 `count` 天（没有调用的日子也在，花费为 null）。 */
function foldDaily(rows: Array<WorkspaceRow & { d: string; e: number }>, parts: PricedPart[], fromMs: number, count: number, offset: number): Array<UsageWorkspaceDay & { tally: Tally }> {
  const daily = new Map<string, { tally: Tally; models: Map<string, number> }>()
  const dayOf = (hourMs: number) => new Date(hourMs + offset).toISOString().slice(0, 10)
  for (const row of rows) {
    const entry = daily.get(row.d) ?? { tally: emptyTally(), models: new Map<string, number>() }
    // 日行按 模型 × 渠道 聚合（不带 success），失败数单独求和：s=1 只是让 addRow 不重复计失败。
    addRow(entry.tally, { ...row, s: 1 }, ledgerPart(row))
    entry.tally.errors += num(row.e)
    entry.models.set(row.m, (entry.models.get(row.m) ?? 0) + num(row.t))
    daily.set(row.d, entry)
  }
  for (const part of parts) {
    const entry = daily.get(dayOf(num(part.h)))
    if (entry) addCost(entry.tally, part.cost)
  }
  const days: Array<UsageWorkspaceDay & { tally: Tally }> = []
  for (let index = 0; index < count; index += 1) {
    const day = new Date(fromMs + offset + index * WS_DAY_MS).toISOString().slice(0, 10)
    const entry = daily.get(day)
    const tally = entry?.tally ?? emptyTally()
    days.push({
      day,
      requests: tally.requests,
      errors: tally.errors,
      tokens: tally.tokens,
      costUsd: entry ? costOf(tally) : null,
      freshInput: tally.freshInput,
      output: tally.output,
      cacheRead: tally.cacheRead,
      cacheWrite: tally.cacheWrite,
      topModels: entry
        ? [...entry.models].map(([model, tokens]) => ({ model, tokens })).sort((a, b) => b.tokens - a.tokens || compareText(a.model, b.model)).slice(0, 3)
        : [],
      tally,
    })
  }
  return days
}

const publicDay = ({ tally: _tally, ...day }: UsageWorkspaceDay & { tally: Tally }): UsageWorkspaceDay => day

export type UsageWorkspaceDay = {
  day: string
  requests: number
  errors: number
  tokens: number
  costUsd: number | null
  freshInput: number
  output: number
  cacheRead: number
  cacheWrite: number
  topModels: Array<{ model: string; tokens: number }>
}

export type UsageWindowView = { days: number; from: string; to: string; timeZone: string; span: { from: string; to: string } | null }

export type UsageWorkspaceOverview = {
  view: 'workspace'
  window: UsageWindowView
  filters: UsageWorkspaceFilter
  scope: UsageWorkspaceScope
  ledger: UsageWorkspaceLedger
  /** 前一个等长窗口；保留期外（没有数据可比）为 null */
  previous: Pick<UsageWorkspaceLedger, 'requests' | 'errors' | 'errorRate' | 'tokens' | 'costUsd' | 'cacheHitRate' | 'activeKeys'> | null
  mix: { freshInput: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number; cacheSavingsUsd: number | null }
  /** 热力图：保留期内每一天（配置时区），最早在前 */
  daily: UsageWorkspaceDay[]
  models: UsageWorkspaceRank[]
  keys: Array<UsageWorkspaceRank & { enabled: boolean | null }>
  /** `removed` = 渠道已不在当前分组（只在全部渠道口径下出现），页面标「已移除」 */
  channels: Array<UsageWorkspaceRank & { removed: boolean }>
  clients: UsageWorkspaceRank[]
  failures: UsageWorkspaceFailure[]
  generatedAt: string
}

export async function loadUsageWorkspaceOverview(
  reader: Reader,
  groups: ConsoleGroup[],
  filter: UsageWorkspaceFilter,
  options: { timeZone: string; retentionDays: number; now?: number },
): Promise<UsageWorkspaceOverview> {
  const now = options.now ?? Date.now()
  const window = usageFilterWindow(filter, now, options.timeZone)
  const offset = zoneOffsetMs(options.timeZone, now)
  const heatDays = Math.max(1, Math.min(371, Math.floor(options.retentionDays) || 90))
  // 日序列止于窗口最后一天（滚动窗口 = 今天；自定义跨度 = to 那天），账本的 7 日历史因此跟着窗口走
  const lastDayStart = Math.floor((window.endMs - 1 + offset) / WS_DAY_MS) * WS_DAY_MS - offset
  const heatFromMs = lastDayStart - (heatDays - 1) * WS_DAY_MS
  const where = usageWorkspacePredicate(groups, filter, 'rollup')
  const removed = removedOperation(groups, filter, window.fromMs, window.endMs)
  const currentCache = cacheFiguresOf(groups, filter, window.fromMs, window.endMs, options.timeZone, now)
  const previousCache = cacheFiguresOf(groups, filter, window.prevFromMs, window.fromMs, options.timeZone, now)
  const operations: ReadOperation[] = [
    { method: 'all', sql: 'SELECT key_hash id, name, enabled FROM api_keys', params: [] },
    { method: 'all', sql: workspaceRowsSql(`hour_ms >= ? AND hour_ms < ? AND ${where.sql}`), params: [window.fromMs, window.endMs, ...where.params] },
    { method: 'all', sql: workspaceRowsSql(`hour_ms >= ? AND hour_ms < ? AND ${where.sql}`), params: [window.prevFromMs, window.fromMs, ...where.params] },
    dailyRowsOperation(where, offset, heatFromMs, window.endMs),
    { method: 'get', sql: 'SELECT MIN(hour_ms) first FROM usage_hourly_rollup', params: [] },
    // 未入账请求：覆盖前一窗口、当前窗口与热力图的全部小时，同一批片分给三处
    uncostedRollupOperation(where, Math.min(window.prevFromMs, heatFromMs), window.endMs),
    ...currentCache.operations,
    ...previousCache.operations,
  ]
  if (removed) operations.push(removed)
  const [keyValue, rowsValue, previousValue, dailyValue, firstValue, uncostedValue, cacheRows, cacheEvidence, prevCacheRows, prevCacheEvidence, removedValue] =
    await runIndependent(reader, operations)
  const parts = await loadPricedParts(reader, groups, filter, uncostedValue as UncostedRow[])
  const inRange = (fromMs: number, toMs: number) => parts.filter((part) => num(part.h) >= fromMs && num(part.h) < toMs)
  const keys = keyIndex(keyValue as KeyRow[])
  const rows = rowsValue as WorkspaceRow[]
  const currentParts = inRange(window.fromMs, window.endMs)
  const cache = currentCache.build(cacheRows, cacheEvidence)
  const { ledger, total } = ledgerOf(rows, currentParts, keys, cache)
  const previousRows = previousValue as WorkspaceRow[]
  const firstHour = num((firstValue as { first?: number } | undefined)?.first)
  // 前一窗口落在已有数据之前（保留期外、或刚开始记录）就没有可比的基线，不能拿 0 当基线。
  const previousCovered = firstHour > 0 && firstHour <= window.prevFromMs
  const previousLedger = previousCovered
    ? ledgerOf(previousRows, inRange(window.prevFromMs, window.fromMs), keys, previousCache.build(prevCacheRows, prevCacheEvidence)).ledger
    : null

  const days = foldDaily(dailyValue as Array<WorkspaceRow & { d: string; e: number }>, inRange(heatFromMs, window.endMs), heatFromMs, heatDays, offset).map(publicDay)

  const keyLabel = (id: string) => (id === DELETED_KEY_ID ? '已删除的 Key' : id === NO_KEY_ID ? '无 Key' : keys.get(id)?.name ?? id)
  const keyIdOf = (row: RankKey) => (!row.k ? NO_KEY_ID : keys.has(row.k) ? row.k : DELETED_KEY_ID)
  const keyRanks = rankBy(rows, currentParts, keyIdOf, keyLabel)
    .map((rank) => ({ ...rank, enabled: keys.has(rank.id) ? keys.get(rank.id)!.enabled : null }))
    .sort((a, b) => (b.costUsd ?? -1) - (a.costUsd ?? -1) || b.tokens - a.tokens || compareText(a.id, b.id))

  return {
    view: 'workspace',
    window: windowView(filter, window.fromMs, window.toMs, options.timeZone),
    filters: filter,
    scope: scopeOf(groups, (removedValue as Array<{ p: string; n: number }> | undefined) ?? [], Boolean(filter.currentOnly)),
    ledger,
    previous: previousLedger && {
      requests: previousLedger.requests,
      errors: previousLedger.errors,
      errorRate: previousLedger.errorRate,
      tokens: previousLedger.tokens,
      costUsd: previousLedger.costUsd,
      cacheHitRate: previousLedger.cacheHitRate,
      activeKeys: previousLedger.activeKeys,
    },
    mix: {
      freshInput: total.freshInput,
      output: total.output,
      cacheRead: total.cacheRead,
      cacheWrite: total.cacheWrite,
      reasoning: total.reasoning,
      // = 缓存页签 totals.savings.netUsd（同一批行、按小时价、长上下文分档、只算支持缓存的模型）
      cacheSavingsUsd: cache.totals.savings.netUsd,
    },
    daily: days,
    models: rankBy(rows, currentParts, (row) => row.m || 'unknown', (id) => id),
    keys: keyRanks,
    channels: rankBy(rows, currentParts, (row) => usageChannelId(row.p, groups), (id) => usageChannelLabel(id, groups))
      .map((rank) => ({ ...rank, removed: isRemovedChannel(rank.id, groups) }))
      .sort((a, b) => b.requests - a.requests || compareText(a.id, b.id)),
    clients: rankBy(rows, currentParts, (row) => row.c || 'legacy-unknown', (id) => clientLabel(id))
      .sort((a, b) => b.requests - a.requests || compareText(a.id, b.id)),
    failures: failuresOf(rows),
    generatedAt: new Date(now).toISOString(),
  }
}

export type UsageWorkspaceRequestQuery = {
  /** '' 全部 · ok 成功 · error 失败 */
  status: '' | 'ok' | 'error'
  /** 错误类别（隐含 status=error）；'' 全部 */
  category: string
  /** 只看某一天（配置时区的 YYYY-MM-DD，来自热力图「看当日请求」）；'' = 用 days 窗口 */
  day?: string
  page: number
  pageSize: number
}

type RequestTallyRow = { k: string; c: string; s: number; sc: number; ec: string; n: number; t: number; l: number }

export type UsageWorkspaceRequestRow = {
  requestId: string
  timestamp: string
  timestampMs: number
  keyId: string | null
  keyName: string | null
  provider: string
  channel: string
  modelGroup: string
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
  cacheWriteTokens: number
  totalTokens: number
  freshInputTokens: number
  cacheReadTokens: number
  promptTokens: number
  hitRate: number | null
  costUsd: number | null
  /** 账本里没有，按当前单价估算 */
  costEstimated: boolean
  errorDetail: string
  errorCategory: string
  upstreamRequestId: string
  authIndex: string
  reasoningEffort: string
  serviceTier: string
  userAgent: string
  clientType: string
  clientIp: string
}

/**
 * 请求页签：账本（rollup）与流水（事件表）用同一窗口、同一谓词，所以错误条的计数、分页总数和流水逐条对得上。
 * 返回 AnalyticsData 的超集（summary / keyUsage / clients / statusCodes / errorCategories / requests）。
 */
export async function loadUsageWorkspaceRequests(
  rollupReader: Reader,
  eventReader: Reader,
  groups: ConsoleGroup[],
  filter: UsageWorkspaceFilter,
  query: UsageWorkspaceRequestQuery,
  options: { timeZone: string; now?: number },
) {
  const now = options.now ?? Date.now()
  const window = usageFilterWindow(filter, now, options.timeZone)
  // 指定某天时窗口换成那一天（时区日界都是整点，rollup 与事件表仍逐条可比）
  const dayStart = query.day ? Date.parse(`${query.day}T00:00:00.000Z`) - zoneOffsetMs(options.timeZone, now) : null
  const fromMs = dayStart ?? window.fromMs
  // 上界（不含）：那一天的结束，或当前小时结束（比当前小时更晚的行不计，账本与流水同一规则）
  const toMs = dayStart === null ? window.endMs : dayStart + WS_DAY_MS
  const rollupWhere = usageWorkspacePredicate(groups, filter, 'rollup')
  const eventWhere = usageWorkspacePredicate(groups, filter, 'events', 'u')
  const status = query.category ? 'error' : query.status
  const statusSql = (alias: string) => {
    const p = alias ? `${alias}.` : ''
    const parts: string[] = []
    if (status === 'ok') parts.push(`${p}success = 1`)
    if (status === 'error') parts.push(`${p}success = 0`)
    if (query.category === 'other') parts.push(`${p}error_category IN ('', 'other')`)
    else if (query.category) parts.push(`${p}error_category = ?`)
    return { sql: parts.length ? ` AND ${parts.join(' AND ')}` : '', params: query.category && query.category !== 'other' ? [query.category] : [] }
  }
  const eventStatus = statusSql('u')
  const offset = (Math.max(1, query.page) - 1) * query.pageSize
  const [[keyValue, tallyValue], [pageValue]] = await Promise.all([
    runIndependent(rollupReader, [
      { method: 'all', sql: 'SELECT key_hash id, name, enabled FROM api_keys', params: [] },
      {
        method: 'all',
        sql: `SELECT key_hash k, client_type c, success s, status_code sc, error_category ec,
            SUM(request_count) n, COALESCE(SUM(total_tokens),0) t, COALESCE(SUM(latency_sum_ms),0) l
          FROM usage_hourly_rollup WHERE hour_ms >= ? AND hour_ms < ? AND ${rollupWhere.sql}
          GROUP BY key_hash, client_type, success, status_code, error_category`,
        params: [fromMs, toMs, ...rollupWhere.params],
      },
    ]),
    eventReader.run([{
      method: 'all',
      sql: `SELECT u.request_id requestId, u.timestamp, u.timestamp_ms timestampMs, u.key_hash keyId, a.name keyName,
          u.provider, u.model_group modelGroup, ${canonicalModelSql('u')} model, u.endpoint, u.success, u.status_code statusCode,
          u.latency_ms latencyMs, u.ttft_ms ttftMs, u.input_tokens inputTokens, u.output_tokens outputTokens,
          u.reasoning_tokens reasoningTokens, u.cached_tokens cachedTokens, u.cache_write_tokens cacheWriteTokens,
          u.total_tokens totalTokens, u.cost_usd costUsd, u.error_detail errorDetail, u.error_category errorCategory,
          u.upstream_request_id upstreamRequestId, u.auth_index authIndex, u.reasoning_effort reasoningEffort,
          u.service_tier serviceTier, u.user_agent userAgent, ${clientTypeSql('u')} clientType, u.client_ip clientIp
        FROM usage_events u LEFT JOIN api_keys a ON a.key_hash = u.key_hash
        WHERE u.timestamp_ms >= ? AND u.timestamp_ms < ? AND ${eventWhere.sql}${eventStatus.sql}
        ORDER BY u.timestamp_ms DESC, u.id DESC LIMIT ? OFFSET ?`,
      params: [fromMs, toMs, ...eventWhere.params, ...eventStatus.params, query.pageSize, offset],
    }]),
  ])
  const keys = keyIndex(keyValue as KeyRow[])
  const tallies = tallyValue as RequestTallyRow[]

  let requests = 0
  let errors = 0
  let tokens = 0
  let latency = 0
  let matching = 0
  const byKey = new Map<string, { requests: number; tokens: number; errors: number }>()
  const byClient = new Map<string, { requests: number; tokens: number; errors: number; latency: number }>()
  const byCode = new Map<number, number>()
  for (const row of tallies) {
    const n = num(row.n)
    const failed = !num(row.s)
    requests += n
    tokens += num(row.t)
    latency += num(row.l)
    if (failed) {
      errors += n
      byCode.set(num(row.sc), (byCode.get(num(row.sc)) ?? 0) + n)
    }
    const category = usageErrorCategory(row.ec)
    const statusMatches = status === '' || (status === 'ok' ? !failed : failed)
    if (statusMatches && (!query.category || (failed && category === query.category))) matching += n
    const keyId = row.k || NO_KEY_ID
    const key = byKey.get(keyId) ?? { requests: 0, tokens: 0, errors: 0 }
    key.requests += n
    key.tokens += num(row.t)
    if (failed) key.errors += n
    byKey.set(keyId, key)
    const clientId = row.c || 'legacy-unknown'
    const client = byClient.get(clientId) ?? { requests: 0, tokens: 0, errors: 0, latency: 0 }
    client.requests += n
    client.tokens += num(row.t)
    client.latency += num(row.l)
    if (failed) client.errors += n
    byClient.set(clientId, client)
  }

  const items: UsageWorkspaceRequestRow[] = (pageValue as Array<Record<string, unknown>>).map((row) => {
    const model = String(row.model || 'unknown')
    const provider = String(row.provider || '')
    const tokensOf = normalizeTokens({
      model,
      provider,
      modelGroup: String(row.modelGroup || ''),
      inputTokens: num(row.inputTokens),
      outputTokens: num(row.outputTokens),
      cachedTokens: num(row.cachedTokens),
      cacheWriteTokens: num(row.cacheWriteTokens),
    })
    const ledger = typeof row.costUsd === 'number' && Number.isFinite(row.costUsd) ? row.costUsd : null
    const estimate = ledger === null
      ? estimateCost(model, tokensOf.freshInputTokens, tokensOf.outputTokens, tokensOf.cacheReadTokens, tokensOf.cacheWriteTokens, { at: String(row.timestamp || '') || undefined, promptTokens: tokensOf.promptTokens })
      : null
    return {
      requestId: String(row.requestId || ''),
      timestamp: String(row.timestamp || ''),
      timestampMs: num(row.timestampMs),
      keyId: row.keyId ? String(row.keyId) : null,
      keyName: row.keyName ? String(row.keyName) : null,
      provider,
      channel: usageChannelId(provider, groups),
      modelGroup: String(row.modelGroup || ''),
      model,
      endpoint: String(row.endpoint || ''),
      success: num(row.success),
      statusCode: num(row.statusCode),
      latencyMs: num(row.latencyMs),
      ttftMs: num(row.ttftMs),
      inputTokens: num(row.inputTokens),
      outputTokens: num(row.outputTokens),
      reasoningTokens: num(row.reasoningTokens),
      cachedTokens: num(row.cachedTokens),
      cacheWriteTokens: num(row.cacheWriteTokens),
      totalTokens: num(row.totalTokens),
      freshInputTokens: tokensOf.freshInputTokens,
      cacheReadTokens: tokensOf.cacheReadTokens,
      promptTokens: tokensOf.promptTokens,
      hitRate: hitRate(tokensOf),
      costUsd: ledger ?? estimate,
      costEstimated: ledger === null && estimate !== null,
      errorDetail: String(row.errorDetail || ''),
      errorCategory: num(row.success) ? '' : usageErrorCategory(row.errorCategory),
      upstreamRequestId: String(row.upstreamRequestId || ''),
      authIndex: String(row.authIndex || ''),
      reasoningEffort: String(row.reasoningEffort || ''),
      serviceTier: String(row.serviceTier || ''),
      userAgent: String(row.userAgent || ''),
      clientType: String(row.clientType || 'legacy-unknown'),
      clientIp: String(row.clientIp || ''),
    }
  })

  const keyLabel = (id: string) => (id === NO_KEY_ID ? '无 Key' : keys.get(id)?.name ?? '已删除的 Key')
  return {
    view: 'workspace' as const,
    days: filter.days,
    window: windowView(filter, fromMs, dayStart === null ? window.toMs : toMs, options.timeZone),
    filters: filter,
    query: { status, category: query.category, day: query.day ?? '', page: Math.max(1, query.page), pageSize: query.pageSize },
    summary: {
      requests,
      tokens,
      avgLatency: requests > 0 ? latency / requests : 0,
      errorRate: requests > 0 ? errors / requests : 0,
      errors,
    },
    trend: [],
    groups: [],
    models: [],
    latency: [],
    keyUsage: [...byKey].map(([id, value]) => ({
      id,
      name: keyLabel(id),
      requests: value.requests,
      tokens: value.tokens,
      errorRate: value.requests > 0 ? value.errors / value.requests : 0,
    })).sort((a, b) => b.requests - a.requests || compareText(a.id, b.id)),
    clients: [...byClient].map(([type, value]) => ({
      type,
      label: clientLabel(type),
      requests: value.requests,
      tokens: value.tokens,
      avgLatency: value.requests > 0 ? value.latency / value.requests : 0,
      errorRate: value.requests > 0 ? value.errors / value.requests : 0,
    })).sort((a, b) => b.requests - a.requests || compareText(a.type, b.type)),
    statusCodes: [...byCode].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count || a.code - b.code),
    errorCategories: failuresOf(tallies),
    /** 当前状态 / 类别筛选下的总条数（与流水同一窗口、同一谓词） */
    total: matching,
    requests: items,
    generatedAt: new Date(now).toISOString(),
  }
}

export type UsageFacetOption = { value: string; label: string; count: number; current?: boolean; removed?: boolean }

/**
 * 共享筛选条的选项与计数：每个筛选器的计数只受其它筛选约束（选了模型后，Key 的计数是「该模型下」的）。
 * 渠道列出全部当前渠道（没有调用的计 0），全部渠道口径下再列窗口内有调用的已移除渠道（`removed: true`）；
 * Key 列出全部 Key；模型与客户端只列窗口内出现过的。
 */
export async function loadUsageWorkspaceFacets(
  reader: Reader,
  groups: ConsoleGroup[],
  filter: UsageWorkspaceFilter,
  options: { timeZone: string; now?: number },
) {
  const now = options.now ?? Date.now()
  const window = usageFilterWindow(filter, now, options.timeZone)
  const currentOnly = Boolean(filter.currentOnly)
  const scoped = scopedProviderPredicate(groups, 'provider', currentOnly)
  const removed = removedOperation(groups, filter, window.fromMs, window.endMs)
  const where = usageWorkspacePredicate(groups, filter, 'rollup')
  const cacheFigures = cacheFiguresOf(groups, filter, window.fromMs, window.endMs, options.timeZone, now)
  const operations: ReadOperation[] = [
    { method: 'all', sql: 'SELECT key_hash id, name, enabled FROM api_keys ORDER BY enabled DESC, name', params: [] },
    {
      method: 'all',
      sql: `SELECT key_hash k, ${canonicalModelSql()} m, lower(trim(provider)) p, client_type c, SUM(request_count) n
        FROM usage_hourly_rollup WHERE hour_ms >= ? AND hour_ms < ? AND ${scoped.sql}
        GROUP BY key_hash, ${canonicalModelSql()}, lower(trim(provider)), client_type`,
      params: [window.fromMs, window.endMs, ...scoped.params],
    },
    // 页签上的「未定价」与总览账本同一批未入账片（同一谓词、按各自的成功 / 失败分组，不混成一组）
    uncostedRollupOperation(where, window.fromMs, window.endMs),
    ...cacheFigures.operations,
  ]
  if (removed) operations.push(removed)
  const [keyValue, rowsValue, uncostedValue, cacheRows, cacheEvidence, removedValue] = await runIndependent(reader, operations)
  const keyRows = keyValue as KeyRow[]
  const rows = (rowsValue as Array<Pick<WorkspaceRow, 'k' | 'm' | 'p' | 'c' | 'n'>>).map((row) => ({ ...row, channel: usageChannelId(row.p, groups) }))
  const providerFilter = filter.provider ? usageChannelId(filter.provider, groups) : ''
  const matches = (row: (typeof rows)[number], skip: FilterPart | null) =>
    (skip === 'keyId' || !filter.keyId || row.k === filter.keyId)
    && (skip === 'model' || !filter.model || row.m === filter.model)
    && (skip === 'provider' || !providerFilter || row.channel === providerFilter)
    && (skip === 'client' || !filter.client || row.c === filter.client)
  const count = (skip: FilterPart, idOf: (row: (typeof rows)[number]) => string) => {
    const map = new Map<string, number>()
    for (const row of rows) if (matches(row, skip)) map.set(idOf(row), (map.get(idOf(row)) ?? 0) + num(row.n))
    return map
  }
  const keyCounts = count('keyId', (row) => row.k)
  const modelCounts = count('model', (row) => row.m || 'unknown')
  const channelCounts = count('provider', (row) => row.channel)
  const clientCounts = count('client', (row) => row.c || 'legacy-unknown')
  const byCount = (a: UsageFacetOption, b: UsageFacetOption) => b.count - a.count || compareText(a.label, b.label)

  // 页签标题与筛选条右侧的数：与总览账本同一谓词（四个筛选全部生效）、同一花费片、同一缓存页签命中率
  let requests = 0
  for (const row of rows) if (matches(row, null)) requests += num(row.n)
  const parts = await loadPricedParts(reader, groups, filter, uncostedValue as UncostedRow[])
  const unpriced = new Set<string>()
  for (const part of parts) if (part.cost.unpricedRequests > 0) unpriced.add(part.m || 'unknown')
  const cache = cacheFigures.build(cacheRows, cacheEvidence)

  return {
    view: 'workspace' as const,
    window: windowView(filter, window.fromMs, window.toMs, options.timeZone),
    scope: scopeOf(groups, (removedValue as Array<{ p: string; n: number }> | undefined) ?? [], currentOnly),
    totals: { requests, cacheHitRate: cache.totals.hitRate, unpricedModels: [...unpriced].sort() },
    keys: keyRows.map((row) => ({
      value: String(row.id),
      label: String(row.name),
      count: keyCounts.get(String(row.id)) ?? 0,
      current: Boolean(num(row.enabled)),
    })).sort(byCount),
    models: [...modelCounts].map(([value, total]) => ({ value, label: value, count: total })).sort(byCount),
    channels: ([
      ...groups.map((group) => ({ value: group.id, label: group.name || channelLabel(group.id), count: channelCounts.get(group.id) ?? 0, current: true })),
      ...[...channelCounts]
        .filter(([id, total]) => total > 0 && isRemovedChannel(id, groups))
        .map(([id, total]) => ({ value: id, label: channelLabel(id), count: total, current: false, removed: true })),
    ] as UsageFacetOption[]).sort(byCount),
    clients: [...clientCounts].map(([value, total]) => ({ value, label: clientLabel(value), count: total })).sort(byCount),
    generatedAt: new Date(now).toISOString(),
  }
}

/* ── 热力图日序列（贡献图）：一年的日格，与页面的时间窗无关 ─────────────────────────────────────────── */

/** `recent` = 截至今天的 53 周（周一起）；数字 = 那个日历年（今年截至今天）。 */
export type UsageDailyYear = 'recent' | number

export type UsageWorkspaceDaily = {
  view: 'workspace'
  /** 图的范围（含首尾的日历日）；`offsetMinutes` = 配置时区相对 UTC，前端据此把某天换成 [起, 止) */
  range: { year: UsageDailyYear; from: string; to: string; timeZone: string; offsetMinutes: number }
  /** 保留期起点（更早的日子已被清理，不是「没有调用」）与同一筛选下最早有记录的日子 */
  history: { retainedFrom: string; firstDay: string | null; retentionDays: number }
  /** 保留期内有记录的日历年，新的在前 */
  years: number[]
  /** max(range.from, retainedFrom) 起到 range.to 的每一天，最早在前 */
  days: UsageWorkspaceDay[]
  totals: { requests: number; errors: number; tokens: number; costUsd: number | null; costEstimated: boolean; unpricedRequests: number }
  generatedAt: string
}

const addDays = (day: string, count: number) => new Date(Date.parse(`${day}T00:00:00.000Z`) + count * WS_DAY_MS).toISOString().slice(0, 10)
const mondayIndex = (day: string) => (new Date(`${day}T00:00:00.000Z`).getUTCDay() + 6) % 7

/** 保留期内最早的完整日历日：今天往前数 `retentionDays - 1` 天。 */
export function retainedFromDay(today: string, retentionDays: number): string {
  return addDays(today, -(Math.max(1, Math.floor(retentionDays) || 1) - 1))
}

/** 图的日历范围：`recent` 从 52 周前那一周的周一到今天（共 53 列）；某年 = 1/1 到 12/31 与今天取早者。 */
export function usageDailyRange(year: UsageDailyYear, today: string): { from: string; to: string } {
  if (year === 'recent') return { from: addDays(today, -mondayIndex(today) - 52 * 7), to: today }
  const end = `${year}-12-31`
  return { from: `${year}-01-01`, to: end < today ? end : today }
}

/**
 * 热力图的日序列：与总览同一张 rollup、同一谓词（Key / 模型 / 渠道 / 客户端 / 渠道口径）、同一套花费片，
 * 只是范围换成一年；不读上游、不另存。保留期之前的日子不返回（前端画成「无记录」的空格）。
 */
export async function loadUsageWorkspaceDaily(
  reader: Reader,
  groups: ConsoleGroup[],
  filter: UsageWorkspaceFilter,
  options: { timeZone: string; retentionDays: number; year: UsageDailyYear; now?: number },
): Promise<UsageWorkspaceDaily> {
  const now = options.now ?? Date.now()
  const offset = zoneOffsetMs(options.timeZone, now)
  const today = zoneDayKey(now, options.timeZone)
  const retainedFrom = retainedFromDay(today, options.retentionDays)
  const range = usageDailyRange(options.year, today)
  const firstDay = range.from > retainedFrom ? range.from : retainedFrom
  const where = usageWorkspacePredicate(groups, filter, 'rollup')
  const retainedFromMs = zoneDayStartMs(retainedFrom, options.timeZone, now)
  const fromMs = zoneDayStartMs(firstDay, options.timeZone, now)
  const endMs = Math.min(zoneDayStartMs(range.to, options.timeZone, now) + WS_DAY_MS, Math.floor(now / WS_HOUR_MS) * WS_HOUR_MS + WS_HOUR_MS)
  const count = firstDay > range.to ? 0 : Math.round((zoneDayStartMs(range.to, options.timeZone, now) - fromMs) / WS_DAY_MS) + 1
  const [dailyValue, uncostedValue, firstValue] = await runIndependent(reader, [
    dailyRowsOperation(where, offset, fromMs, endMs),
    uncostedRollupOperation(where, fromMs, endMs),
    { method: 'get', sql: `SELECT MIN(hour_ms) first FROM usage_hourly_rollup WHERE hour_ms >= ? AND ${where.sql}`, params: [retainedFromMs, ...where.params] },
  ])
  const parts = count > 0 ? await loadPricedParts(reader, groups, filter, uncostedValue as UncostedRow[]) : []
  const folded = count > 0 ? foldDaily(dailyValue as Array<WorkspaceRow & { d: string; e: number }>, parts, fromMs, count, offset) : []
  const total = emptyTally()
  for (const day of folded) {
    total.requests += day.tally.requests
    total.errors += day.tally.errors
    total.tokens += day.tally.tokens
    addCost(total, { usd: day.tally.priced ? day.tally.cost : null, unpricedRequests: day.tally.unpricedRequests, estimated: day.tally.estimated })
  }
  const firstHour = num((firstValue as { first?: number | null } | undefined)?.first)
  const firstRecorded = firstHour > 0 ? zoneDayKey(firstHour, options.timeZone) : null
  const years: number[] = []
  if (firstRecorded) for (let y = Number(today.slice(0, 4)); y >= Number(firstRecorded.slice(0, 4)); y -= 1) years.push(y)
  return {
    view: 'workspace',
    range: { year: options.year, from: range.from, to: range.to, timeZone: options.timeZone, offsetMinutes: Math.round(offset / 60_000) },
    history: { retainedFrom, firstDay: firstRecorded, retentionDays: Math.max(1, Math.floor(options.retentionDays) || 1) },
    years,
    days: folded.map(publicDay),
    totals: {
      requests: total.requests,
      errors: total.errors,
      tokens: total.tokens,
      costUsd: costOf(total),
      costEstimated: total.estimated,
      unpricedRequests: total.unpricedRequests,
    },
    generatedAt: new Date(now).toISOString(),
  }
}
