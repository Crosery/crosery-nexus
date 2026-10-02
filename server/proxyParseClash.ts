/**
 * Clash proxy objects → the whitelisted node the pool stores (PROXY-SPEC §2, MIHOMO §3.1).
 *
 * Every field is copied by name with a per-field coercion, so a scalar parsed as a string (`port: "443"`,
 * `password: 123456`) gets the type mihomo expects and unknown or dangerous keys (`interface-name`,
 * `routing-mark`, `dialer-proxy`, file paths) never reach the generated kernel config. Names are labels only:
 * control characters stripped, 64 characters max, never used as identifiers.
 */

export type ProxyProtocol = 'http' | 'https' | 'socks5' | 'ss' | 'ssr' | 'vmess' | 'vless' | 'trojan' | 'hysteria2' | 'tuic' | 'wireguard'
export type ProxyKind = 'url' | 'mihomo'
export type ClashNode = Record<string, unknown>

export const MIHOMO_TYPES = ['ss', 'ssr', 'vmess', 'vless', 'trojan', 'hysteria2', 'tuic', 'wireguard', 'socks5', 'http'] as const
export type MihomoType = (typeof MIHOMO_TYPES)[number]

/** One parsed proxy before it meets the pool. `url` / `node` and `dedupKey` hold secrets and never leave the server. */
export type ProxyCandidate = {
  name: string
  /** the declared type, also for unsupported rows (`snell`) */
  type: string
  status: 'ok' | 'unsupported' | 'invalid' | 'info'
  reason?: string
  kind?: ProxyKind
  protocol?: ProxyProtocol
  url?: string
  node?: ClashNode
  server?: string
  serverPort?: number
  /** normalized endpoint incl. credential; HMAC'd by the store, never persisted or served raw */
  dedupKey?: string
  /** a loopback url that belongs to another program on that host */
  external?: boolean
}

export class FieldError extends Error {
  constructor(readonly field: string, message: string) { super(message); this.name = 'FieldError' }
}

type Coerce = (value: unknown, field: string) => unknown

const MAX_STRING = 4096

const isMap = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

export function cleanLabel(value: unknown, max = 64): string {
  const text = typeof value === 'string' ? value : typeof value === 'number' ? String(value) : ''
  // control characters and bidi overrides out; whitespace runs collapsed
  // eslint-disable-next-line no-control-regex
  const cleaned = text.replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim()
  return Array.from(cleaned).slice(0, max).join('')
}

const str: Coerce = (value, field) => {
  if (value === null || value === undefined) return undefined
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (typeof value !== 'string') throw new FieldError(field, `${field} 应为字符串`)
  if (value.length > MAX_STRING) throw new FieldError(field, `${field} 过长`)
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b-\u001f]/.test(value)) throw new FieldError(field, `${field} 含控制字符`)
  return value
}

const nonEmpty: Coerce = (value, field) => {
  const text = str(value, field)
  return text === '' ? undefined : text
}

const bool: Coerce = (value, field) => {
  if (value === null || value === undefined || value === '') return undefined
  if (typeof value === 'boolean') return value
  const text = String(value).trim().toLowerCase()
  if (['true', 'yes', 'on', '1'].includes(text)) return true
  if (['false', 'no', 'off', '0'].includes(text)) return false
  throw new FieldError(field, `${field} 应为 true/false`)
}

const int = (min: number, max: number): Coerce => (value, field) => {
  if (value === null || value === undefined || value === '') return undefined
  const number = typeof value === 'number' ? value : Number(String(value).trim())
  if (!Number.isSafeInteger(number) || number < min || number > max) throw new FieldError(field, `${field} 应为 ${min}–${max} 的整数`)
  return number
}

const oneOf = (...values: string[]): Coerce => (value, field) => {
  const text = nonEmpty(value, field)
  if (text === undefined) return undefined
  if (!values.includes(String(text))) throw new FieldError(field, `${field} 不支持 ${String(text).slice(0, 40)}`)
  return text
}

const strList: Coerce = (value, field) => {
  if (value === null || value === undefined || value === '') return undefined
  const items = Array.isArray(value) ? value : String(value).split(',')
  if (items.length > 64) throw new FieldError(field, `${field} 过多`)
  const out = items.map(item => str(typeof item === 'string' ? item.trim() : item, field)).filter((item): item is string => typeof item === 'string' && item !== '')
  return out.length ? out : undefined
}

const headerMap: Coerce = (value, field) => {
  if (value === null || value === undefined) return undefined
  if (!isMap(value)) throw new FieldError(field, `${field} 应为映射`)
  const out: Record<string, string> = {}
  for (const [key, raw] of Object.entries(value).slice(0, 32)) {
    if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/.test(key)) continue
    const text = str(raw, field)
    if (typeof text === 'string') out[key] = text
  }
  return Object.keys(out).length ? out : undefined
}

const headerListMap: Coerce = (value, field) => {
  if (value === null || value === undefined) return undefined
  if (!isMap(value)) throw new FieldError(field, `${field} 应为映射`)
  const out: Record<string, string[]> = {}
  for (const [key, raw] of Object.entries(value).slice(0, 32)) {
    if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/.test(key)) continue
    const list = strList(Array.isArray(raw) ? raw : [raw], field)
    if (Array.isArray(list)) out[key] = list as string[]
  }
  return Object.keys(out).length ? out : undefined
}

type Schema = Record<string, Coerce>

const obj = (schema: Schema): Coerce => (value, field) => {
  if (value === null || value === undefined) return undefined
  if (!isMap(value)) throw new FieldError(field, `${field} 应为映射`)
  const out = pick(value, schema, `${field}.`)
  return Object.keys(out).length ? out : undefined
}

function pick(source: Record<string, unknown>, schema: Schema, prefix = ''): ClashNode {
  const out: ClashNode = {}
  for (const [key, coerce] of Object.entries(schema)) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue
    const value = coerce(source[key], `${prefix}${key}`)
    if (value !== undefined) out[key] = value
  }
  return out
}

const reserved: Coerce = (value, field) => {
  if (value === null || value === undefined || value === '') return undefined
  if (typeof value === 'string' && !value.includes(',') && !/^\d+$/.test(value.trim())) return str(value, field)
  const list = Array.isArray(value) ? value : String(value).split(',')
  if (list.length !== 3) throw new FieldError(field, `${field} 应为 3 个数字`)
  return list.map(item => int(0, 255)(typeof item === 'string' ? item.trim() : item, field))
}

const SS_CIPHERS = [
  'aes-128-gcm', 'aes-192-gcm', 'aes-256-gcm', 'chacha20-ietf-poly1305', 'xchacha20-ietf-poly1305',
  '2022-blake3-aes-128-gcm', '2022-blake3-aes-256-gcm', '2022-blake3-chacha20-poly1305', 'none', 'plain', 'dummy',
  'aes-128-cfb', 'aes-192-cfb', 'aes-256-cfb', 'aes-128-ctr', 'aes-192-ctr', 'aes-256-ctr', 'rc4-md5',
  'chacha20', 'chacha20-ietf', 'xchacha20', 'aes-128-ccm', 'aes-256-ccm', 'chacha8-ietf-poly1305', 'xchacha8-ietf-poly1305',
  'lea-128-gcm', 'lea-192-gcm', 'lea-256-gcm', 'rabbit128-poly1305', 'aegis-128l', 'aegis-256', 'aez-384', 'deoxys-ii-256-128',
]

const SSR_CIPHERS = ['none', 'table', 'rc4', 'rc4-md5', 'rc4-md5-6', 'aes-128-cfb', 'aes-192-cfb', 'aes-256-cfb',
  'aes-128-ctr', 'aes-192-ctr', 'aes-256-ctr', 'aes-128-cfb8', 'aes-192-cfb8', 'aes-256-cfb8', 'bf-cfb',
  'camellia-128-cfb', 'camellia-192-cfb', 'camellia-256-cfb', 'salsa20', 'chacha20', 'chacha20-ietf', 'dummy']

const COMMON: Schema = {
  udp: bool,
  'ip-version': oneOf('dual', 'ipv4', 'ipv6', 'ipv4-prefer', 'ipv6-prefer'),
  tfo: bool,
  mptcp: bool,
  smux: obj({
    enabled: bool,
    protocol: oneOf('smux', 'yamux', 'h2mux'),
    'max-connections': int(0, 1024),
    'min-streams': int(0, 1024),
    'max-streams': int(0, 1024),
    padding: bool,
    statistic: bool,
    'only-tcp': bool,
  }),
}

const TLS: Schema = {
  tls: bool,
  'skip-cert-verify': bool,
  fingerprint: nonEmpty,
  'client-fingerprint': oneOf('chrome', 'firefox', 'safari', 'ios', 'android', 'edge', '360', 'qq', 'random', 'randomized', 'none'),
  alpn: strList,
}

const REALITY = obj({ 'public-key': nonEmpty, 'short-id': str, 'support-x25519mlkem768': bool })

const WS = obj({
  path: str,
  headers: headerMap,
  'max-early-data': int(0, 65535),
  'early-data-header-name': str,
  'v2ray-http-upgrade': bool,
  'v2ray-http-upgrade-fast-open': bool,
})
const GRPC = obj({ 'grpc-service-name': str })
const H2 = obj({ host: strList, path: str })
const HTTP_OPTS = obj({ method: str, path: strList, headers: headerListMap })
const XHTTP = obj({ path: str, host: str, mode: oneOf('auto', 'stream-one', 'stream-up', 'packet-up'), headers: headerMap, 'no-grpc-header': bool })

const SERVER: Coerce = (value, field) => {
  const text = nonEmpty(value, field)
  if (typeof text !== 'string') return undefined
  const host = text.trim().replace(/^\[(.*)\]$/, '$1')
  if (host.length > 253 || !/^[A-Za-z0-9._:%~-]+$/.test(host) || host.startsWith('-')) throw new FieldError(field, 'server 不是有效的主机名或地址')
  return host
}

const PORT = int(1, 65535)

const PLUGIN_OPTS = obj({
  mode: str,
  host: str,
  path: str,
  tls: bool,
  mux: bool,
  headers: headerMap,
  'skip-cert-verify': bool,
  fingerprint: nonEmpty,
  password: str,
  version: int(1, 3),
  'version-hint': str,
  'restls-script': str,
  alpn: strList,
  'v2ray-http-upgrade': bool,
  'ech-opts': obj({ enable: bool, config: str }),
})

const SCHEMAS: Record<MihomoType, Schema> = {
  http: { server: SERVER, port: PORT, username: str, password: str, ...TLS, sni: nonEmpty, headers: headerMap, ...COMMON },
  socks5: { server: SERVER, port: PORT, username: str, password: str, tls: bool, 'skip-cert-verify': bool, fingerprint: nonEmpty, ...COMMON },
  ss: {
    server: SERVER, port: PORT, cipher: oneOf(...SS_CIPHERS), password: str,
    'udp-over-tcp': bool, 'udp-over-tcp-version': int(1, 2),
    plugin: oneOf('obfs', 'v2ray-plugin', 'shadow-tls', 'restls', 'gost-plugin', 'kcptun'),
    'plugin-opts': PLUGIN_OPTS, 'client-fingerprint': TLS['client-fingerprint'], ...COMMON,
  },
  ssr: {
    server: SERVER, port: PORT, cipher: oneOf(...SSR_CIPHERS), password: str, obfs: nonEmpty, protocol: nonEmpty,
    'obfs-param': str, 'protocol-param': str, ...COMMON,
  },
  vmess: {
    server: SERVER, port: PORT, uuid: nonEmpty, alterId: int(0, 65535),
    cipher: oneOf('auto', 'none', 'zero', 'aes-128-gcm', 'chacha20-poly1305'),
    ...TLS, servername: nonEmpty, network: oneOf('tcp', 'http', 'h2', 'ws', 'grpc'),
    'ws-opts': WS, 'h2-opts': H2, 'http-opts': HTTP_OPTS, 'grpc-opts': GRPC, 'reality-opts': REALITY,
    'packet-encoding': oneOf('packetaddr', 'xudp', 'none'), 'global-padding': bool, 'authenticated-length': bool, ...COMMON,
  },
  vless: {
    server: SERVER, port: PORT, uuid: nonEmpty, flow: oneOf('xtls-rprx-vision', 'xtls-rprx-vision-udp443'),
    ...TLS, servername: nonEmpty, network: oneOf('tcp', 'ws', 'grpc', 'h2', 'http', 'xhttp'),
    'ws-opts': WS, 'grpc-opts': GRPC, 'h2-opts': H2, 'http-opts': HTTP_OPTS, 'xhttp-opts': XHTTP, 'reality-opts': REALITY,
    'packet-encoding': oneOf('packetaddr', 'xudp', 'none'), encryption: str, ...COMMON,
  },
  trojan: {
    server: SERVER, port: PORT, password: str, sni: nonEmpty, ...TLS, network: oneOf('tcp', 'ws', 'grpc'),
    'ws-opts': WS, 'grpc-opts': GRPC, 'reality-opts': REALITY, 'ss-opts': obj({ enabled: bool, method: str, password: str }), ...COMMON,
  },
  hysteria2: {
    server: SERVER, port: PORT, ports: nonEmpty, 'hop-interval': int(1, 86_400), up: nonEmpty, down: nonEmpty,
    password: str, obfs: oneOf('salamander'), 'obfs-password': str, sni: nonEmpty,
    'skip-cert-verify': bool, fingerprint: nonEmpty, alpn: strList, ...COMMON,
  },
  tuic: {
    server: SERVER, port: PORT, uuid: nonEmpty, password: str, token: nonEmpty, ip: nonEmpty,
    'heartbeat-interval': int(1, 600_000), alpn: strList, 'disable-sni': bool, 'reduce-rtt': bool,
    'request-timeout': int(1, 600_000), 'udp-relay-mode': oneOf('native', 'quic'),
    'congestion-controller': oneOf('cubic', 'new_reno', 'bbr'), 'max-udp-relay-packet-size': int(1, 65535),
    'fast-open': bool, 'skip-cert-verify': bool, 'max-open-streams': int(1, 65535), sni: nonEmpty, ...COMMON,
  },
  wireguard: {
    server: SERVER, port: PORT, ip: nonEmpty, ipv6: nonEmpty, 'private-key': nonEmpty, 'public-key': nonEmpty,
    'pre-shared-key': nonEmpty, reserved, 'allowed-ips': strList, mtu: int(576, 9000),
    'persistent-keepalive': int(0, 65535), 'remote-dns-resolve': bool, dns: strList, ...COMMON,
  },
}

const REQUIRED: Record<MihomoType, string[]> = {
  http: ['server', 'port'],
  socks5: ['server', 'port'],
  ss: ['server', 'port', 'cipher', 'password'],
  ssr: ['server', 'port', 'cipher', 'password', 'obfs', 'protocol'],
  vmess: ['server', 'port', 'uuid'],
  vless: ['server', 'port', 'uuid'],
  trojan: ['server', 'port', 'password'],
  hysteria2: ['server', 'port', 'password'],
  tuic: ['server', 'port'],
  wireguard: ['server', 'port', 'private-key', 'public-key'],
}

const KNOWN_UNSUPPORTED = new Set(['snell', 'mieru', 'anytls', 'ssh', 'hysteria', 'masque', 'direct', 'dns', 'reject',
  'reject-drop', 'pass', 'compatible', 'sudoku', 'trusttunnel', 'relay', 'select', 'url-test', 'fallback', 'load-balance'])

const BANNER_NAME = /剩余|到期|流量|过期|套餐|官网|expire|traffic|remaining|重置|有效期|距离下次/i
const PLACEHOLDER_HOSTS = new Set(['127.0.0.1', '0.0.0.0', 'localhost', '::1', '::'])

export const isLoopbackHost = (host: string) => {
  const value = host.toLowerCase().replace(/^\[(.*)\]$/, '$1')
  return value === 'localhost' || value === '::1' || value.startsWith('127.') || value === '0.0.0.0' || value === '::'
}

/** URL form of a proxy endpoint; IPv6 hosts bracketed, credentials percent-encoded. */
export function buildProxyUrl(scheme: string, host: string, port: number | null, username?: string, password?: string): string {
  const hostPart = host.includes(':') ? `[${host}]` : host
  const auth = username || password
    ? `${encodeURIComponent(username ?? '')}${password !== undefined && password !== '' ? `:${encodeURIComponent(password)}` : ''}@`
    : ''
  return `${scheme}://${auth}${hostPart}${port ? `:${port}` : ''}`
}

const DEFAULT_PORTS: Record<string, number> = { http: 80, https: 443, socks5: 1080 }

export type UrlEndpoint = { scheme: 'http' | 'https' | 'socks5' | 'socks5h'; host: string; port: number; username: string; password: string }

/** Parse an http/https/socks5(h) proxy URL (the account `proxy_url` shape). Null when it is not one. */
export function parseProxyUrl(value: string): UrlEndpoint | null {
  const raw = String(value ?? '').trim()
  const match = /^(https?|socks5h?|socks):\/\//i.exec(raw)
  if (!match) return null
  let url: URL
  try { url = new URL(raw) } catch { return null }
  const scheme = match[1].toLowerCase() === 'socks' ? 'socks5' : match[1].toLowerCase() as UrlEndpoint['scheme']
  const host = url.hostname.replace(/^\[(.*)\]$/, '$1').toLowerCase()
  if (!host) return null
  const family = scheme === 'socks5h' ? 'socks5' : scheme
  const port = url.port ? Number(url.port) : DEFAULT_PORTS[family]
  let username = ''
  let password = ''
  try {
    username = decodeURIComponent(url.username)
    password = decodeURIComponent(url.password)
  } catch {
    return null
  }
  return { scheme, host, port, username, password }
}

/** The dedup key of a url entry: scheme family, host, port (default filled), credential. Contains secrets. */
export function urlDedupKey(endpoint: UrlEndpoint): string {
  const family = endpoint.scheme === 'socks5h' ? 'socks5' : endpoint.scheme
  return [family, endpoint.host, endpoint.port, `${endpoint.username}\u0000${endpoint.password}`].join('|')
}

/** The dedup key of a mihomo node: type, host, port, credential (+ cipher). Transport fields are not part of it. */
export function nodeDedupKey(type: string, node: ClashNode): string {
  const s = (key: string) => (typeof node[key] === 'string' ? String(node[key]) : '')
  let credential = ''
  switch (type) {
    case 'ss': credential = `${s('cipher')}\u0000${s('password')}`; break
    case 'ssr': credential = `${s('cipher')}\u0000${s('password')}\u0000${s('protocol')}\u0000${s('obfs')}`; break
    case 'vmess':
    case 'vless': credential = s('uuid').toLowerCase(); break
    case 'trojan':
    case 'hysteria2': credential = s('password'); break
    case 'tuic': credential = s('token') || `${s('uuid').toLowerCase()}\u0000${s('password')}`; break
    case 'wireguard': credential = s('private-key'); break
    default: credential = `${s('username')}\u0000${s('password')}`
  }
  const family = type === 'http' && node.tls === true ? 'https' : type
  return [family, s('server').toLowerCase(), Number(node.port) || 0, credential].join('|')
}

/** A loopback url, or a node whose name/host marks it as a provider's traffic/expiry banner. */
export function isBannerNode(name: string, server: string): boolean {
  return BANNER_NAME.test(name) || PLACEHOLDER_HOSTS.has(server.toLowerCase())
}

const unsupported = (name: string, type: string, reason: string): ProxyCandidate => ({ name, type, status: 'unsupported', reason })
const invalid = (name: string, type: string, reason: string, extra: Partial<ProxyCandidate> = {}): ProxyCandidate => ({ name, type, status: 'invalid', reason, ...extra })

/**
 * One Clash proxy mapping → candidate. `options.banners` marks provider banner rows as `info` (Clash profiles and
 * subscriptions do this; a pasted single proxy does not).
 */
export function sanitizeClashProxy(raw: unknown, options: { banners?: boolean } = {}): ProxyCandidate {
  if (!isMap(raw)) return invalid('', '', '不是代理对象')
  const name = cleanLabel(raw.name)
  const rawType = typeof raw.type === 'string' ? raw.type.trim().toLowerCase() : ''
  const type = rawType === 'shadowsocks' ? 'ss' : rawType === 'shadowsocksr' ? 'ssr' : rawType === 'socks' ? 'socks5' : rawType === 'hy2' ? 'hysteria2' : rawType
  if (!type) return invalid(name, '', '缺少 type')
  if (!(MIHOMO_TYPES as readonly string[]).includes(type)) {
    return unsupported(name, type, KNOWN_UNSUPPORTED.has(type) || /^[a-z0-9-]{1,24}$/.test(type) ? `不支持的类型 ${type.slice(0, 24)}` : '不支持的类型')
  }
  const mihomoType = type as MihomoType
  if (mihomoType === 'wireguard' && raw.peers !== undefined) return unsupported(name, type, 'wireguard peers 暂不支持')
  let node: ClashNode
  try {
    node = pick(raw, SCHEMAS[mihomoType])
  } catch (error) {
    return invalid(name, type, error instanceof FieldError ? error.message : '字段无效')
  }
  for (const field of REQUIRED[mihomoType]) {
    if (node[field] === undefined || node[field] === '') return invalid(name, type, `缺少字段 ${field}`)
  }
  if (mihomoType === 'tuic' && !node.token && !(node.uuid && node.password)) return invalid(name, type, '缺少字段 uuid/password 或 token')
  if (mihomoType === 'wireguard' && !node.ip && !node.ipv6) return invalid(name, type, '缺少字段 ip')
  if (mihomoType === 'vmess') {
    if (node.alterId === undefined) node.alterId = 0
    if (node.cipher === undefined) node.cipher = 'auto'
  }
  const server = String(node.server)
  const serverPort = Number(node.port)

  // plain http/socks5 without TLS extras is the `url` kind: written to accounts as is
  if (mihomoType === 'socks5' || mihomoType === 'http') {
    const extras = Object.keys(node).filter(key => !['server', 'port', 'username', 'password', 'udp', 'tls'].includes(key))
    const tls = node.tls === true
    if (!extras.length && !(mihomoType === 'socks5' && tls)) {
      const scheme = mihomoType === 'http' ? (tls ? 'https' : 'http') : 'socks5'
      const url = buildProxyUrl(scheme, server, serverPort, node.username as string | undefined, node.password as string | undefined)
      const endpoint = parseProxyUrl(url)
      if (!endpoint) return invalid(name, type, '地址无效')
      return {
        name, type, status: 'ok', kind: 'url', protocol: scheme as ProxyProtocol, url, server, serverPort,
        dedupKey: urlDedupKey(endpoint), external: isLoopbackHost(server) || undefined,
      }
    }
  }
  const protocol: ProxyProtocol = mihomoType === 'http' && node.tls === true ? 'https' : mihomoType
  const candidate: ProxyCandidate = {
    name, type, status: 'ok', kind: 'mihomo', protocol, node, server, serverPort, dedupKey: nodeDedupKey(mihomoType, node),
  }
  if (options.banners && isBannerNode(name, server)) return { ...candidate, status: 'info', reason: '订阅提示行（流量/到期）' }
  return candidate
}

/** Stable JSON (sorted keys) for change detection between a stored node and a re-imported one. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (isMap(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  return JSON.stringify(value ?? null)
}

/** Field names whose values are secrets inside a node (masked in exports and never logged). */
export const NODE_SECRET_FIELD = /password|uuid|token|private-key|pre-shared-key|psk|username|auth|secret|obfs-param|protocol-param/i

/**
 * Transport header values (`ws-opts.headers`, `http-opts.headers`, …) can carry cookies or API keys under any name, so
 * every header except `Host` counts as secret.
 */
const isSecretHeader = (parent: string, key: string) => /^headers$/i.test(parent) && !/^host$/i.test(key)
const UUID_TEXT = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi

/** A copy of the node with every secret value replaced by `***` (masked export). */
export function maskNode(node: ClashNode): ClashNode {
  const walk = (value: unknown, key: string, parent: string, depth: number): unknown => {
    if (depth > 8) return '***'
    const present = value !== undefined && value !== null && value !== ''
    if (present && (NODE_SECRET_FIELD.test(key) || isSecretHeader(parent, key))) return '***'
    if (Array.isArray(value)) return value.map(item => walk(item, key, parent, depth + 1))
    if (isMap(value)) return Object.fromEntries(Object.entries(value).map(([child, inner]) => [child, walk(inner, child, key, depth + 1)]))
    // a uuid is credential-shaped wherever it sits (some providers put it in a ws path)
    if (typeof value === 'string') return value.replace(UUID_TEXT, '***')
    return value
  }
  return walk(node, '', '', 0) as ClashNode
}

/** Every secret string inside a node (for scrubbing logs and asserting responses). */
export function nodeSecrets(node: ClashNode | undefined): string[] {
  const out: string[] = []
  const walk = (value: unknown, key: string, parent: string, depth: number) => {
    if (depth > 8) return
    if (typeof value === 'string' && (NODE_SECRET_FIELD.test(key) || isSecretHeader(parent, key)) && value.length >= 3) out.push(value)
    else if (Array.isArray(value)) value.forEach(item => walk(item, key, parent, depth + 1))
    else if (isMap(value)) Object.entries(value).forEach(([child, inner]) => walk(inner, child, key, depth + 1))
  }
  walk(node, '', '', 0)
  return out
}
