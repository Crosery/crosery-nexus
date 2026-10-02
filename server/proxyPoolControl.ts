/**
 * The console's own control plane, as the proxy pool sees it (PROXY-SPEC §7, §8).
 *
 * Reads go through `server/cpa.ts`, which already routes to the remote CPA management API or to the local Magpie
 * shim; the sandbox bridge (`MAGPIE_SOURCE_CPA_BASE_URL`) is never a source. Writes use the existing paths:
 * `setCredentialProxy` (channels.ts) for a credential and `setGlobalProxy` (cpa.ts) for the CPA global default.
 * Raw credential files are read server-side only and reduced to `proxy_url` immediately.
 */

import fs from 'node:fs'
import { config } from './config.js'
import { cpaSameHost, proxyBackend, type ProxyBackend } from './proxyPoolStore.js'
import { getAuthFileProxy, getCompatChannels, getGlobalProxy, getProviderKeyEntries, listAuthFiles, PROVIDER_KEY_ENDPOINTS, providerChannelName } from './cpa.js'
import { accountProxySupport, accountProxyWriter, readAccountProxy, type AccountProxySupport } from './magpieAccountProxies.js'

export type ControlCredential = {
  name: string
  provider: string
  label: string
  disabled: boolean
  /** present when the list itself carries the value (local shim); CPA's list never does */
  proxyUrl?: string
}

export type ControlProxyRef = { ref: string; url: string; label: string; provider?: string }

export type ProxyControlPlane = {
  backend(): ProxyBackend
  cpaSameHost(): boolean
  listCredentials(): Promise<ControlCredential[]>
  readCredentialProxy(name: string): Promise<string>
  writeCredentialProxy(name: string, url: string): Promise<void>
  readGlobalProxy(): Promise<string>
  writeGlobalProxy(url: string): Promise<void>
  /** channel and key `proxy-url` values (read-only in v1) */
  readChannelProxies(): Promise<ControlProxyRef[]>
  /** Magpie provider / per-account proxies from the registry's optional `accounts` section (read-only) */
  readMagpieAccountProxies(): ControlProxyRef[]
  presets(): Array<{ label: string; url: string }>
  /**
   * Per-account exits of Magpie kernel accounts (`magpie:<agent>:<user>`): writable only when the kernel routes
   * them (capability `account-proxy`). Absent on control planes without kernel accounts.
   */
  magpieAccounts?: {
    support(): Promise<AccountProxySupport>
    read(agent: string, user: string): string
    /** stores the exit and pushes it to the kernel; '' = follow the service / global */
    write(agent: string, user: string, url: string): Promise<void>
  }
}

const text = (value: unknown, max = 256) => (typeof value === 'string' ? value.slice(0, max) : '')

export function projectCredential(file: Record<string, unknown>): ControlCredential | null {
  const name = text(file.name) || text(file.filename)
  if (!name) return null
  return {
    name,
    provider: text(file.type, 64) || text(file.provider, 64),
    label: text(file.email) || text(file.account) || text(file.label) || name.replace(/\.json$/i, ''),
    disabled: file.disabled === true,
    ...(typeof file.proxy_url === 'string' ? { proxyUrl: file.proxy_url.trim() } : {}),
  }
}

/** The optional `accounts` section of MAGPIE_CHANNELS_FILE: `{<agent>: {proxy?, accountProxies?: {<user>: url}}}`. */
export function readMagpieAccountsSection(file = config.magpieChannelsFile): ControlProxyRef[] {
  try {
    const stat = fs.lstatSync(file)
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024) return []
    const state = JSON.parse(fs.readFileSync(file, 'utf8')) as { version?: unknown; accounts?: unknown }
    if (state.version !== 1 || !state.accounts || typeof state.accounts !== 'object') return []
    const out: ControlProxyRef[] = []
    for (const [agent, raw] of Object.entries(state.accounts as Record<string, unknown>)) {
      if (!raw || typeof raw !== 'object' || !/^[a-z0-9][a-z0-9_.-]{0,63}$/i.test(agent)) continue
      const section = raw as { proxy?: unknown; accountProxies?: unknown }
      if (typeof section.proxy === 'string' && section.proxy.trim()) out.push({ ref: `magpie:${agent}`, url: section.proxy.trim(), label: agent, provider: agent })
      if (section.accountProxies && typeof section.accountProxies === 'object') {
        for (const [user, url] of Object.entries(section.accountProxies as Record<string, unknown>)) {
          if (typeof url === 'string' && user && user.length <= 256) out.push({ ref: `magpie:${agent}:${user}`, url: url.trim(), label: user, provider: agent })
        }
      }
    }
    return out
  } catch {
    return []
  }
}

let credentialCache: { at: number; value: ControlCredential[] } | null = null

export function defaultControlPlane(): ProxyControlPlane {
  return {
    backend: proxyBackend,
    cpaSameHost: () => cpaSameHost(),
    async listCredentials() {
      if (credentialCache && Date.now() - credentialCache.at < 15_000) return credentialCache.value
      const { files } = await listAuthFiles()
      const value = (files || []).map(projectCredential).filter((item): item is ControlCredential => item !== null)
      credentialCache = { at: Date.now(), value }
      return value
    },
    readCredentialProxy: name => getAuthFileProxy(name),
    async writeCredentialProxy(name, url) {
      const { setCredentialProxy } = await import('./channels.js')
      await setCredentialProxy(name, url)
      credentialCache = null
    },
    readGlobalProxy: () => getGlobalProxy({ required: true }),
    async writeGlobalProxy(url) {
      const cpa = await import('./cpa.js') as { setGlobalProxy?: (value: string) => Promise<unknown> }
      if (typeof cpa.setGlobalProxy !== 'function') throw new Error('setGlobalProxy unavailable')
      await cpa.setGlobalProxy(url)
    },
    async readChannelProxies() {
      const out: ControlProxyRef[] = []
      for (const channel of await getCompatChannels()) {
        const name = text(channel.name, 80)
        if (!name) continue
        if (typeof channel['proxy-url'] === 'string' && channel['proxy-url'].trim()) {
          out.push({ ref: `cpa:channel:${name}`, url: channel['proxy-url'].trim(), label: name })
        }
        ;(channel['api-key-entries'] || []).forEach((entry, index) => {
          const proxy = entry?.['proxy-url']
          if (typeof proxy === 'string' && proxy.trim()) out.push({ ref: `cpa:key:${name}:${index}`, url: proxy.trim(), label: `${name} #${index + 1}` })
        })
      }
      for (const endpoint of PROVIDER_KEY_ENDPOINTS) {
        const entries = await getProviderKeyEntries(endpoint).catch(() => [])
        entries.forEach((entry, index) => {
          const proxy = entry['proxy-url']
          if (typeof proxy === 'string' && proxy.trim()) {
            out.push({ ref: `cpa:key:${endpoint}:${index}`, url: proxy.trim(), label: providerChannelName(entry, endpoint, index) })
          }
        })
      }
      return out
    },
    readMagpieAccountProxies: () => (proxyBackend() === 'magpie' ? readMagpieAccountsSection() : []),
    presets: () => config.proxyPresets,
    magpieAccounts: {
      support: () => (proxyBackend() === 'magpie' ? accountProxySupport() : Promise.resolve({ supported: false, reason: '只有本机 Magpie 内核的账号可以单独设置出口' })),
      read: (agent, user) => readAccountProxy(agent, user),
      write: (agent, user, url) => accountProxyWriter()(agent, user, url),
    },
  }
}

export function resetControlPlaneCacheForTests() {
  credentialCache = null
}
