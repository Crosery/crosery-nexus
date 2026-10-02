/**
 * Navigation model — the single source for the desktop rail, the mobile tab bar, the 更多 sheet, ⌘K page
 * jumps, 1–8 / 1–4 shortcuts and page heads (`04 / 接入 · ACCOUNTS`). `server/navRoutes.test.ts` holds this
 * file and `routes.ts` in parity: every page route has a nav entry and every nav target is a page route.
 */
import type { IconName } from '../ui/icons'
import type { NavItem } from '../ui/types'

export type NavGroupKey = 'overview' | 'access' | 'usage' | 'system'

/** BRIEF IA groups: rail dividers, ⌘K sections, 更多 sheet, page-head micro. */
export const NAV_GROUP_LABEL: Record<NavGroupKey, string> = {
  overview: '概览',
  access: '接入',
  usage: '用量',
  system: '系统',
}

export type AppNavItem = NavItem & { id: string; idx: string; en: string; icon: IconName; group: NavGroupKey }

export const ADMIN_NAV: AppNavItem[] = [
  { id: 'dashboard', idx: '01', label: '概览', en: 'OVERVIEW', group: 'overview', icon: 'grid', to: '/dashboard' },
  { id: 'keys', idx: '02', label: 'Key', en: 'KEYS', group: 'access', icon: 'key', to: '/keys' },
  { id: 'channels', idx: '03', label: '渠道', en: 'CHANNELS', group: 'access', icon: 'plug', to: '/channels' },
  { id: 'accounts', idx: '04', label: '账号', en: 'ACCOUNTS', group: 'access', icon: 'user', to: '/accounts' },
  { id: 'models', idx: '05', label: '模型', en: 'MODELS', group: 'access', icon: 'cube', to: '/models' },
  { id: 'usage', idx: '06', label: '用量', en: 'USAGE', group: 'usage', icon: 'chart', to: '/usage' },
  { id: 'settings', idx: '07', label: '设置', en: 'SETTINGS', group: 'system', icon: 'gear', to: '/settings' },
  { id: 'help', idx: '08', label: '帮助', en: 'HELP', group: 'system', icon: 'help', to: '/help' },
]

/** Mobile bottom bar (admin): 概览 · 账号 · Key · 用量, then 更多. */
export const ADMIN_TAB_IDS = ['dashboard', 'accounts', 'keys', 'usage'] as const

/** What the 更多 sheet lists, grouped like the IA. */
export const ADMIN_MORE_IDS: Array<{ group: NavGroupKey; ids: string[] }> = [
  { group: 'access', ids: ['channels', 'models'] },
  { group: 'system', ids: ['settings', 'help'] },
]

/** Key-user rail and tab bar: Chinese only, no EN micro, no admin vocabulary. */
export const KEY_NAV: AppNavItem[] = [
  { id: 'me', idx: '01', label: '概览', en: '', group: 'overview', icon: 'grid', to: '/me' },
  { id: 'me-usage', idx: '02', label: '用量', en: '', group: 'overview', icon: 'chart', to: '/me/usage' },
  { id: 'me-models', idx: '03', label: '模型', en: '', group: 'overview', icon: 'cube', to: '/me/models' },
  { id: 'me-connect', idx: '04', label: '接入', en: '', group: 'overview', icon: 'plug', to: '/me/connect' },
]

/** `/usage` workspace tabs (one nav entry, four routes). */
export const USAGE_TABS = [
  { id: 'usage', label: '总览', to: '/usage' },
  { id: 'usage-requests', label: '请求', to: '/usage/requests' },
  { id: 'usage-cache', label: '缓存', to: '/usage/cache' },
  { id: 'usage-performance', label: '性能', to: '/usage/performance' },
] as const

/** The nav entry a path belongs to (longest prefix), e.g. `/usage/cache` → 用量. */
export function navItemFor(path: string, items: AppNavItem[] = ADMIN_NAV): AppNavItem | null {
  let best: AppNavItem | null = null
  for (const item of items) {
    if (path === item.to || path.startsWith(`${item.to}/`)) if (!best || item.to.length > best.to.length) best = item
  }
  return best
}

/** Page-head micro for admin desktop: `04 / 接入 · ACCOUNTS`. */
export function pageMicro(item: AppNavItem): { idx: string; group: string; en: string } {
  return { idx: item.idx, group: NAV_GROUP_LABEL[item.group], en: item.en }
}
