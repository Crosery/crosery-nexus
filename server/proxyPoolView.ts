/**
 * Allow-list projections: the only shapes of pool data that leave the server (PROXY-SPEC §13).
 * Every field is picked by name; `url`, `node`, subscription addresses, link `prev` and the listener credential
 * never appear. Hosts and ports do (the admin page shows them); audit rows and logs carry neither.
 */

import { maskProxyUserinfo } from './accountProjection.js'
import { maskSubscriptionUrl } from './proxyParseSubscription.js'
import { maskNode } from './proxyParseClash.js'
import { entryScope, isManagedPort, proxySettings, scrubProxySecrets, type HealthRecord, type PoolFile, type ProxyEntry, type ProxyScope, type ProxySubscription } from './proxyPoolStore.js'
import type { ProxyKernelView } from './proxyPoolHooks.js'

export type UsedBy = { total: number; byProvider: Record<string, number> }

export type EntryView = {
  id: string
  name: string
  nameAuto: boolean
  kind: ProxyEntry['kind']
  protocol: ProxyEntry['protocol']
  /** `socks5://***@host:port` for url entries, `vmess://host:port` for nodes */
  display: string
  server: string
  serverPort: number
  port: number | null
  scope: ProxyScope
  assignable: boolean
  unassignableReason: string | null
  source: ProxyEntry['source']
  subscriptionId: string | null
  stale: boolean
  external: boolean
  tags: string[]
  enabled: boolean
  validity: ProxyEntry['validity']
  invalidReason: string | null
  usedBy: UsedBy
  health: HealthRecord | null
  createdAt: string
  updatedAt: string
}

export type AssignContext = { cpaSameHost: boolean; kernel: ProxyKernelView; backend: 'cpa' | 'magpie' }

export function usageByEntry(pool: PoolFile): Map<string, UsedBy> {
  const out = new Map<string, UsedBy>()
  for (const link of Object.values(pool.links)) {
    const used = out.get(link.entryId) ?? { total: 0, byProvider: {} }
    used.total++
    const provider = link.provider || 'other'
    used.byProvider[provider] = (used.byProvider[provider] ?? 0) + 1
    out.set(link.entryId, used)
  }
  return out
}

/** Whether an entry can be written into accounts here, and why not. */
export function assignability(entry: ProxyEntry, context: AssignContext): { assignable: boolean; reason: string | null } {
  if (!entry.enabled) return { assignable: false, reason: '已停用' }
  if (entry.validity === 'invalid') return { assignable: false, reason: '配置无效' }
  if (entry.kind === 'mihomo') {
    if (context.kernel.state === 'unavailable') return { assignable: false, reason: '内核未安装' }
    if (!context.cpaSameHost) return { assignable: false, reason: 'CPA 不在本机，本机端口对它不可用' }
    if (context.kernel.bindFailed?.includes(entry.id)) return { assignable: false, reason: '本机端口被占用' }
  }
  return { assignable: true, reason: null }
}

const safeHealth = (record: HealthRecord | undefined): HealthRecord | null => {
  if (!record || typeof record !== 'object') return null
  // health.json holds no secrets, but it is a file other modules write: pass known fields only
  const rawExit = record.exit as (HealthRecord['exit'] & { state?: unknown; ms?: unknown }) | null | undefined
  const exit = rawExit && typeof rawExit === 'object'
    ? {
        ...(typeof rawExit.ip === 'string' ? { ip: rawExit.ip.slice(0, 64) } : {}),
        ...(typeof rawExit.country === 'string' ? { country: rawExit.country.slice(0, 8) } : {}),
        ...(typeof rawExit.state === 'string' ? { state: rawExit.state.slice(0, 32) } : {}),
        ...(typeof rawExit.ms === 'number' ? { ms: rawExit.ms } : {}),
        at: String(rawExit.at ?? ''),
      }
    : null
  const services: HealthRecord['services'] = {}
  for (const [service, cell] of Object.entries(record.services ?? {})) {
    if (!cell || typeof cell !== 'object' || !/^[a-z0-9-]{1,24}$/.test(service)) continue
    services[service] = {
      state: String(cell.state ?? '').slice(0, 32),
      ms: typeof cell.ms === 'number' ? cell.ms : null,
      at: String(cell.at ?? ''),
      hosts: Array.isArray(cell.hosts) ? cell.hosts.slice(0, 8).map(host => ({
        host: String(host?.host ?? '').slice(0, 128),
        state: String(host?.state ?? '').slice(0, 32),
        ms: typeof host?.ms === 'number' ? host.ms : null,
        status: typeof host?.status === 'number' ? host.status : null,
      })) : [],
    }
  }
  return { exit, services, ...(typeof record.lastAt === 'string' ? { lastAt: record.lastAt } : {}) }
}

export function entryDisplay(entry: ProxyEntry): string {
  if (entry.kind === 'url') return maskProxyUserinfo(entry.url ?? '')
  const host = entry.server.includes(':') ? `[${entry.server}]` : entry.server
  return `${entry.protocol}://${host}:${entry.serverPort}`
}

export function entryView(entry: ProxyEntry, used: UsedBy | undefined, health: HealthRecord | undefined, context: AssignContext): EntryView {
  const { assignable, reason } = assignability(entry, context)
  return {
    id: entry.id,
    name: entry.name,
    nameAuto: entry.nameAuto,
    kind: entry.kind,
    protocol: entry.protocol,
    display: entryDisplay(entry),
    server: entry.server,
    serverPort: entry.serverPort,
    port: entry.kind === 'mihomo' && entry.port ? entry.port : null,
    scope: entryScope(entry),
    assignable,
    unassignableReason: reason,
    source: entry.source,
    subscriptionId: entry.subscriptionId ?? null,
    stale: entry.staleInSubscription === true,
    external: entry.external === true,
    tags: [...entry.tags],
    enabled: entry.enabled,
    validity: entry.validity,
    invalidReason: entry.invalidReason ?? null,
    usedBy: used ?? { total: 0, byProvider: {} },
    health: safeHealth(health),
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  }
}

export type SubscriptionView = {
  id: string
  name: string
  maskedUrl: string
  intervalH: number
  lastFetchAt: string | null
  nextAt: string | null
  failures: number
  error: string | null
  info: ProxySubscription['info'] | null
  nodeCount: number
}

export function subscriptionView(subscription: ProxySubscription): SubscriptionView {
  return {
    id: subscription.id,
    name: subscription.name,
    maskedUrl: maskSubscriptionUrl(subscription.url),
    intervalH: subscription.intervalH,
    lastFetchAt: subscription.lastFetchAt,
    nextAt: subscription.nextAt,
    failures: subscription.failures,
    error: subscription.error ?? null,
    info: subscription.info ?? null,
    nodeCount: subscription.nodeCount,
  }
}

/** The masked export (`GET /export`): secrets replaced by `***`, so only secret-free entries can be re-imported. */
export function maskedExport(pool: PoolFile, now = new Date().toISOString()) {
  return {
    format: 'crosery-proxy-pool' as const,
    version: 1 as const,
    exportedAt: now,
    masked: true,
    entries: pool.entries.map((entry, index) => ({
      ref: `e${index + 1}`,
      name: entry.name,
      kind: entry.kind,
      protocol: entry.protocol,
      ...(entry.kind === 'url' ? { url: maskProxyUserinfo(entry.url ?? '') } : { node: maskNode(entry.node ?? {}) }),
      tags: [...entry.tags],
      enabled: entry.enabled,
      source: entry.source,
    })),
    subscriptions: pool.subscriptions.map(subscription => ({ name: subscription.name, url: maskSubscriptionUrl(subscription.url), intervalH: subscription.intervalH })),
  }
}

/** The full export (`POST /export {withSecrets}`): CLI-only, audited, written 0600 by the CLI. */
export function secretExport(pool: PoolFile, now = new Date().toISOString()) {
  const refs = new Map(pool.entries.map((entry, index) => [entry.id, `e${index + 1}`]))
  const assignments: Array<{ entryRef: string; account: { backend: string; provider: string; identity: string } }> = []
  for (const [ref, link] of Object.entries(pool.links)) {
    const entryRef = refs.get(link.entryId)
    if (!entryRef) continue
    if (ref.startsWith('cpa:') && !/^cpa:(global|channel:|key:)/.test(ref)) {
      assignments.push({ entryRef, account: { backend: 'cpa', provider: link.provider ?? '', identity: ref.slice(4) } })
    } else if (/^magpie:[^:]+:/.test(ref)) {
      const [, agent, ...user] = ref.split(':')
      assignments.push({ entryRef, account: { backend: 'magpie', provider: agent, identity: user.join(':') } })
    }
  }
  return {
    format: 'crosery-proxy-pool' as const,
    version: 1 as const,
    exportedAt: now,
    masked: false,
    entries: pool.entries.map(entry => ({
      ref: refs.get(entry.id),
      name: entry.name,
      kind: entry.kind,
      protocol: entry.protocol,
      ...(entry.kind === 'url' ? { url: entry.url } : { node: entry.node }),
      tags: [...entry.tags],
      enabled: entry.enabled,
      source: entry.source,
    })),
    subscriptions: pool.subscriptions.map(subscription => ({ name: subscription.name, url: subscription.url, intervalH: subscription.intervalH })),
    assignments,
  }
}

/**
 * The kernel module's status, by allow-list: primitives and arrays/maps of primitives only, strings capped; `reason`
 * is scrubbed again (it is the one free-text field).
 */
export function projectKernelView(view: ProxyKernelView, pool?: PoolFile): ProxyKernelView {
  const primitive = (value: unknown): unknown => {
    if (typeof value === 'string') return value.slice(0, 200)
    if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value
    return undefined
  }
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(view ?? {})) {
    if (!/^[A-Za-z][A-Za-z0-9]{0,31}$/.test(key)) continue
    if (Array.isArray(value)) out[key] = value.slice(0, 2000).map(primitive).filter(item => item !== undefined)
    else if (value && typeof value === 'object') {
      out[key] = Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 2000).map(([inner, item]) => [inner.slice(0, 64), primitive(item)]).filter(([, item]) => item !== undefined))
    } else {
      const item = primitive(value)
      if (item !== undefined) out[key] = item
    }
  }
  if (typeof out.reason === 'string') out.reason = scrubProxySecrets(out.reason, pool)
  return { ...out, state: typeof view?.state === 'string' ? view.state : 'unavailable' } as ProxyKernelView
}

/** Mask an account's proxy value for display. */
export const maskAccountProxy = (value: string) => maskProxyUserinfo(value)

export const managedRange = () => {
  const settings = proxySettings()
  return { base: settings.portBase, count: settings.portCount, last: settings.portBase + settings.portCount - 1, listenerAuth: settings.listenerAuth }
}

export { isManagedPort }
