/**
 * Account egress (PROXY-SPEC §7, §12 "Accounts page"): what the /accounts page needs to show and change each
 * account's exit — the pickable pool entries with their exit country and per-service reachability, every
 * account's current exit as the pool knows it, and what a sign-in itself goes through.
 *
 * `GET /api/proxies/egress` reads local state only (pool.json, health.json, the Magpie registry); it never calls
 * CPA, a vendor or an exit. The authoritative per-account read (`GET /api/proxies/egress/account`) asks the
 * control plane for one account (CPA management API, not a vendor), coalesced per account, and keeps the pool's
 * index in step. Every value that leaves is masked: no URL credential, no listener credential.
 */

import { maskProxyUserinfo } from './accountProjection.js'
import type { AccountProxySection, AccountProxySupport } from './magpieAccountProxies.js'
import { assignability, type AssignContext, type UsedBy } from './proxyPoolView.js'
import { matchEntryForUrl, proxyMode, type HealthRecord, type PoolFile, type ProxyEntry } from './proxyPoolStore.js'

export type EgressService = 'claude' | 'openai' | 'google'

/** account provider / agent → the probe service that tells whether its exit reaches the vendor */
const SERVICE_OF: Record<string, EgressService> = {
  claude: 'claude', anthropic: 'claude',
  codex: 'openai', openai: 'openai', chatgpt: 'openai',
  antigravity: 'google', gemini: 'google', 'gemini-cli': 'google', google: 'google', vertex: 'google', aistudio: 'google',
}
export const serviceOf = (provider: string | null | undefined): EgressService | null => SERVICE_OF[String(provider ?? '').toLowerCase()] ?? null

export type EgressCheck = { state: string; ms: number | null; at: string | null }

export type EgressEntry = {
  id: string
  name: string
  kind: ProxyEntry['kind']
  protocol: ProxyEntry['protocol']
  country: string | null
  /** the exit probe's own failure (proxy down, auth failed…), null when it answered or was never run */
  exitState: string | null
  checks: Partial<Record<EgressService, EgressCheck>>
  checkedAt: string | null
  assignable: boolean
  reason: string | null
  usedBy: number
}

export type EgressMode = 'inherit' | 'direct' | 'url' | 'invalid' | 'unknown'
export type EgressAccount = { mode: EgressMode; entryId: string | null; masked: string | null; at: string | null }

const SERVICES: EgressService[] = ['claude', 'openai', 'google']

export function egressEntry(entry: ProxyEntry, health: HealthRecord | undefined, used: UsedBy | undefined, context: AssignContext): EgressEntry {
  const { assignable, reason } = assignability(entry, context)
  const checks: EgressEntry['checks'] = {}
  for (const service of SERVICES) {
    const cell = health?.services?.[service]
    if (cell && typeof cell.state === 'string' && cell.state) {
      checks[service] = { state: cell.state.slice(0, 32), ms: typeof cell.ms === 'number' ? cell.ms : null, at: typeof cell.at === 'string' ? cell.at : null }
    }
  }
  const exit = health?.exit
  const exitState = exit && typeof exit.state === 'string' && !['ok', 'auth-expected'].includes(exit.state) ? exit.state.slice(0, 32) : null
  const times = [health?.lastAt, exit?.at, ...Object.values(checks).map(check => check?.at)].filter((at): at is string => typeof at === 'string' && Boolean(at))
  return {
    id: entry.id,
    name: entry.name,
    kind: entry.kind,
    protocol: entry.protocol,
    country: typeof exit?.country === 'string' && exit.country ? exit.country.slice(0, 8) : null,
    exitState,
    checks,
    checkedAt: health?.lastAt ?? times.sort().at(-1) ?? null,
    assignable,
    reason,
    usedBy: used?.total ?? 0,
  }
}

const isAccountRef = (ref: string) => /^cpa:(?!global$|channel:|key:)/.test(ref) || /^magpie:[^:]+:./.test(ref)

/** CPA accounts as the pool last saw them (the list API carries no proxy_url; a per-account read refreshes one). */
export function poolAccounts(pool: PoolFile): Record<string, EgressAccount> {
  const out: Record<string, EgressAccount> = {}
  for (const [ref, seen] of Object.entries(pool.observed)) {
    if (!isAccountRef(ref) || !ref.startsWith('cpa:')) continue
    out[ref] = { mode: seen.mode, entryId: pool.links[ref]?.entryId ?? null, masked: seen.mode === 'url' ? seen.masked ?? null : null, at: seen.at ?? null }
  }
  return out
}

/** Magpie kernel accounts from the registry (live: the registry is the source of truth, links derive from it). */
export function registryAccounts(pool: PoolFile, section: AccountProxySection): Record<string, EgressAccount> {
  const out: Record<string, EgressAccount> = {}
  for (const [agent, entry] of Object.entries(section)) {
    for (const [user, url] of Object.entries(entry.accountProxies ?? {})) out[`magpie:${agent}:${user}`] = accountValue(pool, url, null)
  }
  return out
}

/** One stored value → the masked view, linked to the pool entry it points at. */
export function accountValue(pool: PoolFile, raw: string, at: string | null): EgressAccount {
  const value = String(raw ?? '').trim()
  const mode = proxyMode(value)
  const entry = mode === 'url' ? matchEntryForUrl(pool, value) : null
  return { mode, entryId: entry?.id ?? null, masked: mode === 'url' ? maskProxyUserinfo(value) : null, at }
}

/** Index of the configured preset with exactly this value (the picker shows presets that are not pool entries). */
export function presetIndex(presets: Array<{ url: string }>, raw: string): number | null {
  const value = String(raw ?? '').trim()
  if (!value) return null
  const index = presets.findIndex(preset => preset.url.trim() === value)
  return index === -1 ? null : index
}

export type SigninEgress = {
  /** what the sign-in's own token exchange goes through */
  via: 'cpa-global' | 'direct'
  exit: { mode: EgressMode | 'unsupported'; entryId: string | null }
  /** whether a sign-in can be sent through a chosen exit (no backend can today) */
  perSignin: false
  note: string
}

export type EgressViewInput = {
  pool: PoolFile
  health: Record<string, HealthRecord>
  used: Map<string, UsedBy>
  context: AssignContext
  presets: Array<{ label: string; url: string }>
  magpie: AccountProxySection | null
  support: AccountProxySupport
}

/** The page read model (GET /api/proxies/egress). Pure; the caller supplies local state only. */
export function egressView(input: EgressViewInput) {
  const { pool, context } = input
  const entries = pool.entries.filter(entry => entry.enabled).map(entry => egressEntry(entry, input.health[entry.id], input.used.get(entry.id), context))
  const accounts = { ...poolAccounts(pool), ...(input.magpie ? registryAccounts(pool, input.magpie) : {}) }
  const global = pool.observed['cpa:global']
  const defaultExit = context.backend === 'cpa'
    ? { mode: (global?.mode ?? 'unknown') as EgressMode, entryId: pool.links['cpa:global']?.entryId ?? null }
    : { mode: 'direct' as EgressMode, entryId: null }
  // a Magpie account with no exit of its own follows its service's `proxy`, else the kernel's (never set here: direct)
  const services: Record<string, EgressAccount> = {}
  for (const [agent, entry] of Object.entries(input.magpie ?? {})) if (entry.proxy) services[agent] = accountValue(pool, entry.proxy, null)
  const signin: SigninEgress = context.backend === 'cpa'
    ? { via: 'cpa-global', exit: defaultExit, perSignin: false, note: '登录由 CPA 完成，走 CPA 的全局代理，不能为一次登录单独指定出口' }
    : { via: 'direct', exit: { mode: 'direct', entryId: null }, perSignin: false, note: '登录由本机内核完成，不经过代理，不能为一次登录单独指定出口' }
  return {
    backend: context.backend,
    cpaSameHost: context.cpaSameHost,
    kernel: { state: context.kernel.state },
    accountProxy: input.support,
    default: defaultExit,
    services,
    signin,
    entries,
    accounts,
    presets: input.presets.map(preset => ({ label: preset.label, entryId: matchEntryForUrl(pool, preset.url)?.id ?? null })),
  }
}

export type EgressView = ReturnType<typeof egressView>
