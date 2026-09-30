import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createServer, request, type IncomingMessage, type ServerResponse } from 'node:http'
import type { CompatChannel, ProviderKeyEntry, UsageRecord } from './cpa.js'
import { DEFAULT_OPEN_CHANNELS } from './keyChannelAccess.js'
import { DEFAULT_OPEN_MODELS } from './keyModelAccess.js'
import { MAGPIE_API_ROUTES, type MagpieRouteId, type Magpie_provider_Provider } from '../packages/contracts/magpie-upstream.generated.js'

export type KernelProvider = Magpie_provider_Provider & {
  id: string; name: string; key: string; keys: Array<{ key: string }>
  models: string[]; chat?: string; responses?: string; anthropic?: string
  proxy: string; headers?: Record<string, string>; routing: string; affinity: string
}
export type MagpieRoute = { channel: string; alias: string; upstream: string; provider: KernelProvider }
export type AdmissionKey = {
  key_value: string; key_hash: string; enabled: number; groups_json: string
  total_concurrency: number; group_concurrency_json: string
}
type KernelUsage = {
  rid: string; t: string; provider: string; model: string; in: number; out: number
  cache_read?: number; cache_write?: number; reasoning?: number; effort?: string
  ms: number; ttft_ms?: number; status: number
}
type Dependencies = {
  socket: string
  port: number
  timeoutMs: number
  routes: () => Promise<MagpieRoute[]>
  key: (token: string) => AdmissionKey | undefined
  exceeded: (key: AdmissionKey) => boolean
  settle: (records: UsageRecord[]) => void
}
class AdmissionError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code) }
}
function reject(status: number, code: string): never { throw new AdmissionError(status, code) }
const modelId = (model: { name?: string; alias?: string }) => String(model.alias || model.name || '')

const admissionRoutes = [
  'inference GET /v1/models', 'inference GET /v1beta/models',
  'inference POST /v1/chat/completions', 'inference POST /v1/responses',
  'inference POST /v1/messages', 'inference POST /v1/messages/count_tokens',
  'inference POST /v1beta/models/{call...}',
] as const satisfies readonly MagpieRouteId[]
const ordinaryPaths = new Set(admissionRoutes.filter(id => id.startsWith('inference POST ') && !id.includes('{'))
  .map(id => id.slice('inference POST '.length)))
const geminiActions = ['generateContent', 'streamGenerateContent', 'countTokens']

/** Upstream changes must pass our policy adapter, not silently widen public access. */
export function assertMagpieAdmissionContract(routes: ReadonlyArray<{ id: string; actions: readonly string[] }> = MAGPIE_API_ROUTES) {
  const byId = new Map(routes.map(route => [route.id, route]))
  if (admissionRoutes.some(id => !byId.has(id)) ||
      geminiActions.some(action => !byId.get('inference POST /v1beta/models/{call...}')?.actions.includes(action))) {
    throw new Error('Upstream inference contract changed; review the Crosery admission adapter')
  }
}

/** Each model slot is explicit, so kernel fallback cannot cross a key's channel policy. */
export function mapMagpieRoutes(channels: CompatChannel[], native: Array<{ endpoint: string; entry: ProviderKeyEntry; name: string }> = []): MagpieRoute[] {
  const all = [
    ...channels.map(channel => ({ channel, protocol: String(channel.protocol || 'chat') })),
    ...native.filter(source => ['claude-api-key', 'codex-api-key'].includes(source.endpoint)).map(source => ({
      channel: {
        name: source.name, 'base-url': source.entry['base-url'] || (source.endpoint === 'claude-api-key' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1'),
        'api-key-entries': [{ ...source.entry, 'api-key': source.entry['api-key'] }],
        models: source.entry.models, disabled: source.entry.disabled,
        'proxy-url': source.entry['proxy-url'], headers: source.entry.headers,
      } as CompatChannel,
      protocol: source.endpoint === 'claude-api-key' ? 'anthropic' : 'responses',
    })),
  ]
  return all.flatMap(({ channel, protocol }) => {
    if (channel.disabled === true || !channel.name) return []
    if (!['chat', 'responses', 'anthropic'].includes(protocol)) throw new Error('Unsupported Magpie upstream protocol')
    const base = new URL(String(channel['base-url'] || ''))
    if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password || base.search || base.hash ||
        (base.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(base.hostname))) throw new Error('Invalid Magpie upstream')
    const keys = (channel['api-key-entries'] || []).filter(entry => Boolean(entry['api-key']))
    if (!keys.length) return []
    // Per-key proxies are not silently collapsed into a single shared proxy.
    const proxies = keys.map(key => String(key['proxy-url'] || channel['proxy-url'] || 'direct'))
    if (new Set(proxies).size !== 1) throw new Error('Mixed upstream-key proxies require separate Magpie channels')
    return (channel.models || []).map((model, index) => {
      if (!model.name || !modelId(model)) throw new Error('Invalid Magpie model mapping')
      const id = `c-${createHash('sha256').update(`${channel.name}\0${model.name}\0${modelId(model)}\0${index}`).digest('hex').slice(0, 24)}`
      const provider: KernelProvider = {
        id, name: String(channel.name), key: String(keys[0]['api-key']),
        keys: keys.slice(1).map(key => ({ key: String(key['api-key']) })),
        models: [model.name], proxy: proxies[0], routing: 'rotate', affinity: 'session',
        headers: channel.headers as Record<string, string> | undefined,
      }
      const endpoint = base.href.replace(/\/+$/, '')
      if (protocol === 'anthropic') provider.anthropic = endpoint.replace(/\/v1$/, '')
      else if (protocol === 'responses') provider.responses = endpoint
      else provider.chat = endpoint
      return { channel: String(channel.name), alias: modelId(model), upstream: model.name, provider }
    })
  })
}

function arrayJSON(raw: string): string[] {
  try {
    const value: unknown = JSON.parse(raw)
    return Array.isArray(value) && value.every(item => typeof item === 'string') ? value : []
  } catch { return [] }
}
export function allowedMagpieRoutes(routes: MagpieRoute[], key: AdmissionKey) {
  if (!key.enabled) return []
  const selected = new Set(arrayJSON(key.groups_json))
  return routes.filter(route => selected.has(route.channel) ||
    ((DEFAULT_OPEN_CHANNELS as readonly string[]).includes(route.channel) && (DEFAULT_OPEN_MODELS as readonly string[]).includes(route.alias)))
}

export function kernelJSON(socket: string, route: string, method = 'GET', body?: unknown): Promise<unknown> {
  return new Promise((resolve, rejectRequest) => {
    const req = request({ socketPath: socket, path: route, method, headers: { 'content-type': 'application/json' }, timeout: 10_000 }, res => {
      const chunks: Buffer[] = []
      let bytes = 0
      res.on('data', chunk => {
        bytes += chunk.length
        if (bytes > 4 * 1024 * 1024) req.destroy(new Error('Kernel response too large'))
        else chunks.push(chunk)
      })
      res.once('end', () => {
        if ((res.statusCode || 500) >= 300) return rejectRequest(new Error('Magpie kernel control request failed'))
        try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null) } catch { rejectRequest(new Error('Invalid kernel response')) }
      })
      res.once('error', rejectRequest)
    })
    req.once('timeout', () => req.destroy(new Error('Kernel control timeout')))
    req.once('error', rejectRequest)
    req.end(body === undefined ? undefined : JSON.stringify(body))
  })
}

function respond(res: ServerResponse, status: number, code: string) {
  if (res.headersSent) { res.destroy(); return }
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify({ error: { type: 'crosery_gateway_error', code, message: code } }))
}
function readKey(req: IncomingMessage, url: URL) {
  const tokens = [
    /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '')?.[1],
    req.headers['x-api-key'], req.headers['x-goog-api-key'], url.searchParams.get('key'),
  ].filter((value): value is string => typeof value === 'string' && Boolean(value))
  if (!tokens.length || new Set(tokens).size !== 1) reject(401, 'invalid_api_key')
  return tokens[0]
}
async function readBody(req: IncomingMessage) {
  let bytes = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    bytes += chunk.length
    if (bytes > 8 * 1024 * 1024) reject(413, 'request_too_large')
    chunks.push(Buffer.from(chunk))
  }
  let body: Record<string, unknown>
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return reject(400, 'invalid_json') }
  if (!body || typeof body !== 'object' || Array.isArray(body)) reject(400, 'invalid_json')
  // URL media fetching belongs behind an egress policy, not an unrestricted kernel.
  const unsafeMedia = (value: unknown): boolean => {
    if (!value || typeof value !== 'object') return false
    if (Array.isArray(value)) return value.some(unsafeMedia)
    const entry = value as Record<string, unknown>
    if (entry.encrypted_content) reject(501, 'stateful_responses_not_supported')
    if (entry.type === 'url' && typeof entry.url === 'string') return true
    for (const field of ['image_url', 'file_url', 'file_uri', 'fileUri']) {
      const raw = entry[field]
      const url = typeof raw === 'string' ? raw : raw && typeof raw === 'object' ? (raw as Record<string, unknown>).url : ''
      if (typeof url === 'string' && url && !url.startsWith('data:')) return true
    }
    return Object.values(entry).some(unsafeMedia)
  }
  if (unsafeMedia(body)) reject(400, 'remote_media_not_supported')
  if (body.background === true || body.previous_response_id || body.encrypted_content) reject(501, 'stateful_responses_not_supported')
  if (Array.isArray(body.tools) && body.tools.some(tool => {
    const kind = (tool as { type?: unknown })?.type
    return typeof kind === 'string' && kind !== 'function'
  })) reject(501, 'builtin_tools_not_supported')
  return body
}

export function createMagpieAdmission(deps: Dependencies) {
  assertMagpieAdmissionContract()
  const activeKeys = new Map<string, number>()
  const activeGroups = new Map<string, number>()
  const rotation = new Map<string, number>()
  let accountingUnavailable = false
  let signature = ''
  let updates: Promise<unknown> = Promise.resolve()
  async function configure(routes: MagpieRoute[]) {
    const providers = routes.map(route => route.provider)
    const hash = createHash('sha256').update(JSON.stringify(providers)).digest('hex')
    const next = updates.then(async () => {
      if (hash !== signature) {
        await kernelJSON(deps.socket, '/internal/providers', 'PUT', providers)
        signature = hash
      }
    })
    updates = next.catch(() => {})
    await next
  }
  return createServer((req, res) => { void handle(req, res) })
  async function handle(req: IncomingMessage, res: ServerResponse) {
    const abort = new AbortController()
    const started = Date.now()
    const id = `magpie-${randomUUID()}`
    const timer = setTimeout(() => { abort.abort(); if (!req.complete) req.destroy() }, deps.timeoutMs)
    timer.unref()
    const onClose = () => { if (!res.writableEnded) abort.abort() }
    res.once('close', onClose)
    let release: (() => void) | undefined
    let record: UsageRecord | undefined
    let settled = false
    const settle = (records: UsageRecord[]) => {
      try { deps.settle(records); settled = true } catch {
        accountingUnavailable = true
        reject(503, 'accounting_unavailable')
      }
    }
    try {
      if (req.headers.host !== `127.0.0.1:${deps.port || req.socket.localPort}` || req.headers.origin || req.headers['sec-fetch-site'] === 'cross-site') reject(403, 'local_only')
      const url = new URL(req.url || '/', 'http://local')
      if (req.method === 'GET' && url.pathname === '/health') {
        const health = await kernelJSON(deps.socket, '/internal/health')
        res.writeHead(accountingUnavailable ? 503 : 200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ...health as object, accountingAvailable: !accountingUnavailable }))
        return
      }
      if (accountingUnavailable) reject(503, 'accounting_unavailable')
      const token = readKey(req, url)
      let key = deps.key(token)
      if (!key?.enabled) reject(401, 'invalid_api_key')
      if (deps.exceeded(key)) reject(429, 'quota_exceeded')
      const routes = await deps.routes()
      // Revocation and quota changes must win over an in-flight configuration read.
      key = deps.key(token)
      if (!key?.enabled) reject(401, 'invalid_api_key')
      if (deps.exceeded(key)) reject(429, 'quota_exceeded')
      const allowed = allowedMagpieRoutes(routes, key)
      if (req.method === 'GET' && ['/v1/models', '/v1beta/models'].includes(url.pathname)) {
        const ids = [...new Set(allowed.map(route => route.alias))].sort()
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        res.end(JSON.stringify(url.pathname === '/v1/models'
          ? { object: 'list', data: ids.map(model => ({ id: model, object: 'model', owned_by: 'crosery' })) }
          : { models: ids.map(model => ({ name: `models/${model}`, supportedGenerationMethods: ['generateContent', 'countTokens'] })) }))
        return
      }
      const gemini = /^\/v1beta\/models\/(.+):([^/:]+)$/.exec(url.pathname)
      const ordinary = ordinaryPaths.has(url.pathname)
      if (req.method !== 'POST' || (!ordinary && !(gemini && geminiActions.includes(gemini[2])))) reject(404, 'route_not_supported')
      const body = await readBody(req)
      const model = gemini ? gemini[1] : body.model
      if (typeof model !== 'string' || !model || model.length > 200) reject(400, 'model_required')
      const matches = allowed.filter(route => route.alias === model)
      if (!matches.length) reject(403, 'model_not_allowed')
      const rotationKey = `${key.key_hash}:${model}`
      const position = rotation.get(rotationKey) || 0
      const target = matches[position % matches.length]
      rotation.set(rotationKey, position + 1)
      const groupKey = `${key.key_hash}:${target.channel}`
      const current = activeKeys.get(key.key_hash) || 0
      let groupLimits: Record<string, number> = {}
      try { groupLimits = JSON.parse(key.group_concurrency_json) } catch { reject(503, 'invalid_concurrency_policy') }
      const groupActive = activeGroups.get(groupKey) || 0
      if (key.total_concurrency !== 0 && (current >= key.total_concurrency ||
          groupActive >= (groupLimits[target.channel] || key.total_concurrency))) reject(429, 'concurrency_exceeded')
      activeKeys.set(key.key_hash, current + 1)
      activeGroups.set(groupKey, groupActive + 1)
      release = () => {
        activeKeys.set(key!.key_hash, (activeKeys.get(key!.key_hash) || 1) - 1)
        activeGroups.set(groupKey, (activeGroups.get(groupKey) || 1) - 1)
      }
      await configure(routes)
      const nowKey = deps.key(token)
      if (!nowKey?.enabled || !allowedMagpieRoutes([target], nowKey).length) reject(403, 'channel_not_allowed')
      if (deps.exceeded(nowKey)) reject(429, 'quota_exceeded')
      const kernelModel = `${target.provider.id}/${target.upstream}`
      const kernelPath = gemini ? `/v1beta/models/${kernelModel}:${gemini[2]}${url.searchParams.get('alt') === 'sse' ? '?alt=sse' : ''}` : url.pathname
      const payload = JSON.stringify(gemini ? body : { ...body, model: kernelModel })
      record = {
        request_id: id, timestamp: new Date().toISOString(), api_key: token, provider: target.channel,
        model: target.upstream, alias: model, endpoint: url.pathname, source: 'magpie-kernel',
        user_agent: req.headers['user-agent'], client_ip: req.socket.remoteAddress,
      }
      const headers: Record<string, string> = {
        'content-type': 'application/json', authorization: 'Bearer magpie', 'x-crosery-request-id': id,
      }
      for (const name of ['user-agent', 'x-magpie-session', 'session_id', 'x-session-id', 'anthropic-version', 'anthropic-beta']) {
        const value = req.headers[name]
        if (typeof value === 'string') headers[name] = value
      }
      const upstream = await new Promise<IncomingMessage>((resolve, rejectRequest) => {
        const child = request({ socketPath: deps.socket, path: kernelPath, method: 'POST', headers, signal: abort.signal }, resolve)
        child.once('error', rejectRequest)
        child.end(payload)
      })
      const status = upstream.statusCode || 502
      res.writeHead(status, { 'content-type': upstream.headers['content-type'] || 'application/json',
        'cache-control': 'no-store', 'x-accel-buffering': 'no', 'x-crosery-engine': 'magpie' })
      for await (const chunk of upstream) {
        if (!record.ttft_ms) record.ttft_ms = Date.now() - started
        if (!res.write(chunk)) await once(res, 'drain', { signal: abort.signal })
      }
      let usage: KernelUsage[]
      try { usage = JSON.parse(String(upstream.trailers['x-crosery-usage'] || '')) } catch { reject(502, 'kernel_accounting_missing') }
      if (!Array.isArray(usage!)) reject(502, 'kernel_accounting_invalid')
      const count = url.pathname.endsWith('/count_tokens') || gemini?.[2] === 'countTokens'
      if (!usage!.length && !count && status < 400) reject(502, 'kernel_accounting_missing')
      const records = usage!.map((use, index): UsageRecord => {
        if (use.rid !== id || use.provider !== target.provider.id ||
            [use.in, use.out, use.cache_read || 0, use.cache_write || 0, use.reasoning || 0].some(value => !Number.isSafeInteger(value) || value < 0)) reject(502, 'kernel_accounting_invalid')
        return { ...record!, request_id: `${id}-${index}`, latency_ms: use.ms,
          ttft_ms: use.ttft_ms || record!.ttft_ms, reasoning_effort: use.effort,
          failed: use.status >= 400, ...(use.status >= 400 ? { fail: { status_code: use.status, body: 'kernel_request_failed' } } : {}),
          tokens: { input_tokens: use.in + (target.provider.anthropic ? 0 : use.cache_read || 0),
            output_tokens: use.out, cached_tokens: use.cache_read || 0, cache_read_tokens: use.cache_read || 0,
            cache_creation_tokens: use.cache_write || 0, reasoning_tokens: use.reasoning || 0,
            total_tokens: use.in + use.out + (use.cache_read || 0) + (use.cache_write || 0) },
        }
      })
      if (records.length) settle(records)
      else if (!count) settle([{ ...record, latency_ms: Date.now() - started, failed: true, fail: { status_code: status, body: 'kernel_request_failed' } }])
      res.end()
    } catch (error) {
      abort.abort()
      const status = error instanceof AdmissionError ? error.status : abort.signal.aborted ? 502 : 503
      const code = error instanceof AdmissionError ? error.code : 'kernel_unavailable'
      if (record && !settled) {
        try { settle([{ ...record, latency_ms: Date.now() - started, failed: true, fail: { status_code: status, body: code } }]) } catch { accountingUnavailable = true }
      }
      respond(res, status, code)
    } finally {
      release?.()
      clearTimeout(timer)
      res.off('close', onClose)
    }
  }
}
