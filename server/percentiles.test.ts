import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { percentileSummary } from './percentiles.mjs'
import { SQLiteReadWorker } from './sqliteReadWorker.js'

/** The SQL it replaced: nearest rank ⌈p·n⌉ over the sorted positive values. */
function naive(values: number[]) {
  const sorted = values.filter((v) => v > 0).sort((a, b) => a - b)
  if (!sorted.length) return null
  const n = sorted.length
  return { n, p50: sorted[Math.floor((n + 1) / 2) - 1], p95: sorted[Math.floor((95 * n + 99) / 100) - 1] }
}

/** Deterministic rows spanning every slot width (sub-second exact through the open top slot), with ties and gaps. */
function rows(count: number) {
  let seed = 7
  const next = () => (seed = (seed * 48271) % 2147483647) / 2147483647
  return Array.from({ length: count }, (_, i) => {
    const scale = [900, 9_000, 90_000, 900_000, 30_000_000][i % 5]
    return {
      b: i % 13, m: `model-${i % 7}`, p: ['a', 'b', 'c'][i % 3],
      latency_ms: i % 11 === 0 ? 0 : Math.floor(1 + next() * scale),
      ttft_ms: i % 4 === 0 ? null : Math.floor(1 + next() * scale / 3),
    }
  })
}

test('percentileSummary equals the naive nearest rank in every partition', () => {
  const data = rows(20_000)
  const summary = percentileSummary(data, ['latency_ms', 'ttft_ms'])
  for (const field of ['latency_ms', 'ttft_ms'] as const) {
    const byPartition = new Map<string, number[]>()
    for (const row of data) {
      for (const [dim, key] of [['a', ''], ['m', row.m], ['p', row.p], ['b', row.b]] as const) {
        const id = `${dim}:${key}`
        byPartition.set(id, [...(byPartition.get(id) ?? []), Number(row[field] ?? 0)])
      }
    }
    for (const out of summary[field]) {
      assert.deepEqual({ n: out.n, p50: out.p50, p95: out.p95 }, naive(byPartition.get(`${out.dim}:${out.k}`)!), `${field} ${out.dim}:${out.k}`)
    }
    assert.equal(summary[field].length, byPartition.size)
  }
})

test('percentileSummary: no reported values → no rows (the report reads that as "not reported")', () => {
  assert.deepEqual(percentileSummary([{ b: 1, m: 'x', p: 'y', latency_ms: 0, ttft_ms: null }], ['latency_ms', 'ttft_ms']), { latency_ms: [], ttft_ms: [] })
  assert.deepEqual(percentileSummary([], ['latency_ms']), { latency_ms: [] })
})

test('the read worker reduces in its own thread and answers what the in-process reduction answers', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'console-percentiles-'))
  const filename = path.join(directory, 'test.db')
  const database = new DatabaseSync(filename)
  database.exec('CREATE TABLE t (b INTEGER, m TEXT, p TEXT, latency_ms INTEGER, ttft_ms INTEGER)')
  const insert = database.prepare('INSERT INTO t VALUES (?, ?, ?, ?, ?)')
  const data = rows(5_000)
  for (const row of data) insert.run(row.b, row.m, row.p, row.latency_ms, row.ttft_ms)
  database.close()
  const reader = new SQLiteReadWorker(filename)
  try {
    const sql = 'SELECT b, m, p, latency_ms, ttft_ms FROM t'
    const [reduced, raw] = await reader.run([
      { method: 'all', sql, reduce: { percentiles: ['latency_ms', 'ttft_ms'] } },
      { method: 'all', sql },
    ])
    assert.ok(Array.isArray(raw))
    assert.deepEqual(reduced, percentileSummary(raw as Array<Record<string, unknown>>, ['latency_ms', 'ttft_ms']))
  } finally {
    await reader.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
