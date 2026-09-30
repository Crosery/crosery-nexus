import assert from 'node:assert/strict'
import test from 'node:test'
import { magpieCredentialReference, resolveMagpieSecret, validateMagpieChannels } from './magpieControl.js'

const channel = {
  name: 'test', 'base-url': 'https://upstream.invalid/v1', models: [{ name: 'real', alias: 'public' }],
  'api-key-entries': [{ 'api-key': 'env:TEST_UPSTREAM_KEY' }],
}
test('registry stores references, never raw upstream keys', () => {
  assert.equal(validateMagpieChannels([channel]).length, 1)
  assert.throws(() => validateMagpieChannels([{ ...channel, 'api-key-entries': [{ 'api-key': 'fixture-secret' }] }]), /raw credentials/)
  const reference = magpieCredentialReference('openai-compatibility', 'test', 0)
  assert.equal(validateMagpieChannels([{ ...channel, 'api-key-entries': [{ 'api-key': reference }] }]).length, 1)
  assert.ok(!reference.includes('test'))
})
test('credential references resolve only at runtime', () => {
  assert.equal(resolveMagpieSecret('env:TEST_UPSTREAM_KEY', { TEST_UPSTREAM_KEY: 'fixture-secret' }), 'fixture-secret')
  assert.throws(() => resolveMagpieSecret('env:TEST_UPSTREAM_KEY', {}), /unavailable/)
  assert.throws(() => resolveMagpieSecret('raw-key', {}), /reference/)
  assert.throws(() => resolveMagpieSecret('env:TEST_UPSTREAM_KEY', { TEST_UPSTREAM_KEY: 'unsafe\nheader' }), /unavailable/)
})
test('invalid registries fail closed before a provider is configured', () => {
  assert.throws(() => validateMagpieChannels([channel, channel]), /duplicate/)
  assert.throws(() => validateMagpieChannels([{ ...channel, protocol: 'gemini' }]), /protocol/)
  assert.throws(() => validateMagpieChannels([{ ...channel, models: [] }]), /models/)
  assert.throws(() => validateMagpieChannels([{ ...channel, headers: { Authorization: 'fixture-secret' } }]), /header/)
  assert.throws(() => validateMagpieChannels([{ ...channel, 'proxy-url': 'http://user:password@proxy.invalid' }]), /credentials/)
})

test('unrelated admin-input fields cannot become another persisted credential store', () => {
  const projected = validateMagpieChannels([{ ...channel, secret: 'fixture-secret',
    'api-key-entries': [{ 'api-key': 'env:TEST_UPSTREAM_KEY', privateHeader: 'fixture-secret' }],
  }])
  assert.ok(!JSON.stringify(projected).includes('fixture-secret'))
})
