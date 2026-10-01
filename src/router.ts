import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router'
import ConsoleShell from './components/ConsoleShell.vue'
import { api } from './api'

const routes: RouteRecordRaw[] = [
  {
    path: '/login',
    name: 'login',
    component: () => import('./pages/LoginPage.vue'),
    meta: { public: true },
  },
  {
    path: '/',
    component: ConsoleShell,
    children: [
      { path: '', redirect: '/dashboard' },
      { path: 'dashboard', name: 'dashboard', component: () => import('./pages/DashboardPage.vue') },
      { path: 'keys', name: 'keys', component: () => import('./pages/KeysPage.vue') },
      { path: 'channels', name: 'channels', component: () => import('./pages/ChannelsPage.vue') },
      { path: 'oauth', name: 'oauth', component: () => import('./pages/OAuthPage.vue') },
      // 凭据导入（task-77 恢复）：旧 React 版为 src/pages/CredentialUploadPage.tsx，Vue 重写时整页丢失。
      // 路由用 `/credentials`（比 /credentials-upload 短，且与 /api/credentials 同词），归入「接入管理」组（见 ConsoleNav）。
      { path: 'credentials', name: 'credentials', component: () => import('./pages/CredentialUploadPage.vue') },
      { path: 'models', name: 'models', component: () => import('./pages/ModelsPage.vue') },
      // RTK 控制面：本机/内核/中转站三层平面，写入策略受服务端开关约束。
      { path: 'rtk', name: 'rtk', component: () => import('./pages/RtkPage.vue') },
      { path: 'charts', name: 'charts', component: () => import('./pages/ChartsPage.vue') },
      { path: 'analytics', name: 'analytics', component: () => import('./pages/AnalyticsPage.vue') },
      { path: 'usage', name: 'usage', component: () => import('./pages/UsagePage.vue') },
      { path: 'cache', name: 'cache', component: () => import('./pages/CachePage.vue') },
      { path: 'monitor', name: 'monitor', component: () => import('./pages/MonitorPage.vue') },
      { path: 'help', name: 'help', component: () => import('./pages/HelpPage.vue') },
      // A/B 实验台（本地 QA 用）：新旧交互对照与真实用户偏好留痕，深链 /ab?flow=&v=
      { path: 'ab', name: 'ab', component: () => import('./pages/AbLabPage.vue') },
    ],
  },
  {
    path: '/:pathMatch(.*)*',
    redirect: '/dashboard',
  },
]

export const router = createRouter({
  history: createWebHistory('/'),
  routes,
  scrollBehavior: (_to, _from, saved) => saved ?? { top: 0 },
})

let authState: { checked: boolean; authenticated: boolean } = {
  checked: false,
  authenticated: false,
}

export function updateAuthState(authenticated: boolean) {
  authState.checked = true
  authState.authenticated = authenticated
}

router.beforeEach(async (to, _from, next) => {
  if (to.meta.public) {
    if (authState.checked && authState.authenticated && to.path === '/login') {
      return next('/dashboard')
    }
    return next()
  }

  if (!authState.checked) {
    try {
      const res = await api.session()
      authState.authenticated = Boolean(res?.authenticated)
    } catch {
      authState.authenticated = false
    }
    authState.checked = true
  }

  if (!authState.authenticated) {
    return next('/login')
  }

  next()
})
