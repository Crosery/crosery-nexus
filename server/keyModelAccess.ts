import type { ConsoleGroup } from './groups.js'
import { modelsForGroups } from './groups.js'

/**
 * CPA 将「没有映射」和「空数组」都解释为不限制。为了表达“这把 Key 当前没有任何
 * 可用渠道”，必须写入一个不可能存在的模型名，让模型目录为空且任何请求都返回 403。
 */
export const DENY_ALL_MODEL = '__console_no_models_allowed__'

/**
 * 默认对所有 Key 开放的模型（2026-09-17 用户要求）：与渠道分组无关，任何启用中的 Key
 * 都能调用。目前唯一一项是 claude haiku；其它 claude 模型仍要 Key 显式勾选 claude 组
 * 才会进入白名单。
 *
 * 模型闸之外还有渠道闸（见 keyChannelAccess.ts 的 DEFAULT_OPEN_CHANNELS）：
 * 只放开模型不放开渠道，请求会以 503 auth_not_found 失败。
 */
export const DEFAULT_OPEN_MODELS = ['claude-haiku-4-5-20251001'] as const

export type KeyAccessRow = {
  keyValue: string
  enabled: boolean
  groups: string[]
}

export type KeyAccessPlan = {
  access: Record<string, string[]>
  normalizedGroups: Map<string, string[]>
}

const normalizeAccess = (access: Record<string, string[]>) => Object.fromEntries(
  Object.entries(access)
    .map(([key, models]) => [key, [...new Set(models)].sort()] as const)
    .sort(([left], [right]) => left.localeCompare(right)),
)

/** 比较前先排序，避免 CPA 只因数组顺序不同就反复保存并重载。 */
export function sameKeyAccess(left: Record<string, string[]>, right: Record<string, string[]>) {
  return JSON.stringify(normalizeAccess(left)) === JSON.stringify(normalizeAccess(right))
}

/**
 * 以当前实时分组为唯一真相源重建所有 Key 白名单。
 * 已关闭/已删除渠道不会进入 groups，因此会从 Key 的选择中清掉；若一项都不剩则拒绝全部模型。
 */
export function buildKeyAccessPlan(groups: ConsoleGroup[], rows: KeyAccessRow[]): KeyAccessPlan {
  const knownGroups = new Set(groups.map((group) => group.id))
  const access: Record<string, string[]> = {}
  const normalizedGroups = new Map<string, string[]>()

  for (const row of rows) {
    const selected = [...new Set(row.groups.filter((group) => knownGroups.has(group)))].sort()
    normalizedGroups.set(row.keyValue, selected)
    if (!row.enabled) continue
    const models = [...new Set([...modelsForGroups(groups, selected), ...DEFAULT_OPEN_MODELS])].sort()
    access[row.keyValue] = models.length ? models : [DENY_ALL_MODEL]
  }

  return { access, normalizedGroups }
}
