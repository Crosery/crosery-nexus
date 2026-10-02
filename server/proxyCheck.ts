import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { parseProxyEndpoint, probeRequest, ProbeError, type ProbeRequestOptions, type ProbeResponse, type ProxyEndpoint } from './proxyCheckClient.js'

/**
 * Reachability of one exit to the AI services (PROXY-SPEC §6): exit IP/country plus Claude, OpenAI and Google, through
 * exactly the path an account uses. Eight small unauthenticated GETs per entry, sequential; every request goes through
 * the shared upstream limiter (≤ 4 in flight across all in-process jobs). Results are data, not errors: they land in
 * `DATA_DIR/proxy/health.json` (0600, no secrets: no URLs, no credentials, no response bodies).
 */

export type ProbeState =
  | 'ok' | 'auth-expected' | 'region-blocked' | 'challenge' | 'blocked' | 'service-error'
  | 'proxy-auth-failed' | 'proxy-down' | 'upstream' | 'dns' | 'tls' | 'timeout'

export type ProbeService = 'claude' | 'openai' | 'google'
export const PROBE_SERVICES: readonly ProbeService[] = ['claude', 'openai', 'google']

export type ProbeTargetSpec = { service: 'exit' | ProbeService; url: string }

/** Order matters: the exit probe runs first so a dead proxy costs one request, not eight. */
export const PROBE_TARGETS: readonly ProbeTargetSpec[] = [
  { service: 'exit', url: 'https://www.cloudflare.com/cdn-cgi/trace' },
  { service: 'claude', url: 'https://api.anthropic.com/v1/models' },
  { service: 'claude', url: 'https://claude.ai/login' },
  { service: 'openai', url: 'https://api.openai.com/v1/models' },
  { service: 'openai', url: 'https://chatgpt.com/backend-api/codex/responses' },
  { service: 'openai', url: 'https://auth.openai.com/' },
  { service: 'google', url: 'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist' },
  { service: 'google', url: 'https://accounts.google.com/' },
]

export const PROBE_STATE_LABEL: Record<ProbeState, string> = {
  ok: '正常',
  'auth-expected': '正常',
  'region-blocked': '地区限制',
  challenge: '人机验证',
  blocked: '被拦截',
  'service-error': '服务异常',
  'proxy-auth-failed': '代理认证失败',
  'proxy-down': '代理不可达',
  upstream: '节点不通',
  dns: '解析失败',
  tls: 'TLS 异常',
  timeout: '超时',
}

/** Higher = worse; a cell shows its worst host. */
const SEVERITY: Record<ProbeState, number> = {
  ok: 0, 'auth-expected': 0, 'service-error': 2, challenge: 3, blocked: 4, 'region-blocked': 5,
  timeout: 6, tls: 6, dns: 7, upstream: 7, 'proxy-auth-failed': 8, 'proxy-down': 9,
}

export const isReachable = (state: ProbeState) => state === 'ok' || state === 'auth-expected'
/** On a tie the earlier host wins (a cell of `auth-expected` + `ok` reads `auth-expected`: both are reachable). */
export const worstState = (states: readonly ProbeState[]): ProbeState =>
  states.reduce<ProbeState>((worst, state) => (SEVERITY[state] > SEVERITY[worst] ? state : worst), states[0] ?? 'ok')

/* ────────────────────────── classification ────────────────────────── */

const REGION_BODY = [
  /unsupported_country_region_territory/i, // OpenAI / ChatGPT
  /Request not allowed/i, // Anthropic API from an unsupported region (403)
  /User location is not supported/i, // Google
  /not available in your (?:country|region)/i,
]
const REGION_REDIRECT = /unavailable|unsupported|region/i
const BLOCK_REDIRECT = /(^|\.)google\.[a-z.]+\/sorry\b|\/sorry\/index/i

/**
 * Body patterns are fixtures from public reports and are **[unverified]** against live responses until captured once by hand.
 * Order: challenge → region → blocked → ok → auth-expected (only 400/401/405, what an unauthenticated probe expects).
 * Any other status (408, 410, 5xx, …) is `service-error`: the exit reached the service, but it did not answer normally.
 */
export function classifyResponse(response: Pick<ProbeResponse, 'status' | 'headers' | 'body'>, requestUrl?: string): ProbeState {
  const status = response.status
  const header = (name: string) => String(response.headers[name] ?? '')
  if (/challenge/i.test(header('cf-mitigated'))) return 'challenge'
  const body = response.body.slice(0, 16 * 1024)
  if ((status === 403 || status === 400 || status === 451) && REGION_BODY.some(pattern => pattern.test(body))) return 'region-blocked'
  if (status === 451) return 'region-blocked'
  if (status >= 300 && status < 400) {
    const location = header('location')
    let target = location
    try {
      const resolved = new URL(location, requestUrl ?? 'https://invalid.local/')
      target = `${resolved.hostname}${resolved.pathname}`
    } catch { /* keep raw */ }
    if (BLOCK_REDIRECT.test(target)) return 'blocked'
    if (REGION_REDIRECT.test(target)) return 'region-blocked'
    return 'ok'
  }
  if (status === 429 || status === 403) return 'blocked'
  if (status >= 200 && status < 300) return 'ok'
  if (status === 404) return 'ok'
  if (status === 400 || status === 401 || status === 405) return 'auth-expected'
  return 'service-error'
}

/** Cloudflare trace: `ip=…` and `loc=XX`. */
export function parseTrace(body: string): { ip: string | null; country: string | null } {
  const ip = /^ip=([0-9a-f.:]{3,45})$/im.exec(body)?.[1] ?? null
  const loc = /^loc=([A-Z]{2})$/m.exec(body)?.[1] ?? null
  return { ip, country: loc && loc !== 'XX' ? loc : null }
}

/* ────────────────────────── results ────────────────────────── */

export type HostResult = { host: string; state: ProbeState; status: number | null; ms: number | null }
export type ServiceHealth = { state: ProbeState; ms: number | null; hosts: HostResult[]; at: string }
export type ExitHealth = { ip: string | null; country: string | null; state: ProbeState; ms: number | null; at: string }
/** `lastAt` = when the check finished (the pool view reads `lastAt`, `exit`, `services`). */
export type EntryHealth = { lastAt: string; exit: ExitHealth; services: Record<ProbeService, ServiceHealth>; requests: number }

/** Probe input: the entry id and the exact URL its accounts use (`null` = direct). The URL never leaves this module. */
export type ProbeTarget = { id: string; proxyUrl: string | null }

/* ────────────────────────── health store ────────────────────────── */

type HealthFile = { version: 1; entries: Record<string, EntryHealth> }

const HEALTH_MAX_BYTES = 8 * 1024 * 1024
const ENTRY_ID = /^[A-Za-z0-9_-]{1,64}$/
const STATES = new Set<ProbeState>(Object.keys(SEVERITY) as ProbeState[])

function validIso(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value))
}

function sanitizeHost(raw: unknown): HostResult | null {
  const value = raw as HostResult
  if (!value || typeof value !== 'object' || typeof value.host !== 'string' || !STATES.has(value.state)) return null
  return {
    host: value.host.slice(0, 120),
    state: value.state,
    status: Number.isSafeInteger(value.status) ? value.status : null,
    ms: Number.isFinite(value.ms) ? Math.max(0, Math.round(value.ms as number)) : null,
  }
}

function sanitizeEntry(raw: unknown): EntryHealth | null {
  const value = raw as EntryHealth
  if (!value || typeof value !== 'object' || !validIso(value.lastAt) || !value.exit || !value.services) return null
  const exit = value.exit
  if (!STATES.has(exit.state) || !validIso(exit.at)) return null
  const services = {} as Record<ProbeService, ServiceHealth>
  for (const service of PROBE_SERVICES) {
    const cell = value.services[service]
    if (!cell || !STATES.has(cell.state) || !validIso(cell.at) || !Array.isArray(cell.hosts)) return null
    services[service] = {
      state: cell.state,
      ms: Number.isFinite(cell.ms) ? cell.ms : null,
      hosts: cell.hosts.map(sanitizeHost).filter((host): host is HostResult => host !== null).slice(0, 8),
      at: cell.at,
    }
  }
  return {
    lastAt: value.lastAt,
    exit: {
      ip: typeof exit.ip === 'string' && /^[0-9a-f.:]{3,45}$/i.test(exit.ip) ? exit.ip : null,
      country: typeof exit.country === 'string' && /^[A-Z]{2}$/.test(exit.country) ? exit.country : null,
      state: exit.state,
      ms: Number.isFinite(exit.ms) ? exit.ms : null,
      at: exit.at,
    },
    services,
    requests: Number.isSafeInteger(value.requests) ? value.requests : 0,
  }
}

/**
 * `DATA_DIR/proxy/health.json`: `{version: 1, entries: {<entryId>: EntryHealth}}`. Atomic 0600 writes in a 0700 directory;
 * a file with another version is read-only (we never overwrite what a newer console wrote).
 */
export class ProxyHealthStore {
  private entries = new Map<string, EntryHealth>()
  private stamp: string | null = null
  private readOnly = false

  constructor(readonly file: string) {}

  private currentStamp(): string {
    try {
      const stat = fs.statSync(this.file)
      return `${stat.ino}:${stat.size}:${stat.mtimeMs}`
    } catch {
      return 'missing'
    }
  }

  /** Re-reads whenever the file changed under us (another writer, a restore), so a save never resurrects stale rows. */
  private load() {
    const stamp = this.currentStamp()
    if (stamp === this.stamp) return
    this.stamp = stamp
    this.entries = new Map()
    this.readOnly = false
    try {
      const stat = fs.statSync(this.file)
      if (!stat.isFile() || stat.size > HEALTH_MAX_BYTES) return
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<HealthFile>
      if (parsed?.version !== 1) {
        this.readOnly = true
        return
      }
      for (const [id, raw] of Object.entries(parsed.entries ?? {})) {
        if (!ENTRY_ID.test(id)) continue
        const entry = sanitizeEntry(raw)
        if (entry) this.entries.set(id, entry)
      }
    } catch {
      // missing or corrupt: start empty (health is observational data)
    }
  }

  get(id: string): EntryHealth | null {
    this.load()
    return this.entries.get(id) ?? null
  }

  all(): Record<string, EntryHealth> {
    this.load()
    return Object.fromEntries(this.entries)
  }

  set(id: string, health: EntryHealth) {
    this.load()
    if (!ENTRY_ID.test(id)) return
    this.entries.set(id, health)
    this.save()
  }

  /** Drops results for entries that no longer exist. */
  prune(validIds: Iterable<string>) {
    this.load()
    const keep = new Set(validIds)
    let changed = false
    for (const id of [...this.entries.keys()]) {
      if (!keep.has(id)) {
        this.entries.delete(id)
        changed = true
      }
    }
    if (changed) this.save()
  }

  private save() {
    if (this.readOnly) return
    const dir = path.dirname(this.file)
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    fs.chmodSync(dir, 0o700)
    const temporary = `${this.file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
    fs.writeFileSync(temporary, `${JSON.stringify({ version: 1, entries: Object.fromEntries(this.entries) } satisfies HealthFile)}\n`, { flag: 'wx', mode: 0o600 })
    fs.renameSync(temporary, this.file)
    this.stamp = this.currentStamp()
  }
}

/* ────────────────────────── checker ────────────────────────── */

export type Limiter = { run<T>(task: () => Promise<T>): Promise<T> }

export type ProxyCheckerOptions = {
  store: ProxyHealthStore
  /** Shared upstream limiter (`upstreamLimiter` from syncRegistry.ts in production). */
  limiter: Limiter
  now?: () => number
  targets?: readonly ProbeTargetSpec[]
  request?: (proxy: ProxyEndpoint, url: string, options: ProbeRequestOptions) => Promise<ProbeResponse>
  requestOptions?: ProbeRequestOptions
  /** A repeat check of the same entry within this window returns the stored result (manual test cooldown). Default 60 s. */
  reuseWithinMs?: number
}

export type CheckOutcome = { health: EntryHealth; requests: number; cached: boolean }

const PROXY_STAGE_FAILURES = new Set<ProbeState>(['proxy-down', 'proxy-auth-failed'])

export class ProxyChecker {
  private readonly store: ProxyHealthStore
  private readonly limiter: Limiter
  private readonly now: () => number
  private readonly targets: readonly ProbeTargetSpec[]
  private readonly request: (proxy: ProxyEndpoint, url: string, options: ProbeRequestOptions) => Promise<ProbeResponse>
  private readonly requestOptions: ProbeRequestOptions
  private readonly reuseWithinMs: number
  private readonly inflight = new Map<string, Promise<CheckOutcome>>()
  private readonly listeners = new Set<(id: string, health: EntryHealth) => void>()

  constructor(options: ProxyCheckerOptions) {
    this.store = options.store
    this.limiter = options.limiter
    this.now = options.now ?? Date.now
    this.targets = options.targets ?? PROBE_TARGETS
    this.request = options.request ?? probeRequest
    this.requestOptions = options.requestOptions ?? {}
    this.reuseWithinMs = options.reuseWithinMs ?? 60_000
  }

  get healthStore() { return this.store }

  isChecking(id: string): boolean {
    return this.inflight.has(id)
  }

  /** Called after every fresh (non-cached) check; a throwing listener never fails the check. */
  onChecked(listener: (id: string, health: EntryHealth) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * Single-flight per entry: concurrent callers share one run. A result younger than `maxAgeMs` (default: the 60 s reuse
   * window) is returned without any request.
   */
  check(target: ProbeTarget, options: { maxAgeMs?: number } = {}): Promise<CheckOutcome> {
    const pending = this.inflight.get(target.id)
    if (pending) return pending
    const previous = this.store.get(target.id)
    const maxAge = options.maxAgeMs ?? this.reuseWithinMs
    if (previous && this.now() - Date.parse(previous.lastAt) < maxAge) return Promise.resolve({ health: previous, requests: 0, cached: true })
    const run = this.run(target).finally(() => this.inflight.delete(target.id))
    this.inflight.set(target.id, run)
    return run
  }

  private async run(target: ProbeTarget): Promise<CheckOutcome> {
    let endpoint: ProxyEndpoint | null = null
    try {
      endpoint = parseProxyEndpoint(target.proxyUrl)
    } catch {
      endpoint = null
    }
    const results: Array<{ spec: ProbeTargetSpec; host: HostResult; response: ProbeResponse | null }> = []
    let requests = 0
    let consecutiveTimeouts = 0
    let shortCircuit: ProbeState | null = endpoint ? null : 'proxy-down'
    for (const spec of this.targets) {
      const host = new URL(spec.url).host
      if (shortCircuit) {
        results.push({ spec, host: { host, state: shortCircuit, status: null, ms: null }, response: null })
        continue
      }
      requests += 1
      const outcome = await this.limiter.run(async () => {
        try {
          const response = await this.request(endpoint!, spec.url, this.requestOptions)
          return { state: classifyResponse(response, spec.url), response }
        } catch (error) {
          const state: ProbeState = error instanceof ProbeError ? error.code : 'upstream'
          return { state, response: null, stage: error instanceof ProbeError ? error.stage : 'target' }
        }
      })
      results.push({ spec, host: { host, state: outcome.state, status: outcome.response?.status ?? null, ms: outcome.response?.ms ?? null }, response: outcome.response })
      // The proxy itself is down or refuses us: the other requests would only repeat that. Two timeouts in a row mean the
      // exit black-holes traffic; stop there too (bounds a manual test to ~20 s instead of 8 × 10 s).
      consecutiveTimeouts = outcome.state === 'timeout' ? consecutiveTimeouts + 1 : 0
      if (PROXY_STAGE_FAILURES.has(outcome.state) || ('stage' in outcome && outcome.stage === 'proxy')) shortCircuit = outcome.state
      else if (consecutiveTimeouts >= 2) shortCircuit = 'timeout'
    }
    const at = new Date(this.now()).toISOString()
    const exitResult = results.find(item => item.spec.service === 'exit')
    const trace = exitResult?.response && exitResult.response.status === 200 ? parseTrace(exitResult.response.body) : { ip: null, country: null }
    const exitState: ProbeState = exitResult?.host.state ?? 'ok'
    const services = {} as Record<ProbeService, ServiceHealth>
    for (const service of PROBE_SERVICES) {
      const hosts = results.filter(item => item.spec.service === service).map(item => item.host)
      services[service] = { state: hosts.length ? worstState(hosts.map(host => host.state)) : 'ok', ms: hosts[0]?.ms ?? null, hosts, at }
    }
    const health: EntryHealth = {
      lastAt: at,
      exit: { ip: trace.ip, country: trace.country, state: exitState, ms: exitResult?.host.ms ?? null, at },
      services,
      requests,
    }
    this.store.set(target.id, health)
    for (const listener of this.listeners) {
      try { listener(target.id, health) } catch { /* observers never fail a check */ }
    }
    return { health, requests, cached: false }
  }
}

/** True when every service cell is reachable. */
export function entryHealthy(health: EntryHealth | null): boolean {
  return Boolean(health) && isReachable(health!.exit.state) && PROBE_SERVICES.every(service => isReachable(health!.services[service].state))
}

/* ────────────────────────── secrets in text ────────────────────────── */

/**
 * Masks proxy secrets in free text before it reaches a log, an audit row or a sync error (`sanitizeSyncError` alone does
 * not mask proxy URLs or uuids): URL userinfo, uuids, subscription paths/queries and any known secret value.
 */
export function scrubProbeText(text: unknown, secrets: readonly string[] = []): string {
  let out = String(text ?? '')
  const known = [...new Set(secrets.map(String).filter(value => value.length >= 3))].sort((a, b) => b.length - a.length)
  for (const secret of known) out = out.split(secret).join('***')
  return out
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@"']*@/gi, '$1***@')
    .replace(/(https?:\/\/[^\s/?#"']+)[/?#][^\s"']*/gi, '$1/***')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '***')
}
