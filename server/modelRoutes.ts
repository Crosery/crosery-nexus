import { db, transaction } from './db.js'
import type { ModelEntry, ModelSource } from './modelIndex.js'

/**
 * 模型级路由：每个模型自己的来源顺序与权重，存在控制台；中转层按它把请求定向到具体来源（CPA 的 `prefix`），
 * CPA 只负责转发。没存过顺序的模型：来源按渠道名排，权重全 0，不轮询。
 */
export type RouteSourceKind = 'compat' | 'oauth'
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

/** 已存顺序套到来源上：存过的在前（按 weight、再按拖拽位置），没存过的（后来新增的来源）排在最后一档。 */
export function orderSources(model: string, sources: ModelSource[]): ModelSource[] {
  const rows = savedOrder(model)
  const saved = new Map(rows.map((row) => [`${row.kind}:${row.source}`, row]))
  const key = (source: ModelSource) => `${source.kind}:${source.channel}`
  const lastTier = rows.length ? Math.max(...rows.map((row) => row.weight)) + 1 : 0
  return [...sources]
    .map((source) => ({ ...source, weight: saved.get(key(source))?.weight ?? lastTier }))
    .sort((a, b) => {
      const left = saved.get(key(a))
      const right = saved.get(key(b))
      if (left && right) return (a.weight - b.weight) || (left.position - right.position)
      if (left) return -1
      if (right) return 1
      return a.channel.localeCompare(b.channel)
    })
}

/** 给模型目录补上路由字段：来源顺序、每个来源的权重、同档轮询开关。 */
export function applyRoutes(models: ModelEntry[]): ModelEntry[] {
  const rr = new Set((db.prepare('SELECT model FROM model_route_settings WHERE round_robin = 1').all() as Array<{ model: string }>).map((row) => row.model))
  const routed = new Set((db.prepare('SELECT DISTINCT model FROM model_route_order').all() as Array<{ model: string }>).map((row) => row.model))
  return models.map((entry) => ({ ...entry, sources: orderSources(entry.id, entry.sources), roundRobin: rr.has(entry.id), routed: routed.has(entry.id) }))
}

export function saveRoute(model: string, items: RouteItem[], roundRobin?: boolean) {
  const seen = new Set<string>()
  for (const item of items) {
    if (!item.channel || (item.kind !== 'compat' && item.kind !== 'oauth')) throw new Error('来源格式不对')
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

export type PublishedRoute = { model: string; weight: number; prefix: string; roundRobin: boolean }

/** 整表替换发给中转层的路由。 */
export function publishRoutes(routes: PublishedRoute[]) {
  transaction(() => {
    db.prepare('DELETE FROM relay_routes').run()
    const insert = db.prepare('INSERT INTO relay_routes (model, rank, weight, prefix, round_robin) VALUES (?, ?, ?, ?, ?)')
    const rank = new Map<string, number>()
    for (const route of routes) {
      const next = rank.get(route.model) ?? 0
      rank.set(route.model, next + 1)
      insert.run(route.model, next, route.weight, route.prefix, route.roundRobin ? 1 : 0)
    }
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
