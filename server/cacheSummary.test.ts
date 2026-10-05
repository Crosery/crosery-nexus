import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import express from 'express'
import type { ConsoleGroup } from './groups.js'
import { SQLiteReadPool, type ReadOperation } from './sqliteReadWorker.js'
import { migrateUsageRollup } from './usageRollup.js'
import { CACHE_CEILING_INDEX_DDL, CACHE_WRITE_CEILING } from './cacheStats.js'
import { parseUsageScope } from './perfReports.js'
import { loadCacheSummary, priceDeclaresCache, registerCacheSummaryRoutes, savingsFor } from './cacheSummary.js'

/*
 * 用量 · 缓存 (/api/cache-summary): hit rate over cache-capable models only (the rest is counted, never a red
 * 0%), savings net of the write premium, over-ceiling counts, dense trend with gaps, the shared filters.
 */

const HOUR = 3_600_000
const DAY = 24 * HOUR
const NOW = Date.parse('2026-10-02T06:32:08.000Z')

const EVENTS_DDL = `
  CREATE TABLE usage_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT UNIQUE, timestamp TEXT NOT NULL, key_hash TEXT,
    provider TEXT NOT NULL, model TEXT NOT NULL, model_group TEXT NOT NULL, endpoint TEXT NOT NULL,
    success INTEGER NOT NULL, status_code INTEGER NOT NULL, latency_ms INTEGER NOT NULL, ttft_ms INTEGER NOT NULL,
    input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, reasoning_tokens INTEGER NOT NULL,
    cached_tokens INTEGER NOT NULL, total_tokens INTEGER NOT NULL, timestamp_ms INTEGER NOT NULL DEFAULT 0,
    error_category TEXT NOT NULL DEFAULT '', cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    user_agent TEXT NOT NULL DEFAULT '', client_type TEXT NOT NULL DEFAULT '', cost_usd REAL
  );
  ${CACHE_CEILING_INDEX_DDL}`

type Ev = { at: number; model: string; provider: string; input: number; cached?: number; write?: number; key?: string; client?: string; ok?: boolean }

function open(filename = ':memory:', rollup = true) {
  const db = new DatabaseSync(filename)
  db.exec(EVENTS_DDL)
  if (rollup) migrateUsageRollup(db)
  const insert = db.prepare(`INSERT INTO usage_events (timestamp, timestamp_ms, key_hash, provider, model, model_group, endpoint,
    success, status_code, latency_ms, ttft_ms, input_tokens, output_tokens, reasoning_tokens, cached_tokens, total_tokens,
    cache_write_tokens, client_type) VALUES (?, ?, ?, ?, ?, '', '/v1/messages', ?, 200, 1000, 300, ?, 10, 0, ?, ?, ?, ?)`)
  const add = (e: Ev) => insert.run(
    new Date(e.at).toISOString(), e.at, e.key ?? 'key-a', e.provider, e.model, e.ok === false ? 0 : 1,
    e.input, e.cached ?? 0, e.input + 10 + (e.cached ?? 0), e.write ?? 0, e.client ?? 'claude-code',
  )
  const reader = { run: async (ops: readonly ReadOperation[]) => ops.map((op) => db.prepare(op.sql)[op.method](...(op.params ?? []))) }
  return { db, add, reader }
}

const groups: ConsoleGroup[] = [
  { id: 'claude', name: 'Claude', color: '#000', kind: 'oauth', models: [] },
  { id: 'codex', name: 'Codex', color: '#000', kind: 'oauth', models: [] },
  { id: 'openrouter', name: 'openrouter', color: '#000', kind: 'compat', models: [] },
]
const load = (reader: { run(ops: readonly ReadOperation[]): Promise<unknown[]> }, patch: Record<string, string> = {}) =>
  loadCacheSummary(reader, groups, parseUsageScope({ days: '7', ...patch }, 90), { timeZone: 'Asia/Shanghai', now: NOW })

const close = (a: number | null | undefined, b: number, eps = 1e-9) => assert.ok(a !== null && a !== undefined && Math.abs(a - b) < eps, `${a} ≈ ${b}`)

test('capability: price card discount or observed cache traffic; everything else is counted out, never 0%', () => {
  assert.equal(priceDeclaresCache('claude-opus-4-6'), true)
  assert.equal(priceDeclaresCache('deepseek-v4-flash'), true)
  assert.equal(priceDeclaresCache('qwen3.8-27b:free'), false) // unpriced
})

test('dialects: anthropic has three parallel segments, openai-style cached sits inside input', async () => {
  const f = open()
  // anthropic: fresh 100, read 800, write 100 → 80%
  f.add({ at: NOW - 2 * HOUR, model: 'claude-opus-4-6', provider: 'claude', input: 100, cached: 800, write: 100 })
  // openai via a compat channel: input 1000 includes 600 cached → fresh 400, write ignored → 60%
  f.add({ at: NOW - 2 * HOUR, model: 'deepseek-v4-flash', provider: 'openai-compatible-openrouter', input: 1000, cached: 600, write: 50 })
  const r = await load(f.reader)
  const opus = r.byModel.find((m) => m.id === 'claude-opus-4-6')!
  assert.equal(opus.dialect, 'anthropic')
  close(opus.hitRate, 0.8)
  assert.deepEqual([opus.freshInputTokens, opus.cacheReadTokens, opus.cacheWriteTokens], [100, 800, 100])
  const ds = r.byModel.find((m) => m.id === 'deepseek-v4-flash')!
  assert.equal(ds.dialect, 'openai')
  assert.deepEqual([ds.freshInputTokens, ds.cacheReadTokens, ds.cacheWriteTokens], [400, 600, 0])
  close(r.totals.hitRate, 1400 / 2000)
  assert.equal(r.totals.requests, 2)
})

test('hit rate excludes models that cannot cache, and says how many; capability ignores the key filter', async () => {
  const f = open()
  f.add({ at: NOW - 3 * HOUR, model: 'claude-opus-4-6', provider: 'claude', input: 100, cached: 900, key: 'key-a' })
  f.add({ at: NOW - 3 * HOUR, model: 'claude-opus-4-6', provider: 'claude', input: 1000, key: 'key-b' }) // capable, missed
  f.add({ at: NOW - 3 * HOUR, model: 'qwen3.8-27b:free', provider: 'openrouter', input: 500, key: 'key-b' })
  f.add({ at: NOW - 3 * HOUR, model: 'qwen3.8-27b:free', provider: 'openrouter', input: 500, key: 'key-b' })
  // free model with real cache reads 20 days ago: still capable this week (evidence window 30d)
  f.add({ at: NOW - 20 * DAY, model: 'laguna-xs-2.1:free', provider: 'openrouter', input: 50, cached: 30 })
  f.add({ at: NOW - 3 * HOUR, model: 'laguna-xs-2.1:free', provider: 'openrouter', input: 50, key: 'key-b' })

  const all = await load(f.reader)
  assert.deepEqual(all.excluded, { models: 1, requests: 2, items: [{ model: 'qwen3.8-27b:free', requests: 2 }] })
  assert.deepEqual(all.byModel.map((m) => m.id).sort(), ['claude-opus-4-6', 'laguna-xs-2.1:free'])
  close(all.totals.hitRate, 900 / (1000 + 1000 + 50))

  const keyB = await load(f.reader, { keyId: 'key-b' })
  assert.equal(keyB.totals.hitRate, 0) // a real 0%: capable models that missed, not "unsupported"
  assert.equal(keyB.excluded.models, 1)
  assert.ok(keyB.byModel.some((m) => m.id === 'claude-opus-4-6'))

  const onlyFree = await load(f.reader, { model: 'qwen3.8-27b:free' })
  assert.equal(onlyFree.totals.hitRate, null)
  assert.equal(onlyFree.totals.requests, 0)
  assert.equal(onlyFree.excluded.requests, 2)
})

test('savings: read discount minus write premium at the price in force; unpriced is counted, never $0', async () => {
  const at = NOW - 2 * HOUR
  const s = savingsFor('claude-opus-4-6', { requests: 1, freshInputTokens: 0, cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000 }, at)!
  close(s.readUsd, 4.5) // (5 − 0.5) per M
  close(s.writeUsd, 1.25) // (6.25 − 5) per M
  assert.equal(s.free, false)
  assert.equal(savingsFor('qwen3.8-27b:free', { requests: 1, freshInputTokens: 0, cacheReadTokens: 10, cacheWriteTokens: 0 }, at), null)

  const f = open()
  f.add({ at, model: 'claude-opus-4-6', provider: 'claude', input: 0, cached: 1_000_000, write: 200_000 })
  f.add({ at, model: 'laguna-xs-2.1:free', provider: 'openrouter', input: 100, cached: 50 })
  const r = await load(f.reader)
  close(r.totals.savings.netUsd, 4.5 - 0.25)
  close(r.totals.savings.readUsd, 4.5)
  close(r.totals.savings.writeUsd, 0.25)
  assert.equal(r.totals.savings.pricedRequests, 1)
  assert.equal(r.totals.savings.unpricedRequests, 1)
  assert.equal(r.totals.savings.unpricedModels, 1)
  assert.equal(r.totals.savings.free, false)
  assert.equal(r.byModel.find((m) => m.id === 'laguna-xs-2.1:free')!.savingsUsd, null)

  const unpriced = await load(f.reader, { model: 'laguna-xs-2.1:free' })
  assert.equal(unpriced.totals.savings.netUsd, null)
  assert.equal(unpriced.totals.savings.readUsd, null)
})

test('over ceiling: prompts above the cache write ceiling are counted per model in their own dialect', async () => {
  const f = open()
  const at = NOW - HOUR
  f.add({ at, model: 'claude-opus-4-6', provider: 'claude', input: 10, cached: CACHE_WRITE_CEILING, write: 1 }) // 663,011 > ceiling
  f.add({ at, model: 'claude-opus-4-6', provider: 'claude', input: 10, cached: CACHE_WRITE_CEILING - 100 })
  f.add({ at, model: 'deepseek-v4-flash', provider: 'codex', input: CACHE_WRITE_CEILING + 1, cached: CACHE_WRITE_CEILING }) // cached ⊂ input
  f.add({ at, model: 'deepseek-v4-flash', provider: 'codex', input: CACHE_WRITE_CEILING, cached: 5 })
  const r = await load(f.reader)
  assert.equal(r.totals.overCeilingRequests, 2)
  assert.equal(r.byModel.find((m) => m.id === 'claude-opus-4-6')!.overCeilingRequests, 1)
  assert.equal(r.byModel.find((m) => m.id === 'deepseek-v4-flash')!.overCeilingRequests, 1)
  assert.equal(r.ceiling, CACHE_WRITE_CEILING)
})

test('trend: one point per bucket, empty buckets are gaps; failures never counted; removed channels counted unless currentOnly', async () => {
  const f = open()
  f.add({ at: NOW - 2 * HOUR, model: 'claude-opus-4-6', provider: 'claude', input: 100, cached: 300 })
  f.add({ at: NOW - 2 * HOUR, model: 'claude-opus-4-6', provider: 'claude', input: 5000, ok: false })
  f.add({ at: NOW - 2 * HOUR, model: 'claude-opus-4-6', provider: 'retired', input: 5000, cached: 5000 })
  // 只看当前渠道（显式）：已移除的 retired 不计
  const current = await load(f.reader, { currentOnly: '1' })
  assert.equal(current.trend.length, 29)
  assert.equal(current.bucketMs, 6 * HOUR)
  const last = current.trend.at(-1)!
  assert.equal(last.requests, 1)
  close(last.hitRate, 0.75)
  assert.ok(current.trend.slice(0, -1).every((p) => p.requests === 0 && p.hitRate === null && p.savingsUsd === null))
  assert.equal(current.totals.requests, 1)
  // 默认（全部渠道）：retired 的历史照样计入；失败请求仍然不计
  const all = await load(f.reader)
  assert.equal(all.totals.requests, 2)
  assert.equal(all.trend.at(-1)!.requests, 2)
  assert.equal(all.filters.currentOnly, false)
})

test('filters: client and provider alias reach the rollup; byClient carries the display label', async () => {
  const f = open()
  f.add({ at: NOW - HOUR, model: 'claude-opus-4-6', provider: 'claude', input: 100, cached: 100, client: 'claude-code' })
  f.add({ at: NOW - HOUR, model: 'deepseek-v4-flash', provider: 'openai-compatible-openrouter', input: 100, cached: 50, client: 'codex-cli' })
  assert.equal((await load(f.reader, { client: 'codex-cli' })).totals.requests, 1)
  assert.equal((await load(f.reader, { provider: 'openrouter' })).totals.requests, 1)
  const r = await load(f.reader)
  assert.deepEqual(r.byClient.map((c) => [c.id, c.label]).sort(), [['claude-code', 'Claude Code'], ['codex-cli', 'Codex CLI']])
})

test('without the rollup table the read worker falls back to raw events with the same totals', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cache-summary-'))
  const pools: SQLiteReadPool[] = []
  try {
    const results = []
    for (const rollup of [true, false]) {
      const file = path.join(dir, `${rollup ? 'with' : 'without'}.db`)
      const f = open(file, rollup)
      f.add({ at: NOW - 30 * HOUR, model: 'claude-opus-4-6', provider: 'claude', input: 100, cached: 800, write: 100 })
      f.add({ at: NOW - 2 * HOUR, model: 'deepseek-v4-flash', provider: 'codex', input: 1000, cached: 600 })
      f.add({ at: NOW - 2 * HOUR, model: 'qwen3.8-27b:free', provider: 'openrouter', input: 10 })
      f.db.close()
      const pool = new SQLiteReadPool(file, 1)
      pools.push(pool)
      results.push(await load(pool))
    }
    const [withRollup, withoutRollup] = results
    assert.equal(withRollup.totals.requests, 2)
    assert.deepEqual(
      { ...withoutRollup.totals, savings: withoutRollup.totals.savings },
      { ...withRollup.totals, savings: withRollup.totals.savings },
    )
    assert.deepEqual(withoutRollup.excluded, withRollup.excluded)
    assert.deepEqual(withoutRollup.trend.map((p) => p.requests), withRollup.trend.map((p) => p.requests))
  } finally {
    await Promise.all(pools.map((pool) => pool.close()))
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('route: GET /api/cache-summary answers with the summary and a 503 code when the read fails', async () => {
  const f = open()
  f.add({ at: NOW - HOUR, model: 'claude-opus-4-6', provider: 'claude', input: 100, cached: 100 })
  const app = express()
  registerCacheSummaryRoutes(app, { reader: f.reader, groups: async () => groups, timeZone: 'Asia/Shanghai', retentionDays: 90, now: () => NOW })
  const failing = express()
  registerCacheSummaryRoutes(failing, { reader: { run: async () => { throw new Error('locked') } }, groups: async () => groups, timeZone: 'UTC', retentionDays: 90 })
  const servers = [app.listen(0, '127.0.0.1'), failing.listen(0, '127.0.0.1')]
  await Promise.all(servers.map((s) => new Promise((r) => s.once('listening', r))))
  const url = (i: number, q: string) => `http://127.0.0.1:${(servers[i].address() as { port: number }).port}/api/cache-summary${q}`
  try {
    const ok = await fetch(url(0, '?days=1'))
    assert.equal(ok.status, 200)
    const body = await ok.json() as { days: number; totals: { hitRate: number }; basis: string }
    assert.equal(body.days, 1)
    assert.equal(body.totals.hitRate, 0.5)
    assert.match(body.basis, /缓存读 ÷/)
    const bad = await fetch(url(1, ''))
    assert.equal(bad.status, 503)
    assert.deepEqual(await bad.json(), { error: '缓存报表暂时读不出来', code: 'report_unavailable' })
    const refused = await fetch(url(0, `?keyId=${'k'.repeat(129)}`))
    assert.equal(refused.status, 400)
    assert.equal((await refused.json() as { code: string }).code, 'invalid_filter')
  } finally {
    await Promise.all(servers.map((s) => new Promise((r) => s.close(r))))
  }
})
