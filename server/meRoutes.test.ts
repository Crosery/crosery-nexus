import './testDataDir.js'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import test from 'node:test'
import cookieParser from 'cookie-parser'
import express from 'express'

// config.ts 在模块求值时读取 SESSION_SECRET：先设环境，再动态导入。
process.env.SESSION_SECRET ||= 'me-routes-unit-secret'

const { config } = await import('./config.js')
const { calendarWindowStart, createMeRouter, gatewayBaseUrl, groupCost, localDayBounds, meModelView, utcIso } = await import('./meRoutes.js')
type CatalogModel = import('./modelCatalog.js').CatalogModel

const catalogModel = (overrides: Partial<CatalogModel> = {}): CatalogModel => ({
  id: 'claude-sonnet-5',
  providers: ['zz-internal-channel', 'claude'],
  context_length: 200_000,
  total_context_length: null,
  max_completion_tokens: 64_000,
  thinking: { levels: ['low', 'high'] },
  pricing: { from: '2026-01-01', input: 3, output: 15, cacheRead: 0.3, unit: 'token' },
  pricingSources: { 'models.dev': { input: 3, output: 15 }, openrouter: { input: 3.1, output: 15 } },
  availableOnGateway: true,
  priceHistory: [{ from: '2026-01-01', input: 3, output: 15, cacheRead: 0.3, note: 'internal note' }],
  ...overrides,
})

test('模型行只挑契约字段：渠道名、价格历史、来源原始报价都不出去', () => {
  const view = meModelView(catalogModel(), { requests: 3, tokens: 900 })
  assert.deepEqual(view, {
    id: 'claude-sonnet-5',
    name: null,
    family: null,
    contextWindow: 200_000,
    maxOutput: 64_000,
    reasoning: true,
    kind: 'chat',
    pricing: { inputPerM: 3, outputPerM: 15, cacheReadPerM: 0.3, cacheWritePerM: 3.75, source: 'models.dev' },
    used7d: { requests: 3, tokens: 900 },
  })
  assert.equal(meModelView(catalogModel({ id: 'gpt-image-2.5' }), null).kind, 'image', '类型与 /api/model-index 同一分类')
  const text = JSON.stringify(view)
  for (const leaked of ['zz-internal-channel', 'internal note', '3.1']) assert.ok(!text.includes(leaked), `不得出现 ${leaked}`)
})

test('模型行的未知值是 null：无定义的模型推理能力未知、无价即 null、来源对不上不猜', () => {
  const bare = meModelView(catalogModel({ providers: [], thinking: null, pricing: null, context_length: null, max_completion_tokens: null }), null)
  assert.equal(bare.reasoning, null)
  assert.equal(bare.pricing, null)
  assert.equal(bare.used7d, null)
  assert.equal(meModelView(catalogModel({ thinking: null }), null).reasoning, false, '有目录定义、没有 thinking ⇒ 明确不支持')
  const gatewayPriced = meModelView(catalogModel({ pricing: { from: '1970-01-01', input: 2, output: 8, cacheRead: 0.2, cacheWrite: 2.5, unit: 'token' } }), null)
  assert.deepEqual(gatewayPriced.pricing, { inputPerM: 2, outputPerM: 8, cacheReadPerM: 0.2, cacheWritePerM: 2.5, source: null })
})

test('网关地址：配置优先（缺 /v1 自动补），否则回退本机网关', () => {
  const original = config.publicGatewayBaseUrl
  try {
    config.publicGatewayBaseUrl = 'https://gateway.example.test/v1'
    assert.equal(gatewayBaseUrl(), 'https://gateway.example.test/v1')
    config.publicGatewayBaseUrl = 'https://gateway.example.test'
    assert.equal(gatewayBaseUrl(), 'https://gateway.example.test/v1')
    config.publicGatewayBaseUrl = ''
    assert.equal(gatewayBaseUrl(), `${config.cpaBaseUrl}/v1`)
  } finally {
    config.publicGatewayBaseUrl = original
  }
})

test('时间一律归一成 UTC ISO Z：偏移串、纳秒、无时区的 SQLite 时间、毫秒数；坏值给 null', () => {
  assert.equal(utcIso('2026-09-30T15:52:21.197744654-04:00'), '2026-09-30T19:52:21.197Z')
  assert.equal(utcIso('2026-09-30T15:52:21-04:00'), '2026-09-30T19:52:21.000Z')
  assert.equal(utcIso('2026-07-27T03:42:10.029563+00:00'), '2026-07-27T03:42:10.029Z')
  assert.equal(utcIso('2026-07-27 03:42:10'), '2026-07-27T03:42:10.000Z', '无时区按 UTC，不随服务器时区漂移')
  assert.equal(utcIso('2026-07-27T03:42'), '2026-07-27T03:42:00.000Z')
  assert.equal(utcIso('2026-10-02T06:00:00.000Z'), '2026-10-02T06:00:00.000Z')
  assert.equal(utcIso(Date.UTC(2026, 9, 2, 6)), '2026-10-02T06:00:00.000Z')
  assert.equal(utcIso(new Date(Date.UTC(2026, 9, 2, 6))), '2026-10-02T06:00:00.000Z')
  for (const bad of [null, undefined, '', 'not-a-date', 0, Number.NaN, new Date(Number.NaN)]) assert.equal(utcIso(bad), null, `坏值 ${String(bad)}`)
})

test('日历窗：days=1 是今天本地 00:00；days=7 再往前 6 个整天；整小时时区下落在整点', () => {
  const now = new Date(2026, 9, 2, 14, 32, 8)
  const today = new Date(2026, 9, 2).getTime()
  assert.equal(calendarWindowStart(1, now), today)
  assert.equal(calendarWindowStart(7, now), new Date(2026, 8, 26).getTime())
  assert.equal(calendarWindowStart(30, now), new Date(2026, 8, 3).getTime())
  assert.equal(calendarWindowStart(0, now), today, '非法天数按 1 天')
  if (new Date(today).getTimezoneOffset() % 60 === 0) assert.equal(calendarWindowStart(7, now) % 3_600_000, 0)
})

/* ────────────────── review-auth-isolation：缺价补价、当日下界、未配置标记（进程内，真库 + 真守卫） ────────────────── */

const auth = await import('./auth.js')
const { db } = await import('./db.js')
const { hashKey } = await import('./cpa.js')
const { applyGatewayPricing, priceRequest } = await import('./pricing.js')
const { keySessionState } = await import('./keySession.js')
type ReadOperation = import('./sqliteReadWorker.js').ReadOperation

/** 与生产同一接口的读库：直接在测试库上执行（生产是读 worker）。 */
const directReader = {
  async run(operations: readonly ReadOperation[]) {
    return operations.map(op => {
      const statement = db.prepare(op.sql)
      const params = (op.params ?? []) as Array<string | number | null>
      return op.method === 'all' ? statement.all(...params) : statement.get(...params)
    })
  },
}

const TIERED = 'zz-tiered-unit-model'
const UNPRICED = 'zz-unpriced-unit-model'
const UNIT_KEY = 'sk-me-routes-unit-0123456789abcdef0123456789ab'

async function meHarness(reader: { run(operations: readonly ReadOperation[]): Promise<unknown[]> } = directReader, keyValue = UNIT_KEY) {
  // 网关价补进来的分档模型：完整提示 > 272k 整单按高档计（与 gpt-5.x 的公开价卡同一规则）
  applyGatewayPricing(new Map([[TIERED, { from: '1970-01-01', input: 2, output: 8, cacheRead: 0.2, tiers: [{ above: 272_000, input: 4, output: 16, cacheRead: 0.4 }] }]]))
  auth.setKeySessionLookup(keySessionState)
  const app = express()
  app.use(cookieParser())
  app.use(auth.createSessionGuard(app))
  app.use('/api/me', createMeRouter({ usageReader: reader }))
  const server: Server = createServer(app)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  const cookie = `${auth.SESSION_COOKIE}=${auth.createSessionToken({ role: 'key', keyHash: hashKey(keyValue) })}`
  return {
    get: async <T>(path: string) => {
      const response = await fetch(`${base}${path}`, { headers: { cookie } })
      return { status: response.status, body: await response.json() as T }
    },
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  }
}

function seedUnitKey(): { times: number[]; ledger: number[] } {
  const now = new Date()
  const iso = now.toISOString()
  db.prepare(`INSERT OR REPLACE INTO api_keys (key_hash,key_value,name,note,enabled,groups_json,total_concurrency,group_concurrency_json,created_at,updated_at,quota_blocked_reason)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(hashKey(UNIT_KEY), UNIT_KEY, 'unit-me', '', 1, '[]', 4, '{}', iso, iso, '')
  const insert = db.prepare(`INSERT INTO usage_events
    (request_id,timestamp,timestamp_ms,key_hash,provider,model,model_group,endpoint,success,status_code,latency_ms,ttft_ms,
     input_tokens,output_tokens,reasoning_tokens,cached_tokens,cache_write_tokens,total_tokens,cost_usd)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  // 同一（日, 模型, provider）组：10 条已入账 + 1 条缺价（网关价丢失那段时间的样子），提示都 300k
  // 都在近 7 天窗口里（刚过 00:00 时落在昨天也一样被 days=7 覆盖）
  const base = now.getTime() - 60_000
  const times: number[] = []
  const ledger: number[] = []
  for (let i = 0; i < 11; i += 1) {
    const ms = base + i * 1000
    times.push(ms)
    const cost = i === 10 ? null : 2.46 + i / 100
    if (cost !== null) ledger.push(cost)
    insert.run(`unit-req-${i}`, new Date(ms).toISOString(), ms, hashKey(UNIT_KEY), 'openai-compatible-zz', TIERED, 'zz', '/v1/responses', 1, 200, 100, 10,
      300_000, 1_000, 0, 0, 0, 301_000, cost)
  }
  // 无价模型的一条缺价请求：如实计为未定价，不编数
  const unpricedAt = base + 11_000
  times.push(unpricedAt)
  insert.run('unit-req-unpriced', new Date(unpricedAt).toISOString(), unpricedAt, hashKey(UNIT_KEY), 'openai-compatible-zz', UNPRICED, 'zz', '/v1/responses', 1, 200, 100, 10,
    1_000, 100, 0, 0, 0, 1_100, null)
  return { times, ledger }
}

test('AI-03/AI-04 部分缺价的组：账本价保留，缺价请求按当时价 + 长上下文档逐条补；总花费 = 逐条花费之和 = 真值', async () => {
  const { times, ledger } = seedUnitKey()
  const harness = await meHarness()
  try {
    const truthMissing = priceRequest(TIERED, { newInputTokens: 300_000, outputTokens: 1_000, cacheReadTokens: 0, at: times[10] })!
    assert.ok(Math.abs(truthMissing - (300_000 * 4 + 1_000 * 16) / 1e6) < 1e-12, '对照：300k 提示落在高档')
    const truth = ledger.reduce((sum, cost) => sum + cost, 0) + truthMissing

    const usage = await harness.get<{ totals: { requests: number; costUsd: number | null; unpricedRequests: number }; models: Array<{ model: string; costUsd: number | null }>; daily: Array<{ estimatedCostUsd: number | null }> }>('/api/me/usage?days=7')
    assert.equal(usage.status, 200)
    assert.equal(usage.body.totals.requests, 12)
    // 修复前：整组按聚合 token、基础价重估（≈ $6.7），账本的 $25.05 被丢掉
    assert.ok(Math.abs((usage.body.totals.costUsd ?? NaN) - truth) < 1e-9, `总花费 ${usage.body.totals.costUsd} ≠ 真值 ${truth}`)
    assert.equal(usage.body.totals.unpricedRequests, 1, '无价模型那条计为未定价')
    assert.equal(usage.body.models.find(m => m.model === UNPRICED)?.costUsd, null)
    assert.ok(Math.abs(usage.body.daily.reduce((sum, day) => sum + (day.estimatedCostUsd ?? 0), 0) - truth) < 1e-9, '日格之和 = 总花费')

    const requests = await harness.get<{ items: Array<{ id: string; costUsd: number | null }> }>('/api/me/requests?limit=50')
    assert.equal(requests.status, 200)
    const missingRow = requests.body.items.find(item => item.id === 'unit-req-10')
    // 修复前：缺价那条不带提示长度估价，按基础价给 $0.608
    assert.ok(Math.abs((missingRow?.costUsd ?? NaN) - truthMissing) < 1e-12, `缺价请求按高档计：${missingRow?.costUsd}`)
    const sum = requests.body.items.reduce((total, item) => total + (item.costUsd ?? 0), 0)
    assert.ok(Math.abs(sum - (usage.body.totals.costUsd ?? NaN)) < 1e-9, '/me/usage 花费 = /me/requests 逐条花费之和')

    // AI-13：after 是含下界，before 是不含上界；坏值 400
    const window = await harness.get<{ items: Array<{ id: string }>; nextBefore: string | null }>(
      `/api/me/requests?limit=50&after=${encodeURIComponent(new Date(times[3]).toISOString())}&before=${encodeURIComponent(new Date(times[6]).toISOString())}`)
    assert.deepEqual(window.body.items.map(item => item.id), ['unit-req-5', 'unit-req-4', 'unit-req-3'])
    assert.equal(window.body.nextBefore, null, '翻到下界就停')
    const paged = await harness.get<{ items: Array<{ id: string }>; nextBefore: string | null }>(`/api/me/requests?limit=2&after=${encodeURIComponent(new Date(times[3]).toISOString())}&before=${encodeURIComponent(new Date(times[6]).toISOString())}`)
    assert.deepEqual(paged.body.items.map(item => item.id), ['unit-req-5', 'unit-req-4'])
    const rest = await harness.get<{ items: Array<{ id: string }>; nextBefore: string | null }>(`/api/me/requests?limit=2&after=${encodeURIComponent(new Date(times[3]).toISOString())}&before=${encodeURIComponent(paged.body.nextBefore!)}`)
    assert.deepEqual([rest.body.items.map(item => item.id), rest.body.nextBefore], [['unit-req-3'], null])
    const bad = await harness.get<{ code?: string }>('/api/me/requests?after=not-a-date')
    assert.deepEqual([bad.status, bad.body.code], [400, 'invalid_after'])

    // AI-17：没配公网地址时明说
    const original = config.publicGatewayBaseUrl
    try {
      config.publicGatewayBaseUrl = ''
      assert.equal((await harness.get<{ configured: boolean }>('/api/me/connect')).body.configured, false)
      config.publicGatewayBaseUrl = 'https://gateway.example.test'
      const configured = await harness.get<{ configured: boolean; baseUrl: string }>('/api/me/connect')
      assert.deepEqual([configured.body.configured, configured.body.baseUrl], [true, 'https://gateway.example.test/v1'])
    } finally {
      config.publicGatewayBaseUrl = original
    }
  } finally {
    auth.setKeySessionLookup(null)
    await harness.close()
  }
})

test('groupCost：账本完整用账本；部分缺价 = 账本 + 补价；明细对不上的差额计为未定价（不编数）', () => {
  const row = { bucket: 'd', model: 'm', provider: 'p', modelGroup: '', requests: 5, inputTokens: 0, uncachedInputTokens: 0, outputTokens: 0, cacheTokens: 0, cacheWriteTokens: 0, costSum: 3, costCount: 3 }
  assert.deepEqual(groupCost({ ...row, costCount: 5 }, new Map()), { cost: 3, unpriced: 0 })
  assert.deepEqual(groupCost(row, new Map([['d\u0000m\u0000p', { cost: 1.5, priced: 2, unpriced: 0 }]])), { cost: 4.5, unpriced: 0 })
  assert.deepEqual(groupCost(row, new Map([['d\u0000m\u0000p', { cost: 0.5, priced: 1, unpriced: 1 }]])), { cost: 3.5, unpriced: 1 })
  assert.deepEqual(groupCost(row, new Map()), { cost: 3, unpriced: 2 }, '明细里没捞到的缺价请求按未定价计')
  assert.deepEqual(groupCost({ ...row, costSum: 0, costCount: 0 }, new Map([['d\u0000m\u0000p', { cost: 0, priced: 0, unpriced: 5 }]])), { cost: null, unpriced: 5 })
})

test('两次读之间新到的缺价请求：不在汇总快照里，也不进补价（花费不会比请求数多算一条）', async () => {
  const RACE_KEY = 'sk-me-routes-race-0123456789abcdef0123456789ab'
  const iso = new Date().toISOString()
  db.prepare(`INSERT OR REPLACE INTO api_keys (key_hash,key_value,name,note,enabled,groups_json,total_concurrency,group_concurrency_json,created_at,updated_at,quota_blocked_reason)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(hashKey(RACE_KEY), RACE_KEY, 'race-me', '', 1, '[]', 4, '{}', iso, iso, '')
  const insert = db.prepare(`INSERT INTO usage_events
    (request_id,timestamp,timestamp_ms,key_hash,provider,model,model_group,endpoint,success,status_code,latency_ms,ttft_ms,
     input_tokens,output_tokens,reasoning_tokens,cached_tokens,cache_write_tokens,total_tokens,cost_usd)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  const event = (id: string, ms: number, cost: number | null) => insert.run(id, new Date(ms).toISOString(), ms, hashKey(RACE_KEY), 'openai-compatible-zz', TIERED, 'zz', '/v1/responses', 1, 200, 100, 10,
    300_000, 1_000, 0, 0, 0, 301_000, cost)
  const base = Date.now() - 10_000
  event('race-ledger', base, 25)
  event('race-null-0', base + 1_000, null)
  // 汇总读完、补价读之前写进来一条缺价请求（同组）：读库模拟这两次读之间的写入
  let arrivals = 0
  let armed = true // 只在第一次汇总读之后插一条
  const racingReader = {
    async run(operations: readonly ReadOperation[]) {
      const result = await directReader.run(operations)
      if (armed && operations.some(op => op.sql.includes('usage_hourly_rollup') && op.sql.includes('costCount'))) {
        armed = false
        arrivals += 1
        event(`race-late-${arrivals}`, base + 1_000 + arrivals * 1_000, null)
      }
      return result
    },
  }
  const harness = await meHarness(racingReader, RACE_KEY)
  try {
    const perMissing = priceRequest(TIERED, { newInputTokens: 300_000, outputTokens: 1_000, cacheReadTokens: 0, at: base })!
    const usage = await harness.get<{ totals: { requests: number; costUsd: number | null; unpricedRequests: number }; daily: Array<{ day: string; startsAt?: string; endsAt?: string }> }>('/api/me/usage?days=7')
    assert.equal(usage.status, 200)
    assert.ok(usage.body.daily.length === 7 && usage.body.daily.every(d => d.startsAt === localDayBounds(d.day).startsAt && d.endsAt === localDayBounds(d.day).endsAt), '逐日带服务器日历的 [起, 止)')
    assert.equal(arrivals, 1, '确实在两次读之间写进了一条')
    assert.equal(usage.body.totals.requests, 2, '汇总快照里只有两条')
    assert.ok(Math.abs((usage.body.totals.costUsd ?? NaN) - (25 + perMissing)) < 1e-9, `花费 ${usage.body.totals.costUsd} 只含快照里的两条`)
    assert.equal(usage.body.totals.unpricedRequests, 0)

    // /api/me 的 today 走同一个 loadMissingCosts（快照 MAX(id) 同一常量）；它要额度读库 worker，进程内测不了，端到端见 meIsolation
  } finally {
    auth.setKeySessionLookup(null)
    await harness.close()
  }
})

test('逐日 [起, 止)：按服务器本地日历，夏令时那天 23 小时（不是固定偏移 + 24h）', () => {
  const original = process.env.TZ
  try {
    process.env.TZ = 'America/New_York'
    assert.deepEqual(localDayBounds('2026-03-08'), { startsAt: '2026-03-08T05:00:00.000Z', endsAt: '2026-03-09T04:00:00.000Z' })
    process.env.TZ = 'Asia/Shanghai'
    assert.deepEqual(localDayBounds('2026-10-01'), { startsAt: '2026-09-30T16:00:00.000Z', endsAt: '2026-10-01T16:00:00.000Z' })
    assert.deepEqual(localDayBounds('2026-10'), { startsAt: null, endsAt: null })
  } finally {
    if (original === undefined) delete process.env.TZ
    else process.env.TZ = original
  }
})
