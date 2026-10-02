/**
 * Paste → preview → import (PROXY-SPEC §2) and the subscription merge (§3).
 *
 * The preview holds the parsed secrets server-side for 10 minutes under a random `previewId`; the client only ever
 * sees the masked rows. Subscriptions found in the paste are fetched once, on that explicit action, and the
 * fetched result is reused at import. Merge by dedup key keeps entry ids, ports and links.
 */

import { randomBytes } from 'node:crypto'
import { canonicalJson, cleanLabel, isLoopbackHost, parseProxyUrl, type ProxyCandidate } from './proxyParseClash.js'
import { DUPLICATE_SUBSCRIPTIONS_NOTE, parseProxyInput, subscriptionLabel, type ExportAssignment, type ParsedCandidate, type ParsedInput, type ProviderRef } from './proxyParse.js'
import { fetchSubscription, maskSubscriptionUrl, SubscriptionFetchError, type SubscriptionFetchOptions, type SubscriptionFetchResult } from './proxyParseSubscription.js'
import {
  candidatePorts, fingerprintOf, isManagedPort, ProxyError, randomId, retirePort, scrubProxySecrets, takePort,
  type PoolFile, type ProxyEntry, type ProxyPoolStore, type ProxySource, type ProxySubscription,
} from './proxyPoolStore.js'

export const PREVIEW_TTL_MS = 10 * 60_000
const PREVIEW_MAX = 16
export const SUBSCRIPTION_DEFAULT_INTERVAL_H = 12
export const SUBSCRIPTION_MIN_INTERVAL_H = 6

export type RowStatus = 'new' | 'duplicate' | 'update' | 'unsupported' | 'invalid' | 'info'

export type PreviewRow = {
  key: string
  candidate: ParsedCandidate
  status: RowStatus
  reason?: string
  /** duplicate/update: the pool entry it matches */
  entryId?: string
  /** duplicate inside this paste: the first row */
  duplicateOf?: string
  /** rows from a subscription */
  subscriptionKey?: string
  fingerprint?: string
}

export type PreviewSubscription = {
  key: string
  provider: ProviderRef
  ok: boolean
  error?: string
  info?: SubscriptionFetchResult['info']
  updateIntervalH?: number | null
  filename?: string | null
  insecureHttp?: boolean
  rowKeys: string[]
  existingId?: string
  intervalH: number
  retryAfterMs?: number | null
}

export type Preview = {
  id: string
  createdAt: number
  format: ParsedInput['format']
  rows: PreviewRow[]
  subscriptions: PreviewSubscription[]
  ignoredSections: string[]
  notes: string[]
  assignments: ExportAssignment[]
}

/* ────────────────────────── preview cache ────────────────────────── */

const previews = new Map<string, Preview>()

export function savePreview(preview: Preview, now = Date.now()) {
  for (const [id, item] of previews) if (now - item.createdAt > PREVIEW_TTL_MS) previews.delete(id)
  while (previews.size >= PREVIEW_MAX) previews.delete(previews.keys().next().value as string)
  previews.set(preview.id, preview)
}

export function takePreview(id: unknown, now = Date.now()): Preview {
  const preview = typeof id === 'string' ? previews.get(id) : undefined
  if (!preview || now - preview.createdAt > PREVIEW_TTL_MS) {
    if (typeof id === 'string') previews.delete(id)
    throw new ProxyError(410, 'preview_expired')
  }
  return preview
}

export function dropPreview(id: string) { previews.delete(id) }
export function clearPreviewsForTests() { previews.clear() }

/* ────────────────────────── classification ────────────────────────── */

function sameContent(entry: ProxyEntry, candidate: ProxyCandidate): boolean {
  if (entry.kind !== candidate.kind) return false
  if (entry.kind === 'url') return true
  return canonicalJson(entry.node) === canonicalJson(candidate.node)
}

/** Classify candidates against the pool and each other. */
export function classifyRows(pool: PoolFile, candidates: ParsedCandidate[], startIndex = 0, subscriptionKey?: string): PreviewRow[] {
  const seen = new Map<string, string>()
  const byFingerprint = new Map(pool.entries.map(entry => [entry.fingerprint, entry]))
  return candidates.map((candidate, index) => {
    const key = `r${startIndex + index}`
    const base: PreviewRow = { key, candidate, status: 'new', ...(subscriptionKey ? { subscriptionKey } : {}) }
    if (candidate.status !== 'ok') return { ...base, status: candidate.status, reason: candidate.reason }
    if (candidate.kind === 'url' && candidate.server && isLoopbackHost(candidate.server) && candidate.serverPort && isManagedPort(candidate.serverPort)) {
      return { ...base, status: 'invalid', reason: '这是代理池自己的本机端口，不能作为出口导入' }
    }
    const fingerprint = pool.salt && candidate.dedupKey ? fingerprintOf(pool, candidate.dedupKey) : candidate.dedupKey ?? key
    const firstRow = seen.get(fingerprint)
    if (firstRow) return { ...base, status: 'duplicate', duplicateOf: firstRow, reason: '与本次粘贴的另一条重复', fingerprint }
    seen.set(fingerprint, key)
    const existing = byFingerprint.get(fingerprint)
    if (existing) {
      return sameContent(existing, candidate)
        ? { ...base, status: 'duplicate', entryId: existing.id, reason: '代理池里已有', fingerprint }
        : { ...base, status: 'update', entryId: existing.id, reason: '已存在，配置有变化', fingerprint }
    }
    return { ...base, fingerprint }
  })
}

/* ────────────────────────── preview ────────────────────────── */

export type PreviewDeps = {
  fetch?: (url: string, options?: SubscriptionFetchOptions) => Promise<SubscriptionFetchResult>
  /** wraps each upstream fetch (the global upstream limiter) */
  limit?: <T>(task: () => Promise<T>) => Promise<T>
  countRequest?: () => void
  now?: () => number
}

/**
 * One request per subscription address at a time, and its outcome (success or failure) is reused for
 * `SUBSCRIPTION_REUSE_MS`: a link pasted twice, repeated 「解析」 clicks, or a refresh right after a preview never send
 * the same token to the provider twice (ban risk). Keyed per fetcher so injected test fetchers stay isolated.
 */
export const SUBSCRIPTION_REUSE_MS = 60_000
/** `settledAt` is null while the request is queued or in flight: an unsettled flight is always joined, never expired. */
type SubscriptionFlight = { settledAt: number | null; promise: Promise<SubscriptionFetchResult> }
const subscriptionFlights = new WeakMap<object, Map<string, SubscriptionFlight>>()

function sharedSubscriptionFetch(url: string, deps: PreviewDeps): Promise<SubscriptionFetchResult> {
  const fetcher = deps.fetch ?? fetchSubscription
  const limit = deps.limit ?? (<T>(task: () => Promise<T>) => task())
  const clock = () => deps.now?.() ?? Date.now()
  const now = clock()
  let flights = subscriptionFlights.get(fetcher)
  if (!flights) subscriptionFlights.set(fetcher, flights = new Map())
  for (const [key, flight] of flights) if (flight.settledAt !== null && now - flight.settledAt >= SUBSCRIPTION_REUSE_MS) flights.delete(key)
  const reused = flights.get(url)
  if (reused) return reused.promise
  deps.countRequest?.()
  const flight: SubscriptionFlight = { settledAt: null, promise: limit(() => fetcher(url)) }
  // settled flights stay for the reuse window; a rejection must not surface as unhandled while it waits there
  flight.promise.then(() => { flight.settledAt = clock() }, () => { flight.settledAt = clock() })
  flights.set(url, flight)
  return flight.promise
}

/** Fetch one subscription and parse its body into candidates (prefix applied). */
export async function fetchSubscriptionCandidates(provider: ProviderRef, deps: PreviewDeps = {}): Promise<{ result: SubscriptionFetchResult; candidates: ParsedCandidate[]; notes: string[] }> {
  const result = await sharedSubscriptionFetch(provider.url, deps)
  const parsed = parseProxyInput(result.body, { fromSubscription: true })
  const candidates = parsed.candidates.map((candidate) => {
    if (provider.prefix && candidate.name) return { ...candidate, name: cleanLabel(`${provider.prefix}${candidate.name}`) }
    return candidate
  })
  return { result, candidates, notes: parsed.notes }
}

export async function buildPreview(store: ProxyPoolStore, text: string, deps: PreviewDeps = {}): Promise<Preview> {
  const parsed = parseProxyInput(text)
  const pool = store.read()
  const now = deps.now?.() ?? Date.now()
  const rows = classifyRows(pool, parsed.candidates)
  const subscriptions: PreviewSubscription[] = []
  const notes = [...parsed.notes]
  let next = rows.length
  // the same address twice in one paste is one subscription (and one fetch)
  const seenUrls = new Set<string>()
  const providers = parsed.providers.filter((provider) => {
    if (seenUrls.has(provider.url)) return false
    seenUrls.add(provider.url)
    return true
  })
  if (providers.length < parsed.providers.length) notes.push(DUPLICATE_SUBSCRIPTIONS_NOTE)
  // sequential: one subscription fetch at a time
  for (const [index, provider] of providers.entries()) {
    const key = `s${index}`
    const existing = pool.subscriptions.find(subscription => subscription.url === provider.url)
    const item: PreviewSubscription = {
      key, provider, ok: false, rowKeys: [], intervalH: Math.max(SUBSCRIPTION_MIN_INTERVAL_H, provider.intervalH ?? SUBSCRIPTION_DEFAULT_INTERVAL_H),
      ...(existing ? { existingId: existing.id } : {}),
    }
    try {
      const fetched = await fetchSubscriptionCandidates(provider, deps)
      const subscriptionRows = classifyRows(pool, fetched.candidates, next, key)
      // a node already in this paste (or another subscription of it) is a duplicate there
      const seen = new Set(rows.map(row => row.fingerprint).filter(Boolean))
      for (const row of subscriptionRows) {
        if (row.fingerprint && seen.has(row.fingerprint) && row.status === 'new') {
          row.status = 'duplicate'
          row.reason = '与本次粘贴的另一条重复'
        }
      }
      next += subscriptionRows.length
      rows.push(...subscriptionRows)
      notes.push(...fetched.notes)
      item.ok = true
      item.rowKeys = subscriptionRows.map(row => row.key)
      item.info = fetched.result.info
      item.updateIntervalH = fetched.result.updateIntervalH
      item.filename = fetched.result.filename
      item.insecureHttp = fetched.result.insecureHttp
      if (fetched.result.updateIntervalH) item.intervalH = Math.max(item.intervalH, fetched.result.updateIntervalH)
    } catch (error) {
      item.error = error instanceof SubscriptionFetchError
        ? error.message
        : error instanceof Error && error.name === 'ProxyParseError' ? `订阅内容无法识别：${scrubProxySecrets(error.message, null, [provider.url])}` : '订阅拉取失败'
      item.retryAfterMs = error instanceof SubscriptionFetchError ? error.retryAfterMs : null
    }
    subscriptions.push(item)
  }
  if (rows.length > 5000) throw new ProxyError(413, 'too_large', '代理数量过多')
  const preview: Preview = {
    id: randomBytes(12).toString('base64url'),
    createdAt: now,
    format: parsed.format,
    rows,
    subscriptions,
    ignoredSections: parsed.ignoredSections,
    notes: [...new Set(notes)],
    assignments: parsed.assignments,
  }
  savePreview(preview, now)
  return preview
}

/** The masked preview the client sees. */
export function previewView(preview: Preview, options: { kernelAvailable: boolean }) {
  const counts = { new: 0, update: 0, duplicate: 0, unsupported: 0, invalid: 0, info: 0 }
  const byProtocol: Record<string, number> = {}
  let needsKernel = 0
  for (const row of preview.rows) {
    counts[row.status]++
    const protocol = row.candidate.protocol ?? (row.candidate.type || 'unknown')
    byProtocol[protocol] = (byProtocol[protocol] ?? 0) + 1
    if ((row.status === 'new' || row.status === 'update') && row.candidate.kind === 'mihomo') needsKernel++
  }
  return {
    previewId: preview.id,
    expiresAt: new Date(preview.createdAt + PREVIEW_TTL_MS).toISOString(),
    format: preview.format,
    counts,
    byProtocol,
    needsKernel,
    kernelAvailable: options.kernelAvailable,
    ignoredSections: preview.ignoredSections,
    notes: preview.notes,
    rows: preview.rows.map(row => ({
      key: row.key,
      name: row.candidate.name,
      type: row.candidate.type,
      protocol: row.candidate.protocol ?? null,
      kind: row.candidate.kind ?? null,
      server: row.candidate.server ?? null,
      serverPort: row.candidate.serverPort ?? null,
      external: row.candidate.external === true,
      status: row.status,
      reason: row.reason ?? null,
      entryId: row.entryId ?? null,
      duplicateOf: row.duplicateOf ?? null,
      subscriptionKey: row.subscriptionKey ?? null,
    })),
    subscriptions: preview.subscriptions.map(item => ({
      key: item.key,
      name: item.filename || item.provider.name || subscriptionLabel(item.provider.url),
      maskedUrl: maskSubscriptionUrl(item.provider.url),
      source: item.provider.source,
      ok: item.ok,
      error: item.error ?? null,
      nodeCount: item.rowKeys.length,
      info: item.info ?? null,
      intervalH: item.intervalH,
      insecureHttp: item.insecureHttp === true,
      existingId: item.existingId ?? null,
    })),
    assignments: preview.assignments.length,
  }
}

/* ────────────────────────── commit ────────────────────────── */

const intervalWithJitter = (hours: number, random = Math.random) => Math.round(hours * 3_600_000 * (1 + (random() * 0.2 - 0.1)))

function autoName(candidate: ProxyCandidate): string {
  const host = candidate.server ?? ''
  return cleanLabel(host.includes(':') ? `[${host}]` : host) || candidate.protocol || 'proxy'
}

function sourceFor(format: ParsedInput['format'], candidate: ProxyCandidate, subscription: boolean): ProxySource {
  if (subscription) return 'subscription'
  if (format === 'export') return 'pool-import'
  if (format === 'clash') return 'clash'
  return candidate.kind === 'url' ? 'manual' : 'uri'
}

/** A new entry from a candidate (the caller assigns `port` for mihomo entries). */
export function entryFromCandidate(pool: PoolFile, candidate: ParsedCandidate, source: ProxySource, now: string, extra: Partial<ProxyEntry> = {}): ProxyEntry {
  const name = candidate.name
  return {
    id: randomId('px_'),
    name: name || autoName(candidate),
    nameAuto: !name,
    kind: candidate.kind as ProxyEntry['kind'],
    protocol: candidate.protocol as ProxyEntry['protocol'],
    ...(candidate.kind === 'url' ? { url: candidate.url } : { node: candidate.node }),
    server: candidate.server ?? '',
    serverPort: candidate.serverPort ?? 0,
    fingerprint: fingerprintOf(pool, candidate.dedupKey ?? ''),
    source,
    ...(candidate.external ? { external: true } : {}),
    tags: [...new Set(candidate.tags ?? [])],
    enabled: candidate.enabled !== false,
    validity: candidate.kind === 'url' ? 'ok' : 'unverified',
    createdAt: now,
    updatedAt: now,
    ...extra,
  }
}

function applyUpdate(entry: ProxyEntry, candidate: ParsedCandidate, now: string) {
  if (candidate.kind === 'mihomo' && candidate.node) {
    entry.node = candidate.node
    entry.validity = 'unverified'
    delete entry.invalidReason
  }
  entry.server = candidate.server ?? entry.server
  entry.serverPort = candidate.serverPort ?? entry.serverPort
  if (entry.nameAuto && candidate.name) { entry.name = candidate.name; entry.nameAuto = false }
  entry.updatedAt = now
}

export type MergeResult = { added: string[]; updated: string[]; removed: number; stale: number; unchanged: number }

/**
 * Merge a subscription's current nodes into the pool by dedup key: new nodes are added (tagged with the
 * subscription name), changed ones updated in place (id, port and links kept), vanished ones removed when
 * unlinked or marked stale (「订阅中已移除」) when an account still uses them.
 */
export function mergeSubscription(pool: PoolFile, subscription: ProxySubscription, candidates: ParsedCandidate[], probed: number[], now: string): MergeResult {
  const result: MergeResult = { added: [], updated: [], removed: 0, stale: 0, unchanged: 0 }
  const linked = new Set(Object.values(pool.links).map(link => link.entryId))
  const current = new Set<string>()
  const byFingerprint = new Map(pool.entries.map(entry => [entry.fingerprint, entry]))
  const tag = cleanLabel(subscription.name, 24)
  const ignored = new Set(pool.migration.ignored)
  for (const candidate of candidates) {
    if (candidate.status !== 'ok' || !candidate.dedupKey) continue
    if (candidate.kind === 'url' && candidate.serverPort && isLoopbackHost(candidate.server ?? '') && isManagedPort(candidate.serverPort)) continue
    const fingerprint = fingerprintOf(pool, candidate.dedupKey)
    if (current.has(fingerprint)) continue
    current.add(fingerprint)
    // a node the admin deleted stays deleted across refreshes
    if (ignored.has(fingerprint) && !byFingerprint.has(fingerprint)) continue
    const existing = byFingerprint.get(fingerprint)
    if (existing) {
      if (existing.subscriptionId && existing.subscriptionId !== subscription.id) { result.unchanged++; continue }
      if (!existing.subscriptionId && existing.source !== 'subscription') { result.unchanged++; continue }
      existing.subscriptionId = subscription.id
      delete existing.staleInSubscription
      if (sameContent(existing, candidate)) { result.unchanged++; continue }
      applyUpdate(existing, candidate, now)
      result.updated.push(existing.id)
      continue
    }
    const entry = entryFromCandidate(pool, candidate, 'subscription', now, { subscriptionId: subscription.id, tags: tag ? [tag] : [] })
    if (entry.kind === 'mihomo') {
      const port = takePort(pool, probed)
      if (port === null) continue
      entry.port = port
    }
    pool.entries.push(entry)
    byFingerprint.set(fingerprint, entry)
    result.added.push(entry.id)
  }
  const keep: ProxyEntry[] = []
  for (const entry of pool.entries) {
    if (entry.subscriptionId !== subscription.id || current.has(entry.fingerprint)) { keep.push(entry); continue }
    if (linked.has(entry.id) || pool.defaultEntryId === entry.id) {
      if (!entry.staleInSubscription) { entry.staleInSubscription = true; entry.updatedAt = now }
      result.stale++
      keep.push(entry)
      continue
    }
    retirePort(pool, entry.port)
    result.removed++
  }
  pool.entries = keep
  subscription.nodeCount = pool.entries.filter(entry => entry.subscriptionId === subscription.id).length
  return result
}

export type CommitOptions = {
  keys?: unknown
  tags?: unknown
  subscriptions?: unknown
}

export type CommitDeps = {
  probe?: (port: number) => Promise<boolean>
  now?: () => number
  random?: () => number
}

export type CommitResult = {
  added: string[]
  updated: string[]
  skipped: number
  subscriptions: Array<{ key: string; id: string; added: number; updated: number; removed: number; stale: number }>
  assignPlan: Array<{ account: string; entryId: string; status: 'linked' | 'pending' }>
  mihomoChanged: string[]
}

const cleanTags = (value: unknown): string[] => (Array.isArray(value) ? value : [])
  .filter((tag): tag is string => typeof tag === 'string').map(tag => cleanLabel(tag, 24)).filter(Boolean).slice(0, 16)

type SubscriptionChoice = { include: boolean; intervalH?: number; name?: string }

function subscriptionChoices(raw: unknown): Map<string, SubscriptionChoice> {
  const out = new Map<string, SubscriptionChoice>()
  if (!Array.isArray(raw)) return out
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    if (typeof record.key !== 'string') continue
    const interval = Number(record.intervalH)
    out.set(record.key, {
      include: record.include !== false,
      ...(Number.isFinite(interval) ? { intervalH: Math.min(24 * 30, Math.max(SUBSCRIPTION_MIN_INTERVAL_H, Math.round(interval))) } : {}),
      ...(typeof record.name === 'string' && cleanLabel(record.name) ? { name: cleanLabel(record.name, 48) } : {}),
    })
  }
  return out
}

/** Commit a preview into the pool. Writes `pool.json` only; never touches an account. */
export async function commitImport(store: ProxyPoolStore, preview: Preview, options: CommitOptions, deps: CommitDeps = {}): Promise<CommitResult> {
  const nowMs = deps.now?.() ?? Date.now()
  const now = new Date(nowMs).toISOString()
  const keys = Array.isArray(options.keys) ? new Set(options.keys.filter((key): key is string => typeof key === 'string')) : null
  const tags = cleanTags(options.tags)
  const choices = subscriptionChoices(options.subscriptions)
  const included = preview.subscriptions.filter(item => item.ok && (choices.get(item.key)?.include ?? true))
  const includedKeys = new Set(included.map(item => item.key))
  const standalone = preview.rows.filter(row => !row.subscriptionKey
    && (keys ? keys.has(row.key) && ['new', 'update', 'info'].includes(row.status) : row.status === 'new' || row.status === 'update'))
  const subscriptionRows = preview.rows.filter(row => row.subscriptionKey && includedKeys.has(row.subscriptionKey))
  const needPorts = [...standalone, ...subscriptionRows].filter(row => row.candidate.kind === 'mihomo' && row.status !== 'update' && row.status !== 'duplicate').length
  const probed = needPorts ? await candidatePorts(store.read(), needPorts, deps.probe) : []

  const exportRefs = new Map<string, string>()
  const result = store.update((pool) => {
    const out: CommitResult = { added: [], updated: [], skipped: 0, subscriptions: [], assignPlan: [], mihomoChanged: [] }
    const byFingerprint = new Map(pool.entries.map(entry => [entry.fingerprint, entry]))
    for (const row of standalone) {
      const candidate = row.candidate
      if (candidate.status !== 'ok' && row.status !== 'info') { out.skipped++; continue }
      if (!candidate.dedupKey || !candidate.kind) { out.skipped++; continue }
      const fingerprint = fingerprintOf(pool, candidate.dedupKey)
      const existing = byFingerprint.get(fingerprint)
      if (existing) {
        if (!sameContent(existing, candidate)) {
          applyUpdate(existing, candidate, now)
          out.updated.push(existing.id)
          if (existing.kind === 'mihomo') out.mihomoChanged.push(existing.id)
        }
        if (tags.length) existing.tags = [...new Set([...existing.tags, ...tags])].slice(0, 16)
        if (candidate.exportRef) exportRefs.set(candidate.exportRef, existing.id)
        continue
      }
      const entry = entryFromCandidate(pool, candidate, sourceFor(preview.format, candidate, false), now)
      entry.tags = [...new Set([...entry.tags, ...tags])].slice(0, 16)
      if (entry.kind === 'mihomo') {
        const port = takePort(pool, probed)
        if (port === null) { out.skipped++; continue }
        entry.port = port
        out.mihomoChanged.push(entry.id)
      }
      pool.entries.push(entry)
      byFingerprint.set(fingerprint, entry)
      out.added.push(entry.id)
      if (candidate.exportRef) exportRefs.set(candidate.exportRef, entry.id)
    }
    // rows already in the pool are not re-imported, but an export file's assignments still point at them
    for (const row of preview.rows) {
      const candidate = row.candidate
      if (row.status !== 'duplicate' || !candidate.exportRef || !candidate.dedupKey || exportRefs.has(candidate.exportRef)) continue
      const existing = byFingerprint.get(fingerprintOf(pool, candidate.dedupKey))
      if (existing) exportRefs.set(candidate.exportRef, existing.id)
    }
    for (const item of included) {
      const choice = choices.get(item.key)
      let subscription = item.existingId ? pool.subscriptions.find(sub => sub.id === item.existingId) : pool.subscriptions.find(sub => sub.url === item.provider.url)
      const intervalH = Math.max(choice?.intervalH ?? item.intervalH, item.updateIntervalH ?? 0, SUBSCRIPTION_MIN_INTERVAL_H)
      if (!subscription) {
        subscription = {
          id: randomId('sub_'),
          name: choice?.name || item.filename || item.provider.name || subscriptionLabel(item.provider.url),
          url: item.provider.url,
          intervalH,
          lastFetchAt: null,
          nextAt: null,
          failures: 0,
          info: null,
          nodeCount: 0,
          createdAt: now,
        }
        pool.subscriptions.push(subscription)
      } else if (choice?.intervalH) {
        subscription.intervalH = intervalH
      }
      subscription.lastFetchAt = now
      subscription.nextAt = new Date(nowMs + intervalWithJitter(subscription.intervalH, deps.random)).toISOString()
      subscription.failures = 0
      delete subscription.error
      subscription.info = item.info ?? null
      const candidates = preview.rows.filter(row => row.subscriptionKey === item.key).map(row => row.candidate)
      const merged = mergeSubscription(pool, subscription, candidates, probed, now)
      out.added.push(...merged.added)
      out.updated.push(...merged.updated)
      for (const id of [...merged.added, ...merged.updated]) {
        if (pool.entries.find(entry => entry.id === id)?.kind === 'mihomo') out.mihomoChanged.push(id)
      }
      out.subscriptions.push({ key: item.key, id: subscription.id, added: merged.added.length, updated: merged.updated.length, removed: merged.removed, stale: merged.stale })
    }
    // export assignments: a dry-run plan; accounts already on the entry count as linked, the rest need an assign
    for (const assignment of preview.assignments) {
      const entryId = exportRefs.get(assignment.entryRef)
      if (!entryId) continue
      const ref = assignment.account.backend === 'cpa' ? `cpa:${assignment.account.identity}` : `magpie:${assignment.account.provider}:${assignment.account.identity}`
      out.assignPlan.push({ account: ref, entryId, status: pool.links[ref]?.entryId === entryId ? 'linked' : 'pending' })
    }
    return out
  })
  dropPreview(preview.id)
  return result
}

/** A subscription refresh outcome for the pool (used by the job and the manual refresh). */
export async function refreshSubscription(store: ProxyPoolStore, id: string, deps: PreviewDeps & CommitDeps = {}): Promise<MergeResult & { nodeCount: number }> {
  const snapshot = store.read()
  const subscription = snapshot.subscriptions.find(item => item.id === id)
  if (!subscription) throw new ProxyError(404, 'subscription_not_found')
  const nowMs = deps.now?.() ?? Date.now()
  try {
    const fetched = await fetchSubscriptionCandidates({ name: subscription.name, url: subscription.url, source: 'provider' }, deps)
    const fresh = fetched.candidates.filter(candidate => candidate.status === 'ok' && candidate.kind === 'mihomo' && candidate.dedupKey
      && !snapshot.entries.some(entry => entry.fingerprint === fingerprintOf(snapshot, candidate.dedupKey as string)))
    const probed = fresh.length ? await candidatePorts(snapshot, fresh.length, deps.probe) : []
    return store.update((pool) => {
      const target = pool.subscriptions.find(item => item.id === id)
      if (!target) throw new ProxyError(404, 'subscription_not_found')
      const now = new Date(nowMs).toISOString()
      if (fetched.result.updateIntervalH) target.intervalH = Math.max(target.intervalH, fetched.result.updateIntervalH)
      target.lastFetchAt = now
      target.nextAt = new Date(nowMs + intervalWithJitter(target.intervalH, deps.random)).toISOString()
      target.failures = 0
      delete target.error
      target.info = fetched.result.info ?? target.info ?? null
      const merged = mergeSubscription(pool, target, fetched.candidates, probed, now)
      return { ...merged, nodeCount: target.nodeCount }
    })
  } catch (error) {
    if (error instanceof ProxyError) throw error
    const retryAfterMs = error instanceof SubscriptionFetchError ? error.retryAfterMs : null
    store.update((pool) => {
      const target = pool.subscriptions.find(item => item.id === id)
      if (!target) return
      target.failures = Math.min(target.failures + 1, 32)
      // backoff 1 h → 24 h, never shorter than Retry-After
      const backoff = Math.min(24 * 3_600_000, 3_600_000 * 2 ** (target.failures - 1))
      target.nextAt = new Date(nowMs + Math.max(backoff, retryAfterMs ?? 0)).toISOString()
      const message = error instanceof SubscriptionFetchError ? error.message
        : error instanceof Error && error.name === 'ProxyParseError' ? '订阅内容无法识别' : '订阅拉取失败'
      target.error = scrubProxySecrets(message, pool).slice(0, 200)
    })
    throw new ProxyError(502, 'subscription_failed', error instanceof SubscriptionFetchError ? error.message : '订阅拉取失败', { retryAfterMs })
  }
}

export const subscriptionDue = (subscription: ProxySubscription, now: number) => !subscription.nextAt || Date.parse(subscription.nextAt) <= now

/** Keep an entry's url in the managed-port check consistent for callers outside this module. */
export const urlIsManagedPort = (url: string) => {
  const endpoint = parseProxyUrl(url)
  return Boolean(endpoint && isLoopbackHost(endpoint.host) && isManagedPort(endpoint.port))
}
