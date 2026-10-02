import type express from 'express'
import { config } from './config.js'
import { addAudit } from './db.js'
import { availableItems, catalogItemView, CPA_CATALOG, DEFAULT_CATALOG_FILE, loadMagpieCatalog, zhCopy, type MagpieCatalog } from './accountCatalog.js'
import { ACCOUNTS_MESSAGES, AccountsError, errorResponse } from './accountsError.js'
import { kernelCaller, KernelProbeCache, type KernelCall, type KernelHealth } from './magpieKernel.js'
import { accountView, LOGIN_ACTIONS, MagpieAccounts, type AccountView, type KernelAgent, type LoginAction, type QuotaLimiter, type QuotaRegistry } from './magpieAccounts.js'
import { SignInManager, type RelayFn } from './magpieSignin.js'
import { autoupdatePaths, writeSigninLease } from './autoupdate.js'
import { syncRegistry, upstreamLimiter } from './syncRegistry.js'

/**
 * /api/accounts — the accounts page's one backend (ACCOUNTS-ALIGN §2.3).
 *
 * `backend` decides everything and is computed per request:
 * - `cpa`: GATEWAY_ENGINE=cpa, or magpie with the CPA control plane. The page keeps today's endpoints
 *   (/api/channels, /api/monitor, /api/cpa/oauth/*, /api/credentials/*), unchanged; these routes only list the
 *   CPA providers and refuse writes with 409 `cpa_backend`.
 * - `magpie`: magpie + local control plane and a kernel with the account capabilities.
 * - `magpie-unavailable`: same mode, but the kernel is down, too old, or the catalog file is missing.
 * Signed-in Magpie accounts do not serve the gateway yet (`routing:false`); that is the next round.
 * Admin only: key sessions are refused by the default-deny guard (server/auth.ts) before reaching these.
 */

export type AccountsBackend =
  | { kind: 'cpa' }
  | { kind: 'magpie'; health: KernelHealth; catalog: MagpieCatalog }
  | { kind: 'magpie-unavailable'; reason: string }

export const ROUTING_NOTE = '已登录的账号暂不参与网关路由（下一轮接入）'

export type AccountsServiceDeps = {
  call?: KernelCall
  socket?: () => string
  /** true when GATEWAY_ENGINE=magpie and MAGPIE_CONTROL_PLANE=local */
  magpieLocal?: () => boolean
  hostExec?: () => boolean
  catalogFile?: string
  now?: () => number
  relay?: RelayFn
  audit?: (action: string, target: string, details: string) => void
  limiter?: QuotaLimiter
  registry?: QuotaRegistry
  quotaTtlMs?: number
  /** accounts changed (sign-in done, an action): drop caches that read them */
  onAccountsChanged?: () => void
  /** where live sign-ins are announced to the auto-update job; unset = not announced (tests) */
  signinLeaseFile?: string | null
}

export function createAccountsService(deps: AccountsServiceDeps = {}) {
  const now = deps.now ?? Date.now
  const call = deps.call ?? kernelCaller(deps.socket ?? (() => config.magpieKernelSocket))
  const magpieLocal = deps.magpieLocal ?? (() => config.gatewayEngine === 'magpie' && config.magpieControlPlane === 'local')
  const hostExec = deps.hostExec ?? (() => config.magpieSigninHostExec)
  const audit = deps.audit ?? addAudit
  const probes = new KernelProbeCache(call, now)
  const accounts = new MagpieAccounts({
    call, now, audit,
    limiter: deps.limiter ?? upstreamLimiter,
    registry: deps.registry ?? syncRegistry,
    quotaTtlMs: deps.quotaTtlMs ?? config.magpieAccountQuotaTtlMs,
  })
  const changed = () => {
    accounts.invalidate()
    try { deps.onAccountsChanged?.() } catch { /* cache hooks never fail a write */ }
  }
  // the lease file tells the scheduled auto-update job (scripts/magpie-autoupdate.mjs) not to restart the kernel mid-sign-in
  const lease = deps.signinLeaseFile ?? null
  const signins = new SignInManager({ call, now, relay: deps.relay, audit, onDone: changed,
    onLive: live => { if (lease) writeSigninLease(lease, live) } })

  async function backend(): Promise<AccountsBackend> {
    if (!magpieLocal()) return { kind: 'cpa' }
    const probe = await probes.get()
    if (!probe.ok) return { kind: 'magpie-unavailable', reason: probe.reason }
    const catalog = loadMagpieCatalog(deps.catalogFile ?? DEFAULT_CATALOG_FILE)
    if (!catalog) return { kind: 'magpie-unavailable', reason: 'catalog_missing' }
    return { kind: 'magpie', health: probe.health, catalog }
  }

  /** Magpie routes only: the CPA backend keeps its own endpoints; an unusable kernel says why. */
  async function requireMagpie(): Promise<Extract<AccountsBackend, { kind: 'magpie' }>> {
    const current = await backend()
    if (current.kind === 'cpa') throw new AccountsError(409, 'cpa_backend')
    if (current.kind === 'magpie-unavailable') {
      const status = current.reason === 'kernel_outdated' ? 501 : current.reason === 'kernel_timeout' ? 504 : 503
      throw new AccountsError(status, current.reason)
    }
    return current
  }

  const nameOf = (catalog: MagpieCatalog | null, agent: string) => catalog?.items.find(item => item.agent === agent)
  const providerView = (catalog: MagpieCatalog, group: KernelAgent) => {
    const item = nameOf(catalog, group.agent)
    const views: AccountView[] = group.accounts.map(account => accountView(account, group.accounts, accounts.quota.view(group.agent, account.user)))
    return {
      agent: group.agent,
      name: item?.short.zh ?? group.agent,
      icon: item?.icon ?? '',
      single: item?.single ?? false,
      accounts: views,
      counts: {
        total: views.length,
        on: views.filter(view => view.on).length,
        attention: views.filter(view => view.needsRelogin || view.quota?.errorCode === 'signed_out').length,
      },
    }
  }

  return {
    backend,
    signins,
    accounts,
    /** Synchronous: the magpie backend answered its last probe (the sync center's job state reads this). */
    magpieReady: () => magpieLocal() && probes.peek()?.ok === true,
    /** `upstream.oauthConnected` in the magpie backend: any account ticked for use */
    anyLoginOn: async () => (await backend()).kind === 'magpie' && accounts.anyOn(),

    async list() {
      const current = await backend()
      if (current.kind === 'cpa') {
        return { backend: 'cpa' as const, available: true, reason: null, message: null, routing: true, providers: [], excluded: [], counts: null }
      }
      if (current.kind === 'magpie-unavailable') {
        return { backend: 'magpie-unavailable' as const, available: false, reason: current.reason,
          message: ACCOUNTS_MESSAGES[current.reason] ?? '内核不可用', routing: false, providers: [], excluded: [], counts: null }
      }
      const listing = await accounts.list()
      const groups = listing.agents.filter(group => group.accounts.length)
      // allowances due are read in the background; this answer never waits for a vendor
      void accounts.quota.refresh(groups).catch(() => undefined)
      const providers = groups.map(group => providerView(current.catalog, group))
      const quotaAsOf = accounts.quota.asOf()
      return {
        backend: 'magpie' as const,
        available: true,
        reason: null,
        message: null,
        revision: current.health.revision.slice(0, 7),
        routing: false,
        routingNote: ROUTING_NOTE,
        providers,
        excluded: listing.excluded.map(entry => ({
          agent: entry.agent,
          name: nameOf(current.catalog, entry.agent)?.short.zh ?? entry.agent,
          state: entry.removed ? 'removed' as const : 'signed_out' as const,
          note: entry.removed ? '已从 magpie 移除，仍保持登录' : '已保存，但内核里没有登录这个服务',
          quiet: entry.quiet,
        })),
        signingIn: signins.live(),
        counts: {
          accounts: providers.reduce((sum, provider) => sum + provider.counts.total, 0),
          providers: providers.length,
          attention: providers.reduce((sum, provider) => sum + provider.counts.attention, 0),
        },
        quotaAsOf: quotaAsOf === null ? null : new Date(quotaAsOf).toISOString(),
      }
    },

    async catalog() {
      const current = await backend()
      if (current.kind === 'cpa') {
        return { backend: 'cpa' as const, available: true, reason: null, items: CPA_CATALOG, copy: {} }
      }
      if (current.kind === 'magpie-unavailable') {
        return { backend: 'magpie-unavailable' as const, available: false, reason: current.reason,
          message: ACCOUNTS_MESSAGES[current.reason] ?? '内核不可用', items: [], copy: {} }
      }
      const listing = await accounts.list().catch(() => null)
      const signedIn = new Map((listing?.agents ?? []).map(group => [group.agent, group.accounts.length]))
      return {
        backend: 'magpie' as const,
        available: true,
        reason: null,
        revision: current.health.revision.slice(0, 7),
        catalogRevision: current.catalog.revision.slice(0, 7),
        /** the catalog was generated from another Magpie revision than the running kernel */
        stale: current.catalog.revision !== current.health.revision,
        routing: false,
        routingNote: ROUTING_NOTE,
        copy: zhCopy(current.catalog),
        items: availableItems(current.catalog, current.health)
          .map(item => catalogItemView(current.catalog, item, current.health, hostExec(), signedIn.get(item.agent) ?? 0)),
      }
    },

    async startSignIn(body: Record<string, unknown>) {
      const current = await requireMagpie()
      return signins.start({ agent: body.agent, site: body.site, confirmRisk: body.confirmRisk }, { health: current.health, catalog: current.catalog, hostExec: hostExec() })
    },

    async login(action: string, body: Record<string, unknown>) {
      await requireMagpie()
      if (!LOGIN_ACTIONS.includes(action as LoginAction)) throw new AccountsError(404, 'invalid_action')
      const group = await accounts.action(action as LoginAction, body.agent, body.id)
      changed()
      const current = await backend()
      return { ok: true, provider: current.kind === 'magpie' ? providerView(current.catalog, group) : null }
    },

    async codexReset(body: Record<string, unknown>) {
      await requireMagpie()
      return accounts.codexReset(body.id)
    },

    /**
     * The sync center's manual run of `account-quota` in the magpie backend: due agents only (the 5 min floor
     * holds), shaped for summarizeAccountQuota. null outside the magpie backend.
     */
    async refreshForSync() {
      const current = await backend()
      if (current.kind !== 'magpie') return null
      const groups = (await accounts.list()).agents.filter(group => group.accounts.length)
      await accounts.quota.refresh(groups, { record: false })
      return {
        accounts: groups.flatMap(group => group.accounts.map(account => ({ normalizedQuota: { error: accounts.quota.view(group.agent, account.user)?.error ?? null } }))),
        quotaSupport: { supported: true, reason: null },
      }
    },

    async refreshQuota(body: Record<string, unknown>) {
      await requireMagpie()
      const listing = await accounts.list()
      const agent = typeof body.agent === 'string' ? body.agent : null
      const groups = listing.agents.filter(group => group.accounts.length && (!agent || group.agent === agent))
      if (agent && !groups.length) throw new AccountsError(404, 'account_not_found')
      const due = new Set(accounts.quota.due(groups).map(group => group.agent))
      await accounts.quota.refresh(groups)
      return {
        results: groups.map(group => {
          const next = accounts.quota.nextAllowedAt(group.agent)
          return { agent: group.agent, refreshed: due.has(group.agent), nextAllowedAt: next === null ? null : new Date(next).toISOString() }
        }),
      }
    },
  }
}

export type AccountsService = ReturnType<typeof createAccountsService>

let defaultService: AccountsService | null = null
/** The process-wide service (index.ts registers it; cpa.ts reads `anyLoginOn` from it). */
export function accountsService(deps?: AccountsServiceDeps): AccountsService {
  if (!defaultService) defaultService = createAccountsService(deps ?? { signinLeaseFile: autoupdatePaths().lease })
  return defaultService
}

const SIGNIN_PARAM = /^[A-Za-z0-9_-]{1,32}$/

export function registerAccountsRoutes(app: express.Express, service: AccountsService): void {
  const handle = (run: (req: express.Request) => Promise<unknown>, status = 200) => async (req: express.Request, res: express.Response) => {
    res.setHeader('Cache-Control', 'no-store')
    try {
      res.status(status).json(await run(req))
    } catch (error) {
      const { status: code, body } = errorResponse(error)
      res.status(code).json(body)
    }
  }
  const body = (req: express.Request): Record<string, unknown> =>
    (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body as Record<string, unknown> : {})
  const signinId = (req: express.Request) => {
    const id = String(req.params.id ?? '')
    if (!SIGNIN_PARAM.test(id)) throw new AccountsError(404, 'signin_not_found')
    return id
  }
  const magpieOnly = async () => { await service.backend().then((current) => {
    if (current.kind === 'cpa') throw new AccountsError(409, 'cpa_backend')
  }) }

  app.get('/api/accounts', handle(() => service.list()))
  app.get('/api/accounts/catalog', handle(() => service.catalog()))
  app.post('/api/accounts/signin', handle(req => service.startSignIn(body(req))))
  app.get('/api/accounts/signin/:id', handle(async (req) => { await magpieOnly(); return service.signins.status(signinId(req)) }))
  app.post('/api/accounts/signin/:id/callback', handle(async (req) => {
    await magpieOnly()
    return service.signins.callback(signinId(req), body(req).url)
  }, 202))
  app.post('/api/accounts/signin/:id/cancel', handle(async (req) => { await magpieOnly(); return service.signins.cancel(signinId(req)) }))
  app.post('/api/accounts/login/:action', handle(req => service.login(String(req.params.action), body(req))))
  app.post('/api/accounts/codex-reset', handle(req => service.codexReset(body(req))))
  app.post('/api/accounts/quota/refresh', handle(req => service.refreshQuota(body(req))))
}
