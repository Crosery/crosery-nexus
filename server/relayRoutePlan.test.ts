import assert from 'node:assert/strict'
import test from 'node:test'
import { planAttempts } from './relayRoutePlan.js'

const rows = (...items: Array<[string, number]>) => items.map(([prefix, weight]) => ({ prefix, weight, round_robin: 0 }))

test('按权重分档，同档保持列表先后；全部来源都在尝试序列里（失败时依次换下一个）', () => {
  assert.deepEqual(planAttempts('m', rows(['a', 1], ['b', 0], ['c', 1]), 0), ['b/m', 'a/m', 'c/m'])
  assert.deepEqual(planAttempts('m', rows(['a', 1], ['b', 0], ['c', 1]), 7), ['b/m', 'a/m', 'c/m'], '默认不轮询：turn 不影响顺序')
})

test('同档轮询：只在档内轮换起点，档与档之间的先后不变', () => {
  const list = [{ prefix: 'a', weight: 0, round_robin: 1 }, { prefix: 'b', weight: 0, round_robin: 1 }, { prefix: 'c', weight: 5, round_robin: 1 }]
  assert.deepEqual(planAttempts('m', list, 0), ['a/m', 'b/m', 'c/m'])
  assert.deepEqual(planAttempts('m', list, 1), ['b/m', 'a/m', 'c/m'])
  assert.deepEqual(planAttempts('m', list, 2), ['a/m', 'b/m', 'c/m'])
})

test('这把 Key 没开通的渠道不进尝试序列；过滤后不足两个来源就不介入', () => {
  const list = [{ prefix: 'a', weight: 0, round_robin: 0, channel: 'commandcode' }, { prefix: 'b', weight: 1, round_robin: 0, channel: 'opencode-go' }, { prefix: 'c', weight: 2, round_robin: 0, channel: 'codex' }]
  assert.deepEqual(planAttempts('m', list, 0, new Set(['opencode-go', 'codex'])), ['b/m', 'c/m'], 'commandcode 没开通：不当「第一个」')
  assert.deepEqual(planAttempts('m', list, 0, new Set(['opencode-go'])), [], '只剩一个来源：交给网关')
  assert.deepEqual(planAttempts('m', list, 0, null), ['a/m', 'b/m', 'c/m'], '不知道 Key 的分组：不过滤')
})
