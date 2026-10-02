/**
 * One paste box → parsed proxies (PROXY-SPEC §2 detection order).
 *
 * After stripping the BOM and trimming, the input is the first match of:
 *   1. our export JSON (`format: crosery-proxy-pool`);
 *   2. Clash YAML (`proxies:` and/or `proxy-providers:`, or a bare list of proxy mappings);
 *   3. subscription URLs: http(s) with a path or query and no userinfo (one per line);
 *   4. share-link lines (ss ssr vmess vless trojan hy2 tuic wireguard socks http …);
 *   5. base64 (any variant) that decodes to 2 or 4.
 * Anything else is 「无法识别的格式」, with a `?flag=clash` hint for sing-box / Surge / Quantumult X input.
 * Nothing here fetches: subscription URLs are returned for the caller to fetch once, on an explicit action.
 */

import { cleanLabel, parseProxyUrl, sanitizeClashProxy, type ProxyCandidate } from './proxyParseClash.js'
import { CLASH_SKIP_SECTIONS, parseYamlSubset, YamlSubsetError, type YamlMap, type YamlValue } from './proxyParseYaml.js'
import { decodeBase64Text, isSubscriptionUrl, parseShareLink, uriScheme } from './proxyParseUri.js'

export const PARSE_LIMITS = { maxProxies: 2000, maxProviders: 10, maxLines: 5000 } as const
export const DUPLICATE_SUBSCRIPTIONS_NOTE = '重复的订阅链接已合并'

export type ParsedCandidate = ProxyCandidate & {
  /** which provider/subscription (index into `providers`) the row came from */
  provider?: number
  /** export rows: the entry ref used by `assignments` */
  exportRef?: string
  tags?: string[]
  enabled?: boolean
}

export type ProviderRef = {
  name: string
  /** secret: the subscription address */
  url: string
  /** names from this provider get this prefix (`override.additional-prefix`) */
  prefix?: string
  source: 'pasted' | 'provider' | 'export'
  intervalH?: number
}

export type ExportAssignment = { entryRef: string; account: { backend: string; provider: string; identity: string } }

export type ParsedInput = {
  format: 'export' | 'clash' | 'uri' | 'base64' | 'subscription'
  candidates: ParsedCandidate[]
  providers: ProviderRef[]
  ignoredSections: string[]
  notes: string[]
  assignments: ExportAssignment[]
}

export class ProxyParseError extends Error {
  constructor(readonly code: 'unsupported_format' | 'too_large' | 'invalid_yaml', message: string, readonly hint: string | null = null) {
    super(message)
    this.name = 'ProxyParseError'
  }
}

export const EXPORT_FORMAT = 'crosery-proxy-pool'

const FORMAT_HINT = '请在订阅链接后加 ?flag=clash（或在机场后台选择 Clash / Mihomo 格式）再粘贴'

const isMap = (value: unknown): value is YamlMap => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

function contentLines(text: string): string[] {
  return text.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#') && !line.startsWith('//'))
}

const CLASH_MARKER = /^(proxies|proxy-providers)[ \t]*:/m
const BARE_LIST_MARKER = /^-[ \t]+(\{|name[ \t]*:|type[ \t]*:|server[ \t]*:)/m

function tooMany(count: number) {
  if (count > PARSE_LIMITS.maxProxies) throw new ProxyParseError('too_large', `代理数量超过 ${PARSE_LIMITS.maxProxies} 个`)
}

/** `proxies` + `proxy-providers` of a parsed Clash document. */
function fromClash(root: YamlValue, ignored: string[], options: { allowProviders: boolean }): Pick<ParsedInput, 'candidates' | 'providers' | 'notes'> & { ignoredSections: string[] } {
  const candidates: ParsedCandidate[] = []
  const providers: ProviderRef[] = []
  const notes: string[] = []
  const list = Array.isArray(root) ? root : isMap(root) && Array.isArray(root.proxies) ? root.proxies : []
  tooMany(list.length)
  for (const item of list) candidates.push(sanitizeClashProxy(item, { banners: true }))
  const providerMap = isMap(root) && isMap(root['proxy-providers']) ? root['proxy-providers'] : null
  if (providerMap) {
    for (const [rawName, value] of Object.entries(providerMap)) {
      const name = cleanLabel(rawName) || 'provider'
      if (!isMap(value)) continue
      const type = typeof value.type === 'string' ? value.type.toLowerCase() : ''
      const override = isMap(value.override) ? value.override : null
      // the prefix keeps its trailing space ("[A] "); control characters out, 24 characters max
      // eslint-disable-next-line no-control-regex
      const prefix = override && typeof override['additional-prefix'] === 'string' ? Array.from(override['additional-prefix'].replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '')).slice(0, 24).join('') || undefined : undefined
      if (type === 'inline' && Array.isArray(value.payload)) {
        tooMany(candidates.length + value.payload.length)
        for (const item of value.payload) {
          const candidate: ParsedCandidate = sanitizeClashProxy(item, { banners: true })
          if (prefix && candidate.name) candidate.name = cleanLabel(`${prefix}${candidate.name}`)
          candidates.push(candidate)
        }
        continue
      }
      if (type === 'file') {
        candidates.push({ name, type: 'provider', status: 'unsupported', reason: 'provider type file：不读取本地文件' })
        continue
      }
      if (type !== 'http' || typeof value.url !== 'string') {
        candidates.push({ name, type: 'provider', status: 'unsupported', reason: `不支持的 provider 类型 ${type.slice(0, 16) || '未知'}` })
        continue
      }
      if (!options.allowProviders) {
        notes.push('订阅内容里的 proxy-providers 不会被继续拉取')
        continue
      }
      if (!isSubscriptionUrl(value.url) && !/^https?:\/\/[^/]+\/?$/i.test(value.url.trim())) {
        candidates.push({ name, type: 'provider', status: 'invalid', reason: 'provider 地址无效' })
        continue
      }
      const url = value.url.trim()
      if (providers.some(provider => provider.url === url)) {
        notes.push(DUPLICATE_SUBSCRIPTIONS_NOTE)
        continue
      }
      if (providers.length >= PARSE_LIMITS.maxProviders) {
        notes.push(`最多一次处理 ${PARSE_LIMITS.maxProviders} 个 proxy-providers`)
        continue
      }
      const interval = Number(value.interval)
      providers.push({
        name, url, prefix, source: 'provider',
        ...(Number.isFinite(interval) && interval > 0 ? { intervalH: Math.max(6, Math.round(interval / 3600)) } : {}),
      })
    }
  }
  return { candidates, providers, notes, ignoredSections: ignored }
}

function parseClashText(text: string, options: { allowProviders: boolean }) {
  let parsed
  try {
    parsed = parseYamlSubset(text, {
      skipKeys: CLASH_SKIP_SECTIONS,
      requiredKeys: new Set(['proxies', 'proxy-providers']),
    })
  } catch (error) {
    if (error instanceof YamlSubsetError) throw new ProxyParseError('invalid_yaml', `Clash 配置解析失败：${error.message}`)
    throw error
  }
  const ignored = parsed.topLevelKeys.filter(key => key !== 'proxies' && key !== 'proxy-providers')
  return fromClash(parsed.value, [...new Set(ignored)], options)
}

/** Our own export file. Masked entries (`***`) cannot be imported and say so. */
function parseExport(json: Record<string, unknown>): ParsedInput {
  if (json.version !== 1) throw new ProxyParseError('unsupported_format', '导出文件版本不受支持')
  const candidates: ParsedCandidate[] = []
  const entries = Array.isArray(json.entries) ? json.entries : []
  tooMany(entries.length)
  for (const raw of entries) {
    if (!isMap(raw)) continue
    const exportRef = typeof raw.ref === 'string' ? raw.ref.slice(0, 32) : undefined
    const name = cleanLabel(raw.name)
    const tags = Array.isArray(raw.tags) ? raw.tags.filter((tag): tag is string => typeof tag === 'string').map(tag => cleanLabel(tag, 24)).filter(Boolean).slice(0, 16) : undefined
    const enabled = (raw as Record<string, unknown>).enabled === false ? false : undefined
    const masked = JSON.stringify(raw).includes('***')
    if (masked) {
      candidates.push({ name, type: String(raw.protocol || ''), status: 'invalid', reason: '脱敏导出不含密码，无法导入', exportRef })
      continue
    }
    let candidate: ProxyCandidate
    if (raw.kind === 'url' && typeof raw.url === 'string') {
      candidate = parseShareLink(raw.url)
      if (candidate.status === 'ok' && candidate.kind !== 'url') candidate = { name, type: 'url', status: 'invalid', reason: '代理地址无效' }
    } else if (raw.kind === 'mihomo' && isMap(raw.node)) {
      const protocol = typeof raw.protocol === 'string' ? raw.protocol : ''
      candidate = sanitizeClashProxy({ type: protocol === 'https' ? 'http' : protocol, ...raw.node, name: raw.name }, { banners: false })
    } else {
      candidate = { name, type: String(raw.protocol || ''), status: 'invalid', reason: '导出条目无效' }
    }
    candidates.push({ ...candidate, name: name || candidate.name, exportRef, ...(tags?.length ? { tags } : {}), ...(enabled === false ? { enabled } : {}) })
  }
  const providers: ProviderRef[] = []
  const notes: string[] = []
  for (const raw of Array.isArray(json.subscriptions) ? json.subscriptions : []) {
    if (!isMap(raw) || typeof raw.url !== 'string') continue
    if (raw.url.includes('***')) { notes.push('脱敏导出的订阅不含地址，已跳过'); continue }
    if (!isSubscriptionUrl(raw.url)) continue
    const url = raw.url.trim()
    if (providers.some(provider => provider.url === url)) { notes.push(DUPLICATE_SUBSCRIPTIONS_NOTE); continue }
    if (providers.length >= PARSE_LIMITS.maxProviders) continue
    const interval = Number(raw.intervalH)
    providers.push({ name: cleanLabel(raw.name) || 'subscription', url, source: 'export', ...(Number.isFinite(interval) ? { intervalH: interval } : {}) })
  }
  const assignments: ExportAssignment[] = []
  for (const raw of Array.isArray(json.assignments) ? json.assignments : []) {
    if (!isMap(raw) || typeof raw.entryRef !== 'string' || !isMap(raw.account)) continue
    const account = raw.account
    const backend = typeof account.backend === 'string' ? account.backend : ''
    const identity = typeof account.identity === 'string' ? account.identity.slice(0, 256) : ''
    if (!['cpa', 'magpie'].includes(backend) || !identity) continue
    assignments.push({ entryRef: raw.entryRef.slice(0, 32), account: { backend, provider: typeof account.provider === 'string' ? account.provider.slice(0, 64) : '', identity } })
    if (assignments.length >= 5000) break
  }
  return { format: 'export', candidates, providers, ignoredSections: [], notes, assignments }
}

function parseLines(lines: string[], format: 'uri' | 'base64'): ParsedInput {
  if (lines.length > PARSE_LIMITS.maxLines) throw new ProxyParseError('too_large', `超过 ${PARSE_LIMITS.maxLines} 行`)
  const candidates: ParsedCandidate[] = []
  const providers: ProviderRef[] = []
  const notes: string[] = []
  for (const line of lines) {
    if (isSubscriptionUrl(line) && !parseProxyUrl(line)?.username) {
      // the same address twice is one subscription: one fetch, one slot of the cap
      if (providers.some(provider => provider.url === line)) { notes.push(DUPLICATE_SUBSCRIPTIONS_NOTE); continue }
      if (providers.length >= PARSE_LIMITS.maxProviders) { notes.push(`最多一次处理 ${PARSE_LIMITS.maxProviders} 个订阅`); continue }
      providers.push({ name: subscriptionLabel(line), url: line, source: 'pasted' })
      continue
    }
    candidates.push(parseShareLink(line))
  }
  tooMany(candidates.length)
  return { format: providers.length && !candidates.length ? 'subscription' : format, candidates, providers, ignoredSections: [], notes, assignments: [] }
}

/** The host of a subscription address as its default name; the URL itself is a secret. */
export function subscriptionLabel(url: string): string {
  try { return cleanLabel(new URL(url).hostname, 48) || 'subscription' } catch { return 'subscription' }
}

const looksLikeUriList = (lines: string[]) => lines.length > 0 && lines.every(line => uriScheme(line) !== null)

function hintFor(text: string): string | null {
  if (/"outbounds"\s*:/.test(text)) return FORMAT_HINT
  if (/^\s*\[(Proxy|server_local|Proxy Group)\]/im.test(text)) return FORMAT_HINT
  if (/^[^=\n]{1,64}=\s*(ss|vmess|trojan|http|https|socks5|snell|hysteria2|tuic|vless|wireguard)\s*,/im.test(text)) return FORMAT_HINT
  if (/^(shadowsocks|vmess|trojan|http|vless)\s*=\s*[^,\n]+:\d+\s*,/im.test(text)) return FORMAT_HINT
  return null
}

/**
 * Parse pasted text (or a fetched subscription body with `fromSubscription`, which never yields providers to fetch).
 * Throws ProxyParseError; never throws anything else on any input.
 */
export function parseProxyInput(input: string, options: { fromSubscription?: boolean; depth?: number } = {}): ParsedInput {
  const text = String(input ?? '').replace(/^﻿/, '').trim()
  if (!text) throw new ProxyParseError('unsupported_format', '内容为空')
  if (Buffer.byteLength(text, 'utf8') > 4 * 1024 * 1024) throw new ProxyParseError('too_large', '内容超过 4 MiB')
  const allowProviders = !options.fromSubscription
  try {
    if (text.startsWith('{')) {
      let json: unknown = null
      try { json = JSON.parse(text) } catch { json = null }
      if (isMap(json) && json.format === EXPORT_FORMAT) return parseExport(json)
      if (isMap(json) && (Array.isArray(json.proxies) || isMap(json['proxy-providers']))) {
        return { format: 'clash', assignments: [], ...fromClash(json as YamlMap, Object.keys(json).filter(key => key !== 'proxies' && key !== 'proxy-providers'), { allowProviders }) }
      }
      if (isMap(json)) throw new ProxyParseError('unsupported_format', '无法识别的格式', hintFor(text))
    }
    if (CLASH_MARKER.test(text) || BARE_LIST_MARKER.test(text)) {
      return { format: 'clash', assignments: [], ...parseClashText(text, { allowProviders }) }
    }
    const lines = contentLines(text)
    if (looksLikeUriList(lines)) {
      const parsed = parseLines(lines, 'uri')
      if (options.fromSubscription && parsed.providers.length) {
        parsed.notes.push('订阅内容里的订阅地址不会被继续拉取')
        parsed.providers = []
      }
      return parsed
    }
    // a mixed paste: keep the link lines, report the rest
    const linkLines = lines.filter(line => uriScheme(line) !== null)
    if (linkLines.length && linkLines.length >= lines.length / 2) {
      const parsed = parseLines(linkLines, 'uri')
      for (const line of lines) {
        if (uriScheme(line) === null) parsed.candidates.push({ name: '', type: '', status: 'invalid', reason: '无法识别的行' })
      }
      tooMany(parsed.candidates.length)
      if (options.fromSubscription) parsed.providers = []
      return parsed
    }
    if ((options.depth ?? 0) < 1) {
      const decoded = decodeBase64Text(text)
      if (decoded) {
        const inner = parseProxyInput(decoded, { ...options, depth: (options.depth ?? 0) + 1 })
        if (inner.format === 'clash' || inner.format === 'uri') return { ...inner, format: inner.format === 'uri' ? 'base64' : inner.format }
      }
    }
  } catch (error) {
    if (error instanceof ProxyParseError) throw error
    throw new ProxyParseError('unsupported_format', '无法识别的格式')
  }
  throw new ProxyParseError('unsupported_format', '无法识别的格式', hintFor(text))
}
