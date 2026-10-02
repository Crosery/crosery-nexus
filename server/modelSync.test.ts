import './testDataDir.js'

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { testDataDir } from './testDataDir.js'
import { config } from './config.js'
import { db } from './db.js'
import {
  applyAdditions, catalogModelsHash, cpaSyncChannel, discoveryBackoff, DISCOVERY_POLICY, nextDiscoveryAt, parseRetryAfter, readDisabledModels, readSharedCatalog, UNKNOWN_PROXY,
  resolveCatalogTarget, sanitizeDiscoveryState, sharedCatalogPath, syncUpstreamModels,
  type ChannelStore, type DiscoveryState, type ModelSyncDeps, type SharedCatalog, type SyncChannel,
} from './modelSync.js'

test('shared catalog reader correctly accesses ~/.agents/crosery/catalog.json if present', () => {
  const p = sharedCatalogPath()
  assert.ok(p.includes('catalog.json'))

  const catalog = readSharedCatalog()
  if (catalog) {
    assert.equal(catalog.version, 1)
    assert.equal(catalog.provider, 'crosery')
    assert.ok(Array.isArray(catalog.models))
    assert.ok(catalog.models.length > 0)
    assert.ok(catalog.models.some(m => m.id.includes('claude') || m.id.includes('gpt')))
  }
})

test('syncUpstreamModels runs and returns structured sync result', async () => {
  const result = await syncUpstreamModels({ force: true, state: {}, deps: { store: memoryStore([]).store, readCatalog: () => null } })
  assert.ok(result)
  assert.ok(Array.isArray(result.addedModels))
  assert.ok(typeof result.totalModels === 'number')
  assert.ok(typeof result.channelCount === 'number')
  assert.ok(typeof result.syncedAt === 'string')
})

/* ────────────────────────── 夹具 ────────────────────────── */

const channel = (name: string, baseUrl: string, keyRef: string | undefined, models: string[] = [], disabled = false): SyncChannel => ({
  name, baseUrl, keyRef, disabled, models: models.map(model => ({ name: model })),
})

function memoryStore(initial: SyncChannel[]) {
  let channels = structuredClone(initial)
  let writes = 0
  const store: ChannelStore = {
    read: async () => structuredClone(channels),
    commit: async (additions, guard) => {
      const result = applyAdditions(channels, additions, undefined, guard?.blocked?.())
      if (result.added.length) writes += 1
      return result
    },
  }
  return { store, get channels() { return channels }, set channels(value: SyncChannel[]) { channels = value }, get writes() { return writes } }
}

type FetchCall = { url: string; authorization: string | null; headers: Headers }

function fakeFetch(handler: (url: string, headers: Headers) => Response | Promise<Response>) {
  const calls: FetchCall[] = []
  const fetch = async (input: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    calls.push({ url: input, authorization: headers.get('authorization'), headers })
    return handler(input, headers)
  }
  return { fetch, calls }
}

const modelsResponse = (...ids: string[]) => new Response(JSON.stringify({ data: ids.map(id => ({ id })) }), { status: 200, headers: { 'content-type': 'application/json' } })

function deps(overrides: ModelSyncDeps & { clock?: { now: number } }): ModelSyncDeps {
  const clock = overrides.clock ?? { now: 10_000_000 }
  return {
    now: () => clock.now,
    random: () => 0.5,
    resolveCredential: async (reference) => {
      if (reference === 'env:GOOD_KEY') return 'resolved-secret'
      throw new Error('unavailable')
    },
    resolveSecret: (reference) => {
      if (reference === 'env:GOOD_HEADER') return 'header-secret'
      throw new Error('unavailable')
    },
    readCatalog: () => null,
    disabledModels: () => new Map(),
    afterWrite: async () => undefined,
    catalogTarget: '',
    ...overrides,
  }
}

/* ────────────────────────── 凭据：绝不匿名探测 ────────────────────────── */

test('引用型凭据解析不了就跳过渠道，不发任何匿名请求；能解析的带真实凭据', async () => {
  const memory = memoryStore([
    channel('ref-missing', 'https://a.example.test/v1', 'cpa:openai-compatibility:0123456789abcdef01234567:0'),
    channel('no-key', 'https://b.example.test/v1', undefined),
    channel('env-ok', 'https://c.example.test/v1', 'env:GOOD_KEY'),
  ])
  const { fetch, calls } = fakeFetch(() => modelsResponse('m-1'))
  const result = await syncUpstreamModels({ state: {}, deps: deps({ store: memory.store, fetch }) })

  assert.deepEqual(calls.map(call => new URL(call.url).host), ['c.example.test'])
  assert.ok(calls.every(call => call.authorization === 'Bearer resolved-secret'), '每个请求都必须带解析出来的凭据')
  assert.equal(result.missingCredential, 2)
  assert.equal(result.result, 'partial')
  assert.deepEqual(result.addedModels, ['m-1'])
})

/* ────────────────────────── 单飞 ────────────────────────── */

test('定时器、目录监听、手动按钮并发触发时共用一次运行', async () => {
  const memory = memoryStore([channel('one', 'https://one.example.test/v1', 'env:GOOD_KEY')])
  let release: () => void = () => undefined
  const gate = new Promise<void>((resolve) => { release = resolve })
  const { fetch, calls } = fakeFetch(async () => { await gate; return modelsResponse('m-1') })
  const options = { state: {}, deps: deps({ store: memory.store, fetch }) }
  const first = syncUpstreamModels(options)
  const second = syncUpstreamModels({ ...options, force: true })
  assert.equal(first, second)
  release()
  await Promise.all([first, second])
  assert.equal(calls.length, 1)
  assert.equal(memory.writes, 1)
})

/* ────────────────────────── 节奏：间隔、目录哈希、主机最小间隔 ────────────────────────── */

test('每渠道 ≥30 分钟才探一次；目录内容变了立即补探；没到期的运行是 silent', async () => {
  const clock = { now: 20_000_000 }
  let catalog: SharedCatalog | null = { version: 1, generatedAt: 1, provider: 'crosery', baseUrl: 'https://gw.example.test/v1', models: [{ id: 'x-1' }] }
  const memory = memoryStore([channel('one', 'https://one.example.test/v1', 'env:GOOD_KEY')])
  const { fetch, calls } = fakeFetch(() => modelsResponse('m-1'))
  const state: DiscoveryState = {}
  const run = () => syncUpstreamModels({ state, deps: deps({ store: memory.store, fetch, clock, readCatalog: () => catalog, catalogTarget: 'off' }) })

  await run()
  assert.equal(calls.length, 1)

  clock.now += 10 * 60_000
  const idle = await run()
  assert.equal(calls.length, 1, '10 分钟内不重复探测')
  assert.equal(idle.silent, true)
  assert.equal(idle.requests, 0)

  // 生成时间、价格段变了但模型集合没变：不算目录变化
  catalog = { ...catalog!, generatedAt: 2 }
  await run()
  assert.equal(calls.length, 1)

  catalog = { ...catalog!, models: [{ id: 'x-1' }, { id: 'x-2' }] }
  clock.now += 2 * 60_000
  await run()
  assert.equal(calls.length, 2, '目录模型集合变化 → 立即补探')

  clock.now += DISCOVERY_POLICY.channelIntervalMs * 1.2
  await run()
  assert.equal(calls.length, 3, '超过间隔（含抖动）后按期再探')
  assert.ok(DISCOVERY_POLICY.channelIntervalMs >= 30 * 60_000)
})

test('同一主机两次探测至少隔 1 分钟：同主机的第二个渠道推迟到下一轮', async () => {
  const clock = { now: 30_000_000 }
  const memory = memoryStore([
    channel('a', 'https://shared.example.test/v1', 'env:GOOD_KEY'),
    channel('b', 'https://shared.example.test/other/v1', 'env:GOOD_KEY'),
  ])
  const { fetch, calls } = fakeFetch(() => modelsResponse('m-1'))
  const state: DiscoveryState = {}
  const first = await syncUpstreamModels({ state, deps: deps({ store: memory.store, fetch, clock }) })
  assert.equal(calls.length, 1)
  assert.equal(first.deferred, 1)

  clock.now += DISCOVERY_POLICY.hostMinIntervalMs
  await syncUpstreamModels({ state, deps: deps({ store: memory.store, fetch, clock }) })
  assert.equal(calls.length, 2)
  assert.match(calls[1].url, /other/)
})

/* ────────────────────────── 退避 ────────────────────────── */

test('429 按主机退避并服从 Retry-After；401 只退避该渠道，且不再换路径重打', async () => {
  const clock = { now: 40_000_000 }
  const memory = memoryStore([
    channel('limited', 'https://limited.example.test', 'env:GOOD_KEY'),
    channel('denied', 'https://denied.example.test', 'env:GOOD_KEY'),
  ])
  const { fetch, calls } = fakeFetch((url) => {
    if (url.includes('limited')) return new Response('slow down', { status: 429, headers: { 'retry-after': '7200' } })
    return new Response('nope', { status: 401 })
  })
  const state: DiscoveryState = {}
  const result = await syncUpstreamModels({ state, deps: deps({ store: memory.store, fetch, clock }) })
  // 两个渠道都是 host 根路径（有两个候选 URL），但遇到 429/401 必须立刻停手
  assert.equal(calls.length, 2)
  assert.equal(result.result, 'error')
  assert.equal(state.hosts!['limited.example.test'].backoffUntil, clock.now + 7_200_000)
  assert.equal(state.channels!.denied.backoffUntil, clock.now + DISCOVERY_POLICY.authBackoffBaseMs)
  assert.equal(state.hosts!['denied.example.test'].backoffUntil ?? 0, 0, '401/403 是这把 key 的问题，不是主机的')

  clock.now += 60 * 60_000
  const forced = await syncUpstreamModels({ state, force: true, deps: deps({ store: memory.store, fetch, clock }) })
  assert.equal(calls.length, 3, '手动触发也不能打退避中的主机（limited 仍在 Retry-After 窗口）')
  assert.equal(forced.deferred, 1)
  assert.equal(state.channels!.denied.backoffLevel, 2)
  assert.equal(state.channels!.denied.backoffUntil, clock.now + 2 * DISCOVERY_POLICY.authBackoffBaseMs, '连续失败指数递增')
})

test('Retry-After 支持秒数与 HTTP 日期', () => {
  assert.equal(parseRetryAfter('120', 0), 120_000)
  assert.equal(parseRetryAfter(new Date(90_000).toUTCString(), 30_000), 60_000)
  assert.equal(parseRetryAfter('garbage', 0), null)
})

/* ────────────────────────── 写入：重读后追加，不覆盖并发改动 ────────────────────────── */

test('真实 magpie 渠道表：探测期间管理员的改动不会被旧快照覆盖', async () => {
  const file = path.join(testDataDir, 'magpie-channels-race.json')
  const original = { engine: config.gatewayEngine, plane: config.magpieControlPlane, file: config.magpieChannelsFile }
  config.gatewayEngine = 'magpie'
  config.magpieControlPlane = 'local'
  config.magpieChannelsFile = file
  const write = (channels: unknown) => fs.writeFileSync(file, `${JSON.stringify({ version: 1, channels }, null, 2)}\n`)
  write([
    { name: 'up', 'base-url': 'https://up.example.test/v1', 'api-key-entries': [{ 'api-key': 'env:GOOD_KEY' }], models: [{ name: 'old-model' }] },
    { name: 'other', 'base-url': 'https://other.example.test/v1', 'api-key-entries': [{ 'api-key': 'env:OTHER_KEY' }], models: [{ name: 'keep' }], disabled: true },
  ])
  try {
    const { fetch } = fakeFetch(() => {
      // 探测进行中，管理员启用了 other 并给 up 加了一个模型
      write([
        { name: 'up', 'base-url': 'https://up.example.test/v1', 'api-key-entries': [{ 'api-key': 'env:GOOD_KEY' }], models: [{ name: 'old-model' }, { name: 'admin-added' }] },
        { name: 'other', 'base-url': 'https://other.example.test/v1', 'api-key-entries': [{ 'api-key': 'env:OTHER_KEY' }], models: [{ name: 'keep' }] },
      ])
      return modelsResponse('old-model', 'new-model')
    })
    const result = await syncUpstreamModels({ state: {}, deps: deps({ fetch }) })
    assert.deepEqual(result.addedModels, ['new-model'])
    const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as { channels: Array<{ name: string; disabled?: boolean; models: Array<{ name: string }> }> }
    const up = saved.channels.find(item => item.name === 'up')!
    assert.deepEqual(up.models.map(model => model.name), ['old-model', 'admin-added', 'new-model'])
    assert.equal(saved.channels.find(item => item.name === 'other')!.disabled, undefined)
  } finally {
    config.gatewayEngine = original.engine
    config.magpieControlPlane = original.plane
    config.magpieChannelsFile = original.file
  }
})

test('单渠道模型数受 500 上限保护：超出部分不写入并如实报告', () => {
  const channels = [{ name: 'big', models: Array.from({ length: 499 }, (_, index) => ({ name: `m-${index}` })) }]
  const result = applyAdditions(channels, new Map([['big', [{ id: 'n-1', alias: 'n-1' }, { id: 'n-2', alias: 'n-2' }]]]))
  assert.deepEqual(result.added, ['n-1'])
  assert.equal(result.capped, 1)
  assert.equal(channels[0].models.length, 500)
})

/* ────────────────────────── 共享目录自反馈 ────────────────────────── */

const catalogOf = (baseUrl: string, ids: string[]): SharedCatalog => ({ version: 1, generatedAt: 1, provider: 'crosery', baseUrl, models: ids.map(id => ({ id })) })

test('SB-01 目录合入：没有渠道指向产出目录的网关时不合入任何渠道（网关独有模型不挂到无关第三方、不占它的名额）', async () => {
  // 复现线上：catalog.baseUrl 是网关自己，第一个启用渠道是 openrouter；cline-pass/kimi-k3 的本渠道已停用。
  const memory = memoryStore([
    channel('openrouter', 'https://openrouter.example.test/api/v1', 'env:GOOD_KEY', ['own-1']),
    channel('router', 'https://router.example.test/v1', 'env:MISSING', ['shared-free']),
    channel('cline-pass', 'https://cline.example.test/v1', 'env:MISSING', ['kimi-k3'], true),
  ])
  const catalog = catalogOf('https://ai.example.test/v1', ['shared-free', 'kimi-k3', 'gateway-only'])
  const { fetch } = fakeFetch(() => modelsResponse('own-1', 'own-2'))
  const result = await syncUpstreamModels({ state: {}, deps: deps({ store: memory.store, fetch, readCatalog: () => catalog }) })
  assert.equal(result.catalog.mode, 'none')
  assert.equal(result.catalog.target, null)
  assert.equal(result.catalog.added, 0)
  assert.deepEqual(memory.channels.find(item => item.name === 'openrouter')!.models.map(model => model.name), ['own-1', 'own-2'],
    'openrouter 只拿到它自己 /models 报出来的模型')
  assert.deepEqual(resolveCatalogTarget(memory.channels, catalog), { mode: 'none', target: null })
})

test('SB-01 目录合入：目标渠道本轮自己报过模型表时，它没列出的目录 id 不挂上去', async () => {
  const memory = memoryStore([channel('gateway', 'https://gw.example.test/v1', 'env:GOOD_KEY', [])])
  const catalog = catalogOf('https://gw.example.test/v1', ['visible', 'not-for-this-key'])
  const { fetch } = fakeFetch(() => modelsResponse('visible'))
  const result = await syncUpstreamModels({ state: {}, deps: deps({ store: memory.store, fetch, readCatalog: () => catalog }) })
  assert.equal(result.catalog.mode, 'matched')
  assert.deepEqual(memory.channels[0].models.map(model => model.name), ['visible'])
})

test('目录合入：有渠道指向产出目录的网关时只合入它本轮自己也列出的 id（凭据不可用、没探测成功就不合入）；off 关闭合入', async () => {
  const channels = [
    channel('third-party', 'https://third.example.test/v1', 'env:MISSING', ['own-1']),
    channel('gateway', 'https://GW.example.test', 'env:MISSING', []),
  ]
  const catalog = catalogOf('https://gw.example.test/v1/', ['a', 'own-1'])
  assert.equal(resolveCatalogTarget(channels, catalog).target?.name, 'gateway')
  assert.equal(resolveCatalogTarget(channels, catalog, 'off').mode, 'off')
  assert.equal(resolveCatalogTarget(channels, catalog, 'third-party').mode, 'pinned')

  const memory = memoryStore(channels)
  const { fetch } = fakeFetch(() => modelsResponse())
  const unverified = await syncUpstreamModels({ state: {}, deps: deps({ store: memory.store, fetch, readCatalog: () => catalog }) })
  assert.equal(unverified.catalog.mode, 'matched')
  assert.deepEqual(memory.channels.find(item => item.name === 'gateway')!.models.map(model => model.name), [], '凭据不可用：没法确认这把 key 看得到哪些模型')
  assert.deepEqual(memory.channels.find(item => item.name === 'third-party')!.models.map(model => model.name), ['own-1'])

  const working = memoryStore([channel('gateway', 'https://GW.example.test', 'env:GOOD_KEY', [])])
  const listing = fakeFetch(() => modelsResponse('a', 'own-1'))
  await syncUpstreamModels({ state: {}, deps: deps({ store: working.store, fetch: listing.fetch, readCatalog: () => catalog }) })
  assert.deepEqual(working.channels[0].models.map(model => model.name), ['a', 'own-1'])

  const disabled = memoryStore(channels)
  await syncUpstreamModels({ state: {}, deps: deps({ store: disabled.store, fetch, readCatalog: () => catalog, catalogTarget: 'off' }) })
  assert.equal(disabled.writes, 0)
})

test('目录只在内容变化（或手动）时合入一次；管理员删掉的模型不会每轮被加回来', async () => {
  const memory = memoryStore([channel('gateway', 'https://gw.example.test/v1', 'env:MISSING', [])])
  const catalog = catalogOf('https://gw.example.test/v1', ['a'])
  const { fetch } = fakeFetch(() => modelsResponse())
  const state: DiscoveryState = {}
  const clock = { now: 50_000_000 }
  await syncUpstreamModels({ state, deps: deps({ store: memory.store, fetch, clock, readCatalog: () => catalog }) })
  assert.equal(state.catalogHash, catalogModelsHash(catalog))
  memory.channels = [channel('gateway', 'https://gw.example.test/v1', 'env:MISSING', [])]
  clock.now += DISCOVERY_POLICY.channelIntervalMs * 2
  await syncUpstreamModels({ state, deps: deps({ store: memory.store, fetch, clock, readCatalog: () => catalog }) })
  assert.equal(memory.channels[0].models.length, 0)
})

test('读取渠道失败如实报错，不假装成功', async () => {
  const result = await syncUpstreamModels({
    state: {},
    deps: deps({ store: { read: async () => { throw new Error('cpa down') }, commit: async () => ({ added: [], capped: 0 }) } }),
  })
  assert.equal(result.result, 'error')
  assert.equal(result.source, 'none')
  assert.match(result.errors[0], /cpa down/)
})

test('合入写失败时下轮重试合入（pinned 目标），但不会因此每轮都重探所有渠道', async () => {
  // matched 目标只合入本轮探测确认过的 id（等同探测本身），重试由它下次探测完成；pinned 是管理员显式指定，合入照常重试。
  const clock = { now: 60_000_000 }
  const catalog = catalogOf('https://gw.example.test/v1', ['a'])
  const channels = [channel('gateway', 'https://gw.example.test/v1', 'env:GOOD_KEY', [])]
  let commits = 0
  const failing: ChannelStore = {
    read: async () => structuredClone(channels),
    commit: async () => { commits += 1; throw new Error('disk full') },
  }
  const { fetch, calls } = fakeFetch(() => modelsResponse('m-1'))
  const state: DiscoveryState = {}
  const first = await syncUpstreamModels({ state, deps: deps({ store: failing, fetch, clock, readCatalog: () => catalog, catalogTarget: 'gateway' }) })
  assert.equal(first.result, 'error')
  assert.equal(calls.length, 1)
  clock.now += DISCOVERY_POLICY.tickMs
  await syncUpstreamModels({ state, deps: deps({ store: failing, fetch, clock, readCatalog: () => catalog, catalogTarget: 'gateway' }) })
  assert.equal(calls.length, 1, '目录没变，渠道也没到期：不再探测')
  assert.equal(commits, 2, '合入照样重试（纯本地）')
})

/* ────────────────────────── review-sync-balance ────────────────────────── */

test('SB-02 被单渠道上限挡掉的模型：结果是 partial，如实列出数量与 id，摘要写「上限丢弃」', async () => {
  const full = Array.from({ length: DISCOVERY_POLICY.maxModelsPerChannel }, (_, index) => `old-${index}`)
  const memory = memoryStore([channel('big', 'https://big.example.test/v1', 'env:GOOD_KEY', full)])
  const { fetch } = fakeFetch(() => modelsResponse('old-1', 'brand-new'))
  const result = await syncUpstreamModels({ state: {}, deps: deps({ store: memory.store, fetch }) })
  assert.equal(result.result, 'partial', '真实上游模型没写进去，不能报 ok')
  assert.equal(result.capped, 1)
  assert.deepEqual(result.cappedModels, ['brand-new'])
  assert.match(result.summary, /上限丢弃 1/)
  assert.ok(result.errors.some(error => error.includes('brand-new')))
  assert.equal(memory.channels[0].models.length, DISCOVERY_POLICY.maxModelsPerChannel, '不自动腾位置')
})

test('SB-12 totalModels 是写入后启用渠道上的映射条数：两个渠道新增同一个 id 算 2，停用渠道不算', async () => {
  const memory = memoryStore([
    channel('a', 'https://a.example.test/v1', 'env:GOOD_KEY', ['x']),
    channel('b', 'https://b.example.test/v1', 'env:GOOD_KEY', ['y']),
    channel('off', 'https://off.example.test/v1', 'env:GOOD_KEY', ['z1', 'z2', 'z3'], true),
  ])
  const { fetch } = fakeFetch(() => modelsResponse('shared'))
  const result = await syncUpstreamModels({ state: {}, deps: deps({ store: memory.store, fetch }) })
  assert.deepEqual(result.addedModels, ['shared'])
  assert.equal(result.totalModels, 4, 'a:[x,shared] + b:[y,shared]')
  assert.match(result.summary, /^4 模型/)
})

test('SB-05 401/403 只退避出错的渠道：同主机的好 key 渠道照常被探测（24h 模拟）', async () => {
  const clock = { now: 70_000_000 }
  const memory = memoryStore([
    channel('bad-key', 'https://same.example.test/v1', 'env:BAD_KEY'),
    channel('good-key', 'https://same.example.test/v1', 'env:GOOD_KEY'),
  ])
  const { fetch, calls } = fakeFetch((_url, headers) =>
    headers.get('authorization') === 'Bearer bad-secret' ? new Response('nope', { status: 401 }) : modelsResponse('m-1'))
  const state: DiscoveryState = {}
  const resolveCredential = async (reference: string) => (reference === 'env:BAD_KEY' ? 'bad-secret' : 'resolved-secret')
  const end = clock.now + 24 * 60 * 60_000
  while (clock.now < end) {
    await syncUpstreamModels({ state, deps: deps({ store: memory.store, fetch, clock, resolveCredential }) })
    clock.now += DISCOVERY_POLICY.tickMs
  }
  const good = calls.filter(call => call.authorization === 'Bearer resolved-secret').length
  const bad = calls.filter(call => call.authorization === 'Bearer bad-secret').length
  assert.ok(good >= 24, `好 key 渠道 24h 内应按 30 分钟节奏被探测，实际 ${good} 次`)
  assert.ok(bad <= 8, `坏 key 渠道按渠道指数退避，实际 ${bad} 次`)
  assert.equal(state.hosts!['same.example.test'].backoffUntil ?? 0, 0, '401 不进主机退避')
  assert.ok((state.channels!['bad-key'].backoffLevel ?? 0) >= 3)
  assert.deepEqual(memory.channels.find(item => item.name === 'good-key')!.models.map(model => model.name), ['m-1'])
})

test('SB-05 Anthropic 原生渠道按协议探测：x-api-key + anthropic-version，先试 /v1/models', async () => {
  const memory = memoryStore([{ ...channel('kimi', 'https://anthropic.example.test', 'env:GOOD_KEY'), protocol: 'claude' }])
  const { fetch, calls } = fakeFetch(() => modelsResponse('claude-x'))
  const result = await syncUpstreamModels({ state: {}, deps: deps({ store: memory.store, fetch }) })
  assert.equal(result.result, 'ok')
  assert.equal(calls[0].url, 'https://anthropic.example.test/v1/models')
  assert.equal(calls[0].headers.get('x-api-key'), 'resolved-secret')
  assert.equal(calls[0].headers.get('anthropic-version'), '2023-06-01')
  assert.equal(calls[0].authorization, null)
})

test('SB-06 管理员停用过的模型（墓碑）探测与目录都不会再加回来；写入那一刻也会复核', async () => {
  const memory = memoryStore([channel('gateway', 'https://gw.example.test/v1', 'env:GOOD_KEY', ['keep'])])
  const tombstones = new Map([['gateway', new Set(['disabled-id', 'public-alias'])]])
  const { fetch } = fakeFetch(() => modelsResponse('keep', 'disabled-id', 'Public-Alias', 'fresh'))
  const catalog = catalogOf('https://gw.example.test/v1', ['disabled-id', 'fresh'])
  const result = await syncUpstreamModels({ state: {}, deps: deps({ store: memory.store, fetch, readCatalog: () => catalog, disabledModels: () => tombstones }) })
  assert.deepEqual(result.addedModels, ['fresh'])
  assert.deepEqual(memory.channels[0].models.map(model => model.name), ['keep', 'fresh'])

  // 探测期间管理员又停用了 fresh2：commit 里重新读墓碑，挡住它
  const racing = memoryStore([channel('gateway', 'https://gw.example.test/v1', 'env:GOOD_KEY', [])])
  let reads = 0
  const late = new Map<string, Set<string>>()
  const raced = await syncUpstreamModels({
    state: {},
    deps: deps({
      store: { read: racing.store.read, commit: (additions, guard) => racing.store.commit(additions, guard) },
      fetch: fakeFetch(() => { late.set('gateway', new Set(['fresh2'])); return modelsResponse('fresh1', 'fresh2') }).fetch,
      disabledModels: () => { reads += 1; return reads === 1 ? new Map() : late },
    }),
  })
  assert.deepEqual(raced.addedModels, ['fresh1'])
  assert.equal(reads, 2, '运行开始与写入前各读一次')
})

test('SB-06 墓碑来自 channel_model_states：model 列（对外名）与 snapshot 里的 name/alias 都算', () => {
  db.prepare('INSERT INTO channel_model_states (channel,model,enabled,snapshot_json,updated_at) VALUES (?,?,0,?,?)')
    .run('tomb-channel', 'Public-Name', JSON.stringify([{ name: 'vendor/Upstream-Id', alias: 'public-name' }]), new Date().toISOString())
  db.prepare('INSERT INTO channel_model_states (channel,model,enabled,snapshot_json,updated_at) VALUES (?,?,1,?,?)')
    .run('tomb-channel', 'restored', JSON.stringify([{ name: 'restored' }]), new Date().toISOString())
  const blocked = readDisabledModels().get('tomb-channel')!
  assert.ok(blocked.has('public-name'))
  assert.ok(blocked.has('vendor/upstream-id'))
  assert.ok(!blocked.has('restored'), '重新启用的不算墓碑')
})

test('SB-06 墓碑读不到时本轮不写入（宁可不加，也不能加回管理员停用的模型）', async () => {
  const memory = memoryStore([channel('a', 'https://a.example.test/v1', 'env:GOOD_KEY')])
  const { fetch, calls } = fakeFetch(() => modelsResponse('m-1'))
  const result = await syncUpstreamModels({ state: {}, deps: deps({ store: memory.store, fetch, disabledModels: () => { throw new Error('db locked') } }) })
  assert.equal(result.result, 'error')
  assert.equal(calls.length, 0)
  assert.equal(memory.writes, 0)
})

test('SB-24 一直拿不到模型列表的渠道：探测间隔逐次翻倍，封顶 24h；成功后恢复', async () => {
  const clock = { now: 80_000_000 }
  let empty = true
  const memory = memoryStore([channel('quiet', 'https://quiet.example.test/v1', 'env:GOOD_KEY')])
  const { fetch, calls } = fakeFetch(() => (empty ? new Response('not found', { status: 404 }) : modelsResponse('m-1')))
  const state: DiscoveryState = {}
  const end = clock.now + 24 * 60 * 60_000
  while (clock.now < end) {
    await syncUpstreamModels({ state, deps: deps({ store: memory.store, fetch, clock }) })
    clock.now += DISCOVERY_POLICY.tickMs
  }
  assert.ok(calls.length <= 7, `24h 内应只探测 ~6 次（30m,1h,2h,4h,8h…），实际 ${calls.length}`)
  assert.ok(state.channels!.quiet.emptyLevel! >= 5)
  empty = false
  await syncUpstreamModels({ state, force: true, deps: deps({ store: memory.store, fetch, clock }) })
  assert.equal(state.channels!.quiet.emptyLevel, 0)
  assert.ok(state.channels!.quiet.nextProbeAt! - clock.now <= DISCOVERY_POLICY.channelIntervalMs * 1.1)
})

test('SB-25 走代理的渠道不直连探测；自定义请求头按引用解析后带上，解析不了就跳过', async () => {
  const memory = memoryStore([
    { ...channel('proxied', 'https://proxied.example.test/v1', 'env:GOOD_KEY'), proxy: 'socks5://127.0.0.1:1080' },
    { ...channel('custom', 'https://custom.example.test/v1', 'env:GOOD_KEY'), headers: { 'X-Tenant': 'env:GOOD_HEADER', 'X-Plain': 'plain' } },
    { ...channel('broken', 'https://broken.example.test/v1', 'env:GOOD_KEY'), headers: { 'X-Tenant': 'env:MISSING_HEADER' } },
  ])
  const { fetch, calls } = fakeFetch(() => modelsResponse('m-1'))
  const result = await syncUpstreamModels({ state: {}, deps: deps({ store: memory.store, fetch }) })
  assert.deepEqual(calls.map(call => new URL(call.url).host), ['custom.example.test'])
  assert.equal(calls[0].headers.get('x-tenant'), 'header-secret')
  assert.equal(calls[0].headers.get('x-plain'), 'plain')
  assert.equal(calls[0].authorization, 'Bearer resolved-secret')
  assert.equal(result.proxied, 1)
  assert.equal(result.missingCredential, 1)
  assert.match(result.summary, /代理 1 未探测/)
})

test('SB-25 magpie 渠道表的代理/请求头/协议进入探测视图（key 上的代理优先，direct 视为直连）', async () => {
  const file = path.join(testDataDir, 'magpie-channels-proxy.json')
  const original = { engine: config.gatewayEngine, plane: config.magpieControlPlane, file: config.magpieChannelsFile }
  config.gatewayEngine = 'magpie'
  config.magpieControlPlane = 'local'
  config.magpieChannelsFile = file
  fs.writeFileSync(file, `${JSON.stringify({ version: 1, channels: [
    { name: 'keyproxy', 'base-url': 'https://a.example.test/v1', 'api-key-entries': [{ 'api-key': 'env:GOOD_KEY', 'proxy-url': 'http://127.0.0.1:7890' }], models: [{ name: 'a' }] },
    { name: 'direct', 'base-url': 'https://b.example.test', 'proxy-url': 'http://127.0.0.1:7890', 'api-key-entries': [{ 'api-key': 'env:GOOD_KEY', 'proxy-url': 'direct' }], models: [{ name: 'b' }], protocol: 'anthropic' },
  ] }, null, 2)}\n`)
  try {
    const { fetch, calls } = fakeFetch(() => modelsResponse('b', 'b2'))
    const result = await syncUpstreamModels({ state: {}, deps: deps({ fetch }) })
    assert.equal(result.proxied, 1)
    assert.deepEqual(calls.map(call => call.url), ['https://b.example.test/v1/models'])
    assert.equal(calls[0].headers.get('x-api-key'), 'resolved-secret')
    assert.deepEqual(result.addedModels, ['b2'])
  } finally {
    config.gatewayEngine = original.engine
    config.magpieControlPlane = original.plane
    config.magpieChannelsFile = original.file
  }
})

test('SB-19 状态文件里的坏条目：null 渠道/主机、离谱时间都被清洗，运行与同步中心视图不抛错', async () => {
  const clock = { now: 90_000_000 }
  const state = {
    catalogHash: 42,
    channels: { broken: null, frozen: { nextProbeAt: 1e20, lastProbeAt: clock.now + 10 * 60_000, backoffUntil: 'soon' }, list: [1, 2] },
    hosts: { 'x.example.test': null, 'y.example.test': { lastRequestAt: clock.now + 3_600_000, backoffUntil: Number.POSITIVE_INFINITY } },
  } as unknown as Record<string, unknown>
  sanitizeDiscoveryState(state, clock.now)
  const clean = state as DiscoveryState
  assert.equal(clean.catalogHash, undefined)
  assert.deepEqual(Object.keys(clean.channels!), ['frozen'])
  assert.equal(clean.channels!.frozen.nextProbeAt, clock.now + DISCOVERY_POLICY.retryAfterCapMs, '离谱的下次时间夹到最长合法等待')
  assert.equal(clean.channels!.frozen.lastProbeAt, clock.now, '「上次」不能在未来')
  assert.equal(clean.channels!.frozen.backoffUntil, undefined)
  assert.deepEqual(Object.keys(clean.hosts!), ['y.example.test'])
  assert.equal(clean.hosts!['y.example.test'].lastRequestAt, clock.now)
  assert.equal(clean.hosts!['y.example.test'].backoffUntil, undefined)

  const raw = { channels: { a: null }, hosts: { 'a.example.test': null } } as unknown as DiscoveryState
  assert.doesNotThrow(() => nextDiscoveryAt(raw, clock.now))
  assert.doesNotThrow(() => discoveryBackoff(raw, clock.now))
  const memory = memoryStore([channel('a', 'https://a.example.test/v1', 'env:GOOD_KEY')])
  const { fetch } = fakeFetch(() => modelsResponse('m-1'))
  const result = await syncUpstreamModels({ state: raw, deps: deps({ store: memory.store, fetch, clock }) })
  assert.equal(result.result, 'ok', '坏的持久化状态不能让每一轮发现都失败')
})

test('SB-03 CPA 渠道表：写入前复读比对，管理员在探测期间的改动不会被整表 PUT 覆盖；持续冲突就放弃本轮', async () => {
  const original = { fetch: globalThis.fetch, engine: config.gatewayEngine, key: config.cpaManagementKey, base: config.cpaBaseUrl }
  config.gatewayEngine = 'cpa'
  config.cpaManagementKey = 'fixture-management-key'
  config.cpaBaseUrl = 'https://cpa.example.test'
  let table: Array<Record<string, unknown>> = [
    { name: 'up', 'base-url': 'https://up.example.test/v1', 'api-key-entries': [{ 'api-key': 'env:GOOD_KEY' }], models: [{ name: 'old' }] },
  ]
  let gets = 0
  let puts = 0
  let interfere: (count: number) => void = () => undefined
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    // CPA 全局代理（SB-25）：没设 ⇒ 渠道直连，可以探测。
    if (url.endsWith('/v0/management/proxy-url')) return new Response(JSON.stringify({ 'proxy-url': '' }), { status: 200 })
    if (!url.endsWith('/v0/management/openai-compatibility')) throw new Error(`unexpected ${url}`)
    if ((init?.method || 'GET') === 'PUT') {
      puts += 1
      table = JSON.parse(String(init?.body))
      return new Response('{}', { status: 200 })
    }
    gets += 1
    interfere(gets)
    return new Response(JSON.stringify({ 'openai-compatibility': table }), { status: 200 })
  }) as typeof fetch
  try {
    // read(#1) → commit 基线(#2) → 写入前复读(#3)：管理员恰好在 #3 之前新建了渠道 admin-new
    interfere = (count) => {
      if (count === 3) table = [...table, { name: 'admin-new', 'base-url': 'https://n.example.test/v1', 'api-key-entries': [{ 'api-key': 'k' }], models: [{ name: 'n' }] }]
    }
    const probe = fakeFetch(() => modelsResponse('old', 'discovered'))
    const ok = await syncUpstreamModels({ state: {}, deps: deps({ fetch: probe.fetch }) })
    assert.deepEqual(ok.addedModels, ['discovered'])
    assert.equal(puts, 1)
    assert.deepEqual(table.map(item => item.name), ['up', 'admin-new'], '管理员新建的渠道还在')
    assert.deepEqual((table[0].models as Array<{ name: string }>).map(model => model.name), ['old', 'discovered'])

    // 每次复读都不一样：放弃写入，如实报错
    gets = 0
    puts = 0
    interfere = (count) => { if (count >= 2) table = table.map(item => ({ ...item, touched: count })) }
    const probe2 = fakeFetch(() => modelsResponse('another'))
    const conflicted = await syncUpstreamModels({ state: {}, force: true, deps: deps({ fetch: probe2.fetch }) })
    assert.equal(puts, 0)
    assert.equal(conflicted.result, 'error')
    assert.ok(conflicted.errors.some(error => error.includes('反复被修改')))
  } finally {
    globalThis.fetch = original.fetch
    config.gatewayEngine = original.engine
    config.cpaManagementKey = original.key
    config.cpaBaseUrl = original.base
  }
})

/* ────────────────────────── review-sync-balance 复核（Codex 确认轮） ────────────────────────── */

test('SB-16 探测在拿着全局名额时读完响应体：响应头到了就放名额会让在途请求超过上限', async () => {
  let inside = 0
  let bodyReadOutside = 0
  const limit = async <T>(task: () => Promise<T>) => {
    inside += 1
    try { return await task() } finally { inside -= 1 }
  }
  const memory = memoryStore([channel('a', 'https://a.example.test/v1', 'env:GOOD_KEY')])
  const fetch = async () => new Response(new ReadableStream({
    pull(controller) {
      if (inside === 0) bodyReadOutside += 1
      controller.enqueue(new TextEncoder().encode(JSON.stringify({ data: [{ id: 'm-1' }] })))
      controller.close()
    },
  }, { highWaterMark: 0 }), { status: 200 }) // 只在真正读取时才 pull
  const result = await syncUpstreamModels({ state: {}, deps: deps({ store: memory.store, fetch, limit }) })
  assert.deepEqual(result.addedModels, ['m-1'])
  assert.equal(bodyReadOutside, 0, '响应体必须在名额内读完')
})

test('SB-16 同主机间隔按真正发出的时刻算：排队等名额的时间不能把 60s 间隔「用掉」', async () => {
  const clock = { now: 10_000_000 }
  let waited = false
  // 第一次拿名额前排队 61s（名额被账号额度占着）。
  const limit = async <T>(task: () => Promise<T>) => {
    if (!waited) { waited = true; clock.now += 61_000 }
    return task()
  }
  const memory = memoryStore([
    channel('bad', 'https://shared.example.test/v1', 'env:GOOD_KEY'),
    channel('good', 'https://shared.example.test/v1', 'env:GOOD_KEY'),
  ])
  const { fetch, calls } = fakeFetch(() => new Response('denied', { status: 401 }))
  const state: DiscoveryState = {}
  const result = await syncUpstreamModels({ state, deps: deps({ store: memory.store, fetch, limit, clock }) })
  assert.equal(calls.length, 1, `同主机第二个渠道应推迟，实际发出 ${calls.length} 次`)
  assert.equal(result.deferred, 1)
  assert.equal(state.hosts!['shared.example.test'].lastRequestAt, 10_000_000 + 61_000)
  assert.equal(state.channels!.good.nextProbeAt, 10_000_000 + 61_000 + DISCOVERY_POLICY.hostMinIntervalMs)
})

test('SB-25 CPA 控制面渠道继承 CPA 全局代理（key > 渠道 > 全局 > 直连）；全局代理读不到时出口未知、不直连探测', async () => {
  const entry = (proxy?: string) => ({ 'api-key': 'env:GOOD_KEY', ...(proxy === undefined ? {} : { 'proxy-url': proxy }) })
  const base = { name: 'x', 'base-url': 'https://x.example.test/v1', models: [{ name: 'm' }] }
  assert.equal(cpaSyncChannel({ ...base, 'api-key-entries': [entry()] }, 'http://global:1').proxy, 'http://global:1')
  assert.equal(cpaSyncChannel({ ...base, 'api-key-entries': [entry()] }, '').proxy, null)
  assert.equal(cpaSyncChannel({ ...base, 'api-key-entries': [entry('direct')], 'proxy-url': 'http://channel:1' }, 'http://global:1').proxy, null)
  assert.equal(cpaSyncChannel({ ...base, 'api-key-entries': [entry()], 'proxy-url': 'direct' }, 'http://global:1').proxy, null)
  assert.equal(cpaSyncChannel({ ...base, 'api-key-entries': [entry()], 'proxy-url': 'http://channel:1' }, 'http://global:1').proxy, 'http://channel:1')
  assert.equal(cpaSyncChannel({ ...base, 'api-key-entries': [entry()] }, null).proxy, UNKNOWN_PROXY)
  assert.equal(cpaSyncChannel({ ...base, 'api-key-entries': [entry('direct')] }, null).proxy, null, '显式直连不受全局代理读取失败影响')

  const memory = memoryStore([{ ...channel('unknown', 'https://u.example.test/v1', 'env:GOOD_KEY'), proxy: UNKNOWN_PROXY }])
  const { fetch, calls } = fakeFetch(() => modelsResponse('m-1'))
  const state: DiscoveryState = {}
  const result = await syncUpstreamModels({ state, deps: deps({ store: memory.store, fetch }) })
  assert.equal(calls.length, 0)
  assert.equal(result.proxied, 1)
  assert.equal(state.channels!.unknown.lastError, 'proxy_unknown')
})

test('SB-01 matched 目标本轮探测被推迟/失败时，目录 id 不合入（不占名额、不制造这把 key 路由不了的映射），下次探测成功由探测补齐', async () => {
  const clock = { now: 70_000_000 }
  const memory = memoryStore([channel('gateway', 'https://gw.example.test/v1', 'env:GOOD_KEY', ['old'])])
  const catalog = catalogOf('https://gw.example.test/v1', ['old', 'key-a-only', 'shared-new'])
  const state: DiscoveryState = { hosts: { 'gw.example.test': { backoffUntil: clock.now + 10 * 60_000, backoffLevel: 1 } } }
  const { fetch, calls } = fakeFetch(() => modelsResponse('old', 'shared-new'))
  const deferred = await syncUpstreamModels({ state, deps: deps({ store: memory.store, fetch, clock, readCatalog: () => catalog }) })
  assert.equal(calls.length, 0, '主机退避中，本轮不探测')
  assert.equal(deferred.catalog.mode, 'matched')
  assert.equal(deferred.catalog.added, 0)
  assert.deepEqual(memory.channels[0].models.map(model => model.name), ['old'])

  clock.now += 11 * 60_000
  await syncUpstreamModels({ state, deps: deps({ store: memory.store, fetch, clock, readCatalog: () => catalog }) })
  assert.deepEqual(memory.channels[0].models.map(model => model.name), ['old', 'shared-new'], '探测成功后只补上这把 key 自己列出的模型')
})
