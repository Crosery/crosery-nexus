import assert from 'node:assert/strict'
import test from 'node:test'
import { CPARequestError } from './cpa.js'
import { defaultModelAlias, discoveryFailure, modelDiscoveryUrls, normalizeDiscoveredModels, parseChannelProtocol, validateChannelName, validateSelectedModels } from './channelDiscovery.js'

test('uses /models when base url already ends in /v1', () => {
  assert.deepEqual(modelDiscoveryUrls('openai', 'https://api.minimaxi.com/v1/'), ['https://api.minimaxi.com/v1/models'])
})

test('tries both common OpenAI discovery paths from a host root', () => {
  assert.deepEqual(modelDiscoveryUrls('openai', 'https://example.com'), [
    'https://example.com/models',
    'https://example.com/v1/models',
  ])
})

test('Claude prefers the Anthropic /v1/models path', () => {
  assert.deepEqual(modelDiscoveryUrls('claude', 'https://api.example.com'), [
    'https://api.example.com/v1/models',
    'https://api.example.com/models',
  ])
})

test('responses relay discovers through the OpenAI /models paths', () => {
  // Responses 是 OpenAI 家协议：/models 走 openai 顺序，只有 Bearer 认证语义相同。
  assert.deepEqual(modelDiscoveryUrls('responses', 'https://aigw.example.com/v1'), ['https://aigw.example.com/v1/models'])
  assert.deepEqual(modelDiscoveryUrls('responses', 'https://example.com'), [
    'https://example.com/models',
    'https://example.com/v1/models',
  ])
})

test('parseChannelProtocol accepts responses and falls back to openai', () => {
  assert.equal(parseChannelProtocol('responses'), 'responses')
  assert.equal(parseChannelProtocol('claude'), 'claude')
  assert.equal(parseChannelProtocol('openai'), 'openai')
  assert.equal(parseChannelProtocol('anthropic'), 'openai')
  assert.equal(parseChannelProtocol(undefined), 'openai')
})

test('normalizes OpenAI and Gemini model payloads', () => {
  assert.deepEqual(normalizeDiscoveredModels({ data: [{ id: 'MiniMax-M3' }, { id: 'MiniMax-M3' }, { id: 'MiniMax-M2.7' }] }), [
    { id: 'MiniMax-M2.7', alias: 'minimax-m2.7' },
    { id: 'MiniMax-M3', alias: 'minimax-m3' },
  ])
  assert.deepEqual(normalizeDiscoveredModels({ models: [{ name: 'models/gemini-3-flash' }] }), [
    { id: 'gemini-3-flash', alias: 'gemini-3-flash' },
  ])
})

test('mixed-case upstream names default to lowercase public aliases', () => {
  assert.equal(defaultModelAlias('MiniMax-M3'), 'minimax-m3')
  assert.equal(defaultModelAlias('kimi-k3'), 'kimi-k3')
})

test('channel names and selected aliases are validated', () => {
  assert.equal(validateChannelName('minimax-prod'), 'minimax-prod')
  assert.throws(() => validateChannelName('bad name'), /渠道名/)
  assert.throws(() => validateSelectedModels([]), /至少选择/)
  assert.throws(() => validateSelectedModels([{ id: 'a', alias: 'same' }, { id: 'b', alias: 'same' }]), /重复/)
})

test('探测失败原因：CPA 连不上上游的 502 换成一句话，其它原因原样', () => {
  assert.equal(discoveryFailure(new CPARequestError(502, '/api-call', '{"error":"request failed"}')), '连不上这个地址 · 检查域名与网络')
  assert.equal(discoveryFailure(new CPARequestError(500, '/api-call', 'boom')), 'CPA 500: boom')
  assert.equal(discoveryFailure(new Error('超时')), '超时')
  assert.equal(discoveryFailure('x'), '请求失败')
})
