import assert from 'node:assert/strict'
import test from 'node:test'
import { evaluateQuota, planQuotaActions, quotaWindowResetAt, quotaWindowStart, quotaWindowTiming, sumCost, validateQuota } from './quota.js'

const noQuota = { totalUsd: 0, dailyUsd: 0, weeklyUsd: 0 }

test('zero means unlimited rather than "instantly exceeded"', () => {
  const state = evaluateQuota(noQuota, { total: 999, daily: 999, weekly: 999 })
  assert.equal(state.unlimited, true)
  assert.equal(state.exceeded, false)
  assert.equal(state.total.ratio, null)
})

test('a window trips exactly at its limit, not after', () => {
  const quota = { totalUsd: 10, dailyUsd: 0, weeklyUsd: 0 }
  assert.equal(evaluateQuota(quota, { total: 9.99, daily: 0, weekly: 0 }).exceeded, false)
  assert.equal(evaluateQuota(quota, { total: 10, daily: 0, weekly: 0 }).exceeded, true)
})

test('the reported window is the one that actually tripped', () => {
  const quota = { totalUsd: 100, dailyUsd: 5, weeklyUsd: 50 }
  assert.equal(evaluateQuota(quota, { total: 10, daily: 6, weekly: 10 }).exceededWindow, 'daily')
  assert.equal(evaluateQuota(quota, { total: 10, daily: 1, weekly: 60 }).exceededWindow, 'weekly')
  // 总额度优先，因为它最严重：日/周窗口会自然滚动，总额度不会
  assert.equal(evaluateQuota(quota, { total: 200, daily: 6, weekly: 60 }).exceededWindow, 'total')
})

test('daily and weekly windows are independent of each other', () => {
  const quota = { totalUsd: 0, dailyUsd: 5, weeklyUsd: 50 }
  const state = evaluateQuota(quota, { total: 0, daily: 1, weekly: 49 })
  assert.equal(state.exceeded, false)
  assert.equal(state.daily.ratio, 0.2)
  assert.equal(state.weekly.ratio, 0.98)
})

test('validation rejects nonsense combinations', () => {
  assert.throws(() => validateQuota({ totalUsd: -1, dailyUsd: 0, weeklyUsd: 0 }), /总额度/)
  assert.throws(() => validateQuota({ totalUsd: 10, dailyUsd: 20, weeklyUsd: 0 }), /日额度不能超过总额度/)
  assert.throws(() => validateQuota({ totalUsd: 100, dailyUsd: 0, weeklyUsd: 200 }), /周额度不能超过总额度/)
  assert.throws(() => validateQuota({ totalUsd: 0, dailyUsd: 60, weeklyUsd: 50 }), /日额度不能超过周额度/)
  assert.deepEqual(validateQuota({ totalUsd: 100, dailyUsd: 5, weeklyUsd: 50 }), { totalUsd: 100, dailyUsd: 5, weeklyUsd: 50 })
  assert.deepEqual(validateQuota(noQuota), noQuota)
})

test('cost sums per model instead of applying one blended rate', () => {
  const cost = sumCost([
    { model: 'claude-opus-5', newInputTokens: 1_000_000, outputTokens: 0, cacheTokens: 0 },
    { model: 'claude-haiku-4-5-20251001', newInputTokens: 1_000_000, outputTokens: 0, cacheTokens: 0 },
  ])
  assert.equal(cost, 6)
})

test('unpriced models contribute zero rather than blocking a key on a guess', () => {
  const cost = sumCost([
    { model: 'claude-opus-5', newInputTokens: 1_000_000, outputTokens: 0, cacheTokens: 0 },
    { model: 'totally-unknown', newInputTokens: 9_000_000, outputTokens: 9_000_000, cacheTokens: 0 },
  ])
  assert.equal(cost, 5)
})

test('unpriced Codex Spark does not guess quota spending while image token usage does', () => {
  const cost = sumCost([
    { model: 'gpt-5.3-codex-spark', newInputTokens: 1_000_000, outputTokens: 1_000_000, cacheTokens: 1_000_000 },
    { model: 'gpt-image-2', newInputTokens: 1_000_000, outputTokens: 1_000_000, cacheTokens: 1_000_000 },
  ])
  assert.equal(cost, 40)
})

test('channel-prefixed models are priced like their bare name', () => {
  assert.equal(
    sumCost([{ model: 'qiji/claude-opus-5', newInputTokens: 1_000_000, outputTokens: 0, cacheTokens: 0 }]),
    5,
  )
})

// 窗口边界是「本地零点」，序列化成 UTC 后可能落在前一天，所以用计算值而非字面量断言
const localMidnight = (value: string) => {
  const date = new Date(value)
  date.setHours(0, 0, 0, 0)
  return date.toISOString()
}

test('the daily window starts at local midnight when never reset', () => {
  const now = new Date('2026-08-03T15:00:00')
  assert.equal(quotaWindowStart('daily', '', now), localMidnight('2026-08-03T15:00:00'))
})

test('a reset later than midnight becomes the new start', () => {
  const now = new Date('2026-08-03T15:00:00')
  const reset = new Date('2026-08-03T14:00:00').toISOString()
  assert.equal(quotaWindowStart('daily', reset, now), reset)
})

test('a stale reset mark never rewinds the natural window', () => {
  const now = new Date('2026-08-03T15:00:00')
  assert.equal(quotaWindowStart('daily', '2026-07-01T00:00:00.000Z', now), localMidnight('2026-08-03T15:00:00'))
})

test('the weekly window starts on Monday local midnight', () => {
  const start = quotaWindowStart('weekly', '', new Date('2026-08-06T15:00:00'))
  assert.equal(new Date(start).getDay(), 1)
  assert.ok(new Date(start).getTime() <= new Date('2026-08-06T15:00:00').getTime())
})

test('the total window only honors explicit resets', () => {
  assert.equal(quotaWindowStart('total', ''), '1970-01-01T00:00:00.000Z')
  assert.equal(quotaWindowStart('total', '2026-08-01T00:00:00.000Z'), '2026-08-01T00:00:00.000Z')
  assert.equal(quotaWindowResetAt('total', new Date('2026-08-03T15:00:00')), null)
})

test('daily and weekly windows expose their next automatic reset timestamp', () => {
  const now = new Date('2026-08-05T15:00:00') // 周三
  const timing = quotaWindowTiming('', '', '', now)
  const dailyReset = new Date(timing.daily.resetsAt || '')
  const weeklyReset = new Date(timing.weekly.resetsAt || '')
  assert.equal(dailyReset.getHours(), 0)
  assert.equal(dailyReset.getDate(), 6)
  assert.equal(weeklyReset.getDay(), 1)
  assert.equal(weeklyReset.getHours(), 0)
  assert.ok(weeklyReset.getTime() > now.getTime())
})

test('only quota-blocked keys are auto-restored, never manually disabled ones', () => {
  const under = evaluateQuota({ totalUsd: 10, dailyUsd: 0, weeklyUsd: 0 }, { total: 1, daily: 0, weekly: 0 })
  const plan = planQuotaActions([
    { keyHash: 'quota-blocked', enabled: false, blockedReason: '总额度已用 $10.00 / $10.00', state: under },
    { keyHash: 'manually-off', enabled: false, blockedReason: '', state: under },
  ])
  assert.deepEqual(plan.restore, ['quota-blocked'])
  assert.deepEqual(plan.block, [])
})

test('an over-quota enabled key is scheduled for blocking with its window', () => {
  const over = evaluateQuota({ totalUsd: 0, dailyUsd: 5, weeklyUsd: 0 }, { total: 0, daily: 7, weekly: 0 })
  const plan = planQuotaActions([{ keyHash: 'k1', enabled: true, blockedReason: '', state: over }])
  assert.deepEqual(plan.block, [{ keyHash: 'k1', window: 'daily' }])
})

test('an already-blocked key is not blocked twice', () => {
  const over = evaluateQuota({ totalUsd: 5, dailyUsd: 0, weeklyUsd: 0 }, { total: 9, daily: 0, weekly: 0 })
  const plan = planQuotaActions([{ keyHash: 'k1', enabled: false, blockedReason: '总额度已用', state: over }])
  assert.deepEqual(plan.block, [])
  assert.deepEqual(plan.restore, [])
})
