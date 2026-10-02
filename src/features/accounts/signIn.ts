/**
 * The sign-in flow in the add-account sheet as a pure reducer (ACCOUNTS-ALIGN §3, Magpie `startSignIn` /
 * `followSignIn` / `renderSigning`): risk → site → starting → installing → waiting → done | failed | canceled.
 * `risk`, `site` and `starting` are client-only steps; the rest mirror the server's SignInView.state. No Vue,
 * no DOM (`server/accountsSignInFlow.test.ts`). The server is the guard: it refuses a risky sign-in without
 * `confirmRisk`, a gated agent, a bad site — this file only decides what the sheet shows.
 */
import type { SignInView } from '../../types.js'

export type FlowStep = 'risk' | 'site' | 'starting' | 'installing' | 'waiting' | 'done' | 'failed' | 'canceled'

export type FlowItem = {
  agent: string
  shortName: string
  risk: { title: string; note: string } | null
  sites: Array<{ id: string; label: string; host: string }>
}

export type FlowState = {
  agent: string
  name: string
  step: FlowStep
  risk: { title: string; note: string } | null
  riskConfirmed: boolean
  sites: FlowItem['sites']
  site: string | null
  /** the server's last answer for this sign-in */
  view: SignInView | null
  /** failed / canceled: the zh reason, its code and Magpie's sanitized English detail */
  reason: string | null
  code: string | null
  detail: string | null
  /** the pasted address was accepted: the input stays locked for the rest of this sign-in */
  callbackLocked: boolean
  callbackBusy: boolean
  callbackError: string | null
  canceledBy: 'user' | 'server' | null
}

export type FlowEvent =
  | { type: 'confirmRisk' }
  | { type: 'pickSite'; site: string }
  /** a POST /api/accounts/signin is on its way */
  | { type: 'start' }
  /** any SignInView: the start answer, a poll, a callback answer */
  | { type: 'view'; view: SignInView }
  | { type: 'startFailed'; code: string | null; reason: string; detail?: string | null }
  /** polling gave up (404, repeated failures) */
  | { type: 'lost'; code: string | null; reason: string }
  | { type: 'callbackSubmit' }
  | { type: 'callbackFailed'; reason: string }
  | { type: 'cancel' }
  | { type: 'retry' }
  | { type: 'timeout' }

export const LIVE_STEPS: ReadonlySet<FlowStep> = new Set(['starting', 'installing', 'waiting'])
const TERMINAL: ReadonlySet<FlowStep> = new Set(['done', 'failed', 'canceled'])

/** Magpie polls every 800 ms; a hidden tab every 3 s (a status read is a map lookup in the kernel). */
export const POLL_VISIBLE_MS = 800
export const POLL_HIDDEN_MS = 3000
/** past the deadline the server cancels the flow itself (≤ 30 s later); this is the browser's last resort */
export const DEADLINE_SLACK_MS = 60_000
/** consecutive failed polls before the sheet says the connection is gone */
export const MAX_POLL_ERRORS = 4

export function pollDelay(hidden: boolean): number {
  return hidden ? POLL_HIDDEN_MS : POLL_VISIBLE_MS
}

export function firstStep(item: Pick<FlowItem, 'risk' | 'sites'>, riskConfirmed = false, site: string | null = null): FlowStep {
  if (item.risk && !riskConfirmed) return 'risk'
  if (item.sites.length && !site) return 'site'
  return 'starting'
}

export function openFlow(item: FlowItem, options: { site?: string | null; riskConfirmed?: boolean } = {}): FlowState {
  const site = options.site && item.sites.some((s) => s.id === options.site) ? options.site : null
  const riskConfirmed = Boolean(options.riskConfirmed && item.risk)
  return {
    agent: item.agent,
    name: item.shortName,
    step: firstStep(item, riskConfirmed, site),
    risk: item.risk,
    riskConfirmed,
    sites: item.sites,
    site,
    view: null,
    reason: null,
    code: null,
    detail: null,
    callbackLocked: false,
    callbackBusy: false,
    callbackError: null,
    canceledBy: null,
  }
}

export function isLive(state: FlowState | null | undefined): boolean {
  return Boolean(state && LIVE_STEPS.has(state.step))
}

export function isTerminal(state: FlowState | null | undefined): boolean {
  return Boolean(state && TERMINAL.has(state.step))
}

/** The body of POST /api/accounts/signin, or null when the flow is not at `starting`. */
export function startRequest(state: FlowState): { agent: string; site?: string; confirmRisk?: boolean } | null {
  if (state.step !== 'starting') return null
  return {
    agent: state.agent,
    ...(state.site ? { site: state.site } : {}),
    ...(state.risk ? { confirmRisk: state.riskConfirmed } : {}),
  }
}

/** ms until the server's deadline (null before the first answer). */
export function remainingMs(state: FlowState | null | undefined, now: number): number | null {
  const at = state?.view?.deadline ? Date.parse(state.view.deadline) : NaN
  return Number.isFinite(at) ? Math.max(0, at - now) : null
}

export function pastDeadline(state: FlowState | null | undefined, now: number): boolean {
  const at = state?.view?.deadline ? Date.parse(state.view.deadline) : NaN
  return Number.isFinite(at) && now > at + DEADLINE_SLACK_MS
}

function fromView(state: FlowState, view: SignInView): FlowState {
  const base = { ...state, view, callbackLocked: state.callbackLocked || view.callbackLocked }
  switch (view.state) {
    case 'installing':
    case 'waiting':
      return { ...base, step: view.state }
    case 'done':
      return { ...base, step: 'done', callbackBusy: false, callbackError: null }
    case 'failed':
      return { ...base, step: 'failed', callbackBusy: false, reason: view.error || '登录未完成', code: view.errorCode, detail: view.detail }
    case 'canceled':
      return { ...base, step: 'canceled', callbackBusy: false, canceledBy: state.canceledBy ?? 'server', reason: view.error }
    default:
      return state
  }
}

export function reduceFlow(state: FlowState, event: FlowEvent): FlowState {
  switch (event.type) {
    case 'confirmRisk':
      if (state.step !== 'risk') return state
      return { ...state, riskConfirmed: true, step: firstStep(state, true, state.site) }
    case 'pickSite':
      if (state.step !== 'site' || !state.sites.some((s) => s.id === event.site)) return state
      return { ...state, site: event.site, step: 'starting' }
    case 'start':
      return firstStep(state, state.riskConfirmed, state.site) === 'starting'
        ? { ...state, step: 'starting', view: null, reason: null, code: null, detail: null, canceledBy: null }
        : state
    case 'view':
      // a finished sign-in stays finished; an answer for another sign-in id is not this flow's
      if (TERMINAL.has(state.step)) return state
      if (state.view && state.view.id !== event.view.id) return state
      return fromView(state, event.view)
    case 'startFailed':
      if (state.step !== 'starting') return state
      if (event.code === 'risk_unconfirmed' && state.risk) return { ...state, step: 'risk', riskConfirmed: false }
      if (event.code === 'site_required' && state.sites.length) return { ...state, step: 'site', site: null }
      return { ...state, step: 'failed', reason: event.reason, code: event.code, detail: event.detail ?? null }
    case 'lost':
      if (!LIVE_STEPS.has(state.step)) return state
      return { ...state, step: 'failed', reason: event.reason, code: event.code, detail: null, callbackBusy: false }
    case 'timeout':
      if (!LIVE_STEPS.has(state.step)) return state
      return { ...state, step: 'failed', reason: '登录超时，请重新开始', code: 'signin_timeout', detail: null, callbackBusy: false }
    case 'callbackSubmit':
      if (state.step !== 'waiting' || state.callbackLocked || state.callbackBusy) return state
      return { ...state, callbackBusy: true, callbackError: null }
    case 'callbackFailed':
      return { ...state, callbackBusy: false, callbackError: event.reason }
    case 'cancel':
      if (TERMINAL.has(state.step)) return state
      return { ...state, step: 'canceled', canceledBy: 'user', callbackBusy: false }
    case 'retry':
      if (!TERMINAL.has(state.step)) return state
      return {
        ...state,
        step: firstStep(state, state.riskConfirmed, state.site),
        view: null, reason: null, code: null, detail: null,
        callbackLocked: false, callbackBusy: false, callbackError: null, canceledBy: null,
      }
  }
}

/* ── what the waiting panel says ─────────────────────────────────────────────────────────────── */

export type WaitingHint = 'code-confirm' | 'code-enter' | 'browser'

/** Magpie's sub text: Factory asks to check the code it shows, Copilot to type it, the rest to finish in the browser. */
export function waitingHint(state: FlowState): WaitingHint {
  if (!state.view?.code) return 'browser'
  return state.agent === 'factory' ? 'code-confirm' : 'code-enter'
}
