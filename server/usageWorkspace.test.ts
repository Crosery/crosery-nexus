import './testDataDir.js'

import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import test from 'node:test'
import express from 'express'

import { db } from './db.js'
import type { ConsoleGroup } from './groups.js'
import type { ReadOperation } from './sqliteReadWorker.js'
import {
  loadAnalyticsReport,
  loadDashboardReport,
  loadUsageWorkspaceFacets,
  loadUsageWorkspaceOverview,
  loadUsageWorkspaceRequests,
  usageChannelId,
  usageWorkspaceWindow,
  type UsageWorkspaceFilter,
} from './usageReports.js'
import { parseUsageWorkspaceFilter, parseUsageWorkspaceRequestQuery, registerUsageWorkspaceRoutes, UsageFilterError } from './usageWorkspaceRoutes.js'

/**
 * 用量工作台的「同一筛选、同一个数」不变量（红队 P0 #3）：
 * - 账本 = 各排行合计 = 请求页签 summary = 筛选条合计 = 概览（dashboard）摘要 = 旧 analytics 摘要；
 * - 账本（rollup）与流水（事件表）用同一个整点窗口，开头不足一小时的事件两边都不算；
 * - 默认统计全部渠道（含已移除渠道的历史，如实进 scope.removed、排行标 removed）；「只看当前渠道」是显式筛选，
 *   此时那部分进 scope.excluded；
 * - 活跃 Key ≠ 已启用 Key；花费不拿 0 冒充「未定价」；热力图按配置时区切日；
 * - 流水里没有 `source`（兼容渠道的上游凭据）。
 */

const NOW = Date.parse('2026-10-01T12:20:00.000Z')
const HOUR = 3_600_000
const DAY = 24 * HOUR
const TZ = 'Asia/Shanghai'
const groups: ConsoleGroup[] = [
  { id: 'codex', name: 'Codex', color: '#000', kind: 'oauth', models: ['gpt-5.6-sol'] },
  { id: 'relay', name: 'Relay 中转', color: '#000', kind: 'compat', models: ['claude-opus-5', 'mystery-model'] },
]
const reader = {
  async run(operations: readonly ReadOperation[]) {
    return operations.map((op) => {
      const statement = db.prepare(op.sql)
      return op.method === 'get' ? statement.get(...(op.params ?? [])) : statement.all(...(op.params ?? []))
    })
  },
}

let seq = 0
type EventInput = {
  at: number
  key?: string | null
  provider?: string
  model?: string
  success?: boolean
  status?: number
  category?: string
  input?: number
  output?: number
  cached?: number
  cacheWrite?: number
  latency?: number
  client?: string
  cost?: number | null
  source?: string
}
function insertEvent(event: EventInput) {
  seq += 1
  const input = event.input ?? 1_000
  const output = event.output ?? 100
  const ok = event.success ?? true
  db.prepare(`INSERT INTO usage_events
    (request_id,timestamp,timestamp_ms,key_hash,provider,model,model_group,endpoint,success,status_code,latency_ms,ttft_ms,
     input_tokens,output_tokens,reasoning_tokens,cached_tokens,cache_write_tokens,total_tokens,user_agent,client_type,client_ip,
     error_detail,error_category,upstream_request_id,source,auth_index,cost_usd)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    `ws-${seq}`, new Date(event.at).toISOString(), event.at, event.key === undefined ? 'key-a' : event.key, event.provider ?? 'codex',
    event.model ?? 'gpt-5.6-sol', 'g', 'POST /v1/chat/completions', ok ? 1 : 0, event.status ?? (ok ? 200 : 429),
    event.latency ?? 1_000, 300, input, output, 0, event.cached ?? 0, event.cacheWrite ?? 0, input + output,
    'ua', event.client ?? 'codex-cli', '127.0.0.1', ok ? '' : 'boom', ok ? '' : (event.category ?? 'rate_limited'), `up-${seq}`,
    event.source ?? 'sk-upstream-secret-should-never-leave', 'auth-1', event.cost === undefined ? 0.01 : event.cost,
  )
}

const windowStart = usageWorkspaceWindow(7, NOW).fromMs
db.exec('DELETE FROM usage_events; DELETE FROM usage_hourly_rollup; DELETE FROM api_keys')
for (const [hash, name, enabled] of [['key-a', 'Alpha', 1], ['key-b', 'Beta', 1], ['key-c', 'Gamma idle', 1], ['key-d', 'Delta off', 0], ['key-e', 'Echo deleted', 1]] as const) {
  db.prepare(`INSERT INTO api_keys (key_hash,key_value,name,enabled,created_at,updated_at) VALUES (?,?,?,?,?,?)`)
    .run(hash, `value-${hash}`, name, enabled, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')
}
// 窗口开头不足一小时：rollup 的整点窗口不含它，事件表也必须不含它
insertEvent({ at: NOW - 7 * DAY + 5 * 60_000, key: 'key-b' })
insertEvent({ at: windowStart + 60_000, key: 'key-b', client: 'claude-code' })
insertEvent({ at: NOW - 2 * DAY, key: 'key-a' })
insertEvent({ at: NOW - 2 * DAY + 1, key: 'key-a', success: false, status: 429, category: 'rate_limited', input: 0, output: 0, cost: null })
insertEvent({ at: NOW - DAY, key: 'key-a', provider: 'openai-compatible-relay', model: 'claude-opus-5', cost: null, cached: 4_000, cacheWrite: 1_000 })
insertEvent({ at: NOW - DAY + 1, key: 'key-b', provider: 'relay', model: 'mystery-model', cost: null })
insertEvent({ at: NOW - DAY + 2, key: 'key-b', provider: 'relay', model: 'mystery-model', success: false, status: 503, category: 'upstream_5xx', cost: null })
insertEvent({ at: NOW - 3 * HOUR, key: 'key-e' })
insertEvent({ at: NOW - 3 * HOUR + 1, key: null })
// 已不在当前分组的渠道：不计入，但要如实报出来（兼容写法折叠成 `retired`）
insertEvent({ at: NOW - 2 * HOUR, key: 'key-a', provider: 'openai-compatible-retired' })
insertEvent({ at: NOW - 2 * HOUR + 1, key: 'key-c', provider: 'antigravity' })
// 上海时区 10/01 01:30 = UTC 09/30 17:30
insertEvent({ at: Date.parse('2026-09-30T17:30:00.000Z'), key: 'key-a' })
// 删掉 Key：事件的 key_hash 置空，rollup 仍留着旧 hash → 「已删除的 Key」
db.prepare('DELETE FROM api_keys WHERE key_hash = ?').run('key-e')

const ALL: UsageWorkspaceFilter = { days: 7, keyId: '', model: '', provider: '', client: '' }
const CURRENT: UsageWorkspaceFilter = { ...ALL, currentOnly: true }
const options = { timeZone: TZ, retentionDays: 90, now: NOW }
const sum = (rows: Array<{ requests: number }>) => rows.reduce((total, row) => total + row.requests, 0)

test('同一筛选下：账本 = 各排行合计 = 请求页签 = 筛选条 = 概览摘要 = 旧 analytics（两种渠道口径各自成立）', async () => {
  // 整点窗口里：开头那条不算；默认口径含两条已移除渠道的调用（11），只看当前渠道时不含（9）
  for (const [filter, expected] of [[ALL, 11], [CURRENT, 9]] as const) {
    const currentOnly = Boolean(filter.currentOnly)
    const overview = await loadUsageWorkspaceOverview(reader, groups, filter, options)
    const requests = await loadUsageWorkspaceRequests(reader, reader, groups, filter, { status: '', category: '', page: 1, pageSize: 100 }, options)
    const facets = await loadUsageWorkspaceFacets(reader, groups, filter, options)
    const dashboard = await loadDashboardReport(reader, groups, 7, '', NOW, currentOnly)
    const analytics = await loadAnalyticsReport(reader, groups, 7, '', NOW, currentOnly)

    assert.equal(overview.ledger.requests, expected)
    for (const ranks of [overview.keys, overview.models, overview.channels, overview.clients]) assert.equal(sum(ranks), overview.ledger.requests)
    assert.equal(requests.summary.requests, overview.ledger.requests)
    assert.equal(requests.total, overview.ledger.requests)
    assert.equal(requests.requests.length, overview.ledger.requests, '流水条数与账本一致（同一窗口起点）')
    assert.equal(facets.totals.requests, overview.ledger.requests)
    assert.equal((dashboard.summary as unknown as { requests: number }).requests, overview.ledger.requests)
    assert.equal((analytics.summary as { requests: number }).requests, overview.ledger.requests)
    assert.equal(overview.ledger.errors, 2)
    assert.equal(requests.summary.errors, 2)
    assert.equal(sum(overview.failures.map((item) => ({ requests: item.count }))), overview.ledger.errors)
  }
})

test('活跃 Key 是窗口内有调用且仍存在的 Key，与已启用数分开；已删除 / 无 Key 的流量单独成行', async () => {
  const overview = await loadUsageWorkspaceOverview(reader, groups, ALL, options)
  assert.equal(overview.ledger.activeKeys, 3, 'key-c 只走过已移除渠道：历史照算，它在窗口内是活跃的')
  assert.equal(overview.ledger.enabledKeys, 3)
  assert.equal(overview.ledger.totalKeys, 4)
  const dashboard = await loadDashboardReport(reader, groups, 7, '', NOW)
  assert.equal((dashboard.summary as { activeKeys: number }).activeKeys, overview.ledger.activeKeys)
  const labels = overview.keys.map((key) => key.label)
  assert.ok(labels.includes('已删除的 Key'))
  assert.ok(labels.includes('无 Key'))
  assert.ok(labels.includes('Gamma idle'))

  const current = await loadUsageWorkspaceOverview(reader, groups, CURRENT, options)
  assert.equal(current.ledger.activeKeys, 2)
  const currentDashboard = await loadDashboardReport(reader, groups, 7, '', NOW, true)
  assert.equal((currentDashboard.summary as { activeKeys: number }).activeKeys, current.ledger.activeKeys)
  assert.ok(!current.keys.map((key) => key.label).includes('Gamma idle'), '只看当前渠道时 key-c 不在口径里')
})

test('默认全部渠道：已移除渠道的历史计入，按折叠后的渠道 id 排行并标 removed；只看当前渠道时如实报出未计入', async () => {
  const overview = await loadUsageWorkspaceOverview(reader, groups, ALL, options)
  assert.equal(overview.scope.kind, 'all')
  assert.equal(overview.scope.removed.requests, 2)
  assert.deepEqual(overview.scope.removed.channels.map((item) => item.id).sort(), ['antigravity', 'retired'])
  assert.equal(overview.scope.excluded.requests, 0, '全部渠道口径下没有被排除的请求')
  assert.deepEqual(overview.channels.map((item) => [item.id, item.removed]).sort(), [['antigravity', true], ['codex', false], ['relay', false], ['retired', true]])
  assert.equal(usageChannelId('openai-compatible-relay', groups), 'relay')
  assert.equal(usageChannelId('OpenAI-Compatible-Retired ', groups), 'retired')
  // 筛选条：窗口内有调用的已移除渠道列在当前渠道之后，带 removed 标记
  const facets = await loadUsageWorkspaceFacets(reader, groups, ALL, options)
  assert.deepEqual(facets.channels.filter((item) => item.removed).map((item) => [item.value, item.count]).sort(), [['antigravity', 1], ['retired', 1]])
  // 选定已移除渠道：就是它自己的历史
  const retired = await loadUsageWorkspaceOverview(reader, groups, { ...ALL, provider: 'retired' }, options)
  assert.equal(retired.ledger.requests, 1)

  const current = await loadUsageWorkspaceOverview(reader, groups, CURRENT, options)
  assert.equal(current.scope.kind, 'current')
  assert.equal(current.scope.excluded.requests, 2)
  assert.deepEqual(current.scope.excluded.channels.map((item) => item.id).sort(), ['antigravity', 'retired'])
  assert.deepEqual(current.channels.map((item) => item.id).sort(), ['codex', 'relay'])
  const currentFacets = await loadUsageWorkspaceFacets(reader, groups, CURRENT, options)
  assert.ok(currentFacets.channels.every((item) => !item.removed))
  // 选定一个渠道时「已移除 / 已排除」不适用
  const relay = await loadUsageWorkspaceOverview(reader, groups, { ...CURRENT, provider: 'relay' }, options)
  assert.equal(relay.scope.excluded.requests, 0)
  assert.equal(relay.ledger.requests, 3)
})

test('筛选对账本与流水同时生效；筛选项计数不受自身约束', async () => {
  const filter = { ...ALL, provider: 'relay', model: 'mystery-model' }
  const overview = await loadUsageWorkspaceOverview(reader, groups, filter, options)
  const requests = await loadUsageWorkspaceRequests(reader, reader, groups, filter, { status: '', category: '', page: 1, pageSize: 50 }, options)
  assert.equal(overview.ledger.requests, 2)
  assert.equal(requests.requests.length, 2)
  assert.ok(requests.requests.every((row) => row.model === 'mystery-model' && row.channel === 'relay'))

  const facets = await loadUsageWorkspaceFacets(reader, groups, filter, options)
  assert.equal(facets.totals.requests, 2)
  // 模型计数只受渠道约束：relay 下有 claude-opus-5 与 mystery-model 两个
  assert.deepEqual(facets.models.map((item) => [item.value, item.count]).sort(), [['claude-opus-5', 1], ['mystery-model', 2]])
  // 渠道计数只受模型约束：所有当前渠道都列出，没有调用的计 0
  assert.deepEqual(facets.channels.map((item) => [item.value, item.count]).sort(), [['codex', 0], ['relay', 2]])
  assert.equal(facets.keys.length, 4, 'Key 列出全部 Key')

  const byClient = await loadUsageWorkspaceRequests(reader, reader, groups, { ...ALL, client: 'claude-code' }, { status: '', category: '', page: 1, pageSize: 50 }, options)
  assert.equal(byClient.total, 1)
  assert.equal(byClient.requests.length, 1)
})

test('状态与错误类别筛选：错误条计数 = 该类别的流水条数', async () => {
  const requests = await loadUsageWorkspaceRequests(reader, reader, groups, ALL, { status: '', category: 'upstream_5xx', page: 1, pageSize: 50 }, options)
  const strip = requests.errorCategories.find((item) => item.category === 'upstream_5xx')
  assert.equal(strip?.count, 1)
  assert.equal(requests.total, 1)
  assert.equal(requests.requests.length, 1)
  assert.equal(requests.requests[0].errorCategory, 'upstream_5xx')
  assert.equal(requests.query.status, 'error', '类别隐含「失败」')
  const ok = await loadUsageWorkspaceRequests(reader, reader, groups, ALL, { status: 'ok', category: '', page: 1, pageSize: 50 }, options)
  assert.equal(ok.total, 9)
  assert.ok(ok.requests.every((row) => row.success === 1))
  const paged = await loadUsageWorkspaceRequests(reader, reader, groups, ALL, { status: '', category: '', page: 2, pageSize: 20 }, options)
  assert.equal(paged.requests.length, 0)
  assert.equal(paged.total, 11)
})

test('看当日请求：day 把窗口换成那一天（配置时区），账本计数与流水一致', async () => {
  const overview = await loadUsageWorkspaceOverview(reader, groups, ALL, options)
  const day = overview.daily.find((item) => item.day === '2026-10-01')!
  const requests = await loadUsageWorkspaceRequests(reader, reader, groups, ALL, { status: '', category: '', day: '2026-10-01', page: 1, pageSize: 100 }, options)
  assert.equal(requests.total, day.requests)
  assert.equal(requests.requests.length, day.requests)
  assert.equal(requests.window.from, '2026-09-30T16:00:00.000Z')
  assert.ok(requests.requests.every((row) => row.timestampMs >= Date.parse('2026-09-30T16:00:00.000Z') && row.timestampMs < Date.parse('2026-10-01T16:00:00.000Z')))
})

test('花费：账本优先；没有单价的模型不拿 0 冒充，标为未定价', async () => {
  const overview = await loadUsageWorkspaceOverview(reader, groups, ALL, options)
  assert.equal(overview.ledger.hasPartialCost, true)
  assert.deepEqual(overview.ledger.unpricedModels, ['mystery-model'])
  assert.ok(overview.ledger.unpricedRequests >= 1)
  assert.ok(overview.ledger.costEstimated, 'claude-opus-5 没有账本，按单价估算（≈）')
  const mystery = overview.models.find((item) => item.id === 'mystery-model')
  assert.equal(mystery?.costUsd, null)
  const onlyUnpriced = await loadUsageWorkspaceOverview(reader, groups, { ...ALL, model: 'mystery-model' }, options)
  assert.equal(onlyUnpriced.ledger.costUsd, null)
  assert.ok(overview.ledger.cacheHitRate !== null && overview.ledger.cacheHitRate > 0, '有缓存活动的模型计入命中率')
  assert.ok(overview.ledger.cacheIdleModels >= 1)
})

test('热力图按配置时区切日，覆盖保留期，最早在前', async () => {
  const overview = await loadUsageWorkspaceOverview(reader, groups, ALL, options)
  assert.equal(overview.daily.length, 90)
  assert.equal(overview.daily.at(-1)?.day, '2026-10-01')
  const shanghaiDay = overview.daily.find((day) => day.day === '2026-10-01')
  assert.ok(shanghaiDay && shanghaiDay.requests >= 1, 'UTC 09/30 17:30 属于上海 10/01')
  assert.equal(sum(overview.daily.slice(-8)), sum(overview.daily))
  assert.ok(overview.daily.every((day, index) => index === 0 || overview.daily[index - 1].day < day.day))
  // 前一个等长窗口没有被数据覆盖（库里最早一条就在当前窗口附近）：没有可比基线
  assert.equal(overview.previous, null)
})

test('流水与旧 analytics 都不带 source（兼容渠道的上游凭据）', async () => {
  const requests = await loadUsageWorkspaceRequests(reader, reader, groups, ALL, { status: '', category: '', page: 1, pageSize: 50 }, options)
  const analytics = await loadAnalyticsReport(reader, groups, 7, '', NOW)
  const text = JSON.stringify([requests, analytics])
  assert.doesNotMatch(text, /sk-upstream-secret/)
  assert.ok(requests.requests.every((row) => !('source' in row)))
})

test('参数解析：窗口只认 24h/7d/30d/90d 且不超过保留期；控制字符与超长值拒绝', () => {
  assert.equal(parseUsageWorkspaceFilter({ days: '30' }, 90).days, 30)
  assert.equal(parseUsageWorkspaceFilter({ days: '13' }, 90).days, 7)
  assert.equal(parseUsageWorkspaceFilter({ days: '90' }, 30).days, 7)
  assert.equal(parseUsageWorkspaceFilter({}, 1).days, 1)
  assert.equal(parseUsageWorkspaceFilter({}, 90).currentOnly, false, '缺省 = 全部渠道')
  assert.equal(parseUsageWorkspaceFilter({ currentOnly: '1' }, 90).currentOnly, true)
  assert.equal(parseUsageWorkspaceFilter({ currentOnly: 'true' }, 90).currentOnly, true)
  assert.equal(parseUsageWorkspaceFilter({ currentOnly: 'yes' }, 90).currentOnly, false)
  assert.throws(() => parseUsageWorkspaceFilter({ model: 'a\u0000b' }, 90), UsageFilterError)
  assert.throws(() => parseUsageWorkspaceFilter({ keyId: 'x'.repeat(129) }, 90), UsageFilterError)
  assert.deepEqual(parseUsageWorkspaceRequestQuery({ status: 'error', category: 'nope', page: '0', pageSize: '7', day: '2026-13-45' }), { status: 'error', category: '', day: '', page: 1, pageSize: 50 })
  assert.deepEqual(parseUsageWorkspaceRequestQuery({ category: 'auth_failed', page: '3', pageSize: '20', day: '2026-10-01' }), { status: '', category: 'auth_failed', day: '2026-10-01', page: 3, pageSize: 20 })
})

test('路由：只有 view=workspace 由新处理器接；其余原样交给旧处理器；筛选非法 400', async () => {
  const app = express()
  registerUsageWorkspaceRoutes(app, {
    usageReader: reader,
    latencyReader: reader,
    reportingContext: async () => ({ groups, policyHash: 'test' }),
    retentionDays: 90,
    timeZone: TZ,
  })
  app.get('/api/usage-overview', (_req, res) => void res.json({ legacy: 'overview' }))
  app.get('/api/analytics', (_req, res) => void res.json({ legacy: 'analytics' }))
  const server = app.listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  try {
    assert.deepEqual(await (await fetch(`${base}/api/usage-overview?days=7`)).json(), { legacy: 'overview' })
    assert.deepEqual(await (await fetch(`${base}/api/analytics?days=7`)).json(), { legacy: 'analytics' })
    const overview = await (await fetch(`${base}/api/usage-overview?view=workspace&days=7`)).json() as { view: string; ledger: { requests: number } }
    assert.equal(overview.view, 'workspace')
    assert.equal(typeof overview.ledger.requests, 'number')
    const requests = await (await fetch(`${base}/api/analytics?view=workspace&days=7&status=error`)).json() as { view: string; query: { status: string } }
    assert.equal(requests.view, 'workspace')
    assert.equal(requests.query.status, 'error')
    const facets = await fetch(`${base}/api/usage-facets?days=30`)
    assert.equal(facets.status, 200)
    const bad = await fetch(`${base}/api/usage-facets?model=${encodeURIComponent('x\u0001')}`)
    assert.equal(bad.status, 400)
    assert.equal(((await bad.json()) as { code: string }).code, 'invalid_filter')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})
