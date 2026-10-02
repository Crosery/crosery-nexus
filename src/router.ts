import { createRouter, createWebHistory } from 'vue-router'
import { setAuthHooks } from './api'
import { routes } from './app/routes'
import { clearSession, keyGoneNotice, loadSession, onAuthChange, roleHome, safeNext, session, sessionIdentity, setLoginNotice } from './app/session'
import { notify } from './ui/feedback/toast'

export const router = createRouter({
  history: createWebHistory('/'),
  routes,
  scrollBehavior: (to, from, saved) => {
    if (saved) return saved
    if (to.hash) return { el: to.hash, top: 64 }
    // filters and sort live in the query: changing them must not jump to the top
    if (to.path === from.path) return false
    return { top: 0 }
  },
})

const ADMIN_ONLY = '此页面仅管理员可见'

router.beforeEach(async (to) => {
  const current = await loadSession()

  if (to.meta.public) {
    if (to.name === 'login' && current.authenticated) return safeNext(to.query.next) ?? roleHome(current.role)
    return true
  }
  if (!current.authenticated) {
    const next = to.meta.home ? null : safeNext(to.fullPath)
    return { name: 'login', query: next ? { next } : {} }
  }
  if (to.meta.home) return roleHome(current.role)
  if (to.meta.role && to.meta.role !== current.role) {
    // Cosmetic only: the server answers 403 for the other role's endpoints anyway.
    if (current.role === 'key') notify(ADMIN_ONLY, { tone: 'note', id: 'cx-role' })
    return roleHome(current.role)
  }
  return true
})

/*
 * Global response hooks (DESIGN §5.1): a session that dies mid-use goes to /login?next=…, and a role
 * mismatch (another tab switched this browser's session to the other role) re-probes and goes home.
 */
let leaving = false
setAuthHooks({
  onUnauthorized(error) {
    if (leaving) return
    const route = router.currentRoute.value
    clearSession()
    if (route.meta.public) return
    leaving = true
    const keyNotice = keyGoneNotice(error.code)
    const keyGone = keyNotice !== null
    const title = (route.meta.title as string | undefined) ?? '上一页'
    setLoginNotice(keyNotice ?? `会话已过期 · 登录后回到 ${title}`)
    const next = safeNext(route.fullPath)
    void router.replace({ name: 'login', query: next && !keyGone ? { next } : {} }).finally(() => {
      leaving = false
    })
  },
  async onRoleDenied() {
    if (leaving) return
    leaving = true
    try {
      const current = await loadSession(true)
      if (!current.authenticated) {
        await router.replace({ name: 'login' })
        return
      }
      if (current.role === 'key') notify(ADMIN_ONLY, { tone: 'note', id: 'cx-role' })
      const route = router.currentRoute.value
      if (route.meta.role !== current.role) await router.replace(roleHome(current.role))
    } finally {
      leaving = false
    }
  },
})

/*
 * Another tab signed in or out (same cookie): re-probe, then leave pages that belong to the old identity.
 * Same role, different key → KeyShell remounts its page on `sessionIdentity`, so no rows or cursor of the
 * previous key survive.
 */
onAuthChange(async () => {
  const before = sessionIdentity.value
  const current = await loadSession(true)
  if (sessionIdentity.value === before || leaving) return
  const route = router.currentRoute.value
  if (!current.authenticated) {
    if (route.meta.public) return
    setLoginNotice('已在其他标签页退出')
    await router.replace({ name: 'login' })
    return
  }
  if (route.meta.public || (route.meta.role && route.meta.role !== current.role)) await router.replace(roleHome(current.role))
})

/** Login / logout transitions call these so the guard never acts on a stale role. */
export async function refreshSession() {
  return loadSession(true)
}

export { session }
