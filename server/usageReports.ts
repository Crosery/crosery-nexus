import { bucketSecondsFor, buildTrend, type TrendRow } from './cacheTrend.js'
import { clientLabel, clientTypeSql } from './clientAgent.js'
import { activeProviderExpression, activeProviderId, activeProviderPredicate } from './currentChannels.js'
import type { ConsoleGroup } from './groups.js'
import { canonicalModelId, canonicalModelSql, channelLabel } from './modelIdentity.js'
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
) {
  const { where, params } = usageWindow(days, keyId, 'hour_ms', now)
  const active = activeProviderPredicate(groups, 'provider')
  const currentWhere = `${where} AND ${active.sql}`
  const currentParams = [...params, ...active.params]
  const [summary, trend] = await reader.run([
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
  ])
  return { days, summary, trend }
}

/** Charts render independently from request details and exact p95 calculation. */
export async function loadChartsReport(
  reader: Reader,
  groups: ConsoleGroup[],
  days: number,
  keyId: string,
  now = Date.now(),
) {
  const { where, params } = usageWindow(days, keyId, 'timestamp_ms', now)
  const active = activeProviderPredicate(groups, 'provider')
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
) {
  const { where, params } = usageWindow(days, keyId, 'timestamp_ms', now)
  const active = activeProviderPredicate(groups, 'provider')
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
) {
  const { where, params } = usageWindow(days, keyId, 'hour_ms', now)
  const active = activeProviderPredicate(groups, 'provider')
  const currentWhere = `${where} AND ${active.sql}`
  const currentParams = [...params, ...active.params]
  const { where: requestWhere, params: requestWindowParams } = usageWindow(days, keyId, 'u.timestamp_ms', now, 'u.key_hash')
  const requestActive = activeProviderPredicate(groups, 'u.provider')
  const requestCurrentWhere = `${requestWhere} AND ${requestActive.sql}`
  const requestParams = [...requestWindowParams, ...requestActive.params]
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
        WHERE u.key_hash != '' AND u.hour_ms >= ? AND ${activeProviderPredicate(groups, 'u.provider').sql}
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
      sql: `SELECT u.request_id requestId,u.timestamp,u.provider,${canonicalModelSql('u')} model,u.endpoint,u.success,u.status_code statusCode,u.latency_ms latencyMs,u.ttft_ms ttftMs,u.input_tokens inputTokens,u.output_tokens outputTokens,u.reasoning_tokens reasoningTokens,u.cached_tokens cachedTokens,u.cache_write_tokens cacheWriteTokens,u.total_tokens totalTokens,u.error_detail errorDetail,u.error_category errorCategory,u.upstream_request_id upstreamRequestId,u.source,u.auth_index authIndex,u.reasoning_effort reasoningEffort,u.service_tier serviceTier,u.user_agent userAgent,${clientTypeSql('u')} clientType,u.client_ip clientIp,a.name keyName FROM usage_events u LEFT JOIN api_keys a ON a.key_hash=u.key_hash WHERE ${requestCurrentWhere} ORDER BY u.timestamp_ms DESC LIMIT 200`,
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

export async function loadUsageOverviewReport(
  reader: Reader,
  groups: ConsoleGroup[],
  days: number,
  keyId: string,
  now = Date.now(),
) {
  const { where, params } = usageWindow(days, keyId, 'hour_ms', now)
  const active = activeProviderPredicate(groups, 'provider')
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
          COUNT(DISTINCT day_text) activeDays
        FROM usage_hourly_rollup WHERE ${currentWhere}
        GROUP BY ${modelSql}, ${providerExpr.sql} ORDER BY totalTokens DESC
      `,
      params: [...providerExpr.params, ...currentParams, ...providerExpr.params],
    },
    {
      method: 'all',
      sql: `
        SELECT day_text day, COALESCE(SUM(total_tokens),0) totalTokens,
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
      sql: `SELECT day_text day, ${modelSql} model, COALESCE(SUM(total_tokens),0) totalTokens FROM usage_hourly_rollup WHERE ${currentWhere} GROUP BY day, ${modelSql} ORDER BY day, totalTokens DESC`,
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
) {
  const { where, params } = usageWindow(days, keyId, 'hour_ms', now)
  const active = activeProviderPredicate(groups, 'provider')
  const currentWhere = `${where} AND ${active.sql}`
  const currentParams = [...params, ...active.params]
  let rowsValue: unknown
  try {
    ;[rowsValue] = await reader.run([{
      method: 'all',
      sql: `
        SELECT day_text day, model, provider,
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
          SELECT substr(timestamp,1,10) day, model, provider,
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
) {
  const active = activeProviderPredicate(groups, 'u.provider')
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
) {
  const { where, params } = usageWindow(days, keyId, 'hour_ms', now)
  const active = activeProviderPredicate(groups, 'provider')
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
        FROM api_keys a JOIN usage_hourly_rollup u ON u.key_hash = a.key_hash AND u.hour_ms >= ? AND ${activeProviderPredicate(groups, 'u.provider').sql}
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
) {
  const active = activeProviderPredicate(groups, 'provider')
  const cutoff = cutoffEpochMs(hours, 'hours', now)
  const keyClause = keyId ? ' AND key_hash = ?' : ''
  const operations = active.params.map((activeProvider) => ({
    method: 'all' as const,
    sql: `SELECT CAST(timestamp_ms / 60000 AS INTEGER) minuteBucket,
      ${canonicalModelSql()} model, provider,
      ${clientTypeSql()} clientType,
      MIN(timestamp_ms) firstTimestampMs, COUNT(*) requests,
      COALESCE(SUM(input_tokens),0) inputTokens,
      COALESCE(SUM(MAX(input_tokens - cached_tokens, 0)),0) uncachedInputTokens,
      COALESCE(SUM(cached_tokens),0) cacheReadTokens,
      COALESCE(SUM(cache_write_tokens),0) cacheWriteTokens,
      COALESCE(SUM(output_tokens),0) outputTokens,
      CASE WHEN COUNT(cost_usd) = COUNT(*) THEN COALESCE(SUM(cost_usd),0) ELSE NULL END costUsd
      FROM usage_events INDEXED BY idx_usage_cache_rollup
      WHERE timestamp_ms >= ?
        AND CAST(timestamp_ms / 3600000 AS INTEGER) >= CAST(? / 3600000 AS INTEGER)
        AND success = 1 AND lower(trim(provider)) = ?${keyClause}
      GROUP BY CAST(timestamp_ms / 3600000 AS INTEGER),
        CAST(timestamp_ms / 60000 AS INTEGER), ${canonicalModelSql()},
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
  type CacheRollup = TrendRow & { firstTimestampMs: number }
  const bucketMs = bucketSecondsFor(hours) * 1_000
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
      costUsd: typeof row.costUsd === 'number' && Number.isFinite(row.costUsd) ? Number(row.costUsd) : null,
      firstTimestampMs: Number.POSITIVE_INFINITY,
    }
    aggregate.requests = (aggregate.requests || 0) + (Number(row.requests) || 0)
    aggregate.freshInputTokens = (aggregate.freshInputTokens || 0) + newInputTokensForAggregate(row, true)
    aggregate.cacheReadTokens = (aggregate.cacheReadTokens || 0) + (Number(row.cacheReadTokens) || 0)
    aggregate.cacheWriteTokens = (aggregate.cacheWriteTokens || 0) + (Number(row.cacheWriteTokens) || 0)
    aggregate.outputTokens += Number(row.outputTokens) || 0
    if (typeof aggregate.costUsd === 'number' && typeof row.costUsd === 'number' && Number.isFinite(row.costUsd)) aggregate.costUsd += Number(row.costUsd)
    else aggregate.costUsd = null
    aggregate.firstTimestampMs = Math.min(aggregate.firstTimestampMs, Number(row.firstTimestampMs))
    rowsByBucket.set(key, aggregate)
  }
  const rows = [...rowsByBucket.values()]
    .sort((left, right) => left.firstTimestampMs - right.firstTimestampMs)
    .map(({ firstTimestampMs: _, ...row }) => row)
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
