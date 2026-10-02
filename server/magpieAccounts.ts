import { maskIdentity } from './accountProjection.js'
import { AccountQuotaCache, AccountQuotaUpstreamError, severityFor, type QuotaWindow } from './accountQuota.js'
import { AccountsError, kernelFailure } from './accountsError.js'
import type { KernelCall } from './magpieKernel.js'
import { RequestCoordinator } from './requestCoordinator.js'
import type { SyncOutcome } from './syncRegistry.js'

/**
 * Magpie's subscription accounts as the kernel lists them (GET /internal/accounts), the per-account actions,
 * Codex resets and allowances. The kernel's store under its own HOME is the only source; nothing here reads
 * a credential. Allowances are request-driven and bounded: one usage read per agent per TTL (5 min floor),
 * failure cooldowns from AccountQuotaCache, every read inside the global upstream limiter and counted under
 * the sync center's `account-quota` job. A page load never waits for a vendor.
 */

export type KernelAccount = {
  id: string
  agent: string
  user: string
  plan: string
  active: boolean
  on: boolean
  own: boolean
  needsRelogin: boolean
  seen: string | null
}
export type KernelAgent = { agent: string; signinDenied: boolean; accounts: KernelAccount[] }
export type KernelExclusion = { agent: string; removed: boolean; signedOut: boolean; quiet: boolean }
export type KernelListing = { agents: KernelAgent[]; excluded: KernelExclusion[] }

const ACCOUNT_ID = /^[a-f0-9]{16}$/
const AGENT_ID = /^[a-z0-9][a-z0-9-]{0,39}$/

function parseAccount(raw: unknown, agent: string): KernelAccount | null {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null
  if (!value || typeof value.id !== 'string' || !ACCOUNT_ID.test(value.id) || value.agent !== agent) return null
  if (typeof value.user !== 'string' || !value.user || value.user.length > 320) return null
  return {
    id: value.id, agent, user: value.user,
    plan: typeof value.plan === 'string' ? value.plan.slice(0, 120) : '',
    active: value.active === true, on: value.on === true || value.active === true, own: value.own === true,
    needsRelogin: value.needsRelogin === true || (typeof value.lapsed === 'string' && value.lapsed !== ''),
    seen: typeof value.seen === 'string' && Number.isFinite(Date.parse(value.seen)) ? new Date(value.seen).toISOString() : null,
  }
}

export function parseKernelAgent(raw: unknown): KernelAgent | null {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null
  if (!value || typeof value.agent !== 'string' || !AGENT_ID.test(value.agent) || !Array.isArray(value.accounts)) return null
  const agent = value.agent
  const accounts = value.accounts.slice(0, 500).map(entry => parseAccount(entry, agent))
  if (accounts.some(account => !account)) return null
  return { agent, signinDenied: value.signinDenied === true, accounts: accounts as KernelAccount[] }
}

/** The kernel's listing, rebuilt from known fields only (Magpie's `why` text, with its file paths, stays behind). */
export function parseKernelListing(body: unknown): KernelListing | null {
  const value = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null
  if (!value || !Array.isArray(value.agents)) return null
  const agents = value.agents.slice(0, 100).map(parseKernelAgent)
  if (agents.some(agent => !agent)) return null
  const excluded = (Array.isArray(value.excluded) ? value.excluded.slice(0, 200) : []).flatMap((raw): KernelExclusion[] => {
    const entry = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
    if (typeof entry.agent !== 'string' || !AGENT_ID.test(entry.agent)) return []
    return [{ agent: entry.agent, removed: typeof entry.provider === 'string' && entry.provider !== '', signedOut: entry.signedOut === true, quiet: entry.quiet === true }]
  })
  return { agents: agents as KernelAgent[], excluded }
}

/* ────────────────────────── allowances ────────────────────────── */

type SubscriptionQuota = Record<string, unknown>
type UsageMap = Record<string, SubscriptionQuota>

export type AccountQuotaView = {
  /** when these numbers were read */
  asOf: string | null
  /** the last read failed or is cooling down; the numbers are the previous ones */
  stale: boolean
  error: string | null
  errorCode: 'signed_out' | 'unavailable' | null
  windows: QuotaWindow[]
  balance: string | null
  until: string | null
  renew: 'auto' | 'off' | null
  resets: { count: number; until: string | null } | null
  /** a Codex reset was used since the last read: the windows refresh on the next read */
  resetPending: boolean
}

export type QuotaLimiter = { run<T>(task: () => Promise<T>): Promise<T> }
export type QuotaRegistry = {
  observe<T>(id: string, task: () => Promise<T>, summarize: (value: T) => SyncOutcome): Promise<T>
  countRequests(id: string, n?: number): void
}

/** Devin reports no allowance at the pin; reading it would only cost a kernel round. */
const NO_USAGE = new Set(['devin'])
export const QUOTA_POLICY = {
  minTtlMs: 5 * 60_000,
  allOffIntervalMs: 60 * 60_000,
  failureCooldownMs: 2 * 60_000,
  rateLimitCooldownMs: 10 * 60_000,
  maxCooldownMs: 30 * 60_000,
  readTimeoutMs: 13_000,
}

const isoOf = (value: unknown): string | null => (typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null)

function windowView(raw: unknown, index: number): QuotaWindow | null {
  const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : null
  if (!value || typeof value.name !== 'string') return null
  const used = typeof value.used === 'number' && Number.isFinite(value.used) ? Math.max(0, Math.min(100, value.used)) : 0
  return {
    id: `${index}:${value.name.slice(0, 80)}`, label: value.name.slice(0, 80), usedPercent: Math.round(used * 10) / 10,
    resetsAt: isoOf(value.resetsAt), windowSeconds: null, severity: severityFor(used), scope: null,
  }
}

export function quotaView(raw: SubscriptionQuota | undefined, meta: { asOf: number | null; stale: boolean; resetPending: boolean }): AccountQuotaView | null {
  if (!raw && meta.asOf === null) return null
  const error = raw && typeof raw.error === 'string' ? raw.error : ''
  const resets = raw?.resets && typeof raw.resets === 'object' ? raw.resets as Record<string, unknown> : null
  return {
    asOf: isoOf(raw?.asOf) ?? (meta.asOf === null ? null : new Date(meta.asOf).toISOString()),
    stale: meta.stale || Boolean(raw?.asOf),
    error: !raw ? (meta.stale ? '暂时无法获取用量' : null) : error ? (/sign-in has expired|signed out|not signed in/i.test(error) ? '登录已失效，请重新添加' : '暂时无法获取用量') : null,
    errorCode: !raw ? (meta.stale ? 'unavailable' : null) : error ? (/sign-in has expired|signed out|not signed in/i.test(error) ? 'signed_out' : 'unavailable') : null,
    windows: raw && Array.isArray(raw.windows) ? raw.windows.slice(0, 16).map(windowView).filter((entry): entry is QuotaWindow => entry !== null) : [],
    balance: raw && typeof raw.balance === 'string' && raw.balance ? raw.balance.slice(0, 80) : null,
    until: isoOf(raw?.until),
    renew: raw?.renew === 'auto' || raw?.renew === 'off' ? raw.renew : null,
    resets: resets && typeof resets.count === 'number' ? { count: Math.max(0, Math.floor(resets.count)), until: isoOf(resets.until) } : null,
    resetPending: meta.resetPending,
  }
}

function usageOf(body: unknown, agent: string): UsageMap | null {
  const value = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null
  if (!value || (value.agent !== undefined && value.agent !== agent)) return null
  const usage = value.usage
  if (usage === undefined) return {}
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return null
  const out: UsageMap = {}
  for (const [user, quota] of Object.entries(usage as Record<string, unknown>).slice(0, 500)) {
    if (quota && typeof quota === 'object' && !Array.isArray(quota)) out[user] = quota as SubscriptionQuota
  }
  return out
}

const RATE_LIMITED = /\b429\b|rate.?limit|too many requests/i

type AgentQuota = { value: UsageMap | null; asOf: number | null; error: string | null; blockedUntil: number | null }

export class QuotaBook {
  private readonly cache: AccountQuotaCache<UsageMap>
  private readonly state = new Map<string, AgentQuota>()
  private readonly lastRead = new Map<string, number>()
  private readonly inflight = new Map<string, Promise<void>>()
  private readonly resetPending = new Set<string>()
  private readonly ttlMs: number

  constructor(private readonly deps: { call: KernelCall; now: () => number; limiter: QuotaLimiter; registry: QuotaRegistry; ttlMs?: number }) {
    this.ttlMs = Math.max(QUOTA_POLICY.minTtlMs, deps.ttlMs ?? QUOTA_POLICY.minTtlMs)
    this.cache = new AccountQuotaCache<UsageMap>({
      ttlMs: this.ttlMs, jitterPct: 0, now: deps.now,
      rateLimitCooldownMs: QUOTA_POLICY.rateLimitCooldownMs, maxCooldownMs: QUOTA_POLICY.maxCooldownMs,
      failureCooldownMs: QUOTA_POLICY.failureCooldownMs,
    })
  }

  /**
   * Agents whose allowance is due: at most one vendor read per agent per TTL (an hour when every account is off),
   * and none while a failed read is cooling down (no read and no sync-center run until it ends).
   */
  due(agents: KernelAgent[]): KernelAgent[] {
    const now = this.deps.now()
    return agents.filter((agent) => {
      if (NO_USAGE.has(agent.agent) || !agent.accounts.length || this.inflight.has(agent.agent)) return false
      const blockedUntil = this.state.get(agent.agent)?.blockedUntil
      if (blockedUntil && blockedUntil > now) return false
      const interval = agent.accounts.some(account => account.on) ? this.ttlMs : Math.max(this.ttlMs, QUOTA_POLICY.allOffIntervalMs)
      const last = this.lastRead.get(agent.agent)
      return last === undefined || now - last >= interval
    })
  }

  nextAllowedAt(agent: string): number | null {
    const last = this.lastRead.get(agent)
    if (last === undefined) return null
    return Math.max(last + this.ttlMs, this.state.get(agent)?.blockedUntil ?? 0)
  }

  /**
   * Reads the given agents' allowances; returns when they are done. One sync-center record for the batch,
   * unless the sync center itself is running it (`record:false`, its run is the record).
   */
  refresh(agents: KernelAgent[], options: { record?: boolean } = {}): Promise<void> {
    const due = this.due(agents)
    if (!due.length) return Promise.resolve()
    const work = async () => {
      await Promise.all(due.map(agent => this.read(agent)))
      return due.map(agent => this.state.get(agent.agent))
    }
    const batch = options.record === false ? work() : this.deps.registry.observe('account-quota', work, summarizeMagpieQuota)
    const done = batch.then(() => undefined, () => undefined)
    for (const agent of due) this.inflight.set(agent.agent, done)
    void done.finally(() => { for (const agent of due) if (this.inflight.get(agent.agent) === done) this.inflight.delete(agent.agent) })
    return done
  }

  view(agent: string, user: string): AccountQuotaView | null {
    const entry = this.state.get(agent)
    if (!entry) return null
    const usage = entry.value
    const raw = usage ? usage[user] ?? Object.entries(usage).find(([name]) => name.toLowerCase() === user.toLowerCase())?.[1] : undefined
    return quotaView(raw, { asOf: entry.asOf, stale: Boolean(entry.error), resetPending: this.resetPending.has(`${agent}\0${user.toLowerCase()}`) })
  }

  markReset(agent: string, user: string): void {
    this.resetPending.add(`${agent}\0${user.toLowerCase()}`)
  }

  asOf(): number | null {
    const times = [...this.state.values()].map(entry => entry.asOf).filter((at): at is number => at !== null)
    return times.length ? Math.max(...times) : null
  }

  private async read(agent: KernelAgent): Promise<void> {
    const result = await this.cache.read(agent.agent, async () => {
      this.lastRead.set(agent.agent, this.deps.now())
      return this.deps.limiter.run(async () => {
        // Magpie asks the vendor once per account
        this.deps.registry.countRequests('account-quota', Math.max(1, agent.accounts.length))
        const reply = await this.deps.call(`/internal/accounts/usage?agent=${encodeURIComponent(agent.agent)}`, { timeoutMs: QUOTA_POLICY.readTimeoutMs })
        if (reply.status !== 200) {
          const failure = kernelFailure(reply, 'usage')
          throw new AccountQuotaUpstreamError(failure.status === 504 ? 504 : 502, failure.message)
        }
        const usage = usageOf(reply.body, agent.agent)
        if (!usage) throw new AccountQuotaUpstreamError(502, '内核响应异常')
        const errors = Object.values(usage).map(quota => (typeof quota.error === 'string' ? quota.error : ''))
        if (errors.length && errors.every(error => RATE_LIMITED.test(error))) throw new AccountQuotaUpstreamError(429, '厂商限流')
        return usage
      })
    }).catch((error: unknown) => ({ value: null, error: error instanceof Error ? error.message : '读取失败', blockedUntil: null }))
    const previous = this.state.get(agent.agent)
    if (result.error) {
      this.state.set(agent.agent, { value: result.value ?? previous?.value ?? null, asOf: previous?.asOf ?? null, error: result.error, blockedUntil: result.blockedUntil })
      return
    }
    const fresh = previous?.value !== result.value
    this.state.set(agent.agent, { value: result.value, asOf: fresh || !previous ? this.deps.now() : previous.asOf, error: null, blockedUntil: null })
    if (fresh) for (const key of [...this.resetPending]) if (key.startsWith(`${agent.agent}\0`)) this.resetPending.delete(key)
  }
}

/** Sync-center record of one allowance batch: all failed → error, some → partial. */
export function summarizeMagpieQuota(entries: Array<AgentQuota | undefined>): SyncOutcome {
  const read = entries.filter((entry): entry is AgentQuota => Boolean(entry))
  const failing = read.filter(entry => entry.error).length
  const result = !read.length ? 'skipped' : failing === 0 ? 'ok' : failing === read.length ? 'error' : 'partial'
  return { result, summary: `${read.length} 个服务${failing ? ` · ${failing} 异常` : ''}`, error: failing ? `${failing} 个服务额度读取异常` : null, skipBackoff: true }
}

/* ────────────────────────── accounts ────────────────────────── */

export type AccountView = {
  id: string
  agent: string
  user: string
  userMasked: string
  plan: string | null
  /** the agent is signed in to it: the gateway would use it first */
  active: boolean
  /** ticked for use (the active one, or next in line) */
  on: boolean
  /** active while other accounts are on too: Magpie's 首选 */
  first: boolean
  own: boolean
  needsRelogin: boolean
  seen: string | null
  status: 'in_use' | 'first' | 'on' | 'off' | 'relogin'
  quota: AccountQuotaView | null
  canReset: boolean
}

export function accountView(account: KernelAccount, siblings: KernelAccount[], quota: AccountQuotaView | null): AccountView {
  const onCount = siblings.filter(entry => entry.on).length
  const first = account.active && onCount > 1
  const status = account.needsRelogin ? 'relogin' : account.active ? (first ? 'first' : 'in_use') : account.on ? 'on' : 'off'
  return {
    id: account.id, agent: account.agent, user: account.user, userMasked: maskIdentity(account.user),
    plan: account.plan || null, active: account.active, on: account.on, first, own: account.own,
    needsRelogin: account.needsRelogin, seen: account.seen, status, quota,
    canReset: account.agent === 'codex' && !account.needsRelogin && Boolean(quota?.resets && quota.resets.count > 0),
  }
}

export type LoginAction = 'on' | 'off' | 'first' | 'forget'
const KERNEL_ACTION: Record<LoginAction, string> = { on: 'on', off: 'off', first: 'switch', forget: 'forget' }
export const LOGIN_ACTIONS = Object.keys(KERNEL_ACTION) as LoginAction[]

export type CodexResetView = {
  ok: boolean
  outcome: 'reset' | 'nothing_to_reset' | 'no_credit' | 'already_redeemed'
  windows: number
  message: string
  /** these accounts don't serve the gateway yet, so there is no gateway cooldown to clear */
  cooldownCleared: null
}

const RESET_TEXT: Record<CodexResetView['outcome'], (windows: number) => string> = {
  reset: windows => `已重新开始 ${windows} 个窗口`,
  nothing_to_reset: () => '没有已用的窗口，重置次数保留',
  no_credit: () => '这个账号没有可用的重置',
  already_redeemed: () => '这次重置已被使用',
}

export class MagpieAccounts {
  private readonly listing: RequestCoordinator<KernelListing>
  private readonly resets = new Set<string>()
  readonly quota: QuotaBook

  constructor(private readonly deps: {
    call: KernelCall
    now: () => number
    limiter: QuotaLimiter
    registry: QuotaRegistry
    audit: (action: string, target: string, details: string) => void
    quotaTtlMs?: number
  }) {
    this.listing = new RequestCoordinator<KernelListing>({ ttlMs: 5_000, now: deps.now })
    this.quota = new QuotaBook({ call: deps.call, now: deps.now, limiter: deps.limiter, registry: deps.registry, ttlMs: deps.quotaTtlMs })
  }

  /** The kernel's accounts (5 s shared read; `fresh` for writes, which must see the current state). */
  async list(fresh = false): Promise<KernelListing> {
    if (fresh) this.listing.clear('accounts')
    return this.listing.run('accounts', async () => {
      const reply = await this.deps.call('/internal/accounts', { timeoutMs: 11_000 })
      if (reply.status !== 200) throw kernelFailure(reply, 'account')
      const listing = parseKernelListing(reply.body)
      if (!listing) throw new AccountsError(502, 'kernel_bad_response')
      return listing
    })
  }

  invalidate(): void {
    this.listing.clear()
  }

  async anyOn(): Promise<boolean> {
    try {
      return (await this.list()).agents.some(agent => agent.accounts.some(account => account.on && !account.needsRelogin))
    } catch {
      return false
    }
  }

  private async find(agent: unknown, id: unknown): Promise<{ account: KernelAccount; group: KernelAgent }> {
    if (typeof agent !== 'string' || !AGENT_ID.test(agent) || typeof id !== 'string' || !ACCOUNT_ID.test(id)) throw new AccountsError(400, 'invalid_request')
    const group = (await this.list(true)).agents.find(entry => entry.agent === agent)
    const account = group?.accounts.find(entry => entry.id === id)
    if (!group || !account) throw new AccountsError(404, 'account_not_found')
    return { account, group }
  }

  async action(action: LoginAction, agent: unknown, id: unknown): Promise<KernelAgent> {
    const { account, group } = await this.find(agent, id)
    // Magpie: the account the agent is signed in to can't be turned off (forgetting it is the kernel's call)
    if (action === 'off' && account.active) throw new AccountsError(409, 'account_active', '首选账号不能停用')
    // nothing to do: answer with the current state instead of a kernel write
    if ((action === 'first' && account.active) || (action === 'on' && account.on) || (action === 'off' && !account.on)) return group
    const reply = await this.deps.call(`/internal/accounts/${KERNEL_ACTION[action]}`, { method: 'POST', body: { agent: account.agent, user: account.user }, timeoutMs: 12_000 })
    this.invalidate()
    if (reply.status !== 200) {
      const failure = kernelFailure(reply, 'account')
      this.deps.audit(`account-${action}`, `${account.agent}:${maskIdentity(account.user)}`, `refused=${failure.code}`)
      throw failure
    }
    const updated = parseKernelAgent(reply.body)
    if (!updated || updated.agent !== account.agent) throw new AccountsError(502, 'kernel_bad_response')
    this.deps.audit(`account-${action}`, `${account.agent}:${maskIdentity(account.user)}`, '')
    return updated
  }

  async codexReset(id: unknown): Promise<CodexResetView> {
    const { account } = await this.find('codex', id)
    if (this.resets.has(account.id)) throw new AccountsError(409, 'reset_in_progress')
    this.resets.add(account.id)
    try {
      const reply = await this.deps.limiter.run(async () => {
        this.deps.registry.countRequests('account-quota', 1)
        return this.deps.call('/internal/accounts/codex-reset', { method: 'POST', body: { user: account.user }, timeoutMs: 22_000 })
      })
      if (reply.status !== 200) {
        const failure = kernelFailure(reply, 'account')
        this.deps.audit('account-codex-reset', `codex:${maskIdentity(account.user)}`, `refused=${failure.code}`)
        throw failure
      }
      const body = reply.body && typeof reply.body === 'object' ? reply.body as Record<string, unknown> : {}
      const outcome = (['reset', 'nothing_to_reset', 'no_credit', 'already_redeemed'] as const).find(code => code === body.code)
      if (!outcome) throw new AccountsError(502, 'kernel_bad_response')
      const windows = typeof body.windows === 'number' && Number.isFinite(body.windows) ? Math.max(0, Math.floor(body.windows)) : 0
      if (outcome === 'reset') this.quota.markReset('codex', account.user)
      this.deps.audit('account-codex-reset', `codex:${maskIdentity(account.user)}`, `outcome=${outcome}`)
      return { ok: outcome === 'reset', outcome, windows, message: RESET_TEXT[outcome](windows), cooldownCleared: null }
    } finally {
      this.resets.delete(account.id)
    }
  }
}
