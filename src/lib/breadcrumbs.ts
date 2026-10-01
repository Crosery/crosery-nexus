/**
 * 面包屑：纯函数，按当前路由给出「控制台 › 当前页」。
 *
 * 对照参考实现 `geek_main/app/console/src/lib/nav.ts:64-71` 的 activeNavId（最长前缀匹配、纯函数、可测），
 * 以及 `components/PageHeader.vue:6,13-16` 的面包屑形状（`{label, to}`，站内路由）。
 *
 * 标题真源已搬到 `lib/nav.ts`（导航与面包屑共用一份）。此前两处各写一份，
 * 结果同一页面有两个名字：面包屑上是路由片段（`控制台 › rtk`），侧边栏上是中文名。
 */
import { navLabelFor } from './nav'

export type Crumb = { label: string; to?: string }

/** 首页（概览）本身不再重复「控制台」这一层。 */
export function crumbsForPath(path: string): Crumb[] {
  const clean = path.replace(/\/+$/, '') || '/'
  const segments = clean.split('/').filter(Boolean)
  if (!segments.length) return []
  const last = segments[segments.length - 1]
  // 未登记的段如实显示原段：不猜、不美化——猜错会让人以为自己在另一个页面上。
  const label = navLabelFor(last) ?? last
  if (last === 'dashboard') return [{ label }]
  return [{ label: '控制台', to: '/dashboard' }, { label }]
}
