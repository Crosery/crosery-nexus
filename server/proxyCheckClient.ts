import http from 'node:http'
import net from 'node:net'
import tls from 'node:tls'

/**
 * The console's own probe client (PROXY-SPEC §6 "Client"): node built-ins only, no env proxies, no cookies, no tokens.
 *
 * 1. Tunnel: SOCKS5 (RFC 1928 + RFC 1929 user/pass; the target hostname is always sent unresolved, which is what CPA's
 *    Go dialer does for both `socks5://` and `socks5h://`), or an http(s) proxy with `CONNECT` + `Proxy-Authorization`.
 * 2. `tls.connect({socket, servername})` for https targets (certificates verified).
 * 3. One `GET`, generic UA, `Accept-Encoding: identity`; status, headers and at most 16 KiB of body are kept.
 *
 * Failures are typed: proxy-auth-failed · proxy-down · upstream · dns · tls · timeout, each with the stage it happened in
 * (`proxy` = reaching/authenticating to the proxy itself, `target` = after the proxy accepted us).
 */

export type ProxyEndpoint =
  | { kind: 'direct' }
  | { kind: 'socks5'; host: string; port: number; username?: string; password?: string }
  | { kind: 'http'; tls: boolean; host: string; port: number; username?: string; password?: string }

export type ProbeFailure = 'proxy-auth-failed' | 'proxy-down' | 'upstream' | 'dns' | 'tls' | 'timeout'

export class ProbeError extends Error {
  constructor(readonly code: ProbeFailure, readonly stage: 'proxy' | 'target', message: string = code) {
    super(message)
    this.name = 'ProbeError'
  }
}

export type ProbeResponse = { status: number; headers: Record<string, string>; body: string; ms: number }

export type ProbeRequestOptions = {
  connectTimeoutMs?: number
  totalTimeoutMs?: number
  maxBodyBytes?: number
  userAgent?: string
  /** Test-only TLS overrides (e.g. a private CA). Production never passes this. */
  tls?: Pick<tls.ConnectionOptions, 'ca'>
}

export const PROBE_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'

const PROXY_SCHEMES: Record<string, 'socks5' | 'http' | 'https'> = { 'socks5:': 'socks5', 'socks5h:': 'socks5', 'socks:': 'socks5', 'http:': 'http', 'https:': 'https' }

/** Parses an account-style proxy URL. `null`, `''` and `direct` mean a direct connection. Throws on anything else invalid. */
export function parseProxyEndpoint(url: string | null | undefined): ProxyEndpoint {
  const raw = String(url ?? '').trim()
  if (!raw || raw.toLowerCase() === 'direct' || raw.toLowerCase() === 'none') return { kind: 'direct' }
  let parsed: URL
  try { parsed = new URL(raw) } catch { throw new Error('代理地址无效') }
  const scheme = PROXY_SCHEMES[parsed.protocol]
  if (!scheme || !parsed.hostname) throw new Error('代理地址无效')
  const host = parsed.hostname.replace(/^\[(.*)\]$/, '$1')
  const defaultPort = scheme === 'socks5' ? 1080 : scheme === 'https' ? 443 : 80
  const port = parsed.port ? Number(parsed.port) : defaultPort
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('代理地址无效')
  const decode = (value: string) => { try { return decodeURIComponent(value) } catch { return value } }
  const credentials = parsed.username || parsed.password ? { username: decode(parsed.username), password: decode(parsed.password) } : {}
  return scheme === 'socks5' ? { kind: 'socks5', host, port, ...credentials } : { kind: 'http', tls: scheme === 'https', host, port, ...credentials }
}

const DNS_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL', 'EAI_NONAME', 'EAI_NODATA'])
const DOWN_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'EADDRNOTAVAIL', 'ECONNABORTED'])

function classifySocketError(error: unknown, stage: 'proxy' | 'target'): ProbeError {
  if (error instanceof ProbeError) return error
  const code = String((error as NodeJS.ErrnoException)?.code ?? '')
  if (DNS_CODES.has(code)) return new ProbeError('dns', stage)
  if (code === 'ETIMEDOUT') return new ProbeError('timeout', stage)
  if (stage === 'proxy' && DOWN_CODES.has(code)) return new ProbeError('proxy-down', stage)
  return new ProbeError(stage === 'proxy' ? 'proxy-down' : 'upstream', stage)
}

/** Buffered exact reads over a socket during handshakes; leftover bytes are pushed back with `unshift`. */
class HandshakeReader {
  private buffer = Buffer.alloc(0)
  private waiter: { size: number; resolve: (value: Buffer) => void; reject: (error: unknown) => void; until?: Buffer } | null = null
  private failure: unknown = null
  private readonly onData = (chunk: Buffer) => { this.buffer = Buffer.concat([this.buffer, chunk]); this.pump() }
  private readonly onEnd = () => this.fail(new ProbeError('upstream', this.stage, 'closed'))
  private readonly onError = (error: unknown) => this.fail(classifySocketError(error, this.stage))

  constructor(private readonly socket: net.Socket | tls.TLSSocket, private stage: 'proxy' | 'target') {
    socket.on('data', this.onData)
    socket.once('end', this.onEnd)
    socket.once('close', this.onEnd)
    socket.on('error', this.onError)
  }

  setStage(stage: 'proxy' | 'target') { this.stage = stage }

  private fail(error: unknown) {
    this.failure ??= error
    const waiter = this.waiter
    this.waiter = null
    waiter?.reject(this.failure)
  }

  private pump() {
    const waiter = this.waiter
    if (!waiter) return
    if (waiter.until) {
      const index = this.buffer.indexOf(waiter.until)
      if (index >= 0) {
        const end = index + waiter.until.length
        const value = this.buffer.subarray(0, end)
        this.buffer = this.buffer.subarray(end)
        this.waiter = null
        waiter.resolve(value)
      } else if (this.buffer.length > waiter.size) {
        this.waiter = null
        waiter.reject(new ProbeError('upstream', this.stage, 'oversized handshake'))
      }
      return
    }
    if (this.buffer.length >= waiter.size) {
      const value = this.buffer.subarray(0, waiter.size)
      this.buffer = this.buffer.subarray(waiter.size)
      this.waiter = null
      waiter.resolve(value)
    }
  }

  read(size: number): Promise<Buffer> {
    if (this.failure && this.buffer.length < size) return Promise.reject(this.failure)
    return new Promise((resolve, reject) => {
      this.waiter = { size, resolve, reject }
      this.pump()
    })
  }

  readUntil(marker: string, max: number): Promise<Buffer> {
    if (this.failure) return Promise.reject(this.failure)
    return new Promise((resolve, reject) => {
      this.waiter = { size: max, resolve, reject, until: Buffer.from(marker) }
      this.pump()
    })
  }

  release() {
    this.socket.off('data', this.onData)
    this.socket.off('end', this.onEnd)
    this.socket.off('close', this.onEnd)
    this.socket.off('error', this.onError)
    if (this.buffer.length) this.socket.unshift(this.buffer)
    this.buffer = Buffer.alloc(0)
  }
}

function tcpConnect(host: string, port: number, stage: 'proxy' | 'target'): { socket: net.Socket; ready: Promise<void> } {
  const socket = net.connect({ host, port })
  socket.setNoDelay(true)
  const ready = new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('error', (error) => reject(classifySocketError(error, stage)))
  })
  return { socket, ready }
}

const SOCKS_UPSTREAM_REPLIES = new Map<number, string>([[1, 'general failure'], [2, 'not allowed'], [3, 'network unreachable'], [4, 'host unreachable'], [5, 'connection refused'], [6, 'ttl expired'], [7, 'command not supported'], [8, 'address type not supported']])

async function socksConnect(socket: net.Socket, proxy: Extract<ProxyEndpoint, { kind: 'socks5' }>, host: string, port: number): Promise<void> {
  const reader = new HandshakeReader(socket, 'proxy')
  try {
    const withAuth = proxy.username !== undefined || proxy.password !== undefined
    socket.write(Buffer.from(withAuth ? [5, 2, 0, 2] : [5, 1, 0]))
    const [version, method] = await reader.read(2)
    if (version !== 5) throw new ProbeError('proxy-down', 'proxy', 'not a socks5 proxy')
    if (method === 0xff) throw new ProbeError('proxy-auth-failed', 'proxy', 'no acceptable auth method')
    if (method === 2) {
      if (!withAuth) throw new ProbeError('proxy-auth-failed', 'proxy', 'proxy requires auth')
      const user = Buffer.from(proxy.username ?? '')
      const pass = Buffer.from(proxy.password ?? '')
      if (user.length > 255 || pass.length > 255) throw new ProbeError('proxy-auth-failed', 'proxy', 'credential too long')
      socket.write(Buffer.concat([Buffer.from([1, user.length]), user, Buffer.from([pass.length]), pass]))
      const [, status] = await reader.read(2)
      if (status !== 0) throw new ProbeError('proxy-auth-failed', 'proxy', 'auth rejected')
    } else if (method !== 0) {
      throw new ProbeError('proxy-auth-failed', 'proxy', 'unsupported auth method')
    }
    const ipVersion = net.isIP(host)
    const address = ipVersion === 4
      ? Buffer.from([1, ...host.split('.').map(Number)])
      : ipVersion === 6
        ? Buffer.concat([Buffer.from([4]), ipv6Bytes(host)])
        : Buffer.concat([Buffer.from([3, Buffer.byteLength(host)]), Buffer.from(host)])
    socket.write(Buffer.concat([Buffer.from([5, 1, 0]), address, Buffer.from([port >> 8, port & 0xff])]))
    reader.setStage('target')
    const head = await reader.read(4)
    if (head[0] !== 5) throw new ProbeError('upstream', 'target', 'bad socks reply')
    if (head[1] !== 0) throw new ProbeError(head[1] === 6 ? 'timeout' : 'upstream', 'target', `socks ${SOCKS_UPSTREAM_REPLIES.get(head[1]) ?? `reply ${head[1]}`}`)
    const addressLength = head[3] === 1 ? 4 : head[3] === 4 ? 16 : (await reader.read(1))[0]
    await reader.read(addressLength + 2)
  } finally {
    reader.release()
  }
}

function ipv6Bytes(address: string): Buffer {
  const [head, tail = ''] = address.split('::')
  const left = head ? head.split(':') : []
  const right = tail ? tail.split(':') : []
  const groups = address.includes('::') ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left
  return Buffer.from(groups.flatMap(group => { const value = parseInt(group || '0', 16); return [value >> 8, value & 0xff] }))
}

async function httpConnect(socket: net.Socket | tls.TLSSocket, proxy: Extract<ProxyEndpoint, { kind: 'http' }>, host: string, port: number): Promise<void> {
  const reader = new HandshakeReader(socket, 'proxy')
  try {
    const authority = `${net.isIP(host) === 6 ? `[${host}]` : host}:${port}`
    const auth = proxy.username !== undefined || proxy.password !== undefined
      ? `Proxy-Authorization: Basic ${Buffer.from(`${proxy.username ?? ''}:${proxy.password ?? ''}`).toString('base64')}\r\n`
      : ''
    socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${auth}Proxy-Connection: keep-alive\r\n\r\n`)
    const head = (await reader.readUntil('\r\n\r\n', 16 * 1024)).toString('latin1')
    const status = Number(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/.exec(head)?.[1] ?? 0)
    if (status === 407) throw new ProbeError('proxy-auth-failed', 'proxy', 'proxy 407')
    if (!status) throw new ProbeError('proxy-down', 'proxy', 'not an http proxy')
    if (status < 200 || status >= 300) throw new ProbeError(status === 504 ? 'timeout' : 'upstream', 'target', `proxy CONNECT ${status}`)
  } finally {
    reader.release()
  }
}

const TLS_UPSTREAM = /socket disconnected|ECONNRESET|EPIPE|socket hang up/i

function tlsHandshake(socket: net.Socket, servername: string, extra: ProbeRequestOptions['tls'], stage: 'proxy' | 'target'): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const secure = tls.connect({
      socket,
      servername: net.isIP(servername) ? undefined : servername,
      ALPNProtocols: ['http/1.1'],
      ...(extra ?? {}),
    })
    secure.once('secureConnect', () => resolve(secure))
    secure.once('error', (error: NodeJS.ErrnoException) => {
      // A tunnel that closes before the server says anything is the exit failing to reach the host, not a TLS problem.
      const message = `${error?.code ?? ''} ${error?.message ?? ''}`
      reject(TLS_UPSTREAM.test(message) ? new ProbeError(stage === 'proxy' ? 'proxy-down' : 'upstream', stage) : new ProbeError('tls', stage, String(error?.code ?? 'tls')))
    })
  })
}

/**
 * One GET through `proxy`. Never consults HTTP(S)_PROXY / ALL_PROXY / NO_PROXY: the path is exactly the account's path.
 */
export async function probeRequest(proxy: ProxyEndpoint, target: string, options: ProbeRequestOptions = {}): Promise<ProbeResponse> {
  const url = new URL(target)
  const secure = url.protocol === 'https:'
  if (!secure && url.protocol !== 'http:') throw new Error('unsupported target')
  const host = url.hostname.replace(/^\[(.*)\]$/, '$1')
  const port = url.port ? Number(url.port) : secure ? 443 : 80
  const connectTimeoutMs = options.connectTimeoutMs ?? 6_000
  const totalTimeoutMs = options.totalTimeoutMs ?? 10_000
  const maxBody = options.maxBodyBytes ?? 16 * 1024
  const started = performance.now()
  const sockets: net.Socket[] = []
  let stage: 'proxy' | 'target' = proxy.kind === 'direct' ? 'target' : 'proxy'
  let timer: ReturnType<typeof setTimeout> | null = null
  const timeout = (ms: number) => new Promise<never>((_, reject) => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => reject(new ProbeError('timeout', stage)), Math.max(1, ms))
    timer.unref?.()
  })
  try {
    const connect = async (): Promise<net.Socket> => {
      if (proxy.kind === 'direct') {
        const { socket, ready } = tcpConnect(host, port, 'target')
        sockets.push(socket)
        await ready
        return secure ? track(await tlsHandshake(socket, host, options.tls, 'target')) : socket
      }
      const { socket, ready } = tcpConnect(proxy.host, proxy.port, 'proxy')
      sockets.push(socket)
      await ready
      let tunnel: net.Socket = socket
      if (proxy.kind === 'socks5') {
        await socksConnect(socket, proxy, host, port)
      } else {
        if (proxy.tls) tunnel = track(await tlsHandshake(socket, proxy.host, undefined, 'proxy'))
        await httpConnect(tunnel, proxy, host, port)
      }
      stage = 'target'
      return secure ? track(await tlsHandshake(tunnel, host, options.tls, 'target')) : tunnel
    }
    const track = (socket: tls.TLSSocket) => { sockets.push(socket); return socket }
    const socket = await Promise.race([connect(), timeout(connectTimeoutMs)])
    stage = 'target'
    const remaining = totalTimeoutMs - (performance.now() - started)
    return await Promise.race([requestOver(socket, url, host, options.userAgent ?? PROBE_USER_AGENT, maxBody, started), timeout(remaining)])
  } finally {
    if (timer) clearTimeout(timer)
    for (const socket of sockets) socket.destroy()
  }
}

function requestOver(socket: net.Socket, url: URL, host: string, userAgent: string, maxBody: number, started: number): Promise<ProbeResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      method: 'GET',
      host,
      path: `${url.pathname}${url.search}`,
      headers: { host: url.host, 'user-agent': userAgent, accept: '*/*', 'accept-encoding': 'identity', connection: 'close' },
      createConnection: () => socket,
    }, (res) => {
      const ms = Math.round(performance.now() - started)
      const headers: Record<string, string> = {}
      for (const [name, value] of Object.entries(res.headers)) headers[name] = Array.isArray(value) ? value.join(', ') : String(value ?? '')
      const chunks: Buffer[] = []
      let bytes = 0
      let settled = false
      const done = () => {
        if (settled) return
        settled = true
        resolve({ status: res.statusCode ?? 0, headers, body: Buffer.concat(chunks).toString('utf8'), ms })
      }
      res.on('data', (chunk: Buffer) => {
        if (bytes >= maxBody) return
        chunks.push(chunk.subarray(0, maxBody - bytes))
        bytes += chunk.length
        if (bytes >= maxBody) { done(); res.destroy() }
      })
      res.once('end', done)
      res.once('close', done)
      res.once('error', done)
    })
    req.once('error', (error) => reject(classifySocketError(error, 'target')))
    req.end()
  })
}
