import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import express from 'express'
import {
  CHANNEL_BUCKET_MS,
  CHANNEL_SPAN_MS,
  createOverviewReader,
  markRemovedChannels,
  OVERVIEW_LAG_MS,
  OVERVIEW_RANGES,
  parseOverviewRange,
  percentile,
  registerOverviewRoutes,
  shortChannelName,
  type OverviewReader,
} from './overviewRoutes.js'
import type { ReadOperation } from './sqliteReadWorker.js'

const HOUR = 3_600_000
const NOW = Date.UTC(2026, 9, 2, 6, 30, 0, 500)
const END = NOW - OVERVIEW_LAG_MS

function fixture() {
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE usage_events (id INTEGER PRIMARY KEY, timestamp_ms INTEGER NOT NULL, key_hash TEXT, provider TEXT NOT NULL,
    success INTEGER NOT NULL, latency_ms INTEGER NOT NULL, ttft_ms INTEGER NOT NULL)`)
  db.exec(`CREATE TABLE usage_hourly_rollup (hour_ms INTEGER NOT NULL, key_hash TEXT NOT NULL, success INTEGER NOT NULL, request_count INTEGER NOT NULL)`)
  const insert = db.prepare('INSERT INTO usage_events (timestamp_ms, key_hash, provider, success, latency_ms, ttft_ms) VALUES (?, ?, ?, ?, ?, ?)')
  const roll = db.prepare('INSERT INTO usage_hourly_rollup (hour_ms, key_hash, success, request_count) VALUES (?, ?, ?, ?)')
  let runs = 0
  const reader: OverviewReader = {
    async run(operations: readonly ReadOperation[]) {
      runs += 1
      return operations.map((op) => {
        const stmt = db.prepare(op.sql)
        const params = (op.params ?? []) as Array<string | number>
        return op.method === 'get' ? stmt.get(...params) : stmt.all(...params)
      })
    },
  }
  return {
    db,
    reader,
    runs: () => runs,
    add: (ms: number, opts: { key?: string | null; provider?: string; ok?: boolean; latency?: number; ttft?: number } = {}) =>
      insert.run(ms, opts.key === undefined ? 'k1' : opts.key, opts.provider ?? 'openai-compatible-openrouter', opts.ok === false ? 0 : 1, opts.latency ?? 100, opts.ttft ?? 0),
    roll: (hourMs: number, key: string, ok: boolean, n: number) => roll.run(hourMs, key, ok ? 1 : 0, n),
  }
}

test('overview: range parsing is strict, default 1h', () => {
  assert.equal(parseOverviewRange(undefined), '1h')
  assert.equal(parseOverviewRange(''), '1h')
  assert.equal(parseOverviewRange('6h'), '6h')
  assert.equal(parseOverviewRange(['24h']), '24h')
  assert.equal(parseOverviewRange('7d'), null)
  assert.equal(parseOverviewRange('__proto__'), null)
})

test('overview: nearest-rank percentile, null on empty; compat provider names fold to the channel name', () => {
  assert.equal(percentile([], 0.95), null)
  assert.equal(percentile([5], 0.95), 5)
  assert.equal(percentile(Array.from({ length: 20 }, (_, i) => (i + 1) * 100), 0.95), 1900)
  assert.equal(percentile([1, 2, 3, 4], 0.5), 2)
  assert.equal(shortChannelName('openai-compatible-openrouter'), 'openrouter')
  assert.equal(shortChannelName(' Codex '), 'codex')
})

test('overview: rolling full-width buckets, zero-filled, oldest first; empty window never fakes 0%', async () => {
  const empty = await createOverviewReader(fixture().reader, () => NOW).read('1h')
  const { spanMs, bucketMs } = OVERVIEW_RANGES['1h']
  assert.equal(empty.gateway.series.requests.length, spanMs / bucketMs)
  assert.equal(empty.bucketMs, bucketMs)
  assert.equal(empty.from, END - spanMs)
  assert.equal(empty.to, END)
  assert.ok(empty.gateway.series.requests.every((n) => n === 0))
  assert.ok(empty.gateway.series.p95Ms.every((v) => v === null))
  assert.equal(empty.gateway.successRate, null)
  assert.equal(empty.gateway.p95Ms, null)
  assert.equal(empty.gateway.peak, null)
  assert.equal(empty.gateway.activeKeys, 0)
})

test('overview: counts, errors, percentiles, peak rpm and active keys over the window', async () => {
  const f = fixture()
  const last = END - 30_000 // inside the newest bucket
  for (let i = 1; i <= 20; i += 1) f.add(last - i, { latency: i * 100, ttft: i * 10, key: i % 2 ? 'k1' : 'k2' })
  f.add(last, { ok: false, latency: 99_999, key: 'k3' })
  f.add(END - 10 * 60_000, { latency: 50 })
  f.add(END + 500, {}) // inside the ingest lag: not drawn yet
  f.add(END - OVERVIEW_RANGES['1h'].spanMs - 1, {}) // older than the window
  const o = await createOverviewReader(f.reader, () => NOW).read('1h')
  assert.equal(o.gateway.requests, 22)
  assert.equal(o.gateway.errors, 1)
  assert.equal(o.gateway.successRate, 21 / 22)
  assert.equal(o.gateway.activeKeys, 3)
  const s = o.gateway.series
  assert.deepEqual([s.requests.at(-1), s.errors.at(-1), s.p95Ms.at(-1)], [21, 1, 1900]) // failures never count toward latency
  assert.deepEqual(o.gateway.peak, { rpm: 21, at: o.to - o.bucketMs })
  assert.equal(o.gateway.p50Ms, 1000) // 21 successes: 50, 100…2000 → 11th
  assert.equal(o.gateway.ttftP50Ms, 100) // ttft 0 (not reported) is skipped: 10…200 → 10th
  // 6h stays at one-minute samples; 24h uses hour buckets and still reports the peak per minute
  const six = await createOverviewReader(f.reader, () => NOW).read('6h')
  assert.equal(six.gateway.series.requests.length, 360)
  const day = await createOverviewReader(f.reader, () => NOW).read('24h')
  assert.equal(day.gateway.series.requests.length, 24)
  // 24h has no live lag: the request at END + 500 is in its current hour (22 + 1)
  assert.equal(day.gateway.series.requests.at(-1), 23)
  assert.equal(day.gateway.peak?.rpm, Math.round((23 / 60) * 10) / 10)
})

test('overview: channel health is 36 × 5-min ticks over 3h per provider, busiest first', async () => {
  const f = fixture()
  f.add(END - 60_000, { provider: 'codex', latency: 300 })
  f.add(END - 60_000, { provider: 'codex', ok: false })
  f.add(END - 2 * HOUR, { provider: 'OpenAI-Compatible-OpenRouter ', latency: 700 })
  f.add(END - 2 * HOUR + 1, { provider: 'openai-compatible-openrouter', latency: 900 })
  f.add(END - 2 * HOUR + 2, { provider: 'openai-compatible-openrouter', latency: 800 })
  f.add(END - CHANNEL_SPAN_MS - 1, { provider: 'antigravity' }) // older than 3h
  const o = await createOverviewReader(f.reader, () => NOW).read('1h')
  assert.equal(o.channels.rows.length, 2)
  const [or, cx] = o.channels.rows
  assert.equal(or.name, 'openrouter')
  assert.equal(or.provider, 'openai-compatible-openrouter')
  assert.equal(or.ticks.length, CHANNEL_SPAN_MS / CHANNEL_BUCKET_MS)
  assert.equal(or.requests, 3)
  assert.equal(or.p95Ms, 900)
  assert.equal(or.ticks.reduce((a, b) => a + b, 0), 3)
  assert.equal(cx.name, 'codex')
  assert.deepEqual([cx.requests, cx.errors, cx.p95Ms], [2, 1, 300])
  assert.equal(cx.bad.at(-1), 1)
  assert.equal(cx.lastAt, END - 60_000)
})

test('overview: a provider that is no longer a current channel keeps its row, marked removed; unknown channel list → null', async () => {
  const f = fixture()
  f.add(END - 60_000, { provider: 'codex' })
  f.add(END - 2 * HOUR, { provider: 'openai-compatible-openrouter' })
  f.add(END - HOUR, { provider: 'antigravity' })
  const o = await createOverviewReader(f.reader, () => NOW).read('1h')
  const groups = [
    { id: 'codex', name: 'Codex', color: '#000', kind: 'oauth' as const, models: [] },
    { id: 'openrouter', name: 'openrouter', color: '#000', kind: 'compat' as const, models: [] },
  ]
  const marked = markRemovedChannels(o, groups)
  assert.deepEqual(marked.channels.rows.map((r) => [r.name, r.removed]).sort(), [['antigravity', true], ['codex', false], ['openrouter', false]])
  assert.equal(marked.gateway.requests, o.gateway.requests, 'the marker never changes a count')
  assert.ok(markRemovedChannels(o, null).channels.rows.every((r) => r.removed === null))
})

test('overview: per-Key 24 hourly buckets from the rollup, current hour last, empty keys skipped', async () => {
  const f = fixture()
  const hour = Math.floor(NOW / HOUR) * HOUR
  f.roll(hour, 'k1', true, 5)
  f.roll(hour, 'k1', false, 2)
  f.roll(hour - 23 * HOUR, 'k1', true, 1)
  f.roll(hour - 24 * HOUR, 'k1', true, 9) // outside 24 buckets
  f.roll(hour - 3 * HOUR, 'k2', true, 40)
  f.roll(hour, '', true, 7) // unattributed
  const o = await createOverviewReader(f.reader, () => NOW).read('1h')
  assert.equal(o.keys.bucketMs, HOUR)
  assert.equal(o.keys.from, hour - 23 * HOUR)
  assert.deepEqual(o.keys.rows.map((r) => r.id), ['k2', 'k1'])
  const k1 = o.keys.rows[1]
  assert.equal(k1.requests.length, 24)
  assert.deepEqual([k1.requests[0], k1.requests[23], k1.errors[23], k1.total, k1.totalErrors], [1, 7, 2, 8, 2])
  assert.equal(o.keys.rows[0].requests[20], 40)
})

test('overview: results are shared within the TTL and recomputed after it', async () => {
  const f = fixture()
  let clock = NOW
  const reader = createOverviewReader(f.reader, () => clock)
  const first = await reader.read('1h')
  const runs = f.runs()
  f.add(END - 1_000, {})
  const again = await reader.read('1h')
  assert.equal(f.runs(), runs, 'cached within the TTL')
  assert.equal(again.gateway.requests, first.gateway.requests)
  clock += OVERVIEW_RANGES['1h'].ttlMs + 20_000
  const later = await reader.read('1h')
  assert.ok(f.runs() > runs)
  assert.equal(later.gateway.requests, 1)
})

test('overview route: 400 on an unknown range, 503 with a code when the read fails, no-store always', async () => {
  const app = express()
  let fail = false
  const f = fixture()
  registerOverviewRoutes(app, {
    reader: {
      run: (ops) => (fail ? Promise.reject(new Error('database is locked')) : f.reader.run(ops)),
    },
  })
  const server = app.listen(0)
  try {
    const port = (server.address() as { port: number }).port
    const bad = await fetch(`http://127.0.0.1:${port}/api/overview?range=7d`)
    assert.equal(bad.status, 400)
    assert.equal((await bad.json() as { code: string }).code, 'invalid_range')
    const ok = await fetch(`http://127.0.0.1:${port}/api/overview?range=6h`)
    assert.equal(ok.status, 200)
    assert.equal(ok.headers.get('cache-control'), 'no-store')
    const body = await ok.json() as { range: string; gateway: { series: { requests: unknown[] } } }
    assert.equal(body.range, '6h')
    assert.equal(body.gateway.series.requests.length, 360)
    fail = true
    const down = await fetch(`http://127.0.0.1:${port}/api/overview?range=24h`)
    assert.equal(down.status, 503)
    assert.deepEqual(await down.json(), { error: '概览数据暂不可用', code: 'overview_unavailable' })
  } finally {
    server.close()
  }
})

test('overview 24h: the ledger cut (first whole hour after now − 24h), so the gateway and 近 24 小时 count the same requests', async () => {
  const f = fixture()
  const cut = Math.ceil((NOW - 24 * HOUR) / HOUR) * HOUR
  f.add(NOW - 24 * HOUR + 60_000) // inside a rolling 24h, before the ledger's whole-hour start
  f.add(cut) // first counted instant
  f.add(END - 1_000)
  f.add(NOW - 1_000) // inside the live lag: the ledger counts it, so the 24h figure does too
  const day = await createOverviewReader(f.reader, () => NOW).read('24h')
  assert.equal(day.from, cut)
  assert.equal(day.to, NOW, '24h ends at now, as the ledger does (no live lag)')
  assert.equal(day.gateway.requests, 3)
  assert.equal(day.gateway.series.requests.length, 24)
  assert.equal(day.gateway.series.requests[0], 1, 'bucket 0 starts at the cut')
  assert.equal(day.gateway.series.requests.at(-1), 2, 'the current, partial hour is the last bucket')
  // 1h / 6h stay rolling live telemetry, lagged
  const hour = await createOverviewReader(f.reader, () => NOW).read('1h')
  assert.equal(hour.from, END - HOUR)
  assert.equal(hour.to, END)
  assert.equal(hour.gateway.requests, 1, 'the request inside the lag is not in the 1h live window')
})

test('overview: latency 0 means "not reported" — excluded from p50 / p95 (gateway, buckets and channels), never a measured 0', async () => {
  const f = fixture()
  for (let i = 0; i < 19; i += 1) f.add(END - 60_000 - i, { latency: 0, provider: 'codex' })
  f.add(END - 60_000 - 50, { latency: 1_000, provider: 'codex' })
  f.add(END - 30 * 60_000, { latency: 0, provider: 'antigravity' })
  const o = await createOverviewReader(f.reader, () => NOW).read('1h')
  assert.equal(o.gateway.requests, 21, 'unreported latency still counts as a request')
  assert.equal(o.gateway.successRate, 1)
  assert.equal(o.gateway.p95Ms, 1_000)
  assert.equal(o.gateway.p50Ms, 1_000)
  assert.equal(o.gateway.series.p95Ms.at(-2), 1_000)
  assert.equal(o.gateway.series.p95Ms.at(-30), null, 'a bucket with only unreported latencies has no p95')
  const codex = o.channels.rows.find((r) => r.name === 'codex')!
  assert.equal(codex.p95Ms, 1_000)
  assert.equal(o.channels.rows.find((r) => r.name === 'antigravity')!.p95Ms, null)
})

test('overview: alias spellings of one channel are one row (x and openai-compatible-x)', async () => {
  const f = fixture()
  f.add(END - 60_000, { provider: 'x', latency: 100 })
  f.add(END - 2 * 60_000, { provider: 'openai-compatible-x', latency: 300 })
  f.add(END - 3 * 60_000, { provider: 'openai-compatible-x', ok: false })
  const o = await createOverviewReader(f.reader, () => NOW).read('1h')
  assert.equal(o.channels.rows.length, 1)
  const [row] = o.channels.rows
  assert.deepEqual([row.name, row.provider, row.requests, row.errors, row.p95Ms], ['x', 'openai-compatible-x', 3, 1, 300])
  assert.equal(row.ticks.reduce((a, b) => a + b, 0), 3)
  const marked = markRemovedChannels(o, [{ id: 'x', name: 'x', color: '#000', kind: 'compat', models: [] }])
  assert.equal(marked.channels.rows[0].removed, false)
})
