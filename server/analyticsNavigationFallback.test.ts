import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

/**
 * 两个真实事故的回归守卫，跟着 v3 的文件走（v2 `pages/AnalyticsPage.vue` → `features/usage/tabs/RequestsTab.vue`，
 * `pages/DashboardPage.vue` → `features/overview/OverviewPage.vue`）：
 * - 切页时解引用缺失的 `keyUsage`（部分响应没有这个字段）。
 * - 概览的部分响应覆盖了请求明细的完整数据（两页共享状态）。
 */
const read = (file: string) => fs.readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8')
const requests = read('features/usage/tabs/RequestsTab.vue')
const overview = read('features/overview/OverviewPage.vue')

test('请求页签在 keyUsage 缺失时不解引用', () => {
  // 归一化：允许 `analytics.value?.keyUsage` 与 `analytics?.keyUsage` 两种写法。
  const normalized = requests.replace(/\.value/g, '')
  // 直接对可能为 undefined 的对象取属性链上的 .map / .length / [i] 才是事故本身。
  assert.doesNotMatch(normalized, /\.keyUsage\.(map|length|filter|slice|forEach)\b/)
  assert.doesNotMatch(normalized, /\.keyUsage\[/)
  // 用到 keyUsage 的地方必须先兜底成数组
  const reads = normalized.match(/\??\.keyUsage\b[^\n]*/g) ?? []
  for (const line of reads) assert.match(line, /\?\.keyUsage \?\? \[\]/, `keyUsage 必须以 \`?.keyUsage ?? []\` 读取：${line.trim()}`)
})

test('请求页签读的是 /api/analytics，不是 /api/usage-breakdown（D1 回归守卫）', () => {
  // 2026-10-01 的真实事故：误调 usageBreakdown 并断言成 AnalyticsData，两者除 days 外零字段重叠
  // → 41.6% 的错误率被渲染成「0.0% 健康稳定」。
  assert.match(requests, /api\.analytics<AnalyticsData>\(/)
  assert.doesNotMatch(requests, /api\.usageBreakdown/)
  // 类型与请求同源：AnalyticsData 的形状只能来自 /api/analytics。
  assert.match(requests, /import type \{[^}]*AnalyticsData[^}]*\} from '(\.\.\/)+types'/)
})

test('概览与请求页签各自取数，互不覆盖', () => {
  assert.doesNotMatch(overview, /api\.analytics\b/)
  assert.doesNotMatch(overview, /analytics\.value =/)
  assert.doesNotMatch(overview, /from '[^']*RequestsTab\.vue'/)
  // 概览若用 URL 筛选（days / keyId），筛选变化必须触发重取（否则筛选会静默失效——修过的真实缺陷）。
  for (const key of ['days', 'keyId']) {
    if (new RegExp(`scope\\.state\\.${key}\\b`).test(overview)) {
      assert.match(overview, new RegExp(`\\(\\) => scope\\.state\\.${key}`), `概览用了 ${key} 筛选却不随它重取`)
    }
  }
})
