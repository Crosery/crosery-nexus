import './testDataDir.js'

import assert from 'node:assert/strict'
import test from 'node:test'

import { db } from './db.js'
import type { ConsoleGroup } from './groups.js'
import type { ReadOperation } from './sqliteReadWorker.js'
import { loadCacheSummary } from './cacheSummary.js'
import { createOverviewReader } from './overviewRoutes.js'
import { ERROR_CATEGORIES, loadPerformanceReport, parseUsageScope } from './perfReports.js'
import { estimateCost } from './pricing.js'
import { estimateUncosted } from './usageCost.js'
import {
  loadDashboardReport,
  loadUsageOverviewReport,
  loadUsagePageReport,
  loadUsageWorkspaceFacets,
  loadUsageWorkspaceOverview,
  loadUsageWorkspaceRequests,
  workspaceRowCost,
  type UsageWorkspaceFilter,
} from './usageReports.js'

/*
 * One filter, one figure across the 用量 tabs (review findings DR-01, DR-03, DR-04, DR-10, DR-16, DR-19):
 * - 缓存净节省 on 总览 = the 缓存 tab's net savings (hour price, long-context tier, cache-capable models only);
 * - 缓存命中率 on the 总览 ledger and the facet badge = the 缓存 tab headline (success only, capable models only);
 * - a recorded cost_usd is never thrown away; only unledgered requests are estimated, at the price of their hour
 *   with the tier their own prompt picks — the request page prices them the same;
 * - the 未定价 list is the same on the facet bar and the ledger;
 * - a row stamped after the current hour is in no total and no trend;
 * - one "whose problem" word per error category.
 */

const NOW = Date.parse('2026-10-01T12:20:00.000Z')
const HOUR = 3_600_000
const DAY = 24 * HOUR
const TZ = 'Asia/Shanghai'
const groups: ConsoleGroup[] = [
  { id: 'codex', name: 'Codex', color: '#000', kind: 'oauth', models: [] },
  { id: 'claude', name: 'Claude', color: '#000', kind: 'oauth', models: [] },
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
type Ev = {
  at: number
  model: string
  provider?: string
  key?: string
  ok?: boolean
  status?: number
  category?: string
  input?: number
  output?: number
  cached?: number
  write?: number
  /** total_tokens as CPA sent it; defaults to the segment sum (CPA may omit it: 0) */
  total?: number
  cost?: number | null
}
function add(e: Ev) {
  seq += 1
  const input = e.input ?? 1_000
  const output = e.output ?? 100
  const ok = e.ok ?? true
  db.prepare(`INSERT INTO usage_events
    (request_id,timestamp,timestamp_ms,key_hash,provider,model,model_group,endpoint,success,status_code,latency_ms,ttft_ms,
     input_tokens,output_tokens,reasoning_tokens,cached_tokens,cache_write_tokens,total_tokens,user_agent,client_type,client_ip,
     error_detail,error_category,upstream_request_id,source,auth_index,cost_usd)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    `uc-${seq}`, new Date(e.at).toISOString(), e.at, e.key ?? 'key-a', e.provider ?? 'codex', e.model, 'g', 'POST /v1/responses',
    ok ? 1 : 0, e.status ?? (ok ? 200 : 500), 900, 200, input, output, 0, e.cached ?? 0, e.write ?? 0,
    e.total ?? input + output + (e.provider === 'claude' ? (e.cached ?? 0) + (e.write ?? 0) : 0),
    'ua', 'codex-cli', '127.0.0.1', ok ? '' : 'boom', ok ? '' : (e.category ?? 'other'), `up-${seq}`, '', 'auth-1',
    e.cost === undefined ? 0.01 : e.cost,
  )
}

db.exec('DELETE FROM usage_events; DELETE FROM usage_hourly_rollup; DELETE FROM api_keys')
for (const [hash, name] of [['key-a', 'Alpha'], ['key-t', 'Tiers']]) {
  db.prepare(`INSERT INTO api_keys (key_hash,key_value,name,enabled,created_at,updated_at) VALUES (?,?,?,?,?,?)`)
    .run(hash, `value-${hash}`, name, 1, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')
}

// long-context prompt on a tiered model (> 272k): the 缓存 tab prices its savings at the tier, the base price would halve it
add({ at: NOW - 2 * DAY, model: 'gpt-5.6-sol', input: 300_000, cached: 290_000, output: 500, cost: 1.2 })
// anthropic: three segments; a failed request never enters the hit rate
add({ at: NOW - 2 * DAY + HOUR, model: 'claude-opus-5', provider: 'claude', input: 1_000, cached: 8_000, write: 1_000, cost: 0.02 })
add({ at: NOW - 2 * DAY + HOUR + 1, model: 'claude-opus-5', provider: 'claude', ok: false, status: 429, category: 'quota_exhausted', input: 50_000, output: 0, cost: 0 })
// partly ledgered hour: one request recorded at $10, its twin has no cost
add({ at: NOW - 3 * DAY, model: 'gpt-5.4', input: 2_000, output: 200, cost: 10 })
add({ at: NOW - 3 * DAY + 1, model: 'gpt-5.4', input: 1_000, output: 100, cost: null })
// unledgered long prompt on a tiered model: the tier its own prompt picks
add({ at: NOW - 4 * DAY, model: 'gpt-5.4', input: 300_000, output: 100, cost: null })
// unledgered request before a price change: priced at its own hour, not today
add({ at: Date.parse('2026-09-09T06:00:00.000Z'), model: 'deepseek-v4-flash', input: 1_000_000, output: 0, cost: null })
// a model dropped from the catalog after it was priced: a ledgered success and a tokenless NULL-cost failure
add({ at: NOW - 5 * DAY, model: 'zz-dropped-model', cost: 0.02 })
add({ at: NOW - 5 * DAY + 1, model: 'zz-dropped-model', ok: false, category: 'other', input: 0, output: 0, cost: null })
// a model that cannot cache and is not priced
add({ at: NOW - 6 * DAY, model: 'mystery-model', cost: null })

const FILTER: UsageWorkspaceFilter = { days: 30, keyId: '', model: '', provider: '', client: '' }
const options = { timeZone: TZ, retentionDays: 90, now: NOW }
const scope = parseUsageScope({ days: '30' }, 90)
const close = (actual: number | null | undefined, expected: number, label: string) =>
  assert.ok(actual !== null && actual !== undefined && Math.abs(actual - expected) < 1e-9, `${label}: ${actual} ≠ ${expected}`)
const sumCost = (rows: Array<{ costUsd: number | null }>) => rows.reduce((total, row) => total + (row.costUsd ?? 0), 0)

test('DR-01: 缓存净节省 on 总览 equals the 缓存 tab (hour price, long-context tier)', async () => {
  const overview = await loadUsageWorkspaceOverview(reader, groups, FILTER, options)
  const cache = await loadCacheSummary(reader, groups, scope, { timeZone: TZ, now: NOW })
  assert.ok(cache.totals.savings.netUsd !== null)
  close(overview.mix.cacheSavingsUsd, cache.totals.savings.netUsd!, 'mix.cacheSavingsUsd')
  // the tiered request saves at the tier: 290k × (8 − 0.8) per M, not the base 290k × (4 − 0.4)
  const sol = cache.byModel.find((row) => row.id === 'gpt-5.6-sol')!
  close(sol.savingsUsd, (290_000 * (8 - 0.8)) / 1_000_000, 'tiered savings')
})

test('DR-04: 缓存命中率 on the ledger, the previous-window shape and the facet badge equal the 缓存 tab headline', async () => {
  const overview = await loadUsageWorkspaceOverview(reader, groups, FILTER, options)
  const facets = await loadUsageWorkspaceFacets(reader, groups, FILTER, options)
  const cache = await loadCacheSummary(reader, groups, scope, { timeZone: TZ, now: NOW })
  assert.ok(cache.totals.hitRate !== null)
  assert.equal(overview.ledger.cacheHitRate, cache.totals.hitRate)
  assert.equal(facets.totals.cacheHitRate, cache.totals.hitRate)
  assert.equal(overview.ledger.cacheIdleModels, cache.excluded.models)
  assert.ok(cache.excluded.items.some((item) => item.model === 'mystery-model'))
  // narrowed by model: still the same figure on all three
  const narrowed = { ...FILTER, model: 'claude-opus-5' }
  const narrowedCache = await loadCacheSummary(reader, groups, parseUsageScope({ days: '30', model: 'claude-opus-5' }, 90), { timeZone: TZ, now: NOW })
  assert.equal((await loadUsageWorkspaceOverview(reader, groups, narrowed, options)).ledger.cacheHitRate, narrowedCache.totals.hitRate)
  assert.equal((await loadUsageWorkspaceFacets(reader, groups, narrowed, options)).totals.cacheHitRate, narrowedCache.totals.hitRate)
  close(narrowedCache.totals.hitRate, 8_000 / 10_000, 'the failed 50k-input request is not in the denominator')
})

test('DR-03: recorded costs are kept; only unledgered requests are estimated, at their hour and their tier', async () => {
  const overview = await loadUsageWorkspaceOverview(reader, groups, FILTER, options)
  const gpt54 = overview.models.find((row) => row.id === 'gpt-5.4')!
  const twin = estimateCost('gpt-5.4', 1_000, 100, 0, 0)!
  const tiered = estimateCost('gpt-5.4', 300_000, 100, 0, 0, { promptTokens: 300_000 })!
  close(tiered, 300_000 * 5 / 1_000_000 + 100 * 22.5 / 1_000_000, 'tier price')
  close(gpt54.costUsd, 10 + twin + tiered, 'gpt-5.4 = ledger $10 + the twin + the tiered request')
  const deepseek = overview.models.find((row) => row.id === 'deepseek-v4-flash')!
  close(deepseek.costUsd, 1_000_000 * 0.14 / 1_000_000, 'priced at 2026-09-09, before the 0.15 price')
  assert.ok(overview.ledger.costEstimated)

  // the same figures add up everywhere: ledger = Σ ranks = Σ days in the window
  close(sumCost(overview.models), overview.ledger.costUsd!, 'Σ models')
  close(sumCost(overview.keys), overview.ledger.costUsd!, 'Σ keys')
  close(sumCost(overview.channels), overview.ledger.costUsd!, 'Σ channels')
  close(sumCost(overview.clients), overview.ledger.costUsd!, 'Σ clients')
  close(sumCost(overview.daily), overview.ledger.costUsd!, 'Σ heatmap days')

  // the request page prices each unledgered request the same way
  const page = await loadUsageWorkspaceRequests(reader, reader, groups, { ...FILTER, model: 'gpt-5.4' }, { status: '', category: '', page: 1, pageSize: 100 }, options)
  close(sumCost(page.requests), gpt54.costUsd!, 'request page Σ = ledger')

  // the pure helpers: a partial group without per-request detail keeps its ledger and estimates the missing share
  const mixed = workspaceRowCost({ m: 'gpt-5.4', p: 'codex', n: 2, i: 2_000, ui: 2_000, o: 200, cr: 0, cw: 0, t: 2_200, cs: 10, cc: 1 })
  close(mixed.usd, 10 + twin, 'workspaceRowCost keeps the $10')
  const alone = estimateUncosted({ h: NOW - 4 * DAY, m: 'gpt-5.4', p: 'codex', n: 1, i: 300_000, ui: 300_000, o: 100, cr: 0, cw: 0, t: 300_100 })
  close(alone.usd, tiered, 'estimateUncosted picks the tier')
  assert.deepEqual(estimateUncosted({ h: NOW, m: 'mystery-model', p: 'codex', n: 3, i: 10, ui: 10, o: 1, cr: 0, cw: 0, t: 11 }), { usd: null, unpricedRequests: 3, estimated: false })
  assert.deepEqual(estimateUncosted({ h: NOW, m: 'mystery-model', p: 'codex', n: 1, i: 0, ui: 0, o: 0, cr: 0, cw: 0, t: 0 }), { usd: 0, unpricedRequests: 0, estimated: false })
})

test('DR-03: a tiered hour mixing short and long unledgered prompts prices each by its own tier', async () => {
  const at = NOW - 8 * DAY
  add({ at, model: 'gpt-5.4', key: 'key-t', input: 100_000, output: 0, cost: null })
  add({ at: at + 1, model: 'gpt-5.4', key: 'key-t', input: 400_000, output: 0, cost: null })
  try {
    const overview = await loadUsageWorkspaceOverview(reader, groups, { ...FILTER, keyId: 'key-t' }, options)
    const expected = estimateCost('gpt-5.4', 100_000, 0, 0, 0, { promptTokens: 100_000 })! + estimateCost('gpt-5.4', 400_000, 0, 0, 0, { promptTokens: 400_000 })!
    // an average prompt of 250k would price both below the tier: 500k × 2.5 instead of 100k × 2.5 + 400k × 5
    close(overview.ledger.costUsd, expected, 'per-request tiers')
  } finally {
    db.exec("DELETE FROM usage_events WHERE key_hash = 'key-t'; DELETE FROM usage_hourly_rollup WHERE key_hash = 'key-t'")
  }
})

test('DR-03: a tiered hour is split by prompt even when CPA sent no total_tokens (0)', async () => {
  const at = NOW - 8 * DAY
  add({ at, model: 'gpt-5.4', key: 'key-t', input: 100_000, output: 0, total: 0, cost: null })
  add({ at: at + 1, model: 'gpt-5.4', key: 'key-t', input: 400_000, output: 0, total: 0, cost: null })
  try {
    const filter = { ...FILTER, keyId: 'key-t' }
    const overview = await loadUsageWorkspaceOverview(reader, groups, filter, options)
    const expected = estimateCost('gpt-5.4', 100_000, 0, 0, 0, { promptTokens: 100_000 })! + estimateCost('gpt-5.4', 400_000, 0, 0, 0, { promptTokens: 400_000 })!
    close(overview.ledger.costUsd, expected, 'per-request tiers without total_tokens')
    const page = await loadUsageWorkspaceRequests(reader, reader, groups, filter, { status: '', category: '', page: 1, pageSize: 100 }, options)
    close(sumCost(page.requests), overview.ledger.costUsd!, 'request page Σ = ledger')
  } finally {
    db.exec("DELETE FROM usage_events WHERE key_hash = 'key-t'; DELETE FROM usage_hourly_rollup WHERE key_hash = 'key-t'")
  }
})

test('DR-19: the facet bar and the ledger list the same 未定价 models', async () => {
  const overview = await loadUsageWorkspaceOverview(reader, groups, FILTER, options)
  const facets = await loadUsageWorkspaceFacets(reader, groups, FILTER, options)
  assert.deepEqual(facets.totals.unpricedModels, overview.ledger.unpricedModels)
  assert.deepEqual(overview.ledger.unpricedModels, ['mystery-model'])
  assert.ok(!facets.totals.unpricedModels.includes('zz-dropped-model'), 'a tokenless failure is free, not unpriced')
})

test('DR-10: a row stamped after the current hour is in no total and no trend', async () => {
  add({ at: NOW + 3 * DAY, model: 'gpt-5.6-sol', input: 1_000, cached: 500, cost: 0.01 })
  try {
    const before = { requests: 10 }
    const overview = await loadUsageWorkspaceOverview(reader, groups, FILTER, options)
    assert.equal(overview.ledger.requests, before.requests)
    const page = await loadUsageWorkspaceRequests(reader, reader, groups, FILTER, { status: '', category: '', page: 1, pageSize: 100 }, options)
    assert.equal(page.total, before.requests)
    assert.equal(page.requests.length, before.requests)
    const facets = await loadUsageWorkspaceFacets(reader, groups, FILTER, options)
    assert.equal(facets.totals.requests, before.requests)
    const perf = await loadPerformanceReport(reader, groups, scope, { timeZone: TZ, now: NOW })
    assert.equal(perf.totals.requests, perf.trend.reduce((total, point) => total + point.requests, 0))
    assert.equal(perf.totals.requests, overview.ledger.requests, 'perf counts read the ledger rows')
    const cache = await loadCacheSummary(reader, groups, scope, { timeZone: TZ, now: NOW })
    assert.equal(cache.totals.requests, cache.trend.reduce((total, point) => total + point.requests, 0))
  } finally {
    db.exec(`DELETE FROM usage_events WHERE timestamp_ms > ${NOW + DAY}; DELETE FROM usage_hourly_rollup WHERE hour_ms > ${NOW + DAY}`)
  }
})

test('DR-02: the dashboard gateway 24h and the 近 24 小时 ledger count the same requests at the same instant', async () => {
  const cut = Math.ceil((NOW - DAY) / HOUR) * HOUR
  add({ at: NOW - DAY + 60_000, model: 'gpt-5.6-sol', key: 'key-t' }) // rolling 24h only: before the ledger's whole-hour cut
  add({ at: cut, model: 'gpt-5.6-sol', key: 'key-t' })
  add({ at: NOW - 1_000, model: 'gpt-5.6-sol', key: 'key-t' }) // inside the live lag of the 1h / 6h ranges
  try {
    const ledger = await loadDashboardReport(reader, groups, 1, '', NOW)
    const gateway = await createOverviewReader(reader, () => NOW).read('24h')
    assert.equal(Number((ledger.summary as Record<string, unknown>).requests), 2)
    assert.equal(gateway.gateway.requests, 2)
  } finally {
    db.exec("DELETE FROM usage_events WHERE key_hash = 'key-t'; DELETE FROM usage_hourly_rollup WHERE key_hash = 'key-t'")
  }
})

test('DR-16: one "whose problem" word per category on 总览 / 请求 and 性能', async () => {
  const overview = await loadUsageWorkspaceOverview(reader, groups, FILTER, options)
  const perf = await loadPerformanceReport(reader, groups, scope, { timeZone: TZ, now: NOW })
  const page = await loadUsageWorkspaceRequests(reader, reader, groups, FILTER, { status: '', category: '', page: 1, pageSize: 20 }, options)
  for (const failure of [...overview.failures, ...page.errorCategories]) {
    assert.equal(failure.owner, ERROR_CATEGORIES[failure.category].owner, failure.category)
    const perfRow = perf.errors.find((row) => row.category === failure.category)
    assert.equal(perfRow?.owner, failure.owner, failure.category)
  }
  assert.equal(overview.failures.find((row) => row.category === 'quota_exhausted')?.owner, '需换号')
  assert.equal(overview.failures.find((row) => row.category === 'other')?.owner, '待查')
})

test('DR-11: legacy daily series bucket by the local calendar day of hour_ms, not the UTC day_text', async () => {
  // the server's local clock (config.quotaTimeZone defaults to it, and the series cells are laid on it): shortly
  // after local midnight of NOW's day — on an Asia/Shanghai host 2026-09-30T17:30Z, still 09-30 in UTC day_text
  const midnight = new Date(NOW)
  midnight.setHours(0, 0, 0, 0)
  const at = midnight.getTime() + Math.min(90 * 60_000, Math.floor((NOW - midnight.getTime()) / 2))
  const local = new Date(at)
  const day = `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, '0')}-${String(local.getDate()).padStart(2, '0')}`
  add({ at, model: 'gpt-5.6-sol', key: 'key-t', cost: 0.01 })
  try {
    const overview = await loadUsageOverviewReport(reader, groups, 1, 'key-t', NOW)
    const page = await loadUsagePageReport(reader, groups, 1, 'key-t', TZ, NOW)
    // the no-rollup fallback of /api/usage-page (a reader that cannot rewrite onto raw events) uses the same day
    const noRollup = {
      async run(operations: readonly ReadOperation[]) {
        if (operations.some((op) => op.sql.includes('usage_hourly_rollup'))) throw new Error('no such table: usage_hourly_rollup')
        return reader.run(operations)
      },
    }
    const fallback = await loadUsagePageReport(noRollup, groups, 1, 'key-t', TZ, NOW)
    for (const [label, report] of [['usage-overview', overview], ['usage-page', page], ['usage-page no rollup', fallback]] as const) {
      const daily = (report as { daily: Array<{ day: string; requests: number }> }).daily
      assert.equal(daily.reduce((total, point) => total + point.requests, 0), 1, `${label}: the request is in the series`)
      assert.equal(daily.find((point) => point.day === day)?.requests, 1, `${label}: on its local day ${day}`)
    }
  } finally {
    db.exec("DELETE FROM usage_events WHERE key_hash = 'key-t'; DELETE FROM usage_hourly_rollup WHERE key_hash = 'key-t'")
  }
})
