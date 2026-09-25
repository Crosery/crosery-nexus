import assert from 'node:assert/strict'
import test from 'node:test'
import { analyticsScopeKey, dataForScope, emptyKeyListCopy, gatewayStatusCopy } from '../src/gatewayStatus.js'

test('网关状态文案不会在不可用时声称在线', () => {
  assert.equal(gatewayStatusCopy('online').short, '在线')
  assert.equal(gatewayStatusCopy('checking').short, '检查中')
  assert.equal(gatewayStatusCopy('unavailable').short, '状态不可用')
  assert.doesNotMatch(gatewayStatusCopy('unavailable').title, /正常|在线/)
})

test('空密钥列表区分读取中、不可用和真实空集合', () => {
  assert.equal(emptyKeyListCopy('checking', 0), '正在读取密钥数据')
  assert.equal(emptyKeyListCopy('unavailable', 0), '密钥数据暂时不可用')
  assert.equal(emptyKeyListCopy('online', 0), '还没有 API Key')
  assert.equal(emptyKeyListCopy('unavailable', 1), null)
})

test('筛选条件变化后不会把旧统计误标成新范围', () => {
  const result = { requests: 12 }
  const keyAScope = analyticsScopeKey(7, 'key-a')
  assert.equal(dataForScope(result, keyAScope, keyAScope), result)
  assert.equal(dataForScope(result, keyAScope, analyticsScopeKey(7, 'key-b')), null)
  assert.equal(dataForScope(result, keyAScope, analyticsScopeKey(30, 'key-a')), null)
})
