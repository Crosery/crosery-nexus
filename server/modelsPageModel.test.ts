import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildModelRows, canonicalModel, catalogSyncFacts, fmtUnitPrice, fmtWindow, hourLabel, liveEvidence, modelVendor, priceView, rowInView,
  rowMatches, sortModelRows, viewCounts, type IndexModel, type ModelInsights,
} from '../src/features/models/modelRows.js'

/*
 * /models row model (DESIGN §6.6): one row per canonical model, unknown is never 0, a missing price is never $0,
 * and the default view (在用, busiest 7 days first) puts traffic on page one instead of `~vendor/...-latest` aliases.
 */

const NOW = Date.UTC(2026, 9, 2, 0, 30) // 08:30 Asia/Shanghai
const src = (channel: string, enabled = true, extra: Partial<IndexModel['sources'][number]> = {}) => ({ channel, kind: 'compat' as const, enabled, upstreams: 1, channelEnabled: enabled, ...extra })
const model = (id: string, overrides: Partial<IndexModel> = {}): IndexModel => {
  const sources = overrides.sources ?? []
  return { id, pricing: null, sources, enabledSources: sources.filter((s) => s.enabled).length, contested: false, ...overrides }
}

const index: IndexModel[] = [
  model('nvidia/nemotron-3:free', { sources: [src('openrouter')], pricingSources: { openrouter: { input: 0, output: 0, sourceId: 'nvidia/nemotron-3:free' } } }),
  model('nemotron-3:free', { pricingSources: { openrouter: { input: 0, output: 0, sourceId: 'nvidia/nemotron-3:free' } }, availableOnGateway: false }),
  model('~anthropic/claude-fable-latest', { sources: [src('openrouter')], pricingSources: { openrouter: { input: 10, output: 50, sourceId: '~anthropic/claude-fable-latest' } } }),
  model('cline-pass/deepseek-v4-flash', { sources: [src('cline-pass', false)] }),
  model('deepseek/deepseek-v4-flash', { sources: [src('openrouter'), src('zhiyu')], pricing: { input: 0.2, output: 0.4, cacheRead: 0.04 }, pricingSources: { 'models.dev': { input: 0.2, output: 0.4 }, openrouter: { input: 0.21, output: 0.4, sourceId: 'deepseek/deepseek-v4-flash' } } }),
  model('gemma-4:free', { sources: [src('openrouter')] }),
  model('qoder/old-model', { sources: [src('qoder-cn', false)] }),
  model('catalog-only-x', { pricingSources: { 'models.dev': { input: 1, output: 2 } }, availableOnGateway: false }),
]
const usage = { models: [
  { model: 'nemotron-3:free', requests: 3, totalTokens: 1677, costUsd: null },
  { model: 'deepseek-v4-flash', requests: 2, totalTokens: 400, costUsd: 0.01 },
  { model: 'gemma-4:free', requests: 4, totalTokens: 0, costUsd: null },
] }
const insights: ModelInsights = {
  days: 7, from: '', generatedAt: '', degraded: [],
  usage: [
    { model: 'nemotron-3:free', requests: 3, errors: 0, lastOkHour: '2026-10-01T23:00:00.000Z', lastErrorHour: null, topError: null, channels: [{ channel: 'openrouter', requests: 3, errors: 0 }] },
    { model: 'gemma-4:free', requests: 4, errors: 4, lastOkHour: null, lastErrorHour: '2026-09-30T14:00:00.000Z', topError: { status: 429, category: 'rate_limited', requests: 3 }, channels: [] },
  ],
  specs: [{ model: 'deepseek-v4-flash', name: null, contextWindow: 1_048_576, maxOutput: 65_536, reasoning: true, efforts: ['high'], specSource: 'catalog' }],
  probes: [{ channel: 'openrouter', lastProbeAt: '2026-10-01T23:23:16.520Z', nextProbeAt: null, status: 200, error: null, discovered: 464, backoffUntil: null }],
}
const channelNames = ['openrouter', 'cline-pass', 'zhiyu', 'qoder-cn']
const rows = buildModelRows({ models: index, channelNames, usage, insights, now: NOW })
const byKey = new Map(rows.map((row) => [row.key, row]))

test('rows fold vendor prefixes and catalog twins into one canonical model with aliases', () => {
  assert.equal(canonicalModel('qiji/claude-opus-5[1m]'), 'claude-opus-5')
  assert.equal(rows.length, 6)
  const nemotron = byKey.get('nemotron-3:free')!
  assert.equal(nemotron.id, 'nvidia/nemotron-3:free', 'the routable entry names the row')
  assert.deepEqual(nemotron.aliases, ['nemotron-3:free'])
  const flash = byKey.get('deepseek-v4-flash')!
  assert.equal(flash.id, 'deepseek/deepseek-v4-flash')
  assert.deepEqual(flash.mappings.map((m) => [m.model, m.channel, m.enabled]), [
    ['deepseek/deepseek-v4-flash', 'openrouter', true], ['deepseek/deepseek-v4-flash', 'zhiyu', true], ['cline-pass/deepseek-v4-flash', 'cline-pass', false],
  ], 'every mapping keeps its exact id for the PATCH')
  assert.equal(flash.enabledChannels, 2)
  assert.equal(flash.channels, 3)
  assert.equal(flash.multi, true)
})

test('vendor: OpenRouter source id first, a serving channel prefix is not a vendor, keywords last', () => {
  assert.equal(byKey.get('claude-fable-latest')?.vendor, 'anthropic')
  assert.equal(byKey.get('nemotron-3:free')?.vendor, 'nvidia')
  assert.equal(modelVendor([model('cline-pass/glm-5.2', { sources: [src('cline-pass')] })], new Set(['cline-pass'])), 'zhipu')
  assert.equal(modelVendor([model('z-ai/glm-5.2')], new Set()), 'zhipu')
  assert.equal(modelVendor([model('mystery-model')], new Set()), 'other')
})

test('price: billing beats a quote, the matching source is named, a quote alone is only a reference, nothing is 未定价', () => {
  assert.deepEqual(byKey.get('deepseek-v4-flash')?.price, { kind: 'billing', input: 0.2, output: 0.4, free: false, source: 'models.dev' })
  const fable = byKey.get('claude-fable-latest')!
  assert.equal(fable.price.kind, 'reference')
  assert.equal(fable.unbilled, true)
  assert.equal(byKey.get('nemotron-3:free')?.price.free, true)
  assert.deepEqual(priceView(null, {}), { kind: 'none', input: null, output: null, free: false, source: null })
  assert.equal(priceView({ input: 3, output: 15, cacheRead: 0.3 }, { openrouter: { input: 3.1, output: 15 } }).source, null, 'no matching quote → 价表')
})

test('unknown is not zero: no usage payload → null tokens; loaded usage without calls → 0', () => {
  const blind = buildModelRows({ models: index, channelNames, usage: null, insights: null, now: NOW })
  assert.equal(blind.find((row) => row.key === 'deepseek-v4-flash')?.tokens, null)
  assert.equal(byKey.get('claude-fable-latest')?.tokens, 0)
  assert.equal(byKey.get('claude-fable-latest')?.successRate, null)
  assert.equal(byKey.get('nemotron-3:free')?.successRate, 1)
})

test('health: all-failing traffic is 不可用 (to-do), recent success is 可用, a probe is evidence, catalog-only is not 停用', () => {
  const gemma = byKey.get('gemma-4:free')!
  assert.equal(gemma.status, 'bad')
  assert.equal(gemma.statusLabel, '不可用')
  assert.ok(gemma.note.includes('429 rate_limited'))
  assert.equal(byKey.get('nemotron-3:free')?.statusLabel, '可用')
  assert.equal(byKey.get('nemotron-3:free')?.note, '最近成功 07 时')
  assert.equal(byKey.get('claude-fable-latest')?.note, 'openrouter 探测 07:23 ✓')
  assert.equal(byKey.get('old-model')?.status, 'off')
  assert.equal(byKey.get('catalog-only-x')?.statusLabel, '仅目录')
  assert.equal(byKey.get('catalog-only-x')?.bad, false)
})

test('health judges current routes: a removed channel\'s failures cannot mark 不可用, its old success cannot vouch 可用', () => {
  const ev = {
    model: 'gemma-4:free', requests: 12, errors: 10, lastOkHour: '2026-10-01T22:00:00.000Z', lastErrorHour: '2026-10-01T23:00:00.000Z',
    topError: { status: 429, category: 'rate_limited', requests: 10 },
    channels: [
      { channel: 'retired', requests: 10, errors: 10, removed: true, lastOkHour: null },
      { channel: 'openrouter', requests: 2, errors: 0, removed: false, lastOkHour: '2026-10-01T21:00:00.000Z' },
    ],
  }
  assert.deepEqual(liveEvidence(ev), { ...ev, requests: 2, errors: 0, lastOkHour: '2026-10-01T21:00:00.000Z', topError: null, channels: [ev.channels[1]] })
  const legacy = { ...ev, channels: [{ channel: 'openrouter', requests: 12, errors: 10 }] }
  assert.equal(liveEvidence(legacy), legacy, 'a payload without removed markers (older server) is used as is')
  const only = buildModelRows({ models: index, channelNames, usage, insights: { ...insights, usage: [ev] }, now: NOW }).find((row) => row.key === 'gemma-4:free')!
  assert.equal(only.statusLabel, '可用')
  assert.equal(only.successRate, 1)
  assert.equal(only.tokens, 0, 'totals still come from the usage report (all traffic)')
})

test('views and counts: 在用 / 异常 / 多渠道 / 未定价 / 已停用 / 全部 never overlap in meaning', () => {
  assert.deepEqual(viewCounts(rows), { inuse: 4, attn: 1, multi: 1, unpriced: 3, off: 1, all: 6 })
  assert.equal(rows.filter((row) => rowInView(row, 'off')).map((row) => row.key).join(), 'old-model')
  assert.ok(rowMatches(byKey.get('nemotron-3:free')!, 'NVIDIA'))
  assert.ok(rowMatches(byKey.get('deepseek-v4-flash')!, 'cline-pass'), 'search reaches aliases and channels')
})

test('default sort: busiest 7 days first, failing models before silent ones, unknown always last', () => {
  const inUse = rows.filter((row) => rowInView(row, 'inuse'))
  assert.deepEqual(sortModelRows(inUse, 'tokens', 'desc').map((row) => row.key), ['nemotron-3:free', 'deepseek-v4-flash', 'gemma-4:free', 'claude-fable-latest'])
  const byContext = sortModelRows(rows, 'context', 'asc').map((row) => row.key)
  assert.equal(byContext[0], 'deepseek-v4-flash', 'the only known context sorts first even ascending')
  assert.deepEqual(sortModelRows(rows, 'context', 'desc').map((row) => row.key)[0], 'deepseek-v4-flash')
})

test('formatting: per-M prices, binary windows, hourly evidence, catalog sync head', () => {
  assert.equal(fmtUnitPrice(3), '$3')
  assert.equal(fmtUnitPrice(0.7999999999999999), '$0.8')
  assert.equal(fmtUnitPrice(0.075), '$0.075')
  assert.equal(fmtUnitPrice(null), '—')
  assert.equal(fmtWindow(262_144), '256K')
  assert.equal(fmtWindow(200_000), '200K')
  assert.equal(fmtWindow(1_048_576), '1M')
  assert.equal(fmtWindow(null), '—')
  assert.equal(hourLabel('2026-10-01T23:00:00.000Z', NOW), '07 时')
  assert.equal(hourLabel('2026-09-30T03:00:00.000Z', NOW), '09/30 11 时')
  const job = { id: 'model-discovery', state: 'idle', lastRunAt: '2026-10-01T23:23:15Z', lastFinishedAt: '2026-10-01T23:23:16Z', nextRunAt: '2026-10-01T23:51:31Z', lastResult: 'ok', lastError: null, summary: '503 模型 · 探测 1/1', backoffUntil: null }
  const clock = (at: string) => new Date(at).toISOString().slice(11, 16)
  assert.deepEqual(catalogSyncFacts(job, clock), { state: 'run', text: '目录 23:23 ✓', next: '23:51', detail: '503 模型 · 探测 1/1' })
  assert.equal(catalogSyncFacts({ ...job, state: 'backoff', backoffUntil: '2026-10-02T00:10:00Z' }, clock)?.state, 'warn')
  assert.equal(catalogSyncFacts({ ...job, lastResult: 'error', lastError: 'HTTP 401' }, clock)?.text, '目录 23:23 失败')
  assert.equal(catalogSyncFacts(undefined, clock), null)
})

test('verdict cause comes from the current channels: a removed channel\'s error is never named for current failures', () => {
  const ev = {
    model: 'gemma-4:free', requests: 103, errors: 103, lastOkHour: null, lastErrorHour: '2026-10-01T23:00:00.000Z',
    topError: { status: 429, category: 'rate_limited', requests: 100 },
    liveTopError: { status: 401, category: 'auth_failed', requests: 3 },
    channels: [
      { channel: 'retired', requests: 100, errors: 100, removed: true, lastOkHour: null },
      { channel: 'openrouter', requests: 3, errors: 3, removed: false, lastOkHour: null },
    ],
  }
  const live = liveEvidence(ev)!
  assert.deepEqual([live.requests, live.errors, live.topError], [3, 3, { status: 401, category: 'auth_failed', requests: 3 }])
  // older server without the split: no cause rather than the wrong one
  const { liveTopError: _drop, ...old } = ev
  assert.equal(liveEvidence(old)!.topError, null)
  const insightsWith = (usageRow: typeof ev | typeof old) => ({ ...insights, usage: [usageRow] })
  const row = buildModelRows({ models: index, channelNames, usage, insights: insightsWith(ev), now: NOW }).find((item) => item.key === 'gemma-4:free')!
  assert.equal(row.statusLabel, '不可用')
  assert.equal(row.note, '近 7 天 3 次全部失败 · 401 auth_failed')
  const oldRow = buildModelRows({ models: index, channelNames, usage, insights: insightsWith(old), now: NOW }).find((item) => item.key === 'gemma-4:free')!
  assert.equal(oldRow.note, '近 7 天 3 次全部失败')
})

test('类型：行沿用服务端的 kind（别名折叠时取可路由的那条），旧服务端没有 kind 就是 null；类型选项只列存在的类型', async () => {
  const { kindChips, kindTag } = await import('../src/lib/modelKind.js')
  const typed = buildModelRows({
    models: [
      model('google/gemini-3.1-flash-image', { sources: [src('openrouter')], kind: 'image' }),
      model('gemini-3.1-flash-image', { availableOnGateway: false, kind: 'image' }),
      model('gemini-3.8-flash', { sources: [src('openrouter')], kind: 'chat' }),
      model('veo-3.1-generate-preview', { availableOnGateway: false, kind: 'video' }),
      model('legacy-x', { sources: [src('openrouter')] }),
    ],
    channelNames, usage: null, insights: null, now: NOW,
  })
  const kinds = Object.fromEntries(typed.map((row) => [row.key, row.kind]))
  assert.deepEqual(kinds, { 'gemini-3.1-flash-image': 'image', 'gemini-3.8-flash': 'chat', 'veo-3.1-generate-preview': 'video', 'legacy-x': null })
  assert.equal(kindTag('chat'), null, '对话是默认，不打标签')
  assert.equal(kindTag('image'), '图片')
  assert.equal(kindTag(null), null)
  assert.equal(kindTag('image', 'image'), null, '已按类型筛选时每行都同一类，不再重复打标签')

  const all = typed.map((row) => row.kind)
  const inUse = typed.filter((row) => rowInView(row, 'inuse')).map((row) => row.kind)
  assert.deepEqual(kindChips(all, inUse, ''), [
    { value: '', label: '全部类型' },
    { value: 'chat', label: '对话', count: 1 },
    { value: 'image', label: '图片', count: 1 },
    { value: 'video', label: '视频', count: 0 },
  ], '固定顺序；数量跟着其它筛选走，视频在「在用」里是 0 但选项不消失')
  assert.equal(kindChips(['chat', 'chat', null], ['chat'], ''), null, '只有一种类型就不显示类型筛选')
  assert.deepEqual(kindChips(['chat'], ['chat'], 'video')?.map((chip) => chip.value), ['', 'chat', 'video'], '已选的类型即使没有也保留，筛选状态看得见')
  assert.deepEqual(kindChips(all, null, '')?.map((chip) => chip.count), [undefined, null, null, null], '没读到目录就不给数量')
})
