/**
 * Per-account exits of the Magpie kernel's subscription accounts (ACCOUNTS-ALIGN §2.6, PROXY-SPEC §7).
 *
 * Stored in the optional `accounts` section of MAGPIE_CHANNELS_FILE — `{<agent>: {proxy?, accountProxies?:
 * {<user lower>: url}}}` — next to `channels`; both writers keep the other's part. The kernel gets them as
 * endpoint-less "pick" providers (`{id: <agent>, accountProxies}`) appended to every `PUT /internal/providers`;
 * the pinned `provider.All()` / `storedPicks()` merge a pick into the account provider with the same id, and
 * `ViaLogin(ctx, agent, user)` then names that account's exit on its own requests.
 *
 * Whether those requests honour it is the kernel's capability `account-proxy` (the console kernel routes
 * `http.DefaultClient` by the request's chosen proxy only from that build on). Without it nothing is written:
 * an exit that is stored but not used would tell the admin an account is behind an IP it is not.
 */

import fs from 'node:fs'
import path from 'node:path'
import { config } from './config.js'
import { KernelProbeCache, kernelCaller, type KernelCall } from './magpieKernel.js'

export const ACCOUNT_PROXY_CAPABILITY = 'account-proxy'
const AGENT = /^[a-z0-9][a-z0-9_.-]{0,63}$/
const MAX_REGISTRY_BYTES = 4 * 1024 * 1024

export type AccountProxySection = Record<string, { proxy?: string; accountProxies?: Record<string, string> }>
export type AccountProxySupport = { supported: boolean; reason: string | null }

/** How the kernel keys an account in `accountProxies` (provider/proxy.go accountKey). */
export const accountKey = (user: string) => String(user ?? '').trim().toLowerCase()

/** `magpie:<agent>:<user lower>`: the pool's account ref for a kernel account. */
export const magpieAccountRef = (agent: string, user: string) => `magpie:${agent}:${accountKey(user)}`

export function parseMagpieAccountRef(ref: string): { agent: string; user: string } | null {
  const match = /^magpie:([^:]+):(.+)$/.exec(ref)
  if (!match || !AGENT.test(match[1])) return null
  const user = accountKey(match[2])
  // eslint-disable-next-line no-control-regex
  if (!user || user.length > 256 || /[\u0000-\u001f]/.test(user)) return null
  return { agent: match[1], user }
}

/** What the kernel accepts (settings.CheckProxy): '' (follow), `direct`, or an http(s) / socks5(h) URL with a host. */
export function validAccountProxy(url: string): boolean {
  const value = url.trim()
  if (value === '' || value === 'direct') return true
  try {
    const parsed = new URL(value)
    return ['http:', 'https:', 'socks5:', 'socks5h:'].includes(parsed.protocol) && Boolean(parsed.hostname) && !/\s/.test(value)
  } catch {
    return false
  }
}

function readRegistry(file: string): Record<string, unknown> | null {
  if (!fs.existsSync(file)) return null
  const stat = fs.lstatSync(file)
  if (!stat.isFile() || stat.size > MAX_REGISTRY_BYTES) throw new Error('Invalid Magpie channel registry')
  const state = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
  if (!state || typeof state !== 'object' || Array.isArray(state) || state.version !== 1) throw new Error('Unsupported Magpie channel registry version')
  return state
}

/** The raw `accounts` section, for the channel writer to carry over (undefined when absent or not an object). */
export function registryAccountsSection(file = config.magpieChannelsFile): Record<string, unknown> | undefined {
  try {
    const section = readRegistry(file)?.accounts
    return section && typeof section === 'object' && !Array.isArray(section) ? section as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

/** The validated section: agents and users that pass the id rules, string values only. Never throws. */
export function readAccountProxySection(file = config.magpieChannelsFile): AccountProxySection {
  const raw = registryAccountsSection(file)
  const out: AccountProxySection = {}
  for (const [agent, value] of Object.entries(raw ?? {})) {
    if (!AGENT.test(agent) || !value || typeof value !== 'object') continue
    const section = value as { proxy?: unknown; accountProxies?: unknown }
    const entry: AccountProxySection[string] = {}
    if (typeof section.proxy === 'string' && section.proxy.trim()) entry.proxy = section.proxy.trim()
    if (section.accountProxies && typeof section.accountProxies === 'object' && !Array.isArray(section.accountProxies)) {
      const proxies: Record<string, string> = {}
      for (const [user, url] of Object.entries(section.accountProxies as Record<string, unknown>)) {
        const key = accountKey(user)
        if (key && key.length <= 256 && typeof url === 'string' && url.trim()) proxies[key] = url.trim()
      }
      if (Object.keys(proxies).length) entry.accountProxies = proxies
    }
    if (entry.proxy || entry.accountProxies) out[agent] = entry
  }
  return out
}

/** The account's own exit; '' when it follows its service / the global one. */
export function readAccountProxy(agent: string, user: string, file = config.magpieChannelsFile): string {
  return readAccountProxySection(file)[agent]?.accountProxies?.[accountKey(user)] ?? ''
}

/**
 * Set (or with '' clear) one account's exit: read-modify-write of the whole registry, every other key kept,
 * written 0600 through tmp + rename like `writeChannels`. Synchronous, so it cannot interleave with that writer.
 */
export function writeAccountProxy(agent: string, user: string, url: string, file = config.magpieChannelsFile): { prev: string; changed: boolean } {
  if (!AGENT.test(agent)) throw new Error('invalid agent')
  const key = accountKey(user)
  if (!key || key.length > 256) throw new Error('invalid account')
  const value = url.trim()
  if (!validAccountProxy(value)) throw new Error('invalid proxy')
  const state = readRegistry(file) ?? { version: 1, channels: [] }
  const accounts = state.accounts && typeof state.accounts === 'object' && !Array.isArray(state.accounts) ? { ...(state.accounts as Record<string, unknown>) } : {}
  const current = accounts[agent] && typeof accounts[agent] === 'object' && !Array.isArray(accounts[agent]) ? { ...(accounts[agent] as Record<string, unknown>) } : {}
  const proxies = current.accountProxies && typeof current.accountProxies === 'object' && !Array.isArray(current.accountProxies)
    ? { ...(current.accountProxies as Record<string, unknown>) }
    : {}
  const prev = typeof proxies[key] === 'string' ? (proxies[key] as string).trim() : ''
  if (prev === value) return { prev, changed: false }
  if (value) proxies[key] = value
  else delete proxies[key]
  if (Object.keys(proxies).length) current.accountProxies = proxies
  else delete current.accountProxies
  if (Object.keys(current).length) accounts[agent] = current
  else delete accounts[agent]
  const next: Record<string, unknown> = { ...state }
  if (Object.keys(accounts).length) next.accounts = accounts
  else delete next.accounts
  const temporary = `${file}.${process.pid}.acc.tmp`
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    fs.renameSync(temporary, file)
  } catch (error) {
    fs.rmSync(temporary, { force: true })
    throw error
  }
  return { prev, changed: true }
}

/**
 * The pick providers for `PUT /internal/providers`: one endpoint-less entry per agent with exits. An agent's own
 * `proxy` (written by Magpie-native tooling, not this console) rides along so a push never drops it.
 */
export function accountPicks(file = config.magpieChannelsFile): Array<{ id: string; name: string; key: string; proxy?: string; accountProxies?: Record<string, string> }> {
  return Object.entries(readAccountProxySection(file))
    .filter(([, entry]) => [entry.proxy, ...Object.values(entry.accountProxies ?? {})].every(value => value === undefined || validAccountProxy(value)))
    .map(([agent, entry]) => ({ id: agent, name: '', key: '', ...(entry.proxy ? { proxy: entry.proxy } : {}), ...(entry.accountProxies ? { accountProxies: entry.accountProxies } : {}) }))
}

/* ────────────────────────── kernel ────────────────────────── */

const localMagpie = () => config.gatewayEngine === 'magpie' && config.magpieControlPlane === 'local'

let probe: KernelProbeCache | null = null
let probeFor: KernelCall | null = null

/** Per-account exits are writable here: the Magpie backend with a kernel that routes them. */
export async function accountProxySupport(call?: KernelCall): Promise<AccountProxySupport> {
  if (!call && !localMagpie()) return { supported: false, reason: '只有本机 Magpie 内核的账号可以单独设置出口' }
  const caller = call ?? kernelCaller(() => config.magpieKernelSocket)
  if (!probe || (call && probeFor !== call)) {
    probe = new KernelProbeCache(caller)
    probeFor = call ?? null
  }
  const result = await probe.get()
  if (!result.ok) return { supported: false, reason: result.reason === 'kernel_unavailable' ? '内核未运行' : result.reason === 'kernel_outdated' ? '当前内核不支持账号登录，需要重新构建内核' : '内核响应异常' }
  if (!result.health.capabilities.includes(ACCOUNT_PROXY_CAPABILITY)) return { supported: false, reason: '当前内核不会让账号走单独的出口，需要重新构建内核' }
  return { supported: true, reason: null }
}

export function resetAccountProxySupportForTests() {
  probe = null
  probeFor = null
}

/** Push channel slots + picks now (after a write, at boot). The admission's own push adds the same picks. */
export async function pushAccountPicks(): Promise<void> {
  if (!localMagpie()) return
  const { magpieRoutes } = await import('./magpieRuntime.js')
  const { kernelJSON } = await import('./magpieEngine.js')
  const routes = await magpieRoutes()
  await kernelJSON(config.magpieKernelSocket, '/internal/providers', 'PUT', [...routes.map(route => route.provider), ...accountPicks()])
}

/**
 * Store then push; when the push fails the stored value is put back, so the registry never claims an exit the
 * kernel is not using (the page would show the account behind an IP it is not behind).
 */
export function accountProxyWriter(push: () => Promise<void> = pushAccountPicks, file?: string) {
  return async (agent: string, user: string, url: string): Promise<void> => {
    const { changed, prev } = writeAccountProxy(agent, user, url, file)
    if (!changed) return
    try {
      await push()
    } catch (error) {
      writeAccountProxy(agent, user, prev, file)
      throw error
    }
  }
}

/**
 * At boot the kernel holds no providers until the first inference request configures it, while the accounts
 * page already reads usage through it: push once picks exist, retrying while the kernel starts.
 */
export async function pushAccountPicksAtBoot(attempts = 6, delayMs = 2_000): Promise<boolean> {
  if (!localMagpie() || !accountPicks().length) return false
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await pushAccountPicks()
      return true
    } catch {
      await new Promise(resolve => setTimeout(resolve, delayMs).unref())
    }
  }
  return false
}
