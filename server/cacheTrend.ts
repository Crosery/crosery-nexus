import { cacheDialectFor, costForTokens, hitRate, normalizeTokens, wastedCostFor, type NormalizedTokens } from './cacheStats.js'

/**
 * 「不同时间段的总命中率」趋势。
 *
 * 分桶粒度随时间跨度自适应：跨度越大桶越粗，保证点数落在可读区间（约 24-96 个点），
 * 既不会因点太密而糊成一片，也不会因点太疏而看不出波动。
 */
export type TrendBucket = {
  /** 桶起始时刻，ISO 字符串 */
  bucket: string
  requests: number
  freshInputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  hitRate: number | null
  costUsd: number | null
  wastedUsd: number | null
}

export type TrendRow = {
  timestamp: string
  model: string
  provider?: string
  modelGroup?: string
  inputTokens: number
  outputTokens: number
  cachedTokens: number
  /** 缓存写入段。漏传时趋势图会把 claude 画成一条恒 100% 的直线。 */
  cacheWriteTokens?: number
  /** SQL 预聚合行携带这些字段，避免把窗口内每条事件复制回主线程。 */
  requests?: number
  freshInputTokens?: number
  cacheReadTokens?: number
  /** SQL 聚合的逐条结算成本；缺失时回退到按时间戳和当前 token 估算。 */
  costUsd?: number | null
}

/** 按小时跨度选择分桶秒数。 */
export function bucketSecondsFor(hours: number): number {
  if (hours <= 2) return 60 // 1 分钟
  if (hours <= 6) return 300 // 5 分钟
  if (hours <= 24) return 900 // 15 分钟
  if (hours <= 72) return 3600 // 1 小时
  if (hours <= 24 * 14) return 6 * 3600 // 6 小时
  return 24 * 3600 // 1 天
}

const floorToBucket = (iso: string, seconds: number): string | null => {
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return null
  const step = seconds * 1000
  return new Date(Math.floor(ms / step) * step).toISOString()
}

/**
 * 聚合成趋势桶。空桶不补零——补零会在低流量时段画出一条误导性的 0% 命中率折线，
 * 而真实语义是「这段时间没有请求」。前端按时间轴断开处理。
 */
export function buildTrend(rows: TrendRow[], hours: number): { bucketSeconds: number; points: TrendBucket[] } {
  const bucketSeconds = bucketSecondsFor(hours)
  const map = new Map<string, TrendBucket>()

  for (const row of rows) {
    const bucket = floorToBucket(row.timestamp, bucketSeconds)
    if (!bucket) continue

    const tokens: NormalizedTokens = row.freshInputTokens === undefined || row.cacheReadTokens === undefined
      ? normalizeTokens({
          model: row.model,
          inputTokens: row.inputTokens,
          outputTokens: row.outputTokens,
          cachedTokens: row.cachedTokens,
          cacheWriteTokens: row.cacheWriteTokens,
          provider: row.provider,
          modelGroup: row.modelGroup,
        })
      : (() => {
          const dialect = cacheDialectFor(row.model, { provider: row.provider, modelGroup: row.modelGroup })
          const freshInputTokens = Math.max(row.freshInputTokens || 0, 0)
          const cacheReadTokens = Math.max(row.cacheReadTokens || 0, 0)
          const cacheWriteTokens = dialect === 'anthropic' ? Math.max(row.cacheWriteTokens || 0, 0) : 0
          return {
            dialect,
            freshInputTokens,
            cacheReadTokens,
            cacheWriteTokens,
            outputTokens: Math.max(row.outputTokens || 0, 0),
            promptTokens: freshInputTokens + cacheReadTokens + cacheWriteTokens,
          }
        })()

    const entry = map.get(bucket) ?? {
      bucket,
      requests: 0,
      freshInputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      hitRate: null,
      costUsd: null,
      wastedUsd: null,
    }
    entry.requests += Math.max(1, Math.floor(row.requests || 1))
    entry.freshInputTokens += tokens.freshInputTokens
    entry.cacheReadTokens += tokens.cacheReadTokens
    entry.cacheWriteTokens += tokens.cacheWriteTokens

    const cost = typeof row.costUsd === 'number' && Number.isFinite(row.costUsd)
      ? row.costUsd
      : costForTokens(row.model, tokens, row.timestamp)
    if (cost !== null) entry.costUsd = (entry.costUsd ?? 0) + cost
    const wasted = wastedCostFor(row.model, tokens, row.timestamp)
    if (wasted !== null) entry.wastedUsd = (entry.wastedUsd ?? 0) + wasted

    map.set(bucket, entry)
  }

  const points = [...map.values()]
    .map((entry) => {
      entry.hitRate = hitRate(entry)
      return entry
    })
    .sort((a, b) => a.bucket.localeCompare(b.bucket))

  return { bucketSeconds, points }
}
