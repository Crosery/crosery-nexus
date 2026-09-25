import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { SQLiteReadPool, SQLiteReadWorker } from './sqliteReadWorker.js'

type PoolInternals = {
  workers: Array<{ worker: unknown | null }>
}

const initializedWorkers = (pool: SQLiteReadPool) =>
  (pool as unknown as PoolInternals).workers.filter((worker) => worker.worker !== null).length

test('runs a batch of read-only SQLite queries in a worker', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'console-read-worker-'))
  const filename = path.join(directory, 'test.db')
  const database = new DatabaseSync(filename)
  database.exec('CREATE TABLE events (id INTEGER PRIMARY KEY, value TEXT); INSERT INTO events (value) VALUES (\'a\'), (\'b\')')
  database.close()

  const reader = new SQLiteReadWorker(filename)
  try {
    const [summary, rows] = await reader.run([
      { method: 'get', sql: 'SELECT COUNT(*) count FROM events' },
      { method: 'all', sql: 'SELECT value FROM events ORDER BY id' },
    ])
    assert.deepEqual(summary, { count: 2 })
    assert.deepEqual(rows, [{ value: 'a' }, { value: 'b' }])
  } finally {
    await reader.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('returns query errors without killing the worker', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'console-read-worker-'))
  const filename = path.join(directory, 'test.db')
  const database = new DatabaseSync(filename)
  database.exec('CREATE TABLE events (id INTEGER PRIMARY KEY)')
  database.close()

  const reader = new SQLiteReadWorker(filename)
  try {
    await assert.rejects(reader.run([{ method: 'all', sql: 'SELECT * FROM missing' }]), /no such table/)
    const [row] = await reader.run([{ method: 'get', sql: 'SELECT COUNT(*) count FROM events' }])
    assert.deepEqual(row, { count: 0 })
  } finally {
    await reader.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('pool run keeps a batch on one worker', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'console-read-pool-'))
  const filename = path.join(directory, 'test.db')
  const database = new DatabaseSync(filename)
  database.exec('CREATE TABLE events (id INTEGER PRIMARY KEY, value TEXT); INSERT INTO events (value) VALUES (\'a\'), (\'b\')')
  database.close()

  const pool = new SQLiteReadPool(filename, 4)
  try {
    const results = await pool.run([
      { method: 'get', sql: 'SELECT COUNT(*) count FROM events' },
      { method: 'all', sql: 'SELECT value FROM events ORDER BY id' },
      { method: 'get', sql: 'SELECT value FROM events WHERE id = 2' },
    ])
    assert.deepEqual(results, [
      { count: 2 },
      [{ value: 'a' }, { value: 'b' }],
      { value: 'b' },
    ])
    assert.equal(initializedWorkers(pool), 1)
  } finally {
    await pool.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('pool runParallel preserves result order and uses at most four workers', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'console-read-pool-'))
  const filename = path.join(directory, 'test.db')
  const database = new DatabaseSync(filename)
  database.exec('CREATE TABLE events (id INTEGER PRIMARY KEY, value TEXT)')
  database.close()

  const pool = new SQLiteReadPool(filename, 6)
  try {
    const results = await pool.runParallel(Array.from({ length: 9 }, (_, index) => ({
      method: 'get' as const,
      sql: 'SELECT ? position',
      params: [index],
    })))
    assert.deepEqual(results, Array.from({ length: 9 }, (_, position) => ({ position })))
    assert.equal(initializedWorkers(pool), 4)
  } finally {
    await pool.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('pool runParallel handles an empty batch without starting a worker', async () => {
  const pool = new SQLiteReadPool(':memory:', 4)
  try {
    assert.deepEqual(await pool.runParallel([]), [])
    assert.equal(initializedWorkers(pool), 0)
  } finally {
    await pool.close()
  }
})

test('pool remains usable after a parallel query fails', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'console-read-pool-'))
  const filename = path.join(directory, 'test.db')
  const database = new DatabaseSync(filename)
  database.exec('CREATE TABLE events (id INTEGER PRIMARY KEY, value TEXT); INSERT INTO events (value) VALUES (\'ok\')')
  database.close()

  const pool = new SQLiteReadPool(filename, 4)
  try {
    await assert.rejects(pool.runParallel([
      { method: 'get', sql: 'SELECT value FROM events WHERE id = 1' },
      { method: 'all', sql: 'SELECT * FROM missing' },
      { method: 'get', sql: 'SELECT COUNT(*) count FROM events' },
    ]), /no such table/)
    assert.deepEqual(await pool.runParallel([
      { method: 'get', sql: 'SELECT value FROM events WHERE id = 1' },
      { method: 'get', sql: 'SELECT COUNT(*) count FROM events' },
    ]), [{ value: 'ok' }, { count: 1 }])
  } finally {
    await pool.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
