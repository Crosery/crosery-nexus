/**
 * 导航单一真源：分组、条目、标题。
 *
 * 为什么要有这个文件：导航（`components/ConsoleNav.vue`）与面包屑（`lib/breadcrumbs.ts`）
 * 曾经各写一份标题表，结果两处漂移——面包屑上出现的是路由片段（`控制台 › rtk`），
 * 而侧边栏写的是中文名；用户看到的同一个页面有两个名字（红队 D18 提过，第 34 轮修）。
 *
 * 另一个真实缺陷：`TxSidebarNav` 的契约是 `SidebarNavGroup = { key, label }`，条目靠
 * `item.group === group.key` 归组。旧代码传的是 `{ id, label }` ⇒ 没有任何条目能匹配上任何组
 * ⇒ 全部落进"未分组"桶 ⇒ **五个分类标题一个都不显示**（用户报的"之前的 tab 分类没了"就是这个）。
 * 类型来自 tuffex，改这里时别把 `key` 写回 `id`。
 */
import type { SidebarNavGroup, SidebarNavItem } from '@talex-touch/tuffex/sidebar-nav'

export type NavItem = {
  /** 路由末段，同时也是面包屑的查表键。 */
  id: string
  label: string
  group: string
  icon: string
  to: string
}

/** 分组顺序即侧边栏顺序；`key` 是 tuffex 契约字段，不要改回 `id`。 */
export const NAV_GROUPS: SidebarNavGroup[] = [
  { key: 'overview', label: '总览' },
  { key: 'access', label: '接入管理' },
  { key: 'analytics', label: '用量分析' },
  { key: 'monitor', label: '运行监控' },
  { key: 'help', label: '帮助' },
]

export const NAV_ITEMS: NavItem[] = [
  { id: 'dashboard', label: '运行概览', group: 'overview', icon: 'i-carbon-dashboard', to: '/dashboard' },
  { id: 'keys', label: 'API Key', group: 'access', icon: 'i-carbon-password', to: '/keys' },
  { id: 'channels', label: '渠道账号', group: 'access', icon: 'i-carbon-connection-signal', to: '/channels' },
  { id: 'oauth', label: 'OAuth 登录', group: 'access', icon: 'i-carbon-globe', to: '/oauth' },
  // 「凭据导入」曾被整体砍掉（旧 React 有 CredentialUploadPage.tsx），第 34 轮恢复：
  // 路由 `/credentials` 与页面已落地，导航条目与路由**同时存在**，没有指向空的链接。
  { id: 'credentials', label: '凭据导入', group: 'access', icon: 'i-carbon-upload', to: '/credentials' },
  { id: 'models', label: '模型总览', group: 'access', icon: 'i-carbon-chip', to: '/models' },
  { id: 'rtk', label: 'RTK 优化', group: 'access', icon: 'i-carbon-terminal', to: '/rtk' },
  { id: 'usage', label: '统计和使用情况', group: 'analytics', icon: 'i-carbon-gauge', to: '/usage' },
  { id: 'charts', label: '图表分析', group: 'analytics', icon: 'i-carbon-chart-line', to: '/charts' },
  { id: 'analytics', label: '请求明细', group: 'analytics', icon: 'i-carbon-data-table', to: '/analytics' },
  { id: 'cache', label: '缓存命中率', group: 'analytics', icon: 'i-carbon-flash', to: '/cache' },
  { id: 'monitor', label: '账号监控', group: 'monitor', icon: 'i-carbon-activity', to: '/monitor' },
  { id: 'help', label: '接入帮助', group: 'help', icon: 'i-carbon-help', to: '/help' },
  /*
   * A/B 实验台**不放进侧边栏**：它是给我们自己看新旧交互、投一票用的内部工具，
   * 不是这个控制台的产品功能。放进产品导航会让用户问"这是干什么的"（用户原话：
   * "还有这几个何以为"）。路由 `/ab` 保留，入口在运行概览底部那条"对比新旧界面"。
   * 见 navRoutes.test.ts 的 NAV_EXEMPT_ROUTES——豁免必须显式声明，不能靠漏掉。
   */
]

export const NAV_AS_SIDEBAR_ITEMS: SidebarNavItem[] = NAV_ITEMS.map(item => ({
  value: item.id,
  label: item.label,
  group: item.group,
  icon: item.icon,
}))

const LABELS = new Map(NAV_ITEMS.map(item => [item.id, item.label]))

/** 路由末段 → 中文页名。查不到就返回 null，由调用方决定怎么显示（不要伪造标题）。 */
export function navLabelFor(segment: string): string | null {
  return LABELS.get(segment) ?? null
}
