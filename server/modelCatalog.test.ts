import assert from 'node:assert/strict'
import test from 'node:test'
import { mergeGatewayPriceSnapshot } from './modelCatalog.js'
import type { ModelPricing } from './pricing.js'

const priced = (input: number, output: number, cacheRead = input): ModelPricing => ({
  from: '1970-01-01', input, output, cacheRead, unit: 'token',
})

test('合并网关价快照：本轮没回的老模型必须留在快照里', () => {
  const existing = { 'gemini-3.8-flash': { from: '1970-01-01', input: 0.75, output: 3.75, cacheRead: 0.075 } }
  const merged = mergeGatewayPriceSnapshot(existing, new Map([['gpt-6-astra', priced(10, 50, 1)]]))
  // 整份覆盖会在这里把 gemini-3.8-flash 抹掉，下次重启该模型就记成未定价
  assert.deepEqual(merged['gemini-3.8-flash'], existing['gemini-3.8-flash'])
  assert.equal(merged['gpt-6-astra'].input, 10)
})

test('合并网关价快照：同一个模型上游改价时以本轮为准', () => {
  const existing = { 'gpt-6-astra': { from: '1970-01-01', input: 10, output: 50, cacheRead: 1 } }
  const merged = mergeGatewayPriceSnapshot(existing, new Map([['gpt-6-astra', priced(8, 40, 0.8)]]))
  assert.equal(merged['gpt-6-astra'].input, 8)
  assert.equal(merged['gpt-6-astra'].cacheRead, 0.8)
})

test('合并网关价快照：落盘结构里不带 unit、丢掉无效价', () => {
  const merged = mergeGatewayPriceSnapshot({}, new Map([
    ['ok', priced(1, 2, 0.1)],
    ['broken', { from: '1970-01-01', input: Number.NaN, output: 2, cacheRead: 0, unit: 'token' }],
  ]))
  assert.equal('unit' in merged.ok, false)
  assert.equal('broken' in merged, false)
})

test('合并网关价快照：保留完整字段（until / cacheWrite / tiers / note）', () => {
  const merged = mergeGatewayPriceSnapshot({}, new Map([['promo', {
    from: '2026-08-21', until: '2026-11-21', input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5,
    tiers: [{ above: 272_000, input: 8, output: 30, cacheRead: 0.8, cacheWrite: 10 }],
    note: '促销', unit: 'token',
  } as ModelPricing]]))
  assert.deepEqual(merged.promo, {
    from: '2026-08-21', until: '2026-11-21', input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5,
    tiers: [{ above: 272_000, input: 8, output: 30, cacheRead: 0.8, cacheWrite: 10 }], note: '促销',
  })
})
