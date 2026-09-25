import assert from 'node:assert/strict'
import test from 'node:test'
import { activeProviderPredicate, activeProviderValues, isActiveProvider } from './currentChannels.js'

const groups = [
  { id: 'claude', name: 'Claude', color: '', kind: 'oauth' as const, models: [] },
  { id: 'minimax', name: 'MiniMax', color: '', kind: 'compat' as const, models: [] },
  { id: 'mox-aigw', name: 'Mox 中转', color: '', kind: 'compat' as const, models: [] },
]

test('active provider values come only from live groups and include CPA aliases', () => {
  assert.deepEqual(activeProviderValues(groups), [
    'claude',
    'minimax',
    'mox-aigw',
    'openai-compatible-minimax',
    'openai-compatible-mox-aigw',
  ])
  assert.equal(isActiveProvider('qijichuangtan', groups), false)
  assert.equal(isActiveProvider('openai-compatible-minimax', groups), true)
})

test('empty live groups fail closed', () => {
  assert.deepEqual(activeProviderPredicate([]), { sql: '0 = 1', params: [] })
})
