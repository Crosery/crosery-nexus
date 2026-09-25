import assert from 'node:assert/strict'
import test from 'node:test'
import { buildUsageBreakdown, costForRow, type BreakdownRow } from './usageBreakdown.js'

const row = (partial: Partial<BreakdownRow> & { model: string }): BreakdownRow => ({
  requests: 1,
  newInputTokens: 0,
  outputTokens: 0,
  cacheTokens: 0,
  reasoningTokens: 0,
  totalTokens: 0,
  ...partial,
})

test('cost splits into input, output and cache segments', () => {
  // claude-opus-5: 5 / 25 / 0.5 per 1M
  const cost = costForRow(row({ model: 'claude-opus-5', newInputTokens: 1_000_000, outputTokens: 1_000_000, cacheTokens: 1_000_000, totalTokens: 3_000_000 }))
  assert.equal(cost.inputCostUsd, 5)
  assert.equal(cost.outputCostUsd, 25)
  assert.equal(cost.cacheCostUsd, 0.5)
  assert.equal(cost.totalCostUsd, 30.5)
  assert.equal(cost.priced, true)
})

test('unpriced models report null, not zero, so "free" is distinguishable', () => {
  const cost = costForRow(row({ model: 'totally-unknown', newInputTokens: 9_000_000, totalTokens: 9_000_000 }))
  assert.equal(cost.totalCostUsd, null)
  assert.equal(cost.inputCostUsd, null)
  assert.equal(cost.priced, false)
})

test('breakdown sorts by cost and aggregates segment totals', () => {
  const breakdown = buildUsageBreakdown([
    row({ model: 'claude-haiku-4-5-20251001', newInputTokens: 1_000_000, totalTokens: 1_000_000, requests: 3 }),
    row({ model: 'claude-opus-5', outputTokens: 1_000_000, totalTokens: 1_000_000, requests: 2 }),
  ])
  assert.deepEqual(breakdown.models.map((model) => model.model), ['claude-opus-5', 'claude-haiku-4-5-20251001'])
  assert.equal(breakdown.totals.outputCostUsd, 25)
  assert.equal(breakdown.totals.inputCostUsd, 1)
  assert.equal(breakdown.totals.totalCostUsd, 26)
  assert.equal(breakdown.totals.requests, 5)
})

test('unpriced models are listed once by bare name', () => {
  const breakdown = buildUsageBreakdown([
    row({ model: 'qiji/totally-unknown', totalTokens: 10 }),
    row({ model: 'totally-unknown', totalTokens: 10 }),
  ])
  assert.deepEqual(breakdown.unpricedModels, ['totally-unknown'])
})

test('unpriced rows contribute zero to totals rather than NaN', () => {
  const breakdown = buildUsageBreakdown([
    row({ model: 'claude-opus-5', outputTokens: 1_000_000, totalTokens: 1_000_000 }),
    row({ model: 'mystery', outputTokens: 5_000_000, totalTokens: 5_000_000 }),
  ])
  assert.equal(breakdown.totals.totalCostUsd, 25)
  assert.equal(Number.isNaN(breakdown.totals.totalCostUsd), false)
})

test('image rows use the published image token price card', () => {
  const cost = costForRow(row({ model: 'gpt-image-2', newInputTokens: 1_000_000, outputTokens: 1_000_000, cacheTokens: 1_000_000 }))
  assert.equal(cost.pricing?.unit, 'token')
  assert.equal(cost.priced, true)
  assert.equal(cost.inputCostUsd, 8)
  assert.equal(cost.outputCostUsd, 30)
  assert.equal(cost.cacheCostUsd, 2)
  assert.equal(cost.totalCostUsd, 40)
})
