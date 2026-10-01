import './testDataDir.js'

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

/**
 * task-78：双源价格（models.dev / openrouter）+ 并集 + 「未收录」语义。
 *
 * 全部用**固定夹具**（不联网）：唯一联网的实现是共享同步脚本 `~/.agents/crosery/sync.mjs`，
 * 本仓库只做薄 adapter（读产物）+ 展示。
 */

const pricing = await import('./pricing.js')
type SharedPricingRow = import('./pricing.js').SharedPricingRow
type PricingSourceStatus = import('./pricing.js').PricingSourceStatus
const { loadSharedPricing, sharedCatalogPath } = await import('./modelSync.js')
const { buildModelCatalog, mergePricingSourceModels } = await import('./modelCatalog.js')

/** 夹具：与共享产物 `pricing` 段同形状（一个模型两个来源都给了价格，另一个只有一个来源）。 */
const FIXTURE: {
  sources: Partial<Record<'models.dev' | 'openrouter', PricingSourceStatus>>
  rows: SharedPricingRow[]
} = {
  sources: {
    openrouter: { ok: true, fetchedAt: 1_790_859_683_478, entries: 456 },
    'models.dev': { ok: true, fetchedAt: 1_790_859_684_909, entries: 214 },
  },
  rows: [
    {
      id: 'claude-sonnet-4-6', source: 'openrouter', sourceId: 'anthropic/claude-sonnet-4.6',
      prices: { openrouter: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75, unit: 'usd-per-million-tokens' } },
    },
    {
      id: 'claude-sonnet-4-6', source: 'models.dev', sourceId: 'anthropic:claude-sonnet-4-6',
      prices: { 'models.dev': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75, unit: 'usd-per-million-tokens' } },
    },
    {
      // 两个来源报价**不一致**：差值必须能被看出来
      id: 'price-mismatch-model', source: 'openrouter', sourceId: 'vendor/price-mismatch',
      prices: { openrouter: { input: 1, output: 2, unit: 'usd-per-million-tokens' } },
    },
    {
      id: 'price-mismatch-model', source: 'models.dev', sourceId: 'vendor:price-mismatch',
      prices: { 'models.dev': { input: 1.5, output: 3, unit: 'usd-per-million-tokens' } },
    },
    {
      // 只有 models.dev 收录：另一个来源必须"缺席"而不是补 0
      id: 'fixture-only-models-dev-9f3a2b', source: 'models.dev', sourceId: 'vendor:fixture-only-models-dev-9f3a2b',
      prices: { 'models.dev': { input: 0.2, output: 0.4, unit: 'usd-per-million-tokens' } },
    },
  ],
}

test('双源价格：两个来源各自保存、互不覆盖，并带上各自的抓取时间戳', () => {
  pricing.resetSharedPricing()
  const applied = pricing.applySharedPricing({ rows: FIXTURE.rows, sources: FIXTURE.sources }, 1_800_000_000_000)
  assert.equal(applied.rows, 5, '夹具 5 行都要落地')
  assert.equal(applied.models, 3, '归一化后是 3 个模型')
  assert.deepEqual(applied.degraded, [], '两个来源都 ok ⇒ 无降级')

  const both = pricing.getPricingSources('anthropic/claude-sonnet-4-6') // 带渠道前缀也要能匹配
  assert.deepEqual(Object.keys(both.sources).sort(), ['models.dev', 'openrouter'], '两个来源并存')
  assert.equal(both.sources['models.dev']?.input, 3)
  assert.equal(both.sources.openrouter?.input, 3)
  assert.equal(both.sources['models.dev']?.fetchedAt, 1_790_859_684_909, 'models.dev 的时间戳随行带出')
  assert.equal(both.sources.openrouter?.fetchedAt, 1_790_859_683_478, 'openrouter 的时间戳随行带出')
  assert.equal(both.sources.openrouter?.sourceId, 'anthropic/claude-sonnet-4.6', '保留来源原始 id 便于溯源')

  // 两个来源不一致时，差值可见（不是"取其一"）
  const mismatch = pricing.getPricingSources('price-mismatch-model')
  assert.equal(mismatch.sources.openrouter?.input, 1)
  assert.equal(mismatch.sources['models.dev']?.input, 1.5)
  assert.notEqual(mismatch.sources.openrouter?.input, mismatch.sources['models.dev']?.input)

  // 只有一个来源收录时，另一个来源**缺席**（不能补 0 冒充免费）
  const onlyOne = pricing.getPricingSources('fixture-only-models-dev-9f3a2b')
  assert.deepEqual(Object.keys(onlyOne.sources), ['models.dev'])
  assert.equal(onlyOne.sources.openrouter, undefined, '缺失的来源必须缺席，而不是 0')

  // 幂等：同一份快照重复应用，结果一致
  const again = pricing.applySharedPricing({ rows: FIXTURE.rows, sources: FIXTURE.sources }, 1_800_000_001_000)
  assert.equal(again.models, 3)
  assert.deepEqual(pricing.getPricingSources('claude-sonnet-4-6').sources['models.dev']?.input, 3)
  pricing.resetSharedPricing()
})

test('取不到外部数据时降级可见：产物缺失 / 来源 ok=false / 空，且**不用旧值冒充新值**', () => {
  // ① 先灌一份"正常"的快照
  pricing.applySharedPricing({ rows: FIXTURE.rows, sources: FIXTURE.sources })
  assert.equal(pricing.getPricingSources('claude-sonnet-4-6').sources.openrouter?.input, 3)

  // ② 产物整段缺失
  const missing = pricing.applySharedPricing(null)
  assert.ok(missing.degraded.includes('shared-pricing-missing'), `必须如实标注：${JSON.stringify(missing.degraded)}`)
  assert.deepEqual(pricing.getPricingSources('claude-sonnet-4-6').sources, {}, '不能拿上一次的值冒充新值')
  assert.ok(pricing.pricingSourceStatus().degraded.includes('shared-pricing-missing'))

  // ③ 某个来源失败（ok=false）：另一个来源照常，失败的那个显式标注
  const partial = pricing.applySharedPricing({
    rows: FIXTURE.rows.filter(row => row.source === 'models.dev'),
    sources: { ...FIXTURE.sources, openrouter: { ok: false, fetchedAt: 1_790_859_683_478, error: 'HTTP 503' } },
  })
  assert.ok(partial.degraded.includes('source-unavailable:openrouter'), JSON.stringify(partial.degraded))
  assert.deepEqual(Object.keys(pricing.getPricingSources('claude-sonnet-4-6').sources), ['models.dev'])
  assert.equal(pricing.pricingSourceStatus().sources.openrouter?.error, 'HTTP 503', '失败原因要能被展示层读到')

  // ④ 空段
  const empty = pricing.applySharedPricing({ rows: [], sources: FIXTURE.sources })
  assert.ok(empty.degraded.includes('shared-pricing-empty'), JSON.stringify(empty.degraded))
  pricing.resetSharedPricing()
  const unloaded = pricing.pricingSourceStatus()
  assert.deepEqual(unloaded.degraded, ['shared-pricing-not-loaded'], '没跑过同步时也要有明确状态')
})

test('薄 adapter：只读共享产物（不联网），写成固定的 catalog.json 夹具就能落地；缺文件则降级', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crosery-pricing-fixture-'))
  const file = path.join(dir, 'catalog.json')
  const previous = process.env.CROSERY_SHARED_CATALOG
  try {
    process.env.CROSERY_SHARED_CATALOG = file
    assert.equal(sharedCatalogPath(), file, '产物路径可注入（测试用夹具）')

    // ① 没有文件 → 降级可见，不当成"没有价格就是免费"
    const before = loadSharedPricing()
    assert.equal(before.ok, false)
    assert.ok(before.degraded.includes('shared-pricing-missing'))

    // ② 写夹具（与共享产物同形状）→ 落地
    fs.writeFileSync(file, JSON.stringify({
      version: 1, generatedAt: 1_790_859_690_000, provider: 'crosery', baseUrl: 'https://example.invalid/v1',
      models: [], pricing: FIXTURE,
    }))
    const after = loadSharedPricing()
    assert.equal(after.ok, true, JSON.stringify(after))
    assert.equal(after.rows, 5)
    assert.equal(after.path, file)
    assert.deepEqual(after.degraded, [])
    assert.equal(pricing.getPricingSources('claude-sonnet-4-6').sources.openrouter?.input, 3)

    // ③ 老产物（没有 pricing 段）→ 明确降级
    fs.writeFileSync(file, JSON.stringify({ version: 1, generatedAt: 1, provider: 'x', baseUrl: 'y', models: [] }))
    const legacy = loadSharedPricing()
    assert.equal(legacy.ok, false)
    assert.ok(legacy.degraded.includes('shared-pricing-missing'), '老产物必须显式降级，而不是静默无价格')
  } finally {
    if (previous === undefined) delete process.env.CROSERY_SHARED_CATALOG
    else process.env.CROSERY_SHARED_CATALOG = previous
    fs.rmSync(dir, { recursive: true, force: true })
    pricing.resetSharedPricing()
  }
})

test('模型总览并集：价格来源里有、网关没有的模型也要出现，且标记 unpriced / availableOnGateway', () => {
  pricing.resetSharedPricing()
  pricing.applySharedPricing({ rows: FIXTURE.rows, sources: FIXTURE.sources })

  // 走真实构建路径（网关目录），这样 availableOnGateway / unpriced 才会被算出
  const gatewayCatalog = buildModelCatalog([
    { provider: 'anthropic', models: [{ id: 'claude-sonnet-4-6' }] },
  ])
  const merged = mergePricingSourceModels(gatewayCatalog)

  const ids = merged.map(model => model.id)
  assert.ok(ids.includes('claude-sonnet-4-6'), '网关原有模型必须保留')
  assert.ok(ids.includes('fixture-only-models-dev-9f3a2b'), '只在价格来源里出现的模型必须并进总览')
  assert.deepEqual([...ids].sort(), ids, '并集结果按 id 有序')
  assert.equal(new Set(ids).size, ids.length, '不得重复')

  const onlySource = merged.find(model => model.id === 'fixture-only-models-dev-9f3a2b')!
  assert.equal(onlySource.availableOnGateway, false, '不在网关上可用要标出来')
  assert.deepEqual(Object.keys(onlySource.pricingSources || {}), ['models.dev'])
  assert.equal(pricing.getModelPricing('fixture-only-models-dev-9f3a2b'), null, '夹具 id 必须不在本地价表里（否则这条断言没意义）')
  // 语义：unpriced 表示"**任何**来源都没有价格"。这里 models.dev 给了价 ⇒ false；
  // 但 openrouter 那一列**缺席**，前端该列显示「未收录」（不是 0）。
  assert.equal(onlySource.unpriced, false, '有任一来源报价就不算未收录')
  assert.equal((onlySource.pricingSources as Record<string, unknown>).openrouter, undefined, '缺失的来源必须缺席')

  const gatewayOne = merged.find(model => model.id === 'claude-sonnet-4-6')!
  assert.equal(gatewayOne.availableOnGateway, true)
  assert.equal(gatewayOne.unpriced, false, '有来源价格 ⇒ 不是未收录')

  // 「未收录」必须是"没有数字"，绝不能是 0（0 会被读成免费）
  // 「未收录」必须是"没有数字"，绝不能是 0（0 会被读成免费）：逐项检查值，而不是字符串前缀
  const sourceValues = Object.values(onlySource.pricingSources || {})
  assert.ok(sourceValues.length > 0, '这条模型应当有 models.dev 报价')
  for (const item of sourceValues) {
    for (const field of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) {
      const value = (item as Record<string, unknown>)[field]
      if (value === undefined) continue
      assert.ok(Number(value) > 0, `${field} 不得为 0（会被读成免费）：${JSON.stringify(item)}`)
    }
  }
  assert.equal(onlySource.pricing, null, '没有权威价时 pricing 为 null，不是 0 价')

  // 完全没有任何来源价格的模型（走真实的 buildModelCatalog 路径）⇒ unpriced=true 且不带 0 价
  const bareId = 'fixture-bare-7d21c9'
  assert.equal(pricing.getModelPricing(bareId), null, '夹具 id 必须不在本地价表里')
  const bareCatalog = buildModelCatalog([{ provider: 'fixture', models: [{ id: bareId }] }])
  const bareEntry = bareCatalog.find(model => model.id === bareId)!
  assert.equal(bareEntry.pricing, null)
  assert.equal(bareEntry.pricingSources, undefined, '没有来源价格就不该有 pricingSources 字段')
  assert.equal(bareEntry.unpriced, true, '完全无价 ⇒ unpriced=true（前端显示「未收录」，不是 0）')
  assert.ok(!('pricingSources' in bareEntry), '未收录的条目不带任何来源价格字段（所以也没有 0 价）')

  // 幂等：再并一次不会重复
  assert.equal(mergePricingSourceModels(merged).length, merged.length)
  pricing.resetSharedPricing()
})
