import assert from 'node:assert/strict'
import test from 'node:test'
import { mergeChannelView } from './channelView.js'
import { providerChannelName } from './cpa.js'

const liveChannel = {
  name: 'kimi',
  'base-url': 'https://api.kimi.com/coding/v1',
  'api-key-entries': [{ 'api-key': 'sk-a' }],
  models: [{ name: 'kimi-k3', alias: 'kimi-k3' }, { name: 'kimi-k2.7-code' }],
}

test('reports a gateway channel as enabled with its models', () => {
  const [channel] = mergeChannelView([liveChannel], [], [])
  assert.equal(channel.enabled, true)
  assert.equal(channel.keyCount, 1)
  assert.deepEqual(channel.models.map((model) => model.id), ['kimi-k2.7-code', 'kimi-k3'])
  assert.ok(channel.models.every((model) => model.enabled))
})

test('restores a disabled channel from its local snapshot', () => {
  const snapshot = { name: 'qiji', enabled: 0, snapshot_json: JSON.stringify({ name: 'qiji', 'base-url': 'https://api.openai-next.com/v1', models: [{ name: 'glm-5.2' }] }) }
  const views = mergeChannelView([liveChannel], [snapshot], [])
  const off = views.find((view) => view.name === 'qiji')
  assert.ok(off, '停用渠道必须仍然出现在列表里')
  assert.equal(off.enabled, false)
  assert.equal(off.baseUrl, 'https://api.openai-next.com/v1')
  assert.deepEqual(off.models.map((model) => model.id), ['glm-5.2'])
})

test('marks a model absent from the gateway as disabled', () => {
  const [channel] = mergeChannelView([liveChannel], [], [{ channel: 'kimi', model: 'kimi-legacy', enabled: 0 }])
  const legacy = channel.models.find((model) => model.id === 'kimi-legacy')
  assert.ok(legacy, '停用模型必须仍然出现，否则无法再启用回来')
  assert.equal(legacy.enabled, false)
})

test('never duplicates a model that is back in the gateway', () => {
  const [channel] = mergeChannelView([liveChannel], [], [{ channel: 'kimi', model: 'kimi-k3', enabled: 0 }])
  assert.equal(channel.models.filter((model) => model.id === 'kimi-k3').length, 1)
  assert.equal(channel.models.find((model) => model.id === 'kimi-k3')?.enabled, true)
})

test('ignores a stale snapshot once the channel is live again', () => {
  const stale = { name: 'kimi', enabled: 0, snapshot_json: JSON.stringify({ name: 'kimi', models: [] }) }
  const views = mergeChannelView([liveChannel], [stale], [])
  assert.equal(views.filter((view) => view.name === 'kimi').length, 1)
  assert.equal(views[0].enabled, true)
})

test('folds multiple upstreams sharing one alias into a single switch', () => {
  // 真实配置：kimi 渠道用两条上游轮询同一个对外名 kimi-k2.7-code
  const shared = {
    name: 'kimi',
    models: [
      { name: 'kimi-for-coding', alias: 'kimi-k2.7-code' },
      { name: 'kimi-for-coding-highspeed', alias: 'kimi-k2.7-code' },
      { name: 'k3', alias: 'kimi-k3' },
    ],
  }
  const [channel] = mergeChannelView([shared], [], [])
  assert.deepEqual(channel.models.map((model) => model.id), ['kimi-k2.7-code', 'kimi-k3'])
  assert.equal(channel.models.find((model) => model.id === 'kimi-k2.7-code')?.upstreams, 2)
  assert.equal(channel.models.find((model) => model.id === 'kimi-k3')?.upstreams, 1)
})

test('respects a disabled flag retained by CPA', () => {
  const [channel] = mergeChannelView([{ ...liveChannel, disabled: true }], [], [])
  assert.equal(channel.enabled, false)
})

test('sorts enabled channels ahead of disabled ones', () => {
  const snapshot = { name: 'aaa-off', enabled: 0, snapshot_json: JSON.stringify({ name: 'aaa-off' }) }
  const views = mergeChannelView([liveChannel], [snapshot], [])
  assert.deepEqual(views.map((view) => view.name), ['kimi', 'aaa-off'])
})

test('survives a corrupted snapshot without dropping the channel', () => {
  const broken = { name: 'broken', enabled: 0, snapshot_json: '{not json' }
  const views = mergeChannelView([], [broken], [])
  assert.equal(views.length, 1)
  assert.equal(views[0].name, 'broken')
  assert.equal(views[0].enabled, false)
})

test('provider-endpoint channels are named after their base-url host', () => {
  assert.equal(providerChannelName({ 'base-url': 'https://api.kimi.com/coding' }, 'claude-api-key', 0), 'kimi')
  assert.equal(providerChannelName({ 'base-url': 'https://ollama.com/v1' }, 'claude-api-key', 1), 'ollama')
  // 同一 host 同时承载多个原生协议时，显式 prefix 必须成为稳定渠道名，避免快照和权限组碰撞。
  assert.equal(providerChannelName({ prefix: 'opencode-go-msg', 'base-url': 'https://opencode.ai/zen/go' }, 'claude-api-key', 0), 'opencode-go-msg')
  assert.equal(providerChannelName({ prefix: 'opencode-go-resp', 'base-url': 'https://opencode.ai/zen/go/v1' }, 'codex-api-key', 0), 'opencode-go-resp')
  // base-url 缺失时回退到端点名，不能产生空名字
  assert.equal(providerChannelName({}, 'claude-api-key', 2), 'claude-api-key-3')
  assert.equal(providerChannelName({ 'base-url': 'not a url' }, 'codex-api-key', 0), 'codex-api-key-1')
})

test('a channel deleted on the CPA side is excluded from the current view', () => {
  const snapshots = [
    { name: 'gone', enabled: 1, snapshot_json: JSON.stringify({ name: 'gone', 'base-url': 'https://gone.example/v1', models: [{ name: 'm1' }] }) },
  ]
  assert.deepEqual(mergeChannelView([], snapshots, []), [])
})

test('a channel disabled from the panel stays restorable, not stale', () => {
  const snapshots = [
    { name: 'paused', enabled: 0, snapshot_json: JSON.stringify({ name: 'paused', models: [] }) },
  ]
  const [view] = mergeChannelView([], snapshots, [])
  assert.equal(view.stale, false)
  assert.equal(view.enabled, false)
})

test('a live channel is never marked stale', () => {
  const snapshots = [{ name: 'kimi', enabled: 1, snapshot_json: JSON.stringify({ name: 'kimi' }) }]
  const [view] = mergeChannelView([{ name: 'kimi', models: [{ name: 'k' }] }], snapshots, [])
  assert.equal(view.stale, false)
  assert.equal(view.enabled, true)
})
