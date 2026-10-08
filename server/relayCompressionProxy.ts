import { Agent, createServer, request, ServerResponse, type ClientRequest, type IncomingHttpHeaders, type IncomingMessage } from 'node:http'
import { pipeline } from 'node:stream/promises'
import { isSystemKey } from './systemKeys.js'

/**
 * RTK relay: a loopback HTTP proxy in front of the context guard. Requests from opted-in keys to the
 * inference paths below get their tool outputs compressed; everything else is forwarded unchanged,
 * streamed in both directions. Pure module (no config/db): it also runs inside the relay worker.
 */
const PATHS = new Set(['/v1/messages', '/v1/messages/count_tokens', '/v1/chat/completions', '/v1/responses'])
export const MAX_BODY_BYTES = 100 * 1024 * 1024
/** Larger bodies (inline images and files) stream through uncompressed instead of being held in memory. */
export const MAX_COMPRESS_BYTES = 16 * 1024 * 1024
/** Per-connection hop-by-hop fields; Node re-frames bodies itself. Request Transfer-Encoding is kept (see forward). */
const HOP_BY_HOP = ['connection', 'keep-alive', 'proxy-connection', 'upgrade']

export type RelayFailureStage = 'lookup' | 'compress'

export type RelayDependencies = {
  target: string
  /** True when compression is on and the presented key opted in. Throwing counts as a lookup failure. */
  optedIn: (token: string) => boolean
  /** Rewrites tool outputs in place and returns the removed UTF-8 bytes. Throwing forwards the original body. */
  compress: (body: Record<string, unknown>) => number
  /** A compressed request completed successfully upstream. */
  saved: (savedTokens: number) => void
  /** Compression was skipped because a step failed; the request itself went through unchanged. */
  failed: (stage: RelayFailureStage) => void
  maxBodyBytes?: number
  maxCompressBytes?: number
}

export function relayTarget(value: string): URL {
  let target: URL | undefined
  try { target = new URL(value) } catch { /* reported below */ }
  if (!target || target.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(target.hostname) ||
      target.username || target.password || target.pathname !== '/' || target.search || target.hash) {
    throw new Error('RTK_RELAY_TARGET 必须是本机回环 HTTP 地址（如 http://127.0.0.1:8316）')
  }
  return target
}

function dropSet(headers: IncomingHttpHeaders, extra: readonly string[] = []) {
  const drop = new Set([...HOP_BY_HOP, ...extra])
  for (const name of String(headers.connection || '').split(',')) {
    const field = name.trim().toLowerCase()
    if (field) drop.add(field)
  }
  return drop
}

/** Raw (case- and duplicate-preserving) header pairs without the dropped fields. */
function forward(raw: string[], drop: Set<string>, add: string[] = []) {
  const out: string[] = []
  for (let index = 0; index < raw.length; index += 2) {
    if (!drop.has(raw[index]!.toLowerCase())) out.push(raw[index]!, raw[index + 1]!)
  }
  return out.concat(add)
}

function reply(res: ServerResponse, status: number, code: string) {
  if (res.destroyed) return
  if (res.headersSent) { res.destroy(); return }
  res.writeHead(status, { 'content-type': 'application/json', connection: 'close' })
  res.end(JSON.stringify({ error: { code, message: code } }))
}

class TooLarge extends Error {}

/** Buffers up to `limit` bytes. `ended: false` means the limit was crossed; the request is paused and unread. */
function bufferUpTo(req: IncomingMessage, limit: number) {
  return new Promise<{ chunks: Buffer[]; ended: boolean }>((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    const done = () => { req.off('data', onData); req.off('end', onEnd); req.off('error', onError); req.off('close', onClose) }
    const onData = (chunk: Buffer) => {
      chunks.push(chunk)
      size += chunk.length
      if (size > limit) { req.pause(); done(); resolve({ chunks, ended: false }) }
    }
    const onEnd = () => { done(); resolve({ chunks, ended: true }) }
    const onError = (error: Error) => { done(); reject(error) }
    const onClose = () => { if (!req.complete) { done(); reject(new Error('client closed')) } }
    req.on('data', onData).once('end', onEnd).once('error', onError).once('close', onClose)
  })
}

/**
 * Decides, from the response the client already received unchanged, whether a compressed request
 * completed; HTTP-200 protocol errors and truncated streams record nothing.
 */
class ResponseOutcome {
  failed = false
  complete = false
  private pending = ''
  private readonly decoder = new TextDecoder()

  constructor(private readonly streaming: boolean, private readonly limit: number) {}

  feed(chunk: Uint8Array, final = false) {
    if (this.failed) return
    this.pending += this.decoder.decode(chunk, { stream: !final })
    if (this.pending.length > this.limit) { this.failed = true; this.pending = ''; return }
    if (!this.streaming) {
      if (final) { this.accept(this.pending); this.complete = !this.failed }
      return
    }
    let match: RegExpExecArray | null
    while ((match = /\r?\n\r?\n/.exec(this.pending))) {
      this.frame(this.pending.slice(0, match.index))
      this.pending = this.pending.slice(match.index + match[0].length)
    }
    if (final && this.pending.trim()) this.frame(this.pending)
  }

  private frame(frame: string) {
    const lines = frame.split(/\r?\n/)
    const event = lines.find(line => line.startsWith('event:'))?.slice(6).trim()
    if (event === 'error' || event === 'response.failed' || event === 'response.incomplete') this.failed = true
    if (event === 'message_stop' || event === 'response.completed') this.complete = true
    const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n')
    if (data.trim() === '[DONE]') { this.complete = true; return }
    if (data) this.accept(data)
  }

  private accept(data: string) {
    let value: Record<string, unknown>
    try { value = JSON.parse(data) } catch { this.failed = true; return }
    if (!value || typeof value !== 'object' || Array.isArray(value)) { this.failed = true; return }
    const response = value.response && typeof value.response === 'object'
      ? value.response as Record<string, unknown> : value
    if (value.error || response.error || ['error', 'response.failed', 'response.incomplete'].includes(String(value.type)) ||
        ['failed', 'incomplete'].includes(String(response.status))) this.failed = true
    if (value.type === 'message_stop' || value.type === 'response.completed' || response.status === 'completed') this.complete = true
    if (Array.isArray(value.choices) && value.choices.some(choice => choice && typeof choice === 'object' && choice.finish_reason)) this.complete = true
  }
}

export function createRelayCompressionProxy(deps: RelayDependencies) {
  const target = relayTarget(deps.target)
  const maxBody = deps.maxBodyBytes ?? MAX_BODY_BYTES
  const maxCompress = Math.min(deps.maxCompressBytes ?? MAX_COMPRESS_BYTES, maxBody)
  // One upstream connection per request, like a reverse proxy without an upstream keepalive pool:
  // no reused-socket race with the guard's idle timeout.
  const agent = new Agent({ keepAlive: false })
  const server = createServer({ maxHeaderSize: 64 * 1024, noDelay: true }, (req, res) => { void handle(req, res) })
  // Longer than a reverse proxy's default upstream keepalive (60s), so it never reuses a socket closed here.
  server.keepAliveTimeout = 75_000
  server.headersTimeout = 80_000
  server.requestTimeout = 600_000
  server.on('upgrade', (req, socket, head) => {
    const child = request(target, { method: req.method, path: req.url, headers: req.rawHeaders, agent })
    child.on('error', () => socket.destroy())
    socket.on('error', () => child.destroy())
    socket.once('close', () => child.destroy())
    child.on('upgrade', (upstream, upstreamSocket, upstreamHead) => {
      let head101 = `HTTP/1.1 ${upstream.statusCode} ${upstream.statusMessage}\r\n`
      for (let index = 0; index < upstream.rawHeaders.length; index += 2) head101 += `${upstream.rawHeaders[index]}: ${upstream.rawHeaders[index + 1]}\r\n`
      socket.write(`${head101}\r\n`)
      if (upstreamHead.length) socket.write(upstreamHead)
      if (head.length) upstreamSocket.write(head)
      upstreamSocket.on('error', () => socket.destroy())
      socket.once('close', () => upstreamSocket.destroy())
      upstreamSocket.once('close', () => socket.destroy())
      upstreamSocket.pipe(socket).pipe(upstreamSocket)
    })
    // A refused upgrade (401, 429 …) is an ordinary response; answer it on the client socket as such.
    child.on('response', upstream => {
      const response = new ServerResponse(req)
      response.assignSocket(socket as Parameters<ServerResponse['assignSocket']>[0])
      response.shouldKeepAlive = false
      response.once('finish', () => socket.end())
      response.writeHead(upstream.statusCode || 502, upstream.statusMessage, forward(upstream.rawHeaders, dropSet(upstream.headers, ['transfer-encoding'])))
      void pipeline(upstream, response).catch(() => socket.destroy())
    })
    child.end()
  })
  return server

  function candidate(req: IncomingMessage, pathname: string) {
    if (req.method !== 'POST' || !PATHS.has(pathname)) return ''
    if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers['content-type'] || ''))) return ''
    if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') return ''
    const bearer = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || ''))?.[1]?.trim()
    const apiKey = req.headers['x-api-key']
    const token = bearer || (typeof apiKey === 'string' ? apiKey.trim() : '')
    // The console's own probe / lockout keys: never compressed, never looked up, never counted.
    return isSystemKey(token) ? '' : token
  }

  function fail(stage: RelayFailureStage) {
    try { deps.failed(stage) } catch { /* counting never affects the request */ }
  }

  function optedIn(token: string) {
    try {
      return deps.optedIn(token)
    } catch {
      fail('lookup')
      return false
    }
  }

  /** Compressed body, or null to forward the original bytes. */
  function rewrite(payload: Buffer): { payload: Buffer; savedTokens: number } | null {
    let body: unknown
    // Invalid JSON keeps the upstream's own error response.
    try { body = JSON.parse(payload.toString('utf8')) } catch { return null }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null
    try {
      const savedBytes = deps.compress(body as Record<string, unknown>)
      if (!(savedBytes > 0)) return null
      return { payload: Buffer.from(JSON.stringify(body)), savedTokens: Math.floor(savedBytes / 4) }
    } catch {
      fail('compress')
      return null
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const abort = new AbortController()
    const onClose = () => { if (!res.writableFinished) abort.abort() }
    res.once('close', onClose)
    let child: ClientRequest | undefined
    let tooLarge = false
    try {
      const declared = Number(req.headers['content-length'] || 0)
      if (declared > maxBody) throw new TooLarge()
      const pathname = new URL(req.url || '/', 'http://relay.local').pathname
      const token = candidate(req, pathname)
      let headers = forward(req.rawHeaders, dropSet(req.headers), req.headers.host ? [] : ['Host', target.host])
      let payload: Buffer | undefined
      let prefix: Buffer[] = []
      let savedTokens = 0
      if (token && declared <= maxCompress && optedIn(token)) {
        const buffered = await bufferUpTo(req, maxCompress)
        if (buffered.ended) {
          payload = Buffer.concat(buffered.chunks)
          const rewritten = rewrite(payload)
          if (rewritten) {
            payload = rewritten.payload
            savedTokens = rewritten.savedTokens
            headers = forward(headers, new Set(['content-length', 'transfer-encoding', 'accept-encoding']),
              ['Content-Length', String(payload.length), 'Accept-Encoding', 'identity'])
          }
        } else prefix = buffered.chunks
      }
      const upstream = await new Promise<IncomingMessage>((resolve, reject) => {
        child = request(target, { method: req.method, path: req.url, headers, agent, signal: abort.signal }, resolve)
        child.once('error', reject)
        if (payload) { child.end(payload); return }
        let size = prefix.reduce((total, chunk) => total + chunk.length, 0)
        for (const chunk of prefix) child.write(chunk)
        // Content-Length is enforced by the parser; only a chunked body can grow past the cap.
        req.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > maxBody && !tooLarge) { tooLarge = true; req.unpipe(child); child!.destroy(new TooLarge()) }
        })
        req.once('error', reject)
        req.pipe(child)
      })
      res.writeHead(upstream.statusCode || 502, upstream.statusMessage, forward(upstream.rawHeaders, dropSet(upstream.headers, ['transfer-encoding'])))
      const outcome = savedTokens > 0
        ? new ResponseOutcome(/^text\/event-stream(?:\s*;|$)/i.test(String(upstream.headers['content-type'] || '')), maxCompress)
        : undefined
      if (outcome) upstream.on('data', chunk => outcome.feed(chunk))
      await pipeline(upstream, res)
      outcome?.feed(new Uint8Array(), true)
      if (outcome?.complete && !outcome.failed && (upstream.statusCode || 502) < 400 && !pathname.endsWith('/count_tokens')) {
        try { deps.saved(savedTokens) } catch { /* accounting never affects a delivered response */ }
      }
    } catch (error) {
      if (child) req.unpipe(child)
      child?.destroy()
      req.resume()
      reply(res, tooLarge || error instanceof TooLarge ? 413 : 502, tooLarge || error instanceof TooLarge ? 'request_too_large' : 'relay_unavailable')
    } finally {
      res.off('close', onClose)
    }
  }
}
