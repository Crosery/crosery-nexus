import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import type { ConsoleGroup } from './groups.js'
import { SQLiteReadPool, type ReadOperation } from './sqliteReadWorker.js'
import {
  loadCacheTrendReport,
  loadAnalyticsReport,
  loadChartsLatencyReport,
  loadChartsReport,
  loadUsageKeySummariesReport,
  loadUsagePageReport,
} from './usageReports.js'

const groups: ConsoleGroup[] = [
  { id: 'codex', name: 'Codex', color: '#000', kind: 'oauth', models: ['gpt-5.6-sol'] },
]

class FakeReader {
  operations: ReadOperation[] = []
  batches: Array<{ mode: 'serial' | 'parallel'; operations: readonly ReadOperation[] }> = []

  constructor(private readonly responses: unknown[][]) {}

  private take(mode: 'serial' | 'parallel', operations: readonly ReadOperation[]) {
    this.operations.push(...operations)
    this.batches.push({ mode, operations })
    const response = this.responses.shift()
    if (!response) throw new Error('unexpected reader call')
    return response
  }

  async run(operations: readonly ReadOperation[]) {
    return this.take('serial', operations)
  }

  async runParallel(operations: readonly ReadOperation[]) {
    return this.take('parallel', operations)
  }
}

const modelRow = {
  model: 'gpt-5.6-sol', provider: 'codex', requests: 3,
  newInputTokens: 300, outputTokens: 30, cacheTokens: 270,
  cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 600, activeDays: 1,
}
const usageAggregateRow = {
  day: '2026-08-31',
  model: modelRow.model,
  provider: modelRow.provider,
  modelGroup: 'codex',
  requests: modelRow.requests,
  inputTokens: 570,
  uncachedInputTokens: modelRow.newInputTokens,
  outputTokens: modelRow.outputTokens,
  cacheTokens: modelRow.cacheTokens,
  cacheWriteTokens: modelRow.cacheWriteTokens,
  reasoningTokens: modelRow.reasoningTokens,
  totalTokens: modelRow.totalTokens,
  errors: 0,
  firstTimestampMs: Date.parse('2026-08-31T00:00:00.000Z'),
}

test('usage page core returns without waiting for the all-key aggregate', async () => {
  const reader = new FakeReader([[[usageAggregateRow]]])

  const result = await loadUsagePageReport(reader, groups, 7, '', 'Asia/Shanghai', Date.parse('2026-08-31T12:00:00Z'))

  assert.equal(reader.operations.length, 1)
  assert.deepEqual(reader.batches.map((batch) => batch.mode), ['serial'])
  assert.match(reader.operations[0].sql, /GROUP BY key_hash, day/)
  assert.match(reader.operations[0].sql, /MIN\(timestamp_ms\) firstTimestampMs/)
  assert.equal(result.requests, 3)
  assert.equal('keySummaries' in result, false)
  assert.equal(reader.operations.some((operation) => operation.sql.includes('FROM api_keys')), false)
})

test('usage page keeps provider-specific new-input semantics after SQL pre-aggregation', async () => {
  const reader = new FakeReader([[[
    usageAggregateRow,
    {
      ...usageAggregateRow,
      model: 'claude-opus-5',
      provider: 'claude',
      modelGroup: 'claude',
      requests: 1,
      inputTokens: 100,
      uncachedInputTokens: 0,
      cacheTokens: 900,
      totalTokens: 1_000,
    },
  ]]])
  const allGroups: ConsoleGroup[] = [
    ...groups,
    { id: 'claude', name: 'Claude', color: '#fff', kind: 'oauth', models: ['claude-opus-5'] },
  ]

  const result = await loadUsagePageReport(reader, allGroups, 7, '', 'Asia/Shanghai', Date.parse('2026-08-31T12:00:00Z'))

  assert.equal(result.newInputTokens, 400)
  assert.match(reader.operations[0].sql, /SUM\(input_tokens\).*SUM\(MAX\(input_tokens - cached_tokens, 0\)\)/s)
  assert.match(reader.operations[0].sql, /GROUP BY key_hash, day, model, provider/)
})

test('usage key summaries run independently and omit per-key model arrays', async () => {
  const reader = new FakeReader([[
    [{ id: 'key-1', name: 'Main', ...usageAggregateRow }],
  ]])

  const result = await loadUsageKeySummariesReport(reader, groups, 7, Date.parse('2026-08-31T12:00:00Z'))

  assert.equal(reader.operations.length, 1)
  assert.deepEqual(result.keySummaries.map((item) => ({ id: item.id, name: item.name, requests: item.totals.requests })), [
    { id: 'key-1', name: 'Main', requests: 3 },
  ])
  assert.equal('models' in result.keySummaries[0], false)
})

test('usage page skips the all-key aggregate for a selected key', async () => {
  const reader = new FakeReader([[[usageAggregateRow]]])

  const result = await loadUsagePageReport(reader, groups, 7, 'key-1', 'Asia/Shanghai', Date.parse('2026-08-31T12:00:00Z'))

  assert.equal(reader.operations.length, 1)
  assert.equal(reader.operations.some((operation) => operation.sql.includes('FROM api_keys')), false)
  assert.equal('keySummaries' in result, false)
})

test('usage page remains internally consistent across a concurrent insert', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-page-snapshot-'))
  const filename = path.join(directory, 'test.db')
  const database = new DatabaseSync(filename)
  database.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE usage_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      timestamp_ms INTEGER NOT NULL,
      key_hash TEXT,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      model_group TEXT NOT NULL,
      success INTEGER NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      cached_tokens INTEGER NOT NULL,
      cache_write_tokens INTEGER NOT NULL,
      reasoning_tokens INTEGER NOT NULL,
      total_tokens INTEGER NOT NULL
    );
    CREATE INDEX idx_usage_key_rollup ON usage_events(
      key_hash, substr(timestamp,1,10), model, provider, timestamp,
      timestamp_ms, input_tokens, cached_tokens, output_tokens, cache_write_tokens,
      reasoning_tokens, total_tokens, success
    );
  `)
  const insert = database.prepare(`
    INSERT INTO usage_events (
      timestamp, timestamp_ms, key_hash, provider, model, model_group, success,
      input_tokens, output_tokens, cached_tokens, cache_write_tokens, reasoning_tokens, total_tokens
    ) VALUES (?, ?, ?, 'codex', 'gpt-5.6-sol', 'codex', 1, ?, ?, ?, 0, 0, ?)
  `)
  const now = Date.parse('2026-08-31T12:00:00.000Z')
  for (let index = 0; index < 3; index++) {
    insert.run(`2026-08-31T11:0${index}:00.000Z`, now - (index + 1) * 60_000, 'key-1', 100, 50, 50, 200)
  }

  const pool = new SQLiteReadPool(filename, 4)
  let insertedDuringRead = false
  const reader = {
    run: async (operations: readonly ReadOperation[]) => {
      const pending = pool.run(operations)
      if (!insertedDuringRead) {
        insertedDuringRead = true
        insert.run('2026-08-31T11:59:30.000Z', now - 30_000, 'key-1', 5_000, 500, 0, 5_500)
      }
      return pending
    },
  }

  try {
    const result = await loadUsagePageReport(reader, groups, 7, '', 'Asia/Shanghai', now)
    const populatedDay = result.daily.find((entry) => entry.day === '2026-08-31')
    assert.equal(insertedDuringRead, true)
    assert.ok(result.requests === 3 || result.requests === 4)
    assert.equal(populatedDay?.requests, result.requests)
    assert.equal(populatedDay?.totalTokens, result.totalTokens)
  } finally {
    await pool.close()
    database.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('request-details analytics skips chart-only aggregates', async () => {
  const reader = new FakeReader([[
    { requests: 3, tokens: 600, avgLatency: 200, errorRate: 0 },
    [{ id: 'key-1', name: 'Main', requests: 3, tokens: 600, errorRate: 0 }],
    [{ requestId: 'request-1', timestamp: '2026-08-31T11:00:00.000Z', model: 'gpt-5.6-sol' }],
    [{ type: 'codex-cli', requests: 3, tokens: 600, avgLatency: 200, errorRate: 0 }],
  ]])

  const result = await loadAnalyticsReport(reader, groups, 7, '', Date.parse('2026-08-31T12:00:00Z'))
  const sql = reader.operations.map((operation) => operation.sql).join('\n')

  assert.equal(reader.operations.length, 4)
  assert.doesNotMatch(sql, /ROW_NUMBER|PARTITION BY|GROUP BY status_code|GROUP BY category/i)
  assert.deepEqual(result.trend, [])
  assert.deepEqual(result.models, [])
  assert.deepEqual(result.latency, [])
  assert.equal(result.clients[0]?.label, 'Codex CLI')
})

test('charts report omits request details, key rankings, clients, and p95 sort', async () => {
  const reader = new FakeReader([[ [{
    bucket: '2026-08-31T12', provider: 'codex', name: 'gpt-5.6-sol', success: 1,
    code: 200, category: 'other', requests: 3, tokens: 600,
  }] ]])

  const result = await loadChartsReport(reader, groups, 7, '', Date.parse('2026-08-31T12:00:00Z'))
  const sql = reader.operations.map((operation) => operation.sql).join('\n')

  assert.equal(reader.operations.length, 1)
  assert.match(sql, /INDEXED BY idx_usage_charts_rollup/)
  assert.doesNotMatch(sql, /request_id|LEFT JOIN api_keys|client_type|ROW_NUMBER|PARTITION BY/i)
  assert.deepEqual(result.latency, [])
  assert.equal((result.trend as Array<{ requests: number }>)[0]?.requests, 3)
})

test('charts default report preserves the five legacy JSON datasets in one indexed pass', async () => {
  const database = new DatabaseSync(':memory:')
  database.exec(`
    CREATE TABLE usage_events (
      timestamp TEXT NOT NULL,
      timestamp_ms INTEGER NOT NULL,
      key_hash TEXT,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      success INTEGER NOT NULL,
      status_code INTEGER NOT NULL,
      error_category TEXT NOT NULL,
      total_tokens INTEGER NOT NULL
    );
    CREATE INDEX idx_usage_charts_rollup ON usage_events(
      substr(timestamp,1,13), lower(trim(provider)),
      (CASE WHEN instr(model,'/')>0 THEN substr(model,instr(model,'/')+1) ELSE model END),
      success, status_code, error_category, total_tokens, timestamp_ms
    );
  `)
  const insert = database.prepare('INSERT INTO usage_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
  const now = Date.parse('2026-08-31T12:00:00.000Z')
  const rows = [
    ['2026-08-31T10:00:00.000Z', now - 7_200_000, null, 'codex', 'codex/gpt-5.6-sol', 1, 200, '', 100],
    ['2026-08-31T10:10:00.000Z', now - 6_600_000, null, 'codex', 'gpt-5.6-sol', 0, 500, '', 20],
    ['2026-08-31T10:20:00.000Z', now - 6_000_000, null, 'codex', 'gpt-5.6-sol', 0, 500, 'other', 30],
    ['2026-08-31T11:00:00.000Z', now - 3_600_000, null, 'codex', 'gpt-5.6-luna', 1, 200, '', 200],
    ['2026-08-31T11:10:00.000Z', now - 3_000_000, null, 'codex', 'gpt-5.6-luna', 0, 429, 'rate_limit', 10],
  ] as const
  for (const row of rows) insert.run(...row)
  const operations: ReadOperation[] = []
  const reader = {
    run: async (batch: readonly ReadOperation[]) => {
      operations.push(...batch)
      return batch.map((operation) => database.prepare(operation.sql).all(...(operation.params || [])))
    },
  }

  try {
    const result = await loadChartsReport(reader, groups, 7, '', now)
    assert.equal(JSON.stringify(result), JSON.stringify({
      days: 7,
      trend: [
        { bucket: '2026-08-31T10', requests: 3, tokens: 150, errors: 2 },
        { bucket: '2026-08-31T11', requests: 2, tokens: 210, errors: 1 },
      ],
      groups: [{ name: 'codex', requests: 5, tokens: 360 }],
      models: [
        { name: 'gpt-5.6-sol', requests: 3, tokens: 150 },
        { name: 'gpt-5.6-luna', requests: 2, tokens: 210 },
      ],
      latency: [],
      statusCodes: [{ code: 500, count: 2 }, { code: 429, count: 1 }],
      errorCategories: [{ category: 'other', count: 2 }, { category: 'rate_limit', count: 1 }],
    }))
    const plan = database.prepare(`EXPLAIN QUERY PLAN ${operations[0].sql}`)
      .all(...(operations[0].params || [])) as Array<{ detail: string }>
    assert.ok(plan.some((row) => row.detail.includes('idx_usage_charts_rollup')))
    assert.equal(plan.some((row) => row.detail.includes('TEMP B-TREE')), false)
  } finally {
    database.close()
  }
})

test('charts latency obtains exact p95 by indexed offset without a window sort', async () => {
  const reader = new FakeReader([
    [[
      { name: 'gpt-5.6-sol', requests: 22, avgLatency: 12, avgTtft: 4 },
      { name: 'claude-opus-5', requests: 3, avgLatency: 9, avgTtft: 3 },
    ]],
    [
      { requests: 22, avgLatency: 12, avgTtft: 4, p95: 20 },
      { requests: 3, avgLatency: 9, avgTtft: 3, p95: 2 },
    ],
  ])

  const result = await loadChartsLatencyReport(reader, groups, 7, '', Date.parse('2026-08-31T12:00:00Z'))

  assert.deepEqual(reader.batches.map((batch) => batch.mode), ['serial', 'parallel'])
  assert.doesNotMatch(reader.operations[0].sql, /ROW_NUMBER|PARTITION BY/i)
  assert.match(reader.operations[1].sql, /ORDER BY latency_ms\s+LIMIT 1 OFFSET \(\s*SELECT/i)
  assert.deepEqual(reader.operations.slice(1).map((operation) =>
    operation.params?.filter((value) => value === operation.params?.[0]).length), [3, 3])
  assert.deepEqual(result.latency.map((row) => ({ name: row.name, p95: row.p95 })), [
    { name: 'gpt-5.6-sol', p95: 20 },
    { name: 'claude-opus-5', p95: 2 },
  ])
})

test('charts latency preserves the discrete percentile on SQLite without percentile extensions', async () => {
  const database = new DatabaseSync(':memory:')
  database.exec(`
    CREATE TABLE usage_events (
      model TEXT NOT NULL,
      provider TEXT NOT NULL,
      timestamp_ms INTEGER NOT NULL,
      success INTEGER NOT NULL,
      latency_ms INTEGER NOT NULL,
      ttft_ms INTEGER NOT NULL
    );
    CREATE INDEX idx_usage_latency_rollup ON usage_events(
      (CASE WHEN instr(model,'/')>0 THEN substr(model,instr(model,'/')+1) ELSE model END),
      success, latency_ms, lower(trim(provider)), timestamp_ms, ttft_ms, model
    );
  `)
  const now = Date.parse('2026-08-31T12:00:00.000Z')
  const insert = database.prepare('INSERT INTO usage_events VALUES (?, ?, ?, ?, ?, ?)')
  for (let latency = 1; latency <= 22; latency++) {
    insert.run('gpt-5.6-sol', 'codex', now - latency, 1, latency, latency / 2)
  }
  insert.run('gpt-5.6-sol', 'codex', now - 1, 0, 999, 999)
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
  const reader = { run: execute, runParallel: execute }

  try {
    const result = await loadChartsLatencyReport(reader, groups, 7, '', now)

    assert.equal(result.latency[0]?.requests, 22)
    assert.equal(result.latency[0]?.p95, 20)
    for (const operation of operations) {
      const plan = database.prepare(`EXPLAIN QUERY PLAN ${operation.sql}`)
        .all(...(operation.params || [])) as Array<{ detail: string }>
      assert.ok(plan.some((row) => row.detail.includes('idx_usage_latency_rollup')), plan.map((row) => row.detail).join('\n'))
      if (operation.sql.includes('LIMIT 1 OFFSET')) {
        assert.equal(plan.some((row) => row.detail.includes('TEMP B-TREE FOR ORDER BY')), false)
      }
    }
  } finally {
    database.close()
  }
})

test('cache trend aggregates in SQLite and preserves aggregate request counts', async () => {
  const reader = new FakeReader([[
    [{
      minuteBucket: Math.floor(Date.parse('2026-08-31T11:00:00.000Z') / 60_000),
      model: 'gpt-5.6-sol', provider: 'codex', modelGroup: 'codex', clientType: 'codex',
      requests: 9, inputTokens: 9_000, uncachedInputTokens: 900, cacheReadTokens: 8_100,
      cacheWriteTokens: 0, outputTokens: 90,
    }],
  ]])

  const result = await loadCacheTrendReport(reader, groups, 24, '', '', '', '', Date.parse('2026-08-31T12:00:00Z'))

  assert.match(reader.operations[0].sql, /COUNT\(\*\) requests/)
  assert.match(reader.operations[0].sql, /CAST\(timestamp_ms \/ 60000 AS INTEGER\)/)
  assert.doesNotMatch(reader.operations.map((operation) => operation.sql).join('\n'), /SELECT DISTINCT/)
  assert.equal(result.points[0]?.requests, 9)
  assert.equal(result.points[0]?.freshInputTokens, 900)
  assert.equal(result.points[0]?.cacheReadTokens, 8_100)
  assert.deepEqual(result.models, ['gpt-5.6-sol'])
  assert.equal(result.clients[0]?.requests, 9)
})

test('cache trend filters by key in SQL and by provider in Node while keeping both option counts', async () => {
  const twoGroups: ConsoleGroup[] = [
    ...groups,
    { id: 'claude', name: 'Claude', color: '#000', kind: 'oauth', models: ['claude-opus-5'] },
  ]
  const minuteBucket = Math.floor(Date.parse('2026-08-31T11:00:00.000Z') / 60_000)
  const codexRow = {
    minuteBucket, model: 'gpt-5.6-sol', provider: 'codex', clientType: 'codex-cli',
    firstTimestampMs: minuteBucket * 60_000, requests: 4, inputTokens: 4_000, uncachedInputTokens: 400,
    cacheReadTokens: 3_600, cacheWriteTokens: 0, outputTokens: 40,
  }
  const claudeRow = {
    minuteBucket, model: 'claude-opus-5', provider: 'claude', clientType: 'claude-code',
    firstTimestampMs: minuteBucket * 60_000, requests: 6, inputTokens: 60, uncachedInputTokens: 60,
    cacheReadTokens: 9_000, cacheWriteTokens: 300, outputTokens: 90,
  }
  const reader = new FakeReader([[[claudeRow], [codexRow]]])

  const result = await loadCacheTrendReport(reader, twoGroups, 24, '', '', 'key-hash-1', 'claude', Date.parse('2026-08-31T12:00:00Z'))

  assert.equal(reader.operations.length, 2)
  for (const operation of reader.operations) {
    assert.match(operation.sql, /INDEXED BY idx_usage_cache_rollup/)
    assert.match(operation.sql, /AND key_hash = \?/)
    assert.equal(operation.params?.at(-1), 'key-hash-1')
  }
  assert.equal(result.keyId, 'key-hash-1')
  assert.equal(result.provider, 'claude')
  // 渠道筛选只裁剪趋势点，各渠道计数保持完整，切换筛选器时选项不会消失。
  assert.deepEqual(result.providers, [
    { id: 'claude', label: 'Claude', requests: 6 },
    { id: 'codex', label: 'Codex', requests: 4 },
  ])
  assert.deepEqual(result.clients.map((item) => item.type), ['claude-code'])
  assert.equal(result.points.length, 1)
  assert.equal(result.points[0]?.requests, 6)
  assert.equal(result.points[0]?.cacheWriteTokens, 300)

  const unfiltered = new FakeReader([[[claudeRow], [codexRow]]])
  const all = await loadCacheTrendReport(unfiltered, twoGroups, 24, '', '', '', '', Date.parse('2026-08-31T12:00:00Z'))
  assert.doesNotMatch(unfiltered.operations[0].sql, /key_hash/)
  assert.equal(all.points[0]?.requests, 10)
  assert.deepEqual(all.clients.map((item) => item.requests), [6, 4])
})
