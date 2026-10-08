import type { DatabaseSync } from 'node:sqlite'

/**
 * Key 的实际生效权限（写进 CPA 的模型白名单 + 渠道白名单）一有变化就写一条审计，带增删明细。
 * 对账每 15 秒跑一次，所以和上一次「已记录的生效权限」比，而不是和 CPA 当前内容比：
 * CPA 侧的规范化或丢条目不会被当成变化，没有变化的轮次一条也不写。
 */

export type EffectiveKeyAccess = { models: string[]; channels: string[] }
export type EffectiveAccessMap = Record<string, EffectiveKeyAccess>
export type KeyAccessChange = {
  keyHash: string
  models: { added: string[]; removed: string[]; before: number; after: number }
  channels: { added: string[]; removed: string[] }
}

const SETTING_KEY = 'key_access.effective.v1'
/** 审计明细里每个列表最多列这么多项，完整计数照记。 */
const MAX_LISTED = 100

const EMPTY: EffectiveKeyAccess = { models: [], channels: [] }
const sorted = (values: string[]) => [...new Set(values)].sort()
const minus = (left: string[], right: string[]) => {
  const exclude = new Set(right)
  return left.filter((value) => !exclude.has(value))
}

export function normalizeEffectiveAccess(map: EffectiveAccessMap): EffectiveAccessMap {
  return Object.fromEntries(Object.keys(map).sort().map((keyHash) => [keyHash, { models: sorted(map[keyHash].models), channels: sorted(map[keyHash].channels) }]))
}

/** `known` = 数据库里仍存在的 Key：删掉的 Key 不再对比（删除本身另有审计）。 */
export function diffEffectiveAccess(previous: EffectiveAccessMap, next: EffectiveAccessMap, known: ReadonlySet<string>): KeyAccessChange[] {
  const changes: KeyAccessChange[] = []
  const keyHashes = new Set([...Object.keys(next), ...Object.keys(previous).filter((keyHash) => known.has(keyHash))])
  for (const keyHash of [...keyHashes].sort()) {
    const before = previous[keyHash] || EMPTY
    const after = next[keyHash] || EMPTY
    const models = { added: minus(after.models, before.models), removed: minus(before.models, after.models) }
    const channels = { added: minus(after.channels, before.channels), removed: minus(before.channels, after.channels) }
    if (!models.added.length && !models.removed.length && !channels.added.length && !channels.removed.length) continue
    changes.push({ keyHash, models: { ...models, before: before.models.length, after: after.models.length }, channels })
  }
  return changes
}

function readSnapshot(database: DatabaseSync): EffectiveAccessMap | null {
  const row = database.prepare('SELECT value FROM app_settings WHERE key = ?').get(SETTING_KEY) as { value?: string } | undefined
  if (!row?.value) return null
  try {
    const parsed = JSON.parse(row.value) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const map: EffectiveAccessMap = {}
    for (const [keyHash, value] of Object.entries(parsed as Record<string, unknown>)) {
      const entry = value as Partial<EffectiveKeyAccess> | null
      if (!entry || !Array.isArray(entry.models) || !Array.isArray(entry.channels)) continue
      map[keyHash] = { models: entry.models.filter((item) => typeof item === 'string'), channels: entry.channels.filter((item) => typeof item === 'string') }
    }
    return map
  } catch {
    return null
  }
}

const list = (values: string[]) => values.length > MAX_LISTED ? [...values.slice(0, MAX_LISTED), `…+${values.length - MAX_LISTED}`] : values

/**
 * 对比并落盘这一轮的生效权限，有变化的 Key 各写一条 `key_access_change` 审计（目标是 Key 名称，从不写 Key 本身）。
 * 第一次运行（没有基线）只建基线、不写审计，避免上线时每把 Key 刷一条「全部新增」。
 */
export function recordKeyAccessChanges(
  database: DatabaseSync,
  next: EffectiveAccessMap,
  known: ReadonlyMap<string, string>,
  audit: (action: string, target: string, details: string) => void,
): KeyAccessChange[] {
  const normalized = normalizeEffectiveAccess(next)
  const previous = readSnapshot(database)
  const changes = previous ? diffEffectiveAccess(previous, normalized, new Set(known.keys())) : []
  if (!previous || JSON.stringify(normalizeEffectiveAccess(previous)) !== JSON.stringify(normalized)) {
    database.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(SETTING_KEY, JSON.stringify(normalized))
  }
  for (const change of changes) {
    audit('key_access_change', known.get(change.keyHash) || change.keyHash.slice(0, 12), JSON.stringify({
      models: { added: list(change.models.added), removed: list(change.models.removed), before: change.models.before, after: change.models.after },
      channels: change.channels,
    }))
  }
  return changes
}
