import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import {
  migrateQuotaLedger,
  quotaSpendForWindows,
  quotaSpendSince,
} from './quotaLedger.js'

function ledger() {
  const database = new DatabaseSync(':memory:')
  database.exec(`
    CREATE TABLE quota_usage_events (
      request_id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      key_hash TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      cached_tokens INTEGER NOT NULL,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0
    )
  `)
  return database
}

const insert = (database: DatabaseSync, requestId: string, timestamp: string) => {
  database.prepare(`
    INSERT INTO quota_usage_events
      (request_id, timestamp, key_hash, provider, model, input_tokens, output_tokens, cached_tokens)
    VALUES (?, ?, 'key-1', 'claude', 'claude-opus-5', 1000000, 0, 0)
  `).run(requestId, timestamp)
}

const insertForKey = (
  database: DatabaseSync,
  requestId: string,
  timestamp: string,
  keyHash: string,
) => {
  database.prepare(`
    INSERT INTO quota_usage_events
      (request_id, timestamp, key_hash, provider, model, input_tokens, output_tokens, cached_tokens)
    VALUES (?, ?, ?, 'claude', 'claude-opus-5', 1000000, 0, 0)
  `).run(requestId, timestamp, keyHash)
}

test('daily quota compares offset timestamps by absolute time, not text order', () => {
  const database = ledger()
  insert(database, 'before-midnight', '2026-08-04T23:59:59+08:00')
  insert(database, 'after-midnight', '2026-08-05T00:00:01+08:00')

  assert.equal(quotaSpendSince(database, 'key-1', '2026-08-04T16:00:00.000Z'), 5)
})

test('weekly quota excludes records before Monday midnight across offsets', () => {
  const database = ledger()
  insert(database, 'sunday', '2026-08-02T23:59:59+08:00')
  insert(database, 'monday', '2026-08-03T00:00:01+08:00')

  assert.equal(quotaSpendSince(database, 'key-1', '2026-08-02T16:00:00.000Z'), 5)
})

test('quota ledger migration backfills epoch timestamps, indexes them, and keeps new rows current', () => {
  const database = ledger()
  insert(database, 'existing', '2026-08-05T00:00:01+08:00')

  migrateQuotaLedger(database)

  const existing = database.prepare(`
    SELECT timestamp_ms timestampMs FROM quota_usage_events WHERE request_id = 'existing'
  `).get() as { timestampMs: number }
  assert.equal(existing.timestampMs, Date.parse('2026-08-05T00:00:01+08:00'))

  insert(database, 'new', '2026-08-05T00:00:02+08:00')
  const current = database.prepare(`
    SELECT timestamp_ms timestampMs FROM quota_usage_events WHERE request_id = 'new'
  `).get() as { timestampMs: number }
  assert.equal(current.timestampMs, Date.parse('2026-08-05T00:00:02+08:00'))

  const plan = database.prepare(`
    EXPLAIN QUERY PLAN
    SELECT model FROM quota_usage_events WHERE key_hash = ? AND timestamp_ms >= ?
  `).all('key-1', Date.parse('2026-08-04T16:00:00.000Z')) as Array<{ detail: string }>
  assert.ok(
    plan.some((row) => row.detail.includes('idx_quota_usage_key_timestamp_ms')),
    plan.map((row) => row.detail).join('\n'),
  )
})

test('quota ledger migration resumes after an interrupted column add', () => {
  const database = ledger()
  database.exec('ALTER TABLE quota_usage_events ADD COLUMN timestamp_ms INTEGER NOT NULL DEFAULT 0')
  insert(database, 'partial-migration', '2026-08-05T00:00:01+08:00')

  migrateQuotaLedger(database)

  const row = database.prepare(`
    SELECT timestamp_ms timestampMs FROM quota_usage_events WHERE request_id = 'partial-migration'
  `).get() as { timestampMs: number }
  assert.equal(row.timestampMs, Date.parse('2026-08-05T00:00:01+08:00'))
})

test('batch quota query reads every key and all three windows in one pass', () => {
  const database = ledger()
  migrateQuotaLedger(database)
  insertForKey(database, 'key-1-total', '2026-08-02T12:00:00.000Z', 'key-1')
  insertForKey(database, 'key-1-weekly', '2026-08-04T12:00:00.000Z', 'key-1')
  insertForKey(database, 'key-1-daily', '2026-08-05T12:00:00.000Z', 'key-1')
  insertForKey(database, 'key-2-old', '2026-08-01T12:00:00.000Z', 'key-2')
  insertForKey(database, 'key-2-current', '2026-08-05T12:00:00.000Z', 'key-2')

  const spend = quotaSpendForWindows(database, [
    {
      keyHash: 'key-1',
      totalSince: '2026-08-01T00:00:00.000Z',
      weeklySince: '2026-08-03T00:00:00.000Z',
      dailySince: '2026-08-05T00:00:00.000Z',
    },
    {
      keyHash: 'key-2',
      totalSince: '2026-08-02T00:00:00.000Z',
      weeklySince: '2026-08-04T00:00:00.000Z',
      dailySince: '2026-08-05T00:00:00.000Z',
    },
  ])

  assert.deepEqual(spend.get('key-1'), { total: 15, daily: 5, weekly: 10 })
  assert.deepEqual(spend.get('key-2'), { total: 5, daily: 5, weekly: 5 })
})
