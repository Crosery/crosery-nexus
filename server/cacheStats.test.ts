import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CACHE_WRITE_CEILING,
  bandFor,
  cacheDialectFor,
  costForTokens,
  hitRate,
  isOverCacheCeiling,
  normalizeTokens,
  wastedCostFor,
} from './cacheStats.js'

test('claude 与 gpt 的 cached 口径相反', () => {
  assert.equal(cacheDialectFor('claude-opus-5'), 'anthropic')
  assert.equal(cacheDialectFor('qiji/claude-opus-5'), 'anthropic')
  assert.equal(cacheDialectFor('claude-opus-5', { provider: 'claude' }), 'anthropic')
  assert.equal(cacheDialectFor('qiji/claude-opus-5', { provider: 'qijichuangtan' }), 'openai')
  assert.equal(cacheDialectFor('gpt-5.6-sol'), 'openai')
  assert.equal(cacheDialectFor('codex-static/gpt-5.6-sol'), 'openai')
  assert.equal(cacheDialectFor('minimax-m3'), 'openai')
})

test('anthropic: input 与 cached 并列，input 即新输入', () => {
  // 线上真实形态：cached 远大于 input
  const t = normalizeTokens({ model: 'claude-opus-5', inputTokens: 260, outputTokens: 500, cachedTokens: 6_256_869 })
  assert.equal(t.freshInputTokens, 260)
  assert.equal(t.cacheReadTokens, 6_256_869)
  assert.equal(t.promptTokens, 6_257_129)
})

test('openai: cached 是 input 的子集，需扣减', () => {
  const t = normalizeTokens({ model: 'gpt-5.6-sol', inputTokens: 2006, outputTokens: 100, cachedTokens: 1920 })
  assert.equal(t.freshInputTokens, 86)
  assert.equal(t.cacheReadTokens, 1920)
  assert.equal(t.promptTokens, 2006)
})

test('回归：旧公式把 gpt 命中率压低约一半', () => {
  // 线上 7 天 gpt-5.6-sol 实际聚合值
  const t = normalizeTokens({ model: 'gpt-5.6-sol', inputTokens: 5_995_484_903, outputTokens: 0, cachedTokens: 5_664_047_616 })
  const correct = hitRate(t)!
  assert.ok(correct > 0.94 && correct < 0.95, `期望 ~94.5%，实际 ${(correct * 100).toFixed(1)}%`)

  // 旧公式 cached/(input+cached) 的结果
  const legacy = 5_664_047_616 / (5_995_484_903 + 5_664_047_616)
  assert.ok(legacy < 0.49, '旧公式确实低于 49%')
})

test('回归：旧 SQL 把 claude 新输入夹成 0', () => {
  // cached > input 时 MAX(input-cached,0) 恒为 0
  const legacy = Math.max(260 - 6_256_869, 0)
  assert.equal(legacy, 0)

  const t = normalizeTokens({ model: 'claude-opus-5', inputTokens: 260, outputTokens: 0, cachedTokens: 6_256_869 })
  assert.equal(t.freshInputTokens, 260, '归一化后不再被夹成 0')
})

// 价格表按日期分段且有长上下文阶梯价，断言必须钉住日期、并区分阶梯内外，否则会随「今天」漂移。
const BASE_PRICE_DAY = '2026-08-10'

test('gpt 缓存段不再重复计费', () => {
  const t = normalizeTokens({ model: 'gpt-5.6-sol', inputTokens: 200_000, outputTokens: 0, cachedTokens: 180_000 })
  // gpt-5.6-sol 基础价（≤272K）: input 5 / cacheRead 0.5 per 1M；只有 2 万是新输入
  const expected = (20_000 * 5 + 180_000 * 0.5) / 1_000_000
  assert.equal(costForTokens('gpt-5.6-sol', t, BASE_PRICE_DAY), expected)

  // 旧口径会把整个 20 万按 input 全价计，明显偏高
  const legacy = (200_000 * 5 + 180_000 * 0.5) / 1_000_000
  assert.ok(legacy > expected * 3, '旧口径确实高估')
})

test('gpt 超过 272K 输入整单走长上下文阶梯价', () => {
  const t = normalizeTokens({ model: 'gpt-5.6-sol', inputTokens: 1_000_000, outputTokens: 0, cachedTokens: 900_000 })
  // 阶梯价: input 10 / cacheRead 1 per 1M
  assert.equal(costForTokens('gpt-5.6-sol', t, BASE_PRICE_DAY), (100_000 * 10 + 900_000 * 1) / 1_000_000)
})

test('claude 三段计价按并列口径', () => {
  const t = normalizeTokens({ model: 'claude-opus-5', inputTokens: 1_000_000, outputTokens: 1_000_000, cachedTokens: 1_000_000 })
  // 5 / 25 / 0.5 per 1M
  assert.equal(costForTokens('claude-opus-5', t), 30.5)
})

test('未定价模型返回 null 而不是 0', () => {
  const t = normalizeTokens({ model: 'totally-unknown', inputTokens: 9_000_000, outputTokens: 0, cachedTokens: 0 })
  assert.equal(costForTokens('totally-unknown', t), null)
  assert.equal(wastedCostFor('totally-unknown', t), null)
})

test('缓存写入上限：663k 内正常，越线标红', () => {
  // 实测最大可命中样本：prompt=663,063，其中 663,052 命中缓存
  const ok = normalizeTokens({ model: 'claude-opus-5', inputTokens: 11, outputTokens: 0, cachedTokens: 663_052 })
  assert.equal(ok.promptTokens, 663_063)
  assert.equal(isOverCacheCeiling(ok), true, '663,063 已略高于 663k 基准，属灰区')

  // 明确安全的样本
  const safe = normalizeTokens({ model: 'claude-opus-5', inputTokens: 610_183, outputTokens: 0, cachedTokens: 0 })
  assert.equal(isOverCacheCeiling(safe), false)

  const over = normalizeTokens({ model: 'claude-opus-5', inputTokens: 737_583, outputTokens: 0, cachedTokens: 1_902 })
  assert.equal(isOverCacheCeiling(over), true)
  assert.ok(over.promptTokens > CACHE_WRITE_CEILING)
})

test('上下文分档把超上限单独切出来', () => {
  assert.equal(bandFor(10_000), '<50k')
  assert.equal(bandFor(200_000), '150-250k')
  assert.equal(bandFor(500_000), '400-663k')
  assert.equal(bandFor(740_000), '>663k 超缓存上限')
})

test('浪费金额 = 新输入按全价与缓存价的差额', () => {
  const t = normalizeTokens({ model: 'claude-opus-5', inputTokens: 737_583, outputTokens: 0, cachedTokens: 1_902 })
  // (5 - 0.5) / 1M * 737583
  assert.ok(Math.abs(wastedCostFor('claude-opus-5', t)! - 3.319) < 0.01)
})
