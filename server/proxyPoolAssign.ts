/**
 * Assignment (PROXY-SPEC §7): the only path that writes account settings, always through the existing writers
 * (`setCredentialProxy` → CPA `PATCH /auth-files/fields`, `setGlobalProxy` → CPA `PUT/DELETE /proxy-url`).
 *
 * A target is `inherit` (''), `direct` or a pool entry id; raw URLs stay on the existing credential route.
 * Each write records the account's previous value on its link (`prev`), so `unassign --restore` can put it back.
 * Guards: a console-host (mihomo) entry is refused for a remote CPA and while the kernel is unavailable.
 */

import { maskIdentity } from './accountProjection.js'
import type { ProxyControlPlane } from './proxyPoolControl.js'
import type { ProxyKernelView } from './proxyPoolHooks.js'
import {
  effectiveProxyUrl, ENTRY_ID, observeAccount, ProxyError, scrubProxySecrets, urlKeyOf,
  type HealthRecord, type PoolFile, type ProxyEntry, type ProxyPoolStore,
} from './proxyPoolStore.js'
import { assignability } from './proxyPoolView.js'

export type AssignTarget = { mode: 'inherit' } | { mode: 'direct' } | { mode: 'entry'; entry: ProxyEntry }

export type AssignContext = { cpaSameHost: boolean; kernel: ProxyKernelView }

export type AccountRef =
  | { kind: 'credential'; ref: string; name: string }
  | { kind: 'global'; ref: string }
  | { kind: 'readonly'; ref: string }

export const MAX_ASSIGN = 500

export function parseAccountRef(raw: unknown): AccountRef {
  const ref = typeof raw === 'string' ? raw.trim() : ''
  // eslint-disable-next-line no-control-regex
  if (!ref || ref.length > 300 || /[\u0000-\u001f]/.test(ref)) throw new ProxyError(400, 'invalid_request', '账号标识无效')
  if (ref === 'cpa:global') return { kind: 'global', ref }
  if (ref.startsWith('cpa:channel:') || ref.startsWith('cpa:key:')) return { kind: 'readonly', ref }
  if (ref.startsWith('cpa:')) {
    const name = ref.slice(4)
    if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) throw new ProxyError(400, 'invalid_request', '账号标识无效')
    return { kind: 'credential', ref, name }
  }
  throw new ProxyError(400, 'invalid_request', '账号标识无效')
}

export function resolveTarget(pool: PoolFile, raw: unknown): AssignTarget {
  const value = typeof raw === 'string' ? raw.trim() : ''
  if (value === '' || value === 'inherit') return { mode: 'inherit' }
  if (value === 'direct' || value === 'none') return { mode: 'direct' }
  if (!ENTRY_ID.test(value)) throw new ProxyError(400, 'invalid_target')
  const entry = pool.entries.find(item => item.id === value)
  if (!entry) throw new ProxyError(404, 'entry_not_found')
  return { mode: 'entry', entry }
}

/** Throws the 409 that explains why this entry cannot be written into accounts here. */
export function checkAssignable(target: AssignTarget, context: AssignContext) {
  if (target.mode !== 'entry') return
  const { entry } = target
  if (entry.kind === 'mihomo') {
    if (context.kernel.state === 'unavailable') throw new ProxyError(409, 'kernel_unavailable')
    if (!context.cpaSameHost) throw new ProxyError(409, 'proxy_scope_mismatch')
  }
  const verdict = assignability(entry, context)
  if (!verdict.assignable) throw new ProxyError(409, 'invalid_target', `这个出口不能分配：${verdict.reason}`)
}

export function targetUrl(pool: PoolFile, target: AssignTarget): string {
  if (target.mode === 'inherit') return ''
  if (target.mode === 'direct') return 'direct'
  return effectiveProxyUrl(pool, target.entry)
}

export const targetLabel = (target: AssignTarget) => (target.mode === 'entry' ? target.entry.id : target.mode)

/** Non-blocking warnings: the entry was never checked, or its last check failed somewhere. */
export function assignWarnings(target: AssignTarget, health: HealthRecord | undefined): string[] {
  if (target.mode !== 'entry') return []
  const warnings = target.entry.external ? ['依赖该主机上的其它代理程序'] : []
  if (!health || !health.services || !Object.keys(health.services).length) return [...warnings, '这个出口还没检测过']
  const failed = Object.entries(health.services).filter(([, cell]) => cell && !['ok', 'auth-expected'].includes(cell.state)).map(([service]) => service)
  return failed.length ? [...warnings, `最近一次检测不通：${failed.join('、')}`] : warnings
}

export type AssignOutcome = { account: string; status: 'updated' | 'unchanged' | 'failed' | 'restored'; code?: string; error?: string }

export type AssignDeps = {
  store: ProxyPoolStore
  control: ProxyControlPlane
  context: AssignContext
  audit?: (action: string, target: string, details: string) => void
  now?: () => string
}

const accountLabel = (ref: AccountRef) => (ref.kind === 'credential' ? maskIdentity(ref.name) : ref.kind === 'global' ? 'cpa:global' : 'account')

async function readCurrent(deps: AssignDeps, ref: AccountRef): Promise<string> {
  if (ref.kind === 'global') return deps.control.readGlobalProxy()
  if (ref.kind === 'credential') return deps.control.readCredentialProxy(ref.name)
  throw new ProxyError(409, 'account_read_only')
}

async function writeCurrent(deps: AssignDeps, ref: AccountRef, url: string): Promise<void> {
  if (ref.kind === 'global') return deps.control.writeGlobalProxy(url)
  if (ref.kind === 'credential') return deps.control.writeCredentialProxy(ref.name, url)
  throw new ProxyError(409, 'account_read_only')
}

async function writeOne(deps: AssignDeps, ref: AccountRef, url: string, entryForLink: string | null, via: 'assign'): Promise<AssignOutcome> {
  const now = deps.now?.() ?? new Date().toISOString()
  try {
    if (ref.kind === 'readonly') throw new ProxyError(409, 'account_read_only')
    const prev = await readCurrent(deps, ref)
    const written = ref.kind === 'global' && url === 'direct' ? '' : url
    const changed = prev.trim() !== written
    if (changed) await writeCurrent(deps, ref, written)
    deps.store.update((pool) => {
      const provider = pool.observed[ref.ref]?.provider ?? pool.links[ref.ref]?.provider
      const entry = observeAccount(pool, ref.ref, written, provider, via, now)
      const link = pool.links[ref.ref]
      if (entry && link && entryForLink === entry.id && changed) {
        link.prev = prev
        link.via = 'assign'
      }
      if (ref.kind === 'global') pool.defaultEntryId = entry?.id ?? null
    })
    return { account: ref.ref, status: changed ? 'updated' : 'unchanged' }
  } catch (error) {
    if (error instanceof ProxyError) return { account: ref.ref, status: 'failed', code: error.code, error: error.message }
    const status = Number((error as { status?: unknown })?.status)
    const code = status === 404 ? 'account_not_found' : 'control_plane_unavailable'
    return { account: ref.ref, status: 'failed', code, error: status === 404 ? '账号不存在' : scrubProxySecrets(error instanceof Error ? error.message : error, deps.store.read()).slice(0, 160) }
  }
}

/** Assign accounts to a target. Sequential (management API writes); per-account outcomes, partial failure allowed. */
export async function assignAccounts(deps: AssignDeps, rawTarget: unknown, rawAccounts: unknown) {
  const accounts = Array.isArray(rawAccounts) ? rawAccounts : []
  if (!accounts.length || accounts.length > MAX_ASSIGN) throw new ProxyError(400, 'invalid_request', `一次最多分配 ${MAX_ASSIGN} 个账号`)
  const refs = [...new Map(accounts.map(parseAccountRef).map(ref => [ref.ref, ref])).values()]
  const pool = deps.store.read()
  const target = resolveTarget(pool, rawTarget)
  checkAssignable(target, deps.context)
  const url = targetUrl(pool, target)
  const results: AssignOutcome[] = []
  for (const ref of refs) {
    const outcome = await writeOne(deps, ref, url, target.mode === 'entry' ? target.entry.id : null, 'assign')
    results.push(outcome)
    if (outcome.status === 'updated') deps.audit?.('proxy-assign', accountLabel(ref), `to=${targetLabel(target)}`)
  }
  return { target: targetLabel(target), results, updated: results.filter(item => item.status === 'updated').length, failed: results.filter(item => item.status === 'failed').length }
}

/** Unassign: back to inherit, or (`restore`) to the value the account held before the pool assigned it. */
export async function unassignAccounts(deps: AssignDeps, rawAccounts: unknown, restore: boolean) {
  const accounts = Array.isArray(rawAccounts) ? rawAccounts : []
  if (!accounts.length || accounts.length > MAX_ASSIGN) throw new ProxyError(400, 'invalid_request', `一次最多处理 ${MAX_ASSIGN} 个账号`)
  const refs = [...new Map(accounts.map(parseAccountRef).map(ref => [ref.ref, ref])).values()]
  const results: AssignOutcome[] = []
  for (const ref of refs) {
    const link = deps.store.read().links[ref.ref]
    const value = restore && link?.prev !== undefined ? link.prev : ''
    const outcome = await writeOne(deps, ref, value, null, 'assign')
    if (outcome.status === 'updated' && restore && link?.prev !== undefined) outcome.status = 'restored'
    results.push(outcome)
    if (outcome.status === 'updated' || outcome.status === 'restored') deps.audit?.('proxy-assign', accountLabel(ref), restore ? 'restore' : 'to=inherit')
  }
  return { results, updated: results.filter(item => item.status === 'updated' || item.status === 'restored').length, failed: results.filter(item => item.status === 'failed').length }
}

/** Accounts linked to an entry, split into the ones the pool may write and read-only references. */
export function linkedRefs(pool: PoolFile, entryId: string): { writable: AccountRef[]; readOnly: string[] } {
  const writable: AccountRef[] = []
  const readOnly: string[] = []
  for (const [ref, link] of Object.entries(pool.links)) {
    if (link.entryId !== entryId) continue
    const parsed = (() => { try { return parseAccountRef(ref) } catch { return null } })()
    if (parsed && (parsed.kind === 'credential' || parsed.kind === 'global')) writable.push(parsed)
    else readOnly.push(ref)
  }
  return { writable, readOnly }
}

/**
 * After a `url` entry's address changed: re-read every linked account and re-PATCH only the ones that still hold
 * the old URL (their link's urlKey). Drifted accounts are reported and unlinked, never overwritten.
 */
export async function reapplyUrlEdit(deps: AssignDeps, entryId: string) {
  const pool = deps.store.read()
  const entry = pool.entries.find(item => item.id === entryId)
  if (!entry || entry.kind !== 'url') return { updated: 0, drifted: 0, failed: 0, readOnly: 0 }
  const { writable, readOnly } = linkedRefs(pool, entryId)
  const url = effectiveProxyUrl(pool, entry)
  let updated = 0
  let drifted = 0
  let failed = 0
  for (const ref of writable) {
    try {
      const current = await readCurrent(deps, ref)
      const link = deps.store.read().links[ref.ref]
      if (!link || urlKeyOf(deps.store.read(), current) !== link.urlKey) {
        drifted++
        deps.store.update((next) => { observeAccount(next, ref.ref, current, next.observed[ref.ref]?.provider, 'scan') })
        continue
      }
      await writeCurrent(deps, ref, url)
      deps.store.update((next) => {
        const keepPrev = next.links[ref.ref]?.prev
        observeAccount(next, ref.ref, url, next.observed[ref.ref]?.provider, 'assign')
        if (next.links[ref.ref] && keepPrev !== undefined) next.links[ref.ref].prev = keepPrev
      })
      updated++
      deps.audit?.('proxy-assign', accountLabel(ref), `to=${entryId} reapply`)
    } catch {
      failed++
    }
  }
  return { updated, drifted, failed, readOnly: readOnly.length }
}
