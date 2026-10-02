import './testDataDir.js'

import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import type { ConsoleGroup } from './groups.js'
import type { CatalogModel } from './modelCatalog.js'
import type { DiscoveryState, SharedCatalog } from './modelSync.js'
import type { ReadOperation } from './sqliteReadWorker.js'

const { buildChannelProbes, buildModelSpecs, buildUsageEvidence, createModelInsights } = await import('./modelInsights.js')
const { loadUsageOverviewReport } = await import('./usageReports.js')

const NOW = Date.UTC(2026, 9, 2, 6, 30, 0)
const HOUR = 3_600_000
const hourOf = (ms: number) => Math.floor(ms / HOUR) * HOUR

const groups: ConsoleGroup[] = [
  { id: 'openrouter', name: 'openrouter', color: '#000', kind: 'compat', models: [] },
  { id: 'codex', name: 'Codex', color: '#000', kind: 'oauth', models: [] },
]

function rollupDb() {
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE usage_hourly_rollup (
    hour_ms INTEGER NOT NULL, hour_text TEXT NOT NULL, day_text TEXT NOT NULL, key_hash TEXT NOT NULL,
    provider TEXT NOT NULL, model TEXT NOT NULL, model_group TEXT NOT NULL, endpoint TEXT NOT NULL,
    client_type TEXT NOT NULL, success INTEGER NOT NULL, status_code INTEGER NOT NULL, error_category TEXT NOT NULL,
    request_count INTEGER NOT NULL, total_tokens INTEGER NOT NULL, input_tokens INTEGER NOT NULL,
    uncached_input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, cached_tokens INTEGER NOT NULL,
    cache_write_tokens INTEGER NOT NULL, reasoning_tokens INTEGER NOT NULL, latency_sum_ms INTEGER NOT NULL,
    ttft_sum_ms INTEGER NOT NULL, cost_usd_sum REAL NOT NULL, cost_usd_count INTEGER NOT NULL,
    first_timestamp_ms INTEGER NOT NULL,
    PRIMARY KEY (hour_ms, key_hash, provider, model, model_group, endpoint, client_type, success, status_code, error_category)
  ) WITHOUT ROWID`)
  const insert = db.prepare(`INSERT INTO usage_hourly_rollup VALUES (?, ?, ?, 'k', ?, ?, 'g', '/v1', 'cli', ?, ?, ?, ?, ?, 10, 10, 5, 0, 0, 0, 100, 10, 0, 0, ?)`)
  const add = (at: number, provider: string, model: string, success: boolean, requests: number, status = success ? 200 : 429, category = success ? '' : 'rate_limit') => {
    const hour = hourOf(at)
    const text = new Date(hour).toISOString()
    insert.run(hour, text.slice(0, 13), text.slice(0, 10), provider, model, success ? 1 : 0, status, category, requests, requests * 100, at)
  }
  const reader = {
    operations: [] as ReadOperation[],
    async run(operations: readonly ReadOperation[]) {
      this.operations.push(...operations)
      return operations.map((op) => (op.method === 'all' ? db.prepare(op.sql).all(...(op.params ?? [])) : db.prepare(op.sql).get(...(op.params ?? []))))
    },
  }
  return { db, add, reader }
}

const catalogModel = (overrides: Partial<CatalogModel>): CatalogModel => ({
  id: 'x', providers: ['openrouter'], context_length: null, total_context_length: null, max_completion_tokens: null,
  thinking: null, pricing: null, priceHistory: [], ...overrides,
})

test('usage evidence: canonical model, all channels by default (removed ones marked), same window as the usage overview', async () => {
  const { add, reader } = rollupDb()
  add(NOW - 2 * HOUR, 'openai-compatible-openrouter', 'nvidia/nemotron-3:free', true, 8)
  add(NOW - 1 * HOUR, 'openrouter', 'nemotron-3:free', false, 2, 429, 'rate_limit')
  add(NOW - 3 * HOUR, 'codex', 'gpt-6-sol', false, 3, 401, 'auth')
  add(NOW - 3 * HOUR, 'codex', 'gpt-6-sol', false, 1, 500, 'upstream')
  add(NOW - 30 * HOUR, 'codex', 'gpt-6-sol', true, 6)
  add(NOW - 2 * HOUR, 'openai-compatible-cline-pass', 'gpt-6-sol', true, 50) // not a current channel any more
  add(NOW - 9 * 24 * HOUR, 'codex', 'gpt-6-sol', true, 70) // outside 7 days

  const insights = createModelInsights({
    reader, groups: async () => groups, catalog: async () => [], shared: () => null, discovery: () => null, now: () => NOW,
  })
  const payload = await insights.read(7)
  assert.equal(payload.days, 7)
  assert.equal(payload.from, new Date(NOW - 7 * 24 * HOUR).toISOString())
  // history is history: the removed cline-pass traffic counts, folded to its id and marked removed
  assert.deepEqual(payload.usage?.map((row) => [row.model, row.requests, row.errors]), [['gpt-6-sol', 60, 4], ['nemotron-3:free', 10, 2]])
  const sol = payload.usage?.find((row) => row.model === 'gpt-6-sol')
  assert.deepEqual(sol?.channels.map((c) => [c.channel, c.requests, c.removed]), [['cline-pass', 50, true], ['codex', 10, false]])
  assert.equal(sol?.channels.find((c) => c.channel === 'codex')?.lastOkHour, new Date(hourOf(NOW - 30 * HOUR)).toISOString())
  assert.deepEqual(sol?.topError, { status: 401, category: 'auth', requests: 3 })

  const nemotron = payload.usage?.find((row) => row.model === 'nemotron-3:free')
  assert.equal(nemotron?.lastOkHour, new Date(hourOf(NOW - 2 * HOUR)).toISOString())
  assert.equal(nemotron?.lastErrorHour, new Date(hourOf(NOW - HOUR)).toISOString())
  assert.deepEqual(nemotron?.channels, [{ channel: 'openrouter', requests: 10, errors: 2, removed: false, lastOkHour: new Date(hourOf(NOW - 2 * HOUR)).toISOString() }], 'openai-compatible-openrouter folds into its channel id')

  // opt-in 只看当前渠道
  const current = await insights.read(7, true)
  assert.deepEqual(current.usage?.map((row) => [row.model, row.requests, row.errors]), [['gpt-6-sol', 10, 4], ['nemotron-3:free', 10, 2]])

  // One metric, one query: request totals equal the usage overview for the same window and scope.
  for (const [payloadScope, currentOnly] of [[payload, false], [current, true]] as const) {
    const overview = await loadUsageOverviewReport({
      run: async (operations: readonly ReadOperation[]) => reader.run(operations),
    }, groups, 7, '', NOW, currentOnly)
    const overviewRequests = new Map<string, number>()
    for (const row of overview.models as Array<{ model: string; requests: number }>) {
      overviewRequests.set(row.model, (overviewRequests.get(row.model) ?? 0) + Number(row.requests))
    }
    for (const row of payloadScope.usage ?? []) assert.equal(overviewRequests.get(row.model), row.requests, `${row.model} currentOnly=${currentOnly}`)
  }
})

test('usage evidence: no traffic is [], unreadable usage is null with a reason — never a fake zero', async () => {
  const { reader } = rollupDb()
  const empty = await createModelInsights({ reader, groups: async () => groups, catalog: async () => [], shared: () => null, discovery: () => null, now: () => NOW }).read(7)
  assert.deepEqual(empty.usage, [])

  const broken = await createModelInsights({
    reader: { run: async () => { throw new Error('worker down') } },
    groups: async () => groups, catalog: async () => [], shared: () => null, discovery: () => null, now: () => NOW,
  }).read(7)
  assert.equal(broken.usage, null)
  assert.ok(broken.degraded.includes('usage_unavailable'))

  const noGroups = await createModelInsights({
    reader, groups: async () => { throw new Error('cpa down') }, catalog: async () => [], shared: () => null, discovery: () => null, now: () => NOW,
  }).read(7)
  assert.equal(noGroups.usage, null)
  assert.ok(noGroups.degraded.includes('reporting_groups_unavailable'))
})

test('usage evidence: errors never exceed requests and zero-request rows are dropped', () => {
  const rows = buildUsageEvidence([
    { model: 'a/m', channel: 'x', requests: 2, errors: 5, lastOkHour: null, lastErrorHour: NOW },
    { model: 'm', channel: 'y', requests: 0, errors: 0, lastOkHour: null, lastErrorHour: null },
  ], [])
  assert.deepEqual(rows.map((row) => [row.model, row.requests, row.errors, row.lastOkHour]), [['m', 2, 2, null]])
})

test('specs: gateway catalog → shared catalog → pricing row; unknown reasoning stays null', () => {
  const shared: SharedCatalog = {
    version: 1, generatedAt: NOW, provider: 'crosery', baseUrl: '',
    models: [
      { id: 'apodex/apodex-1.1-mini:free', name: 'Apodex 1.1 Mini', contextWindow: 262_144, maxTokens: 235_929, supportsReasoning: true, efforts: ['low', 'high'] },
      { id: 'vendor/plain-chat', contextWindow: 32_000, supportsReasoning: false },
    ],
    pricing: {
      rows: [
        { id: 'aion-2.0', source: 'models.dev', name: 'Aion 2 (md)', contextWindow: 64_000, maxTokens: 8_000 },
        { id: 'aion-2.0', source: 'openrouter', sourceId: 'aion-labs/aion-2.0', name: 'AionLabs: Aion-2.0', contextWindow: 131_072, maxTokens: 32_768 },
        { id: 'claude-opus-5', source: 'openrouter', contextWindow: 1, maxTokens: 1 },
        { id: 'ghost', source: 'openrouter', contextWindow: 0 },
      ],
    },
  }
  const specs = buildModelSpecs([
    catalogModel({ id: 'claude-opus-5', context_length: 200_000, max_completion_tokens: 64_000, thinking: { levels: ['low', 'high', 'low'] } }),
    catalogModel({ id: 'bare-gateway-model' }),
  ], shared)
  const by = new Map(specs.map((spec) => [spec.model, spec]))

  assert.deepEqual(by.get('claude-opus-5'), { model: 'claude-opus-5', name: null, contextWindow: 200_000, maxOutput: 64_000, reasoning: true, efforts: ['low', 'high'], specSource: 'gateway' })
  assert.deepEqual(by.get('apodex-1.1-mini:free'), { model: 'apodex-1.1-mini:free', name: 'Apodex 1.1 Mini', contextWindow: 262_144, maxOutput: 235_929, reasoning: true, efforts: ['low', 'high'], specSource: 'catalog' })
  assert.equal(by.get('plain-chat')?.reasoning, false, 'a source that says no is no')
  assert.deepEqual(by.get('aion-2.0'), { model: 'aion-2.0', name: 'AionLabs: Aion-2.0', contextWindow: 131_072, maxOutput: 32_768, reasoning: null, efforts: [], specSource: 'openrouter' })
  assert.equal(by.has('bare-gateway-model'), false, 'nothing known → no spec row (the page renders —)')
  assert.equal(by.has('ghost'), false, 'a zero context is not a context')
})

test('probes: per-channel outcome with host backoff, sorted; empty state is []', () => {
  const state: DiscoveryState = {
    channels: {
      zhiyu: { lastProbeAt: NOW - 60_000, nextProbeAt: NOW + 60_000, workingUrl: 'https://api.zhiyu.example/v1/models', lastStatus: 401, lastError: 'HTTP 401', discovered: 0 },
      openrouter: { lastProbeAt: NOW - 120_000, workingUrl: 'https://openrouter.example/api/v1/models', lastStatus: 200, lastError: null, discovered: 464 },
    },
    hosts: { 'api.zhiyu.example': { backoffUntil: NOW + 30 * 60_000, backoffLevel: 1, lastStatus: 401 } },
  }
  assert.deepEqual(buildChannelProbes(state), [
    { channel: 'openrouter', lastProbeAt: new Date(NOW - 120_000).toISOString(), nextProbeAt: null, status: 200, error: null, discovered: 464, backoffUntil: null },
    { channel: 'zhiyu', lastProbeAt: new Date(NOW - 60_000).toISOString(), nextProbeAt: new Date(NOW + 60_000).toISOString(), status: 401, error: 'HTTP 401', discovered: 0, backoffUntil: new Date(NOW + 30 * 60_000).toISOString() },
  ])
  assert.deepEqual(buildChannelProbes(null), [])
})

test('loader: a failing catalog degrades specs only; one computation per window is shared for 30s', async () => {
  const { reader } = rollupDb()
  let clock = NOW
  let catalogCalls = 0
  const insights = createModelInsights({
    reader,
    groups: async () => groups,
    catalog: async () => { catalogCalls += 1; throw new Error('cpa 502') },
    shared: () => ({ version: 1, generatedAt: NOW, provider: '', baseUrl: '', models: [{ id: 'm', contextWindow: 8_000 }] }),
    discovery: () => ({}),
    now: () => clock,
  })
  const first = await insights.read(7)
  assert.ok(first.degraded.includes('catalog_unavailable'))
  assert.deepEqual(first.specs.map((spec) => [spec.model, spec.contextWindow]), [['m', 8_000]])
  assert.equal(await insights.read(7), first)
  assert.equal(catalogCalls, 1)
  assert.notEqual(await insights.read(1), first, 'another window is another computation')
  clock += 31_000
  await insights.read(7)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(catalogCalls, 3, 'stale-while-revalidate refreshes after the ttl')
})

test('usage evidence: liveTopError names the top failure on current channels only; topError keeps the all-channel view', async () => {
  const { add, reader } = rollupDb()
  add(NOW - 2 * HOUR, 'retired', 'gemma-4:free', false, 100, 429, 'rate_limited') // a removed channel
  add(NOW - 1 * HOUR, 'codex', 'gemma-4:free', false, 3, 401, 'auth_failed')
  const payload = await createModelInsights({
    reader, groups: async () => groups, catalog: async () => [], shared: () => null, discovery: () => null, now: () => NOW,
  }).read(7)
  const gemma = payload.usage?.find((row) => row.model === 'gemma-4:free')
  assert.deepEqual(gemma?.topError, { status: 429, category: 'rate_limited', requests: 100 })
  assert.deepEqual(gemma?.liveTopError, { status: 401, category: 'auth_failed', requests: 3 })
  // rows without a channel (older callers) count as current
  const legacy = buildUsageEvidence([{ model: 'm', channel: 'codex', requests: 2, errors: 2, lastOkHour: null, lastErrorHour: NOW }], [{ model: 'm', status: 500, category: 'upstream_5xx', requests: 2 }], groups)
  assert.deepEqual(legacy[0].liveTopError, { status: 500, category: 'upstream_5xx', requests: 2 })
})
