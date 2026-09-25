import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { cutoffEpochMs, epochMsForTimestamp, usageWindow } from './timeRange.js'

const withDb = (fn: (db: DatabaseSync) => void) => {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE usage_events (
      id INTEGER PRIMARY KEY,
      timestamp TEXT NOT NULL,
      timestamp_ms INTEGER NOT NULL
    );
    CREATE INDEX idx_usage_timestamp_ms ON usage_events(timestamp_ms);
  `)
  try { fn(db) } finally { db.close() }
}

test('epochMsForTimestamp normalizes offset timestamps to one absolute timeline', () => {
  assert.equal(epochMsForTimestamp('2026-08-15T20:00:00+08:00'), Date.parse('2026-08-15T12:00:00Z'))
  assert.equal(epochMsForTimestamp('2026-08-15T12:00:00Z'), Date.parse('2026-08-15T12:00:00Z'))
})

test('usageWindow emits an indexable predicate and preserves key filtering', () => {
  const now = Date.parse('2026-08-16T00:00:00Z')
  assert.deepEqual(usageWindow(7, '', 'timestamp_ms', now), {
    where: 'timestamp_ms >= ?',
    params: [cutoffEpochMs(7, 'days', now)],
  })
  assert.deepEqual(usageWindow(24, 'key-1', 'u.timestamp_ms', now, 'u.key_hash', 'hours'), {
    where: 'u.timestamp_ms >= ? AND u.key_hash = ?',
    params: [cutoffEpochMs(24, 'hours', now), 'key-1'],
  })
})

test('timestamp_ms range query is correct across timezone offsets and uses the index', () => {
  withDb((db) => {
    const insert = db.prepare('INSERT INTO usage_events (timestamp, timestamp_ms) VALUES (?, ?)')
    for (const timestamp of [
      '2026-08-15T20:30:00+08:00',
      '2026-08-15T12:30:00Z',
      '2026-08-15T19:00:00+08:00',
    ]) insert.run(timestamp, epochMsForTimestamp(timestamp))

    const now = Date.parse('2026-08-15T13:00:00Z')
    const cutoff = cutoffEpochMs(1, 'hours', now)
    const count = db.prepare('SELECT COUNT(*) count FROM usage_events WHERE timestamp_ms >= ?').get(cutoff) as { count: number }
    assert.equal(count.count, 2)

    const plan = db.prepare('EXPLAIN QUERY PLAN SELECT COUNT(*) FROM usage_events WHERE timestamp_ms >= ?').all(cutoff) as Array<{ detail: string }>
    assert.ok(plan.some((row) => row.detail.includes('idx_usage_timestamp_ms') && row.detail.includes('timestamp_ms>?')), plan.map((row) => row.detail).join('\n'))
  })
})
