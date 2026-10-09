import './testDataDir.js'

import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import express from 'express'
import {
  ChannelHealthError, HEALTH_SLOTS, createChannelHealthService, loadChannelHealth, parseHealthHours, providerAliases, registerChannelHealthRoutes,
  type HealthChannelInput,
} from './channelHealth.js'
import type { DiscoveryState } from './modelSync.js'
import type { ReadOperation } from './sqliteReadWorker.js'
import {
  classifyChannel, countChannels, discoveryCell, discoveryErrorWords, errorWords, hostOf, lastErrorCell, middleEllipsis, poolSlots, suggestName,
  type ChannelHealthItem, type ChannelLike,
} from '../src/features/channels/channelModel.js'

const HOUR = 3_600_000
const NOW = Date.UTC(2026, 9, 2, 6, 30, 0)

/** The columns channelHealth reads, with the real table/rollup names (the read pool runs the same SQL). */
function fixture() {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE usage_events (id INTEGER PRIMARY KEY, timestamp_ms INTEGER NOT NULL, provider TEXT NOT NULL, success INTEGER NOT NULL,
      status_code INTEGER NOT NULL DEFAULT 200, latency_ms INTEGER NOT NULL DEFAULT 0, error_category TEXT NOT NULL DEFAULT '', error_detail TEXT NOT NULL DEFAULT '');
    CREATE INDEX idx_usage_timestamp_ms ON usage_events(timestamp_ms);
    CREATE INDEX idx_usage_success_timestamp_ms ON usage_events(success, timestamp_ms);
    CREATE TABLE usage_hourly_rollup (hour_ms INTEGER NOT NULL, provider TEXT NOT NULL, request_count INTEGER NOT NULL);
  `)
  const insert = db.prepare('INSERT INTO usage_events (timestamp_ms, provider, success, status_code, latency_ms, error_category, error_detail) VALUES (?, ?, ?, ?, ?, ?, ?)')
  const rollup = db.prepare('INSERT INTO usage_hourly_rollup (hour_ms, provider, request_count) VALUES (?, ?, 1)')
  const add = (at: number, provider: string, ok: boolean, extra: { status?: number; latency?: number; category?: string; detail?: string } = {}) => {
    insert.run(at, provider, ok ? 1 : 0, extra.status ?? (ok ? 200 : 500), extra.latency ?? 100, extra.category ?? '', extra.detail ?? '')
    rollup.run(Math.floor(at / HOUR) * HOUR, provider)
  }
  const ops: ReadOperation[][] = []
  const reader = {
    async run(operations: readonly ReadOperation[]) {
      ops.push([...operations])
      return operations.map((op) => (op.method === 'get' ? db.prepare(op.sql).get(...(op.params ?? [])) : db.prepare(op.sql).all(...(op.params ?? []))))
    },
  }
  return { db, add, reader, ops }
}

const channel = (name: string, enabled = true, baseUrl = `https://${name}.example.com/v1`): HealthChannelInput => ({ name, enabled, baseUrl })

test('window: hours are 3 / 24 / 168 only, 24 by default', () => {
  assert.equal(parseHealthHours(undefined), 24)
  assert.equal(parseHealthHours(''), 24)
  assert.equal(parseHealthHours('168'), 168)
  assert.equal(parseHealthHours('3'), 3)
  assert.equal(parseHealthHours('25'), null)
  assert.equal(parseHealthHours('abc'), null)
})

test('aliases: a compat channel owns its name and the openai-compatible- form, case-insensitively', () => {
  assert.deepEqual(providerAliases('OpenRouter'), ['openrouter', 'openai-compatible-openrouter'])
  assert.deepEqual(providerAliases('openai-compatible-x'), ['openai-compatible-x', 'x'])
  assert.deepEqual(providerAliases('  '), [])
})

test('health: counts, success rate, nearest-rank p95 and slots per channel; other providers never leak in', async () => {
  const { add, reader, ops } = fixture()
  // 20 successes 100…2000ms + 4 upstream failures + 1 client cancel inside 24h, split across both aliases
  for (let i = 1; i <= 20; i += 1) add(NOW - i * 60_000, i % 2 ? 'openrouter' : 'OPENAI-COMPATIBLE-OPENROUTER ', true, { latency: i * 100 })
  for (let i = 0; i < 4; i += 1) add(NOW - 30 * 60_000 - i * 1000, 'openrouter', false, { status: 429, category: 'rate_limited' })
  add(NOW - 2 * HOUR, 'openrouter', false, { status: 499, category: 'client_cancelled', detail: 'context canceled' })
  add(NOW - 30 * HOUR, 'openrouter', true, { latency: 99_999 }) // outside the 24h window
  add(NOW - 10 * 60_000, 'codex', false) // an OAuth provider, not a channel
  add(NOW - 10 * 60_000, 'openai-compatible-commandcode', true) // a deleted channel's history

  const payload = await loadChannelHealth(reader, [channel('openrouter'), channel('quiet', false)], null, 24, NOW)
  assert.equal(ops.length, 1, 'one read batch on one connection')
  assert.equal(payload.hours, 24)
  assert.equal(payload.slotMs, (24 * HOUR) / HEALTH_SLOTS)
  assert.equal(payload.to, new Date(NOW).toISOString())

  const or = payload.channels.find((c) => c.name === 'openrouter')!
  assert.equal(or.requests, 25)
  assert.equal(or.errors, 5)
  assert.equal(or.clientCancelled, 1)
  assert.equal(or.successRate, 20 / 25)
  // nearest rank: ceil(0.95 × 20) = 19th of 100…2000 → 1900; failures never count toward latency
  assert.equal(or.p95Ms, 1900)
  assert.deepEqual(or.recent, { requests: 24, errors: 4, clientCancelled: 0 })
  assert.equal(or.slots.length, HEALTH_SLOTS)
  assert.equal(or.slots.reduce((sum, s) => sum + s.n, 0), 25)
  assert.equal(or.slots.reduce((sum, s) => sum + s.bad, 0), 4, 'client cancellations are not upstream failures on the strip')
  assert.equal(or.slots.at(-1)!.n > 0, true, 'newest slot is last')
  assert.equal(or.lastError?.status, 429)
  assert.equal(or.lastError?.category, 'rate_limited')

  const quiet = payload.channels.find((c) => c.name === 'quiet')!
  assert.equal(quiet.requests, 0)
  assert.equal(quiet.successRate, null, 'no traffic is unknown, never a fake 0%')
  assert.equal(quiet.p95Ms, null)
  assert.equal(quiet.lastRequestAt, null)
  assert.equal(quiet.lastError, null)
  assert.equal(quiet.enabled, false)

  // the whole gateway in the same window: the channel's 25, the OAuth failure and the deleted channel's success
  assert.deepEqual(payload.gateway, { requests: 27, errors: 6 })
})

test('health: the gateway total is read even with no channel at all (an all-OAuth gateway), and stays index-only', async () => {
  const { add, reader, ops, db } = fixture()
  add(NOW - 60_000, 'codex', true)
  add(NOW - 2 * 60_000, 'claude', false, { status: 429, category: 'rate_limited' })
  add(NOW - 25 * HOUR, 'codex', true) // outside the window
  const payload = await loadChannelHealth(reader, [], null, 24, NOW)
  assert.deepEqual(payload.channels, [])
  assert.deepEqual(payload.gateway, { requests: 2, errors: 1 })
  assert.equal(ops.length, 1)
  for (const op of ops[0]) {
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${op.sql}`).all(...(op.params ?? [])).map((row) => String(row.detail)).join(' | ')
    assert.match(plan, /COVERING INDEX/, plan)
  }
})

test('health: last request / last error look past the window, and error detail is scrubbed and capped', async () => {
  const { add, reader } = fixture()
  const old = NOW - 5 * 24 * HOUR - 1234
  add(old - 60_000, 'openai-compatible-qoder', false, { status: 401, category: 'auth_failed', detail: `Bearer sk-live-abcdefghijklmnop secret\n${'x'.repeat(400)}` })
  add(old, 'qoder', true)
  const payload = await loadChannelHealth(reader, [channel('qoder')], null, 3, NOW)
  const q = payload.channels[0]
  assert.equal(q.requests, 0)
  assert.equal(q.lastRequestAt, new Date(old).toISOString(), 'exact millisecond, found through the hourly rollup')
  assert.equal(q.lastError?.status, 401)
  assert.ok(q.lastError?.detail && q.lastError.detail.length <= 200)
  assert.ok(!q.lastError?.detail?.includes('abcdefghijklmnop'), 'credentials never reach the page')
  assert.ok(!q.lastError?.detail?.includes('\n'))
})

test('health: discovery state per channel, host backoff only while it lasts, nothing for channels the job skips', async () => {
  const { reader } = fixture()
  const state: DiscoveryState = {
    channels: {
      openrouter: { lastProbeAt: NOW - 20 * 60_000, nextProbeAt: NOW + 10 * 60_000, lastStatus: 200, lastError: null, discovered: 464, workingUrl: 'https://openrouter.example.com/v1/models' },
      groq: { lastProbeAt: NOW - 5 * 60_000, nextProbeAt: NOW + HOUR, lastStatus: 401, lastError: 'http_401' },
    },
    hosts: {
      'groq.example.com': { backoffUntil: NOW + HOUR, backoffLevel: 1 },
      'openrouter.example.com': { backoffUntil: NOW - 1, backoffLevel: 0 },
    },
  }
  const payload = await loadChannelHealth(reader, [channel('openrouter'), channel('groq'), channel('off', false)], state, 24, NOW)
  const [or, groq, off] = payload.channels
  assert.deepEqual(or.discovery, {
    lastProbeAt: new Date(NOW - 20 * 60_000).toISOString(), nextProbeAt: new Date(NOW + 10 * 60_000).toISOString(),
    lastStatus: 200, lastError: null, discovered: 464, hostBackoffUntil: null,
  })
  assert.equal(groq.discovery?.lastError, 'http_401')
  assert.equal(groq.discovery?.hostBackoffUntil, new Date(NOW + HOUR).toISOString())
  assert.equal(off.discovery, null)
  assert.ok(!JSON.stringify(payload).includes('/v1/models'), 'the probe URL stays server-side')
})

test('service: 15s cache per window and channel set; a toggled channel is a new key; control-plane failure is typed', async () => {
  const { add, reader, ops } = fixture()
  add(NOW - 60_000, 'a', true)
  let list = [channel('a')]
  let clock = NOW
  const service = createChannelHealthService({ reader, listChannels: async () => list, discovery: () => null, now: () => clock })
  const first = await service.read(24)
  assert.equal(await service.read(24), first)
  assert.equal(ops.length, 1)
  await service.read(168)
  assert.equal(ops.length, 2, 'another window is another read')
  list = [channel('a', false)]
  const toggled = await service.read(24)
  assert.equal(ops.length, 3)
  assert.equal(toggled.channels[0].enabled, false)
  clock += 16_000
  await service.read(168)
  assert.equal(ops.length, 4, 'expired entries are re-read')

  const broken = createChannelHealthService({ reader, listChannels: async () => { throw new Error('ECONNREFUSED') }, discovery: () => null })
  await assert.rejects(broken.read(24), (error: unknown) => error instanceof ChannelHealthError && error.code === 'channels_unavailable')
})

test('route: GET /api/channel-health → payload, 400 on a bad window, 502 when channels cannot be listed, never cached by the browser', async (t) => {
  const { add, reader } = fixture()
  add(NOW - 60_000, 'x', true, { latency: 321 })
  let fail = false
  const app = express()
  registerChannelHealthRoutes(app, { reader, listChannels: async () => { if (fail) throw new Error('cpa down'); return [channel('x')] }, discovery: () => null, now: () => NOW })
  const server = app.listen(0, '127.0.0.1')
  t.after(() => server.close())
  await new Promise((resolve) => server.once('listening', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  const ok = await fetch(`${base}/api/channel-health`)
  assert.equal(ok.status, 200)
  assert.equal(ok.headers.get('cache-control'), 'no-store')
  const body = await ok.json() as { hours: number; channels: Array<{ name: string; requests: number; p95Ms: number }> }
  assert.equal(body.hours, 24)
  assert.deepEqual(body.channels.map((c) => [c.name, c.requests, c.p95Ms]), [['x', 1, 321]])

  const bad = await fetch(`${base}/api/channel-health?hours=5`)
  assert.equal(bad.status, 400)
  assert.equal((await bad.json() as { code: string }).code, 'invalid_hours')

  fail = true
  const down = await fetch(`${base}/api/channel-health?hours=168`)
  assert.equal(down.status, 502)
  assert.equal((await down.json() as { code: string }).code, 'channels_unavailable')
})

/* ── the page model that renders this payload (src/features/channels/channelModel.ts) ── */

const like = (over: Partial<ChannelLike> = {}): ChannelLike => ({
  name: 'or', baseUrl: 'https://openrouter.example.com/api/v1', keyCount: 1, enabled: true, stale: false,
  models: [{ id: 'm1', enabled: true, upstreams: 1 }, { id: 'm2', enabled: false, upstreams: 0 }], ...over,
})
const health = (over: Partial<ChannelHealthItem> = {}): ChannelHealthItem => ({
  name: 'or', enabled: true, requests: 0, errors: 0, clientCancelled: 0, successRate: null, p95Ms: null,
  recent: { requests: 0, errors: 0, clientCancelled: 0 }, slots: [], lastRequestAt: null, lastError: null, discovery: null, ...over,
})

test('page model: disabled and stale channels are flagged in words; failures grade 降级 / 异常; client cancels never do', () => {
  assert.deepEqual(classifyChannel(like({ enabled: false }), null, NOW), { bucket: 'off', state: 'off', label: '停用', reason: '不参与路由' })
  assert.equal(classifyChannel(like({ stale: true }), null, NOW).label, '残留')
  assert.equal(classifyChannel(like({ models: [{ id: 'm', enabled: false, upstreams: 0 }] }), null, NOW).label, '降级')
  assert.equal(classifyChannel(like(), health({ requests: 5, errors: 5 }), NOW).label, '启用', 'too few requests to judge')
  const bad = classifyChannel(like(), health({ requests: 60, errors: 23, clientCancelled: 2, lastError: { at: new Date(NOW).toISOString(), status: 429, category: 'rate_limited', detail: null } }), NOW)
  assert.equal(bad.state, 'bad')
  assert.equal(bad.label, '异常')
  assert.equal(bad.reason, '失败 35% · 上游限流')
  assert.equal(classifyChannel(like(), health({ requests: 100, errors: 6 }), NOW).label, '降级')
  assert.equal(classifyChannel(like(), health({ requests: 100, errors: 60, clientCancelled: 60 }), NOW).label, '启用', 'all failures were the caller cancelling')
  assert.equal(classifyChannel(like(), health({ recent: { requests: 3, errors: 3, clientCancelled: 0 } }), NOW).label, '降级')
  const auth = classifyChannel(like(), health({ discovery: { lastProbeAt: null, nextProbeAt: null, lastStatus: 401, lastError: 'http_401', discovered: null, hostBackoffUntil: null } }), NOW)
  assert.equal(auth.state, 'bad')
  assert.match(auth.reason ?? '', /401/)
})

test('page model: discovery and error cells speak plain words; counts match their stated definitions', () => {
  assert.deepEqual(discoveryCell(like({ enabled: false }), null, NOW), { main: '—', sub: '停用 · 不探测', hot: false })
  assert.equal(discoveryCell(like(), null, NOW).sub, '等待首次探测')
  const ok = discoveryCell(like(), { lastProbeAt: new Date(NOW - 60_000).toISOString(), nextProbeAt: new Date(NOW + 20 * 60_000).toISOString(), lastStatus: 200, lastError: null, discovered: 464, hostBackoffUntil: null }, NOW)
  assert.match(ok.main, /上游 464$/)
  assert.match(ok.sub, /^下次 \d\d:\d\d$/)
  assert.equal(discoveryCell(like(), { lastProbeAt: null, nextProbeAt: new Date(NOW - 1).toISOString(), lastStatus: null, lastError: null, discovered: null, hostBackoffUntil: null }, NOW).sub, '下次 · 已到期')
  assert.equal(discoveryErrorWords('credential_unavailable'), '凭据不可用 · 未探测')
  assert.equal(discoveryErrorWords('http_403'), '403 · 上游 Key 可能失效')
  assert.equal(errorWords('upstream_eof', 502), '上游连接中断')
  assert.equal(errorWords(null, 503), '上游服务出错')

  const cancel = lastErrorCell(health({ lastError: { at: new Date(NOW - 60_000).toISOString(), status: 499, category: 'client_cancelled', detail: null } }), NOW)
  assert.equal(cancel?.hot, false, 'a client cancel is never orange')
  assert.equal(cancel?.sub, '客户端取消')
  assert.equal(lastErrorCell(health({ lastError: { at: new Date(NOW - 60_000).toISOString(), status: 429, category: 'rate_limited', detail: null } }), NOW)?.hot, true)
  assert.equal(lastErrorCell(health({ lastError: { at: new Date(NOW - 3 * HOUR).toISOString(), status: 429, category: 'rate_limited', detail: null } }), NOW)?.hot, false)

  const channels = [
    like({ name: 'a', models: [{ id: 'X', enabled: true, upstreams: 1 }, { id: 'y', enabled: false, upstreams: 0 }] }),
    like({ name: 'b', models: [{ id: 'x', enabled: true, upstreams: 2 }] }),
    like({ name: 'c', enabled: false, models: [{ id: 'z', enabled: true, upstreams: 1 }] }),
  ]
  const classes = new Map(channels.map((c) => [c.name, classifyChannel(c, null, NOW)]))
  assert.deepEqual(countChannels(channels, classes), { total: 3, enabled: 2, warn: 0, off: 1, stale: 0, routable: 1, mappings: 4 })
})

test('page model: hosts, middle ellipsis, slot pooling, suggested names', () => {
  assert.equal(hostOf('https://openrouter.example.com/api/v1/'), 'openrouter.example.com/api/v1')
  assert.equal(hostOf('nope'), 'nope')
  const short = middleEllipsis('openrouter.example.com/api/v1', 12)
  assert.equal(short.length, 12)
  assert.ok(short.startsWith('openr') && short.endsWith('/v1') && short.includes('…'))
  const pooled = poolSlots(Array.from({ length: 36 }, (_, i) => ({ n: i === 35 ? 2 : 0, bad: i === 0 ? 1 : 0 })), 18)
  assert.equal(pooled.ticks.length, 18)
  assert.equal(pooled.ticks[17], 2)
  assert.equal(pooled.bad[0], true)
  assert.equal(pooled.bad.filter(Boolean).length, 1)
  assert.equal(suggestName('https://api.groq.com/openai/v1'), 'groq')
  assert.equal(suggestName('not a url'), '')
})

test('health: latency 0 is "not reported" — p95 ranks only measured successes; all unreported → null', async () => {
  const { add, reader } = fixture()
  for (let i = 1; i <= 19; i += 1) add(NOW - i * 60_000, 'openrouter', true, { latency: 0 })
  add(NOW - 30 * 60_000, 'openrouter', true, { latency: 1_000 })
  add(NOW - 31 * 60_000, 'blind', true, { latency: 0 })
  const payload = await loadChannelHealth(reader, [channel('openrouter'), channel('blind')], null, 24, NOW)
  const or = payload.channels.find((c) => c.name === 'openrouter')!
  assert.equal(or.requests, 20, 'unreported latency still counts as a request')
  assert.equal(or.successRate, 1)
  assert.equal(or.p95Ms, 1_000)
  assert.equal(payload.channels.find((c) => c.name === 'blind')!.p95Ms, null)
})
