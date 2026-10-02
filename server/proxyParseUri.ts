/**
 * Share links → Clash proxy objects (MIHOMO §7.3), then through the same whitelist as Clash YAML.
 *
 * Covers ss (SIP002 and legacy), ssr, vmess (base64 JSON and URL style), vless, trojan, hysteria2/hy2, tuic,
 * wireguard/wg, socks/socks5/socks5h and http/https. Query strings are decoded by hand: `+` stays `+` (it is part
 * of base64 keys), only percent escapes are decoded. Nothing here throws on garbage: a bad line is an `invalid` row.
 */

import { buildProxyUrl, cleanLabel, isLoopbackHost, parseProxyUrl, sanitizeClashProxy, urlDedupKey, type ProxyCandidate, type ProxyProtocol } from './proxyParseClash.js'

export const URI_SCHEMES = ['ss', 'ssr', 'vmess', 'vless', 'trojan', 'hysteria2', 'hy2', 'tuic', 'wireguard', 'wg', 'socks', 'socks5', 'socks5h', 'http', 'https'] as const

const SCHEME = /^([a-z][a-z0-9+.-]*):\/\//i

export function uriScheme(line: string): string | null {
  return SCHEME.exec(line.trim())?.[1].toLowerCase() ?? null
}

const safeDecode = (value: string): string => {
  try { return decodeURIComponent(value) } catch { return value }
}

/** Standard or URL-safe base64, padded or not, whitespace ignored. Null unless it decodes to valid UTF-8 text. */
export function decodeBase64Text(value: string): string | null {
  const compact = value.replace(/\s+/g, '')
  if (!compact || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(compact)) return null
  const normalized = compact.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '')
  if (normalized.length % 4 === 1) return null
  const buffer = Buffer.from(normalized, 'base64')
  if (!buffer.length) return null
  const text = new TextDecoder('utf-8', { fatal: false }).decode(buffer)
  if (text.includes('�')) return null
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000e-\u001f]/.test(text)) return null
  return text
}

function splitFragment(body: string): { body: string; name: string } {
  const hash = body.indexOf('#')
  if (hash < 0) return { body, name: '' }
  return { body: body.slice(0, hash), name: cleanLabel(safeDecode(body.slice(hash + 1))) }
}

function parseQuery(query: string): Record<string, string> {
  const out: Record<string, string> = Object.create(null)
  for (const part of query.split('&')) {
    if (!part) continue
    const eq = part.indexOf('=')
    const key = safeDecode(eq < 0 ? part : part.slice(0, eq))
    if (!key || key === '__proto__') continue
    out[key] = eq < 0 ? '' : safeDecode(part.slice(eq + 1))
  }
  return out
}

/** `host:port` with optional IPv6 brackets. */
function splitHostPort(value: string): { host: string; port: string } | null {
  const text = value.trim().replace(/\/$/, '')
  const v6 = /^\[([^\]]+)\]:(\d{1,5})$/.exec(text)
  if (v6) return { host: v6[1], port: v6[2] }
  const colon = text.lastIndexOf(':')
  if (colon <= 0) return null
  const host = text.slice(0, colon)
  const port = text.slice(colon + 1)
  if (!/^\d{1,5}$/.test(port) || host.includes(':')) return null
  return { host, port }
}

const truthy = (value: string | undefined) => value !== undefined && ['1', 'true', 'yes'].includes(value.toLowerCase())
const list = (value: string | undefined) => (value ? value.split(',').map(item => item.trim()).filter(Boolean) : undefined)

type Raw = Record<string, unknown>

const invalid = (type: string, reason: string, name = ''): ProxyCandidate => ({ name, type, status: 'invalid', reason })
const unsupported = (type: string, reason: string, name = ''): ProxyCandidate => ({ name, type, status: 'unsupported', reason })

/** URL-shaped links (vless, trojan, hy2, tuic, wireguard, vmess URL style): userinfo, host, port, query, name. */
function urlParts(line: string) {
  const scheme = uriScheme(line) ?? ''
  const { body, name } = splitFragment(line.trim().slice(scheme.length + 3))
  const queryAt = body.indexOf('?')
  const main = (queryAt < 0 ? body : body.slice(0, queryAt)).replace(/\/+$/, '')
  const query = parseQuery(queryAt < 0 ? '' : body.slice(queryAt + 1))
  const at = main.lastIndexOf('@')
  const userinfo = at < 0 ? '' : main.slice(0, at)
  const hostPort = splitHostPort(at < 0 ? main : main.slice(at + 1))
  return { scheme, name, query, userinfo, hostPort }
}

function applyTransport(raw: Raw, type: string, query: Record<string, string>, kind: 'vless' | 'vmess' | 'trojan') {
  let network = (type || 'tcp').toLowerCase()
  if (network === 'httpupgrade') {
    raw.network = 'ws'
    raw['ws-opts'] = { path: query.path || '/', ...(query.host ? { headers: { Host: query.host } } : {}), 'v2ray-http-upgrade': true }
    return null
  }
  if (network === 'splithttp') network = 'xhttp'
  if (['kcp', 'mkcp', 'quic'].includes(network)) return `${kind} ${network} 暂不支持`
  if (network === 'ws') {
    raw.network = 'ws'
    const opts: Raw = { path: query.path || '/' }
    if (query.host) opts.headers = { Host: query.host }
    if (query.ed && /^\d+$/.test(query.ed)) opts['max-early-data'] = query.ed
    raw['ws-opts'] = opts
  } else if (network === 'grpc') {
    if (kind === 'trojan' || kind === 'vless' || kind === 'vmess') raw.network = 'grpc'
    raw['grpc-opts'] = { 'grpc-service-name': query.serviceName || query.path || '' }
  } else if (network === 'h2' || network === 'http') {
    if (kind === 'trojan') return 'trojan h2 暂不支持'
    if (network === 'http' && (query.security === 'none' || !query.security) && kind !== 'vmess') {
      raw.network = 'http'
      raw['http-opts'] = { method: 'GET', path: [query.path || '/'], ...(query.host ? { headers: { Host: [query.host] } } : {}) }
    } else {
      raw.network = 'h2'
      raw['h2-opts'] = { host: query.host ? [query.host] : [], path: query.path || '/' }
    }
  } else if (network === 'xhttp') {
    if (kind !== 'vless') return `${kind} xhttp 暂不支持`
    raw.network = 'xhttp'
    raw['xhttp-opts'] = { path: query.path || '/', ...(query.host ? { host: query.host } : {}), ...(query.mode ? { mode: query.mode } : {}) }
  } else if (network === 'tcp' || network === 'raw') {
    if (query.headerType === 'http') {
      raw.network = 'http'
      raw['http-opts'] = { method: 'GET', path: [query.path || '/'], ...(query.host ? { headers: { Host: [query.host] } } : {}) }
    } else if (kind !== 'trojan') {
      raw.network = 'tcp'
    }
  } else {
    return `${kind} ${network.slice(0, 16)} 暂不支持`
  }
  return null
}

function applySecurity(raw: Raw, query: Record<string, string>, sniField: 'servername' | 'sni') {
  const security = (query.security || '').toLowerCase()
  if (security === 'tls' || security === 'xtls' || security === 'reality') {
    raw.tls = true
    const sni = query.sni || query.peer
    if (sni) raw[sniField] = sni
    if (query.fp) raw['client-fingerprint'] = query.fp
    if (query.alpn) raw.alpn = list(query.alpn)
    if (truthy(query.allowInsecure) || truthy(query.insecure)) raw['skip-cert-verify'] = true
    if (security === 'reality') {
      raw['reality-opts'] = { 'public-key': query.pbk || '', 'short-id': query.sid || '' }
      if (!raw['client-fingerprint']) raw['client-fingerprint'] = 'chrome'
    }
  }
}

function parseVless(line: string): ProxyCandidate {
  const { name, query, userinfo, hostPort } = urlParts(line)
  if (!hostPort || !userinfo) return invalid('vless', '链接缺少地址或 uuid', name)
  const raw: Raw = { name, type: 'vless', server: hostPort.host, port: hostPort.port, uuid: safeDecode(userinfo), udp: true }
  if (query.flow) raw.flow = query.flow
  if (query.encryption && query.encryption !== 'none') raw.encryption = query.encryption
  const problem = applyTransport(raw, query.type, query, 'vless')
  if (problem) return unsupported('vless', problem, name)
  applySecurity(raw, query, 'servername')
  if (query.packetEncoding === 'xudp' || !query.packetEncoding) raw['packet-encoding'] = 'xudp'
  return sanitizeClashProxy(raw, { banners: true })
}

function parseVmess(line: string): ProxyCandidate {
  const { body, name: fragmentName } = splitFragment(line.trim().slice('vmess://'.length))
  const decoded = decodeBase64Text(body)
  if (decoded && decoded.trim().startsWith('{')) {
    let json: Record<string, unknown>
    try { json = JSON.parse(decoded) as Record<string, unknown> } catch { return invalid('vmess', 'vmess JSON 无效') }
    const text = (key: string) => (json[key] === undefined || json[key] === null ? '' : String(json[key]).trim())
    const name = cleanLabel(text('ps')) || fragmentName
    const raw: Raw = {
      name, type: 'vmess', server: text('add'), port: text('port'), uuid: text('id'),
      alterId: text('aid') || '0', cipher: text('scy') || 'auto',
    }
    const net = (text('net') || 'tcp').toLowerCase()
    const query: Record<string, string> = { path: text('path'), host: text('host'), serviceName: text('path'), headerType: text('type') }
    if (net === 'h2' || net === 'http') {
      raw.network = 'h2'
      raw['h2-opts'] = { host: query.host ? query.host.split(',').map(item => item.trim()) : [], path: query.path || '/' }
    } else {
      const problem = applyTransport(raw, net, query, 'vmess')
      if (problem) return unsupported('vmess', problem, name)
    }
    if (text('tls') === 'tls') {
      raw.tls = true
      const sni = text('sni') || text('host')
      if (sni) raw.servername = sni.split(',')[0]
      if (text('fp')) raw['client-fingerprint'] = text('fp')
      if (text('alpn')) raw.alpn = list(text('alpn'))
      if (truthy(text('allowInsecure')) || truthy(text('skip-cert-verify'))) raw['skip-cert-verify'] = true
    }
    return sanitizeClashProxy(raw, { banners: true })
  }
  // newer URL style: vmess://uuid@host:port?type=ws&security=tls#name
  const { name, query, userinfo, hostPort } = urlParts(line)
  if (!hostPort || !userinfo) return invalid('vmess', 'vmess 链接无法解析', name)
  const raw: Raw = { name, type: 'vmess', server: hostPort.host, port: hostPort.port, uuid: safeDecode(userinfo), alterId: query.alterId || query.aid || '0', cipher: query.encryption || 'auto' }
  const problem = applyTransport(raw, query.type, query, 'vmess')
  if (problem) return unsupported('vmess', problem, name)
  applySecurity(raw, query, 'servername')
  return sanitizeClashProxy(raw, { banners: true })
}

function parseTrojan(line: string): ProxyCandidate {
  const { name, query, userinfo, hostPort } = urlParts(line)
  if (!hostPort || !userinfo) return invalid('trojan', '链接缺少地址或密码', name)
  const raw: Raw = { name, type: 'trojan', server: hostPort.host, port: hostPort.port, password: safeDecode(userinfo), udp: true }
  const type = (query.type || 'tcp').toLowerCase()
  if (type !== 'tcp') {
    const problem = applyTransport(raw, type, query, 'trojan')
    if (problem) return unsupported('trojan', problem, name)
  }
  const sni = query.sni || query.peer
  if (sni) raw.sni = sni
  if (query.alpn) raw.alpn = list(query.alpn)
  if (query.fp) raw['client-fingerprint'] = query.fp
  if (truthy(query.allowInsecure) || truthy(query.insecure)) raw['skip-cert-verify'] = true
  if ((query.security || '').toLowerCase() === 'reality') {
    raw['reality-opts'] = { 'public-key': query.pbk || '', 'short-id': query.sid || '' }
    if (!raw['client-fingerprint']) raw['client-fingerprint'] = 'chrome'
  }
  return sanitizeClashProxy(raw, { banners: true })
}

function parseHysteria2(line: string): ProxyCandidate {
  const { name, query, userinfo, hostPort } = urlParts(line)
  if (!hostPort || !userinfo) return invalid('hysteria2', '链接缺少地址或密码', name)
  const raw: Raw = { name, type: 'hysteria2', server: hostPort.host, port: hostPort.port, password: safeDecode(userinfo) }
  if (query.sni) raw.sni = query.sni
  if (truthy(query.insecure)) raw['skip-cert-verify'] = true
  if (query.obfs) raw.obfs = query.obfs
  if (query['obfs-password']) raw['obfs-password'] = query['obfs-password']
  if (query.mport) raw.ports = query.mport
  if (query.alpn) raw.alpn = list(query.alpn)
  if (query.upmbps) raw.up = query.upmbps
  if (query.downmbps) raw.down = query.downmbps
  const pin = (query.pinSHA256 || '').replace(/:/g, '').toLowerCase()
  if (/^[0-9a-f]{64}$/.test(pin)) raw.fingerprint = pin
  return sanitizeClashProxy(raw, { banners: true })
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function parseTuic(line: string): ProxyCandidate {
  const { name, query, userinfo, hostPort } = urlParts(line)
  if (!hostPort || !userinfo) return invalid('tuic', '链接缺少地址或凭据', name)
  const raw: Raw = { name, type: 'tuic', server: hostPort.host, port: hostPort.port }
  const colon = userinfo.indexOf(':')
  if (colon > 0) {
    raw.uuid = safeDecode(userinfo.slice(0, colon))
    raw.password = safeDecode(userinfo.slice(colon + 1))
  } else if (UUID.test(safeDecode(userinfo)) && query.password) {
    raw.uuid = safeDecode(userinfo)
    raw.password = query.password
  } else {
    raw.token = safeDecode(userinfo)
  }
  if (query.congestion_control) raw['congestion-controller'] = query.congestion_control
  if (query.udp_relay_mode) raw['udp-relay-mode'] = query.udp_relay_mode
  if (query.alpn) raw.alpn = list(query.alpn)
  if (query.sni) raw.sni = query.sni
  if (truthy(query.allow_insecure) || truthy(query.insecure) || truthy(query.allowInsecure)) raw['skip-cert-verify'] = true
  if (truthy(query.disable_sni)) raw['disable-sni'] = true
  return sanitizeClashProxy(raw, { banners: true })
}

function parseWireguard(line: string): ProxyCandidate {
  const { name, query, userinfo, hostPort } = urlParts(line)
  if (!hostPort || !userinfo) return invalid('wireguard', '链接缺少地址或私钥', name)
  const raw: Raw = {
    name, type: 'wireguard', server: hostPort.host, port: hostPort.port, 'private-key': safeDecode(userinfo),
    'public-key': query.publickey || query.publicKey || query.peer_public_key || '', udp: true,
    'allowed-ips': ['0.0.0.0/0', '::/0'],
  }
  for (const address of list(query.address || query.ip) ?? []) {
    const bare = address.replace(/\/\d+$/, '')
    if (bare.includes(':')) { if (!raw.ipv6) raw.ipv6 = bare } else if (!raw.ip) raw.ip = bare
  }
  if (query.reserved) raw.reserved = query.reserved
  if (query.mtu) raw.mtu = query.mtu
  const psk = query.presharedkey || query.preSharedKey || query['pre-shared-key']
  if (psk) raw['pre-shared-key'] = psk
  return sanitizeClashProxy(raw, { banners: true })
}

const SS_PLAIN_METHOD = /^[a-z0-9-]+$/

function parseSs(line: string): ProxyCandidate {
  const { body, name } = splitFragment(line.trim().slice('ss://'.length))
  const queryAt = body.indexOf('?')
  let main = (queryAt < 0 ? body : body.slice(0, queryAt)).replace(/\/+$/, '')
  const query = parseQuery(queryAt < 0 ? '' : body.slice(queryAt + 1))
  let method = ''
  let password = ''
  let hostPort: { host: string; port: string } | null = null
  if (!main.includes('@')) {
    // legacy: whole body base64(method:password@host:port)
    const decoded = decodeBase64Text(main)
    if (!decoded) return invalid('ss', 'ss 链接无法解析', name)
    main = decoded.trim()
  }
  const at = main.lastIndexOf('@')
  if (at < 0) return invalid('ss', 'ss 链接缺少地址', name)
  const userinfo = main.slice(0, at)
  hostPort = splitHostPort(main.slice(at + 1))
  if (!hostPort) return invalid('ss', 'ss 链接缺少地址', name)
  const plain = safeDecode(userinfo)
  const plainColon = plain.indexOf(':')
  if (plainColon > 0 && SS_PLAIN_METHOD.test(plain.slice(0, plainColon).toLowerCase()) && !decodeBase64Text(userinfo)?.includes(':')) {
    method = plain.slice(0, plainColon)
    password = plain.slice(plainColon + 1)
  } else {
    const decoded = decodeBase64Text(safeDecode(userinfo))
    const colon = decoded ? decoded.indexOf(':') : -1
    if (!decoded || colon <= 0) {
      if (plainColon > 0) { method = plain.slice(0, plainColon); password = plain.slice(plainColon + 1) } else return invalid('ss', 'ss 链接缺少加密方式或密码', name)
    } else {
      method = decoded.slice(0, colon)
      password = decoded.slice(colon + 1)
    }
  }
  const raw: Raw = { name, type: 'ss', server: hostPort.host, port: hostPort.port, cipher: method.toLowerCase(), password, udp: true }
  if (query.plugin) {
    const parts = query.plugin.split(';')
    const plugin = parts[0].trim().toLowerCase()
    const options: Record<string, string> = {}
    for (const part of parts.slice(1)) {
      const eq = part.indexOf('=')
      options[(eq < 0 ? part : part.slice(0, eq)).trim()] = eq < 0 ? 'true' : part.slice(eq + 1).trim()
    }
    if (plugin === 'obfs-local' || plugin === 'simple-obfs' || plugin === 'obfs') {
      raw.plugin = 'obfs'
      raw['plugin-opts'] = { mode: options.obfs || 'http', ...(options['obfs-host'] ? { host: options['obfs-host'] } : {}) }
    } else if (plugin === 'v2ray-plugin') {
      raw.plugin = 'v2ray-plugin'
      raw['plugin-opts'] = {
        mode: options.mode || 'websocket', ...(options.tls !== undefined ? { tls: true } : {}),
        ...(options.host ? { host: options.host } : {}), ...(options.path ? { path: options.path } : {}),
        ...(options.mux !== undefined ? { mux: truthy(options.mux) || options.mux === 'true' } : {}),
      }
    } else if (plugin === 'shadow-tls') {
      raw.plugin = 'shadow-tls'
      raw['plugin-opts'] = { ...(options.host ? { host: options.host } : {}), ...(options.password ? { password: options.password } : {}), ...(options.version ? { version: options.version } : {}) }
    } else {
      return unsupported('ss', `不支持的 ss 插件 ${plugin.slice(0, 24)}`, name)
    }
  }
  if (truthy(query['udp-over-tcp']) || truthy(query.uot)) raw['udp-over-tcp'] = true
  return sanitizeClashProxy(raw, { banners: true })
}

function parseSsr(line: string): ProxyCandidate {
  const decoded = decodeBase64Text(line.trim().slice('ssr://'.length))
  if (!decoded) return invalid('ssr', 'ssr 链接无法解析')
  const slash = decoded.indexOf('/?')
  const main = slash < 0 ? decoded.replace(/\/$/, '') : decoded.slice(0, slash)
  const params = parseQuery(slash < 0 ? '' : decoded.slice(slash + 2))
  const parts = main.split(':')
  if (parts.length < 6) return invalid('ssr', 'ssr 链接字段不足')
  const passwordB64 = parts.pop() as string
  const obfs = parts.pop() as string
  const method = parts.pop() as string
  const protocol = parts.pop() as string
  const port = parts.pop() as string
  const host = parts.join(':').replace(/^\[(.*)\]$/, '$1')
  const b64 = (value: string | undefined) => (value ? decodeBase64Text(value) ?? '' : '')
  const name = cleanLabel(b64(params.remarks))
  const password = b64(passwordB64)
  if (!password) return invalid('ssr', 'ssr 密码无法解析', name)
  const raw: Raw = { name, type: 'ssr', server: host, port, protocol, cipher: method, obfs, password, udp: true }
  const obfsParam = b64(params.obfsparam)
  const protocolParam = b64(params.protoparam)
  if (obfsParam) raw['obfs-param'] = obfsParam
  if (protocolParam) raw['protocol-param'] = protocolParam
  return sanitizeClashProxy(raw, { banners: true })
}

/** http/https/socks link as a `url` entry. `socks://BASE64(user:pass)@host:port` (v2rayN) is decoded first. */
function parseUrlProxy(line: string): ProxyCandidate {
  const scheme = uriScheme(line) ?? ''
  const { body, name } = splitFragment(line.trim().slice(scheme.length + 3))
  let rest = body
  const at = rest.lastIndexOf('@')
  if ((scheme === 'socks' || scheme === 'socks5') && at > 0 && !rest.slice(0, at).includes(':')) {
    const decoded = decodeBase64Text(safeDecode(rest.slice(0, at)))
    if (decoded && decoded.includes(':')) {
      const colon = decoded.indexOf(':')
      rest = `${encodeURIComponent(decoded.slice(0, colon))}:${encodeURIComponent(decoded.slice(colon + 1))}${rest.slice(at)}`
    }
  }
  const outScheme = scheme === 'socks' ? 'socks5' : scheme
  const endpoint = parseProxyUrl(`${outScheme}://${rest}`)
  if (!endpoint) return invalid(outScheme, '代理地址无效', name)
  const url = buildProxyUrl(endpoint.scheme, endpoint.host, endpoint.port, endpoint.username || undefined, endpoint.password || undefined)
  const protocol: ProxyProtocol = endpoint.scheme === 'socks5h' ? 'socks5' : endpoint.scheme
  return {
    name, type: protocol, status: 'ok', kind: 'url', protocol, url, server: endpoint.host, serverPort: endpoint.port,
    dedupKey: urlDedupKey(endpoint), external: isLoopbackHost(endpoint.host) || undefined,
  }
}

/** One share link → candidate. Unknown schemes are `unsupported`; nothing throws. */
export function parseShareLink(line: string): ProxyCandidate {
  const scheme = uriScheme(line)
  try {
    switch (scheme) {
      case 'ss': return parseSs(line)
      case 'ssr': return parseSsr(line)
      case 'vmess': return parseVmess(line)
      case 'vless': return parseVless(line)
      case 'trojan': return parseTrojan(line)
      case 'hysteria2':
      case 'hy2': return parseHysteria2(line)
      case 'tuic': return parseTuic(line)
      case 'wireguard':
      case 'wg': return parseWireguard(line)
      case 'socks':
      case 'socks5':
      case 'socks5h':
      case 'http':
      case 'https': return parseUrlProxy(line)
      case null: return invalid('', '无法识别的行')
      default: return unsupported(scheme, `不支持的类型 ${scheme.slice(0, 24)}`)
    }
  } catch {
    return invalid(scheme ?? '', '链接无法解析')
  }
}

/** A subscription address: an http(s) URL with a path or query and no userinfo. A bare `scheme://host:port` is a proxy. */
export function isSubscriptionUrl(line: string): boolean {
  const text = line.trim()
  if (!/^https?:\/\//i.test(text) || /\s/.test(text)) return false
  let url: URL
  try { url = new URL(text) } catch { return false }
  if (url.username || url.password) return false
  return (url.pathname !== '' && url.pathname !== '/') || url.search !== ''
}
