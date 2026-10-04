import type { ConsoleGroup } from './groups.js'
import { modelsForGroups } from './groups.js'
import { db } from './db.js'

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

/**
 * 按前缀默认对所有 Key 开放的模型族（2026-09-26 用户要求：gpt-image 全系默认开放）。
 * 从实时分组里展开而不是写死型号：上游新增 gpt-image-* 自动跟上，渠道下线则自动消失。
 * 只放开这一族，同渠道（codex）的其它模型仍要 Key 显式勾选 codex 组。
 */
export const DEFAULT_OPEN_MODEL_PREFIXES = ['gpt-image-'] as const

export function getCustomSharedModels(): string[] {
  try {
    const row = db.prepare("SELECT value FROM app_settings WHERE key = 'custom_shared_models'").get() as { value: string } | undefined
    return row ? JSON.parse(row.value) : []
  } catch {
    return []
  }
}

export function saveCustomSharedModels(models: string[]): void {
  db.prepare("INSERT INTO app_settings (key, value) VALUES ('custom_shared_models', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(JSON.stringify([...new Set(models)].sort()))
}

/**
 * 默认开放项只取实时目录里真实存在的模型。网关查不到模型且没有兜底目录时必须如实降级为
 * DENY_ALL（2026-08-20 事故约束），不能靠写死的默认项假装还有模型可用。
 */
export function defaultOpenModels(groups: ConsoleGroup[], custom: string[] = getCustomSharedModels()) {
  const exact = new Set<string>([...DEFAULT_OPEN_MODELS, ...custom])
  const models = new Set<string>()
  for (const group of groups) {
    for (const model of group.models) {
      if (exact.has(model) || DEFAULT_OPEN_MODEL_PREFIXES.some((prefix) => model.startsWith(prefix))) models.add(model)
    }
  }
  return [...models].sort()
}

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
export function buildKeyAccessPlan(groups: ConsoleGroup[], rows: KeyAccessRow[], custom: string[] = getCustomSharedModels()): KeyAccessPlan {
  const knownGroups = new Set(groups.map((group) => group.id))
  const access: Record<string, string[]> = {}
  const normalizedGroups = new Map<string, string[]>()
  const defaults = defaultOpenModels(groups, custom)

  for (const row of rows) {
    const selected = [...new Set(row.groups.filter((group) => knownGroups.has(group)))].sort()
    normalizedGroups.set(row.keyValue, selected)
    if (!row.enabled) continue
    const models = [...new Set([...modelsForGroups(groups, selected), ...defaults])].sort()
    access[row.keyValue] = models.length ? models : [DENY_ALL_MODEL]
  }

  return { access, normalizedGroups }
}
