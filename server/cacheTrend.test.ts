import assert from 'node:assert/strict'
import test from 'node:test'
import { bucketSecondsFor, buildTrend, type TrendRow } from './cacheTrend.js'

const row = (partial: Partial<TrendRow> & { model: string; timestamp: string }): TrendRow => ({
  inputTokens: 0,
  outputTokens: 0,
  cachedTokens: 0,
  ...partial,
})

test('分桶粒度随跨度自适应', () => {
  assert.equal(bucketSecondsFor(1), 60)
  assert.equal(bucketSecondsFor(6), 300)
  assert.equal(bucketSecondsFor(24), 900)
  assert.equal(bucketSecondsFor(72), 3600)
  assert.equal(bucketSecondsFor(24 * 7), 6 * 3600)
  assert.equal(bucketSecondsFor(24 * 30), 24 * 3600)
})

test('同一分钟内的请求合并为一个桶', () => {
  const { points } = buildTrend(
    [
      row({ model: 'claude-opus-5', timestamp: '2026-08-10T12:00:05Z', inputTokens: 10, cachedTokens: 90 }),
      row({ model: 'claude-opus-5', timestamp: '2026-08-10T12:00:55Z', inputTokens: 10, cachedTokens: 90 }),
    ],
    1,
  )
  assert.equal(points.length, 1)
  assert.equal(points[0].requests, 2)
  assert.equal(points[0].freshInputTokens, 20)
  assert.equal(points[0].hitRate, 0.9)
})

test('跨桶的请求分开统计并按时间升序', () => {
  const { points } = buildTrend(
    [
      row({ model: 'claude-opus-5', timestamp: '2026-08-10T12:05:00Z', inputTokens: 50, cachedTokens: 50 }),
      row({ model: 'claude-opus-5', timestamp: '2026-08-10T12:00:00Z', inputTokens: 10, cachedTokens: 90 }),
    ],
    1,
  )
  assert.equal(points.length, 2)
  assert.ok(points[0].bucket < points[1].bucket, '按时间升序')
  assert.equal(points[0].hitRate, 0.9)
  assert.equal(points[1].hitRate, 0.5)
})

test('两家口径在同一个桶内各自归一化', () => {
  const { points } = buildTrend(
    [
      // anthropic: 并列 → fresh 100
      row({ model: 'claude-opus-5', timestamp: '2026-08-10T12:00:00Z', inputTokens: 100, cachedTokens: 900 }),
      // openai: 子集 → fresh 100
      row({ model: 'gpt-5.6-sol', timestamp: '2026-08-10T12:00:10Z', inputTokens: 1000, cachedTokens: 900 }),
    ],
    1,
  )
  assert.equal(points.length, 1)
  assert.equal(points[0].freshInputTokens, 200)
  assert.equal(points[0].cacheReadTokens, 1800)
  assert.equal(points[0].hitRate, 0.9)
})

test('空桶不补零，避免画出误导性的 0% 折线', () => {
  const { points } = buildTrend(
    [
      row({ model: 'claude-opus-5', timestamp: '2026-08-10T12:00:00Z', inputTokens: 1, cachedTokens: 99 }),
      // 中间空了 10 分钟
      row({ model: 'claude-opus-5', timestamp: '2026-08-10T12:10:00Z', inputTokens: 1, cachedTokens: 99 }),
    ],
    1,
  )
  assert.equal(points.length, 2, '只有两个真实有数据的桶')
})

test('未定价模型不污染成本合计', () => {
  const { points } = buildTrend(
    [
      row({ model: 'totally-unknown', timestamp: '2026-08-10T12:00:00Z', inputTokens: 1_000_000 }),
      row({ model: 'claude-opus-5', timestamp: '2026-08-10T12:00:10Z', inputTokens: 1_000_000 }),
    ],
    1,
  )
  assert.equal(points[0].costUsd, 5, '只有 claude 计入')
})

test('非法时间戳被跳过而不是崩溃', () => {
  const { points } = buildTrend(
    [
      row({ model: 'claude-opus-5', timestamp: 'not-a-date', inputTokens: 5 }),
      row({ model: 'claude-opus-5', timestamp: '2026-08-10T12:00:00Z', inputTokens: 1, cachedTokens: 99 }),
    ],
    1,
  )
  assert.equal(points.length, 1)
})

test('空输入返回空点集', () => {
  const { points, bucketSeconds } = buildTrend([], 24)
  assert.deepEqual(points, [])
  assert.equal(bucketSeconds, 900)
})

test('预聚合行保留请求数与归一化 token 总量', () => {
  const result = buildTrend([
    row({
      model: 'gpt-5.6-sol',
      timestamp: '2026-08-10T12:00:00Z',
      requests: 7,
      freshInputTokens: 700,
      cacheReadTokens: 6_300,
      cacheWriteTokens: 0,
      outputTokens: 70,
    }),
  ], 24)
  assert.equal(result.points[0]?.requests, 7)
  assert.equal(result.points[0]?.freshInputTokens, 700)
  assert.equal(result.points[0]?.cacheReadTokens, 6_300)
})
