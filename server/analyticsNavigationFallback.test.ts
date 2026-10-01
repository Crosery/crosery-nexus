import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

/**
 * 这一组曾经断言 React 死树（`src/pages/AnalyticsPage.tsx` / `src/App.tsx`）。
 * 那两个文件已删除（task-17），活代码是 `.vue` 树，所以这里改为**对活代码的等价断言**：
 * 仍然盯着原来那两个真实事故——「切页时解引用缺失的 keyUsage」与「Dashboard 的部分响应覆盖完整 Analytics」。
 */
const analytics = fs.readFileSync(new URL('../src/pages/AnalyticsPage.vue', import.meta.url), 'utf8')
const dashboard = fs.readFileSync(new URL('../src/pages/DashboardPage.vue', import.meta.url), 'utf8')

test('请求明细页在 keyUsage 缺失时不解引用（活代码：AnalyticsPage.vue）', () => {
  // 归一化：模板里允许 `analytics.value?.keyUsage` 与 `analytics?.keyUsage` 两种写法。
  const normalized = analytics.replace(/\.value/g, '')
  assert.match(normalized, /const keyUsage = computed\(\(\) => analytics\?\.keyUsage \?\? \[\]\)/)
  assert.match(analytics, /v-for="\(k, idx\) in keyUsage"/)
  // 直接对可能为 undefined 的对象取属性链上的 .map 才是事故本身。
  assert.doesNotMatch(normalized, /analytics\?\.keyUsage\.map\(/)
  assert.doesNotMatch(normalized, /analytics\.keyUsage\.map\(/)
})

test('请求明细页读的是 /api/analytics，不是 /api/usage-breakdown（D1 回归守卫）', () => {
  // 2026-10-01 的真实事故：这里误调 usageBreakdown 并断言成 AnalyticsData，
  // 两者除 days 外零字段重叠 → 41.6% 的错误率被渲染成「0.0% 健康稳定」。
  assert.match(analytics, /api\.analytics<AnalyticsData>\(days\.value, scope\.state\.keyId\)/)
  assert.doesNotMatch(analytics, /api\.usageBreakdown/)
  // 类型与请求同源：AnalyticsData 的形状只能来自 /api/analytics。
  assert.match(analytics, /import type \{[^}]*AnalyticsData[^}]*\} from '\.\.\/types'/)
})

test('Dashboard 与请求明细各自独立取数，互不覆盖（活代码：useResource 依赖驱动）', () => {
  // React 版用「两个 request ref + setAnalytics 互斥」保证不互相覆盖；
  // Vue 版把这条不变量前移到「两个页面各自 useResource，且 Dashboard 从不请求/写入 analytics」。
  assert.match(dashboard, /api\.dashboard<DashboardData>/)
  assert.doesNotMatch(dashboard, /api\.analytics/)
  assert.doesNotMatch(dashboard, /analytics\.value =/)
  // 依赖驱动重取：days/keyId 变化必须触发重取（否则筛选会静默失效——本轮修过的真实缺陷）。
  assert.match(dashboard, /\[\(\) => scope\.state\.days, \(\) => scope\.state\.keyId\]/)
})
