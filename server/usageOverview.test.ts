import assert from 'node:assert/strict'
import test from 'node:test'
import { buildDailySeries, buildUsageOverview, type UsageModelRow } from './usageOverview.js'

const anchor = new Date('2026-07-31T12:00:00')

function row(partial: Partial<UsageModelRow> & { model: string; provider: string }): UsageModelRow {
  return {
    requests: 1,
    newInputTokens: 0,
    outputTokens: 0,
    cacheTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    activeDays: 1,
    ...partial,
  }
}

test('daily series fills gap days so the heatmap keeps calendar spacing', () => {
  const series = buildDailySeries([{ day: '2026-07-31', totalTokens: 100 }], 3, anchor)
  assert.deepEqual(series.map((point) => point.day), ['2026-07-29', '2026-07-30', '2026-07-31'])
  assert.deepEqual(series.map((point) => point.totalTokens), [0, 0, 100])
})

test('intensity scales against the busiest day in range', () => {
  const series = buildDailySeries(
    [
      { day: '2026-07-29', totalTokens: 100 },
      { day: '2026-07-30', totalTokens: 40 },
      { day: '2026-07-31', totalTokens: 0 },
    ],
    3,
    anchor,
  )
  assert.deepEqual(series.map((point) => point.intensity), [4, 2, 0])
})

test('cost skips unpriced models instead of guessing a price', () => {
  const overview = buildUsageOverview(
    [
      row({ model: 'claude-opus-5', provider: 'claude', newInputTokens: 1_000_000, outputTokens: 0, totalTokens: 1_000_000 }),
      row({ model: 'mystery-model', provider: 'other', newInputTokens: 5_000_000, totalTokens: 5_000_000 }),
    ],
    [],
    7,
    anchor,
  )
  assert.equal(overview.estimatedCostUsd, 5)
  assert.equal(overview.hasPartialCost, true)
  assert.deepEqual(overview.unpricedModels, ['mystery-model'])
})

test('cost is null when nothing in range has a known price', () => {
  const overview = buildUsageOverview([row({ model: 'mystery', provider: 'other', totalTokens: 10 })], [], 7, anchor)
  assert.equal(overview.estimatedCostUsd, null)
})

test('cached tokens are priced at the cache rate, not the input rate', () => {
  const overview = buildUsageOverview(
    [row({ model: 'claude-opus-5', provider: 'claude', cacheTokens: 1_000_000, totalTokens: 1_000_000 })],
    [],
    7,
    anchor,
  )
  assert.equal(overview.estimatedCostUsd, 0.5)
})

test('providers aggregate their models and keep the biggest one as the headline', () => {
  const overview = buildUsageOverview(
    [
      row({ model: 'gpt-5.6-sol', provider: 'codex', outputTokens: 900, totalTokens: 900, requests: 9 }),
      row({ model: 'gpt-5.4-mini', provider: 'codex', outputTokens: 100, totalTokens: 100, requests: 1 }),
      row({ model: 'claude-opus-5', provider: 'claude', outputTokens: 500, totalTokens: 500, requests: 5 }),
    ],
    [],
    7,
    anchor,
  )
  assert.deepEqual(overview.providers.map((provider) => provider.id), ['codex', 'claude'])
  const codex = overview.providers[0]
  assert.equal(codex.topModel, 'gpt-5.6-sol')
  assert.equal(codex.totalTokens, 1000)
  assert.equal(codex.requests, 10)
  assert.equal(codex.models, 2)
})

test('cache share measures cache against the new-input/output/cache mix', () => {
  const overview = buildUsageOverview(
    [row({ model: 'claude-opus-5', provider: 'claude', newInputTokens: 100, outputTokens: 100, cacheTokens: 200, totalTokens: 400 })],
    [],
    7,
    anchor,
  )
  assert.equal(overview.cacheShare, 0.5)
})

test('empty range reports no cost and no best day rather than zeroes', () => {
  const overview = buildUsageOverview([], [], 7, anchor)
  assert.equal(overview.estimatedCostUsd, null)
  assert.equal(overview.cacheShare, null)
  assert.equal(overview.bestDay, null)
  assert.equal(overview.activeDays, 0)
})

test('daily points carry the breakdown a hover card needs', () => {
  const series = buildDailySeries(
    [{ day: '2026-07-31', totalTokens: 1000, requests: 4, newInputTokens: 400, outputTokens: 200, cacheTokens: 400, errors: 1 }],
    2,
    anchor,
    [
      { day: '2026-07-31', model: 'claude-opus-5', totalTokens: 700 },
      { day: '2026-07-31', model: 'gpt-5.6-sol', totalTokens: 300 },
    ],
  )
  const today = series.at(-1)
  assert.equal(today?.requests, 4)
  assert.equal(today?.errors, 1)
  assert.deepEqual(today?.topModels.map((entry) => entry.model), ['claude-opus-5', 'gpt-5.6-sol'])
  assert.ok((today?.estimatedCostUsd ?? 0) > 0)
})

test('gap days expose zeroed detail rather than undefined', () => {
  const series = buildDailySeries([], 2, anchor)
  assert.equal(series[0].requests, 0)
  assert.deepEqual(series[0].topModels, [])
  assert.equal(series[0].estimatedCostUsd, null)
})
