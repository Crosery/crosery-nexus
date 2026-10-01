/**
 * 面包屑：纯函数，按当前路由给出「控制台 › 当前页」。
 *
 * 对照参考实现 `geek_main/app/console/src/lib/nav.ts:64-71` 的 activeNavId（最长前缀匹配、纯函数、可测），
 * 以及 `components/PageHeader.vue:6,13-16` 的面包屑形状（`{label, to}`，站内路由）。
 * 放在 lib 里而不是塞进外壳组件里，是为了让 ConsoleShell 与页面共用同一份标题表（红队 D18）。
 */

export type Crumb = { label: string; to?: string }

/** 路由末段 → 页面标题。与 `src/router.ts` 的 path 一一对应（router.ts 归 Lead，改动时同步这里）。 */
export const PAGE_TITLES: Record<string, string> = {
  dashboard: '运行概览',
  keys: 'API Key',
  channels: '渠道',
  oauth: 'OAuth 登录池',
  models: '模型目录',
  charts: '图表分析',
  analytics: '请求明细',
  usage: '用量统计',
  cache: '缓存分析',
  monitor: '账号监控',
  help: '帮助',
}

/** 首页（概览）本身不再重复「控制台」这一层。 */
export function crumbsForPath(path: string): Crumb[] {
  const clean = path.replace(/\/+$/, '') || '/'
  const segments = clean.split('/').filter(Boolean)
  if (!segments.length) return []
  const last = segments[segments.length - 1]
  const label = PAGE_TITLES[last] ?? last
  if (last === 'dashboard') return [{ label }]
  return [{ label: '控制台', to: '/dashboard' }, { label }]
}
