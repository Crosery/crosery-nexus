import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import { ReportSnapshotCache } from './reportSnapshotCache.js'

test('report snapshots survive a process-local cache restart', async () => {
  const database = new DatabaseSync(':memory:')
  let now = 1_000
  let loads = 0
  const first = new ReportSnapshotCache(database, { now: () => now })
  const value = await first.run('charts:7:all:policy', 20_000, async () => {
    loads += 1
    return { days: 7, trend: [{ requests: 3 }] }
  })
  assert.equal(loads, 1)
  assert.equal(value.days, 7)

  now = 2_000
  const restarted = new ReportSnapshotCache(database, { now: () => now })
  const restored = await restarted.run('charts:7:all:policy', 20_000, async () => {
    loads += 1
    return { days: 0 }
  })

  assert.equal(loads, 1)
  assert.deepEqual(restored, value)
  database.close()
})

test('stale report snapshots return immediately and refresh once in background', async () => {
  const database = new DatabaseSync(':memory:')
  let now = 1_000
  const scheduled: Array<() => void> = []
  const cache = new ReportSnapshotCache(database, {
    now: () => now,
    maxStaleMs: 60_000,
    schedule: (task) => scheduled.push(task),
  })
  await cache.run('usage:7:all:policy', 20_000, async () => ({ revision: 1 }))

  now = 25_000
  let loads = 0
  const loader = async () => { loads += 1; return { revision: 2 } }
  const [left, right] = await Promise.all([
    cache.run('usage:7:all:policy', 20_000, loader),
    cache.run('usage:7:all:policy', 20_000, loader),
  ])

  assert.deepEqual(left, { revision: 1 })
  assert.deepEqual(right, { revision: 1 })
  assert.equal(loads, 0)
  assert.equal(scheduled.length, 1)
  scheduled[0]()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(loads, 1)
  assert.deepEqual(await cache.run('usage:7:all:policy', 20_000, loader), { revision: 2 })
  database.close()
})

test('different report scopes never share a persistent entry', async () => {
  const database = new DatabaseSync(':memory:')
  const cache = new ReportSnapshotCache(database)

  const all = await cache.run('cache:24:all:all:policy', 20_000, async () => ({ scope: 'all' }))
  const model = await cache.run('cache:24:gpt-5.6-sol:all:policy', 20_000, async () => ({ scope: 'model' }))

  assert.equal(all.scope, 'all')
  assert.equal(model.scope, 'model')
  const rows = database.prepare('SELECT COUNT(*) count FROM data_plane_snapshots').get() as { count: number }
  assert.equal(rows.count, 2)
  database.close()
})

test('report snapshot persistence stays bounded across filter churn', async () => {
  const database = new DatabaseSync(':memory:')
  const cache = new ReportSnapshotCache(database, {
    maxMemoryEntries: 2,
    maxPersistentEntries: 3,
  })

  for (let index = 0; index < 6; index += 1) {
    await cache.run(`cache:24:model-${index}:all:policy`, 20_000, async () => ({ index }))
  }

  const rows = database.prepare(`
    SELECT COUNT(*) count FROM data_plane_snapshots WHERE snapshot_key LIKE 'report-v1:%'
  `).get() as { count: number }
  assert.equal(rows.count, 3)
  database.close()
})
