import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import express from 'express'
import type { ConsoleGroup } from './groups.js'
import type { ReadOperation } from './sqliteReadWorker.js'
import {
  bucketPlan, bucketStart, ERROR_CATEGORIES, loadPerformanceReport, nearestRank, parseUsageScope, registerPerfRoutes, tzOffsetMs,
} from './perfReports.js'
import { UsageFilterError } from './usageWorkspaceRoutes.js'
import { migrateUsageRollup } from './usageRollup.js'

/*
 * 用量 · 性能 (/api/usage-performance): exact nearest-rank percentiles per model / channel / bucket, success
 * rate, error categories in plain words, and the shared window / bucket / filter rules the cache tab reuses.
 */

const HOUR = 3_600_000
const NOW = Date.parse('2026-10-02T06:32:08.000Z') // 14:32:08 Asia/Shanghai

const EVENTS_DDL = `
  CREATE TABLE usage_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT UNIQUE, timestamp TEXT NOT NULL, key_hash TEXT,
    provider TEXT NOT NULL, model TEXT NOT NULL, model_group TEXT NOT NULL, endpoint TEXT NOT NULL,
    success INTEGER NOT NULL, status_code INTEGER NOT NULL, latency_ms INTEGER NOT NULL, ttft_ms INTEGER NOT NULL,
    input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, reasoning_tokens INTEGER NOT NULL,
    cached_tokens INTEGER NOT NULL, total_tokens INTEGER NOT NULL, timestamp_ms INTEGER NOT NULL DEFAULT 0,
    error_category TEXT NOT NULL DEFAULT '', cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    user_agent TEXT NOT NULL DEFAULT '', client_type TEXT NOT NULL DEFAULT '', cost_usd REAL
  );`

type Ev = {
  at: number
  model?: string
  provider?: string
  key?: string | null
  ok?: boolean
  status?: number
  category?: string
  latency?: number
  ttft?: number
  client?: string
  ua?: string
}

function fixture() {
  const db = new DatabaseSync(':memory:')
  db.exec(EVENTS_DDL)
  // counts read the hourly rollup (kept by the production triggers), percentiles read the raw events
  migrateUsageRollup(db)
  const insert = db.prepare(`INSERT INTO usage_events (timestamp, timestamp_ms, key_hash, provider, model, model_group, endpoint,
    success, status_code, latency_ms, ttft_ms, input_tokens, output_tokens, reasoning_tokens, cached_tokens, total_tokens,
    error_category, user_agent, client_type) VALUES (?, ?, ?, ?, ?, '', '/v1/chat/completions', ?, ?, ?, ?, 10, 5, 0, 0, 15, ?, ?, ?)`)
  const add = (e: Ev) => insert.run(
    new Date(e.at).toISOString(), e.at, e.key ?? 'key-a', e.provider ?? 'codex', e.model ?? 'gpt-5.6-sol',
    e.ok === false ? 0 : 1, e.status ?? (e.ok === false ? 500 : 200), e.latency ?? 1000, e.ttft ?? 300,
    e.category ?? '', e.ua ?? '', e.client ?? 'codex-cli',
  )
  const reader = { run: async (ops: readonly ReadOperation[]) => ops.map((op) => db.prepare(op.sql)[op.method](...(op.params ?? []))) }
  return { db, add, reader }
}

const groups: ConsoleGroup[] = [
  { id: 'codex', name: 'Codex', color: '#000', kind: 'oauth', models: [] },
  { id: 'mox-aigw', name: 'Mox', color: '#000', kind: 'compat', models: [] },
]
const scope = (patch: Record<string, string> = {}) => parseUsageScope({ days: '7', ...patch }, 90)
const load = (reader: ReturnType<typeof fixture>['reader'], patch: Record<string, string> = {}) =>
  loadPerformanceReport(reader, groups, scope(patch), { timeZone: 'Asia/Shanghai', now: NOW })

/** reference nearest-rank percentile */
const pct = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[nearestRank(sorted.length, p) - 1]
}

test('scope: the workspace filter rule — 24h/7d/30d/90d within retention, else 7 d; bad values refused', () => {
  assert.deepEqual(parseUsageScope({}, 90), { days: 7, keyId: '', model: '', client: '', provider: '', currentOnly: false })
  assert.equal(parseUsageScope({ currentOnly: '1' }, 90).currentOnly, true)
  assert.equal(parseUsageScope({ currentOnly: 'no' }, 90).currentOnly, false)
  for (const days of ['1', '7', '30', '90']) assert.equal(parseUsageScope({ days }, 90).days, Number(days))
  for (const days of ['400', '0', 'abc', '14']) assert.equal(parseUsageScope({ days }, 90).days, 7)
  assert.equal(parseUsageScope({ hours: '24' }, 90).days, 7) // the window is `days`; old ?hours= links land on the default
  assert.equal(parseUsageScope({ days: '30' }, 14).days, 7)
  const s = parseUsageScope({ model: ['  gpt-5  ', 'x'], provider: ' OpenAI-Compatible-Mox ' }, 90)
  assert.equal(s.model, 'gpt-5')
  assert.equal(s.provider, 'openai-compatible-mox')
  assert.throws(() => parseUsageScope({ client: 'x'.repeat(500) }, 90), UsageFilterError)
  assert.throws(() => parseUsageScope({ model: 'a\u0000b' }, 90), UsageFilterError)
})

test('buckets: 24h hourly, 7d six-hourly, 30d daily, aligned to the console wall clock', () => {
  assert.equal(tzOffsetMs('Asia/Shanghai', NOW), 8 * HOUR)
  assert.equal(tzOffsetMs('UTC', NOW), 0)
  assert.equal(tzOffsetMs('Not/AZone', NOW), 0)
  assert.equal(bucketPlan(1, NOW, 'Asia/Shanghai').bucketMs, HOUR)
  const week = bucketPlan(7, NOW, 'Asia/Shanghai')
  assert.equal(week.bucketMs, 6 * HOUR)
  // last 6h bucket starts 12:00 Shanghai = 04:00Z
  assert.equal(new Date(bucketStart(week, week.last)).toISOString(), '2026-10-02T04:00:00.000Z')
  assert.equal(week.last - week.first + 1, 29)
  const month = bucketPlan(30, NOW, 'Asia/Shanghai')
  assert.equal(new Date(bucketStart(month, month.last)).toISOString(), '2026-10-01T16:00:00.000Z') // 00:00 Shanghai
  assert.ok(bucketStart(month, month.first) <= month.fromMs && bucketStart(month, month.first + 1) > month.fromMs)
})

test('percentiles: exact nearest rank overall, per model, per channel and per bucket; 0ms means not reported', async () => {
  const f = fixture()
  const latA: number[] = []
  const latB: number[] = []
  const ttftA: number[] = []
  for (let i = 0; i < 41; i += 1) {
    const latency = 200 + ((i * 7919) % 4001)
    const ttft = i % 5 === 0 ? 0 : 50 + ((i * 104729) % 900) // every 5th call is non-streaming: no first token
    latA.push(latency)
    if (ttft > 0) ttftA.push(ttft)
    f.add({ at: NOW - 2 * HOUR - i * 1000, model: 'gpt-5.6-sol', latency, ttft })
  }
  for (let i = 0; i < 9; i += 1) {
    const latency = 5_000 + i * 1_000
    latB.push(latency)
    f.add({ at: NOW - 30 * HOUR, model: 'mox/claude-opus-4-6', provider: 'openai-compatible-mox-aigw', latency, ttft: 900 })
  }
  f.add({ at: NOW - 2 * HOUR, ok: false, latency: 99_999, ttft: 99_999, category: 'rate_limited', status: 429 })

  const r = await load(f.reader)
  assert.equal(r.totals.requests, 51)
  assert.equal(r.totals.errors, 1)
  assert.equal(r.totals.successRate, 50 / 51)
  assert.deepEqual(r.totals.latency, { n: 50, p50: pct([...latA, ...latB], 0.5), p95: pct([...latA, ...latB], 0.95) })

  const gpt = r.byModel.find((m) => m.id === 'gpt-5.6-sol')!
  assert.deepEqual(gpt.latency, { n: 41, p50: pct(latA, 0.5), p95: pct(latA, 0.95) })
  assert.deepEqual(gpt.ttft, { n: ttftA.length, p50: pct(ttftA, 0.5), p95: pct(ttftA, 0.95) })
  assert.equal(gpt.requests, 42)
  assert.equal(gpt.errors, 1)
  // channel prefix stripped from the model, and both provider spellings fold into one channel
  const opus = r.byModel.find((m) => m.id === 'claude-opus-4-6')!
  assert.deepEqual(opus.latency, { n: 9, p50: 9_000, p95: 13_000 })
  const mox = r.byChannel.find((c) => c.id === 'mox-aigw')!
  assert.equal(mox.label, 'Mox 中转')
  assert.equal(mox.requests, 9)
  assert.equal(mox.successRate, 1)

  const plan = bucketPlan(7, NOW, 'Asia/Shanghai')
  const lastBucket = r.trend.at(-1)!
  assert.equal(r.trend.length, plan.last - plan.first + 1)
  assert.equal(lastBucket.t, bucketStart(plan, plan.last))
  assert.equal(lastBucket.requests, 42)
  assert.equal(lastBucket.errorRate, 1 / 42)
  assert.deepEqual(lastBucket.latency, { n: 41, p50: pct(latA, 0.5), p95: pct(latA, 0.95) })
  // an empty bucket is a gap, never a fake 0
  const empty = r.trend.find((p) => p.requests === 0)!
  assert.equal(empty.errorRate, null)
  assert.equal(empty.latency, null)
})

test('filters: key, canonical model, recovered client type, provider alias; removed channels counted by default, left out when currentOnly', async () => {
  const f = fixture()
  f.add({ at: NOW - HOUR, key: 'key-a', model: 'gpt-5.6-sol' })
  f.add({ at: NOW - HOUR, key: 'key-b', model: 'mox/gpt-5.6-sol', provider: 'openai-compatible-mox-aigw', client: 'other', ua: 'omp/1.2.3' })
  f.add({ at: NOW - HOUR, key: 'key-b', model: 'gpt-5.6-sol', provider: 'deleted-channel' })
  f.add({ at: NOW - HOUR, key: 'key-b', model: 'gpt-5.6-sol', provider: 'openai-compatible-retired', latency: 4000 })
  f.add({ at: NOW - 8 * 24 * HOUR, key: 'key-a' }) // outside 7d

  // default: every channel — history is history
  const all = await load(f.reader)
  assert.equal(all.totals.requests, 4)
  assert.equal(all.filters.currentOnly, false)
  assert.equal((await load(f.reader, { keyId: 'key-b' })).totals.requests, 3)
  assert.equal((await load(f.reader, { model: 'gpt-5.6-sol' })).totals.requests, 4)
  assert.equal((await load(f.reader, { client: 'omp' })).totals.requests, 1)
  assert.equal((await load(f.reader, { provider: 'mox-aigw' })).totals.requests, 1)
  assert.equal((await load(f.reader, { provider: 'openai-compatible-mox-aigw' })).totals.requests, 1)
  assert.equal((await load(f.reader, { provider: 'deleted-channel' })).totals.requests, 1)
  // removed channels keep their id (compat prefix folded like the 总览 ranks) and carry the 已移除 marker
  assert.deepEqual(all.byChannel.map((c) => [c.id, c.removed]).sort(), [['codex', false], ['deleted-channel', true], ['mox-aigw', false], ['retired', true]])
  assert.equal(all.byChannel.find((c) => c.id === 'retired')?.latency?.p95, 4000, 'percentile partitions use the same folded id')
  // no current channel at all: the default still counts everything (it never needed the channel list)
  assert.equal((await loadPerformanceReport(f.reader, [], scope(), { timeZone: 'UTC', now: NOW })).totals.requests, 4)

  // opt-in 只看当前渠道: removed channels left out, fail-closed without channels
  assert.equal((await load(f.reader, { currentOnly: '1' })).totals.requests, 2)
  assert.equal((await load(f.reader, { currentOnly: '1', keyId: 'key-b' })).totals.requests, 1)
  assert.equal((await load(f.reader, { currentOnly: '1', provider: 'deleted-channel' })).totals.requests, 0)
  assert.equal((await loadPerformanceReport(f.reader, [], scope({ currentOnly: '1' }), { timeZone: 'UTC', now: NOW })).totals.requests, 0)
})

test('errors: grouped by category with plain words, owner and status codes; empty data has no fake zeros', async () => {
  const f = fixture()
  for (let i = 0; i < 3; i += 1) f.add({ at: NOW - HOUR, ok: false, status: 429, category: 'rate_limited' })
  f.add({ at: NOW - HOUR, ok: false, status: 403, category: 'auth_failed' })
  f.add({ at: NOW - HOUR, ok: false, status: 401, category: 'auth_failed' })
  f.add({ at: NOW - HOUR, ok: false, status: 400, category: '' })
  const r = await load(f.reader)
  assert.deepEqual(r.errors.map((e) => [e.category, e.label, e.owner, e.count]), [
    ['rate_limited', '上游限流', '可重试', 3],
    ['auth_failed', '鉴权失败', '需授权', 2],
    ['other', '其他', '待查', 1],
  ])
  assert.deepEqual(r.errors[1].codes, [{ code: 401, count: 1 }, { code: 403, count: 1 }])
  assert.equal(r.errors[0].share, 0.5)
  assert.equal(r.totals.successRate, 0)
  assert.equal(r.totals.latency, null)
  for (const key of ['rate_limited', 'auth_failed', 'upstream_5xx', 'client_cancelled', 'context_too_large']) assert.ok(ERROR_CATEGORIES[key])

  const none = await load(fixture().reader)
  assert.equal(none.totals.requests, 0)
  assert.equal(none.totals.successRate, null)
  assert.equal(none.totals.latency, null)
  assert.ok(none.trend.every((p) => p.errorRate === null && p.latency === null))
})

test('route: GET /api/usage-performance returns the report, caches it, and fails as 503 with a code', async () => {
  const f = fixture()
  f.add({ at: NOW - HOUR })
  let calls = 0
  const reader = { run: async (ops: readonly ReadOperation[]) => { calls += 1; return f.reader.run(ops) } }
  const app = express()
  registerPerfRoutes(app, { reader, groups: async () => groups, timeZone: 'Asia/Shanghai', retentionDays: 90, now: () => NOW })
  let broken = false
  const failing = express()
  registerPerfRoutes(failing, { reader: { run: async () => { broken = true; throw new Error('disk') } }, groups: async () => groups, timeZone: 'UTC', retentionDays: 90 })
  const servers = [app.listen(0, '127.0.0.1'), failing.listen(0, '127.0.0.1')]
  await Promise.all(servers.map((s) => new Promise((r) => s.once('listening', r))))
  const url = (i: number, q: string) => `http://127.0.0.1:${(servers[i].address() as { port: number }).port}/api/usage-performance${q}`
  try {
    const first = await fetch(url(0, '?days=1'))
    assert.equal(first.status, 200)
    const body = await first.json() as { days: number; totals: { requests: number }; bucketMs: number }
    assert.equal(body.days, 1)
    assert.equal(body.bucketMs, HOUR)
    assert.equal(body.totals.requests, 1)
    await fetch(url(0, '?days=1'))
    assert.equal(calls, 1)
    const refused = await fetch(url(0, `?days=1&client=${'x'.repeat(65)}`))
    assert.equal(refused.status, 400)
    assert.deepEqual(await refused.json(), { error: '筛选参数 client 不合法', code: 'invalid_filter', field: 'client' })
    assert.equal(calls, 1)
    const bad = await fetch(url(1, ''))
    assert.equal(bad.status, 503)
    assert.equal(broken, true)
    assert.deepEqual(await bad.json(), { error: '性能报表暂时读不出来', code: 'report_unavailable' })
  } finally {
    await Promise.all(servers.map((s) => new Promise((r) => s.close(r))))
  }
})
