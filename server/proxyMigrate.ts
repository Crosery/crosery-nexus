/**
 * Migration from the existing console (PROXY-SPEC §8): build the pool from the exits accounts already use,
 * without changing any account.
 *
 * Sources are read through the console's own control plane only (never the sandbox bridge):
 *   - CPA: `listAuthFiles()` names, then each credential's `proxy_url` (CPA's list does not carry it, so one
 *     `auth-files/download` per credential at concurrency 2; the body is reduced to `proxy_url` at once), the
 *     global proxy, channel and key `proxy-url`, and `PROXY_PRESETS`;
 *   - Magpie local: the same calls answered by the local shim (auth-files + auth-files-meta.json, magpie-channels.json),
 *     plus the registry's optional `accounts` section.
 * A plan groups accounts by distinct exit: inherit/direct are counted only; a remote URL becomes a `url` entry;
 * a loopback URL of another program becomes an `external` entry; a managed port links to its entry. Apply writes
 * `pool.json` only (zero account writes) and is idempotent: a re-run reports everything `unchanged`.
 */

import { randomBytes } from 'node:crypto'
import { maskProxyUserinfo } from './accountProjection.js'
import { cleanLabel, isLoopbackHost, parseProxyUrl, urlDedupKey } from './proxyParseClash.js'
import type { ControlProxyRef, ProxyControlPlane } from './proxyPoolControl.js'
import {
  fingerprintOf, isManagedPort, observeAccount, ProxyError, proxyMode, randomId, scrubProxySecrets, urlKeyOf,
  type PoolFile, type ProxyEntry, type ProxyPoolStore,
} from './proxyPoolStore.js'
import { mapWithConcurrency } from './syncRegistry.js'

export type SourceKind = 'credential' | 'global' | 'channel' | 'key' | 'magpie'

export type SourceRow = { ref: string; url: string; provider: string; kind: SourceKind }

export type MigrationSources = {
  rows: SourceRow[]
  presets: Array<{ label: string; url: string }>
  credentials: number
  readErrors: number
  channelError: boolean
  at: number
}

export type ExitAction = 'create' | 'link' | 'unchanged' | 'skip'

export type ExitPlan = {
  key: string
  /** secret: the exact string the accounts hold (or the preset URL) */
  url: string
  action: ExitAction
  reason?: string
  external: boolean
  entryId?: string
  source: 'migrated' | 'preset'
  name: string
  nameAuto: boolean
  refs: SourceRow[]
  fingerprint?: string
}

export type MigrationPlan = {
  exits: ExitPlan[]
  totals: { accounts: number; inherit: number; direct: number; url: number; invalid: number; exits: number; create: number; link: number; unchanged: number; skip: number }
  inheritByProvider: Record<string, number>
  directByProvider: Record<string, number>
}

const ACCOUNT_KINDS: ReadonlySet<SourceKind> = new Set(['credential', 'magpie'])

/** Read every proxy value the console's control plane holds. Account bodies are reduced to `proxy_url` at once. */
export async function collectMigrationSources(control: ProxyControlPlane, options: { concurrency?: number; now?: () => number } = {}): Promise<MigrationSources> {
  const credentials = await control.listCredentials()
  let readErrors = 0
  const rows: SourceRow[] = []
  const values = await mapWithConcurrency(credentials, options.concurrency ?? 2, async (credential) => {
    if (credential.proxyUrl !== undefined) return credential.proxyUrl
    try {
      return await control.readCredentialProxy(credential.name)
    } catch {
      readErrors++
      return null
    }
  })
  credentials.forEach((credential, index) => {
    const value = values[index]
    if (value === null) return
    rows.push({ ref: `cpa:${credential.name}`, url: String(value ?? '').trim(), provider: credential.provider || 'other', kind: 'credential' })
  })
  if (credentials.length && readErrors === credentials.length) throw new ProxyError(502, 'scan_failed', '读取账号代理全部失败，稍后再试')
  if (control.backend() === 'cpa') {
    const global = await control.readGlobalProxy()
    rows.push({ ref: 'cpa:global', url: global, provider: 'global', kind: 'global' })
  }
  let channelError = false
  let channelRefs: ControlProxyRef[] = []
  try { channelRefs = await control.readChannelProxies() } catch { channelError = true }
  for (const item of channelRefs) rows.push({ ref: item.ref, url: item.url, provider: 'channel', kind: item.ref.startsWith('cpa:channel:') ? 'channel' : 'key' })
  for (const item of control.readMagpieAccountProxies()) rows.push({ ref: item.ref, url: item.url, provider: item.provider || 'magpie', kind: 'magpie' })
  return { rows, presets: control.presets(), credentials: credentials.length, readErrors, channelError, at: options.now?.() ?? Date.now() }
}

const hostLabel = (host: string) => cleanLabel(host.includes(':') ? `[${host}]` : host) || 'proxy'

/** Group sources by distinct exit and decide each exit's action against the pool. Pure. */
export function planMigration(pool: PoolFile, sources: MigrationSources): MigrationPlan {
  const totals = { accounts: 0, inherit: 0, direct: 0, url: 0, invalid: 0, exits: 0, create: 0, link: 0, unchanged: 0, skip: 0 }
  const inheritByProvider: Record<string, number> = {}
  const directByProvider: Record<string, number> = {}
  const groups = new Map<string, { url: string; counts: Map<string, number>; refs: SourceRow[]; preset?: string }>()
  const invalid: SourceRow[] = []
  const groupKey = (url: string) => {
    const endpoint = parseProxyUrl(url)
    if (!endpoint) return null
    if (isLoopbackHost(endpoint.host) && isManagedPort(endpoint.port)) return `port|${endpoint.port}`
    return `key|${urlDedupKey(endpoint)}`
  }
  for (const row of sources.rows) {
    const account = ACCOUNT_KINDS.has(row.kind)
    if (account) totals.accounts++
    const mode = proxyMode(row.url)
    if (mode === 'inherit' || mode === 'direct') {
      if (account) {
        totals[mode]++
        const bucket = mode === 'inherit' ? inheritByProvider : directByProvider
        bucket[row.provider] = (bucket[row.provider] ?? 0) + 1
      }
      continue
    }
    const key = mode === 'url' ? groupKey(row.url) : null
    if (!key) {
      if (account) totals.invalid++
      invalid.push(row)
      continue
    }
    if (account) totals.url++
    const group = groups.get(key) ?? { url: row.url, counts: new Map<string, number>(), refs: [] }
    group.counts.set(row.url, (group.counts.get(row.url) ?? 0) + 1)
    group.refs.push(row)
    groups.set(key, group)
  }
  for (const preset of sources.presets) {
    const key = groupKey(preset.url)
    if (!key) continue
    const group = groups.get(key) ?? { url: preset.url, counts: new Map<string, number>(), refs: [] }
    if (!group.counts.size) group.counts.set(preset.url, 1)
    group.preset = cleanLabel(preset.label) || undefined
    groups.set(key, group)
  }

  const exits: ExitPlan[] = []
  let index = 0
  for (const [key, group] of groups) {
    index++
    // the string most accounts hold is the entry's URL, so the written value equals what accounts have
    const url = [...group.counts.entries()].sort((a, b) => b[1] - a[1])[0][0]
    const endpoint = parseProxyUrl(url)
    const external = Boolean(endpoint && isLoopbackHost(endpoint.host) && !key.startsWith('port|'))
    const base = {
      key: `x${index}`, url, external, refs: group.refs,
      source: (group.refs.length ? 'migrated' : 'preset') as ExitPlan['source'],
      name: group.preset || hostLabel(endpoint?.host ?? ''),
      nameAuto: !group.preset,
    }
    let plan: ExitPlan
    if (key.startsWith('port|')) {
      const port = Number(key.slice(5))
      const entry = pool.entries.find(item => item.kind === 'mihomo' && item.port === port)
      plan = entry ? { ...base, action: 'link', entryId: entry.id, name: entry.name } : { ...base, action: 'skip', reason: '代理池里没有这个本机端口' }
    } else {
      const fingerprint = pool.salt ? fingerprintOf(pool, key.slice(4)) : undefined
      const entry = fingerprint ? pool.entries.find(item => item.kind === 'url' && item.fingerprint === fingerprint) : undefined
      if (fingerprint && pool.migration.ignored.includes(fingerprint) && !entry) plan = { ...base, action: 'skip', reason: '已忽略', fingerprint }
      else if (entry) plan = { ...base, action: 'link', entryId: entry.id, name: entry.name, fingerprint }
      else plan = { ...base, action: 'create', fingerprint }
    }
    if (plan.action === 'link') {
      const entry = pool.entries.find(item => item.id === plan.entryId) as ProxyEntry
      const linked = plan.refs.every(row => {
        const link = pool.links[row.ref]
        return link && link.entryId === entry.id && link.urlKey === urlKeyOf(pool, row.url)
      })
      if (linked) plan.action = 'unchanged'
    }
    exits.push(plan)
  }
  if (invalid.length) {
    exits.push({
      key: 'invalid', url: '', action: 'skip', reason: '无法解析的代理地址', external: false, refs: invalid,
      source: 'migrated', name: '无效地址', nameAuto: true,
    })
  }
  for (const exit of exits) totals[exit.action]++
  totals.exits = exits.length
  return { exits, totals, inheritByProvider, directByProvider }
}

export type ApplyResult = { created: string[]; linked: number; unlinked: number; observed: number }

/**
 * Apply a plan: create the missing `url` entries, then record what every account holds (which links it to its
 * entry or drops a drifted link). Writes `pool.json` only.
 */
export function applyMigrationPlan(pool: PoolFile, plan: MigrationPlan, sources: MigrationSources, options: { create: boolean; now: string }): ApplyResult {
  const result: ApplyResult = { created: [], linked: 0, unlinked: 0, observed: 0 }
  if (options.create) {
    for (const exit of plan.exits) {
      if (exit.action !== 'create') continue
      const endpoint = parseProxyUrl(exit.url)
      if (!endpoint) continue
      const fingerprint = fingerprintOf(pool, urlDedupKey(endpoint))
      if (pool.entries.some(entry => entry.fingerprint === fingerprint)) continue
      pool.entries.push({
        id: randomId('px_'),
        name: exit.name,
        nameAuto: exit.nameAuto,
        kind: 'url',
        protocol: endpoint.scheme === 'socks5h' ? 'socks5' : endpoint.scheme,
        url: exit.url,
        server: endpoint.host,
        serverPort: endpoint.port,
        fingerprint,
        source: exit.source,
        ...(exit.external ? { external: true } : {}),
        tags: [],
        enabled: true,
        validity: 'ok',
        createdAt: options.now,
        updatedAt: options.now,
      })
      result.created.push(pool.entries[pool.entries.length - 1].id)
    }
  }
  const before = new Set(Object.keys(pool.links))
  const seen = new Set<string>()
  for (const row of sources.rows) {
    seen.add(row.ref)
    const entry = observeAccount(pool, row.ref, row.url, row.provider, 'migrate', options.now)
    result.observed++
    if (entry && !before.has(row.ref)) result.linked++
    if (!entry && before.has(row.ref)) result.unlinked++
  }
  // accounts that no longer exist (deleted credentials) drop out of the index; refs we could not read stay
  if (sources.readErrors === 0) {
    for (const ref of new Set([...Object.keys(pool.links), ...Object.keys(pool.observed)])) {
      if (seen.has(ref) || !/^cpa:(?!global$|channel:|key:)/.test(ref)) continue
      if (pool.links[ref]) result.unlinked++
      delete pool.links[ref]
      delete pool.observed[ref]
    }
  }
  return result
}

/* ────────────────────────── views ────────────────────────── */

export function planView(plan: MigrationPlan, sources: MigrationSources, scanId: string | null) {
  return {
    scanId,
    at: new Date(sources.at).toISOString(),
    totals: plan.totals,
    inheritByProvider: plan.inheritByProvider,
    directByProvider: plan.directByProvider,
    sources: { credentials: sources.credentials, readErrors: sources.readErrors, channelError: sources.channelError, presets: sources.presets.length },
    exits: plan.exits.map(exit => {
      const byProvider: Record<string, number> = {}
      let accounts = 0
      for (const row of exit.refs) {
        if (!ACCOUNT_KINDS.has(row.kind)) continue
        accounts++
        byProvider[row.provider] = (byProvider[row.provider] ?? 0) + 1
      }
      return {
        key: exit.key,
        name: exit.name,
        maskedUrl: exit.url ? maskProxyUserinfo(exit.url) : '',
        action: exit.action,
        reason: exit.reason ?? null,
        external: exit.external,
        source: exit.source,
        entryId: exit.entryId ?? null,
        accounts: { total: accounts, byProvider },
        others: exit.refs.filter(row => !ACCOUNT_KINDS.has(row.kind)).map(row => row.kind),
      }
    }),
  }
}

/* ────────────────────────── scan cache + runs ────────────────────────── */

export const MIGRATE_COOLDOWN_MS = 10 * 60_000

type CachedScan = { id: string; sources: MigrationSources }
let lastScan: CachedScan | null = null

export function cachedScan(id?: unknown, now = Date.now()): CachedScan | null {
  if (!lastScan || now - lastScan.sources.at > MIGRATE_COOLDOWN_MS) return null
  if (id !== undefined && id !== lastScan.id) return null
  return lastScan
}

export function clearScanCacheForTests() { lastScan = null }

/** A scan, reusing one younger than the cooldown (the manual scan's 10 min cooldown). */
export async function scanSources(control: ProxyControlPlane, options: { force?: boolean; now?: () => number } = {}): Promise<CachedScan> {
  const now = options.now?.() ?? Date.now()
  const cached = cachedScan(undefined, now)
  if (cached && !options.force) return cached
  const sources = await collectMigrationSources(control, { now: () => now })
  lastScan = { id: randomBytes(9).toString('base64url'), sources }
  return lastScan
}

export type MigrationRunResult = {
  mode: 'first-run' | 'scan' | 'apply'
  plan: MigrationPlan
  sources: MigrationSources
  applied: ApplyResult
}

/**
 * The job body: the first run applies (additive, no account writes); later runs only maintain the index and
 * set `migration.pending` for the banner.
 */
export async function runMigration(store: ProxyPoolStore, control: ProxyControlPlane, options: { mode: 'auto' | 'apply'; scanId?: unknown; now?: () => number; force?: boolean }): Promise<MigrationRunResult> {
  const nowMs = options.now?.() ?? Date.now()
  let sources: MigrationSources
  if (options.scanId !== undefined) {
    const cached = cachedScan(options.scanId, nowMs)
    if (!cached) throw new ProxyError(410, 'preview_expired')
    sources = cached.sources
  } else {
    sources = (await scanSources(control, { force: options.force, now: () => nowMs })).sources
  }
  const now = new Date(nowMs).toISOString()
  let mode: MigrationRunResult['mode'] = options.mode === 'apply' ? 'apply' : 'scan'
  let plan: MigrationPlan = planMigration(store.read(), sources)
  const applied = store.update((pool) => {
    plan = planMigration(pool, sources)
    const firstRun = options.mode === 'auto' && !pool.migration.firstRunAt
    if (firstRun) mode = 'first-run'
    const create = mode !== 'scan'
    const result = applyMigrationPlan(pool, plan, sources, { create, now })
    if (firstRun) {
      pool.migration.firstRunAt = now
      pool.migration.firstRunImported = result.created.length
    }
    pool.migration.lastScanAt = now
    const remaining = create ? planMigration(pool, sources) : plan
    const pendingExits = remaining.exits.filter(exit => exit.action === 'create')
    pool.migration.pending = pendingExits.length
      ? { exits: pendingExits.length, accounts: pendingExits.reduce((sum, exit) => sum + exit.refs.filter(row => ACCOUNT_KINDS.has(row.kind)).length, 0), at: now }
      : null
    return result
  })
  return { mode, plan, sources, applied }
}

export function migrationSummary(result: MigrationRunResult): string {
  if (result.mode === 'first-run') return `已从现有账号导入 ${result.applied.created.length} 个出口`
  if (result.mode === 'apply') return `导入 ${result.applied.created.length} 个出口，关联 ${result.applied.linked} 个账号`
  const pending = result.plan.exits.filter(exit => exit.action === 'create')
  return pending.length ? `发现 ${pending.length} 个出口还没进代理池` : '账号代理都已在代理池里'
}

export const scrubMigrationError = (error: unknown, pool?: PoolFile) => scrubProxySecrets(error instanceof Error ? error.message : error, pool)
