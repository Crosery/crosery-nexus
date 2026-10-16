import { createHash } from 'node:crypto'
import type { CredentialSummary } from './credentials.js'
import { db, transaction } from './db.js'
import type { ModelEntry } from './modelIndex.js'

/**
 * 模型级路由：每个模型自己的来源顺序与权重，存在控制台；中转层按它把请求定向到具体来源（CPA 的 `prefix`），
 * CPA 只负责转发。没存过顺序的模型：来源按渠道名排，权重全 0，不轮询。
 */
export type RouteSourceKind = 'compat' | 'account'
/** channel = 兼容渠道名，或账号文件名（kind = account）。 */
export type RouteItem = { channel: string; kind: RouteSourceKind; weight: number }

export const MAX_ROUTE_WEIGHT = 100000

/** 来源 → CPA prefix。固定、可逆，不含 `/`。 */
export const routePrefix = (source: string) => `rt-${source.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'x'}`

type OrderRow = { source: string; kind: string; position: number; weight: number }

function savedOrder(model: string): OrderRow[] {
  return db.prepare('SELECT source, kind, position, weight FROM model_route_order WHERE model = ? ORDER BY position').all(model) as OrderRow[]
}

export function routeRoundRobin(model: string): boolean {
  const row = db.prepare('SELECT round_robin FROM model_route_settings WHERE model = ?').get(model) as { round_robin: number } | undefined
  return row?.round_robin === 1
}

/** 这个模型有没有存过顺序：没存过 = 控制台不介入，网关自己在同名来源之间选（升级前的行为）。 */
export const hasSavedRoute = (model: string) => Boolean(db.prepare('SELECT 1 FROM model_route_order WHERE model = ? LIMIT 1').get(model))

/** 订阅账号的 CPA prefix：每个账号文件一个，固定、可逆；带短哈希避免文件名只差符号时撞名。 */
export const accountPrefix = (file: string) =>
  `rt-a-${file.toLowerCase().replace(/\.json$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'x'}-${createHash('sha1').update(file).digest('hex').slice(0, 4)}`

/**
 * 路由的最小单位：一个兼容渠道，或账号池里的一个账号（同一渠道里的不同账号各算一个来源）。
 * 同渠道里的多把上游 Key 不拆：CPA 的 prefix 只能定到渠道，Key 仍在渠道内部轮询。
 */
export type RouteUnit = { kind: 'compat' | 'account'; id: string; channel: string; label: string; enabled: boolean; weight: number }

const unitKey = (unit: { kind: string; id: string }) => `${unit.kind}:${unit.id}`

function baseUnits(entry: ModelEntry, credentials: CredentialSummary[]): RouteUnit[] {
  const units: RouteUnit[] = []
  for (const source of entry.sources) {
    if (source.kind === 'compat') {
      units.push({ kind: 'compat', id: source.channel, channel: source.channel, label: source.channel, enabled: source.enabled && source.channelEnabled, weight: 0 })
      continue
    }
    for (const credential of credentials.filter((item) => item.type === source.channel)) {
      units.push({ kind: 'account', id: credential.name, channel: source.channel, label: credential.label || credential.name, enabled: source.enabled && source.channelEnabled && !credential.disabled, weight: 0 })
    }
  }
  return units
}

/** 已存顺序套到单位上：存过的在前（按 weight、再按拖拽位置），没存过的（后来新增的来源）排在最后一档。旧版按整个账号池存的行，展开成池里每个账号。 */
export function orderUnits(model: string, units: RouteUnit[]): RouteUnit[] {
  const rows = savedOrder(model)
  const saved = new Map(rows.map((row) => [`${row.kind}:${row.source}`, row]))
  const lookup = (unit: RouteUnit) => saved.get(unitKey(unit)) ?? (unit.kind === 'account' ? saved.get(`oauth:${unit.channel}`) : undefined)
  const lastTier = rows.length ? Math.max(...rows.map((row) => row.weight)) + 1 : 0
  return units
    .map((unit) => ({ ...unit, weight: lookup(unit)?.weight ?? lastTier }))
    .sort((a, b) => {
      const left = lookup(a)
      const right = lookup(b)
      if (left && right) return (a.weight - b.weight) || (left.position - right.position)
      if (left) return -1
      if (right) return 1
      return a.channel.localeCompare(b.channel) || a.label.localeCompare(b.label)
    })
}

/** 给模型目录补上路由字段：来源单位的顺序与权重、同档轮询开关、有没有存过顺序；「多渠道」按启用的单位数算。 */
export function applyRoutes(models: ModelEntry[], credentials: CredentialSummary[] = []): ModelEntry[] {
  const rr = new Set((db.prepare('SELECT model FROM model_route_settings WHERE round_robin = 1').all() as Array<{ model: string }>).map((row) => row.model))
  const routed = new Set((db.prepare('SELECT DISTINCT model FROM model_route_order').all() as Array<{ model: string }>).map((row) => row.model))
  return models.map((entry) => {
    const units = orderUnits(entry.id, baseUnits(entry, credentials))
    return { ...entry, units, contested: units.filter((unit) => unit.enabled).length > 1, roundRobin: rr.has(entry.id), routed: routed.has(entry.id) }
  })
}

export function saveRoute(model: string, items: RouteItem[], roundRobin?: boolean) {
  const seen = new Set<string>()
  for (const item of items) {
    if (!item.channel || (item.kind !== 'compat' && item.kind !== 'account')) throw new Error('来源格式不对')
    const key = `${item.kind}:${item.channel}`
    if (seen.has(key)) throw new Error(`来源重复：${item.channel}`)
    seen.add(key)
    if (!Number.isInteger(item.weight) || Math.abs(item.weight) > MAX_ROUTE_WEIGHT) throw new Error(`权重必须是 -${MAX_ROUTE_WEIGHT} 到 ${MAX_ROUTE_WEIGHT} 的整数`)
  }
  transaction(() => {
    db.prepare('DELETE FROM model_route_order WHERE model = ?').run(model)
    const insert = db.prepare('INSERT INTO model_route_order (model, source, kind, position, weight) VALUES (?, ?, ?, ?, ?)')
    items.forEach((item, position) => insert.run(model, item.channel, item.kind, position, item.weight))
    if (roundRobin !== undefined) {
      db.prepare('INSERT INTO model_route_settings (model, round_robin) VALUES (?, ?) ON CONFLICT(model) DO UPDATE SET round_robin = excluded.round_robin').run(model, roundRobin ? 1 : 0)
    }
  })
}

export function saveRoundRobin(model: string, roundRobin: boolean) {
  db.prepare('INSERT INTO model_route_settings (model, round_robin) VALUES (?, ?) ON CONFLICT(model) DO UPDATE SET round_robin = excluded.round_robin').run(model, roundRobin ? 1 : 0)
}

/** channel = 兼容渠道名，或账号所属的账号池（provider）：中转层按它判断这把 Key 能不能用这个来源。 */
export type PublishedRoute = { model: string; weight: number; prefix: string; channel: string; roundRobin: boolean }

/** 整表替换发给中转层的路由。 */
export function publishRoutes(routes: PublishedRoute[]) {
  transaction(() => {
    db.prepare('DELETE FROM relay_routes').run()
    const insert = db.prepare('INSERT INTO relay_routes (model, rank, weight, prefix, channel, round_robin) VALUES (?, ?, ?, ?, ?, ?)')
    const rank = new Map<string, number>()
    for (const route of routes) {
      const next = rank.get(route.model) ?? 0
      rank.set(route.model, next + 1)
      insert.run(route.model, next, route.weight, route.prefix, route.channel, route.roundRobin ? 1 : 0)
    }
  })
}

/** 整表替换每个模型的来源渠道（按来源顺序、去重）；内容没变不写——每个对账周期都会调用。 */
export function publishModelChannels(rows: Array<{ model: string; channels: string[] }>) {
  const next = rows.flatMap((row) => row.channels.map((channel, rank) => ({ model: row.model, rank, channel })))
    .sort((a, b) => a.model.localeCompare(b.model) || a.rank - b.rank)
  const current = db.prepare('SELECT model, rank, channel FROM relay_model_channels ORDER BY model, rank').all() as Array<{ model: string; rank: number; channel: string }>
  const same = current.length === next.length && current.every((row, index) => row.model === next[index].model && row.rank === next[index].rank && row.channel === next[index].channel)
  if (same) return
  transaction(() => {
    db.prepare('DELETE FROM relay_model_channels').run()
    const insert = db.prepare('INSERT INTO relay_model_channels (model, rank, channel) VALUES (?, ?, ?)')
    for (const row of next) insert.run(row.model, row.rank, row.channel)
  })
}

/** 当前已发布的「模型 → 带前缀的名字」，用来把它们放进 Key 的模型白名单。 */
export function publishedRouteNames(): Map<string, string[]> {
  const out = new Map<string, string[]>()
  try {
    for (const row of db.prepare('SELECT model, prefix FROM relay_routes ORDER BY model, rank').all() as Array<{ model: string; prefix: string }>) {
      const list = out.get(row.model) || []
      list.push(`${row.prefix}/${row.model}`)
      out.set(row.model, list)
    }
  } catch { /* 表还没建 = 没有路由 */ }
  return out
}
