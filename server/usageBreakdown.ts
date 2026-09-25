import { cacheWritePrice, estimateCost, getModelPricing, normalizeModelForPricing } from './pricing.js'

export type BreakdownRow = {
  model: string
  provider?: string
  requests: number
  newInputTokens: number
  outputTokens: number
  cacheTokens: number
  /** 缓存写入段；旧调用方不传时按 0，与修复前行为一致。 */
  cacheWriteTokens?: number
  reasoningTokens: number
  totalTokens: number
  /**
   * 入库时按请求时刻价格与上下文分档结算好的成本之和（SUM(cost_usd)）。
   * 有值时优先于按当前单价的事后估算，这样促销期前后的账单不会被混成一个价。
   */
  costUsd?: number | null
}

export type ModelCost = {
  model: string
  /** 当前模型的单价，单位为美元 / 百万 token。图片模型依网关实际记录的图片 token 字段结算。 */
  pricing: { input: number; output: number; cacheRead: number; cacheWrite?: number; unit: 'token' } | null
  requests: number
  newInputTokens: number
  outputTokens: number
  cacheTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  totalTokens: number
  /** 分段成本，让用户看清钱花在输入、输出、缓存读还是缓存写上 */
  inputCostUsd: number | null
  outputCostUsd: number | null
  cacheCostUsd: number | null
  cacheWriteCostUsd: number | null
  totalCostUsd: number | null
  priced: boolean
}

export type UsageBreakdown = {
  models: ModelCost[]
  totals: {
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
  unpricedModels: string[]
}

/** 把一行用量拆成输入/输出/缓存读/缓存写四段成本；未定价模型返回 null 而不是 0，避免和「真的没花钱」混淆。 */
export function costForRow(row: BreakdownRow): ModelCost {
  const pricing = getModelPricing(row.model)
  const cacheWriteTokens = row.cacheWriteTokens || 0
  const base = { ...row, cacheWriteTokens, pricing }
  if (!pricing) {
    return { ...base, inputCostUsd: null, outputCostUsd: null, cacheCostUsd: null, cacheWriteCostUsd: null, totalCostUsd: null, priced: false }
  }
  let inputCostUsd = (row.newInputTokens * pricing.input) / 1_000_000
  let outputCostUsd = (row.outputTokens * pricing.output) / 1_000_000
  let cacheCostUsd = (row.cacheTokens * pricing.cacheRead) / 1_000_000
  let cacheWriteCostUsd = (cacheWriteTokens * cacheWritePrice(pricing)) / 1_000_000
  const estimated = inputCostUsd + outputCostUsd + cacheCostUsd + cacheWriteCostUsd
  // 入库时的逐条结算比事后按当前单价重算准确（含促销期与长上下文分档）。
  // 四段拆分仍按当前单价的比例分摊，让总额与账本一致、分段仍可读。
  if (typeof row.costUsd === 'number' && Number.isFinite(row.costUsd) && row.costUsd >= 0 && estimated > 0) {
    const scale = row.costUsd / estimated
    inputCostUsd *= scale
    outputCostUsd *= scale
    cacheCostUsd *= scale
    cacheWriteCostUsd *= scale
  }
  return {
    ...base,
    inputCostUsd,
    outputCostUsd,
    cacheCostUsd,
    cacheWriteCostUsd,
    totalCostUsd: inputCostUsd + outputCostUsd + cacheCostUsd + cacheWriteCostUsd,
    priced: true,
  }
}

export function buildUsageBreakdown(rows: BreakdownRow[]): UsageBreakdown {
  // SQL 先按 model + provider 聚合，Node 再把同一规范模型跨渠道合并；
  // 这样每条 provider 的新输入仍按真实协议计算，不会把 Claude 与兼容口径混成一个公式。
  const merged = new Map<string, BreakdownRow>()
  for (const row of rows) {
    const model = normalizeModelForPricing(row.model) || 'unknown'
    const current = merged.get(model)
    if (!current) {
      merged.set(model, { ...row, model })
      continue
    }
    current.requests += row.requests
    current.newInputTokens += row.newInputTokens
    current.outputTokens += row.outputTokens
    current.cacheTokens += row.cacheTokens
    current.cacheWriteTokens = (current.cacheWriteTokens || 0) + (row.cacheWriteTokens || 0)
    current.reasoningTokens += row.reasoningTokens
    current.totalTokens += row.totalTokens
    // 任一来源缺少入库成本就整体回退估算，避免把「一半账本 + 一半估算」当成精确值。
    current.costUsd = typeof current.costUsd === 'number' && typeof row.costUsd === 'number' ? current.costUsd + row.costUsd : null
  }
  const models = [...merged.values()].map(costForRow).sort((a, b) => (b.totalCostUsd ?? 0) - (a.totalCostUsd ?? 0) || b.totalTokens - a.totalTokens)
  const totals = {
    requests: 0,
    newInputTokens: 0,
    outputTokens: 0,
    cacheTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    inputCostUsd: 0,
    outputCostUsd: 0,
    cacheCostUsd: 0,
    cacheWriteCostUsd: 0,
    totalCostUsd: 0,
  }
  const unpriced = new Set<string>()
  for (const model of models) {
    totals.requests += model.requests
    totals.newInputTokens += model.newInputTokens
    totals.outputTokens += model.outputTokens
    totals.cacheTokens += model.cacheTokens
    totals.cacheWriteTokens += model.cacheWriteTokens
    totals.totalTokens += model.totalTokens
    totals.inputCostUsd += model.inputCostUsd ?? 0
    totals.outputCostUsd += model.outputCostUsd ?? 0
    totals.cacheCostUsd += model.cacheCostUsd ?? 0
    totals.cacheWriteCostUsd += model.cacheWriteCostUsd ?? 0
    totals.totalCostUsd += model.totalCostUsd ?? 0
    if (!model.priced && model.totalTokens > 0) unpriced.add(normalizeModelForPricing(model.model))
  }
  return { models, totals, unpricedModels: [...unpriced].sort() }
}

export { estimateCost }
