import { request } from 'node:http'
import { maskIdentity } from './accountProjection.js'
import { availableItems, signinGated, type Completion, type MagpieCatalog } from './accountCatalog.js'
import { ACCOUNTS_MESSAGES, AccountsError, kernelFailure, sanitizeDetail } from './accountsError.js'
import { KernelError, type KernelCall, type KernelHealth } from './magpieKernel.js'

/**
 * Sign-in orchestration over the kernel's /internal/signin* routes (ACCOUNTS-ALIGN §2.4).
 *
 * State lives in this process: only sign-ins started here can be polled, called back or canceled (anything
 * else is 404, so the console is no oracle for other kernel flows). One live sign-in per agent — a new one
 * replaces it, as Magpie does — and three overall, since a loopback flow holds a host port for up to 10 min.
 * Host-loopback flows finish from a remote browser through the relay: the pasted final localhost address is
 * checked against this sign-in (loopback, its port, its callback path, never /cancel) and replayed once to the
 * kernel's listener on 127.0.0.1. The pasted URL, code and state are never logged, audited or echoed.
 */

export type SignInPhase = 'installing' | 'waiting' | 'done' | 'failed' | 'canceled'
const PHASES: readonly SignInPhase[] = ['installing', 'waiting', 'done', 'failed', 'canceled']
const TERMINAL = new Set<SignInPhase>(['done', 'failed', 'canceled'])

export type SignInView = {
  id: string
  agent: string
  state: SignInPhase
  completion: Completion
  /** the vendor page to open in the user's own browser (https only) */
  url: string | null
  /** device code to type on that page */
  code: string | null
  /** the CLI being installed before the sign-in can start */
  installing: string | null
  /** the final localhost address can be pasted back (relay, or Magpie's own paste for dimagent) */
  pasteCallback: boolean
  /** a pasted address was accepted; the input stays locked */
  callbackLocked: boolean
  user: string | null
  userMasked: string | null
  plan: string | null
  /** the agent itself is now signed in to this account (it became the first one) */
  using: boolean
  error: string | null
  errorCode: string | null
  detail: string | null
  /** Kiro's AWS hop: open this page next, then paste the address it returns to */
  next: string | null
  startedAt: string
  deadline: string
}

type KernelState = {
  id: string; agent: string; url: string; code: string; state: SignInPhase
  pasteCallback: boolean; installing: string; user: string; plan: string; using: boolean; error: string
}

type Entry = {
  id: string
  agent: string
  site: string
  completion: Completion
  relayPaths: string[]
  startedAt: number
  deadline: number
  installingSeen: boolean
  port: number | null
  redirectPath: string | null
  urlState: string | null
  last: KernelState
  phase: SignInPhase
  terminalAt: number | null
  errorCode: string | null
  error: string | null
  detail: string | null
  callbackLocked: boolean
  submitting: boolean
  next: string | null
  polledAt: number
  poll: Promise<void> | null
}

export type RelayTarget = { port: number; path: string; host: string }
export type RelayResult = { status: number; location: string | null }
export type RelayFn = (target: RelayTarget) => Promise<RelayResult>
export type SigninAudit = (action: string, target: string, details: string) => void

const SIGNIN_ID = /^[A-Za-z0-9_-]{1,32}$/
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])
const MINUTE = 60_000
export const SIGNIN_LIMITS = {
  /** Magpie waits 10 min (+10 while installing a CLI; Qoder 15) */
  waitMs: 10 * MINUTE,
  installExtraMs: 10 * MINUTE,
  qoderWaitMs: 15 * MINUTE,
  /** past the deadline the console cancels the kernel flow, which frees its port */
  graceMs: 30_000,
  /** terminal entries are kept this long for late polls */
  keepMs: 15 * MINUTE,
  pollCoalesceMs: 300,
  maxLive: 3,
  maxCallbackBytes: 16 * 1024,
  /** the listener exchanges the code inside the request (up to 30 s in Magpie); a shorter wait would cancel it */
  relayTimeoutMs: 40_000,
}

/** GET http://127.0.0.1:<port><path> once: no redirects followed, body discarded, never through a proxy. */
export const loopbackRelay: RelayFn = ({ port, path, host }) => new Promise<RelayResult>((resolve, reject) => {
  const req = request({ host: '127.0.0.1', port, path, method: 'GET', agent: false, headers: { host, 'user-agent': 'crosery-console-relay' } }, (res) => {
    res.resume()
    res.once('end', () => resolve({ status: res.statusCode || 0, location: typeof res.headers.location === 'string' ? res.headers.location : null }))
    res.once('error', () => reject(new AccountsError(502, 'relay_failed')))
  })
  const timer = setTimeout(() => {
    req.destroy()
    reject(new AccountsError(504, 'relay_timeout'))
  }, SIGNIN_LIMITS.relayTimeoutMs)
  timer.unref()
  req.once('close', () => clearTimeout(timer))
  req.once('error', (error: NodeJS.ErrnoException) => {
    reject(error.code === 'ECONNREFUSED' ? new AccountsError(409, 'signin_not_waiting') : new AccountsError(502, 'relay_failed'))
  })
  req.end()
})

function str(value: unknown, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : ''
}

/** The kernel's SignInState, checked field by field; null when it is not one. */
export function parseKernelState(body: unknown, agent: string): KernelState | null {
  const value = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null
  if (!value || typeof value.id !== 'string' || !SIGNIN_ID.test(value.id) || value.agent !== agent) return null
  const state = PHASES.find(phase => phase === value.state)
  if (!state) return null
  return {
    id: value.id, agent, state,
    url: str(value.url, 8192), code: str(value.code, 64), pasteCallback: value.pasteCallback === true,
    installing: str(value.installing, 80), user: str(value.user, 320), plan: str(value.plan, 120),
    using: value.using === true, error: str(value.error, 2000),
  }
}

/** Only an https vendor page is handed to the browser (window.open). */
function safePage(raw: string): string | null {
  try {
    const url = new URL(raw)
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null
  } catch {
    return null
  }
}

/** The loopback listener a relay flow returns to, from the vendor URL's redirect_uri. */
function listenerOf(raw: string): { port: number; path: string; state: string | null } | null {
  try {
    const page = new URL(raw)
    const redirect = new URL(page.searchParams.get('redirect_uri') || '')
    const port = Number(redirect.port)
    if (redirect.protocol !== 'http:' || !LOOPBACK.has(redirect.hostname) || !Number.isInteger(port) || port < 1024 || port > 65535) return null
    return { port, path: redirect.pathname, state: page.searchParams.get('state') }
  } catch {
    return null
  }
}

const iso = (ms: number) => new Date(ms).toISOString()

export class SignInManager {
  private readonly entries = new Map<string, Entry>()
  private readonly starting = new Set<string>()
  private timer: NodeJS.Timeout | null = null
  private readonly now: () => number
  private readonly relay: RelayFn
  private readonly audit: SigninAudit

  constructor(private readonly deps: {
    call: KernelCall
    now?: () => number
    relay?: RelayFn
    audit?: SigninAudit
    /** a sign-in finished: the agent's accounts changed */
    onDone?: (agent: string) => void
    /** the live sign-ins changed (their deadlines): the auto-update job never restarts the kernel during one */
    onLive?: (live: Array<{ deadline: number }>) => void
  }) {
    this.now = deps.now ?? Date.now
    this.relay = deps.relay ?? loopbackRelay
    this.audit = deps.audit ?? (() => {})
  }

  /** live sign-ins, for the account list ("signing in…" on a tile) */
  live(): Array<{ id: string; agent: string; state: SignInPhase }> {
    return [...this.entries.values()].filter(entry => !TERMINAL.has(entry.phase)).map(entry => ({ id: entry.id, agent: entry.agent, state: entry.phase }))
  }

  async start(input: { agent: unknown; site?: unknown; confirmRisk?: unknown }, context: { health: KernelHealth; catalog: MagpieCatalog; hostExec: boolean }): Promise<SignInView> {
    await this.sweep()
    const agent = typeof input.agent === 'string' ? input.agent : ''
    const item = availableItems(context.catalog, context.health).find(entry => entry.agent === agent)
    if (!item) throw new AccountsError(422, 'agent_unsupported')
    if (signinGated(item, context.health, context.hostExec)) throw new AccountsError(403, 'signin_gated')
    if (item.risk && input.confirmRisk !== true) throw new AccountsError(409, 'risk_unconfirmed')
    const site = typeof input.site === 'string' ? input.site : ''
    if (item.sites.length ? !item.sites.some(entry => entry.id === site) : site !== '') {
      throw new AccountsError(400, item.sites.length ? 'site_required' : 'invalid_request')
    }
    if (this.starting.has(agent)) throw new AccountsError(409, 'signin_starting')
    const previous = [...this.entries.values()].find(entry => entry.agent === agent && !TERMINAL.has(entry.phase))
    const others = [...this.entries.values()].filter(entry => entry !== previous && !TERMINAL.has(entry.phase)).length + this.starting.size
    if (others >= SIGNIN_LIMITS.maxLive) throw new AccountsError(429, 'signin_limit')
    this.starting.add(agent)
    try {
      // Magpie cancels an agent's older sign-in itself; doing it here first keeps this table in step
      if (previous) await this.cancelEntry(previous, 'replaced')
      const reply = await this.deps.call('/internal/signin', { method: 'POST', body: site ? { agent, site } : { agent }, timeoutMs: 15_000 })
      if (reply.status !== 200) throw kernelFailure(reply, 'signin')
      const state = parseKernelState(reply.body, agent)
      if (!state) throw new AccountsError(502, 'kernel_bad_response')
      const now = this.now()
      const entry: Entry = {
        id: state.id, agent, site, completion: item.completion, relayPaths: item.relayPaths,
        startedAt: now, deadline: now + (agent === 'qoder' ? SIGNIN_LIMITS.qoderWaitMs : SIGNIN_LIMITS.waitMs),
        // `apply` below moves it on (a kernel that answers a finished flow right away ends it there)
        installingSeen: false, port: null, redirectPath: null, urlState: null, last: state, phase: state.state === 'installing' ? 'installing' : 'waiting',
        terminalAt: null, errorCode: null, error: null, detail: null, callbackLocked: false, submitting: false,
        next: null, polledAt: now, poll: null,
      }
      this.entries.set(entry.id, entry)
      this.audit('account-signin-start', agent, [site ? `site=${site}` : '', item.risk ? 'risk=confirmed' : ''].filter(Boolean).join(' '))
      this.apply(entry, state)
      this.arm()
      this.notifyLive()
      return this.view(entry)
    } finally {
      this.starting.delete(agent)
    }
  }

  async status(id: string): Promise<SignInView> {
    const entry = this.entry(id)
    await this.refresh(entry, false)
    return this.view(entry)
  }

  async cancel(id: string): Promise<SignInView> {
    const entry = this.entry(id)
    if (!TERMINAL.has(entry.phase)) await this.cancelEntry(entry, 'user')
    this.notifyLive()
    return this.view(entry)
  }

  /** The pasted final address of the browser: relayed to the host listener, or Magpie's own paste (dimagent). */
  async callback(id: string, raw: unknown): Promise<SignInView> {
    const entry = this.entry(id)
    if (typeof raw !== 'string' || !raw.trim()) throw new AccountsError(400, 'invalid_request')
    if (Buffer.byteLength(raw) > SIGNIN_LIMITS.maxCallbackBytes) throw new AccountsError(413, 'callback_too_large')
    if (entry.completion !== 'relay' && entry.completion !== 'paste') throw new AccountsError(409, 'callback_not_supported')
    if (entry.callbackLocked || entry.submitting) throw new AccountsError(409, 'callback_locked')
    entry.submitting = true
    try {
      await this.refresh(entry, true)
      if (entry.phase !== 'waiting') throw new AccountsError(409, 'signin_not_waiting')
      return entry.completion === 'paste' ? await this.pasteNative(entry, raw.trim()) : await this.relayCallback(entry, raw.trim())
    } finally {
      entry.submitting = false
    }
  }

  /** Expire flows past their deadline (canceling them frees the host port), drop old finished ones. */
  async sweep(): Promise<void> {
    const now = this.now()
    for (const entry of [...this.entries.values()]) {
      if (TERMINAL.has(entry.phase)) {
        if (entry.terminalAt !== null && now - entry.terminalAt > SIGNIN_LIMITS.keepMs) this.entries.delete(entry.id)
      } else if (now > entry.deadline + SIGNIN_LIMITS.graceMs) {
        await this.expire(entry)
      }
    }
    if (!this.live().length && this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.notifyLive()
  }

  private notifyLive(): void {
    try {
      this.deps.onLive?.([...this.entries.values()].filter(entry => !TERMINAL.has(entry.phase)).map(entry => ({ deadline: entry.deadline + SIGNIN_LIMITS.graceMs })))
    } catch { /* the lease is advisory; a sign-in never fails on it */ }
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /* ── internals ── */

  private entry(id: string): Entry {
    const entry = SIGNIN_ID.test(id) ? this.entries.get(id) : undefined
    if (!entry) throw new AccountsError(404, 'signin_not_found')
    return entry
  }

  private arm(): void {
    if (this.timer || !this.live().length) return
    this.timer = setInterval(() => { void this.sweep().catch(() => undefined) }, 30_000)
    this.timer.unref()
  }

  private async refresh(entry: Entry, force: boolean): Promise<void> {
    if (TERMINAL.has(entry.phase)) return
    if (entry.poll) return entry.poll
    if (!force && this.now() - entry.polledAt < SIGNIN_LIMITS.pollCoalesceMs) return
    const poll = (async () => {
      if (this.now() > entry.deadline + SIGNIN_LIMITS.graceMs) return this.expire(entry)
      const reply = await this.deps.call(`/internal/signin/${entry.id}`, { timeoutMs: 3_000 })
      entry.polledAt = this.now()
      if (reply.status === 404) return this.finish(entry, 'failed', 'signin_not_found')
      if (reply.status !== 200) throw kernelFailure(reply, 'signin')
      const state = parseKernelState(reply.body, entry.agent)
      if (!state || state.id !== entry.id) throw new AccountsError(502, 'kernel_bad_response')
      this.apply(entry, state)
    })()
    entry.poll = poll
    try { await poll } finally { entry.poll = null }
  }

  private apply(entry: Entry, state: KernelState): void {
    // finished is final: a status read that left before a cancel/replace must not bring the flow back to life
    if (TERMINAL.has(entry.phase)) return
    entry.last = state
    if (state.state === 'installing' && !entry.installingSeen) {
      entry.installingSeen = true
      entry.deadline += SIGNIN_LIMITS.installExtraMs
    }
    if (entry.completion === 'relay' && entry.port === null && state.url) {
      const listener = listenerOf(state.url)
      if (listener) {
        entry.port = listener.port
        entry.redirectPath = listener.path
        entry.urlState = listener.state
      }
    }
    if (state.state === 'done') this.finish(entry, 'done')
    else if (state.state === 'failed') {
      this.finish(entry, 'failed', /timed out/i.test(state.error) ? 'signin_timeout' : 'signin_failed', state.error)
    } else if (state.state === 'canceled') this.finish(entry, 'canceled')
    else entry.phase = state.state
  }

  private finish(entry: Entry, phase: 'done' | 'failed' | 'canceled', code: string | null = null, kernelText = ''): void {
    if (TERMINAL.has(entry.phase)) return
    entry.phase = phase
    entry.terminalAt = this.now()
    entry.errorCode = code
    entry.error = code ? ACCOUNTS_MESSAGES[code] ?? ACCOUNTS_MESSAGES.signin_failed : null
    entry.detail = sanitizeDetail(kernelText)
    if (phase === 'done') {
      this.audit('account-signin-done', `${entry.agent}:${maskIdentity(entry.last.user)}`, entry.last.using ? 'using' : 'added')
      try { this.deps.onDone?.(entry.agent) } catch { /* a cache hook must not fail the sign-in */ }
    } else if (phase === 'failed') {
      this.audit('account-signin-failed', entry.agent, code ?? '')
    }
  }

  private async expire(entry: Entry): Promise<void> {
    await this.kernelCancel(entry)
    this.finish(entry, 'failed', 'signin_timeout')
  }

  private async cancelEntry(entry: Entry, why: 'user' | 'replaced'): Promise<void> {
    await this.kernelCancel(entry)
    if (TERMINAL.has(entry.phase)) return
    this.finish(entry, 'canceled')
    this.audit('account-signin-cancel', entry.agent, why)
  }

  /** Best effort: a kernel that is down has no flow left to cancel. */
  private async kernelCancel(entry: Entry): Promise<void> {
    try {
      await this.deps.call('/internal/signin/cancel', { method: 'POST', body: { id: entry.id }, timeoutMs: 3_000 })
    } catch (error) {
      if (!(error instanceof KernelError)) throw error
    }
  }

  private async pasteNative(entry: Entry, raw: string): Promise<SignInView> {
    const reply = await this.deps.call('/internal/signin/callback', { method: 'POST', body: { id: entry.id, url: raw }, timeoutMs: 10_000 })
    if (reply.status !== 204 && reply.status !== 200) {
      const failure = kernelFailure(reply, 'callback')
      this.audit('account-signin-callback', entry.agent, `mode=paste outcome=${failure.code}`)
      throw failure
    }
    entry.callbackLocked = true
    this.audit('account-signin-callback', entry.agent, 'mode=paste outcome=accepted')
    await this.refresh(entry, true).catch(() => undefined)
    return this.view(entry)
  }

  private async relayCallback(entry: Entry, raw: string): Promise<SignInView> {
    let url: URL
    try { url = new URL(raw) } catch { throw new AccountsError(422, 'callback_mismatch') }
    const port = Number(url.port)
    const pathOk = entry.relayPaths.includes(url.pathname)
      && (entry.redirectPath === null || entry.redirectPath === '/' || entry.redirectPath === url.pathname)
    if (url.protocol !== 'http:' || url.username || url.password || !LOOPBACK.has(url.hostname)
      || entry.port === null || port !== entry.port || !pathOk || url.pathname === '/cancel') {
      throw new AccountsError(422, 'callback_mismatch')
    }
    const query = url.searchParams
    const hop = entry.agent === 'kiro' && Boolean(query.get('login_option'))
    if (!query.get('code') && !query.get('error') && !hop) throw new AccountsError(422, 'callback_no_code')
    // The sign-in page's own state must come back (an `error` return without it would still end the flow on the
    // listener). Kiro's second (AWS) return carries AWS's state, which only the listener knows.
    if (entry.agent !== 'kiro' && entry.urlState && query.get('state') !== entry.urlState) {
      throw new AccountsError(422, 'callback_mismatch')
    }
    let result: RelayResult
    try {
      result = await this.relay({ port: entry.port, path: `${url.pathname}${url.search}`, host: url.host })
    } catch (error) {
      const code = error instanceof AccountsError ? error.code : 'relay_failed'
      this.audit('account-signin-callback', entry.agent, `mode=relay outcome=${code}`)
      await this.refresh(entry, true).catch(() => undefined)
      throw error instanceof AccountsError ? error : new AccountsError(502, 'relay_failed')
    }
    await this.refresh(entry, true).catch(() => undefined)
    if (result.status >= 300 && result.status < 400 && result.location && safePage(result.location)) {
      entry.next = safePage(result.location)
      this.audit('account-signin-callback', entry.agent, 'mode=relay outcome=next')
      return this.view(entry)
    }
    if (result.status >= 200 && result.status < 300) {
      entry.callbackLocked = true
      this.audit('account-signin-callback', entry.agent, 'mode=relay outcome=accepted')
      return this.view(entry)
    }
    this.audit('account-signin-callback', entry.agent, `mode=relay outcome=${TERMINAL.has(entry.phase) ? entry.phase : 'rejected'}`)
    // the listener took it and ended the flow (an `error` return): report the flow, not a refusal
    if (TERMINAL.has(entry.phase)) return this.view(entry)
    throw new AccountsError(422, 'callback_rejected')
  }

  private view(entry: Entry): SignInView {
    const state = entry.last
    const done = entry.phase === 'done'
    return {
      id: entry.id,
      agent: entry.agent,
      state: entry.phase,
      completion: entry.completion,
      url: TERMINAL.has(entry.phase) ? null : safePage(state.url),
      code: TERMINAL.has(entry.phase) ? null : state.code || null,
      installing: entry.phase === 'installing' ? state.installing || null : null,
      pasteCallback: entry.completion === 'relay' || entry.completion === 'paste',
      callbackLocked: entry.callbackLocked,
      user: done ? state.user || null : null,
      userMasked: done && state.user ? maskIdentity(state.user) : null,
      plan: done ? state.plan || null : null,
      using: done && state.using,
      error: entry.error,
      errorCode: entry.errorCode,
      detail: entry.detail,
      next: TERMINAL.has(entry.phase) ? null : entry.next,
      startedAt: iso(entry.startedAt),
      deadline: iso(entry.deadline),
    }
  }
}

