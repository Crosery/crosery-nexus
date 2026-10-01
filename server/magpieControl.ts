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
  if (!fs.existsSync(config.magpieChannelsFile)) return []
  const stat = fs.lstatSync(config.magpieChannelsFile)
  if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw new Error('Invalid Magpie channel registry')
  const state = JSON.parse(fs.readFileSync(config.magpieChannelsFile, 'utf8')) as State
  if (state.version !== 1) throw new Error('Unsupported Magpie channel registry version')
  return validateMagpieChannels(state.channels)
}

export function writeChannels(channels: MagpieChannel[]) {
  channels = validateMagpieChannels(channels)
  const filename = config.magpieChannelsFile
  const temporary = `${filename}.${process.pid}.tmp`
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 })
  fs.writeFileSync(temporary, `${JSON.stringify({ version: 1, channels }, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  fs.renameSync(temporary, filename)
}

const authFilesDir = () => path.join(config.dataDir, 'auth-files')

/* ────────────────────────── 凭据文件名的单点校验（task-61，fail closed） ────────────────────────── */

/**
 * 红队第十七轮在 `/api/credentials/:name` 上实测出路径穿越：`name` 一路拼到
 * `path.join(authFilesDir, name)` + `unlinkSync` / `readFileSync`，
 * 于是 `..%2F..%2Fcanary.txt` 能**越界删除/读取 DATA_DIR 之外的文件**。
 *
 * 这里做**单点收口**：`saveLocalAuthFile` / `deleteLocalAuthFile` / `getLocalAuthFile` /
 * `setLocalAuthFileStatus` / `setLocalAuthFileProxy` 全部先过 `authFilePath()`，
 * 任何调用方（HTTP 路由、OAuth 回调、上传、管理面转发）都自动受保护。
 * 校验失败一律抛错（不静默跳过），路由层再补一道入参校验给出明确的 400 reason。
 */
function realPathOf(target: string): string {
  const resolved = path.resolve(target)
  let current = resolved
  const tail: string[] = []
  for (;;) {
    try {
      const real = fs.realpathSync(current)
      return tail.length ? path.join(real, ...tail.reverse()) : real
    } catch {
      const parent = path.dirname(current)
      if (parent === current) return resolved
      tail.push(path.basename(current))
      current = parent
    }
  }
}

const insideDir = (parent: string, child: string) => child === parent || child.startsWith(parent + path.sep)

/** 凭据文件名必须是**单段**：非空、无分隔符（`/` `\`）、无 NUL、非 `.`/`..`、非绝对路径。 */
export function assertAuthFileName(name: unknown): string {
  if (typeof name !== 'string' || !name.trim()) {
    throw new MagpieManagementError(400, 'credential_name_invalid')
  }
  const value = name.trim()
  if (value === '.' || value === '..' || value.includes('/') || value.includes('\\')
    || value.includes('\0') || path.isAbsolute(value)) {
    throw new MagpieManagementError(400, 'credential_name_invalid')
  }
  return value
}

/**
 * 解析凭据文件路径并确认它**确实在 auth-files 目录内**：
 * 形状（单段）→ 解析前缀 → realpath（防软链逃逸）→ nlink（防硬链接绕过 realpath）。
 */
export function authFilePath(name: unknown): string {
  const safe = assertAuthFileName(name)
  const dir = path.resolve(authFilesDir())
  const target = path.resolve(dir, safe)
  if (!insideDir(dir, target)) throw new MagpieManagementError(400, 'credential_path_escape')
  const realDir = realPathOf(dir)
  const realTarget = realPathOf(target)
  if (!insideDir(realDir, realTarget)) throw new MagpieManagementError(400, 'credential_path_escape')
  // 硬链接：realpath 看不出（路径确实在目录内），但它与目录外的文件是同一个 inode —— 凭据文件不该有多个链接
  try {
    if (fs.lstatSync(target).nlink > 1) throw new MagpieManagementError(400, 'credential_hardlink_rejected')
  } catch (error) {
    if (error instanceof MagpieManagementError) throw error
    if ((error as { code?: string }).code !== 'ENOENT') throw new MagpieManagementError(400, 'credential_path_invalid')
  }
  return target
}

const authFilesMetaFile = () => path.join(config.dataDir, 'auth-files-meta.json')
const oauthExcludedModelsFile = () => path.join(config.dataDir, 'oauth-excluded-models.json')

export function readExcludedModels(): Record<string, string[]> {
  try {
    const file = oauthExcludedModelsFile()
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch { /* ignore */ }
  return {}
}

export function writeExcludedModels(map: Record<string, string[]>) {
  const file = oauthExcludedModelsFile()
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  fs.writeFileSync(file, JSON.stringify(map, null, 2), { mode: 0o600 })
}

export function readAuthFilesMeta(): Record<string, { disabled?: boolean; proxy_url?: string }> {
  try {
    const file = authFilesMetaFile()
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch { /* ignore */ }
  return {}
}

export function writeAuthFilesMeta(meta: Record<string, { disabled?: boolean; proxy_url?: string }>) {
  const file = authFilesMetaFile()
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  fs.writeFileSync(file, JSON.stringify(meta, null, 2), { mode: 0o600 })
}

export function listLocalAuthFiles(): Array<Record<string, unknown>> {
  const dir = authFilesDir()
  if (!fs.existsSync(dir)) return []
  const meta = readAuthFilesMeta()
  const files: Array<Record<string, unknown>> = []

  try {
    const entries = fs.readdirSync(dir)
    for (const name of entries) {
      if (!name.endsWith('.json')) continue
      const fullPath = path.join(dir, name)
      try {
        const raw = fs.readFileSync(fullPath, 'utf8')
        const data = JSON.parse(raw) as Record<string, unknown>
        const fileMeta = meta[name] || {}
        files.push({
          name,
          filename: name,
          type: data.type || data.provider || 'oauth',
          provider: data.provider || data.type || 'oauth',
          email: data.email || data.account || '',
          account: data.account || data.email || '',
          disabled: Boolean(fileMeta.disabled ?? data.disabled),
          status: 'active',
          proxy_url: fileMeta.proxy_url ?? data.proxy_url ?? '',
          ...data,
        })
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }

  return files
}

export function saveLocalAuthFile(name: string, content: Buffer | string) {
  const filePath = authFilePath(name) // 单点校验：越界/软链/硬链接一律拒绝
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 })
  fs.writeFileSync(filePath, content, { mode: 0o600 })
}

export function deleteLocalAuthFile(name: string) {
  const safe = assertAuthFileName(name)   // 先把名字校验完，再碰文件系统（顺序本身也是安全属性）
  const filePath = authFilePath(safe)     // 非法名字直接抛错（不静默「删了个不存在的文件」）
  try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath) } catch { /* ignore */ }
  const meta = readAuthFilesMeta()
  if (meta[safe]) {
    delete meta[safe]
    writeAuthFilesMeta(meta)
  }
}

export function setLocalAuthFileStatus(name: string, disabled: boolean) {
  const safe = assertAuthFileName(name)
  const meta = readAuthFilesMeta()
  meta[safe] = { ...meta[safe], disabled }
  writeAuthFilesMeta(meta)
}

export function setLocalAuthFileProxy(name: string, proxyUrl: string) {
  const safe = assertAuthFileName(name)
  const meta = readAuthFilesMeta()
  meta[safe] = { ...meta[safe], proxy_url: proxyUrl }
  writeAuthFilesMeta(meta)
}

export function getLocalAuthFile(name: string): Record<string, unknown> | null {
  const filePath = authFilePath(name) // 单点校验：越界读取同样拒绝
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'))
    }
  } catch { /* ignore */ }
  return null
}

const DEFAULT_TYPE_MODELS: Record<string, string[]> = {
  claude: ['claude-opus-5', 'claude-sonnet-4-6', 'claude-haiku-4-5', 'claude-haiku-4-5-20251001'],
  anthropic: ['claude-opus-5', 'claude-sonnet-4-6', 'claude-haiku-4-5', 'claude-haiku-4-5-20251001'],
  codex: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'],
  openai: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'],
  antigravity: ['gemini-3.8-flash', 'gemini-3.8-pro', 'gemini-3.1-pro', 'gemini-3.1-flash'],
  gemini: ['gemini-3.8-flash', 'gemini-3.8-pro', 'gemini-3.1-pro', 'gemini-3.1-flash'],
  google: ['gemini-3.8-flash', 'gemini-3.8-pro', 'gemini-3.1-pro', 'gemini-3.1-flash'],
  xai: ['grok-4.5', 'grok-4.6'],
  grok: ['grok-4.5', 'grok-4.6'],
}

export function getLocalAuthFileModels(name: string): string[] {
  const file = getLocalAuthFile(name)
  const type = String(file?.type || file?.provider || '').toLowerCase()
  return DEFAULT_TYPE_MODELS[type] || ['default-model']
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
  } else if (url.pathname === '/auth-files') {
    if (method === 'GET') result = { files: listLocalAuthFiles() }
    else if (method === 'DELETE') {
      deleteLocalAuthFile(String(url.searchParams.get('name') || ''))
      result = { ok: true }
    }
  } else if (url.pathname === '/auth-files/status' && method === 'PUT') {
    const body = JSON.parse(String(init.body)) as { name: string; disabled: boolean }
    setLocalAuthFileStatus(body.name, Boolean(body.disabled))
    result = { ok: true }
  } else if (url.pathname === '/auth-files/proxy' && method === 'PUT') {
    const body = JSON.parse(String(init.body)) as { name: string; proxy_url: string }
    setLocalAuthFileProxy(body.name, String(body.proxy_url || ''))
    result = { ok: true }
  } else if (url.pathname === '/auth-files/models' && method === 'GET') {
    const name = url.searchParams.get('name') || ''
    const models = getLocalAuthFileModels(name)
    result = { models: models.map(id => ({ id })) }
  } else if (url.pathname === '/auth-files/download' && method === 'GET') {
    const name = url.searchParams.get('name') || ''
    result = getLocalAuthFile(name)
  } else if (url.pathname === '/oauth-excluded-models') {
    if (method === 'GET') result = { 'oauth-excluded-models': readExcludedModels() }
    else if (method === 'PUT') {
      writeExcludedModels(JSON.parse(String(init.body)))
      result = { ok: true }
    }
  } else if (url.pathname.endsWith('-auth-url')) {
    const name = url.pathname.slice(1).replace(/-auth-url$/, '')
    const { startLocalOAuth } = await import('./magpieOAuth.js')
    result = startLocalOAuth(name)
  } else if (url.pathname === '/get-auth-status' && method === 'GET') {
    const state = url.searchParams.get('state') || ''
    const { getLocalOAuthStatus } = await import('./magpieOAuth.js')
    result = getLocalOAuthStatus(state)
  } else if (url.pathname === '/oauth-callback' && method === 'POST') {
    const body = JSON.parse(String(init.body)) as { provider: string; redirect_url: string; state: string }
    const { submitLocalOAuthCallback } = await import('./magpieOAuth.js')
    result = await submitLocalOAuthCallback(body.provider, body.redirect_url, body.state)
  } else if (url.pathname === '/oauth-session' && method === 'DELETE') {
    const state = url.searchParams.get('state') || ''
    const { cancelLocalOAuthSession } = await import('./magpieOAuth.js')
    result = cancelLocalOAuthSession(state)
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
