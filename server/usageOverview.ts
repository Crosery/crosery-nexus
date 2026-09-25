import { estimateCost, getModelPricing, normalizeModelForPricing } from './pricing.js'
import { channelLabel } from './modelIdentity.js'

export type UsageModelRow = {
  model: string
  provider: string
  requests: number
  newInputTokens: number
  outputTokens: number
  cacheTokens: number
  cacheWriteTokens?: number
  reasoningTokens: number
  totalTokens: number
  activeDays: number
  /** 入库时逐条结算的成本之和；有值时优先于按当前单价的事后估算。 */
  costUsd?: number | null
}

export type UsageDailyRow = {
  day: string
  totalTokens: number
  requests?: number
  newInputTokens?: number
  outputTokens?: number
  cacheTokens?: number
  cacheWriteTokens?: number
  errors?: number
  /** 当天全部请求的入库成本之和；缺失时按当天各模型份额估算。 */
  costUsd?: number | null
}

export type UsageDailyModelRow = { day: string; model: string; totalTokens: number }

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

export type UsageOverview = {
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
  /** 当前筛选（可为单个 Key）下的模型明细，供页面在切换 Key 后继续展示内容。 */
  models: Array<Pick<UsageModelRow, 'model' | 'provider' | 'requests' | 'newInputTokens' | 'outputTokens' | 'cacheTokens' | 'cacheWriteTokens' | 'reasoningTokens' | 'totalTokens' | 'activeDays' | 'costUsd'>>
  daily: UsageDailyPoint[]
  bestDay: UsageDailyPoint | null
  unpricedModels: string[]
}

function getIntensity(totalTokens: number, maxTokens: number): 0 | 1 | 2 | 3 | 4 {
  if (totalTokens <= 0 || maxTokens <= 0) return 0
  const ratio = totalTokens / maxTokens
  if (ratio <= 0.25) return 1
  if (ratio <= 0.5) return 2
  if (ratio <= 0.75) return 3
  return 4
}

function formatDay(date: Date): string {
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/** 补齐区间内没有流量的日期，热力图才不会把空白天数压缩掉。 */
export function buildDailySeries(
  rows: UsageDailyRow[],
  dayCount: number,
  anchor = new Date(),
  modelRows: UsageDailyModelRow[] = [],
): UsageDailyPoint[] {
  const byDay = new Map(rows.map((row) => [row.day, row]))
  const modelsByDay = new Map<string, Array<{ model: string; totalTokens: number }>>()
  for (const row of modelRows) {
    const list = modelsByDay.get(row.day)
    const entry = { model: row.model, totalTokens: row.totalTokens }
    if (list) list.push(entry)
    else modelsByDay.set(row.day, [entry])
  }

  const count = Math.max(1, Math.floor(dayCount))
  const end = new Date(anchor)
  end.setHours(0, 0, 0, 0)
  const days: Array<Omit<UsageDailyPoint, 'intensity'>> = []
  for (let offset = count - 1; offset >= 0; offset--) {
    const date = new Date(end)
    date.setDate(end.getDate() - offset)
    const day = formatDay(date)
    const row = byDay.get(day)
    const dayModels = (modelsByDay.get(day) ?? []).sort((a, b) => b.totalTokens - a.totalTokens)
    // 成本按当天各模型分别计价，不能拿日总量乘一个均价；有入库账本时直接用账本
    let dayCost: number | null = null
    if (row && typeof row.costUsd === 'number' && Number.isFinite(row.costUsd)) {
      dayCost = row.costUsd
    } else if (row) {
      const mix = (row.newInputTokens ?? 0) + (row.outputTokens ?? 0) + (row.cacheTokens ?? 0) + (row.cacheWriteTokens ?? 0)
      for (const entry of dayModels) {
        const share = mix > 0 ? entry.totalTokens / (row.totalTokens || 1) : 0
        const cost = estimateCost(
          entry.model,
          (row.newInputTokens ?? 0) * share,
          (row.outputTokens ?? 0) * share,
          (row.cacheTokens ?? 0) * share,
          (row.cacheWriteTokens ?? 0) * share,
        )
        if (cost !== null) dayCost = (dayCost ?? 0) + cost
      }
    }
    days.push({
      day,
      totalTokens: row?.totalTokens ?? 0,
      requests: row?.requests ?? 0,
      newInputTokens: row?.newInputTokens ?? 0,
      outputTokens: row?.outputTokens ?? 0,
      cacheTokens: row?.cacheTokens ?? 0,
      cacheWriteTokens: row?.cacheWriteTokens ?? 0,
      errors: row?.errors ?? 0,
      estimatedCostUsd: dayCost,
      topModels: dayModels.slice(0, 3),
    })
  }
  const max = days.reduce((peak, entry) => Math.max(peak, entry.totalTokens), 0)
  return days.map((entry) => ({ ...entry, intensity: getIntensity(entry.totalTokens, max) }))
}

export function buildUsageOverview(
  models: UsageModelRow[],
  daily: UsageDailyRow[],
  dayCount: number,
  anchor = new Date(),
  dailyModels: UsageDailyModelRow[] = [],
): UsageOverview {
  const providers = new Map<string, UsageProviderOverview>()
  const unpriced = new Set<string>()
  let totalTokens = 0
  let newInputTokens = 0
  let outputTokens = 0
  let cacheTokens = 0
  let cacheWriteTokens = 0
  let reasoningTokens = 0
  let requests = 0
  let cost = 0
  let anyPriced = false

  for (const row of models) {
    totalTokens += row.totalTokens
    newInputTokens += row.newInputTokens
    outputTokens += row.outputTokens
    cacheTokens += row.cacheTokens
    cacheWriteTokens += row.cacheWriteTokens || 0
    reasoningTokens += row.reasoningTokens
    requests += row.requests

    const rowCost = typeof row.costUsd === 'number' && Number.isFinite(row.costUsd)
      ? row.costUsd
      : estimateCost(row.model, row.newInputTokens, row.outputTokens, row.cacheTokens, row.cacheWriteTokens || 0)
    if (rowCost === null) {
      // 按裸名去重：`qiji/x` 和 `x` 缺的是同一份价格，列两遍只会让提示更难读
      if (row.totalTokens > 0) unpriced.add(normalizeModelForPricing(row.model))
    } else {
      cost += rowCost
      anyPriced = true
    }

    const existing = providers.get(row.provider)
    const provider: UsageProviderOverview = existing ?? {
      id: row.provider,
      label: channelLabel(row.provider),
      hasData: false,
      requests: 0,
      totalTokens: 0,
      newInputTokens: 0,
      outputTokens: 0,
      cacheTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      estimatedCostUsd: null,
      hasPartialCost: false,
      topModel: null,
      models: 0,
    }
    provider.requests += row.requests
    provider.totalTokens += row.totalTokens
    provider.newInputTokens += row.newInputTokens
    provider.outputTokens += row.outputTokens
    provider.cacheTokens += row.cacheTokens
    provider.cacheWriteTokens += row.cacheWriteTokens || 0
    provider.reasoningTokens += row.reasoningTokens
    provider.models += 1
    provider.hasData = provider.hasData || row.totalTokens > 0
    if (rowCost === null) {
      if (row.totalTokens > 0) provider.hasPartialCost = true
    } else {
      provider.estimatedCostUsd = (provider.estimatedCostUsd ?? 0) + rowCost
    }
    // models 已按 tokens 降序传入，所以首次遇到的模型就是该 provider 的头部模型
    if (!provider.topModel && row.totalTokens > 0) provider.topModel = row.model
    providers.set(row.provider, provider)
  }

  const series = buildDailySeries(daily, dayCount, anchor, dailyModels)
  const bestDay = series.reduce<UsageDailyPoint | null>(
    (best, entry) => (entry.totalTokens > 0 && (!best || entry.totalTokens > best.totalTokens) ? entry : best),
    null,
  )
  const mixTotal = newInputTokens + outputTokens + cacheTokens + cacheWriteTokens

  return {
    totalTokens,
    newInputTokens,
    outputTokens,
    cacheTokens,
    cacheWriteTokens,
    reasoningTokens,
    requests,
    activeDays: series.filter((entry) => entry.totalTokens > 0).length,
    estimatedCostUsd: anyPriced ? cost : null,
    hasPartialCost: unpriced.size > 0,
    cacheShare: mixTotal > 0 ? cacheTokens / mixTotal : null,
    providers: [...providers.values()].sort((a, b) => b.totalTokens - a.totalTokens),
    // 选中单个 API Key 时，页面仍需要这份按模型明细，避免下方整块空白。
    models: models.map((row) => ({ ...row })),
    daily: series,
    bestDay,
    unpricedModels: [...unpriced].sort(),
  }
}

export { getModelPricing }
