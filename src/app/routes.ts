/**
 * Route table (CONTRACTS "Frontend routes"). Two role trees under two shells; `meta.role` on the shell record
 * is merged into every child, and the guard in `src/router.ts` enforces it. Shells and pages are lazy so the
 * entry chunk carries neither. Child paths are written absolute (vue-router allows it) so every record states
 * its real URL — `server/navRoutes.test.ts` reads them as written.
 */
import { defineComponent } from 'vue'
import type { RouteRecordRaw } from 'vue-router'
import type { SessionRole } from '../types'

declare module 'vue-router' {
  interface RouteMeta {
    /** reachable without a session (only /login) */
    public?: boolean
    /** only this role may enter; the other role is sent to its home */
    role?: SessionRole
    /** `/` and unknown paths: resolved to the role's home once the session is known */
    home?: boolean
    /** mobile top-bar title */
    title?: string
  }
}

/** Placeholder for records the guard always redirects away from. */
const Redirecting = defineComponent({ name: 'Redirecting', render: () => null })

export const routes: RouteRecordRaw[] = [
  {
    path: '/login',
    name: 'login',
    component: () => import('../features/auth/LoginPage.vue'),
    meta: { public: true, title: '登录' },
  },
  {
    path: '/',
    component: () => import('../shell/AdminShell.vue'),
    meta: { role: 'admin' },
    children: [
      { path: '/', name: 'home', component: Redirecting, meta: { home: true } },
      { path: '/dashboard', name: 'dashboard', component: () => import('../features/overview/OverviewPage.vue'), meta: { title: '概览' } },
      { path: '/keys', name: 'keys', component: () => import('../features/keys/KeysPage.vue'), meta: { title: 'Key' } },
      { path: '/channels', name: 'channels', component: () => import('../features/channels/ChannelsPage.vue'), meta: { title: '渠道' } },
      { path: '/accounts', name: 'accounts', component: () => import('../features/accounts/AccountsPage.vue'), meta: { title: '账号' } },
      { path: '/models', name: 'models', component: () => import('../features/models/ModelsPage.vue'), meta: { title: '模型' } },
      {
        path: '/usage',
        component: () => import('../features/usage/UsageWorkspace.vue'),
        meta: { title: '用量' },
        children: [
          { path: '/usage', name: 'usage', component: () => import('../features/usage/tabs/UsageOverviewTab.vue') },
          { path: '/usage/requests', name: 'usage-requests', component: () => import('../features/usage/tabs/RequestsTab.vue') },
          { path: '/usage/cache', name: 'usage-cache', component: () => import('../features/usage/tabs/CacheTab.vue') },
          { path: '/usage/performance', name: 'usage-performance', component: () => import('../features/usage/tabs/PerformanceTab.vue') },
        ],
      },
      { path: '/settings', name: 'settings', component: () => import('../features/settings/SettingsPage.vue'), meta: { title: '设置' } },
      { path: '/help', name: 'help', component: () => import('../features/help/HelpPage.vue'), meta: { title: '帮助' } },
    ],
  },
  {
    path: '/me',
    component: () => import('../shell/KeyShell.vue'),
    meta: { role: 'key' },
    children: [
      { path: '/me', name: 'me', component: () => import('../features/me/MeOverviewPage.vue'), meta: { title: '概览' } },
      { path: '/me/usage', name: 'me-usage', component: () => import('../features/me/MeUsagePage.vue'), meta: { title: '用量' } },
      { path: '/me/models', name: 'me-models', component: () => import('../features/me/MeModelsPage.vue'), meta: { title: '模型' } },
      { path: '/me/connect', name: 'me-connect', component: () => import('../features/me/MeConnectPage.vue'), meta: { title: '接入' } },
    ],
  },
  // v2 paths keep working (bookmarks, old links); query and hash are carried over by the router.
  { path: '/oauth', redirect: '/accounts' },
  { path: '/monitor', redirect: '/accounts' },
  { path: '/rtk', redirect: '/settings' },
  { path: '/charts', redirect: '/usage/performance' },
  { path: '/analytics', redirect: '/usage/requests' },
  { path: '/cache', redirect: '/usage/cache' },
  { path: '/credentials', redirect: '/dashboard' },
  { path: '/ab', redirect: '/dashboard' },
  { path: '/:pathMatch(.*)*', name: 'unknown', component: Redirecting, meta: { home: true } },
]
