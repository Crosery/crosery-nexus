import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { Agent, request as httpsRequest } from 'node:https'
import { Readable } from 'node:stream'
import { config } from './config.js'
import { db } from './db.js'
import { getCPAKeys, getChannelAccess, getCompatChannels, getGlobalProxy, getModelAccess, hashKey, modelId, type UsageRecord } from './cpa.js'
import { quotaStateFor, type KeyQuotaRow } from './quotaEnforcer.js'
import { persistUsageRecords } from './sync.js'
import type { ConsoleGroup } from './groups.js'
import { listGroups } from './channels.js'

type ObjectValue = Record<string, unknown>
const object = (value: unknown): ObjectValue | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : null
const MAX_BYTES = 64 * 1024 * 1024
let accountingUnavailable = false
class NativeError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code) }
}
function reject(status: number, code: string): never { throw new NativeError(status, code) }
const stringList = (value: unknown): string[] => Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : []
const tokenCount = (value: unknown): number => {
  if (value === undefined) return 0
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) reject(502, 'invalid_native_usage')
  return value
}
const strings = (value: string): string[] => { try { return stringList(JSON.parse(value)) } catch { return [] } }

/** Streaming inspection never changes bytes delivered to the caller. */
export class ResponsesUsage {
  tokens: UsageRecord['tokens'] | undefined
  responseId = ''
  completed = false
  failed = false
  response: ObjectValue | undefined
  private pending = ''
  private readonly decoder = new TextDecoder()

  accept(value: unknown) {
    const event = object(value)
    if (!event) return
    const response = object(event.response) || event
    if (typeof response.id === 'string') this.responseId = response.id
    if (event.type === 'response.completed' || response.status === 'completed') {
      this.completed = true
      this.response = response
    }
    if (event.type === 'response.failed' || event.type === 'error' || response.status === 'failed' || response.status === 'incomplete') this.failed = true
    const usage = object(response.usage)
    if (!usage) return
    this.tokens = {
      input_tokens: tokenCount(usage.input_tokens), output_tokens: tokenCount(usage.output_tokens),
      cached_tokens: tokenCount(object(usage.input_tokens_details)?.cached_tokens),
      reasoning_tokens: tokenCount(object(usage.output_tokens_details)?.reasoning_tokens),
      total_tokens: tokenCount(usage.total_tokens),
    }
  }

  feed(chunk: Uint8Array, final = false) {
    this.pending += this.decoder.decode(chunk, { stream: !final })
    if (this.pending.length > MAX_BYTES) reject(502, 'native_event_too_large')
    let match: RegExpExecArray | null
    while ((match = /\r?\n\r?\n/.exec(this.pending))) {
      this.event(this.pending.slice(0, match.index))
      this.pending = this.pending.slice(match.index + match[0].length)
    }
    if (final && this.pending.trim()) { this.event(this.pending); this.pending = '' }
  }

  private event(frame: string) {
    const data = frame.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).replace(/^ /, '')).join('\n')
    if (!data || data === '[DONE]') return
    try { this.accept(JSON.parse(data)) } catch { reject(502, 'invalid_native_event') }
  }
}

type KeyRow = KeyQuotaRow & { groups_json: string }
async function authorize(key: string, model: string) {
  const row = db.prepare('SELECT * FROM api_keys WHERE key_hash=?').get(hashKey(key)) as KeyRow | undefined
  if (!row || !row.enabled) reject(401, 'invalid_api_key')
  if (quotaStateFor(row).exceeded) reject(429, 'quota_exceeded')
  const channelName = config.nativeResponsesChannel
  const policyGroup = config.nativeResponsesGroup || channelName
  if (!strings(row.groups_json).includes(policyGroup)) reject(403, 'channel_not_allowed')
  if (!['cpa', 'console'].includes(config.nativeResponsesPolicySource)) reject(503, 'invalid_native_policy_source')
  // Console mode is an explicit deployment decision, never a fallback from CPA errors.
  const [keys, channels, globalProxy, groups, cpaPolicy] = await Promise.all([
    getCPAKeys(), getCompatChannels(), getGlobalProxy({ required: true }), listGroups(),
    config.nativeResponsesPolicySource === 'cpa' ? Promise.all([getChannelAccess(), getModelAccess()]) : null,
  ])
  if (!keys.includes(key)) reject(401, 'invalid_api_key')
  if (config.nativeResponsesPolicySource === 'console') {
    const response = await fetch(`${config.cpaBaseUrl}/v1/models`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(config.nativeResponsesTimeoutMs), redirect: 'error',
    })
    if (!response.ok) {
      await response.body?.cancel()
      reject(503, 'native_model_policy_unavailable')
    }
    const catalogue = object(await response.json())
    if (!Array.isArray(catalogue?.data) || !catalogue.data.some((item) => object(item)?.id === model)) reject(403, 'model_not_allowed')
  }
  if (cpaPolicy) {
    const [access, modelAccess] = cpaPolicy
    const allowedChannels = stringList(access[key])
    if (allowedChannels.includes('__console_no_channels_allowed__') || !allowedChannels.includes(policyGroup)) reject(403, 'channel_not_allowed')
    if (!Object.hasOwn(modelAccess, key) || !stringList(modelAccess[key]).includes(model)) reject(403, 'model_not_allowed')
  }
  if (!groups.some((group) => group.id === policyGroup && group.models.includes(model))) reject(403, 'model_not_allowed')
  const channel = channels.find((entry) => entry.name === channelName && entry.disabled !== true)
  if (!channel) reject(503, 'native_channel_unavailable')
  const selected = channel.models?.find((entry) => modelId(entry) === model)
  if (!selected?.name) reject(403, 'model_not_allowed')
  const channelState = db.prepare('SELECT enabled FROM channel_states WHERE name=?').get(channelName) as { enabled: number } | undefined
  const modelState = db.prepare('SELECT enabled FROM channel_model_states WHERE channel=? AND model=?').get(channelName, model) as { enabled: number } | undefined
  if (channelState?.enabled === 0 || modelState?.enabled === 0) reject(403, 'model_not_allowed')
  const base = new URL(String(channel['base-url'] || ''))
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) reject(503, 'invalid_native_upstream')
  const entry = channel['api-key-entries']?.find((item) => Boolean(item['api-key']))
  if (!entry?.['api-key']) reject(503, 'native_credentials_unavailable')
  const configuredProxy = String(object(entry)?.['proxy-url'] || channel['proxy-url'] || globalProxy).trim()
  const proxy = configuredProxy === 'direct' ? '' : configuredProxy
  if (proxy && !['http:', 'https:'].includes(new URL(proxy).protocol)) reject(503, 'native_proxy_not_supported')
  const headers = new Headers()
  for (const [name, value] of Object.entries(object(channel.headers) || {})) {
    if (typeof value !== 'string') reject(503, 'invalid_native_headers')
    if (!['host', 'content-length', 'connection', 'transfer-encoding', 'authorization'].includes(name.toLowerCase())) headers.set(name, value)
  }
  headers.set('Authorization', `Bearer ${entry['api-key']}`)
  headers.set('Content-Type', 'application/json')
  headers.set('Accept-Encoding', 'identity')
  const group: ConsoleGroup = { id: channelName, name: channelName, kind: 'compat', color: '', models: channel.models?.map(modelId) || [] }
  // Recheck local policy after asynchronous management reads before admitting the request.
  const current = db.prepare('SELECT * FROM api_keys WHERE key_hash=?').get(hashKey(key)) as KeyRow | undefined
  if (!current?.enabled || !strings(current.groups_json).includes(policyGroup)) reject(403, 'channel_not_allowed')
  if (quotaStateFor(current).exceeded) reject(429, 'quota_exceeded')
  return { url: `${base.href.replace(/\/$/, '')}/responses`, headers, upstreamModel: selected.name, group, proxy }
}

/** Request-scoped proxy agent avoids changing management/ordinary requests or global env. */
async function requestNative(url: string, headers: Headers, body: string, signal: AbortSignal, proxy: string): Promise<Response> {
  const agent = new Agent({ keepAlive: false, proxyEnv: { HTTPS_PROXY: proxy, NO_PROXY: '' } })
  try {
    const incoming = await new Promise<IncomingMessage>((resolve, rejectRequest) => {
      const request = httpsRequest(url, { method: 'POST', headers: Object.fromEntries(headers), agent, signal }, resolve)
      request.once('error', rejectRequest)
      request.end(body)
    })
    incoming.once('close', () => agent.destroy())
    const responseHeaders = new Headers()
    for (const [name, value] of Object.entries(incoming.headers)) {
      if (Array.isArray(value)) for (const item of value) responseHeaders.append(name, item)
      else if (value !== undefined) responseHeaders.set(name, value)
    }
    const status = incoming.statusCode || 502
    if ([204, 205, 304].includes(status)) {
      incoming.resume()
      return new Response(null, { status, headers: responseHeaders })
    }
    return new Response(Readable.toWeb(incoming) as ReadableStream<Uint8Array>, { status, headers: responseHeaders })
  } catch (error) {
    agent.destroy()
    throw error
  }
}

async function readBody(req: IncomingMessage) {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BYTES) reject(413, 'request_too_large')
    chunks.push(Buffer.from(chunk))
  }
  let body: ObjectValue | null
  try { body = object(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch { return reject(400, 'invalid_json') }
  if (!body || typeof body.model !== 'string' || !body.model.trim()) reject(400, 'model_required')
  if (!Array.isArray(body.tools) || !body.tools.some((tool) => ['web_search', 'web_search_preview'].includes(String(object(tool)?.type)))) reject(400, 'web_search_required')
  if (body.background === true) reject(400, 'background_not_supported')
  return body
}

function reply(res: ServerResponse, status: number, code: string) {
  if (res.destroyed) return
  if (res.headersSent) { res.destroy(); return }
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify({ error: { type: 'native_responses_error', code, message: code } }))
}

/** Bind only loopback. Public traffic must retain the shared nginx admission layer. */
export function startNativeResponsesServer() {
  if (!['cpa', 'console'].includes(config.nativeResponsesPolicySource)) {
    throw new Error('NATIVE_RESPONSES_POLICY_SOURCE must be cpa or console')
  }
  if (!Number.isInteger(config.nativeResponsesPort) || config.nativeResponsesPort < 1 || config.nativeResponsesPort > 65535 || config.nativeResponsesPort === config.port) {
    throw new Error('Native Responses requires a valid dedicated port distinct from the console port')
  }
  if (!config.nativeResponsesChannel.trim() || config.nativeResponsesChannel !== config.nativeResponsesChannel.trim() || /[\r\n\0]/.test(config.nativeResponsesChannel)) {
    throw new Error('NATIVE_RESPONSES_CHANNEL must be a nonempty channel name without surrounding whitespace')
  }
  if (config.nativeResponsesGroup !== config.nativeResponsesGroup.trim() || /[\r\n\0]/.test(config.nativeResponsesGroup)) {
    throw new Error('NATIVE_RESPONSES_GROUP must be an exact group name without surrounding whitespace')
  }
  const server = createServer((req, res) => { void handleNativeResponses(req, res) })
  server.on('error', (error: NodeJS.ErrnoException) => {
    accountingUnavailable = true
    console.error(JSON.stringify({ event: 'native_listener_failed', code: error.code || 'UNKNOWN' }))
    server.close()
  })
  server.requestTimeout = config.nativeResponsesTimeoutMs
  server.headersTimeout = 30_000
  server.listen(config.nativeResponsesPort, '127.0.0.1')
  return server
}

export async function handleNativeResponses(req: IncomingMessage, res: ServerResponse, transport = requestNative) {
  if (accountingUnavailable) { reply(res, 503, 'native_accounting_unavailable'); return }
  if (req.method !== 'POST' || req.url !== '/native/responses') { reply(res, 404, 'not_found'); return }
  const abort = new AbortController()
  const onClose = () => { if (!res.writableEnded) abort.abort() }
  res.once('close', onClose)
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    abort.abort()
    if (!req.complete) req.destroy()
  }, config.nativeResponsesTimeoutMs)
  timer.unref()
  let record: UsageRecord | undefined
  let group: ConsoleGroup | undefined
  let settled = false
  const usage = new ResponsesUsage()
  const started = Date.now()
  const settle = (failed: boolean, status: number, code = '') => {
    if (!record || !group || settled) return
    persistUsageRecords([{ ...record, tokens: usage.tokens, latency_ms: Date.now() - started, failed,
      ...(failed ? { fail: { status_code: status, body: code } } : {}),
      response_headers: usage.responseId ? { 'x-request-id': usage.responseId } : record.response_headers,
    }], [group])
    settled = true
  }
  try {
    const key = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '')?.[1]
    if (!key) reject(401, 'invalid_api_key')
    const body = await readBody(req)
    const model = String(body.model)
    const target = await authorize(key, model)
    group = target.group
    abort.signal.throwIfAborted()
    record = { request_id: `native-${randomUUID()}`, timestamp: new Date().toISOString(), api_key: key, provider: group.id,
      model: target.upstreamModel, alias: model, endpoint: '/v1/responses', source: 'native-responses',
      user_agent: req.headers['user-agent'], client_ip: req.socket.remoteAddress,
      x_forwarded_for: typeof req.headers['x-forwarded-for'] === 'string' ? req.headers['x-forwarded-for'] : undefined,
      reasoning_effort: typeof object(body.reasoning)?.effort === 'string' ? String(object(body.reasoning)?.effort) : undefined,
    }
    const upstream = await transport(target.url, target.headers,
      JSON.stringify({ ...body, model: target.upstreamModel }), abort.signal, target.proxy)
    if (!upstream.ok) {
      await upstream.body?.cancel()
      settle(true, upstream.status, 'native_upstream_error')
      reply(res, upstream.status, 'native_upstream_error')
      return
    }
    if (!upstream.body) reject(502, 'empty_native_response')
    const streaming = upstream.headers.get('content-type')?.includes('text/event-stream') === true
    if (body.stream === true && !streaming) reject(502, 'native_stream_expected')
    record.response_headers = { 'x-request-id': upstream.headers.get('x-request-id') || '' }
    if (streaming) {
      if (body.stream === true) res.writeHead(upstream.status, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' })
      for await (const chunk of upstream.body) {
        if (!record.ttft_ms) record.ttft_ms = Date.now() - started
        usage.feed(chunk)
        if (body.stream === true && !res.write(chunk)) await once(res, 'drain', { signal: abort.signal })
      }
      usage.feed(new Uint8Array(), true)
    } else {
      const chunks: Uint8Array[] = []
      let size = 0
      for await (const chunk of upstream.body) {
        size += chunk.length
        if (size > MAX_BYTES) reject(502, 'native_response_too_large')
        chunks.push(chunk)
      }
      const bytes = Buffer.concat(chunks)
      let parsed: unknown
      try { parsed = JSON.parse(bytes.toString('utf8')) } catch { reject(502, 'invalid_native_json') }
      usage.accept(parsed)
      if (!usage.tokens) reject(502, 'native_usage_missing')
      settle(usage.failed, usage.failed ? 502 : upstream.status, usage.failed ? 'native_response_failed' : '')
      res.writeHead(upstream.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      res.end(bytes)
      return
    }
    if (!usage.tokens || !usage.completed) reject(502, 'native_usage_incomplete')
    settle(usage.failed, usage.failed ? 502 : upstream.status, usage.failed ? 'native_response_failed' : '')
    if (body.stream === true) res.end()
    else {
      res.writeHead(upstream.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify(usage.response))
    }
  } catch (error) {
    abort.abort()
    const status = error instanceof NativeError ? error.status : timedOut ? 504 : res.destroyed ? 499 : 502
    const code = error instanceof NativeError ? error.code : timedOut ? 'native_timeout' : status === 499 ? 'native_cancelled' : 'native_request_failed'
    try { settle(true, status, code) } catch {
      // Never silently continue serving a route whose durable accounting has failed.
      accountingUnavailable = true
      console.error(JSON.stringify({ event: 'native_accounting_failed', requestId: record?.request_id }))
    }
    reply(res, status === 499 ? 502 : status, code)
  } finally {
    clearTimeout(timer)
    res.off('close', onClose)
  }
}
