import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'

import type { ConsoleGroup } from './groups.js'
import { loadCacheLiveHistory } from './cacheLiveHistory.js'
import type { ReadOperation } from './sqliteReadWorker.js'

const groups: ConsoleGroup[] = [
  { id: 'codex', name: 'Codex', color: '#000', kind: 'oauth', models: ['gpt-5.6-sol'] },
]

class FakeReader {
  operations: ReadOperation[] = []

  async run(operations: readonly ReadOperation[]) {
    this.operations.push(...operations)
    return [[
      { requestId: 'new', timestamp: '2026-08-31T12:00:01Z', model: 'gpt-5.6-sol', provider: 'codex', success: 1, clientType: '' },
      { requestId: 'old', timestamp: '2026-08-31T12:00:00Z', model: 'gpt-5.6-sol', provider: 'codex', success: 1, clientType: '' },
    ]]
  }
}

test('cache live history runs as a bounded worker query and restores chronological order', async () => {
  const reader = new FakeReader()

  const history = await loadCacheLiveHistory(reader, groups, 50, 'gpt-5.6-sol', '')

  assert.equal(reader.operations.length, 1)
  assert.match(reader.operations[0].sql, /ORDER BY u\.timestamp_ms DESC LIMIT \?/)
  assert.deepEqual(reader.operations[0].params?.slice(-2), ['gpt-5.6-sol', 50])
  assert.deepEqual(history.map((item) => item.requestId), ['old', 'new'])
})

test('history filters recover OMP without leaking those rows into other or legacy', async () => {
  const database = new DatabaseSync(':memory:')
  try {
    database.exec(`CREATE TABLE api_keys (key_hash TEXT, name TEXT);
      CREATE TABLE usage_events (
        request_id TEXT, timestamp TEXT DEFAULT '', timestamp_ms INTEGER, model TEXT DEFAULT 'gpt-5.6-sol',
        endpoint TEXT DEFAULT '', key_hash TEXT, source TEXT DEFAULT '', latency_ms INTEGER DEFAULT 0,
        success INTEGER DEFAULT 1, status_code INTEGER DEFAULT 200, ttft_ms INTEGER DEFAULT 0,
        provider TEXT DEFAULT 'codex', model_group TEXT DEFAULT 'codex', input_tokens INTEGER DEFAULT 1,
        output_tokens INTEGER DEFAULT 0, reasoning_tokens INTEGER DEFAULT 0, cached_tokens INTEGER DEFAULT 0,
        cache_write_tokens INTEGER DEFAULT 0, total_tokens INTEGER DEFAULT 1, client_type TEXT, user_agent TEXT
      )`)
    const insert = database.prepare('INSERT INTO usage_events(request_id,timestamp_ms,client_type,user_agent) VALUES (?,?,?,?)')
    insert.run('old-omp', 1, 'other', 'omp/18.1.14')
    insert.run('new-omp', 2, 'omp', 'omp/18.1.15')
    insert.run('empty-type-omp', 3, '', 'omp/18.1.15')
    insert.run('pi', 4, 'pi', 'pi (darwin 24.6.0; arm64)')
    insert.run('other', 5, 'other', 'xomp/18.1.15')
    insert.run('legacy', 6, '', '')
    const reader = {
      async run(operations: readonly ReadOperation[]) {
        return operations.map((operation) => database.prepare(operation.sql).all(...(operation.params ?? [])))
      },
    }
    const ids = async (client: string) => (await loadCacheLiveHistory(reader, groups, 20, '', client)).map((event) => event.requestId)
    assert.deepEqual(await ids('omp'), ['old-omp', 'new-omp', 'empty-type-omp'])
    assert.deepEqual(await ids('pi'), ['pi'])
    assert.deepEqual(await ids('other'), ['other'])
    assert.deepEqual(await ids('legacy-unknown'), ['legacy'])
    assert.equal(database.prepare("SELECT client_type type FROM usage_events WHERE request_id = 'old-omp'").get()?.type, 'other')
  } finally {
    database.close()
  }
})

test('cache live history filters by key hash and by provider aliases', async () => {
  const byKey = new FakeReader()
  const byProvider = new FakeReader()

  await loadCacheLiveHistory(byKey, groups, 20, '', '', 'key-hash-1')
  await loadCacheLiveHistory(byProvider, groups, 20, '', '', '', 'mox-aigw')

  assert.match(byKey.operations[0].sql, /u\.key_hash = \?/)
  assert.match(byKey.operations[0].sql, /u\.key_hash keyHash/)
  assert.deepEqual(byKey.operations[0].params?.slice(-2), ['key-hash-1', 20])
  // 兼容渠道的两种 provider 写法都要能命中，否则旧版 CPA 落库的数据会被漏掉。
  assert.match(byProvider.operations[0].sql, /lower\(trim\(u\.provider\)\) IN \(\?, \?\)/)
  assert.deepEqual(byProvider.operations[0].params?.slice(-3), ['mox-aigw', 'openai-compatible-mox-aigw', 20])
})
