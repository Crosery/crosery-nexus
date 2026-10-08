import assert from 'node:assert/strict'
import test from 'node:test'
import { request } from '../src/api/http.js'
import { JOB_SOURCE } from '../src/features/settings/settingsModel.js'
import { USAGE_FILTER_DEFAULTS, usageFilterFrom } from '../src/features/usage/filters.js'
import { scopeFromQuery } from '../src/features/usage/tabs/insight/model.js'
import { sampleUsage, startContractCpa } from './testing/contractFixture.js'
import { launchConsole } from './testing/consoleProcess.js'
import { createShapeChecker } from './testing/typeShape.js'

/**
 * 前后端响应契约（phase 4）：主要页面依赖的接口，经**前端自己的客户端**（`src/api/*`、各页面的 api 模块，
 * 原样的路径、方法与查询参数）打到真实的 `server/index.ts`（CPA 模式 + 假 CPA + 采集进库的几条用量），
 * 再把响应按前端声明的 TS 类型逐字段校验（`testing/typeShape.ts` 读的就是页面编译用的那份类型）。
 * 前端类型里必填、服务端却没发的字段 → 红；改名、类型不符、超出字面量枚举 → 红。
 * 关键数组先断言非空，保证元素形状真的被校验过，而不是空数组顺手通过。
 */

const REPO = new URL('../', import.meta.url).pathname
/**
 * The page clients load at run time: their extensionless imports do not compile in the server's NodeNext
 * program (see navRoutes.test.ts), so they stay out of `tsc` and are typed loosely here.
 */
const client = (file: string): Promise<any> => import(new URL(`../src/${file}`, import.meta.url).href)
const { api } = await client('api/index.ts')
const { fetchChannelHealth } = await client('features/channels/channelsApi.ts')
const { fetchActivity } = await client('features/keys/keysApi.ts')
const { api: usageApi } = await client('features/usage/shared/api.ts')
const { insightApi } = await client('features/usage/tabs/insight/api.ts')
const TYPES = 'src/types.ts'
const INSIGHT = 'src/features/usage/tabs/insight/model.ts'
const shapes = createShapeChecker(REPO, [
  TYPES,
  'src/features/channels/channelModel.ts',
  'src/features/help/HelpPage.vue',
  'src/features/keys/keysModel.ts',
  'src/features/me/meModel.ts',
  'src/features/models/modelRows.ts',
  'src/features/overview/model.ts',
  'src/features/overview/types.ts',
  'src/features/usage/shared/types.ts',
  INSIGHT,
  'server/releaseInfo.ts',
])

const cpa = await startContractCpa()
const app = await launchConsole({ CPA_BASE_URL: cpa.base, CPA_MANAGEMENT_KEY: cpa.key, USAGE_COLLECT_INTERVAL_MS: '250' })
  .catch(async (error: unknown) => { await cpa.stop(); throw error })

// 前端客户端发相对地址：在这里补上控制台地址与当前会话的 Cookie。
let cookie = app.adminCookie
const realFetch = globalThis.fetch
globalThis.fetch = ((input: string | URL | Request, init: RequestInit = {}) => {
  if (typeof input !== 'string' || !input.startsWith('/')) return realFetch(input, init)
  return realFetch(`${app.base}${input}`, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), ...(cookie ? { cookie } : {}) } })
}) as typeof fetch
const teardown = async () => {
  globalThis.fetch = realFetch
  await app.stop()
  await cpa.stop()
}
test.after(teardown)

/** 一把真 Key 与它的三条用量（两条成功、一条 429），等采集器落库后各页面才有可校验的元素。 */
async function seed() {
  const apiKey = await app.createKey('contract-shape-key')
  const keyCookie = await app.loginKey(apiKey)
  cpa.usageQueue.push(...sampleUsage(apiKey))
  const deadline = Date.now() + 15_000
  for (;;) {
    const page = await app.send('GET', '/api/me/requests?limit=10', { cookie: keyCookie })
    if (page.status === 200 && page.body.items.length >= 3) return keyCookie
    if (Date.now() > deadline) throw new Error(`usage was not collected: ${page.status} ${page.text.slice(0, 200)}\n${app.log().slice(-800)}`)
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}
const keyCookie = await seed().catch(async (error: unknown) => { await teardown(); throw error })

function fits(file: string, type: string, value: unknown) {
  const issues = shapes.check(file, type, value)
  assert.deepEqual(issues, [], `${type} 与服务端响应不一致：\n  ${issues.slice(0, 20).join('\n  ')}`)
}

function nonEmpty(value: unknown, label: string) {
  assert.ok(Array.isArray(value) && value.length > 0, `${label} 应当有数据（否则元素形状没被校验）：${JSON.stringify(value)?.slice(0, 200)}`)
}

const workspaceFilter = usageFilterFrom({ ...USAGE_FILTER_DEFAULTS })

test('管理员会话：主要页面的读接口与前端类型一致', async (t) => {
  cookie = app.adminCookie

  await t.test('会话 /api/session → SessionInfo', async () => {
    const session = await api.session()
    fits(TYPES, 'SessionInfo', session)
    assert.deepEqual([session.authenticated, session.authenticated && session.role], [true, 'admin'])
  })

  await t.test('Key 页 /api/bootstrap → BootstrapData，/api/keys/activity → KeysActivityPayload', async () => {
    const boot = await api.bootstrap()
    nonEmpty(boot.keys, 'bootstrap.keys')
    nonEmpty(boot.groups, 'bootstrap.groups')
    fits(TYPES, 'BootstrapData', boot)
    const activity = await fetchActivity()
    fits('src/features/keys/keysModel.ts', 'KeysActivityPayload', activity)
  })

  await t.test('供应商页 /api/channels → ChannelsData，/api/channel-health → ChannelHealthPayload，/api/monitor → MonitorData', async () => {
    const channels = await api.channels()
    nonEmpty(channels.channels, 'channels.channels')
    nonEmpty(channels.credentials, 'channels.credentials')
    fits(TYPES, 'ChannelsData', channels)
    const health = await fetchChannelHealth('24')
    assert.equal(health.available, true)
    if (health.available) {
      nonEmpty(health.payload.channels, 'channel-health.channels')
      fits('src/features/channels/channelModel.ts', 'ChannelHealthPayload', health.payload)
    }
    const monitor = await api.monitor()
    nonEmpty(monitor.accounts, 'monitor.accounts')
    fits(TYPES, 'MonitorData', monitor)
  })

  await t.test('账号 /api/accounts → AccountsData，/api/accounts/catalog → AccountsCatalog', async () => {
    fits(TYPES, 'AccountsData', await api.accounts.list())
    const catalog = await api.accounts.catalog()
    fits(TYPES, 'AccountsCatalog', catalog)
  })

  await t.test('模型页 /api/model-index、/api/usage-overview、/api/models/insights', async () => {
    const index = await request<{ models: unknown[] }>('/api/model-index')
    nonEmpty(index.models, 'model-index.models')
    fits(TYPES, 'ModelIndexData', index)
    const usage = await request<{ models: unknown[] }>('/api/usage-overview?days=7')
    nonEmpty(usage.models, 'usage-overview.models')
    fits(TYPES, 'UsageOverviewData', usage)
    fits('src/features/models/modelRows.ts', 'ModelInsights', await request('/api/models/insights?days=7'))
  })

  await t.test('同步中心 /api/sync/status → SyncStatus，含 model-availability / cpa-catalog / price-watch', async () => {
    const status = await api.sync.status()
    fits(TYPES, 'SyncStatus', status)
    for (const id of ['model-availability', 'cpa-catalog', 'price-watch']) {
      const job = status.jobs.find((entry: { id: string }) => entry.id === id)
      assert.ok(job, `同步状态里缺 ${id}（现有：${status.jobs.map((entry: { id: string }) => entry.id).join(', ')}）`)
      assert.ok(JOB_SOURCE[id], `设置页 JOB_SOURCE 没有 ${id} 的来源说明`)
    }
  })

  await t.test('用量工作台 view=workspace：总览、请求、筛选项、热力图', async () => {
    const overview = await usageApi.usageOverview(workspaceFilter)
    fits('src/features/usage/shared/types.ts', 'UsageOverviewData', overview)
    const requests = await usageApi.analytics(workspaceFilter, { status: '', category: '', day: '', page: 1, pageSize: 50 })
    nonEmpty(requests.requests, 'analytics.requests')
    fits('src/features/usage/shared/types.ts', 'UsageRequestsData', requests)
    fits('src/features/usage/shared/types.ts', 'UsageFacetsData', await usageApi.facets(workspaceFilter))
    fits('src/features/usage/shared/types.ts', 'UsageDailyData', await usageApi.daily(workspaceFilter, 'recent'))
  })

  await t.test('查询参数：前端发的筛选条件服务端都读到了（非默认值，改名会被忽略而失配）', async () => {
    const filter = (state: Record<string, string> = {}) => usageFilterFrom({ ...USAGE_FILTER_DEFAULTS, ...state })
    const all = await usageApi.facets(filter())
    assert.equal(all.totals.requests, 3)
    for (const [dimension, param] of [['keys', 'keyId'], ['models', 'model'], ['channels', 'provider'], ['clients', 'client']] as const) {
      const option = all[dimension].find((entry: { count: number }) => entry.count > 0 && entry.count < all.totals.requests) ?? all[dimension][0]
      assert.ok(option, `筛选项 ${dimension} 为空`)
      const narrowed = await usageApi.facets(filter({ [param]: option.value }))
      assert.equal(narrowed.totals.requests, option.count, `${param}=${option.value}`)
    }
    assert.equal((await usageApi.facets(filter({ days: '30' }))).window.days, 30, 'days')
    assert.equal((await usageApi.facets(filter({ currentOnly: '1' }))).scope.kind, 'current', 'currentOnly')
    const failed = await usageApi.analytics(filter(), { status: 'error', category: '', day: '', page: 1, pageSize: 50 })
    assert.deepEqual([failed.query.status, failed.total], ['error', 1], 'status')
    const health = await fetchChannelHealth('3')
    assert.equal(health.available && health.payload.hours, 3, 'hours')
    assert.equal((await request<{ range: string }>('/api/overview?range=1h')).range, '1h', 'range')
  })

  await t.test('用量 缓存 / 性能 页签 /api/cache-summary → CacheSummary，/api/usage-performance → PerformanceReport', async () => {
    const scope = scopeFromQuery({})
    fits(INSIGHT, 'CacheSummary', await insightApi.cacheSummary(scope))
    fits(INSIGHT, 'PerformanceReport', await insightApi.performance(scope))
  })

  await t.test('概览：/api/overview、/api/pulse 与 24 小时账本（dashboard / charts / cache-trend / cache-summary）', async () => {
    const overview = await request<{ channels: { rows: unknown[] } }>('/api/overview?range=24h')
    nonEmpty(overview.channels.rows, 'overview.channels.rows')
    fits('src/features/overview/types.ts', 'OverviewPayload', overview)
    fits(TYPES, 'PulseData', await api.pulse())
    const dashboard = await api.dashboard(1)
    nonEmpty(dashboard.trend, 'dashboard.trend')
    fits(TYPES, 'DashboardData', dashboard)
    fits(TYPES, 'ChartsData', await api.charts(1))
    fits(TYPES, 'CacheTrendData', await api.cacheTrend(24))
    fits('src/features/overview/model.ts', 'CacheSummaryLike', await request('/api/cache-summary?days=1'))
  })

  await t.test('帮助与设置：/api/connect → ConnectInfo（页面内类型），版本、网关功能、内核、RTK 全局、自动更新、Magpie 更新状态', async () => {
    fits('src/features/help/HelpPage.vue', 'ConnectInfo', await request('/api/connect'))
    fits(TYPES, 'VersionsData', await api.version())
    fits(TYPES, 'GatewaySettings', await api.gatewaySettings())
    fits(TYPES, 'KernelsView', await api.kernels.get())
    fits(TYPES, 'RtkGlobalStatus', await api.rtkGlobal.get())
    fits(TYPES, 'AutoupdateView', await api.autoupdate.get())
    fits(TYPES, 'MagpieUpdateStatus', await api.getMagpieUpdateStatus())
  })

  await t.test('代理：/api/proxies、options、accounts、egress（只读本机状态）', async () => {
    fits(TYPES, 'ProxyPoolData', await api.proxies.pool())
    fits(TYPES, 'ProxyOptionsData', await api.proxies.options())
    const accounts = await api.proxies.accounts()
    nonEmpty(accounts.accounts, 'proxies.accounts.accounts')
    fits(TYPES, 'ProxyAccountsData', accounts)
    fits(TYPES, 'EgressData', await api.proxies.egress())
  })
})

test('key 会话：/api/me* 与前端类型一致', async (t) => {
  cookie = keyCookie
  t.after(() => { cookie = app.adminCookie })

  await t.test('会话 → SessionInfo（role=key）', async () => {
    const session = await api.session()
    fits(TYPES, 'SessionInfo', session)
    assert.equal(session.authenticated && session.role, 'key')
  })
  await t.test('/api/me → MeOverview', async () => fits(TYPES, 'MeOverview', await api.me.overview()))
  await t.test('/api/me/usage → MeUsage', async () => {
    fits(TYPES, 'MeUsage', await api.me.usage(7))
    assert.equal((await api.me.usage(30)).days, 30, 'days')
  })
  await t.test('/api/me/usage/daily → MeUsageDaily', async () => fits(TYPES, 'MeUsageDaily', await api.me.usageDaily()))
  await t.test('/api/me/requests → MeRequestsPage', async () => {
    const page = await api.me.requests({ limit: 50 })
    nonEmpty(page.items, 'me.requests.items')
    fits(TYPES, 'MeRequestsPage', page)
    const failed = await api.me.requests({ limit: 50, status: 'error' })
    assert.deepEqual(failed.items.map((item: { status: number }) => item.status), [429], 'status=error')
  })
  await t.test('/api/me/models → MeModels', async () => {
    const models = await api.me.models()
    nonEmpty(models.models, 'me.models.models')
    fits(TYPES, 'MeModels', models)
  })
  await t.test('/api/me/connect → MeConnectX', async () => fits('src/features/me/meModel.ts', 'MeConnectX', await api.me.connect()))
})

test('公开 /api/public/release → PublicRelease（发布脚本按它确认线上提交）', async () => {
  cookie = ''
  try {
    const release = await request<Record<string, unknown>>('/api/public/release')
    fits('server/releaseInfo.ts', 'PublicRelease', release)
  } finally {
    cookie = app.adminCookie
  }
})
