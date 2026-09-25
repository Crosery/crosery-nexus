import assert from 'node:assert/strict'
import test from 'node:test'
import { estimateCost, getModelPricing, getPriceHistory, normalizeModelForPricing, priceRequest } from './pricing.js'

const rates = (pricing: ReturnType<typeof getModelPricing>) =>
  pricing ? { input: pricing.input, output: pricing.output, cacheRead: pricing.cacheRead, cacheWrite: pricing.cacheWrite } : null

test('channel prefixes resolve to the same price as the bare model', () => {
  assert.deepEqual(rates(getModelPricing('qiji/claude-opus-5')), rates(getModelPricing('claude-opus-5')))
  assert.deepEqual(rates(getModelPricing('codex-static/gpt-5.6-sol')), rates(getModelPricing('gpt-5.6-sol')))
  assert.equal(normalizeModelForPricing('qiji/gemini-2.5-flash-thinking'), 'gemini-2.5-flash-thinking')
  assert.equal(normalizeModelForPricing('claude-opus-5'), 'claude-opus-5')
})

test('prefix stripping shares canonicalModelSql semantics: only the first slash is a channel prefix', () => {
  // SQL 侧 instr(model,'/') 取第一个斜杠之后；JS 侧必须一致，否则同一模型会被拆成两条统计
  assert.equal(normalizeModelForPricing('openai-compatible/mox-aigw/gpt-5.6-sol'), 'mox-aigw/gpt-5.6-sol')
  // 查价本身更宽松：剩余的多级前缀仍能落到同一份价格
  assert.deepEqual(rates(getModelPricing('openai-compatible/mox-aigw/gpt-5.6-sol')), rates(getModelPricing('gpt-5.6-sol')))
})

test('Claude Code [1m] suffix and dot/dash version variants map to one price', () => {
  assert.equal(normalizeModelForPricing('claude-fable-5-1[1m]'), 'claude-fable-5-1')
  assert.deepEqual(rates(getModelPricing('claude-fable-5-1[1m]')), rates(getModelPricing('claude-fable-5-1')))
  assert.deepEqual(rates(getModelPricing('claude-fable-5.1')), rates(getModelPricing('claude-fable-5-1')))
  assert.deepEqual(rates(getModelPricing('minimax-m3')), rates(getModelPricing('MiniMax-M3')))
  assert.ok(getModelPricing('claude-fable-5-1'))
})

test('current first-party prices come from models.dev', () => {
  assert.deepEqual(rates(getModelPricing('claude-opus-5')), { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 })
  assert.deepEqual(rates(getModelPricing('claude-fable-5-1')), { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 })
  const sol = getModelPricing('gpt-5.6-sol', '2026-09-02')
  assert.ok(sol)
  assert.deepEqual(rates(sol), { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 })
  assert.equal(sol.until, '2026-11-21')
  assert.equal(sol.unit, 'token')
})

test('prices are selected by the usage timestamp, not by today', () => {
  const before = getModelPricing('gpt-5.6-sol', '2026-08-01')
  const promo = getModelPricing('gpt-5.6-sol', new Date('2026-09-02T10:00:00+08:00'))
  const after = getModelPricing('gpt-5.6-sol', Date.parse('2026-12-01T00:00:00Z'))
  const earliest = getModelPricing('gpt-5.6-sol', '2026-01-01')
  assert.equal(before?.input, 5)
  assert.equal(promo?.input, 4)
  assert.equal(after?.input, 5)
  // 早于首条生效日的历史用量按最早已知价计，而不是变成未定价
  assert.equal(earliest?.input, 5)
  assert.equal(getPriceHistory('gpt-5.6-sol').length, 3)
})

test('context tiers price the whole request once the prompt exceeds the threshold', () => {
  // OpenAI：>272k 后输入 8 / 输出 30，整单按该档计
  assert.equal(estimateCost('gpt-5.6-sol', 300_000, 1_000, 0, 0, { at: '2026-09-02', promptTokens: 300_000 }), (300_000 * 8 + 1_000 * 30) / 1_000_000)
  assert.equal(estimateCost('gpt-5.6-sol', 300_000, 1_000, 0, 0, { at: '2026-09-02' }), (300_000 * 4 + 1_000 * 20) / 1_000_000)
  // priceRequest 自动用三段之和当提示长度：10 万新输入 + 25 万缓存读 = 35 万 > 272k
  assert.equal(priceRequest('gpt-5.6-sol', { newInputTokens: 100_000, outputTokens: 0, cacheReadTokens: 250_000, at: '2026-09-02' }), (100_000 * 8 + 250_000 * 0.8) / 1_000_000)
  // 未超阈值用基础价
  assert.equal(priceRequest('gpt-5.6-sol', { newInputTokens: 100_000, outputTokens: 0, cacheReadTokens: 100_000, at: '2026-09-02' }), (100_000 * 4 + 100_000 * 0.4) / 1_000_000)
  // 没有分档的模型不受提示长度影响
  assert.equal(estimateCost('claude-opus-5', 1_000_000, 0, 0, 0, { promptTokens: 900_000 }), 5)
})

test('unknown models stay unpriced instead of falling back to a guess', () => {
  assert.equal(getModelPricing('totally-unknown'), null)
  assert.equal(estimateCost('totally-unknown', 1000, 1000, 0), null)
  assert.deepEqual(getPriceHistory('totally-unknown'), [])
})

test('cached tokens bill at the cache rate', () => {
  assert.equal(estimateCost('claude-opus-5', 1_000_000, 0, 0), 5)
  assert.equal(estimateCost('claude-opus-5', 0, 0, 1_000_000), 0.5)
})

test('Codex Spark stays unpriced until its official rate card has numeric prices', () => {
  assert.equal(getModelPricing('gpt-5.3-codex-spark'), null)
  assert.equal(estimateCost('gpt-5.3-codex-spark', 1_000_000, 1_000_000, 1_000_000), null)
})

test('image models use their published image input, output and cache token rates', () => {
  assert.deepEqual(rates(getModelPricing('gpt-image-2')), { input: 8, output: 30, cacheRead: 2, cacheWrite: undefined })
  assert.equal(estimateCost('gpt-image-2', 1_000_000, 1_000_000, 1_000_000), 40)
})

test('models that used to be unpriced now resolve', () => {
  for (const model of ['gemini-3.7-flash', 'gemini-3-flash', 'gemini-3-flash-agent', 'gemini-3.1-pro-preview', 'claude-opus-4-6-thinking', 'qwen3.7-max', 'gpt-image-1.5', 'deepseek-v4-pro']) {
    assert.ok(getModelPricing(model), `${model} 应已定价`)
  }
  const flash = getModelPricing('gemini-3.7-flash', '2026-09-02')
  assert.equal(flash?.input, 0.75)
  assert.equal(flash?.until, '2026-12-31')
})

test('channel-prefixed and effort-suffixed aliases borrow the base model price', () => {
  for (const [alias, base] of [
    ['cline-deepseek-v4.1-flash', 'deepseek-v4.1-flash'],
    ['qcn-qwen3.7-max', 'qwen3.7-max'],
    ['deepseek-v4.1-flash(high)', 'deepseek-v4.1-flash'],
  ]) {
    assert.deepEqual(rates(getModelPricing(alias)), rates(getModelPricing(base)), alias)
  }
})

test('an unlisted version borrows the nearest version of the same model line, never another tier', () => {
  assert.deepEqual(rates(getModelPricing('qcn-glm-5.3')), rates(getModelPricing('glm-5.2')))
  assert.deepEqual(rates(getModelPricing('qcn-qwen3.8-flash')), rates(getModelPricing('qwen3.7-flash')))
  // flash 不能借 max / 正式版的价：骨架不同就保持未定价
  assert.equal(getModelPricing('cline-glm-5.3-flash'), null)
  assert.equal(getModelPricing('qcn-kimi-k2.8-preview'), null)
})
