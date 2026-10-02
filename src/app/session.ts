/**
 * Session store (C1): who is signed in, as which role, and which key. One probe per page load; login, logout
 * and the 401 interceptor keep it current afterwards. Generation rules live in `sessionStore.ts`.
 *
 * Tabs share one cookie, so a sign-in or sign-out in one tab is announced to the others (BroadcastChannel);
 * they re-probe and the router moves them (`onAuthChange` in router.ts). Without the announcement a tab would
 * keep showing the previous key's rows until its next poll.
 */
import { computed } from 'vue'
import { api } from '../api'
import type { SessionInfo, SessionRole } from '../types'
import { createSessionStore } from './sessionStore'

export { safeNext } from './nextPath'
export { keyGoneNotice } from './sessionStore'
export type { SessionState } from './sessionStore'

const UNAVAILABLE_NOTICE = '暂时无法确认登录状态 · 稍后刷新'

const store = createSessionStore(() => api.session(), { onUnavailable: () => setLoginNotice(UNAVAILABLE_NOTICE) })
export const session = store.session

/** Changes whenever the signed-in role or key changes; pages scoped to one key remount on it. */
export const sessionIdentity = computed(() => store.identity())

export function applySession(info: SessionInfo) {
  store.apply(info)
}

/** Signed out here: drop the state, outdate any probe in flight, tell the other tabs. */
export function clearSession() {
  store.clear()
  announceAuthChange()
}

/** Probe `/api/session` once (or again with `force`, always a fresh request); concurrent callers share one. */
export function loadSession(force = false) {
  return store.load(force)
}

export function roleHome(role: SessionRole | null | undefined): string {
  return role === 'key' ? '/me' : '/dashboard'
}

/* ── cross-tab ── */

const CHANNEL = 'crosery-console-auth'
let channel: BroadcastChannel | null | undefined

function authChannel(): BroadcastChannel | null {
  if (channel === undefined) channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(CHANNEL) : null
  return channel
}

/** This tab signed in or out. The message carries nothing: receivers re-probe the server. */
export function announceAuthChange() {
  try {
    authChannel()?.postMessage('changed')
  } catch {
    /* a closed channel only costs the other tabs their early warning */
  }
}

/** Another tab signed in or out. Coalesced: a burst of announcements costs one probe. */
export function onAuthChange(handler: () => void) {
  const target = authChannel()
  if (!target) return
  let queued = false
  target.onmessage = () => {
    if (queued) return
    queued = true
    setTimeout(() => {
      queued = false
      handler()
    }, 50)
  }
}

/**
 * The message the login plate shows after an involuntary sign-out (expired session, key deleted or disabled).
 * Kept in memory, not in the URL, so a crafted link cannot put words on the login page.
 */
let loginNotice: string | null = null

export function setLoginNotice(text: string | null) {
  loginNotice = text
}

export function takeLoginNotice(): string | null {
  const text = loginNotice
  loginNotice = null
  return text
}
