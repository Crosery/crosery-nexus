import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import {
  antigravityWindowStart,
  buildQuotaShare,
  claudeWindowStart,
  codexWindowStart,
  loadMonitorQuotaShare,
  loadQuotaShare,
  quotaWindowStart,
  WEEK_MS,
} from './monitorQuotaShare.js'
import type { ReadOperation } from './sqliteReadWorker.js'

const NOW = Date.parse('2026-09-02T12:00:00Z')

function openDatabase() {
  const database = new DatabaseSync(':memory:')
  database.exec(`
    CREATE TABLE api_keys (key_hash TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE usage_events (
      key_hash TEXT,
      provider TEXT NOT NULL,
      success INTEGER NOT NULL,
      timestamp_ms INTEGER NOT NULL,
      input_tokens INTEGER NOT NULL,
      cached_tokens INTEGER NOT NULL,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL
    );
  `)
  database.prepare('INSERT INTO api_keys VALUES (?, ?)').run('key-a', '程耀宇')
  database.prepare('INSERT INTO api_keys VALUES (?, ?)').run('key-b', '同事')
  const insert = database.prepare('INSERT INTO usage_events VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
  const hourAgo = NOW - 3_600_000
  // key-a：少量新输入但大量缓存读——按美元很便宜，按额度却是大头
  insert.run('key-a', 'codex', 1, hourAgo, 1_000, 90_000, 0, 500)
  insert.run('key-a', 'codex', 1, hourAgo + 1, 1_000, 90_000, 0, 500)
  // key-b：纯新输入
  insert.run('key-b', 'codex', 1, hourAgo, 5_000, 0, 0, 1_000)
  // 失败请求、窗口外请求、其他渠道都不计入
  insert.run('key-b', 'codex', 0, hourAgo, 999_999, 0, 0, 0)
  insert.run('key-b', 'codex', 1, NOW - 10 * 86_400_000, 999_999, 0, 0, 0)
  insert.run('key-a', 'claude', 1, hourAgo, 10, 2_000, 400, 100)
  insert.run(null, 'claude', 1, hourAgo, 10, 0, 0, 90)
  insert.run('key-b', 'openai-compatible-mox-aigw', 1, hourAgo, 100, 0, 0, 10)
  return database
}

function readerFor(database: DatabaseSync) {
  const operations: ReadOperation[] = []
  const execute = async (batch: readonly ReadOperation[]) => {
    operations.push(...batch)
    return batch.map((operation) => {
      const statement = database.prepare(operation.sql)
      return operation.method === 'get'
        ? statement.get(...(operation.params || []))
        : statement.all(...(operation.params || []))
    })
  }
  return { operations, reader: { run: execute, runParallel: execute } }
}

test('codex window start derives from primary_window reset_at and limit_window_seconds', () => {
  const resetAt = Math.floor((NOW + 2 * 86_400_000) / 1000)
  assert.equal(
    codexWindowStart({ rate_limit: { primary_window: { used_percent: 12, limit_window_seconds: 604_800, reset_at: resetAt } } }),
    resetAt * 1000 - 604_800_000,
  )
  assert.equal(codexWindowStart({ rate_limit: { primary_window: null } }), null)
  assert.equal(codexWindowStart({ error: 'boom' }), null)
})

test('claude window start subtracts seven days from seven_day.resets_at or the weekly_all limit', () => {
  assert.equal(
    claudeWindowStart({ usage: { seven_day: { utilization: 92, resets_at: '2026-09-05T00:59:59Z' } } }),
    Date.parse('2026-09-05T00:59:59Z') - WEEK_MS,
  )
  assert.equal(
    claudeWindowStart({ usage: { limits: [{ kind: 'session', resets_at: '2026-09-02T19:00:00Z' }, { kind: 'weekly_all', resets_at: '2026-09-06T00:00:00Z' }] } }),
    Date.parse('2026-09-06T00:00:00Z') - WEEK_MS,
  )
  assert.equal(claudeWindowStart({ usage: { five_hour: { utilization: 1 } } }), null)
})

test('antigravity window start prefers the gemini-weekly bucket', () => {
  const quota = {
    groups: [
      { displayName: 'Gemini Models', buckets: [
        { bucketId: 'gemini-5h', resetTime: '2026-09-02T18:00:00Z', window: '5h' },
        { bucketId: 'gemini-weekly', resetTime: '2026-09-03T07:28:21Z', window: 'weekly' },
      ] },
      { displayName: 'Claude and GPT Models', buckets: [
        { bucketId: 'claude-gpt-weekly', resetTime: '2026-09-08T10:37:04Z', window: 'weekly' },
      ] },
    ],
  }
  assert.equal(antigravityWindowStart(quota), Date.parse('2026-09-03T07:28:21Z') - WEEK_MS)
  assert.equal(
    antigravityWindowStart({ groups: [{ buckets: [{ bucketId: 'claude-gpt-weekly', resetTime: '2026-09-08T10:37:04Z' }] }] }),
    Date.parse('2026-09-08T10:37:04Z') - WEEK_MS,
  )
  assert.equal(antigravityWindowStart({ error: 'boom' }), null)
})

test('quotaWindowStart falls back to seven days and takes the earliest account window', () => {
  assert.equal(quotaWindowStart('codex', [{ error: 'boom' }, null], NOW), NOW - WEEK_MS)
  assert.equal(quotaWindowStart('unknown', [], NOW), NOW - WEEK_MS)
  const later = Math.floor((NOW + 3 * 86_400_000) / 1000)
  const earlier = Math.floor((NOW + 86_400_000) / 1000)
  assert.equal(
    quotaWindowStart('codex', [
      { rate_limit: { primary_window: { limit_window_seconds: 604_800, reset_at: later } } },
      { rate_limit: { primary_window: { limit_window_seconds: 604_800, reset_at: earlier } } },
    ], NOW),
    earlier * 1000 - 604_800_000,
  )
})

test('buildQuotaShare weighs cached input and sorts by share', () => {
  const keys = buildQuotaShare([
    { keyId: 'key-b', keyName: '同事', requests: 1, promptTokens: 5_000, outputTokens: 1_000 },
    { keyId: 'key-a', keyName: '程耀宇', requests: 2, promptTokens: 182_000, outputTokens: 1_000 },
    { keyId: null, keyName: null, requests: 1, promptTokens: 0, outputTokens: 0 },
  ])
  assert.deepEqual(keys.map((key) => key.keyName), ['程耀宇', '同事', '未关联 Key'])
  assert.ok(Math.abs(keys[0].share - 183_000 / 189_000) < 1e-9)
  assert.ok(Math.abs(keys.reduce((sum, key) => sum + key.share, 0) - 1) < 1e-9)
  assert.deepEqual(buildQuotaShare([]), [])
})

test('loadQuotaShare aggregates per key inside the window from SQLite', async () => {
  const database = openDatabase()
  const { operations, reader } = readerFor(database)
  try {
    const share = await loadQuotaShare(reader, 'codex', NOW - 2 * 86_400_000)

    assert.equal(share.windowStart, NOW - 2 * 86_400_000)
    assert.deepEqual(share.keys, [
      { keyId: 'key-a', keyName: '程耀宇', requests: 2, promptTokens: 182_000, outputTokens: 1_000, share: 183_000 / 189_000 },
      { keyId: 'key-b', keyName: '同事', requests: 1, promptTokens: 5_000, outputTokens: 1_000, share: 6_000 / 189_000 },
    ])
    assert.match(operations[0].sql, /u\.success = 1/)
    assert.match(operations[0].sql, /u\.timestamp_ms >= \?/)
    assert.match(operations[0].sql, /input_tokens \+ u\.cached_tokens \+ u\.cache_write_tokens/)
  } finally {
    database.close()
  }
})

test('loadMonitorQuotaShare returns all three providers with account-derived windows', async () => {
  const database = openDatabase()
  const { reader } = readerFor(database)
  try {
    const codexReset = Math.floor((NOW + 86_400_000) / 1000)
    const result = await loadMonitorQuotaShare(reader, [
      { type: 'codex', quota: { rate_limit: { primary_window: { limit_window_seconds: 604_800, reset_at: codexReset } } } },
      { type: 'claude', quota: { usage: { seven_day: { resets_at: '2026-09-04T00:00:00Z' } } } },
      { type: 'antigravity', quota: { error: '读取失败' } },
    ], NOW)

    assert.equal(result.codex.windowStart, codexReset * 1000 - 604_800_000)
    assert.deepEqual(result.codex.keys.map((key) => key.keyName), ['程耀宇', '同事'])
    assert.equal(result.claude.windowStart, Date.parse('2026-09-04T00:00:00Z') - WEEK_MS)
    // 未关联 Key 的请求单独成行；claude 的缓存写入也计入体量
    assert.deepEqual(result.claude.keys.map((key) => [key.keyName, key.promptTokens, key.outputTokens]), [['程耀宇', 2_410, 100], ['未关联 Key', 10, 90]])
    assert.equal(result.antigravity.windowStart, NOW - WEEK_MS)
    assert.deepEqual(result.antigravity.keys, [])
  } finally {
    database.close()
  }
})

test('provider aliases cover the openai-compatible prefix', async () => {
  const database = openDatabase()
  const { reader } = readerFor(database)
  try {
    const share = await loadQuotaShare(reader, 'mox-aigw', NOW - WEEK_MS)
    assert.deepEqual(share.keys.map((key) => [key.keyName, key.requests]), [['同事', 1]])
  } finally {
    database.close()
  }
})
