import './testDataDir.js'

import assert from 'node:assert/strict'
import test from 'node:test'
import { buildGroups, modelsForGroups, resolveGroupForModel } from './groups.js'

const channels = [
  {
    name: 'ollama',
    baseUrl: 'https://ollama.com/v1',
    keyCount: 1,
    enabled: true,
    protocol: 'openai' as const,
    stale: false,
    models: [
      { id: 'glm-5.2', enabled: true, upstreams: 1 },
      { id: 'kimi-k2.7-code', enabled: true, upstreams: 1 },
      { id: 'deepseek-v4-pro', enabled: false, upstreams: 0 },
    ],
  },
  {
    name: 'kimi',
    baseUrl: 'https://api.kimi.com/coding/v1',
    keyCount: 1,
    enabled: true,
    protocol: 'openai' as const,
    stale: false,
    models: [
      { id: 'kimi-k3', enabled: true, upstreams: 1 },
      { id: 'kimi-k2.7-code', enabled: true, upstreams: 2 },
    ],
  },
]

const oauth = [
  { provider: 'claude', models: ['claude-opus-5', 'claude-sonnet-4-6'], excluded: ['claude-sonnet-4-6'], activeAccounts: 1 },
]

test('groups come from upstream channels, not model name keywords', () => {
  const groups = buildGroups(channels, oauth)
  assert.deepEqual(groups.map((group) => group.id), ['claude', 'kimi', 'ollama'])
  // glm-5.2 has no keyword tying it to ollama; channel membership is what counts.
  assert.deepEqual(groups.find((group) => group.id === 'ollama')?.models, ['glm-5.2', 'kimi-k2.7-code'])
})

test('a model served by two channels belongs to both groups independently', () => {
  const groups = buildGroups(channels, oauth)
  assert.ok(groups.find((group) => group.id === 'ollama')?.models.includes('kimi-k2.7-code'))
  assert.ok(groups.find((group) => group.id === 'kimi')?.models.includes('kimi-k2.7-code'))
})

test('disabled or stale channels and inactive oauth providers are not authorizable groups', () => {
  const groups = buildGroups([
    ...channels,
    { name: 'paused', baseUrl: '', keyCount: 1, enabled: false, protocol: 'openai', stale: false, models: [{ id: 'paused-model', enabled: true, upstreams: 1 }] },
    { name: 'gone', baseUrl: '', keyCount: 1, enabled: false, protocol: 'openai', stale: true, models: [{ id: 'gone-model', enabled: true, upstreams: 1 }] },
  ], [...oauth, { provider: 'xai', models: ['grok-4.5'], excluded: [], activeAccounts: 0 }])
  assert.ok(!groups.some((group) => group.id === 'paused'))
  assert.ok(!groups.some((group) => group.id === 'gone'))
  assert.ok(!groups.some((group) => group.id === 'xai'))
})

test('disabled models and excluded oauth models stay out of their group', () => {
  const groups = buildGroups(channels, oauth)
  assert.ok(!groups.find((group) => group.id === 'ollama')?.models.includes('deepseek-v4-pro'))
  assert.deepEqual(groups.find((group) => group.id === 'claude')?.models, ['claude-opus-5'])
})

test('selecting groups yields the union of their models', () => {
  const groups = buildGroups(channels, oauth)
  assert.deepEqual(modelsForGroups(groups, ['kimi']), ['kimi-k2.7-code', 'kimi-k3'])
  assert.deepEqual(modelsForGroups(groups, ['claude', 'ollama']), ['claude-opus-5', 'glm-5.2', 'kimi-k2.7-code'])
  assert.deepEqual(modelsForGroups(groups, []), [])
})

test('usage rows resolve by provider first, then by which group serves the model', () => {
  const groups = buildGroups(channels, oauth)
  assert.equal(resolveGroupForModel('kimi-k2.7-code', 'kimi', groups), 'kimi')
  assert.equal(resolveGroupForModel('kimi-k2.7-code', 'ollama', groups), 'ollama')
  assert.equal(resolveGroupForModel('glm-5.2', 'unknown', groups), 'ollama')
  assert.equal(resolveGroupForModel('mystery-model', 'unknown', groups), 'other')
})
