import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

/**
 * 用量工作台（`src/features/usage/`）四个页签的取数不变量。v3 把 v2 的 Usage / Analytics / Cache / Charts
 * 四页收进一个工作台（`/usage` · `/usage/requests` · `/usage/cache` · `/usage/performance`），断言跟着文件走，
 * 盯的仍是原来四件事：
 * 1. 每个页签有专用 loader，竞态由序号守卫统一丢弃过期响应（`lib/resource.ts` 的 useResource 或
 *    `ui/composables/useLive.ts` 的 useLive —— 两者都在这里被钉住，页面换用哪个都受约束）。
 * 2. 取数只跟随 URL 派生的筛选（工作台共享 days / keyId / hours …），不把数据写回共享状态、不 import 别的页面。
 * 3. 总览页签只读一次 /api/usage-overview；性能页签真的请求 /api/usage-performance 并画出 trend。
 * 4. 共享筛选条（工作台 FilterBar）的目录来自响应，但选中值来自 URL（换 scope 不清空选择）。
 *
 * 明确不再断言的（v3 重设计后没有对应实现，不为绿灯保留假断言）：v2 的 `TxAlert type="info"`、
 * `<path :d="line"`、`v-for="m in topModels"` 这类具体标记；行为（未定价如实提示、趋势真的画出来）仍断言。
 */
const read = (file: string) => fs.readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8')
const app = read('App.vue')
const resource = read('lib/resource.ts')
const live = read('ui/composables/useLive.ts')
const workspace = read('features/usage/UsageWorkspace.vue')
const filters = read('features/usage/filters.ts')
const usage = read('features/usage/tabs/UsageOverviewTab.vue')
const performance = read('features/usage/tabs/PerformanceTab.vue')
const cache = read('features/usage/tabs/CacheTab.vue')
const requests = read('features/usage/tabs/RequestsTab.vue')
const insightModel = read('features/usage/tabs/insight/model.ts')
const insightApiSrc = read('features/usage/tabs/insight/api.ts')
const TABS = [['UsageOverviewTab', usage], ['RequestsTab', requests], ['CacheTab', cache], ['PerformanceTab', performance]] as const

const usesGuardedLoader = (source: string) => /\b(useResource|useLive)\s*(<[^>]*>)?\(/.test(source)

test('竞态守卫：useResource 与 useLive 都是「后发的请求赢」，刷新失败保留旧数据', () => {
  assert.match(resource, /const mine = \+\+seq/)
  assert.match(resource, /if \(mine === seq && !disposed\) \{\s*data\.value = result/)
  assert.match(resource, /if \(mine === seq && !disposed\) error\.value = err/)
  assert.doesNotMatch(resource, /data\.value = undefined/)
  assert.match(live, /const mine = \+\+seq/)
  assert.match(live, /if \(mine !== seq \|\| disposed\) return\s*data\.value = result/)
  assert.doesNotMatch(live, /data\.value = undefined/)
  for (const [name, source] of TABS) assert.ok(usesGuardedLoader(source), `${name} 必须经 useResource / useLive 取数（序号守卫）`)
})

test('每个页签只用自己的 loader，取数跟随 URL 派生的筛选，不 import 别的页面', () => {
  assert.match(usage, /api\.usageOverview<\w+>\(/)
  assert.match(requests, /api\.analytics<\w+>\(/)
  assert.match(cache, /insightApi\.cacheSummary\(scope\.value/)
  assert.match(performance, /insightApi\.performance\(scope\.value/)
  // 依赖驱动重取：筛选变化必须触发重取（否则筛选静默失效——修过的真实缺陷）
  for (const [name, source] of [['UsageOverviewTab', usage], ['RequestsTab', requests]] as const) {
    for (const key of ['days', 'keyId', 'model', 'provider', 'client']) {
      assert.match(source, new RegExp(`\\(\\) => scope\\.state\\.${key}`), `${name} 必须随 ${key} 重取`)
    }
  }
  // 缓存 / 性能：scope 只从 URL 派生，scopeQuery 覆盖全部共享筛选键，变化即重取
  for (const [name, source] of [['CacheTab', cache], ['PerformanceTab', performance]] as const) {
    assert.match(source, /const scope = computed\(\(\) => scopeFromQuery\(route\.query\)\)/, `${name} 的筛选必须来自 URL`)
    assert.match(source, /watch\(\(\) => scopeQuery\(scope\.value\)[\s\S]{0,80}live\.refresh\(\)/, `${name} 必须随筛选重取`)
  }
  assert.match(insightModel, /params\.set\('days', String\(scope\.days\)\)/)
  assert.match(insightModel, /for \(const key of \['keyId', 'model', 'client', 'provider'\] as const\)/)
  for (const [name, source] of TABS) {
    assert.doesNotMatch(source, /from '\.\.?\/[^']*(Tab|Page|Workspace)\.vue'/, `${name} 不应 import 其它页面`)
  }
})

test('工作台切页签只带共享筛选，不带页签私有状态（page / q / request）', () => {
  assert.match(workspace, /:to="\{ path: tab\.to, query: carried \}"/)
  assert.match(workspace, /sharedUsageQuery\(route\.query\)/)
  // currentOnly（只看当前渠道）是四个页签共享的口径筛选，切页签要带着走
  assert.match(filters, /SHARED_USAGE_KEYS = \['days', 'from', 'to', 'keyId', 'hours', 'model', 'client', 'provider', 'currentOnly'\]/)
  assert.doesNotMatch(filters, /'page'|'q'|'request'/)
})

test('总览页签只有一次 /api/usage-overview 读取，未定价如实提示', () => {
  const calls = usage.match(/api\.usage(Overview|Page|KeySummaries|Breakdown)/g) || []
  assert.deepEqual(calls, ['api.usageOverview'])
  assert.match(usage.slice(usage.indexOf('<template>')), /hasPartialCost/, '部分模型未定价时必须在模板里如实提示')
})

test('性能页签真的请求 /api/usage-performance 并把 trend 画出来（D3 回归守卫）', () => {
  assert.match(insightApiSrc, /\/api\/usage-performance\?/)
  assert.match(performance, /\.trend\b/)
  const template = performance.slice(performance.indexOf('<template>'))
  assert.doesNotMatch(template, /加载图表数据中/)
  assert.doesNotMatch(performance, /api\.chartsLatency/)
})

test('共享筛选条的目录来自响应，选中值来自 URL（换 scope 不清空选择）', () => {
  // v3：模型 / 客户端 / 渠道 / Key 的筛选从缓存页签收进工作台唯一的 FilterBar，四个页签共用
  // 读取前先快照 URL 筛选：回包的窗口要跟「问的是哪个窗口」比（90d 超保留期时改看 7d）
  assert.match(workspace, /const asked = filter\.value\n\s*const answer = await api\.facets\(asked, signal\)/)
  for (const [key, facet] of [['keyId', 'keys'], ['model', 'models'], ['provider', 'channels'], ['client', 'clients']]) {
    assert.match(workspace, new RegExp(`withSelected\\(data\\.value\\?\\.${facet} \\?\\? \\[\\], scope\\.state\\.${key},`), `${key} 的选项来自响应、选中值来自 URL`)
  }
  // 选中值不在当前目录里时仍保留（不因换 scope 清空）
  assert.match(workspace, /if \(selected && !items\.some\(\(o\) => o\.value === selected\)\) items\.unshift/)
  // 根组件仍挂着全局确认框宿主（危险操作统一走 confirm()）
  assert.match(app, /<ConfirmHost \/>/)
})
