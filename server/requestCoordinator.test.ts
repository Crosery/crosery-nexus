import assert from 'node:assert/strict'
import test from 'node:test'
import { RequestCoordinator } from './requestCoordinator.js'

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

test('coalesces concurrent requests for the same analytics key', async () => {
  const coordinator = new RequestCoordinator<number>()
  let calls = 0
  const load = async () => { calls += 1; await wait(20); return 42 }
  const [a, b, c] = await Promise.all([
    coordinator.run('analytics:7:all', load),
    coordinator.run('analytics:7:all', load),
    coordinator.run('analytics:7:all', load),
  ])
  assert.deepEqual([a, b, c], [42, 42, 42])
  assert.equal(calls, 1)
})

test('returns a short-lived cached result without sharing different keys', async () => {
  let now = 1_000
  const coordinator = new RequestCoordinator<number>({ ttlMs: 5_000, now: () => now })
  let calls = 0
  const load = async () => ++calls
  assert.equal(await coordinator.run('a', load), 1)
  assert.equal(await coordinator.run('a', load), 1)
  assert.equal(await coordinator.run('b', load), 2)
  now += 5_001
  assert.equal(await coordinator.run('a', load), 3)
})

test('serves stale data immediately while one deferred refresh runs', async () => {
  let now = 1_000
  const scheduled: Array<() => void> = []
  const coordinator = new RequestCoordinator<number>({
    ttlMs: 1_000,
    staleWhileRevalidateMs: 5_000,
    now: () => now,
    schedule: (task) => scheduled.push(task),
  })
  let calls = 0
  const load = async () => ++calls

  assert.equal(await coordinator.run('dashboard', load), 1)
  now += 1_001
  assert.equal(await coordinator.run('dashboard', load), 1)
  assert.equal(await coordinator.run('dashboard', load), 1)
  assert.equal(calls, 1)
  assert.equal(scheduled.length, 1)

  scheduled.shift()?.()
  await wait(0)
  assert.equal(calls, 2)
  assert.equal(await coordinator.run('dashboard', load), 2)
})

test('keeps stale data when a background refresh fails', async () => {
  let now = 1_000
  const scheduled: Array<() => void> = []
  const coordinator = new RequestCoordinator<number>({
    ttlMs: 1_000,
    staleWhileRevalidateMs: 5_000,
    now: () => now,
    schedule: (task) => scheduled.push(task),
  })
  assert.equal(await coordinator.run('analytics', () => 7), 7)
  now += 1_001
  assert.equal(await coordinator.run('analytics', () => { throw new Error('temporary') }), 7)
  scheduled.shift()?.()
  await wait(0)
  assert.equal(await coordinator.run('analytics', () => 8), 7)
})

test('clear forces the next run to reload instead of serving the stale-while-revalidate window', async () => {
  let now = 1_000
  const scheduled: Array<() => void> = []
  const coordinator = new RequestCoordinator<number>({
    ttlMs: 15_000,
    staleWhileRevalidateMs: 30_000,
    now: () => now,
    schedule: (task) => scheduled.push(task),
  })
  let calls = 0
  const load = async () => ++calls
  assert.equal(await coordinator.run('gateway', load), 1)
  now += 15_001
  // 未 clear：SWR 窗口内先回旧值，刷新排到后台——这正是 /api/channels 不带 fresh 时慢一拍的原因。
  assert.equal(await coordinator.run('gateway', load), 1)
  assert.equal(scheduled.length, 1)
  scheduled.shift()?.()
  await wait(0)
  assert.equal(await coordinator.run('gateway', load), 2)
  now += 15_001
  // fresh=1 路径：先 clear 再 run，必须同步重新加载并返回新值，而不是退化成后台刷新。
  coordinator.clear('gateway')
  assert.equal(await coordinator.run('gateway', load), 3)
  assert.equal(scheduled.length, 0)
})
