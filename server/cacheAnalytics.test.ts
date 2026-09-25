import assert from 'node:assert/strict'
import test from 'node:test'
import { buildCacheAnalytics, type CacheEventRow } from './cacheAnalytics.js'
import { costForTokens, hitRate, normalizeTokens } from './cacheStats.js'

const row = (partial: Partial<CacheEventRow> & { model: string }): CacheEventRow => ({
  timestamp: '2026-08-10T00:00:00Z',
  endpoint: 'POST /v1/chat/completions',
  source: 'crosery',
  keyName: '程耀宇',
  authIndex: 'a1',
  inputTokens: 0,
  outputTokens: 0,
  cachedTokens: 0,
  latencyMs: 100,
  ...partial,
})

test('两家口径混在一起时命中率各自归一化', () => {
  const analytics = buildCacheAnalytics([
    // gpt: cached 是 input 子集 → 新输入 100k，命中 900k
    row({ model: 'gpt-5.6-sol', inputTokens: 1_000_000, cachedTokens: 900_000 }),
    // claude: 并列 → 新输入 100k，命中 900k
    row({ model: 'claude-opus-5', inputTokens: 100_000, cachedTokens: 900_000 }),
  ])
  const gpt = analytics.byModel.find((m) => m.label === 'gpt-5.6-sol')!
  const claude = analytics.byModel.find((m) => m.label === 'claude-opus-5')!

  assert.equal(gpt.freshInputTokens, 100_000)
  assert.equal(claude.freshInputTokens, 100_000)
  assert.equal(gpt.hitRate, 0.9)
  assert.equal(claude.hitRate, 0.9)
  assert.equal(gpt.dialect, 'openai')
  assert.equal(claude.dialect, 'anthropic')
})

test('超缓存上限的请求被单独计数并归入专属档位', () => {
  const analytics = buildCacheAnalytics([
    row({ model: 'claude-opus-5', inputTokens: 737_583, cachedTokens: 1_902 }),
    row({ model: 'claude-opus-5', inputTokens: 500, cachedTokens: 610_000 }),
  ])
  assert.equal(analytics.overall.overCeilingRequests, 1)
  const overBand = analytics.byContextBand.find((b) => b.label.includes('超缓存上限'))!
  assert.equal(overBand.requests, 1)
  assert.equal(overBand.freshInputTokens, 737_583)
})

test('worstRequests 按浪费金额排序并标记越线', () => {
  const analytics = buildCacheAnalytics([
    row({ model: 'claude-opus-5', inputTokens: 737_583, cachedTokens: 1_902 }),
    row({ model: 'claude-opus-5', inputTokens: 1_000, cachedTokens: 100_000 }),
  ])
  assert.equal(analytics.worstRequests.length, 2)
  assert.equal(analytics.worstRequests[0].freshInputTokens, 737_583)
  assert.equal(analytics.worstRequests[0].overCeiling, true)
  assert.equal(analytics.worstRequests[1].overCeiling, false)
  assert.ok(analytics.worstRequests[0].wastedUsd! > analytics.worstRequests[1].wastedUsd!)
})

test('全命中的请求不进入 worstRequests', () => {
  const analytics = buildCacheAnalytics([row({ model: 'claude-opus-5', inputTokens: 0, cachedTokens: 500_000 })])
  assert.equal(analytics.worstRequests.length, 0)
  assert.equal(analytics.overall.hitRate, 1)
})

test('按真实 provider 聚合渠道，不把 keyName 或 source 冒充渠道', () => {
  const analytics = buildCacheAnalytics([
    row({ model: 'gpt-5.6-sol', provider: 'minimax', keyName: '极客班', inputTokens: 1000, cachedTokens: 500 }),
    row({ model: 'gpt-5.6-sol', provider: 'qijichuangtan', keyName: null, source: 'abel@aucegypt.edu', inputTokens: 1000, cachedTokens: 500 }),
  ], [
    { id: 'minimax', name: 'MiniMax', color: '', kind: 'compat', models: ['gpt-5.6-sol'] },
  ])
  assert.deepEqual(analytics.byChannel.map((c) => c.label), ['MiniMax'])
})

test('未定价模型不污染成本合计', () => {
  const analytics = buildCacheAnalytics([
    row({ model: 'totally-unknown', inputTokens: 1_000_000, cachedTokens: 0 }),
    row({ model: 'claude-opus-5', inputTokens: 1_000_000, cachedTokens: 0 }),
  ])
  // 只有 claude 计入
  assert.equal(analytics.overall.costUsd, 5)
})

test('空输入不产生除零', () => {
  const analytics = buildCacheAnalytics([])
  assert.equal(analytics.overall.hitRate, null)
  assert.equal(analytics.overall.requests, 0)
  assert.equal(analytics.byModel.length, 0)
})

/**
 * 生产事故回归：Anthropic 的 cache_creation_tokens 早期没有落库，
 * 导致 claude 系列命中率恒为 100%、成本系统性低估约 12%。
 * 实测样本：input=2 / cacheRead=73630 / cacheWrite=77076 / output=670。
 */
test('anthropic cache writes count against the hit rate instead of vanishing', () => {
  const withWrite = normalizeTokens({
    model: 'claude-opus-5',
    inputTokens: 2,
    outputTokens: 670,
    cachedTokens: 73_630,
    cacheWriteTokens: 77_076,
  })
  // 写入段必须进入分母，否则首次写缓存的请求会被算成满命中
  assert.equal(withWrite.promptTokens, 2 + 73_630 + 77_076)
  const rate = hitRate(withWrite)
  assert.ok(rate !== null && rate < 0.5, `写入段进入分母后命中率应显著低于 100%，实际 ${rate}`)

  // 漏接写入段时的旧行为：命中率被抬到几乎 100%
  const withoutWrite = normalizeTokens({
    model: 'claude-opus-5',
    inputTokens: 2,
    outputTokens: 670,
    cachedTokens: 73_630,
  })
  const staleRate = hitRate(withoutWrite)
  assert.ok(staleRate !== null && staleRate > 0.99, '无写入段时才会出现接近 100% 的命中率')
})

test('cache writes are billed at the 1.25x input rate rather than free', () => {
  const tokens = normalizeTokens({
    model: 'claude-opus-5',
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    cacheWriteTokens: 1_000_000,
  })
  // claude-opus-5 输入价 $5/M，写入应为 $6.25/M；当成免费正是低估账单的原因
  assert.equal(costForTokens('claude-opus-5', tokens), 6.25)
})

test('openai dialect never invents a cache write segment', () => {
  // OpenAI 口径下 cached 已含在 input 内，没有独立写入计费段
  const tokens = normalizeTokens({
    model: 'gpt-5.6-terra',
    inputTokens: 51_432,
    outputTokens: 1_785,
    cachedTokens: 27_136,
    cacheWriteTokens: 9_999,
  })
  assert.equal(tokens.cacheWriteTokens, 0)
  assert.equal(tokens.freshInputTokens, 51_432 - 27_136)
})
