import assert from 'node:assert/strict'
import test from 'node:test'
import { issueKeyRevealToken, consumeKeyRevealToken } from './keySecrets.js'

test('issues a one-time reveal token for an API key', () => {
  const token = issueKeyRevealToken('hash-1', 'sk-test-secret')
  assert.equal(consumeKeyRevealToken(token, 'hash-1'), 'sk-test-secret')
  assert.equal(consumeKeyRevealToken(token, 'hash-1'), null)
})

test('does not reveal a token for another key', () => {
  const token = issueKeyRevealToken('hash-1', 'sk-test-secret')
  assert.equal(consumeKeyRevealToken(token, 'hash-2'), null)
})
