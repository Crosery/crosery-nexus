import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

/**
 * 这一组曾经断言 React 死树（`src/App.tsx` / `pages/ChartsPage.tsx` / `pages/CachePage.tsx`）。
 * 死树已删除（task-17），活代码是 `.vue` + `src/lib/resource.ts`，所以改为**对活代码的等价断言**：
 * 原来盯的四件事——「专用 loader + 竞态守卫」「跨 scope 不串数据」「按顺序取数」「图表/筛选不被空列表打断」——
 * 在 Vue 树里分别落到 `useResource` 的序号守卫、页面的 `api.*` 调用与 URL 派生依赖上。
 *
 * 明确删掉的断言（在 Vue 树上已无意义，不为绿灯保留假断言）：
 * - React 版「usage 先渲染 core 再后台合并 key summaries」：Vue 版只有一次 `api.usageOverview`，
 *   不存在两段式合并，该断言没有对应实现。
 * - React 版「charts 先取 core 再取 latency」：Vue 版只请求 `/api/charts`，
 *   `api.chartsLatency` 在活代码里零调用（见下面对它的反向断言）。
 * - React 版「recharts 系列 `isAnimationActive={false}`」：活代码不用 recharts，
 *   图表是 SVG/CSS，动画由 `styles/theme.css` 的 `prefers-reduced-motion` 统一处理。
 */
const app = fs.readFileSync(new URL('../src/App.vue', import.meta.url), 'utf8')
const resource = fs.readFileSync(new URL('../src/lib/resource.ts', import.meta.url), 'utf8')
const usage = fs.readFileSync(new URL('../src/pages/UsagePage.vue', import.meta.url), 'utf8')
const charts = fs.readFileSync(new URL('../src/pages/ChartsPage.vue', import.meta.url), 'utf8')
const cache = fs.readFileSync(new URL('../src/pages/CachePage.vue', import.meta.url), 'utf8')

test('report 页面用专用 loader，竞态由 useResource 的序号守卫统一丢弃过期响应', () => {
  assert.match(usage, /api\.usageOverview<UsagePageData>/)
  assert.match(charts, /api\.charts<ChartsData>\(days\.value, scope\.state\.keyId\)/)
  assert.match(cache, /api\.cacheTrend<CacheTrendData>/)
  // 竞态守卫：后发的请求赢，先发的过期响应被丢弃（React 版每个 loader 各写一份 request ref）。
  assert.match(resource, /const mine = \+\+seq/)
  assert.match(resource, /if \(mine === seq && !disposed\) \{\s*data\.value = result/)
  assert.match(resource, /if \(mine === seq && !disposed\) error\.value = err/)
  // 刷新时保留旧数据：成功前不碰 data，页面不闪空。
  assert.doesNotMatch(resource, /data\.value = undefined/)
})

test('report 页面的取数只跟随 URL 派生的 scope，不把数据写回共享状态', () => {
  assert.match(usage, /\[\(\) => scope\.state\.days, \(\) => scope\.state\.keyId\]/)
  assert.match(cache, /\[\(\) => scope\.state\.hours, \(\) => scope\.state\.model, \(\) => scope\.state\.client, \(\) => scope\.state\.keyId, \(\) => scope\.state\.provider\]/)
  assert.match(charts, /\[\(\) => scope\.state\.days, \(\) => scope\.state\.keyId\]/)
  // 页面之间不共享可变数据：每个页面自持 useResource 结果，不 import 别的页面的状态。
  for (const [name, source] of [['UsagePage', usage], ['ChartsPage', charts], ['CachePage', cache]]) {
    assert.doesNotMatch(source, /from '\.\/(Analytics|Dashboard|Keys|Models)Page\.vue'/, `${name} 不应 import 其它页面`)
  }
})

test('usage 页只有一次 /api/usage-overview 读取（不再有两段式 core+summaries 合并）', () => {
  const calls = usage.match(/api\.usage(Overview|Page|KeySummaries|Breakdown)/g) || []
  assert.deepEqual(calls, ['api.usageOverview'])
  // 未定价告警仍然如实渲染（原来用 TxAlert variant，Tuffex 不认这个 prop → 正文没渲染，本轮修掉）。
  assert.match(usage, /v-if="data\?\.hasPartialCost"/)
  assert.match(usage, /type="info"/)
})

test('charts 页真的请求 /api/charts 并把 trend 画出来（D3 回归守卫）', () => {
  assert.match(charts, /const trend = computed\(\(\) => charts\.value\?\.trend \?\? \[\]\)/)
  assert.match(charts, /<path :d="line"/)
  assert.match(charts, /v-for="m in topModels"/)
  // 曾经 18 行的占位组件：永不请求、永久显示「加载图表数据中」。
  // 只在模板里断言，避免把脚本注释里的这句历史说明当成缺陷。
  const template = charts.slice(charts.indexOf('<template>'))
  assert.doesNotMatch(template, /加载图表数据中/)
  // 活代码不再使用 chartsLatency（React 死树才用它做第二段读取）。
  assert.doesNotMatch(charts, /api\.chartsLatency/)
})

test('cache 筛选依赖响应里的目录但保留当前选中值（换 scope 不清空选择）', () => {
  assert.match(cache, /const internalModels = computed\(\(\) => internalTrend\.value\?\.models \?\? \[\]\)/)
  assert.match(cache, /const internalClients = computed\(\(\) => internalTrend\.value\?\.clients \?\? \[\]\)/)
  // 选中值来自 URL，不来自目录：目录还在加载时选择不会被重置。
  assert.match(cache, /:model-value="scope\.state\.model"/)
  assert.match(cache, /:model-value="scope\.state\.client"/)
  assert.match(cache, /:model-value="scope\.state\.provider"/)
  // 页面根部仍挂着全局确认框宿主（危险操作统一走 confirm()）。
  assert.match(app, /<ConfirmHost \/>/)
})
