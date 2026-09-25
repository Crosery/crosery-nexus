import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { SnapshotStore } from './snapshotStore.js'

type Report = { requests: number }

function report(value: unknown): Report {
  if (!value || typeof value !== 'object' || typeof (value as { requests?: unknown }).requests !== 'number') {
    throw new Error('invalid report')
  }
  return value as Report
}

const tick = () => new Promise((resolve) => setImmediate(resolve))

test('reads a valid snapshot from SQLite after the L1 cache is cleared', () => {
  const database = new DatabaseSync(':memory:')
  const store = new SnapshotStore(database, report, { now: () => 2_000 })
  store.put('dashboard:7:all', { requests: 42 }, 1_500)
  store.clearMemory()

  assert.deepEqual(store.get('dashboard:7:all', 1_000), {
    value: { requests: 42 },
    generatedAt: 1_500,
    storedAt: 2_000,
    stale: false,
  })
  database.close()
})

test('returns stale last-good immediately and refreshes once in the background', async () => {
  const database = new DatabaseSync(':memory:')
  let now = 10_000
  const scheduled: Array<() => void> = []
  const store = new SnapshotStore(database, report, {
    now: () => now,
    schedule: (task) => scheduled.push(task),
  })
  store.put('analytics:7:all', { requests: 1 }, 1_000)

  let loads = 0
  const load = async () => ({ value: { requests: ++loads }, generatedAt: now })
  const first = await store.getOrRefresh('analytics:7:all', 1_000, load)
  const second = await store.getOrRefresh('analytics:7:all', 1_000, load)
  assert.equal(first.stale, true)
  assert.equal(first.value.requests, 1)
  assert.equal(second.value.requests, 1)
  assert.equal(loads, 0)
  assert.equal(scheduled.length, 1)

  scheduled.shift()?.()
  await tick()
  now += 100
  assert.deepEqual(store.get('analytics:7:all', 1_000)?.value, { requests: 1 })
  assert.equal(loads, 1)
  database.close()
})

test('keeps last-good when a stale refresh fails', async () => {
  const database = new DatabaseSync(':memory:')
  const scheduled: Array<() => void> = []
  const store = new SnapshotStore(database, report, {
    now: () => 10_000,
    schedule: (task) => scheduled.push(task),
  })
  store.put('usage:30:all', { requests: 7 }, 1_000)
  const stale = await store.getOrRefresh('usage:30:all', 100, async () => { throw new Error('offline') })
  scheduled.shift()?.()
  await tick()

  assert.equal(stale.stale, true)
  assert.deepEqual(store.get('usage:30:all', 100)?.value, { requests: 7 })
  database.close()
})

test('treats corrupt or schema-incompatible L2 values as misses and repairs them', async () => {
  const database = new DatabaseSync(':memory:')
  const store = new SnapshotStore(database, report, { now: () => 5_000 })
  database.prepare(`
    INSERT INTO data_plane_snapshots (snapshot_key, payload_json, generated_at, stored_at)
    VALUES (?, ?, ?, ?)
  `).run('dashboard:bad', '{broken', 1_000, 1_000)

  assert.equal(store.get('dashboard:bad', 1_000), null)
  const repaired = await store.getOrRefresh('dashboard:bad', 1_000, async () => ({ value: { requests: 9 }, generatedAt: 5_000 }))
  assert.deepEqual(repaired.value, { requests: 9 })
  assert.equal(repaired.stale, false)
  database.close()
})

test('returns the last-good snapshot at the max-stale boundary but not beyond it', () => {
  const database = new DatabaseSync(':memory:')
  let now = 10_000
  const store = new SnapshotStore(database, report, {
    now: () => now,
    maxStaleMs: 5_000,
  })
  store.put('usage:7:boundary', { requests: 3 }, 5_000)

  assert.deepEqual(store.get('usage:7:boundary', 1_000), {
    value: { requests: 3 },
    generatedAt: 5_000,
    storedAt: 10_000,
    stale: true,
  })
  now += 1
  assert.equal(store.get('usage:7:boundary', 1_000), null)
  store.clearMemory()
  assert.equal(store.get('usage:7:boundary', 1_000), null)
  database.close()
})

test('an expired snapshot is unavailable when its refresh fails', async () => {
  const database = new DatabaseSync(':memory:')
  const store = new SnapshotStore(database, report, {
    now: () => 20_000,
    maxStaleMs: 5_000,
  })
  store.put('usage:30:expired', { requests: 7 }, 10_000)

  await assert.rejects(
    store.getOrRefresh('usage:30:expired', 1_000, async () => { throw new Error('offline') }),
    /offline/,
  )
  assert.equal(store.get('usage:30:expired', 1_000), null)
  database.close()
})

test('uses a five-minute hard stale limit by default', () => {
  const database = new DatabaseSync(':memory:')
  let now = 1_000
  const store = new SnapshotStore(database, report, { now: () => now })
  store.put('usage:7:default-limit', { requests: 1 }, now)

  now += 5 * 60_000
  assert.equal(store.get('usage:7:default-limit', 1_000)?.stale, true)
  now += 1
  assert.equal(store.get('usage:7:default-limit', 1_000), null)
  database.close()
})

test('bounds the process-local snapshot cache with LRU eviction', () => {
  const database = new DatabaseSync(':memory:')
  const store = new SnapshotStore(database, report, { now: () => 1_000, maxMemoryEntries: 2 })
  store.put('usage:a', { requests: 1 })
  store.put('usage:b', { requests: 2 })
  assert.equal(store.get('usage:a', 1_000)?.value.requests, 1, 'read promotes a to most-recent')
  store.put('usage:c', { requests: 3 })
  database.exec('DELETE FROM data_plane_snapshots')

  assert.equal(store.get('usage:b', 1_000), null, 'least-recent entry was evicted from L1')
  assert.equal(store.get('usage:a', 1_000)?.value.requests, 1)
  assert.equal(store.get('usage:c', 1_000)?.value.requests, 3)
  database.close()
})
