/**
 * API Key 用户的只读数据面：`/api/me*`（契约 C2）。
 *
 * 隔离规则（全部在本模块内成立，不依赖调用方自觉）：
 * - Key 只来自**已签名的会话**（`currentSession`），从不读 `req.query.keyId` 之类的参数；
 *   进入任何查询前再断言它是 64 位 hex，空串（= 全部 Key）在这里不可能出现。
 * - 响应体逐字段显式构造：不回传渠道/provider 名、其他 Key、客户端 IP、UA、上游请求 ID。
 * - 缓存键都带 key_hash。
 *
 * 口径（一个 Key 只有一套数）：
 * - 统计覆盖这把 Key 的**全部**流量，不套管理端的「仅当前渠道」过滤——额度账本（`quota_usage_events`）和
 *   `/me/requests` 本来就不过滤，三处必须对得上；渠道下线不改变「这把 Key 花过这些钱」。
 * - 时间窗按服务器本地日历对齐（与额度的日/周窗口同一时区）：`days=7` = 今天 + 前 6 个整天，
 *   热力图的日格之和恰好等于窗口总数。
 * - 所有时间字段都归一成 UTC ISO（`…Z`）；上游原样的偏移时间串（`-04:00`、纳秒）不透出。
 * 数据来自既有的聚合与账本（`usage_hourly_rollup`、`quota_usage_events`、模型目录），不另起存储。
 */
import express, { type Response } from 'express'
import { currentSession, SESSION_UNAVAILABLE_BODY } from './auth.js'
import { config } from './config.js'
import { isManuallyDisabled, keyByHash, keyRef, maskApiKey, type KeyRecord } from './keySession.js'
import { loadModelCatalog, visibleModelIds, type CatalogModel } from './modelCatalog.js'
import { canonicalModelId, canonicalModelSql } from './modelIdentity.js'
import { modelKind } from './modelKind.js'
import { cacheWritePrice, priceRequest } from './pricing.js'
import { boundedInteger } from './publicUsage.js'
import type { QuotaWindowState } from './quota.js'
import { quotaStatesForAsync } from './quotaEnforcer.js'
import { RequestCoordinator } from './requestCoordinator.js'
import type { ReadOperation } from './sqliteReadWorker.js'
import { NEW_INPUT_SQL } from './tokenSql.js'
import { buildDailySeries, type UsageDailyModelRow, type UsageDailyRow } from './usageOverview.js'
import { loadUsageWorkspaceDaily, type UsageWorkspaceDaily } from './usageReports.js'
import { parseUsageDailyYear } from './usageWorkspaceRoutes.js'

type Reader = {
  run(operations: readonly ReadOperation[]): Promise<unknown[]>
  runParallel?(operations: readonly ReadOperation[]): Promise<unknown[]>
}

const KEY_HASH = /^[0-9a-f]{64}$/
const USAGE_DAYS = [7, 30, 90] as const
const HOUR_MS = 3_600_000
const ANTHROPIC_PROVIDERS = new Set(['claude', 'claude-api-key', 'anthropic', 'anthropic-api-key'])

const finiteOrNull = (value: unknown): number | null => {
  const number = typeof value === 'number' ? value : value === null || value === undefined || value === '' ? Number.NaN : Number(value)
  return Number.isFinite(number) ? number : null
}

/** 所有查询的唯一入口：key_hash 不合法就抛错，绝不退化成「全部 Key」。 */
function assertKeyHash(keyHash: string): string {
  if (!KEY_HASH.test(keyHash)) throw new Error('me_key_scope_missing')
  return keyHash
}

const sessionKey = (response: Response): KeyRecord => response.locals.meKey as KeyRecord

const NAIVE_DATETIME = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)$/

/**
 * 任意时间表示 → UTC ISO（`2026-09-30T19:52:21.197Z`）；解析不了给 null，绝不把原始串透出去。
 * 没有时区的 `YYYY-MM-DD HH:MM:SS` 按 SQLite 惯例视为 UTC（不随服务器时区漂移）；纳秒截到毫秒。
 */
export function utcIso(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? new Date(value).toISOString() : null
  let text = String(value).trim()
  const naive = NAIVE_DATETIME.exec(text)
  if (naive) text = `${naive[1]}T${naive[2]}Z`
  text = text.replace(/(\.\d{3})\d+/, '$1')
  const ms = Date.parse(text)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

/** 本地日历窗口的起点：今天往前数 `days - 1` 天的本地 00:00（整小时时区下正好落在小时汇总的桶边界上）。 */
export function calendarWindowStart(days: number, now = new Date()): number {
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  start.setDate(start.getDate() - (Math.max(1, Math.floor(days)) - 1))
  return start.getTime()
}

/**
 * 本地日历某一天的 [起, 止)，UTC ISO。用本地日历算（`new Date(y, m, d)`），夏令时切换那天是 23/25 小时，
 * 与汇总表按 `localtime` 分桶同一个日历；前端拿它当「看当日请求」的上下界，不再从固定偏移 + 24h 推。
 */
export function localDayBounds(day: string): { startsAt: string | null; endsAt: string | null } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day)
  if (!match) return { startsAt: null, endsAt: null }
  const [year, month, date] = [Number(match[1]), Number(match[2]) - 1, Number(match[3])]
  return { startsAt: new Date(year, month, date).toISOString(), endsAt: new Date(year, month, date + 1).toISOString() }
}

/** 本地日期键，进缓存键：跨过 00:00 窗口就换了，旧缓存不能接着用。 */
const localDayKey = (now = new Date()) => `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`

/** 与 `usageReports.newInputTokensForAggregate` 同一口径：原生 Anthropic 的 input 不含缓存。 */
function newInputTokens(row: { provider?: string; modelGroup?: string; model?: string; inputTokens: number; uncachedInputTokens: number }) {
  const provider = String(row.provider || '').trim().toLowerCase()
  const model = canonicalModelId(String(row.model || '')).toLowerCase()
  const anthropic = ANTHROPIC_PROVIDERS.has(provider)
    || (provider === '' && (String(row.modelGroup || '').toLowerCase() === 'claude' || model.startsWith('claude')))
  return Number(anthropic ? row.inputTokens : row.uncachedInputTokens) || 0
}

type CostGroup = {
  model: string; provider: string; modelGroup: string; requests: number
  inputTokens: number; uncachedInputTokens: number; outputTokens: number; cacheTokens: number; cacheWriteTokens: number
  costSum: number; costCount: number
}

/** 账本缺价的请求逐条补价后的小计，按（时间桶, 原始 model, 原始 provider）归组，与汇总表的分组键一一对应。 */
export type MissingCost = { cost: number; priced: number; unpriced: number }
export type MissingCostRow = {
  bucket: string | number; model: string; provider: string; canonicalModel: string; timestampMs: number
  newInputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number
}

const costKey = (bucket: string | number, model: string, provider: string) => `${bucket}\u0000${model}\u0000${provider}`

/**
 * 缺价请求逐条估价：按**请求当时**的生效价、按完整提示长度选上下文档（`priceRequest`），
 * 与 `/me/requests` 每条的 `costUsd` 同一算法，所以 `totals.costUsd` = 逐条花费之和。
 */
export function priceMissingRows(rows: readonly MissingCostRow[]): Map<string, MissingCost> {
  const out = new Map<string, MissingCost>()
  for (const row of rows) {
    const key = costKey(row.bucket, row.model, row.provider)
    const entry = out.get(key) ?? { cost: 0, priced: 0, unpriced: 0 }
    const cost = priceRequest(row.canonicalModel, {
      newInputTokens: Number(row.newInputTokens) || 0,
      outputTokens: Number(row.outputTokens) || 0,
      cacheReadTokens: Number(row.cacheReadTokens) || 0,
      cacheWriteTokens: Number(row.cacheWriteTokens) || 0,
      at: Number(row.timestampMs),
    })
    if (cost === null) entry.unpriced += 1
    else { entry.cost += cost; entry.priced += 1 }
    out.set(key, entry)
  }
  return out
}

/**
 * 一组聚合的成本：已入账的请求**保留账本价**，缺价的请求逐条按当时价补（`priceMissingRows`）；
 * 补不出价的计为未定价请求。不再对整组 token 重新估价——那会丢掉账本价、历史价和长上下文分档。
 * 汇总表说缺价、明细里却对不上的请求（理论上不该有）按未定价计，不编数。
 */
export function groupCost(row: CostGroup & { bucket: string | number }, missing: ReadonlyMap<string, MissingCost>): { cost: number | null; unpriced: number } {
  const requests = Number(row.requests) || 0
  const costCount = Number(row.costCount) || 0
  const costSum = Number(row.costSum) || 0
  if (costCount >= requests) return { cost: costSum, unpriced: 0 }
  const filled = missing.get(costKey(row.bucket, row.model, row.provider)) ?? { cost: 0, priced: 0, unpriced: 0 }
  const unaccounted = Math.max(0, requests - costCount - filled.priced - filled.unpriced)
  const priced = costCount + filled.priced
  return { cost: priced > 0 ? costSum + filled.cost : null, unpriced: filled.unpriced + unaccounted }
}

/**
 * 汇总查询顺带读出的 `MAX(id)`：同一条语句、同一个快照。`usage_events.id` 是 AUTOINCREMENT、汇总由插入触发器
 * 在同一事务里维护，所以「id ≤ 它」的明细恰好就是那份汇总里的请求。
 */
const ROLLUP_SNAPSHOT_MAX_ID_SQL = '(SELECT MAX(id) FROM usage_events) snapshotMaxId'

/**
 * 汇总里有缺价的组时才去明细表捞缺价请求（常态下一条额外查询都不发）。
 * 明细是**另一条语句**读的：两次读之间新到的缺价请求不在汇总里，必须用汇总快照的 `MAX(id)` 挡掉，
 * 否则它的补价会被加进一个没数它的组（花费比请求数多出一条）。
 */
async function loadMissingCosts(reader: Reader, rows: ReadonlyArray<CostGroup & { snapshotMaxId?: number | null }>, bucketSql: string, keyHash: string, fromMs: number) {
  if (!rows.some(row => (Number(row.costCount) || 0) < (Number(row.requests) || 0))) return new Map<string, MissingCost>()
  const snapshotMaxId = Number(rows[0]?.snapshotMaxId) || 0
  const [value] = await reader.run([{
    method: 'all',
    sql: `SELECT ${bucketSql} bucket, model, provider, ${canonicalModelSql()} canonicalModel, timestamp_ms timestampMs,
        ${NEW_INPUT_SQL()} newInputTokens, output_tokens outputTokens, cached_tokens cacheReadTokens, cache_write_tokens cacheWriteTokens
      FROM usage_events WHERE key_hash = ? AND timestamp_ms >= ? AND cost_usd IS NULL AND id <= ?`,
    params: [assertKeyHash(keyHash), fromMs, snapshotMaxId],
  }])
  return priceMissingRows(value as MissingCostRow[])
}

const quotaWindowView = (window: QuotaWindowState) => ({
  limitUsd: window.limitUsd > 0 ? window.limitUsd : null,
  spentUsd: window.spentUsd,
  ratio: window.ratio,
  resetsAt: utcIso(window.resetsAt),
  exceeded: window.exceeded,
  /** 本窗口的统计起点（自然起点与手动重置取较晚者）；前端据此算「按这个速度何时用尽」。 */
  startsAt: utcIso(window.startsAt),
})

type FailureRow = { status: number; category: string; count: number }

/** 失败构成：状态码 + 分类，按次数降序；分类/状态未知给 null，不编。 */
const failureView = (rows: FailureRow[]) => rows
  .map(row => ({ status: Number(row.status) > 0 ? Number(row.status) : null, category: row.category || null, count: Number(row.count) || 0 }))
  .filter(row => row.count > 0)

const FAILURES_SQL = (where: string) => `
  SELECT status_code status, error_category category, SUM(request_count) count
  FROM usage_hourly_rollup WHERE ${where} AND success = 0
  GROUP BY status_code, error_category ORDER BY count DESC, status_code LIMIT 12`

/** Key 用户看到的日序列：只挑这几个字段（日格的模型名本来就在 /me/usage 里公开）。 */
export function meDailyView(daily: UsageWorkspaceDaily) {
  return {
    range: { year: daily.range.year, from: daily.range.from, to: daily.range.to, timeZone: daily.range.timeZone, offsetMinutes: daily.range.offsetMinutes },
    history: { retainedFrom: daily.history.retainedFrom, firstDay: daily.history.firstDay, retentionDays: daily.history.retentionDays },
    years: [...daily.years],
    days: daily.days.map(day => ({
      day: day.day,
      requests: day.requests,
      errors: day.errors,
      tokens: day.tokens,
      costUsd: day.costUsd,
      freshInput: day.freshInput,
      output: day.output,
      cacheRead: day.cacheRead,
      cacheWrite: day.cacheWrite,
      topModels: day.topModels.map(model => ({ model: model.model, tokens: model.tokens })),
    })),
    totals: { ...daily.totals },
    generatedAt: daily.generatedAt,
  }
}

/** 网关对外地址：配置优先；没配就给本机网关（本地部署），不猜公网域名。 */
export function gatewayBaseUrl(): string {
  const configured = config.publicGatewayBaseUrl
  if (configured) return /\/v\d+$/.test(configured) ? configured : `${configured}/v1`
  return config.gatewayEngine === 'magpie' ? `http://127.0.0.1:${config.magpiePort}/v1` : `${config.cpaBaseUrl}/v1`
}

/** 价格来源：与某个外部来源的报价一致才标注，否则 null（静态核定价/网关价无法逐条溯源，不猜）。 */
function priceSource(model: CatalogModel): 'models.dev' | 'openrouter' | null {
  const pricing = model.pricing
  if (!pricing) return null
  for (const source of ['models.dev', 'openrouter'] as const) {
    const quoted = model.pricingSources?.[source]
    if (quoted && quoted.input === pricing.input && quoted.output === pricing.output) return source
  }
  return null
}

/** 目录条目 → Key 用户可见的模型行：显式挑字段，`providers`（渠道名）与价格历史不出去。 */
export function meModelView(model: CatalogModel, used7d: { requests: number; tokens: number } | null) {
  return {
    id: model.id,
    name: null,
    family: null,
    contextWindow: model.context_length,
    maxOutput: model.max_completion_tokens,
    // 目录里有定义（providers 非空）才能断言「不支持推理」；只靠 ID 补进来的模型未知。
    reasoning: model.thinking ? true : model.providers.length ? false : null,
    /** 按输出分的类型（与 /api/model-index 同一分类） */
    kind: modelKind(model.id),
    pricing: model.pricing ? {
      inputPerM: model.pricing.input,
      outputPerM: model.pricing.output,
      cacheReadPerM: finiteOrNull(model.pricing.cacheRead),
      cacheWritePerM: cacheWritePrice(model.pricing),
      source: priceSource(model),
    } : null,
    used7d,
  }
}

export function createMeRouter(deps: { usageReader: Reader }) {
  const reader = deps.usageReader
  const router = express.Router()
  const overviewCache = new RequestCoordinator<Record<string, unknown>>({ ttlMs: 5_000 })
  const usageCache = new RequestCoordinator<Record<string, unknown>>({ ttlMs: 20_000, staleWhileRevalidateMs: 60_000 })
  const modelsCache = new RequestCoordinator<Record<string, unknown>>({ ttlMs: 60_000, staleWhileRevalidateMs: 5 * 60_000 })
  // 键带 key_hash + 年份 + 本地日期：Key 数 × 年份数有限，日期一换旧条目自然过期
  const dailyCache = new RequestCoordinator<Record<string, unknown>>({ ttlMs: 20_000, staleWhileRevalidateMs: 60_000, maxEntries: 200 })

  // 守卫已经把非 key 会话挡在外面；这里再按角色与 Key 存活确认一次（纵深防御），并把 Key 行交给处理器。
  router.use((request, response, next) => {
    response.setHeader('Cache-Control', 'no-store')
    const session = currentSession(request)
    if (!session) return void response.status(401).json({ error: '请先登录' })
    if (session.role !== 'key') return void response.status(403).json({ error: '仅 API Key 登录可用', code: 'not_key_session' })
    let key: KeyRecord | null
    try {
      key = keyByHash(session.keyHash)
    } catch {
      response.setHeader('Retry-After', '5')
      return void response.status(503).json(SESSION_UNAVAILABLE_BODY)
    }
    if (!key) return void response.status(401).json({ error: 'API Key 已失效 · 重新登录', code: 'key_invalid' })
    if (isManuallyDisabled(key)) return void response.status(401).json({ error: 'API Key 已被停用', code: 'key_disabled' })
    response.locals.meKey = key
    next()
  })

  /** 今天（本地 00:00 起）逐小时：与额度日窗口同一起点、同一全量口径。 */
  async function loadToday(keyHash: string, now = new Date()) {
    const fromHour = calendarWindowStart(1, now)
    const scope = 'key_hash = ? AND hour_ms >= ?'
    const params = [assertKeyHash(keyHash), fromHour]
    const [rowsValue, failureValue, latencyValue] = await reader.run([{
      method: 'all',
      sql: `
        SELECT hour_ms hourMs, model, provider, MIN(model_group) modelGroup,
          SUM(request_count) requests,
          SUM(CASE WHEN success=0 THEN request_count ELSE 0 END) errors,
          COALESCE(SUM(total_tokens),0) totalTokens,
          COALESCE(SUM(input_tokens),0) inputTokens,
          COALESCE(SUM(uncached_input_tokens),0) uncachedInputTokens,
          COALESCE(SUM(output_tokens),0) outputTokens,
          COALESCE(SUM(cached_tokens),0) cacheTokens,
          COALESCE(SUM(cache_write_tokens),0) cacheWriteTokens,
          COALESCE(SUM(cost_usd_sum),0) costSum,
          COALESCE(SUM(cost_usd_count),0) costCount,
          ${ROLLUP_SNAPSHOT_MAX_ID_SQL}
        FROM usage_hourly_rollup
        WHERE ${scope}
        GROUP BY hour_ms, model, provider
      `,
      params,
    }, { method: 'all', sql: FAILURES_SQL(scope), params }, {
      method: 'get',
      sql: `SELECT SUM(latency_sum_ms) latencySum, SUM(request_count) requests FROM usage_hourly_rollup WHERE ${scope} AND success = 1`,
      params,
    }])
    const rows = rowsValue as Array<CostGroup & { hourMs: number; errors: number; totalTokens: number }>
    const missing = await loadMissingCosts(reader, rows, '(timestamp_ms / 3600000) * 3600000', keyHash, fromHour)
    type Bucket = { requests: number; errors: number; tokens: number; cost: number; priced: boolean; unpriced: number }
    const empty = (): Bucket => ({ requests: 0, errors: 0, tokens: 0, cost: 0, priced: false, unpriced: 0 })
    const hours = new Map<number, Bucket>()
    const total = empty()
    for (const row of rows) {
      const bucket = hours.get(row.hourMs) ?? empty()
      const { cost, unpriced } = groupCost({ ...row, bucket: row.hourMs }, missing)
      for (const target of [bucket, total]) {
        target.requests += Number(row.requests) || 0
        target.errors += Number(row.errors) || 0
        target.tokens += Number(row.totalTokens) || 0
        target.unpriced += unpriced
        if (cost !== null) { target.cost += cost; target.priced = true }
      }
      hours.set(row.hourMs, bucket)
    }
    const costOf = (bucket: Bucket) => (bucket.requests === 0 ? 0 : bucket.priced ? bucket.cost : null)
    const hourly = []
    for (let hour = fromHour; hour <= now.getTime(); hour += HOUR_MS) {
      const bucket = hours.get(hour) ?? empty()
      hourly.push({ hour: new Date(hour).toISOString(), requests: bucket.requests, errors: bucket.errors, tokens: bucket.tokens, costUsd: costOf(bucket) })
    }
    const latency = latencyValue as { latencySum: number | null; requests: number | null } | undefined
    const succeeded = Number(latency?.requests) || 0
    return {
      requests: total.requests,
      errors: total.errors,
      tokens: total.tokens,
      costUsd: costOf(total),
      unpricedRequests: total.unpriced,
      hourly,
      failures: failureView(failureValue as FailureRow[]),
      avgLatencyMs: succeeded > 0 ? Math.round((Number(latency?.latencySum) || 0) / succeeded) : null,
    }
  }

  router.get('/', async (_request, response) => {
    const key = sessionKey(response)
    const body = await overviewCache.run(`me:v2:${assertKeyHash(key.key_hash)}`, async () => {
      const [quotaStates, today] = await Promise.all([quotaStatesForAsync([key]), loadToday(key.key_hash)])
      const quota = quotaStates.get(key.key_hash)!
      return {
        key: {
          name: key.name,
          masked: maskApiKey(key.key_value),
          /** 不透明的 Key 标识（与 /api/session 同一个），前端据此认出「另一个标签页换了 Key」 */
          ref: keyRef(key.key_hash),
          enabled: Boolean(key.enabled),
          blockedReason: key.quota_blocked_reason || null,
          // 授权分组就是渠道名（内部拓扑），对 Key 用户不公开；可调用的模型看 /api/me/models。
          groups: [] as string[],
          totalConcurrency: finiteOrNull(key.total_concurrency),
          createdAt: utcIso(key.created_at),
          lastUsedAt: utcIso(key.last_used_at),
        },
        quota: {
          timeZone: config.quotaTimeZone,
          daily: quotaWindowView(quota.daily),
          weekly: quotaWindowView(quota.weekly),
          total: { ...quotaWindowView(quota.total), resetsAt: null },
        },
        today,
        generatedAt: new Date().toISOString(),
      }
    })
    response.json(body)
  })

  router.get('/usage', async (request, response) => {
    const key = sessionKey(response)
    const requested = Number(request.query.days)
    const days = Math.min((USAGE_DAYS as readonly number[]).includes(requested) ? requested : 7, config.usageRetentionDays)
    const keyHash = assertKeyHash(key.key_hash)
    const now = new Date()
    const body = await usageCache.run(`me-usage:v2:${keyHash}:${days}:${localDayKey(now)}`, async () => {
      const scope = 'key_hash = ? AND hour_ms >= ?'
      const params = [keyHash, calendarWindowStart(days, now)]
      // 与管理端用量页同一张汇总表、同一组列；区别只在：不套当前渠道过滤，日期按本地日历分桶。
      const [rowsValue, failureValue] = await reader.run([{
        method: 'all',
        sql: `
          SELECT strftime('%Y-%m-%d', hour_ms / 1000, 'unixepoch', 'localtime') day, model, provider, MIN(model_group) modelGroup,
            SUM(request_count) requests,
            SUM(CASE WHEN success=0 THEN request_count ELSE 0 END) errors,
            COALESCE(SUM(total_tokens),0) totalTokens,
            COALESCE(SUM(input_tokens),0) inputTokens,
            COALESCE(SUM(uncached_input_tokens),0) uncachedInputTokens,
            COALESCE(SUM(output_tokens),0) outputTokens,
            COALESCE(SUM(cached_tokens),0) cacheTokens,
            COALESCE(SUM(cache_write_tokens),0) cacheWriteTokens,
            COALESCE(SUM(cost_usd_sum),0) costSum,
            COALESCE(SUM(cost_usd_count),0) costCount,
            MIN(first_timestamp_ms) firstTimestampMs,
            ${ROLLUP_SNAPSHOT_MAX_ID_SQL}
          FROM usage_hourly_rollup WHERE ${scope}
          GROUP BY day, model, provider
        `,
        params,
      }, { method: 'all', sql: FAILURES_SQL(scope), params }])
      const rows = rowsValue as Array<CostGroup & { day: string; errors: number; totalTokens: number; firstTimestampMs: number }>
      // 与汇总表同一分桶：先截到整点再取本地日期（半小时时区下也不会落进另一天）
      const missing = await loadMissingCosts(reader, rows, "strftime('%Y-%m-%d', ((timestamp_ms / 3600000) * 3600000) / 1000, 'unixepoch', 'localtime')", keyHash, params[1] as number)
      type DayAgg = Required<Omit<UsageDailyRow, 'day' | 'costUsd'>> & { cost: number; priced: boolean }
      type ModelAgg = { model: string; requests: number; tokens: number; cost: number; priced: boolean; errors: number }
      const byDay = new Map<string, DayAgg>()
      const byDayModel = new Map<string, UsageDailyModelRow>()
      const byModel = new Map<string, ModelAgg>()
      const totals = { requests: 0, errors: 0, tokens: 0, cost: 0, priced: false, unpricedRequests: 0 }
      let firstMs = Number.POSITIVE_INFINITY
      for (const row of rows) {
        const model = canonicalModelId(row.model)
        const requests = Number(row.requests) || 0
        const errors = Number(row.errors) || 0
        const tokens = Number(row.totalTokens) || 0
        const { cost, unpriced } = groupCost({ ...row, bucket: row.day }, missing)
        const day = byDay.get(row.day) ?? { totalTokens: 0, requests: 0, newInputTokens: 0, outputTokens: 0, cacheTokens: 0, cacheWriteTokens: 0, errors: 0, cost: 0, priced: false }
        day.totalTokens += tokens
        day.requests += requests
        day.newInputTokens += newInputTokens(row)
        day.outputTokens += Number(row.outputTokens) || 0
        day.cacheTokens += Number(row.cacheTokens) || 0
        day.cacheWriteTokens += Number(row.cacheWriteTokens) || 0
        day.errors += errors
        const entry = byModel.get(model) ?? { model, requests: 0, tokens: 0, cost: 0, priced: false, errors: 0 }
        entry.requests += requests
        entry.tokens += tokens
        entry.errors += errors
        totals.requests += requests
        totals.errors += errors
        totals.tokens += tokens
        totals.unpricedRequests += unpriced
        if (cost !== null) {
          for (const target of [day, entry, totals]) { target.cost += cost; target.priced = true }
        }
        byDay.set(row.day, day)
        byModel.set(model, entry)
        const dayModelKey = `${row.day}\u0000${model}`
        const dayModel = byDayModel.get(dayModelKey) ?? { day: row.day, model, totalTokens: 0 }
        dayModel.totalTokens += tokens
        byDayModel.set(dayModelKey, dayModel)
        if (Number.isFinite(Number(row.firstTimestampMs))) firstMs = Math.min(firstMs, Number(row.firstTimestampMs))
      }
      const dailyRows: UsageDailyRow[] = [...byDay].map(([day, agg]) => ({
        day,
        totalTokens: agg.totalTokens,
        requests: agg.requests,
        newInputTokens: agg.newInputTokens,
        outputTokens: agg.outputTokens,
        cacheTokens: agg.cacheTokens,
        cacheWriteTokens: agg.cacheWriteTokens,
        errors: agg.errors,
        costUsd: agg.priced ? agg.cost : null,
      }))
      // 日格的花费用与总数同一套逐组计价（日格之和 = 总花费），不走按 token 份额摊的估算。
      const daily = buildDailySeries(dailyRows, days, now, [...byDayModel.values()])
        .map(point => ({ ...point, estimatedCostUsd: byDay.has(point.day) ? (byDay.get(point.day)!.priced ? byDay.get(point.day)!.cost : null) : null, ...localDayBounds(point.day) }))
      return {
        days,
        daily,
        totals: { requests: totals.requests, errors: totals.errors, tokens: totals.tokens, costUsd: totals.priced ? totals.cost : null, unpricedRequests: totals.unpricedRequests },
        models: [...byModel.values()]
          .sort((left, right) => right.tokens - left.tokens || left.model.localeCompare(right.model))
          .map(entry => ({ model: entry.model, requests: entry.requests, tokens: entry.tokens, costUsd: entry.priced ? entry.cost : null, errors: entry.errors })),
        failures: failureView(failureValue as FailureRow[]),
        trackingSince: Number.isFinite(firstMs) ? new Date(firstMs).toISOString() : null,
        from: new Date(params[1] as number).toISOString(),
      }
    })
    response.json(body)
  })

  /**
   * 热力图一年的日格：与管理端 `/api/usage-daily` 同一个日序列引擎，Key 只取自会话（不读任何 query 里的 Key /
   * 渠道 / 模型参数），全部渠道口径；响应逐字段构造，没有渠道名。
   */
  router.get('/usage/daily', async (request, response) => {
    const key = sessionKey(response)
    const keyHash = assertKeyHash(key.key_hash)
    const now = Date.now()
    const clock = { timeZone: config.quotaTimeZone, now }
    const year = parseUsageDailyYear(request.query.year, config.usageRetentionDays, clock)
    const body = await dailyCache.run(`me-daily:v1:${keyHash}:${year}:${localDayKey(new Date(now))}`, async () => {
      const daily = await loadUsageWorkspaceDaily(reader, [], { days: 1, keyId: keyHash, model: '', provider: '', client: '', currentOnly: false }, {
        timeZone: config.quotaTimeZone, retentionDays: config.usageRetentionDays, year, now,
      })
      return meDailyView(daily)
    })
    response.json(body)
  })

  router.get('/requests', async (request, response) => {
    const key = sessionKey(response)
    const limit = boundedInteger(request.query.limit, 50, 1, 200)
    const errorsOnly = request.query.status === 'error'
    const beforeRaw = typeof request.query.before === 'string' ? request.query.before : ''
    const before = beforeRaw ? Date.parse(beforeRaw) : Number.MAX_SAFE_INTEGER
    if (!Number.isFinite(before)) return void response.status(400).json({ error: 'before 不是有效时间', code: 'invalid_before' })
    // `after`（含）= 下界：「看当日请求」只翻这一天，翻到当天 00:00 就停，不混进前一天。
    const afterRaw = typeof request.query.after === 'string' ? request.query.after : ''
    const after = afterRaw ? Date.parse(afterRaw) : 0
    if (!Number.isFinite(after)) return void response.status(400).json({ error: 'after 不是有效时间', code: 'invalid_after' })
    const keyHash = assertKeyHash(key.key_hash)
    const columns = `request_id requestId, timestamp, timestamp_ms timestampMs, ${canonicalModelSql()} model, endpoint,
      success, status_code statusCode, latency_ms latencyMs, ttft_ms ttftMs,
      input_tokens inputTokens, output_tokens outputTokens, cached_tokens cacheReadTokens, cache_write_tokens cacheWriteTokens,
      reasoning_tokens reasoningTokens, total_tokens totalTokens, ${NEW_INPUT_SQL()} newInputTokens, cost_usd costUsd, error_category errorCategory`
    const statusSql = errorsOnly ? 'AND success = 0' : ''
    type Row = {
      requestId: string | null; timestamp: string; timestampMs: number; model: string; endpoint: string
      success: number; statusCode: number; latencyMs: number; ttftMs: number
      inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number
      reasoningTokens: number; totalTokens: number; newInputTokens: number; costUsd: number | null; errorCategory: string
    }
    const [pageValue] = await reader.run([{
      method: 'all',
      sql: `SELECT ${columns} FROM usage_events WHERE key_hash = ? AND timestamp_ms < ? AND timestamp_ms >= ? ${statusSql}
        ORDER BY timestamp_ms DESC, id DESC LIMIT ?`,
      params: [keyHash, before, after, limit + 1],
    }])
    let rows = pageValue as Row[]
    let nextBefore: string | null = null
    if (rows.length > limit) {
      // 游标只有毫秒精度：同一毫秒的请求不能被页边界切开，否则下一页 `< before` 会漏掉它们。
      const lastMs = rows[limit - 1].timestampMs
      const page = rows.slice(0, limit)
      if (rows[limit].timestampMs !== lastMs) {
        rows = page
        nextBefore = new Date(lastMs).toISOString()
      } else {
        const kept = page.filter(row => row.timestampMs !== lastMs)
        if (kept.length) {
          rows = kept
          nextBefore = new Date(lastMs + 1).toISOString()
        } else {
          const [sameMs] = await reader.run([{
            method: 'all',
            sql: `SELECT ${columns} FROM usage_events WHERE key_hash = ? AND timestamp_ms = ? ${statusSql} ORDER BY id DESC`,
            params: [keyHash, lastMs],
          }])
          rows = sameMs as Row[]
          nextBefore = new Date(lastMs).toISOString()
        }
      }
    }
    const items = rows.map((row, index) => {
      const ledger = finiteOrNull(row.costUsd)
      const requestId = row.requestId && !row.requestId.startsWith('fallback-') ? row.requestId : null
      return {
        id: row.requestId || `t${row.timestampMs}-${index}`,
        timestamp: utcIso(row.timestampMs) ?? utcIso(row.timestamp),
        model: row.model,
        endpoint: row.endpoint,
        success: Boolean(row.success),
        status: row.statusCode > 0 ? row.statusCode : null,
        latencyMs: row.latencyMs > 0 ? row.latencyMs : null,
        ttftMs: row.ttftMs > 0 ? row.ttftMs : null,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        cacheReadTokens: row.cacheReadTokens,
        cacheWriteTokens: row.cacheWriteTokens,
        reasoningTokens: row.reasoningTokens,
        /** 网关记录的本条总 token（各上游口径下都不重复计缓存）；additive。 */
        totalTokens: row.totalTokens,
        // 缺价时按请求当时的价、按完整提示长度选档（与 /me/usage 的缺价补价同一算法）
        costUsd: ledger ?? priceRequest(row.model, {
          newInputTokens: Number(row.newInputTokens) || 0,
          outputTokens: Number(row.outputTokens) || 0,
          cacheReadTokens: Number(row.cacheReadTokens) || 0,
          cacheWriteTokens: Number(row.cacheWriteTokens) || 0,
          at: row.timestampMs,
        }),
        errorCategory: row.errorCategory || null,
        requestId,
      }
    })
    response.json({ items, nextBefore })
  })

  router.get('/models', async (_request, response) => {
    const key = sessionKey(response)
    const keyHash = assertKeyHash(key.key_hash)
    const now = new Date()
    const body = await modelsCache.run(`me-models:v2:${keyHash}:${key.enabled ? 'on' : 'blocked'}:${localDayKey(now)}`, async () => {
      // 额度超限自动停用的 Key 此刻不能调用任何模型（网关已把它摘掉），如实返回空列表 + 原因。
      const visible = key.enabled ? await visibleModelIds(key.key_value) : null
      const reason = !key.enabled ? 'key_blocked' : visible ? null : 'gateway_unavailable'
      const catalog = visible ? await loadModelCatalog(visible) : []
      // 「7 天我的用量」与 /me/usage?days=7 同一窗口、同一全量口径。
      const [usageValue] = await reader.run([{
        method: 'all',
        sql: `SELECT model, SUM(request_count) requests, COALESCE(SUM(total_tokens),0) tokens
          FROM usage_hourly_rollup WHERE key_hash = ? AND hour_ms >= ? GROUP BY model`,
        params: [keyHash, calendarWindowStart(7, now)],
      }])
      const used = new Map<string, { requests: number; tokens: number }>()
      for (const row of usageValue as Array<{ model: string; requests: number; tokens: number }>) {
        const model = canonicalModelId(row.model)
        const entry = used.get(model) ?? { requests: 0, tokens: 0 }
        entry.requests += Number(row.requests) || 0
        entry.tokens += Number(row.tokens) || 0
        used.set(model, entry)
      }
      return {
        models: catalog.map(model => meModelView(model, used.get(canonicalModelId(model.id)) ?? { requests: 0, tokens: 0 })),
        reason,
        generatedAt: new Date().toISOString(),
      }
    })
    response.json(body)
  })

  router.get('/connect', (_request, response) => {
    const key = sessionKey(response)
    const baseUrl = gatewayBaseUrl()
    response.json({
      baseUrl,
      anthropicBaseUrl: baseUrl.endsWith('/v1') ? baseUrl.slice(0, -3) : null,
      masked: maskApiKey(key.key_value),
      /** false = 没配 PUBLIC_GATEWAY_BASE_URL，`baseUrl` 是服务器本机地址，外部用不了（与 /api/connect 同义） */
      configured: Boolean(config.publicGatewayBaseUrl),
    })
  })

  return router
}
