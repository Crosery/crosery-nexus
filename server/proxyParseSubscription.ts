/**
 * Subscription fetch (PROXY-SPEC §3): one direct GET, never through env proxies, with hard limits.
 *
 * - https only by default; http allowed with a warning flag.
 * - Loopback/private/link-local targets are refused unless `PROXY_SUBSCRIPTION_ALLOW_PRIVATE=1`; the check runs
 *   inside the socket's DNS lookup, so the address that is checked is the address that is dialed (no rebinding).
 * - At most 3 redirects, each re-checked; 15 s total; 4 MiB body cap (decompressed); UA `clash.meta`; no cookies.
 * - Response headers used: `subscription-userinfo`, `profile-update-interval`, `content-disposition`, `Retry-After`.
 * The URL is a secret: errors and logs only ever carry `https://host/***`.
 */

import dns from 'node:dns'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import zlib from 'node:zlib'
import { cleanLabel } from './proxyParseClash.js'

export const SUBSCRIPTION_LIMITS = { timeoutMs: 15_000, maxBytes: 4 * 1024 * 1024, maxRedirects: 3 } as const

export type SubscriptionInfo = { upload?: number; download?: number; total?: number; expire?: number }

export type SubscriptionFetchResult = {
  body: string
  status: number
  info: SubscriptionInfo | null
  /** `profile-update-interval` in hours (a lower bound for our interval) */
  updateIntervalH: number | null
  /** from `content-disposition` / `profile-title` */
  filename: string | null
  insecureHttp: boolean
}

export class SubscriptionFetchError extends Error {
  constructor(readonly code: 'private_target' | 'bad_url' | 'http_status' | 'too_large' | 'timeout' | 'network' | 'redirects',
    message: string, readonly retryAfterMs: number | null = null, readonly status: number | null = null) {
    super(message)
    this.name = 'SubscriptionFetchError'
  }
}

/** `https://host/***`: what a subscription address looks like in any output. */
export function maskSubscriptionUrl(value: string): string {
  try {
    const url = new URL(value)
    const rest = (url.pathname && url.pathname !== '/') || url.search ? '/***' : ''
    return `${url.protocol}//${url.host}${rest}`
  } catch {
    return '***'
  }
}

function ipv4Private(address: string): boolean {
  const parts = address.split('.').map(Number)
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return true
  const [a, b] = parts
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0 && parts[2] === 0)
    || a >= 224
}

/** The eight 16-bit words of an IPv6 address (a trailing dotted IPv4 is folded in), or null. */
function ipv6Words(value: string): number[] | null {
  let text = value
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text)
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number)
    if ([a, b, c, d].some(part => part > 255)) return null
    text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`
  }
  const halves = text.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null
  const words = [...head, ...Array<string>(fill).fill('0'), ...tail].map(word => (/^[0-9a-f]{1,4}$/.test(word) ? Number.parseInt(word, 16) : -1))
  return words.length === 8 && words.every(word => word >= 0) ? words : null
}

const embeddedIpv4 = (high: number, low: number) => `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`

/**
 * Loopback, private, link-local, CGNAT, multicast, unspecified. IPv6 is checked word by word, so every spelling of an
 * IPv4-mapped/compatible/translated, NAT64 (64:ff9b::/96) or 6to4 (2002::/16) address is judged by the IPv4 inside it
 * (`[::ffff:127.0.0.1]` normalizes to `::ffff:7f00:1` in a URL).
 */
export function isPrivateAddress(address: string): boolean {
  const value = address.toLowerCase().replace(/^\[(.*)\]$/, '$1').replace(/%.*$/, '')
  if (net.isIPv4(value)) return ipv4Private(value)
  if (!net.isIPv6(value)) return true
  const words = ipv6Words(value)
  if (!words) return true
  const zeros = (from: number, to: number) => words.slice(from, to).every(word => word === 0)
  if (zeros(0, 8)) return true
  if (zeros(0, 7) && words[7] === 1) return true
  if (zeros(0, 5) && (words[5] === 0xffff || words[5] === 0)) return ipv4Private(embeddedIpv4(words[6], words[7]))
  if (zeros(0, 4) && words[4] === 0xffff && words[5] === 0) return ipv4Private(embeddedIpv4(words[6], words[7]))
  if (words[0] === 0x64 && words[1] === 0xff9b) return words[2] === 1 || ipv4Private(embeddedIpv4(words[6], words[7]))
  if (words[0] === 0x2002) return ipv4Private(embeddedIpv4(words[1], words[2]))
  const head = words[0]
  return (head & 0xfe00) === 0xfc00 || (head & 0xffc0) === 0xfe80 || (head & 0xffc0) === 0xfec0 || (head & 0xff00) === 0xff00
}

export function parseSubscriptionUserinfo(header: string | null | undefined): SubscriptionInfo | null {
  if (!header) return null
  const info: SubscriptionInfo = {}
  for (const part of header.split(';')) {
    const [key, raw] = part.split('=').map(item => item?.trim())
    const value = Number(raw)
    if (!Number.isFinite(value) || value < 0) continue
    if (key === 'upload' || key === 'download' || key === 'total' || key === 'expire') info[key] = Math.floor(value)
  }
  return Object.keys(info).length ? info : null
}

export function parseContentDispositionName(header: string | null | undefined): string | null {
  if (!header) return null
  const star = /filename\*\s*=\s*(?:UTF-8|utf-8)?''([^;]+)/.exec(header)
  let name = ''
  if (star) {
    try { name = decodeURIComponent(star[1].trim().replace(/^"|"$/g, '')) } catch { name = '' }
  }
  if (!name) name = /filename\s*=\s*"?([^";]+)"?/.exec(header)?.[1] ?? ''
  name = name.replace(/\.(ya?ml|txt|conf)$/i, '')
  return cleanLabel(name, 48) || null
}

export function parseRetryAfter(header: string | null | undefined, now = Date.now()): number | null {
  if (!header) return null
  const seconds = Number(header.trim())
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 7 * 24 * 60 * 60_000)
  const at = Date.parse(header)
  return Number.isFinite(at) ? Math.max(0, Math.min(at - now, 7 * 24 * 60 * 60_000)) : null
}

type LookupFn = (hostname: string, options: dns.LookupAllOptions) => Promise<Array<{ address: string; family: number }>>

export type SubscriptionFetchOptions = {
  allowPrivate?: boolean
  timeoutMs?: number
  maxBytes?: number
  maxRedirects?: number
  /** tests: resolve names without DNS */
  lookup?: LookupFn
  /** tests: which resolved addresses count as private */
  isPrivate?: (address: string) => boolean
  now?: () => number
}

const defaultLookup: LookupFn = (hostname, options) => dns.promises.lookup(hostname, options)

const header = (headers: http.IncomingHttpHeaders, name: string): string | null => {
  const value = headers[name]
  return Array.isArray(value) ? value[0] ?? null : value ?? null
}

/** One request; resolves with the response (body not read yet) or rejects with a SubscriptionFetchError. */
function requestOnce(url: URL, options: Required<Pick<SubscriptionFetchOptions, 'allowPrivate'>> & { lookup: LookupFn; isPrivate: (address: string) => boolean; signal: AbortSignal }): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const host = url.hostname.replace(/^\[(.*)\]$/, '$1')
    if (net.isIP(host) && !options.allowPrivate && options.isPrivate(host)) {
      reject(new SubscriptionFetchError('private_target', '订阅地址指向本机或内网，已拒绝'))
      return
    }
    const lookup = (hostname: string, lookupOptions: dns.LookupOptions, callback: (error: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void) => {
      options.lookup(hostname, { all: true, family: lookupOptions.family as number | undefined ?? 0 }).then((addresses) => {
        if (!addresses.length) throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' })
        if (!options.allowPrivate && addresses.some(item => options.isPrivate(item.address))) {
          throw new SubscriptionFetchError('private_target', '订阅地址解析到本机或内网，已拒绝')
        }
        if (lookupOptions.all) callback(null, addresses.map(item => ({ address: item.address, family: item.family })))
        else callback(null, addresses[0].address, addresses[0].family)
      }).catch(error => callback(error as NodeJS.ErrnoException, ''))
    }
    const transport = url.protocol === 'https:' ? https : http
    // a fresh agent per request: never the global one, so NODE_USE_ENV_PROXY / HTTP(S)_PROXY are not applied
    const agent = url.protocol === 'https:' ? new https.Agent({ keepAlive: false }) : new http.Agent({ keepAlive: false })
    const request = transport.request(url, {
      method: 'GET',
      agent,
      lookup: lookup as unknown as net.LookupFunction,
      headers: { 'User-Agent': 'clash.meta', Accept: '*/*', 'Accept-Encoding': 'gzip, deflate' },
      signal: options.signal,
    }, resolve)
    request.on('error', (error) => {
      if (error instanceof SubscriptionFetchError) { reject(error); return }
      if ((error as { name?: string }).name === 'AbortError') { reject(new SubscriptionFetchError('timeout', '订阅拉取超时')); return }
      const cause = (error as { cause?: unknown }).cause
      if (cause instanceof SubscriptionFetchError) { reject(cause); return }
      const code = (error as NodeJS.ErrnoException).code
      reject(new SubscriptionFetchError('network', code === 'ENOTFOUND' ? '订阅域名无法解析' : code ? `订阅连接失败（${code}）` : '订阅连接失败'))
    })
    request.end()
  })
}

function readBody(response: http.IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const encoding = String(response.headers['content-encoding'] || '').toLowerCase()
    let stream: NodeJS.ReadableStream = response
    if (encoding === 'gzip' || encoding === 'x-gzip') stream = response.pipe(zlib.createGunzip())
    else if (encoding === 'deflate') stream = response.pipe(zlib.createInflate())
    else if (encoding === 'br') stream = response.pipe(zlib.createBrotliDecompress())
    const declared = Number(response.headers['content-length'])
    if (Number.isFinite(declared) && declared > maxBytes && !encoding) {
      response.destroy()
      reject(new SubscriptionFetchError('too_large', `订阅内容超过 ${Math.round(maxBytes / 1024 / 1024)} MiB`))
      return
    }
    const chunks: Buffer[] = []
    let size = 0
    stream.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > maxBytes) {
        response.destroy()
        reject(new SubscriptionFetchError('too_large', `订阅内容超过 ${Math.round(maxBytes / 1024 / 1024)} MiB`))
        return
      }
      chunks.push(chunk)
    })
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    stream.on('error', (error: Error) => {
      if (error instanceof SubscriptionFetchError) reject(error)
      else reject(new SubscriptionFetchError(/abort/i.test(error.name) ? 'timeout' : 'network', /abort/i.test(error.name) ? '订阅拉取超时' : '订阅内容读取失败'))
    })
  })
}

/** Fetch a subscription. Rejects with SubscriptionFetchError (zh message, never the URL). */
export async function fetchSubscription(address: string, options: SubscriptionFetchOptions = {}): Promise<SubscriptionFetchResult> {
  let url: URL
  try { url = new URL(address) } catch { throw new SubscriptionFetchError('bad_url', '订阅地址无效') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new SubscriptionFetchError('bad_url', '订阅地址必须是不含账号密码的 http(s) 地址')
  const allowPrivate = options.allowPrivate ?? process.env.PROXY_SUBSCRIPTION_ALLOW_PRIVATE === '1'
  const maxBytes = options.maxBytes ?? SUBSCRIPTION_LIMITS.maxBytes
  const maxRedirects = options.maxRedirects ?? SUBSCRIPTION_LIMITS.maxRedirects
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? SUBSCRIPTION_LIMITS.timeoutMs)
  timer.unref?.()
  let insecureHttp = url.protocol === 'http:'
  try {
    for (let hop = 0; ; hop++) {
      const response = await requestOnce(url, { allowPrivate, lookup: options.lookup ?? defaultLookup, isPrivate: options.isPrivate ?? isPrivateAddress, signal: controller.signal })
      const status = response.statusCode ?? 0
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume()
        if (hop >= maxRedirects) throw new SubscriptionFetchError('redirects', '订阅重定向次数过多')
        let next: URL
        try { next = new URL(response.headers.location, url) } catch { throw new SubscriptionFetchError('bad_url', '订阅重定向地址无效') }
        if (!['http:', 'https:'].includes(next.protocol) || next.username || next.password) throw new SubscriptionFetchError('bad_url', '订阅重定向地址无效')
        if (next.protocol === 'http:') insecureHttp = true
        url = next
        continue
      }
      if (status < 200 || status >= 300) {
        response.resume()
        const retryAfterMs = parseRetryAfter(header(response.headers, 'retry-after'), options.now?.() ?? Date.now())
        throw new SubscriptionFetchError('http_status', `订阅服务返回 HTTP ${status}`, retryAfterMs, status)
      }
      const body = await readBody(response, maxBytes)
      const intervalRaw = Number(header(response.headers, 'profile-update-interval'))
      const title = header(response.headers, 'profile-title')
      let filename = parseContentDispositionName(header(response.headers, 'content-disposition'))
      if (!filename && title) {
        const decoded = title.startsWith('base64:') ? Buffer.from(title.slice(7), 'base64').toString('utf8') : title
        filename = cleanLabel(decoded, 48) || null
      }
      return {
        body,
        status,
        info: parseSubscriptionUserinfo(header(response.headers, 'subscription-userinfo')),
        updateIntervalH: Number.isFinite(intervalRaw) && intervalRaw > 0 ? Math.min(Math.round(intervalRaw), 24 * 30) : null,
        filename,
        insecureHttp,
      }
    }
  } catch (error) {
    if (error instanceof SubscriptionFetchError) throw error
    if (controller.signal.aborted) throw new SubscriptionFetchError('timeout', '订阅拉取超时')
    throw new SubscriptionFetchError('network', '订阅连接失败')
  } finally {
    clearTimeout(timer)
  }
}
