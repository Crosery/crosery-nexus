import assert from 'node:assert/strict'
import test from 'node:test'
import { buildModelIndex } from './modelIndex.js'

const channel = (name: string, enabled: boolean, models: Array<[string, boolean, number]>) => ({
  name,
  baseUrl: `https://${name}.example/v1`,
  keyCount: 1,
  enabled,
  stale: false,
  models: models.map(([id, on, upstreams]) => ({ id, enabled: on, upstreams })),
})

test('inverts channel to model mapping', () => {
  const index = buildModelIndex([channel('kimi', true, [['kimi-k3', true, 1]])], [])
  assert.equal(index.length, 1)
  assert.equal(index[0].id, 'kimi-k3')
  assert.deepEqual(index[0].sources.map((source) => source.channel), ['kimi'])
  assert.equal(index[0].enabledSources, 1)
  assert.equal(index[0].contested, false)
})

test('flags a model served by more than one channel', () => {
  // 今天的真实事故：裸名 gpt-5.6-sol 同时挂在 codex 与 qijichuangtan 上
  const index = buildModelIndex(
    [channel('qijichuangtan', true, [['gpt-5.6-sol', true, 1]])],
    [{ provider: 'codex', models: ['gpt-5.6-sol'], excluded: [], activeAccounts: 1 }],
  )
  const entry = index.find((model) => model.id === 'gpt-5.6-sol')
  assert.ok(entry)
  assert.equal(entry.contested, true)
  assert.deepEqual(entry.sources.map((source) => source.channel), ['codex', 'qijichuangtan'])
  assert.deepEqual(entry.sources.map((source) => source.kind), ['oauth', 'compat'])
})

test('treats an excluded oauth model as disabled but still listed', () => {
  const index = buildModelIndex([], [{ provider: 'codex', models: ['gpt-5.6-sol'], excluded: ['gpt-image-1'], activeAccounts: 1 }])
  const excluded = index.find((model) => model.id === 'gpt-image-1')
  assert.ok(excluded, '被排除的模型仍要列出，否则无法再启用回来')
  assert.equal(excluded.sources[0].enabled, false)
  assert.equal(excluded.enabledSources, 0)
})

test('marks oauth models unavailable when every account is disabled', () => {
  // 账号全停用时仍列出模型，但标记为不可用，否则界面上模型会凭空消失、无法解释
  const index = buildModelIndex([], [{ provider: 'codex', models: ['gpt-5.6-sol'], excluded: [], activeAccounts: 0 }])
  const entry = index.find((model) => model.id === 'gpt-5.6-sol')
  assert.ok(entry)
  assert.equal(entry.sources[0].enabled, false)
  assert.equal(entry.sources[0].channelEnabled, false)
  assert.equal(entry.enabledSources, 0)
})

test('a model whose only other source is disabled is not contested', () => {
  // 停用渠道仍列在 sources 里供恢复，但请求不会分流到它，不该再触发「多渠道」告警。
  const index = buildModelIndex(
    [channel('mox-aigw', false, [['gpt-5.6-sol', true, 1]])],
    [{ provider: 'codex', models: ['gpt-5.6-sol'], excluded: [], activeAccounts: 1 }],
  )
  const entry = index.find((model) => model.id === 'gpt-5.6-sol')
  assert.ok(entry)
  assert.equal(entry.sources.length, 2)
  assert.equal(entry.enabledSources, 1)
  assert.equal(entry.contested, false)
})

test('a model in a disabled channel is reported disabled', () => {
  const index = buildModelIndex([channel('qiji', false, [['glm-5.2', true, 1]])], [])
  const entry = index.find((model) => model.id === 'glm-5.2')
  assert.ok(entry)
  assert.equal(entry.sources[0].enabled, false, '渠道停用则其下模型不可用')
  assert.equal(entry.sources[0].channelEnabled, false)
})

test('sorts contested models first', () => {
  const index = buildModelIndex(
    [channel('a-chan', true, [['zzz-solo', true, 1]]), channel('b-chan', true, [['shared', true, 1]])],
    [{ provider: 'codex', models: ['shared'], excluded: [], activeAccounts: 1 }],
  )
  assert.equal(index[0].id, 'shared')
  assert.equal(index[0].contested, true)
})

test('keeps per-channel upstream counts', () => {
  const index = buildModelIndex([channel('kimi', true, [['kimi-k2.7-code', true, 2]])], [])
  assert.equal(index[0].sources[0].upstreams, 2)
})

test('attaches public per-million pricing to a model even without recorded usage', () => {
  const index = buildModelIndex([channel('claude', true, [['claude-opus-5', true, 1]])], [])
  assert.deepEqual(index[0].pricing, { input: 5, output: 25, cacheRead: 0.5, unit: 'token' })
})
