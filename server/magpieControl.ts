import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { config, fileBackedSecret } from './config.js'

export type MagpieChannel = {
  name: string
  'base-url': string
  'api-key-entries': Array<{ 'api-key': string; 'proxy-url'?: string }>
  models: Array<{ name: string; alias?: string }>
  protocol?: 'chat' | 'responses' | 'anthropic'
  disabled?: boolean
  'proxy-url'?: string
  headers?: Record<string, string>
}
type State = { version: 1; channels: MagpieChannel[] }
export const magpieCredentialReference = (endpoint: string, identity: string, slot: number) =>
  `cpa:${endpoint}:${createHash('sha256').update(identity).digest('hex').slice(0, 24)}:${slot}`
const secretReference = /^(env:[A-Z_][A-Z0-9_]*|cpa:(openai-compatibility|claude-api-key|codex-api-key):[a-f0-9]{24}:\d{1,3})$/
const sourceCache = new Map<string, { until: number; value: Array<Record<string, unknown>> }>()

export async function readMagpieSource(endpoint: string): Promise<Array<Record<string, unknown>>> {
  if (!['openai-compatibility', 'claude-api-key', 'codex-api-key', 'gemini-api-key', 'vertex-api-key', 'auth-files'].includes(endpoint) ||
      !config.magpieSourceCpaBaseUrl || !config.magpieSourceCpaKey) throw new Error('Read-only CPA credential source is not configured')
  const cached = sourceCache.get(endpoint)
  if (cached && cached.until > Date.now()) return cached.value
  const response = await fetch(`${config.magpieSourceCpaBaseUrl}/v0/management/${endpoint}`, {
    headers: { Authorization: `Bearer ${config.magpieSourceCpaKey}` },
    signal: AbortSignal.timeout(config.cpaRequestTimeoutMs), redirect: 'error',
  })
  if (!response.ok) { await response.body?.cancel(); throw new Error('Read-only CPA credential source unavailable') }
  const chunks: Uint8Array[] = []
  let size = 0
  if (!response.body) throw new Error('Invalid CPA source response')
  for await (const chunk of response.body) {
    size += chunk.length
    if (size > 8 * 1024 * 1024) throw new Error('CPA source response too large')
    chunks.push(chunk)
  }
  const object = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>
  const list = object[endpoint === 'auth-files' ? 'files' : endpoint]
  if (!Array.isArray(list)) throw new Error('Invalid CPA credential source')
  sourceCache.set(endpoint, { until: Date.now() + 5_000, value: list })
  return list
}

export async function resolveMagpieCredential(reference: string) {
  if (reference.startsWith('env:')) return resolveMagpieSecret(reference)
  if (!secretReference.test(reference)) throw new Error('Invalid Magpie credential reference')
  const [, endpoint, digest, rawSlot] = reference.split(':')
  const entries = await readMagpieSource(endpoint)
  for (const entry of entries) {
    const identity = endpoint === 'openai-compatibility' ? String(entry.name) : `${String(entry.prefix || '')}\0${String(entry['base-url'] || '')}`
    if (magpieCredentialReference(endpoint, identity, 0).split(':')[2] !== digest) continue
    const keys = endpoint === 'openai-compatibility'
      ? entry['api-key-entries'] as Array<{ 'api-key'?: unknown }>
      : [{ 'api-key': entry['api-key'] }]
    const value = keys?.[Number(rawSlot)]?.['api-key']
    if (typeof value === 'string' && value && !/[\r\n]/.test(value)) return value
  }
  throw new Error('Referenced upstream credential is unavailable')
}

export function resolveMagpieSecret(reference: string, env = process.env): string {
  const match = /^env:([A-Z_][A-Z0-9_]*)$/.exec(reference)
  if (!match) throw new Error('Magpie upstream credentials require an env:NAME reference')
  const name = match[1]
  const value = fileBackedSecret(name, env[name], env[`${name}_FILE`])
  if (!value || /[\r\n]/.test(value)) throw new Error('Magpie upstream credential is unavailable')
  return value
}

export function validateMagpieChannels(channels: unknown): MagpieChannel[] {
  if (!Array.isArray(channels) || channels.length > 500) throw new Error('Invalid Magpie channels')
  const names = new Set<string>()
  for (const entry of channels) {
    const channel = entry as MagpieChannel
    if (!channel || typeof channel.name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/.test(channel.name) ||
        names.has(channel.name)) throw new Error('Invalid or duplicate Magpie channel name')
    names.add(channel.name)
    const url = new URL(channel['base-url'])
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash ||
        (url.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) throw new Error('Invalid Magpie upstream URL')
    if (channel.protocol && !['chat', 'responses', 'anthropic'].includes(channel.protocol)) throw new Error('Unsupported Magpie upstream protocol')
    if (!Array.isArray(channel.models) || !channel.models.length || channel.models.length > 500 ||
        channel.models.some(model => !model || typeof model.name !== 'string' || !model.name || model.name.length > 200 ||
          (model.alias !== undefined && (typeof model.alias !== 'string' || !model.alias || model.alias.length > 200)))) throw new Error('Invalid Magpie channel models')
    if (!Array.isArray(channel['api-key-entries']) || !channel['api-key-entries'].length ||
        channel['api-key-entries'].some(key => !secretReference.test(key?.['api-key'] || ''))) {
      throw new Error('Use env:NAME for Magpie upstream keys; raw credentials are not persisted')
    }
    if (channel.headers && Object.values(channel.headers).some(value => typeof value !== 'string' || !/^env:[A-Z_][A-Z0-9_]*$/.test(value))) {
      throw new Error('Magpie custom header values require env:NAME references')
    }
    for (const proxy of [channel['proxy-url'], ...channel['api-key-entries'].map(key => key['proxy-url'])]) {
      if (!proxy || proxy === 'direct') continue
      const parsed = new URL(proxy)
      if (!['http:', 'https:', 'socks5:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
        throw new Error('Magpie proxies must not contain credentials or URL parameters')
      }
    }
  }
  // Persist only the registry contract, not arbitrary fields from admin input.
  return channels.map((channel: MagpieChannel) => ({
    name: channel.name, 'base-url': channel['base-url'],
    'api-key-entries': channel['api-key-entries'].map(key => ({
      'api-key': key['api-key'], ...(key['proxy-url'] ? { 'proxy-url': key['proxy-url'] } : {}),
    })),
    models: channel.models.map(model => ({ name: model.name, ...(model.alias ? { alias: model.alias } : {}) })),
    ...(channel.protocol ? { protocol: channel.protocol } : {}),
    ...(channel.disabled !== undefined ? { disabled: channel.disabled } : {}),
    ...(channel['proxy-url'] ? { 'proxy-url': channel['proxy-url'] } : {}),
    ...(channel.headers ? { headers: channel.headers } : {}),
  }))
}

export function readMagpieChannels(): MagpieChannel[] {
  const stat = fs.lstatSync(config.magpieChannelsFile)
  if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw new Error('Invalid Magpie channel registry')
  const state = JSON.parse(fs.readFileSync(config.magpieChannelsFile, 'utf8')) as State
  if (state.version !== 1) throw new Error('Unsupported Magpie channel registry version')
  return validateMagpieChannels(state.channels)
}

function writeChannels(channels: MagpieChannel[]) {
  channels = validateMagpieChannels(channels)
  const filename = config.magpieChannelsFile
  const temporary = `${filename}.${process.pid}.tmp`
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 })
  fs.writeFileSync(temporary, `${JSON.stringify({ version: 1, channels }, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  fs.renameSync(temporary, filename)
}

export class MagpieManagementError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code) }
}

/** Preserve management consumers while SQLite remains the key owner. */
export async function magpieManagementRequest<T>(route: string, init: RequestInit = {}): Promise<T> {
  const { db } = await import('./db.js')
  const url = new URL(route, 'http://local')
  const method = init.method || 'GET'
  const channels = readMagpieChannels()
  let result: unknown
  if (url.pathname === '/api-keys') {
    if (method === 'GET') result = { 'api-keys': db.prepare('SELECT key_value FROM api_keys WHERE enabled=1').all().map(row => row.key_value) }
    // Existing key CRUD and quota enforcement commit their state to SQLite.
    else if (method === 'PUT') result = { ok: true }
  } else if (['/api-key-model-access', '/api-key-channel-access'].includes(url.pathname)) {
    result = method === 'GET' ? {} : { ok: true }
  } else if (url.pathname === '/openai-compatibility') {
    if (method === 'GET') result = { 'openai-compatibility': channels }
    if (method === 'PUT') {
      writeChannels(validateMagpieChannels(JSON.parse(String(init.body))))
      result = { ok: true }
    }
    if (method === 'DELETE') {
      writeChannels(channels.filter(channel => channel.name !== url.searchParams.get('name')))
      result = { ok: true }
    }
  } else if (/^\/(claude|codex|gemini|vertex)-api-key$/.test(url.pathname)) {
    if (method === 'GET') result = { [url.pathname.slice(1)]: [] }
    else throw new MagpieManagementError(501, 'Add a Magpie channel with an explicit protocol and credential reference')
  } else if (url.pathname === '/auth-files' && method === 'GET') {
    result = { files: [] }
  } else if (url.pathname === '/oauth-excluded-models' && method === 'GET') {
    result = { 'oauth-excluded-models': {} }
  } else if (url.pathname === '/proxy-url' && method === 'GET') {
    result = { 'proxy-url': '' }
  } else if (url.pathname === '/usage-queue' && method === 'GET') {
    result = []
  } else if (url.pathname === '/available-models' && method === 'GET') {
    result = { models: channels.filter(channel => !channel.disabled).flatMap(channel =>
      channel.models.map(model => ({ id: model.alias || model.name, provider: channel.name }))) }
  }
  if (result === undefined) throw new MagpieManagementError(501, 'This CPA management operation is not supported by the Magpie kernel')
  return result as T
}
