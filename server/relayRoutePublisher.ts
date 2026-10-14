import { CompatChannelsConflictError, compatChannelsFingerprint, getCompatChannels, putCompatChannels, setAuthFilePrefix } from './cpa.js'
import { db } from './db.js'
import { listModelIndex } from './channels.js'
import { accountPrefix, publishRoutes, routePrefix, type PublishedRoute } from './modelRoutes.js'

/**
 * 把控制台里的模型路由发布给中转层：只发布「有 2 个以上启用来源、且每个来源都能用 prefix 定向」的模型，
 * 并确保这些来源在 CPA 里带着约定的 prefix（兼容渠道 = 条目 prefix，账号池 = 每个账号文件的 prefix）。
 * 其余模型不碰，仍走网关自己的选择。
 */
const APPLIED_KEY = 'route_prefix_applied'

function appliedPrefixes(): Record<string, string> {
  try {
    const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(APPLIED_KEY) as { value: string } | undefined
    return row ? JSON.parse(row.value) as Record<string, string> : {}
  } catch { return {} }
}

const saveApplied = (applied: Record<string, string>) =>
  db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(APPLIED_KEY, JSON.stringify(applied))

let chain: Promise<unknown> = Promise.resolve()

export function publishRelayRoutes(): Promise<void> {
  const next = chain.then(publishOnce)
  chain = next.catch(() => undefined)
  return next
}

async function publishOnce() {
  const { models, channels } = await listModelIndex()
  const compat = new Set(channels.filter((channel) => !channel.stale && channel.enabled && (!channel.cpaChannel || channel.cpaChannel === channel.name) && channel.protocol !== 'claude').map((channel) => channel.name))
  const routes: PublishedRoute[] = []
  const needCompat = new Set<string>()
  const needAccounts = new Set<string>()
  for (const model of models) {
    const active = (model.units ?? []).filter((unit) => unit.enabled)
    if (active.length < 2 || !model.routed) continue
    if (!active.every((unit) => unit.kind === 'account' || compat.has(unit.id))) continue
    for (const unit of active) {
      routes.push({ model: model.id, weight: unit.weight, prefix: unit.kind === 'account' ? accountPrefix(unit.id) : routePrefix(unit.id), channel: unit.channel, roundRobin: Boolean(model.roundRobin) })
      if (unit.kind === 'account') needAccounts.add(unit.id)
      else needCompat.add(unit.id)
    }
  }

  if (needCompat.size) {
    const live = await getCompatChannels()
    const expected = compatChannelsFingerprint(live)
    let changed = false
    const next = live.map((entry) => {
      const name = String(entry.name || '')
      if (!needCompat.has(name) || entry.prefix === routePrefix(name)) return entry
      changed = true
      return { ...entry, prefix: routePrefix(name) }
    })
    if (changed) {
      try { await putCompatChannels(next, { expected }) } catch (error) {
        if (error instanceof CompatChannelsConflictError) return
        throw error
      }
    }
  }

  if (needAccounts.size) {
    const applied = appliedPrefixes()
    let dirty = false
    for (const file of needAccounts) {
      const prefix = accountPrefix(file)
      if (applied[file] === prefix) continue
      await setAuthFilePrefix(file, prefix)
      applied[file] = prefix
      dirty = true
    }
    if (dirty) saveApplied(applied)
  }

  publishRoutes(routes)
}
