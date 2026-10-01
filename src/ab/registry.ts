/**
 * A/B 两套变体的组件注册表 —— **本文件是唯一 import 变体组件的地方**。
 *
 * A 侧（`variants/legacy/*`）：`git show 281c30e:<path>` 的**冻结页面副本**，因此蓝队重写
 * `src/pages/*`、`src/components/*` 不会污染 A 侧。它们依赖的 `api/types/gatewayStatus`
 * 指向活模块（`../../../api` 等）：那三个文件是「类型 + 薄封装」且只做追加，
 * 冻结副本反而会带来重复定义漂移（见 COORDINATION 与 Lead 的决定）。
 * B 侧（`../pages/*`）：蓝队正在维护的**真实页面**，只读引用、不改动。
 *
 * Phase 2 若 B 侧换成新页面（例如 blue-rtk 的 `RtkPage.vue`），只需要改这一个文件。
 */

import { defineAsyncComponent, h, type Component } from 'vue'

/** 变体组件加载中的占位（受控：加载完就消失，不会出现「永久加载中」）。 */
const LabLoading: Component = () => h('p', { class: 'lab-frame__state', role: 'status' }, '正在加载变体组件…')

/** 变体组件加载失败：给出原因 + 刷新指引，避免空白。 */
const LabError: Component = (props: { error?: unknown }) => {
  const message = props.error instanceof Error ? props.error.message : '未知错误'
  return h('div', { class: 'lab-frame__state lab-frame__state--error', role: 'alert' }, [
    h('strong', null, '变体组件加载失败'),
    h('p', null, `${message}。请刷新页面；若持续失败，说明该变体在当前构建里没有产出 chunk。`),
  ])
}

const lazy = (loader: () => Promise<unknown>): Component =>
  defineAsyncComponent({
    loader: loader as () => Promise<Component>,
    loadingComponent: LabLoading,
    errorComponent: LabError,
    delay: 120,
    timeout: 20_000,
  })

/* ── A 侧：迁移前（281c30e 冻结页面副本） ────────────────────────────────── */
const legacyKeys = lazy(() => import('./variants/legacy/KeysPage.legacy.vue'))
const legacyDashboard = lazy(() => import('./variants/legacy/DashboardPage.legacy.vue'))
const legacyOAuth = lazy(() => import('./variants/legacy/OAuthPage.legacy.vue'))
const legacyHelp = lazy(() => import('./variants/legacy/HelpPage.legacy.vue'))

/* ── B 侧：迁移后（真实页面，只读引用） ──────────────────────────────────── */
const currentKeys = lazy(() => import('../pages/KeysPage.vue'))
const currentDashboard = lazy(() => import('../pages/DashboardPage.vue'))
const currentOAuth = lazy(() => import('../pages/OAuthPage.vue'))
const currentHelp = lazy(() => import('../pages/HelpPage.vue'))
/** 迁移后新增的 RTK 配置面（blue-rtk/task-3）；A 侧在控制台里没有对应物。 */
const currentRtk = lazy(() => import('../pages/RtkPage.vue'))

export interface VariantPair {
  /** A=迁移前 主视图 */
  legacy: Component
  /** B=迁移后 主视图 */
  current: Component
  /** A 侧在该流程里「要看文档」时的文档面（可选，折叠展示） */
  legacyDoc?: Component
  /** B 侧文档面（可选，折叠展示） */
  currentDoc?: Component
  /** B 侧在原流程之外**新增**的面（A 侧没有对应物），例如 RTK 配置页 */
  currentExtra?: Component
  currentExtraLabel?: string
}

export type VariantPairKey = 'keys' | 'integration' | 'dashboard'

export const VARIANT_PAIRS: Record<VariantPairKey, VariantPair> = {
  keys: {
    legacy: legacyKeys,
    current: currentKeys,
  },
  integration: {
    legacy: legacyOAuth,
    current: currentOAuth,
    legacyDoc: legacyHelp,
    currentDoc: currentHelp,
    // 迁移前控制台里**没有** RTK 面（只能翻帮助页）；迁移后新增了这个真实页面。
    currentExtra: currentRtk,
    currentExtraLabel: 'B 侧新增面：RTK Token 压缩（迁移前控制台里没有这个面）',
  },
  dashboard: {
    legacy: legacyDashboard,
    current: currentDashboard,
  },
}
