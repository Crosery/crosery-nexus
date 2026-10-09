/**
 * /api/proxies — the proxy pool's admin API (PROXY-SPEC §10). Admin only: key sessions are refused by the
 * default-deny guard (server/auth.ts) before reaching these. Every response is an allow-list projection
 * (proxyPoolView.ts); errors keep the `{error, code}` shape with zh messages; audit rows carry ids or masked
 * identities, never a URL, host or credential.
 *
 * Nothing here sends traffic on a GET: page loads read local state only. Subscription fetches happen on an
 * explicit parse/refresh (and in the sync job); account reads happen on migrate/assign.
 */

import type express from 'express'
import { addAudit } from './db.js'
import { cleanLabel, isLoopbackHost } from './proxyParseClash.js'
import { ProxyParseError } from './proxyParse.js'
import { parseShareLink } from './proxyParseUri.js'
import { maskSubscriptionUrl } from './proxyParseSubscription.js'
import { buildPreview, commitImport, previewView, refreshSubscription, takePreview, type PreviewDeps } from './proxyPoolImport.js'
import { assignAccounts, assignWarnings, checkAssignable, linkedRefs, reapplyUrlEdit, resolveTarget, unassignAccounts, type AssignContext } from './proxyPoolAssign.js'
import { defaultControlPlane, type ProxyControlPlane } from './proxyPoolControl.js'
import { kernelView, notifyPoolChanged, proxyChecker, proxyKernel } from './proxyPoolHooks.js'
import {
  ENTRY_ID, fingerprintOf, isManagedPort, matchEntryForUrl, observeAccount, proxyMode, ProxyError, proxyPoolStore, retirePort,
  scrubProxySecrets, SUBSCRIPTION_ID, type ProxyEntry, type ProxyPoolStore,
} from './proxyPoolStore.js'
import { entryDisplay, entryView, managedRange, maskAccountProxy, maskedExport, projectKernelView, secretExport, subscriptionView, usageByEntry } from './proxyPoolView.js'
import { MIGRATE_COOLDOWN_MS, migrationSummary, planMigration, planView, runMigration, scanSources } from './proxyMigrate.js'
import { maskIdentity } from './accountProjection.js'
import { upstreamLimiter } from './syncRegistry.js'
import { accountValue, egressView, presetIndex } from './proxyEgress.js'
import { parseAccountRef } from './proxyPoolAssign.js'

export type ProxyServiceDeps = {
  store?: ProxyPoolStore
  control?: ProxyControlPlane
  audit?: (action: string, target: string, details: string) => void
  preview?: PreviewDeps
  probe?: (port: number) => Promise<boolean>
  now?: () => number
}

export const SUBSCRIPTION_REFRESH_COOLDOWN_MS = 10 * 60_000
/** one authoritative read per account per this long (CPA management API); every write through the pool clears it */
export const EGRESS_READ_TTL_MS = 15_000

const SIGNIN_NOTE = 'CPA 的登录不支持单独指定出口（使用 CPA 全局代理）；登录完成后再为这个账号选择出口'

export function createProxyService(deps: ProxyServiceDeps = {}) {
  const store = () => deps.store ?? proxyPoolStore()
  const control = deps.control ?? defaultControlPlane()
  const audit = deps.audit ?? addAudit
  const now = deps.now ?? Date.now
  const refreshMarks = new Map<string, number>()
  const accountReads = new Map<string, { at: number; value: Promise<string> }>()
  const forgetReads = (refs: unknown) => {
    for (const raw of Array.isArray(refs) ? refs : []) {
      try { accountReads.delete(parseAccountRef(raw).ref) } catch { /* an invalid ref was refused before any write */ }
    }
  }

  const context = (): AssignContext => ({ cpaSameHost: control.cpaSameHost(), kernel: kernelView() })
  const assignDeps = () => ({ store: store(), control, context: context(), audit, now: () => new Date(now()).toISOString() })

  /** Validate changed mihomo entries (`mihomo -t` via the kernel module), then ask for a reload. `removed` forces the reload. */
  async function validateAndReload(ids: string[], reason: string, removed = false) {
    if (!ids.length) {
      if (removed) notifyPoolChanged(reason)
      return
    }
    const kernel = proxyKernel()
    if (kernel?.validate) {
      const pool = store().read()
      const entries = pool.entries.filter(entry => ids.includes(entry.id) && entry.kind === 'mihomo')
      try {
        const invalid = await kernel.validate(entries)
        if (invalid) {
          store().update((next) => {
            for (const entry of next.entries) {
              if (!ids.includes(entry.id) || entry.kind !== 'mihomo') continue
              const problem = invalid.get(entry.id)
              entry.validity = problem ? 'invalid' : 'ok'
              if (problem) entry.invalidReason = scrubProxySecrets(problem, next).slice(0, 200)
              else delete entry.invalidReason
            }
          })
        }
      } catch { /* validation failure leaves the entries unverified; the kernel validates again before reload */ }
    }
    notifyPoolChanged(reason)
  }

  function view() {
    const { pool, readOnly } = store().snapshot()
    const health = store().readHealth()
    const used = usageByEntry(pool)
    const ctx = context()
    const entries = pool.entries.map(entry => entryView(entry, used.get(entry.id), health.entries[entry.id], ctx))
    const accountsLinked = Object.keys(pool.links).filter(ref => /^cpa:(?!global$|channel:|key:)/.test(ref)).length
    const global = pool.observed['cpa:global']
    const defaultEntry = pool.defaultEntryId ? pool.entries.find(entry => entry.id === pool.defaultEntryId) : undefined
    return {
      backend: 'cpa' as const,
      cpaSameHost: ctx.cpaSameHost,
      kernel: projectKernelView(ctx.kernel, pool),
      ports: managedRange(),
      readOnly,
      summary: {
        entries: entries.length,
        enabled: entries.filter(entry => entry.enabled).length,
        mihomo: entries.filter(entry => entry.kind === 'mihomo').length,
        needsKernel: ctx.kernel.state === 'unavailable' ? entries.filter(entry => entry.kind === 'mihomo').length : 0,
        inUse: entries.filter(entry => entry.usedBy.total > 0).length,
        accountsLinked,
        invalid: entries.filter(entry => entry.validity === 'invalid').length,
        subscriptions: pool.subscriptions.length,
      },
      entries,
      subscriptions: pool.subscriptions.map(subscriptionView),
      migration: {
        firstRunAt: pool.migration.firstRunAt ?? null,
        firstRunImported: pool.migration.firstRunImported ?? null,
        lastScanAt: pool.migration.lastScanAt ?? null,
        pending: pool.migration.pending ?? null,
        ignored: pool.migration.ignored.length,
      },
      default: { mode: global?.mode ?? 'unknown', entryId: defaultEntry?.id ?? null, masked: global?.masked ?? null, at: global?.at ?? null },
      signinNote: SIGNIN_NOTE,
    }
  }

  function options() {
    const { pool } = store().snapshot()
    const health = store().readHealth()
    const used = usageByEntry(pool)
    const ctx = context()
    return {
      builtins: [{ id: 'inherit', name: '继承全局' }, { id: 'direct', name: '直连' }],
      options: pool.entries.filter(entry => entry.enabled).map((entry) => {
        const item = entryView(entry, used.get(entry.id), health.entries[entry.id], ctx)
        const services = Object.fromEntries(Object.entries(item.health?.services ?? {}).map(([service, cell]) => [service, cell.state]))
        return {
          id: item.id, name: item.name, protocol: item.protocol, country: item.health?.exit?.country ?? null,
          assignable: item.assignable, reason: item.unassignableReason, health: services, usedBy: item.usedBy.total, tags: item.tags,
        }
      }),
    }
  }

  async function accounts() {
    const { pool } = store().snapshot()
    const ctx = context()
    const names = new Map(pool.entries.map(entry => [entry.id, entry.name]))
    const rows: Array<Record<string, unknown>> = []
    const credentials = await control.listCredentials()
    for (const credential of credentials) {
      const ref = `cpa:${credential.name}`
      // a list that carries proxy_url is live; CPA's does not, so its value is the last observed one
      const live = credential.proxyUrl !== undefined
      const mode = live ? proxyMode(credential.proxyUrl as string) : pool.observed[ref]?.mode ?? 'unknown'
      const entryId = live ? (mode === 'url' ? matchEntryForUrl(pool, credential.proxyUrl as string)?.id ?? null : null) : pool.links[ref]?.entryId ?? null
      rows.push({
        ref, kind: 'credential', provider: credential.provider, name: credential.name, label: credential.label, disabled: credential.disabled,
        mode,
        masked: live ? (mode === 'url' ? maskAccountProxy(credential.proxyUrl as string) : null) : pool.observed[ref]?.masked ?? null,
        entryId, entryName: entryId ? names.get(entryId) ?? null : null,
        observedAt: live ? null : pool.observed[ref]?.at ?? null,
        assignable: true,
        restorable: pool.links[ref]?.prev !== undefined,
      })
    }
    const global = pool.observed['cpa:global']
    rows.push({ ref: 'cpa:global', kind: 'global', provider: 'global', name: 'CPA 全局', label: 'CPA 全局', disabled: false, mode: global?.mode ?? 'unknown', masked: global?.masked ?? null, entryId: pool.links['cpa:global']?.entryId ?? null, entryName: names.get(pool.links['cpa:global']?.entryId ?? '') ?? null, observedAt: global?.at ?? null, assignable: true, restorable: false })
    return { backend: 'cpa' as const, cpaSameHost: ctx.cpaSameHost, signinNote: SIGNIN_NOTE, accounts: rows }
  }

  async function parse(body: Record<string, unknown>) {
    const text = typeof body.text === 'string' ? body.text : ''
    if (!text.trim()) throw new ProxyError(400, 'invalid_request', '请粘贴要导入的内容')
    try {
      const preview = await buildPreview(store(), text, {
        limit: task => upstreamLimiter.run(task),
        ...deps.preview,
        now,
      })
      return previewView(preview, { kernelAvailable: kernelView().state !== 'unavailable' })
    } catch (error) {
      if (error instanceof ProxyParseError) throw new ProxyError(error.code === 'too_large' ? 413 : 422, error.code, error.message, error.hint ? { hint: error.hint } : {})
      throw error
    }
  }

  async function importPreview(body: Record<string, unknown>) {
    const preview = takePreview(body.previewId, now())
    const result = await commitImport(store(), preview, { keys: body.keys, tags: body.tags, subscriptions: body.subscriptions }, { probe: deps.probe, now })
    audit('proxy-import', 'pool', `added=${result.added.length} updated=${result.updated.length} subscriptions=${result.subscriptions.length}`)
    for (const item of result.subscriptions) audit('proxy-sub-add', item.id, `nodes=${item.added + item.updated}`)
    await validateAndReload(result.mihomoChanged, 'import')
    return {
      added: result.added.length,
      updated: result.updated.length,
      skipped: result.skipped,
      ids: result.added,
      subscriptions: result.subscriptions,
      assignPlan: result.assignPlan.map(item => ({ account: `cpa:${maskIdentity(item.account.slice(4))}`, accountRef: item.account, entryId: item.entryId, status: item.status })),
      entries: view().entries.filter(entry => result.added.includes(entry.id) || result.updated.includes(entry.id)),
    }
  }

  function entryOr404(id: string): ProxyEntry {
    if (!ENTRY_ID.test(id)) throw new ProxyError(404, 'entry_not_found')
    const entry = store().read().entries.find(item => item.id === id)
    if (!entry) throw new ProxyError(404, 'entry_not_found')
    return entry
  }

  /** Move an entry's linked accounts before it disappears/is disabled. 'keep' leaves url-entry accounts as they are. */
  async function reassignLinked(entry: ProxyEntry, reassign: unknown, confirm: unknown) {
    const pool = store().read()
    const { writable, readOnly } = linkedRefs(pool, entry.id)
    if (!writable.length && !readOnly.length) return { moved: 0 }
    if (reassign === undefined || reassign === null || reassign === '') {
      throw new ProxyError(409, 'proxy_in_use', undefined, { accounts: writable.length, readOnly: readOnly.length })
    }
    if (reassign === 'keep') {
      if (entry.kind === 'mihomo') throw new ProxyError(409, 'proxy_in_use', '加密节点删除后账号会断开，请先把账号换到别的出口', { accounts: writable.length })
      return { moved: 0 }
    }
    if (readOnly.length) throw new ProxyError(409, 'proxy_in_use', '还有渠道设置引用这个出口，只能在网关里修改', { readOnly: readOnly.length })
    const target = resolveTarget(pool, reassign)
    if (target.mode === 'entry' && target.entry.id === entry.id) throw new ProxyError(400, 'invalid_target')
    if (confirm !== true && confirm !== '1' && confirm !== 'true') throw new ProxyError(409, 'confirm_required', `将更新 ${writable.length} 个账号`, { accounts: writable.length })
    const result = await assignAccounts(assignDeps(), reassign, writable.map(ref => ref.ref))
    if (result.failed) throw new ProxyError(502, 'control_plane_unavailable', `有 ${result.failed} 个账号没能改过去，出口未删除`, { results: result.results })
    return { moved: result.updated }
  }

  async function updateEntry(id: string, body: Record<string, unknown>) {
    const entry = entryOr404(id)
    const fields: string[] = []
    let reapply = false
    if (body.enabled === false && entry.enabled) await reassignLinked(entry, body.reassign, body.confirm)
    if (typeof body.url === 'string') {
      if (entry.kind !== 'url') throw new ProxyError(400, 'invalid_request', '只有地址类出口可以改地址')
      const candidate = parseShareLink(body.url.trim())
      if (candidate.status !== 'ok' || candidate.kind !== 'url' || !candidate.url || !candidate.dedupKey) throw new ProxyError(400, 'invalid_request', '代理地址无效（支持 http / https / socks5）')
      if (candidate.server && isLoopbackHost(candidate.server) && candidate.serverPort && isManagedPort(candidate.serverPort)) throw new ProxyError(400, 'managed_port_url')
      const pool = store().read()
      const fingerprint = fingerprintOf(pool, candidate.dedupKey)
      if (pool.entries.some(item => item.id !== id && item.fingerprint === fingerprint)) throw new ProxyError(409, 'invalid_request', '代理池里已有这个地址')
      const { writable } = linkedRefs(pool, id)
      if (candidate.url !== entry.url && writable.length && body.confirm !== true) {
        throw new ProxyError(409, 'confirm_required', `将更新 ${writable.length} 个账号`, { accounts: writable.length })
      }
      if (candidate.url !== entry.url) {
        reapply = writable.length > 0
        store().update((next) => {
          const target = next.entries.find(item => item.id === id)
          if (!target) return
          target.url = candidate.url
          target.protocol = candidate.protocol ?? target.protocol
          target.server = candidate.server ?? target.server
          target.serverPort = candidate.serverPort ?? target.serverPort
          target.fingerprint = fingerprintOf(next, candidate.dedupKey as string)
          if (candidate.external) target.external = true
          else delete target.external
          if (target.nameAuto && candidate.server) target.name = cleanLabel(candidate.server)
          target.updatedAt = new Date(now()).toISOString()
        })
        fields.push('url')
      }
    }
    store().update((next) => {
      const target = next.entries.find(item => item.id === id)
      if (!target) throw new ProxyError(404, 'entry_not_found')
      if (typeof body.name === 'string') {
        const name = cleanLabel(body.name)
        if (!name) throw new ProxyError(400, 'invalid_request', '名称不能为空')
        target.name = name
        target.nameAuto = false
        fields.push('name')
      }
      if (Array.isArray(body.tags)) {
        target.tags = [...new Set(body.tags.filter((tag): tag is string => typeof tag === 'string').map(tag => cleanLabel(tag, 24)).filter(Boolean))].slice(0, 16)
        fields.push('tags')
      }
      if (typeof body.enabled === 'boolean' && body.enabled !== target.enabled) {
        target.enabled = body.enabled
        fields.push('enabled')
      }
      if (fields.length) target.updatedAt = new Date(now()).toISOString()
    })
    let reapplied = null
    if (reapply) reapplied = await reapplyUrlEdit(assignDeps(), id)
    if (fields.length) audit('proxy-update', id, `fields=${fields.join(',')}${reapplied ? ` accounts=${reapplied.updated} drifted=${reapplied.drifted}` : ''}`)
    if (entry.kind === 'mihomo' && fields.includes('enabled')) notifyPoolChanged('enable')
    const pool = store().read()
    const updated = pool.entries.find(item => item.id === id) as ProxyEntry
    return { entry: entryView(updated, usageByEntry(pool).get(id), store().readHealth().entries[id], context()), reapplied }
  }

  async function removeEntry(id: string, query: Record<string, unknown>) {
    const entry = entryOr404(id)
    const moved = await reassignLinked(entry, query.reassign, query.confirm)
    store().update((pool) => {
      const index = pool.entries.findIndex(item => item.id === id)
      if (index < 0) return
      const [removed] = pool.entries.splice(index, 1)
      retirePort(pool, removed.port)
      for (const [ref, link] of Object.entries(pool.links)) if (link.entryId === id) delete pool.links[ref]
      if (pool.defaultEntryId === id) pool.defaultEntryId = null
      // a removed migrated/preset/subscription exit must not come back with the next scan or refresh
      if (['migrated', 'preset', 'subscription'].includes(removed.source) && !pool.migration.ignored.includes(removed.fingerprint)) {
        pool.migration.ignored = [...pool.migration.ignored, removed.fingerprint].slice(-5000)
      }
      for (const subscription of pool.subscriptions) {
        if (subscription.id === removed.subscriptionId) subscription.nodeCount = pool.entries.filter(item => item.subscriptionId === subscription.id).length
      }
    })
    audit('proxy-remove', id, `moved=${moved.moved}`)
    if (entry.kind === 'mihomo') notifyPoolChanged('remove')
    return { ok: true, moved: moved.moved }
  }

  async function assign(body: Record<string, unknown>) {
    if (body.confirm !== true) throw new ProxyError(409, 'confirm_required', undefined, { accounts: Array.isArray(body.accounts) ? body.accounts.length : 0 })
    const pool = store().read()
    const target = resolveTarget(pool, body.target)
    checkAssignable(target, context())
    const warnings = assignWarnings(target, target.mode === 'entry' ? store().readHealth().entries[target.entry.id] : undefined)
    try {
      const result = await assignAccounts(assignDeps(), body.target, body.accounts)
      return { ...result, warnings }
    } finally {
      forgetReads(body.accounts)
    }
  }

  async function unassign(body: Record<string, unknown>) {
    if (body.confirm !== true) throw new ProxyError(409, 'confirm_required')
    try {
      return await unassignAccounts(assignDeps(), body.accounts, body.restore === true)
    } finally {
      forgetReads(body.accounts)
    }
  }

  /** The /accounts page's read model: local state only (no CPA, vendor or exit traffic). */
  async function egress() {
    const { pool } = store().snapshot()
    return egressView({
      pool,
      health: store().readHealth().entries,
      used: usageByEntry(pool),
      context: context(),
      presets: control.presets(),
    })
  }

  /**
   * One account's exit, read from its owner (the CPA management API's copy of the credential, reduced to proxy_url
   * server-side) and noted in the pool's index. Never returns the URL itself.
   */
  async function egressAccount(query: Record<string, unknown>) {
    const ref = parseAccountRef(query.ref)
    if (ref.kind === 'readonly') throw new ProxyError(409, 'account_read_only')
    const provider = typeof query.provider === 'string' && /^[a-z0-9][a-z0-9-]{0,31}$/.test(query.provider) ? query.provider : undefined
    const cached = accountReads.get(ref.ref)
    let read = cached && now() - cached.at < EGRESS_READ_TTL_MS ? cached.value : null
    if (!read) {
      read = ref.kind === 'credential' ? control.readCredentialProxy(ref.name) : control.readGlobalProxy()
      const entry = { at: now(), value: read }
      accountReads.set(ref.ref, entry)
      read.catch(() => { if (accountReads.get(ref.ref) === entry) accountReads.delete(ref.ref) })
    }
    const raw = await read
    const at = new Date(now()).toISOString()
    const { pool, readOnly } = store().snapshot()
    const value = accountValue(pool, raw, at)
    const seen = pool.observed[ref.ref]
    const changed = !seen || seen.mode !== value.mode || (seen.masked ?? null) !== value.masked || (pool.links[ref.ref]?.entryId ?? null) !== value.entryId
    if (!readOnly && (changed || (provider && !seen?.provider))) {
      try {
        store().update((next) => { observeAccount(next, ref.ref, raw, next.observed[ref.ref]?.provider ?? provider, 'scan', at) })
      } catch { /* the index is rebuildable; a failed note never fails the read */ }
    }
    const entryName = value.entryId ? pool.entries.find(entry => entry.id === value.entryId)?.name ?? null : null
    return { ref: ref.ref, ...value, entryName, preset: presetIndex(control.presets(), raw) }
  }

  async function setDefault(body: Record<string, unknown>) {
    const inheriting = Object.entries(store().read().observed).filter(([ref, item]) => /^cpa:(?!global$|channel:|key:)/.test(ref) && item.mode === 'inherit').length
    if (body.confirm !== true) throw new ProxyError(409, 'confirm_required', `${inheriting} 个继承全局的账号会改走这个出口`, { accounts: inheriting })
    const result = await assignAccounts(assignDeps(), body.target, ['cpa:global'])
    if (!result.failed) audit('proxy-default', 'cpa:global', `to=${result.target}`)
    return { ...result, inheriting }
  }

  async function migrate(body: Record<string, unknown>) {
    if (store().snapshot().readOnly) throw new ProxyError(409, 'pool_read_only')
    if (body.dryRun !== false) {
      const scan = await scanSources(control, { now })
      return { dryRun: true, ...planView(planMigration(store().read(), scan.sources), scan.sources, scan.id), cooldownMs: MIGRATE_COOLDOWN_MS }
    }
    const result = await runMigration(store(), control, { mode: 'apply', scanId: body.scanId ?? undefined, now })
    audit('proxy-migrate', 'pool', `created=${result.applied.created.length} linked=${result.applied.linked}`)
    return { dryRun: false, summary: migrationSummary(result), created: result.applied.created.length, linked: result.applied.linked, unlinked: result.applied.unlinked }
  }

  function unignore(body: Record<string, unknown>) {
    if (body.all !== true) throw new ProxyError(400, 'invalid_request')
    const count = store().update((pool) => {
      const n = pool.migration.ignored.length
      pool.migration.ignored = []
      return n
    })
    audit('proxy-migrate', 'pool', `unignored=${count}`)
    return { unignored: count }
  }

  function exportMasked() {
    audit('proxy-export', 'pool', `entries=${store().read().entries.length}`)
    return maskedExport(store().read(), new Date(now()).toISOString())
  }

  function exportSecrets(body: Record<string, unknown>) {
    if (body.withSecrets !== true || body.confirm !== 'EXPORT-SECRETS') throw new ProxyError(400, 'export_confirm_required')
    const pool = store().read()
    audit('proxy-export-secrets', 'pool', `entries=${pool.entries.length} subscriptions=${pool.subscriptions.length}`)
    return secretExport(pool, new Date(now()).toISOString())
  }

  function subscriptionOr404(id: string) {
    if (!SUBSCRIPTION_ID.test(id)) throw new ProxyError(404, 'subscription_not_found')
    const subscription = store().read().subscriptions.find(item => item.id === id)
    if (!subscription) throw new ProxyError(404, 'subscription_not_found')
    return subscription
  }

  function updateSubscription(id: string, body: Record<string, unknown>) {
    subscriptionOr404(id)
    const updated = store().update((pool) => {
      const target = pool.subscriptions.find(item => item.id === id)
      if (!target) throw new ProxyError(404, 'subscription_not_found')
      if (typeof body.name === 'string') {
        const name = cleanLabel(body.name, 48)
        if (!name) throw new ProxyError(400, 'invalid_request', '名称不能为空')
        target.name = name
      }
      if (body.intervalH !== undefined) {
        const hours = Number(body.intervalH)
        if (!Number.isInteger(hours) || hours < 6 || hours > 720) throw new ProxyError(400, 'invalid_request', '更新间隔应为 6–720 小时')
        target.intervalH = hours
        const base = target.lastFetchAt ? Date.parse(target.lastFetchAt) : now()
        target.nextAt = new Date(base + hours * 3_600_000).toISOString()
      }
      return target
    })
    audit('proxy-sub-update', id, '')
    return subscriptionView(updated)
  }

  function removeSubscription(id: string, query: Record<string, unknown>) {
    subscriptionOr404(id)
    const keepNodes = query.keepNodes === '1' || query.keepNodes === 'true' || query.keepNodes === true
    const result = store().update((pool) => {
      const linked = new Set(Object.values(pool.links).map(link => link.entryId))
      let kept = 0
      let removed = 0
      const changed: boolean[] = []
      pool.entries = pool.entries.filter((entry) => {
        if (entry.subscriptionId !== id) return true
        if (keepNodes || linked.has(entry.id) || pool.defaultEntryId === entry.id) {
          delete entry.subscriptionId
          delete entry.staleInSubscription
          entry.source = 'manual'
          kept++
          return true
        }
        retirePort(pool, entry.port)
        if (entry.kind === 'mihomo') changed.push(true)
        removed++
        return false
      })
      pool.subscriptions = pool.subscriptions.filter(item => item.id !== id)
      return { kept, removed, kernel: changed.length > 0 }
    })
    audit('proxy-sub-remove', id, `kept=${result.kept} removed=${result.removed}`)
    if (result.kernel) notifyPoolChanged('subscription-remove')
    return { kept: result.kept, removed: result.removed }
  }

  async function refresh(id: string) {
    subscriptionOr404(id)
    const last = refreshMarks.get(id) ?? 0
    const wait = last + SUBSCRIPTION_REFRESH_COOLDOWN_MS - now()
    if (wait > 0) throw new ProxyError(429, 'cooldown', undefined, { retryAfterSec: Math.ceil(wait / 1000) })
    refreshMarks.set(id, now())
    const result = await refreshSubscription(store(), id, { limit: task => upstreamLimiter.run(task), ...deps.preview, probe: deps.probe, now })
    audit('proxy-sub-refresh', id, `added=${result.added.length} updated=${result.updated.length} removed=${result.removed} stale=${result.stale}`)
    await validateAndReload([...result.added, ...result.updated], 'subscription', result.removed > 0)
    return { added: result.added.length, updated: result.updated.length, removed: result.removed, stale: result.stale, nodeCount: result.nodeCount }
  }

  async function test(id: string | null) {
    const checker = proxyChecker()
    if (!checker) throw new ProxyError(501, 'checker_unavailable')
    if (id) entryOr404(id)
    return id ? checker.testEntry(id) : checker.testInUse()
  }

  async function kernelAction(action: string) {
    if (!['start', 'stop', 'restart'].includes(action)) throw new ProxyError(404, 'invalid_request', '不支持的内核操作')
    const kernel = proxyKernel()
    if (!kernel?.action) throw new ProxyError(501, 'kernel_not_attached')
    const result = await kernel.action(action as 'start' | 'stop' | 'restart')
    audit(`proxy-kernel-${action}`, 'kernel', '')
    return result
  }

  /** Index hook: a credential's proxy changed through any writer (accounts UI, cradmin, assign). Never throws. */
  function noteCredentialProxy(name: string, url: string) {
    try {
      if (store().snapshot().readOnly) return
      const ref = `cpa:${name}`
      accountReads.delete(ref)
      const pool = store().read()
      // maintain accounts the pool already tracks, or ones that now point at a pool entry; nothing else
      if (!pool.links[ref] && !pool.observed[ref] && !matchEntryForUrl(pool, url)) return
      store().update((next) => {
        const provider = next.observed[ref]?.provider ?? next.links[ref]?.provider
        observeAccount(next, ref, url, provider, 'hook', new Date(now()).toISOString())
      })
    } catch { /* the index is rebuildable; a hook failure never fails the account write */ }
  }

  return {
    store, control, view, options, accounts, parse, importPreview, updateEntry, removeEntry, assign, unassign, setDefault,
    migrate, unignore, exportMasked, exportSecrets, updateSubscription, removeSubscription, refresh, test, kernelAction,
    noteCredentialProxy, validateAndReload, egress, egressAccount,
  }
}


export type ProxyService = ReturnType<typeof createProxyService>

let shared: ProxyService | null = null

export function proxyService(deps?: ProxyServiceDeps): ProxyService {
  if (!shared) shared = createProxyService(deps)
  return shared
}

/** `{error, code}` + extras (counts, retryAfterSec); unknown errors never echo their message. */
export function proxyErrorResponse(error: unknown): { status: number; body: Record<string, unknown> } {
  if (error instanceof ProxyError) return { status: error.status, body: { error: error.message, code: error.code, ...error.extra } }
  // a CPA refusal (CPARequestError) or an unreachable control plane
  const status = Number((error as { status?: unknown })?.status)
  if ((Number.isInteger(status) && status >= 400) || (error instanceof TypeError && /fetch failed/i.test(error.message)) || (error as { name?: string })?.name === 'TimeoutError') {
    return { status: 502, body: { error: '控制面暂时不可用', code: 'control_plane_unavailable' } }
  }
  return { status: 500, body: { error: '操作失败', code: 'internal_error' } }
}

export function registerProxyRoutes(app: express.Express, service: ProxyService): void {
  const handle = (run: (req: express.Request, res: express.Response) => unknown, status = 200) => async (req: express.Request, res: express.Response) => {
    res.setHeader('Cache-Control', 'no-store')
    try {
      res.status(status).json(await run(req, res))
    } catch (error) {
      const { status: code, body } = proxyErrorResponse(error)
      if (code === 429 && typeof body.retryAfterSec === 'number') res.setHeader('Retry-After', String(body.retryAfterSec))
      if (code === 500) console.error(`[proxy] ${req.method} ${req.path}: ${scrubProxySecrets(error instanceof Error ? error.message : error, service.store().read())}`)
      res.status(code).json(body)
    }
  }
  const body = (req: express.Request): Record<string, unknown> =>
    (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body as Record<string, unknown> : {})
  const query = (req: express.Request): Record<string, unknown> => ({ ...(req.query as Record<string, unknown>) })
  const param = (req: express.Request) => String(req.params.id ?? '')

  app.get('/api/proxies', handle(() => service.view()))
  app.get('/api/proxies/options', handle(() => service.options()))
  app.get('/api/proxies/accounts', handle(() => service.accounts()))
  app.get('/api/proxies/egress', handle(() => service.egress()))
  app.get('/api/proxies/egress/account', handle(req => service.egressAccount(query(req))))
  app.get('/api/proxies/export', handle(() => service.exportMasked()))
  app.post('/api/proxies/export', handle(req => service.exportSecrets(body(req))))
  app.post('/api/proxies/parse', handle(req => service.parse(body(req))))
  app.post('/api/proxies/import', handle(req => service.importPreview(body(req))))
  app.post('/api/proxies/test', handle(() => service.test(null), 202))
  app.post('/api/proxies/assign', handle(req => service.assign(body(req))))
  app.post('/api/proxies/unassign', handle(req => service.unassign(body(req))))
  app.put('/api/proxies/default', handle(req => service.setDefault(body(req))))
  app.post('/api/proxies/migrate', handle(req => service.migrate(body(req))))
  app.post('/api/proxies/migrate/unignore', handle(req => service.unignore(body(req))))
  app.post('/api/proxies/kernel/:action', handle(req => service.kernelAction(String(req.params.action ?? ''))))
  app.patch('/api/proxies/subscriptions/:id', handle(req => service.updateSubscription(param(req), body(req))))
  app.delete('/api/proxies/subscriptions/:id', handle(req => service.removeSubscription(param(req), query(req))))
  app.post('/api/proxies/subscriptions/:id/refresh', handle(req => service.refresh(param(req))))
  app.post('/api/proxies/:id/test', handle(req => service.test(param(req)), 202))
  app.patch('/api/proxies/:id', handle(req => service.updateEntry(param(req), body(req))))
  app.delete('/api/proxies/:id', handle(req => service.removeEntry(param(req), query(req))))
}

/** Masked display helpers re-exported for the CLI/UI layer. */
export { entryDisplay, maskSubscriptionUrl }
