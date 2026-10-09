/**
 * The proxy pool's storage (PROXY-SPEC §1) and the helpers every proxy module shares.
 *
 * `DATA_DIR/proxy/` (0700) holds `pool.json` (secrets: node passwords/uuids, url credentials, subscription
 * addresses, the listener credential) and `health.json` (check results, no secrets). Both are `{version: 1}`,
 * 0600, written atomically (tmp + wx + rename) and capped at 8 MiB. A missing directory is an empty pool, so old
 * installs need no migration; a file with an unknown version (or one that cannot be read) is read-only.
 *
 * The account's own `proxy_url` stays the source of truth. `links` is only an index (account → entry id) that
 * migration scans and assignments rebuild; `observed` is the last masked value seen per account.
 *
 * Interface for the kernel/check modules: `proxyPoolStore()` (read/update), `managedEntries()`,
 * `effectiveProxyUrl()`, `entryScope()`, `setEntryValidity()`, `proxySettings()`, `scrubProxySecrets()`.
 */

import { createHmac, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { config } from './config.js'
import { maskProxyUserinfo } from './accountProjection.js'
import { sanitizeSyncError } from './syncRegistry.js'
import { isLoopbackHost, nodeSecrets, parseProxyUrl, urlDedupKey, type ClashNode, type ProxyKind, type ProxyProtocol } from './proxyParseClash.js'

export const POOL_VERSION = 1
export const POOL_MAX_BYTES = 8 * 1024 * 1024

export type ProxySource = 'manual' | 'clash' | 'uri' | 'subscription' | 'migrated' | 'preset' | 'pool-import'
export type ProxyValidity = 'ok' | 'invalid' | 'unverified'

export type ProxyEntry = {
  /** `px_` + 10 base32 characters; random, never derived from secrets */
  id: string
  name: string
  /** the name was generated (host / host · country) and may be replaced by a better automatic one */
  nameAuto: boolean
  kind: ProxyKind
  protocol: ProxyProtocol
  /** kind=url: the URL written to accounts as is (secret: may carry user:pass) */
  url?: string
  /** kind=mihomo: whitelisted Clash object without `name` (secret) */
  node?: ClashNode
  server: string
  serverPort: number
  /** HMAC(salt, dedup key)[:16] */
  fingerprint: string
  /** kind=mihomo: the stable local socks5 port */
  port?: number
  source: ProxySource
  subscriptionId?: string
  staleInSubscription?: boolean
  /** a loopback url that belongs to another program on the consumer's host */
  external?: boolean
  tags: string[]
  enabled: boolean
  validity: ProxyValidity
  invalidReason?: string
  createdAt: string
  updatedAt: string
}

export type ProxySubscription = {
  id: string
  name: string
  /** secret */
  url: string
  intervalH: number
  lastFetchAt: string | null
  nextAt: string | null
  failures: number
  error?: string
  info?: { upload?: number; download?: number; total?: number; expire?: number } | null
  nodeCount: number
  createdAt: string
}

export type ProxyLink = {
  entryId: string
  /** HMAC of the exact URL the account held when linked (drift detection) */
  urlKey: string
  /** the account's previous value, for undo (secret) */
  prev?: string
  provider?: string
  at: string
  via: 'migrate' | 'assign' | 'hook' | 'import' | 'scan'
}

export type ObservedProxy = {
  mode: 'inherit' | 'direct' | 'url' | 'invalid'
  /** `scheme://***@host:port`; never the credential */
  masked?: string
  provider?: string
  at: string
}

export type PoolMigration = {
  firstRunAt?: string
  firstRunImported?: number
  lastScanAt?: string
  pending?: { exits: number; accounts: number; at: string } | null
  /** fingerprints of deleted migrated exits the scan must not bring back */
  ignored: string[]
}

export type PoolFile = {
  version: 1
  salt: string
  listenerAuth: { username: string; password: string }
  entries: ProxyEntry[]
  subscriptions: ProxySubscription[]
  links: Record<string, ProxyLink>
  observed: Record<string, ObservedProxy>
  defaultEntryId?: string | null
  migration: PoolMigration
  retiredPorts: number[]
}

export type HealthCell = { state: string; ms?: number | null; hosts?: Array<{ host: string; state: string; ms?: number | null; status?: number | null }>; at: string }
export type HealthRecord = { exit?: { ip?: string; country?: string; state?: string; ms?: number; at: string } | null; services?: Record<string, HealthCell>; lastAt?: string }
export type HealthFile = { version: 1; entries: Record<string, HealthRecord> }

/* ────────────────────────── errors ────────────────────────── */

export const PROXY_MESSAGES: Record<string, string> = {
  proxy_in_use: '这个出口还有账号在用，先把它们换到别的出口',
  proxy_scope_mismatch: 'CPA 不在本机，本机端口对它不可用',
  kernel_unavailable: 'mihomo 内核不可用：加密节点暂时不能分配',
  cooldown: '操作太频繁，请稍后再试',
  preview_expired: '预览已过期，请重新解析',
  unsupported_format: '无法识别的格式',
  invalid_yaml: 'Clash 配置解析失败',
  too_large: '内容过大',
  pool_read_only: '代理池文件版本不受支持或无法读取，已只读',
  pool_too_large: '代理池文件超过 8 MiB',
  entry_not_found: '出口不存在或已被删除',
  subscription_not_found: '订阅不存在或已被删除',
  confirm_required: '这个操作会修改账号设置，需要确认',
  invalid_request: '请求不合法',
  invalid_target: '目标出口无效',
  account_not_found: '账号不存在',
  account_read_only: '这个对象的代理只能在网关里修改',
  kernel_not_attached: '内核管理模块还没有接入',
  checker_unavailable: '连通性检测模块还没有接入',
  managed_port_url: '这是代理池自己的本机端口，不能作为出口导入',
  export_confirm_required: '导出含密码的文件需要确认',
  scan_failed: '读取账号代理失败',
  control_plane_unavailable: '控制面暂时不可用',
}

export class ProxyError extends Error {
  constructor(readonly status: number, readonly code: string, message = PROXY_MESSAGES[code] ?? '操作失败', readonly extra: Record<string, unknown> = {}) {
    super(message)
    this.name = 'ProxyError'
  }
}

/* ────────────────────────── settings ────────────────────────── */

export type ProxySettings = {
  portBase: number
  portCount: number
  listenerAuth: boolean
  cpaSameHostOverride: boolean | null
}

const envInt = (raw: string | undefined, fallback: number, min: number, max: number) => {
  const value = raw === undefined || raw === '' ? fallback : Number(raw)
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : fallback
}

export function proxySettings(env: NodeJS.ProcessEnv = process.env): ProxySettings {
  const portBase = envInt(env.PROXY_PORT_BASE, 27890, 1024, 64_000)
  const portCount = Math.min(envInt(env.PROXY_PORT_COUNT, 1000, 10, 10_000), 65_535 - portBase)
  const same = env.PROXY_CPA_SAME_HOST
  return {
    portBase,
    portCount,
    listenerAuth: env.PROXY_LISTENER_AUTH !== 'off',
    cpaSameHostOverride: same === '1' ? true : same === '0' ? false : null,
  }
}

/** Whether the CPA that consumes account exits runs on this host (managed 127.0.0.1 ports reach it). */
export function cpaSameHost(settings = proxySettings()): boolean {
  if (settings.cpaSameHostOverride !== null) return settings.cpaSameHostOverride
  try {
    const host = new URL(config.cpaBaseUrl).hostname.replace(/^\[(.*)\]$/, '$1').toLowerCase()
    return host === 'localhost' || host === '::1' || host.startsWith('127.')
  } catch {
    return false
  }
}

/* ────────────────────────── ids, keys ────────────────────────── */

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567'

export function randomId(prefix: 'px_' | 'sub_', length = 10): string {
  const bytes = randomBytes(length)
  let out = prefix
  for (const byte of bytes) out += BASE32[byte & 31]
  return out
}

export const ENTRY_ID = /^px_[a-z2-7]{10}$/
export const SUBSCRIPTION_ID = /^sub_[a-z2-7]{10}$/

export function keyedHash(salt: string, value: string): string {
  return createHmac('sha256', salt).update(value).digest('hex').slice(0, 16)
}

export const fingerprintOf = (pool: Pick<PoolFile, 'salt'>, dedupKey: string) => keyedHash(pool.salt, `k|${dedupKey}`)
export const urlKeyOf = (pool: Pick<PoolFile, 'salt'>, url: string) => keyedHash(pool.salt, `u|${String(url).trim()}`)

/* ────────────────────────── store ────────────────────────── */

export function emptyPool(): PoolFile {
  return {
    version: 1,
    salt: '',
    listenerAuth: { username: '', password: '' },
    entries: [],
    subscriptions: [],
    links: {},
    observed: {},
    defaultEntryId: null,
    migration: { ignored: [] },
    retiredPorts: [],
  }
}

const isMap = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const cpaRefs = (map: Record<string, unknown>) => Object.fromEntries(Object.entries(map).filter(([ref]) => ref.startsWith('cpa:')))

/** Fill missing optional sections of a stored pool (older writers, hand edits) without inventing secrets. */
function normalizePool(raw: Record<string, unknown>): PoolFile {
  const pool = emptyPool()
  if (typeof raw.salt === 'string') pool.salt = raw.salt
  if (isMap(raw.listenerAuth) && typeof raw.listenerAuth.username === 'string' && typeof raw.listenerAuth.password === 'string') {
    pool.listenerAuth = { username: raw.listenerAuth.username, password: raw.listenerAuth.password }
  }
  if (Array.isArray(raw.entries)) pool.entries = raw.entries.filter(entry => isMap(entry) && typeof entry.id === 'string' && ENTRY_ID.test(entry.id)) as ProxyEntry[]
  for (const entry of pool.entries) {
    if (!Array.isArray(entry.tags)) entry.tags = []
    if (typeof entry.enabled !== 'boolean') entry.enabled = true
    if (!['ok', 'invalid', 'unverified'].includes(entry.validity)) entry.validity = 'unverified'
  }
  if (Array.isArray(raw.subscriptions)) pool.subscriptions = raw.subscriptions.filter(item => isMap(item) && typeof item.id === 'string' && typeof item.url === 'string') as ProxySubscription[]
  // every account ref this console manages is `cpa:…`; anything else is a retired backend's leftover
  if (isMap(raw.links)) pool.links = cpaRefs(raw.links) as Record<string, ProxyLink>
  if (isMap(raw.observed)) pool.observed = cpaRefs(raw.observed) as Record<string, ObservedProxy>
  if (typeof raw.defaultEntryId === 'string') pool.defaultEntryId = raw.defaultEntryId
  if (isMap(raw.migration)) {
    pool.migration = { ...(raw.migration as PoolMigration), ignored: Array.isArray(raw.migration.ignored) ? raw.migration.ignored.filter((item): item is string => typeof item === 'string') : [] }
  }
  if (Array.isArray(raw.retiredPorts)) pool.retiredPorts = raw.retiredPorts.filter((port): port is number => Number.isInteger(port))
  return pool
}

type Cached<T> = { stamp: string; value: T }

export class ProxyPoolStore {
  readonly dir: string
  readonly poolFile: string
  readonly healthFile: string
  private poolCache: Cached<{ pool: PoolFile; readOnly: string | null }> | null = null
  private healthCache: Cached<HealthFile> | null = null

  constructor(dir: string) {
    this.dir = dir
    this.poolFile = path.join(dir, 'pool.json')
    this.healthFile = path.join(dir, 'health.json')
  }

  private stamp(file: string): string | null {
    try {
      const stat = fs.statSync(file)
      return `${stat.ino}:${stat.size}:${stat.mtimeMs}`
    } catch {
      return null
    }
  }

  private load(file: string): { raw: Record<string, unknown> | null; problem: string | null } {
    let stat: fs.Stats
    try { stat = fs.lstatSync(file) } catch { return { raw: null, problem: null } }
    if (!stat.isFile()) return { raw: null, problem: 'not_a_file' }
    if (stat.size > POOL_MAX_BYTES) return { raw: null, problem: 'too_large' }
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown
      if (!isMap(parsed)) return { raw: null, problem: 'corrupt' }
      if (parsed.version !== POOL_VERSION) return { raw: null, problem: 'unknown_version' }
      return { raw: parsed, problem: null }
    } catch {
      return { raw: null, problem: 'corrupt' }
    }
  }

  /** The pool (a missing file is an empty pool). `readOnly` names why writes are refused, or null. */
  snapshot(): { pool: PoolFile; readOnly: string | null } {
    const stamp = this.stamp(this.poolFile) ?? 'missing'
    if (this.poolCache && this.poolCache.stamp === stamp) return this.poolCache.value
    const { raw, problem } = this.load(this.poolFile)
    const value = { pool: raw ? normalizePool(raw) : emptyPool(), readOnly: problem }
    this.poolCache = { stamp, value }
    return value
  }

  read(): PoolFile {
    return this.snapshot().pool
  }

  /** Apply a synchronous mutation to a fresh copy and write it atomically. The mutator's throw leaves the file alone. */
  update<T>(mutate: (pool: PoolFile) => T): T {
    const { pool: current, readOnly } = this.snapshot()
    if (readOnly) throw new ProxyError(409, 'pool_read_only')
    const pool = structuredClone(current)
    if (!pool.salt) pool.salt = randomBytes(32).toString('hex')
    if (!pool.listenerAuth.username || !pool.listenerAuth.password) {
      pool.listenerAuth = { username: `cr${randomBytes(4).toString('hex')}`, password: randomBytes(18).toString('base64url') }
    }
    const result = mutate(pool)
    this.writeJson(this.poolFile, pool)
    this.poolCache = null
    return result
  }

  readHealth(): HealthFile {
    const stamp = this.stamp(this.healthFile) ?? 'missing'
    if (this.healthCache && this.healthCache.stamp === stamp) return this.healthCache.value
    const { raw } = this.load(this.healthFile)
    const value: HealthFile = { version: 1, entries: raw && isMap(raw.entries) ? raw.entries as Record<string, HealthRecord> : {} }
    this.healthCache = { stamp, value }
    return value
  }

  updateHealth<T>(mutate: (health: HealthFile) => T): T {
    const health = structuredClone(this.readHealth())
    const result = mutate(health)
    this.writeJson(this.healthFile, health)
    this.healthCache = null
    return result
  }

  private ensureDir() {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    try {
      if ((fs.statSync(this.dir).mode & 0o077) !== 0) fs.chmodSync(this.dir, 0o700)
    } catch { /* best effort: the files themselves are 0600 */ }
  }

  private writeJson(file: string, value: unknown) {
    const text = `${JSON.stringify(value)}\n`
    if (Buffer.byteLength(text, 'utf8') > POOL_MAX_BYTES) throw new ProxyError(413, 'pool_too_large')
    this.ensureDir()
    const temporary = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
    try {
      fs.writeFileSync(temporary, text, { flag: 'wx', mode: 0o600 })
      fs.renameSync(temporary, file)
    } catch (error) {
      try { fs.rmSync(temporary, { force: true }) } catch { /* nothing to clean */ }
      throw error
    }
  }
}

let shared: ProxyPoolStore | null = null

/** The process-wide store at `DATA_DIR/proxy`. */
export function proxyPoolStore(): ProxyPoolStore {
  if (!shared) shared = new ProxyPoolStore(path.join(config.dataDir, 'proxy'))
  return shared
}

/** Tests only: point the shared store somewhere else. */
export function setProxyPoolStoreForTests(store: ProxyPoolStore | null) {
  shared = store
}

/* ────────────────────────── entries ────────────────────────── */

/** Entries the kernel should run: enabled mihomo entries with a port that are not invalid. */
export function managedEntries(pool: PoolFile): ProxyEntry[] {
  return pool.entries.filter(entry => entry.kind === 'mihomo' && entry.enabled && entry.validity !== 'invalid' && Number.isInteger(entry.port) && entry.node)
}

export function setEntryValidity(store: ProxyPoolStore, id: string, validity: ProxyValidity, reason?: string) {
  store.update((pool) => {
    const entry = pool.entries.find(item => item.id === id)
    if (!entry) return
    entry.validity = validity
    if (validity === 'invalid' && reason) entry.invalidReason = scrubProxySecrets(reason, pool).slice(0, 200)
    else delete entry.invalidReason
    entry.updatedAt = new Date().toISOString()
  })
}

export function isManagedPort(port: number, settings = proxySettings()): boolean {
  return port >= settings.portBase && port < settings.portBase + settings.portCount
}

/** The URL written into an account for this entry. */
export function effectiveProxyUrl(pool: PoolFile, entry: ProxyEntry, settings = proxySettings()): string {
  if (entry.kind === 'url') return entry.url ?? ''
  if (!entry.port) throw new ProxyError(409, 'kernel_unavailable')
  const auth = settings.listenerAuth && pool.listenerAuth.username
    ? `${encodeURIComponent(pool.listenerAuth.username)}:${encodeURIComponent(pool.listenerAuth.password)}@`
    : ''
  return `socks5://${auth}127.0.0.1:${entry.port}`
}

export type ProxyScope = 'anywhere' | 'consumer-host' | 'console-host'

export function entryScope(entry: ProxyEntry): ProxyScope {
  if (entry.kind === 'mihomo') return 'console-host'
  return entry.external ? 'consumer-host' : 'anywhere'
}

/** The entry an account URL points at: a managed port, or a url entry with the same dedup key. */
export function matchEntryForUrl(pool: PoolFile, raw: string, settings = proxySettings()): ProxyEntry | null {
  const endpoint = parseProxyUrl(raw)
  if (!endpoint) return null
  if (isLoopbackHost(endpoint.host) && isManagedPort(endpoint.port, settings)) {
    return pool.entries.find(entry => entry.kind === 'mihomo' && entry.port === endpoint.port) ?? null
  }
  const fingerprint = fingerprintOf(pool, urlDedupKey(endpoint))
  return pool.entries.find(entry => entry.kind === 'url' && entry.fingerprint === fingerprint) ?? null
}

/** Classify an account's proxy_url value: '' inherit, direct, url, or invalid. */
export function proxyMode(raw: string): ObservedProxy['mode'] {
  const value = String(raw ?? '').trim()
  if (!value) return 'inherit'
  if (['direct', 'none'].includes(value.toLowerCase())) return 'direct'
  return parseProxyUrl(value) ? 'url' : 'invalid'
}

/**
 * Record what an account holds now and keep its link in step: linked when the URL is a pool entry, unlinked
 * (drifted) otherwise. `prev` survives only while the account still holds the assigned entry.
 */
export function observeAccount(pool: PoolFile, ref: string, raw: string, provider: string | undefined, via: ProxyLink['via'], now = new Date().toISOString()) {
  const value = String(raw ?? '').trim()
  const mode = proxyMode(value)
  pool.observed[ref] = {
    mode,
    ...(mode === 'url' ? { masked: maskProxyUserinfo(value) } : {}),
    ...(provider ? { provider } : {}),
    at: now,
  }
  const entry = mode === 'url' ? matchEntryForUrl(pool, value) : null
  const existing = pool.links[ref]
  if (!entry) {
    delete pool.links[ref]
    return null
  }
  const urlKey = urlKeyOf(pool, value)
  if (existing && existing.entryId === entry.id && existing.urlKey === urlKey) {
    if (provider) existing.provider = provider
    return entry
  }
  pool.links[ref] = {
    entryId: entry.id, urlKey, at: now, via,
    ...(provider ? { provider } : {}),
    ...(existing?.prev !== undefined && existing.entryId === entry.id ? { prev: existing.prev } : {}),
  }
  return entry
}

/* ────────────────────────── ports ────────────────────────── */

/** Bind probe on 127.0.0.1: true when nothing listens there now. */
export function probeLocalPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.unref()
    server.once('error', () => resolve(false))
    server.listen({ port, host: '127.0.0.1', exclusive: true }, () => server.close(() => resolve(true)))
  })
}

/**
 * Up to `count` ports in the managed range that pass a bind probe (lowest first), skipping ports in use by entries or
 * retired. Only when the fresh range runs out are retired ports (oldest first) probed for reuse.
 */
export async function candidatePorts(pool: PoolFile, count: number, probe: (port: number) => Promise<boolean> = probeLocalPort, settings = proxySettings()): Promise<number[]> {
  const used = new Set<number>(pool.entries.map(entry => entry.port ?? 0))
  const taken = new Set<number>([...used, ...pool.retiredPorts])
  const out: number[] = []
  for (let port = settings.portBase; port < settings.portBase + settings.portCount && out.length < count; port++) {
    if (taken.has(port)) continue
    if (await probe(port)) out.push(port)
  }
  for (const port of pool.retiredPorts) {
    if (out.length >= count) break
    if (used.has(port) || out.includes(port) || !isManagedPort(port, settings)) continue
    if (await probe(port)) out.push(port)
  }
  return out
}

/**
 * Assign a port inside `update`: only a port that passed the bind probe and is still unused. Never an unprobed port —
 * that could be another local proxy's port, and a socks greeting cannot tell the two apart. `null` = skip the entry.
 */
export function takePort(pool: PoolFile, probed: number[], settings = proxySettings()): number | null {
  const used = new Set<number>(pool.entries.map(entry => entry.port ?? 0))
  while (probed.length) {
    const port = probed.shift() as number
    if (used.has(port) || !isManagedPort(port, settings)) continue
    const retired = pool.retiredPorts.indexOf(port)
    if (retired >= 0) pool.retiredPorts.splice(retired, 1)
    return port
  }
  return null
}

export function retirePort(pool: PoolFile, port: number | undefined) {
  if (!port) return
  pool.retiredPorts = [...pool.retiredPorts.filter(item => item !== port), port].slice(-2000)
}

/* ────────────────────────── masking ────────────────────────── */

/** Every secret string the pool holds (≥ 4 characters). */
export function poolSecrets(pool: PoolFile): string[] {
  const out = new Set<string>()
  const add = (value: unknown) => { if (typeof value === 'string' && value.length >= 4) out.add(value) }
  add(pool.listenerAuth.password)
  for (const entry of pool.entries) {
    if (entry.url) {
      const endpoint = parseProxyUrl(entry.url)
      add(endpoint?.password)
      add(endpoint?.username)
      add(entry.url)
    }
    for (const secret of nodeSecrets(entry.node)) add(secret)
  }
  for (const subscription of pool.subscriptions) {
    add(subscription.url)
    try {
      const url = new URL(subscription.url)
      add(url.pathname.length > 4 ? url.pathname : '')
      add(url.search.length > 4 ? url.search : '')
      for (const value of url.searchParams.values()) add(value)
    } catch { /* not a URL: the whole string is already listed */ }
  }
  for (const link of Object.values(pool.links)) add(link.prev)
  return [...out].sort((a, b) => b.length - a.length)
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Scrub a message before it reaches a response, log, audit row or sync error: URL userinfo, share links, uuids,
 * URL paths/queries, mihomo's `proxy <n>`, and every secret value of the pool. Then `sanitizeSyncError`.
 */
export function scrubProxySecrets(message: unknown, pool?: PoolFile | null, extra: string[] = []): string {
  let text = String(message ?? '')
  const secrets = [...(pool ? poolSecrets(pool) : []), ...extra.filter(item => typeof item === 'string' && item.length >= 4)]
  for (const secret of secrets) text = text.replace(new RegExp(escapeRegExp(secret), 'g'), '***')
  text = text
    .replace(/\b(ss|ssr|vmess|vless|trojan|hysteria2|hy2|tuic|wireguard|wg):\/\/\S+/gi, '$1://***')
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@]*@/gi, '$1***@')
    .replace(/\b(https?:\/\/[^\s/?#]+)[/?][^\s"'<>]*/gi, '$1/***')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '***')
    .replace(/\bproxy \d+\b/gi, 'proxy *')
  return sanitizeSyncError(text)
}
