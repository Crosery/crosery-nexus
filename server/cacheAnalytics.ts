import { clientLabel } from './clientAgent.js'
import { canonicalModelId, channelLabel } from './modelIdentity.js'
import { activeProviderId, isActiveProvider } from './currentChannels.js'
import type { ConsoleGroup } from './groups.js'
import {
  CACHE_WRITE_CEILING,
  bandFor,
  cacheDialectFor,
  costForTokens,
  hitRate,
  isOverCacheCeiling,
  normalizeTokens,
  wastedCostFor,
  type CacheDialect,
} from './cacheStats.js'

/**
 * 缓存分析全部基于数据库原始字段，口径归一化在 TS 层统一完成。
 * SQL 里不做任何 input/cached 加减 —— 两家上游口径相反，写在 SQL 里必然出错。
 */
export type CacheEventRow = {
  timestamp: string
  model: string
  endpoint: string
  source: string
  keyName: string | null
  authIndex: string
  provider?: string
  modelGroup?: string
  inputTokens: number
  outputTokens: number
  cachedTokens: number
  /** Anthropic 缓存写入段；不传时按 0 处理，保持旧调用方可用。 */
  cacheWriteTokens?: number
  /** 入库时按请求时刻结算的成本；历史兼容行可能没有。 */
  costUsd?: number | null
  latencyMs: number
  /** 调用方分类，用于按客户端聚合命中率 */
  clientType?: string
}

export type CacheGroupStat = {
  label: string
  dialect: CacheDialect | 'mixed'
  requests: number
  freshInputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  outputTokens: number
  promptTokens: number
  hitRate: number | null
  costUsd: number | null
  /** 若全部命中可省下的金额，衡量优化空间 */
  wastedUsd: number | null
  /** 提示长度越过缓存写入上限的请求数 */
  overCeilingRequests: number
}

/** 单一归一化入口，避免多处重复拼参数时漏传缓存写入段。 */
const tokensFor = (row: CacheEventRow) => normalizeTokens({
  model: row.model,
  inputTokens: row.inputTokens,
  outputTokens: row.outputTokens,
  cachedTokens: row.cachedTokens,
  cacheWriteTokens: row.cacheWriteTokens,
  provider: row.provider,
  modelGroup: row.modelGroup,
})

const emptyStat = (label: string): CacheGroupStat => ({
  label,
  dialect: 'mixed',
  requests: 0,
  freshInputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
  promptTokens: 0,
  hitRate: null,
  costUsd: null,
  wastedUsd: null,
  overCeilingRequests: 0,
})

function accumulate(stat: CacheGroupStat, row: CacheEventRow): void {
  const tokens = tokensFor(row)
  stat.requests += 1
  stat.freshInputTokens += tokens.freshInputTokens
  stat.cacheReadTokens += tokens.cacheReadTokens
  stat.cacheWriteTokens += tokens.cacheWriteTokens
  stat.outputTokens += tokens.outputTokens
  stat.promptTokens += tokens.promptTokens
  if (isOverCacheCeiling(tokens)) stat.overCeilingRequests += 1

  stat.dialect = stat.requests === 1 ? tokens.dialect : stat.dialect === tokens.dialect ? tokens.dialect : 'mixed'

  const cost = typeof row.costUsd === 'number' && Number.isFinite(row.costUsd)
    ? row.costUsd
    : costForTokens(row.model, tokens, row.timestamp)
  if (cost !== null) stat.costUsd = (stat.costUsd ?? 0) + cost
  const wasted = wastedCostFor(row.model, tokens, row.timestamp)
  if (wasted !== null) stat.wastedUsd = (stat.wastedUsd ?? 0) + wasted
}

function finalize(stat: CacheGroupStat): CacheGroupStat {
  stat.hitRate = hitRate(stat)
  return stat
}

function groupBy(rows: CacheEventRow[], keyOf: (row: CacheEventRow) => string): CacheGroupStat[] {
  const map = new Map<string, CacheGroupStat>()
  for (const row of rows) {
    const key = keyOf(row)
    const stat = map.get(key) ?? emptyStat(key)
    accumulate(stat, row)
    map.set(key, stat)
  }
  return [...map.values()].map(finalize).sort((a, b) => b.promptTokens - a.promptTokens)
}

export type CacheAnalytics = {
  ceiling: number
  overall: CacheGroupStat
  byModel: CacheGroupStat[]
  byChannel: CacheGroupStat[]
  byEndpoint: CacheGroupStat[]
  byContextBand: CacheGroupStat[]
  /** 按调用方（Pi / Claude Code / Codex …）聚合，定位哪个客户端在烧缓存写入 */
  byClient: CacheGroupStat[]
  /** 命中率最差且浪费最多的请求，直接给出可操作对象 */
  worstRequests: Array<{
    timestamp: string
    model: string
    endpoint: string
    keyName: string | null
    source: string
    freshInputTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
    promptTokens: number
    hitRate: number | null
    costUsd: number | null
    wastedUsd: number | null
    overCeiling: boolean
    latencyMs: number
  }>
}

/** `currentOnly = false`：行已按全部渠道口径取出，只用 activeGroups 折叠渠道写法，不再剔除已移除渠道。 */
export function buildCacheAnalytics(rows: CacheEventRow[], activeGroups?: ConsoleGroup[], currentOnly = true): CacheAnalytics {
  const currentRows = activeGroups && currentOnly ? rows.filter((row) => isActiveProvider(row.provider || '', activeGroups)) : rows
  rows = currentRows
  const overall = emptyStat('全部')
  for (const row of rows) accumulate(overall, row)
  finalize(overall)

  const byContextBand = groupBy(rows, (row) => bandFor(tokensFor(row).promptTokens))
    .sort((a, b) => a.label.localeCompare(b.label, 'zh'))

  const worstRequests = rows
    .map((row) => {
      const tokens = tokensFor(row)
      return {
        timestamp: row.timestamp,
        // 统计维度统一为规范模型名；同一个模型从不同渠道进来仍是一个模型。
        model: canonicalModelId(row.model),
        endpoint: row.endpoint,
        keyName: row.keyName,
        source: row.source,
        freshInputTokens: tokens.freshInputTokens,
        cacheReadTokens: tokens.cacheReadTokens,
        cacheWriteTokens: tokens.cacheWriteTokens,
        promptTokens: tokens.promptTokens,
        hitRate: hitRate(tokens),
        costUsd: typeof row.costUsd === 'number' && Number.isFinite(row.costUsd) ? row.costUsd : costForTokens(row.model, tokens, row.timestamp),
        wastedUsd: wastedCostFor(row.model, tokens, row.timestamp),
        overCeiling: isOverCacheCeiling(tokens),
        latencyMs: row.latencyMs,
      }
    })
    // 全命中的请求没有优化空间，留下来只会淹没真正费钱的那些
    .filter((item) => item.freshInputTokens > 0)
    .sort((a, b) => (b.wastedUsd ?? 0) - (a.wastedUsd ?? 0))
    .slice(0, 200)

  return {
    ceiling: CACHE_WRITE_CEILING,
    overall,
    byModel: groupBy(rows, (row) => canonicalModelId(row.model)),
    // 渠道必须按真实 provider 统计，不能用 model_group 或 API Key 代替。
    byChannel: groupBy(rows, (row) => channelLabel(activeGroups ? activeProviderId(row.provider || '', activeGroups) : row.provider || '')),
    byEndpoint: groupBy(rows, (row) => row.endpoint),
    byContextBand,
    byClient: groupBy(rows, (row) => clientLabel(row.clientType || 'unknown')),
    worstRequests,
  }
}

export { cacheDialectFor }
