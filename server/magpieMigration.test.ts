import assert from 'node:assert/strict'
import test from 'node:test'
import { projectMagpieChannels } from './magpieMigration.js'

test('migration preserves aliases and IDs without copying upstream credentials', () => {
  const result = projectMagpieChannels({ 'openai-compatibility': [{
    name: 'original-name', 'base-url': 'https://upstream.invalid/v1',
    'api-key-entries': [{ 'api-key': 'fixture-upstream-secret' }],
    models: [{ name: 'original-model', alias: 'public-alias' }],
  }] })
  assert.equal(result.channels[0].name, 'original-name')
  assert.equal(result.channels[0].models[0].alias, 'public-alias')
  assert.ok(!JSON.stringify(result).includes('fixture-upstream-secret'))
  assert.match(result.channels[0]['api-key-entries'][0]['api-key'], /^cpa:/)
})
test('remote loopback and unsupported protocols cannot become silent local routes', () => {
  const result = projectMagpieChannels({
    'openai-compatibility': [{ name: 'loopback', 'base-url': 'http://127.0.0.1:1234/v1', 'api-key-entries': [{ 'api-key': 'fixture' }], models: [{ name: 'm' }] }],
    'gemini-api-key': [{ prefix: 'native-gemini', 'api-key': 'fixture' }],
  })
  assert.equal(result.channels[0].disabled, true)
  assert.equal(result.pending.length, 2)
})
test('secret-bearing proxies stop migration instead of persisting a new secret copy', () => {
  assert.throws(() => projectMagpieChannels({ 'openai-compatibility': [{
    name: 'proxy', 'base-url': 'https://upstream.invalid/v1', 'api-key-entries': [{ 'api-key': 'fixture', 'proxy-url': 'https://user:password@proxy.invalid' }],
    models: [{ name: 'model' }],
  }] }), /Proxy credentials/)
})
