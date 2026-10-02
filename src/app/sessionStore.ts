/**
 * The session store without the fetch wiring (unit-tested in server/loginPageModel.test.ts).
 *
 * Auth generations: every probe and every sign-out takes a new generation number, and a probe answer is applied
 * only while its generation is still the newest. So a probe that started before a sign-out (or before a newer
 * forced probe) can never put an old authenticated state back. A forced probe always starts a new request.
 */
import { reactive, readonly } from 'vue'
import type { SessionInfo, SessionRole } from '../types.js'

export type SessionState = {
  checked: boolean
  authenticated: boolean
  role: SessionRole | null
  user: { name: string } | null
  key: { name: string; masked: string; ref?: string } | null
}

export type SessionProbeError = { status?: number; code?: string | null }

/**
 * The login plate's words when a key stopped working mid-use (C1 401 codes). Client-side text: the server's own
 * message already ends in `· 重新登录`, and re-login only helps when the key is still valid.
 */
export function keyGoneNotice(code: string | null | undefined): string | null {
  if (code === 'key_invalid') return 'API Key 已失效 · 重新登录'
  if (code === 'key_disabled') return 'API Key 已被停用 · 找管理员恢复'
  return null
}

export function createSessionStore(probe: () => Promise<SessionInfo>, hooks: { onUnavailable?: () => void } = {}) {
  const state = reactive<SessionState>({ checked: false, authenticated: false, role: null, user: null, key: null })
  let generation = 0
  let inflight: Promise<SessionState> | null = null

  function apply(info: SessionInfo) {
    state.checked = true
    if (!info.authenticated) {
      state.authenticated = false
      state.role = null
      state.user = null
      state.key = null
      return
    }
    state.authenticated = true
    state.role = info.role === 'key' ? 'key' : 'admin'
    state.user = info.user ?? null
    state.key = info.key ?? null
  }

  /** Signed out (logout, 401): newer than every probe still in flight. */
  function clear() {
    generation += 1
    inflight = null
    apply({ authenticated: false })
  }

  /**
   * Probe `/api/session` once (or again with `force`, which always starts a new request). Concurrent unforced
   * callers share the request in flight. A failed probe keeps an earlier answer (a transient error is not a
   * sign-out); with no earlier answer the session reads as signed out.
   */
  function load(force = false): Promise<SessionState> {
    if (state.checked && !force) return Promise.resolve(state)
    if (inflight && !force) return inflight
    const mine = ++generation
    const run: Promise<SessionState> = probe()
      .then(
        (info) => {
          if (mine === generation) apply(info)
        },
        (error: SessionProbeError) => {
          // superseded, or an earlier answer stands (no login-plate notice either: it would outlive this blip)
          if (mine !== generation || state.checked) return
          if (error?.code === 'session_unavailable') hooks.onUnavailable?.()
          apply({ authenticated: false })
        },
      )
      .then(() => {
        if (inflight === run) inflight = null
        // superseded by a newer probe: answer with that one once it settles; by a sign-out: the cleared state
        return mine === generation || !inflight ? state : inflight
      })
    inflight = run
    return run
  }

  /**
   * Who is signed in: changes when the role or the key changes (another tab signed in as someone else). `ref` is the
   * server's opaque per-key id — two keys can share a name and a masked head/tail.
   */
  const identity = () => (state.authenticated ? `${state.role}|${state.key?.ref ?? ''}|${state.key?.name ?? ''}|${state.key?.masked ?? ''}` : '')

  return { state, session: readonly(state), apply, clear, load, identity }
}
