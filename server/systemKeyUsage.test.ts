import './testDataDir.js'

import assert from 'node:assert/strict'
import test from 'node:test'
import { db } from './db.js'
import { persistUsageRecords } from './sync.js'

test('系统 Key（可用性探测）的流量不进用量明细与额度账本', () => {
  const tokens = { input_tokens: 5, output_tokens: 1, total_tokens: 6 }
  persistUsageRecords([
    { request_id: 'fixture-probe-1', api_key: `sk-probe-${'d'.repeat(64)}`, model: 'gpt-5.6-sol', provider: 'codex', tokens },
    { request_id: 'fixture-user-1', api_key: 'fixture-user-key', model: 'gpt-5.6-sol', provider: 'codex', tokens },
  ], [])
  const count = (table: string, id: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE request_id = ?`).get(id) as { n: number }).n
  assert.equal(count('usage_events', 'fixture-probe-1'), 0)
  assert.equal(count('quota_usage_events', 'fixture-probe-1'), 0)
  assert.equal(count('usage_events', 'fixture-user-1'), 1)
  assert.equal(count('quota_usage_events', 'fixture-user-1'), 1)
})
