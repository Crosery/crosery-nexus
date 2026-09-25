import { estimateCost } from './pricing.js'

export type KeyQuota = {
  totalUsd: number
  dailyUsd: number
  weeklyUsd: number
}

export type QuotaSpend = { total: number; daily: number; weekly: number }

export type QuotaWindowState = {
  limitUsd: number
  spentUsd: number
  /** 0 上限时为 null——不限额没有「用了百分之几」的概念 */
  ratio: number | null
  exceeded: boolean
  /** 本窗口当前统计的起点；总额度仅在管理员手动重置后变化。 */
  startsAt: string
  /** 下一个自然刷新点；总额度没有自动刷新。 */
  resetsAt: string | null
}

export type KeyQuotaState = {
  unlimited: boolean
  total: QuotaWindowState
  daily: QuotaWindowState
  weekly: QuotaWindowState
  exceeded: boolean
  /** 触发停用的那个窗口，用于写清楚停用原因 */
  exceededWindow: 'total' | 'daily' | 'weekly' | null
}

export function validateQuota(quota: KeyQuota) {
  for (const [label, value] of [
    ['总额度', quota.totalUsd],
    ['日额度', quota.dailyUsd],
    ['周额度', quota.weeklyUsd],
  ] as const) {
    if (!Number.isFinite(value) || value < 0) throw new Error(`${label}必须是 0 或正数，0 表示不限额`)
    if (value > 1_000_000) throw new Error(`${label}不能超过 1000000`)
  }
  if (quota.totalUsd > 0 && quota.dailyUsd > quota.totalUsd) throw new Error('日额度不能超过总额度')
  if (quota.totalUsd > 0 && quota.weeklyUsd > quota.totalUsd) throw new Error('周额度不能超过总额度')
  if (quota.weeklyUsd > 0 && quota.dailyUsd > quota.weeklyUsd) throw new Error('日额度不能超过周额度')
  return quota
}

function windowState(limitUsd: number, spentUsd: number, startsAt: string, resetsAt: string | null): QuotaWindowState {
  if (!(limitUsd > 0)) return { limitUsd: 0, spentUsd, ratio: null, exceeded: false, startsAt, resetsAt }
  return { limitUsd, spentUsd, ratio: spentUsd / limitUsd, exceeded: spentUsd >= limitUsd, startsAt, resetsAt }
}

export type QuotaWindowTiming = Record<'total' | 'daily' | 'weekly', { startsAt: string; resetsAt: string | null }>

export function evaluateQuota(quota: KeyQuota, spend: QuotaSpend, timing: QuotaWindowTiming = quotaWindowTiming('', '', '', new Date())): KeyQuotaState {
  const total = windowState(quota.totalUsd, spend.total, timing.total.startsAt, timing.total.resetsAt)
  const daily = windowState(quota.dailyUsd, spend.daily, timing.daily.startsAt, timing.daily.resetsAt)
  const weekly = windowState(quota.weeklyUsd, spend.weekly, timing.weekly.startsAt, timing.weekly.resetsAt)
  const exceededWindow = total.exceeded ? 'total' : weekly.exceeded ? 'weekly' : daily.exceeded ? 'daily' : null
  return {
    unlimited: !(quota.totalUsd > 0 || quota.dailyUsd > 0 || quota.weeklyUsd > 0),
    total,
    daily,
    weekly,
    exceeded: exceededWindow !== null,
    exceededWindow,
  }
}

export const WINDOW_LABELS = { total: '总额度', daily: '日额度', weekly: '周额度' } as const

/**
 * 周期起算点：取「自然窗口起点」与「上次手动重置」中较晚者，
 * 这样手动重置能立刻清零，而日/周窗口照常自然滚动。
 * 所有时间都基于运行 console 服务的服务器本地时区。
 */
export function quotaWindowStart(kind: 'total' | 'daily' | 'weekly', since: string, now = new Date()): string {
  const marks: string[] = []
  if (since) marks.push(since)
  if (kind === 'daily') {
    const start = new Date(now)
    start.setHours(0, 0, 0, 0)
    marks.push(start.toISOString())
  } else if (kind === 'weekly') {
    const start = new Date(now)
    start.setHours(0, 0, 0, 0)
    start.setDate(start.getDate() - ((start.getDay() + 6) % 7)) // 周一为起点
    marks.push(start.toISOString())
  }
  return marks.sort().at(-1) || '1970-01-01T00:00:00.000Z'
}

/** 日额度每天本地 00:00 刷新，周额度每周一本地 00:00 刷新，总额度只有手动重置。 */
export function quotaWindowResetAt(kind: 'total' | 'daily' | 'weekly', now = new Date()): string | null {
  if (kind === 'total') return null
  const reset = new Date(now)
  reset.setHours(0, 0, 0, 0)
  if (kind === 'daily') reset.setDate(reset.getDate() + 1)
  else {
    const daysUntilNextMonday = ((8 - reset.getDay()) % 7) || 7
    reset.setDate(reset.getDate() + daysUntilNextMonday)
  }
  return reset.toISOString()
}

export function quotaWindowTiming(totalSince: string, dailySince: string, weeklySince: string, now = new Date()): QuotaWindowTiming {
  return {
    total: { startsAt: quotaWindowStart('total', totalSince, now), resetsAt: null },
    daily: { startsAt: quotaWindowStart('daily', dailySince, now), resetsAt: quotaWindowResetAt('daily', now) },
    weekly: { startsAt: quotaWindowStart('weekly', weeklySince, now), resetsAt: quotaWindowResetAt('weekly', now) },
  }
}

export type QuotaDecisionRow = { keyHash: string; enabled: boolean; blockedReason: string; state: KeyQuotaState }

/**
 * 只自动恢复「因超额被停」的 key（blockedReason 非空），
 * 人工停用的 key 不能因为额度充足就被静默启用。
 */
export function planQuotaActions(rows: QuotaDecisionRow[]) {
  const block: Array<{ keyHash: string; window: 'total' | 'daily' | 'weekly' }> = []
  const restore: string[] = []
  for (const row of rows) {
    if (row.state.exceeded && row.enabled) block.push({ keyHash: row.keyHash, window: row.state.exceededWindow || 'total' })
    else if (!row.state.exceeded && !row.enabled && row.blockedReason) restore.push(row.keyHash)
  }
  return { block, restore }
}

export type UsageCostRow = {
  model: string
  newInputTokens: number
  outputTokens: number
  cacheTokens: number
  /** 缓存写入段（1.25x 输入价）。旧行没有该字段时按 0，结果与修复前一致。 */
  cacheWriteTokens?: number
  /** 账本里逐条结算的成本之和；有值时优先，避免促销价切换后额度被按新价重算。 */
  costUsd?: number | null
}

/**
 * 按模型分别计价再累加。未定价的模型计 0——宁可少算，也不要用一个猜的均价
 * 把用户的 key 误停。页面会单独提示哪些模型没有定价。
 */
export function sumCost(rows: UsageCostRow[]): number {
  let total = 0
  for (const row of rows) {
    const cost = typeof row.costUsd === 'number' && Number.isFinite(row.costUsd)
      ? row.costUsd
      : estimateCost(row.model, row.newInputTokens, row.outputTokens, row.cacheTokens, row.cacheWriteTokens || 0)
    if (cost !== null) total += cost
  }
  return total
}
