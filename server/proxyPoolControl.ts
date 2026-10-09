/**
 * The console's own control plane, as the proxy pool sees it (PROXY-SPEC §7, §8).
 *
 * Reads go through `server/cpa.ts` (the CPA management API). Writes use the existing paths:
 * `setCredentialProxy` (channels.ts) for a credential and `setGlobalProxy` (cpa.ts) for the CPA global default.
 * Raw credential files are read server-side only and reduced to `proxy_url` immediately.
 */

import { config } from './config.js'
import { cpaSameHost } from './proxyPoolStore.js'
import { getAuthFileProxy, getCompatChannels, getGlobalProxy, getProviderKeyEntries, listAuthFiles, PROVIDER_KEY_ENDPOINTS, providerChannelName } from './cpa.js'

export type ControlCredential = {
  name: string
  provider: string
  label: string
  disabled: boolean
  /** present when the list itself carries the value; CPA's list never does */
  proxyUrl?: string
}

export type ControlProxyRef = { ref: string; url: string; label: string; provider?: string }

export type ProxyControlPlane = {
  cpaSameHost(): boolean
  listCredentials(): Promise<ControlCredential[]>
  readCredentialProxy(name: string): Promise<string>
  writeCredentialProxy(name: string, url: string): Promise<void>
  readGlobalProxy(): Promise<string>
  writeGlobalProxy(url: string): Promise<void>
  /** channel and key `proxy-url` values (read-only in v1) */
  readChannelProxies(): Promise<ControlProxyRef[]>
  presets(): Array<{ label: string; url: string }>
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

let credentialCache: { at: number; value: ControlCredential[] } | null = null

export function defaultControlPlane(): ProxyControlPlane {
  return {
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
    presets: () => config.proxyPresets,
  }
}

export function resetControlPlaneCacheForTests() {
  credentialCache = null
}
