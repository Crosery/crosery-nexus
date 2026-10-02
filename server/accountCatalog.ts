import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { OAUTH_PROVIDER_ENDPOINTS } from './cpa.js'
import type { KernelHealth } from './magpieKernel.js'

/**
 * The sign-in catalog: Magpie's subscription tiles (deploy/magpie/catalog.json, generated from the pinned
 * source by scripts/magpie-catalog.mjs) intersected with the agents the running kernel can sign in to.
 * The file is read lazily and validated; a missing or malformed file disables sign-in instead of guessing.
 */

export type Completion = 'poll' | 'relay' | 'paste' | 'cli' | 'local'
type Localized = { en: string; zh: string }

export type MagpieCatalogItem = {
  agent: string
  name: Localized
  short: Localized
  icon: string
  vendor: string
  plans: string
  own: boolean
  single: boolean
  risk: boolean
  riskNote: Localized | null
  sites: Array<{ id: string; label: Localized; host: string }>
  completion: Completion
  deviceCode: boolean
  relayPaths: string[]
  gate: 'host-exec' | null
}

export type MagpieCatalog = {
  revision: string
  copy: Record<string, Localized>
  relayForbiddenPaths: string[]
  items: MagpieCatalogItem[]
}

const COMPLETIONS: readonly Completion[] = ['poll', 'relay', 'paste', 'cli', 'local']
const AGENT_ID = /^[a-z0-9][a-z0-9-]{0,39}$/
const SITE_ID = /^[a-z0-9-]{1,32}$/
const PATH = /^\/[A-Za-z0-9/_-]{0,80}$/
export const DEFAULT_CATALOG_FILE = fileURLToPath(new URL('../deploy/magpie/catalog.json', import.meta.url))

const localized = (value: unknown): Localized | null => {
  const entry = value && typeof value === 'object' ? value as Record<string, unknown> : null
  return entry && typeof entry.en === 'string' && typeof entry.zh === 'string' && entry.zh.length <= 2000 ? { en: entry.en, zh: entry.zh } : null
}

export function parseMagpieCatalog(raw: unknown): MagpieCatalog | null {
  const file = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null
  if (!file || file.version !== 1 || typeof file.revision !== 'string' || !Array.isArray(file.items) || file.items.length > 100) return null
  const forbidden = Array.isArray(file.relayForbiddenPaths) && file.relayForbiddenPaths.every(entry => typeof entry === 'string')
    ? file.relayForbiddenPaths as string[] : null
  if (!forbidden || !forbidden.includes('/cancel')) return null
  const copy: Record<string, Localized> = {}
  for (const [key, value] of Object.entries(file.copy && typeof file.copy === 'object' ? file.copy as Record<string, unknown> : {})) {
    const text = localized(value)
    if (text) copy[key] = text
  }
  const items: MagpieCatalogItem[] = []
  const seen = new Set<string>()
  for (const entry of file.items) {
    const item = entry && typeof entry === 'object' ? entry as Record<string, unknown> : null
    if (!item || typeof item.agent !== 'string' || !AGENT_ID.test(item.agent) || seen.has(item.agent)) return null
    const name = localized(item.name)
    const short = localized(item.short)
    const completion = COMPLETIONS.find(mode => mode === item.completion)
    const relayPaths = Array.isArray(item.relayPaths) && item.relayPaths.every(path => typeof path === 'string' && PATH.test(path))
      ? item.relayPaths as string[] : null
    const sites = Array.isArray(item.sites) ? item.sites.map((site) => {
      const value = site && typeof site === 'object' ? site as Record<string, unknown> : {}
      const label = localized(value.label)
      return typeof value.id === 'string' && SITE_ID.test(value.id) && label ? { id: value.id, label, host: typeof value.host === 'string' ? value.host : '' } : null
    }) : null
    if (!name || !short || !completion || !relayPaths || !sites || sites.some(site => !site)) return null
    if (relayPaths.some(path => forbidden.includes(path)) || (completion === 'relay' && !relayPaths.length)) return null
    const riskNote = item.riskNote === null || item.riskNote === undefined ? null : localized(item.riskNote)
    if (item.risk === true && !riskNote) return null
    seen.add(item.agent)
    items.push({
      agent: item.agent, name, short,
      icon: typeof item.icon === 'string' ? item.icon : '',
      vendor: typeof item.vendor === 'string' ? item.vendor : '',
      plans: typeof item.plans === 'string' ? item.plans : '',
      own: item.own === true, single: item.single === true, risk: item.risk === true, riskNote,
      sites: sites as MagpieCatalogItem['sites'], completion, deviceCode: item.deviceCode === true, relayPaths,
      gate: item.gate === 'host-exec' ? 'host-exec' : null,
    })
  }
  return { revision: file.revision, copy, relayForbiddenPaths: forbidden, items }
}

let catalogCache: { file: string; mtimeMs: number; catalog: MagpieCatalog | null } | null = null

/** Re-read only when the file changes; null when it is missing or fails validation. */
export function loadMagpieCatalog(file = DEFAULT_CATALOG_FILE): MagpieCatalog | null {
  try {
    const stat = fs.statSync(file)
    if (!stat.isFile() || stat.size > 1024 * 1024) return null
    if (catalogCache && catalogCache.file === file && catalogCache.mtimeMs === stat.mtimeMs) return catalogCache.catalog
    const catalog = parseMagpieCatalog(JSON.parse(fs.readFileSync(file, 'utf8')))
    catalogCache = { file, mtimeMs: stat.mtimeMs, catalog }
    return catalog
  } catch {
    return null
  }
}

/* ────────────────────────── views ────────────────────────── */

/** cursor / grok run a vendor CLI and devin may pipe an installer into bash on the host: off unless both sides allow it. */
export function signinGated(item: MagpieCatalogItem, health: KernelHealth, hostExec: boolean): boolean {
  if (health.signinDeny.includes(item.agent)) return true
  return item.gate === 'host-exec' && !hostExec
}

export type CatalogItemView = {
  agent: string
  name: string
  shortName: string
  icon: string
  vendor: string
  plans: string
  own: boolean
  single: boolean
  risk: { title: string; note: string } | null
  sites: Array<{ id: string; label: string; host: string }>
  completion: Completion
  deviceCode: boolean
  /** a host-loopback flow: the final localhost address can be pasted back */
  pasteCallback: boolean
  gated: boolean
  signedIn: number
}

const fill = (template: string, values: Record<string, string>) => template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match)

export function catalogItemView(catalog: MagpieCatalog, item: MagpieCatalogItem, health: KernelHealth, hostExec: boolean, signedIn: number): CatalogItemView {
  const riskTitle = catalog.copy.riskTitle?.zh ?? '{name} 账号可能被封禁'
  return {
    agent: item.agent,
    name: item.name.zh,
    shortName: item.short.zh,
    icon: item.icon,
    vendor: item.vendor,
    plans: item.plans,
    own: item.own,
    single: item.single,
    risk: item.risk && item.riskNote ? { title: fill(riskTitle, { name: item.short.zh }), note: item.riskNote.zh } : null,
    sites: item.sites.map(site => ({ id: site.id, label: site.label.zh, host: site.host })),
    completion: item.completion,
    deviceCode: item.deviceCode,
    pasteCallback: item.completion === 'relay' || item.completion === 'paste',
    gated: signinGated(item, health, hostExec),
    signedIn,
  }
}

/** Catalog ∩ the kernel's login agents, in Magpie's tile order. */
export function availableItems(catalog: MagpieCatalog, health: KernelHealth): MagpieCatalogItem[] {
  return catalog.items.filter(item => health.loginAgents.includes(item.agent))
}

export function zhCopy(catalog: MagpieCatalog): Record<string, string> {
  return Object.fromEntries(Object.entries(catalog.copy).map(([key, value]) => [key, value.zh]))
}

/**
 * The CPA backend's providers, server-side (the page's PROVIDERS list mirrors it). Every id is an
 * OAUTH_PROVIDER_ENDPOINTS key, so this list cannot offer a provider the CPA routes would refuse.
 */
export const CPA_CATALOG = [
  { agent: 'codex', name: 'Codex', vendor: 'OpenAI · ChatGPT 订阅', flow: 'browser', pasteCallback: true, risk: false },
  { agent: 'claude', name: 'Claude', vendor: 'Anthropic · Claude 订阅', flow: 'browser', pasteCallback: true, risk: true },
  { agent: 'antigravity', name: 'Antigravity', vendor: 'Google · 按模型家族计额', flow: 'browser', pasteCallback: true, risk: true },
  { agent: 'kimi', name: 'Kimi', vendor: 'Moonshot · kimi.com 国内站', flow: 'device', pasteCallback: false, risk: false },
  { agent: 'kimi-ai', name: 'Kimi 国际站', vendor: 'Moonshot · kimi.ai', flow: 'device', pasteCallback: false, risk: false },
  { agent: 'xai', name: 'Grok', vendor: 'xAI · SuperGrok', flow: 'browser', pasteCallback: true, risk: false },
  { agent: 'devin', name: 'Devin', vendor: 'Cognition', flow: 'browser', pasteCallback: true, risk: false },
  { agent: 'meta', name: 'Meta AI', vendor: 'Meta · Muse', flow: 'device', pasteCallback: false, risk: false },
].filter(entry => Object.prototype.hasOwnProperty.call(OAUTH_PROVIDER_ENDPOINTS, entry.agent))
