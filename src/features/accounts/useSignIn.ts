import { onScopeDispose, shallowRef } from 'vue'
import { accountsApi } from '../../api/accounts'
import { errorReason, errorStatus } from '../../lib/errors'
import type { SignInView } from '../../types'
import {
  isLive, MAX_POLL_ERRORS, openFlow, pastDeadline, pollDelay, reduceFlow, startRequest,
  type FlowEvent, type FlowItem, type FlowState,
} from './signIn'

/**
 * Drives one sign-in at a time against /api/accounts/signin*: start, poll (800 ms visible / 3 s hidden, a
 * setTimeout chain that stops on a terminal state), paste the final callback address, cancel. A newer start or
 * a cancel bumps `generation`, so a late answer of an older request never lands on the current flow — a late
 * start answer is canceled on the server instead. Leaving the page cancels a live sign-in (it holds a host port).
 */
export function useSignIn(options: { onDone?: (view: SignInView, state: FlowState) => void } = {}) {
  const state = shallowRef<FlowState | null>(null)
  let generation = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  let pollErrors = 0

  const codeOf = (error: unknown) => {
    const code = (error as { code?: unknown } | null)?.code
    return typeof code === 'string' ? code : null
  }
  const detailOf = (error: unknown) => {
    const detail = (error as { body?: Record<string, unknown> } | null)?.body?.detail
    return typeof detail === 'string' ? detail : null
  }

  function dispatch(event: FlowEvent) {
    if (!state.value) return
    const before = state.value
    const next = reduceFlow(before, event)
    state.value = next
    if (before.step !== 'done' && next.step === 'done' && next.view) options.onDone?.(next.view, next)
  }

  function stop() {
    if (timer) clearTimeout(timer)
    timer = null
  }

  function schedule(delay = pollDelay(typeof document !== 'undefined' && document.hidden)) {
    stop()
    if (!isLive(state.value) || !state.value?.view) return
    const mine = generation
    timer = setTimeout(() => void poll(mine), delay)
  }

  async function poll(mine: number) {
    const id = state.value?.view?.id
    if (!id || mine !== generation) return
    if (pastDeadline(state.value, Date.now())) {
      dispatch({ type: 'timeout' })
      void accountsApi.cancelSignIn(id).catch(() => undefined)
      return
    }
    try {
      const view = await accountsApi.signInStatus(id)
      if (mine !== generation) return
      pollErrors = 0
      dispatch({ type: 'view', view })
    } catch (error) {
      if (mine !== generation) return
      pollErrors += 1
      if (errorStatus(error) === 404 || pollErrors >= MAX_POLL_ERRORS) {
        dispatch({ type: 'lost', code: codeOf(error), reason: errorStatus(error) === 404 ? errorReason(error) : '连不上服务器，这次登录的状态读不到了' })
        return
      }
    }
    schedule()
  }

  async function begin() {
    const current = state.value
    if (!current) return
    dispatch({ type: 'start' })
    const body = state.value ? startRequest(state.value) : null
    if (!body) return
    const mine = ++generation
    pollErrors = 0
    try {
      const view = await accountsApi.signIn(body.agent, { site: body.site, confirmRisk: body.confirmRisk })
      if (mine !== generation) {
        // canceled or replaced while the kernel was starting it: don't leave a listener behind
        void accountsApi.cancelSignIn(view.id).catch(() => undefined)
        return
      }
      dispatch({ type: 'view', view })
      schedule()
    } catch (error) {
      if (mine !== generation) return
      dispatch({ type: 'startFailed', code: codeOf(error), reason: errorReason(error), detail: detailOf(error) })
    }
  }

  /** Open the flow for one catalog item; risk / site steps first when the item needs them. */
  function open(item: FlowItem, opts: { site?: string | null } = {}) {
    abandon()
    state.value = openFlow(item, opts)
    if (state.value.step === 'starting') void begin()
  }

  /** Follow a sign-in this console already started (the list reports it), e.g. after a reload. */
  async function attach(item: FlowItem, id: string) {
    abandon()
    // already past the risk card; the site is unknown, so a retry asks for it again
    state.value = { ...openFlow(item, { riskConfirmed: true }), step: 'starting' }
    const mine = ++generation
    try {
      const view = await accountsApi.signInStatus(id)
      if (mine !== generation) return
      // the list was older than the flow: it already ended (canceled, failed, done) → start a new one
      if (view.state !== 'installing' && view.state !== 'waiting') return open(item)
      dispatch({ type: 'view', view })
      schedule()
    } catch (error) {
      if (mine !== generation) return
      if (errorStatus(error) === 404) return open(item)
      dispatch({ type: 'lost', code: codeOf(error), reason: errorReason(error) })
    }
  }

  function confirmRisk() {
    dispatch({ type: 'confirmRisk' })
    if (state.value?.step === 'starting') void begin()
  }

  function pickSite(site: string) {
    dispatch({ type: 'pickSite', site })
    if (state.value?.step === 'starting') void begin()
  }

  function retry() {
    generation += 1
    stop()
    dispatch({ type: 'retry' })
    if (state.value?.step === 'starting') void begin()
  }

  async function submitCallback(url: string) {
    const id = state.value?.view?.id
    const text = url.trim()
    if (!id || !text) return
    dispatch({ type: 'callbackSubmit' })
    if (!state.value?.callbackBusy) return
    const mine = generation
    try {
      const view = await accountsApi.submitCallback(id, text)
      if (mine !== generation) return
      dispatch({ type: 'view', view })
      if (state.value?.callbackBusy) state.value = { ...state.value, callbackBusy: false }
      schedule(0)
    } catch (error) {
      if (mine !== generation) return
      dispatch({ type: 'callbackFailed', reason: errorReason(error) })
    }
  }

  /** The person ended it: the server flow is canceled too (it frees the host port). */
  function cancel() {
    const live = isLive(state.value)
    const id = state.value?.view?.id
    generation += 1
    stop()
    dispatch({ type: 'cancel' })
    if (live && id) void accountsApi.cancelSignIn(id).catch(() => undefined)
  }

  /** Drop the flow (the sheet went back to the catalog or closed); a live one is canceled first. */
  function abandon() {
    if (isLive(state.value)) cancel()
    generation += 1
    stop()
    pollErrors = 0
    state.value = null
  }

  function onVisibility() {
    if (typeof document === 'undefined' || document.hidden || !isLive(state.value) || !state.value?.view) return
    schedule(0)
  }
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility)
  onScopeDispose(() => {
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility)
    abandon()
  })

  return { state, open, attach, confirmRisk, pickSite, retry, submitCallback, cancel, abandon }
}
