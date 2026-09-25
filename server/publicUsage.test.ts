import assert from 'node:assert/strict'
import test from 'node:test'
import { boundedInteger, readBearerToken } from './publicUsage.js'

test('reads an API key only from a valid Bearer authorization header', () => {
  assert.equal(readBearerToken('Bearer sk-example'), 'sk-example')
  assert.equal(readBearerToken('bearer    sk-example'), 'sk-example')
  assert.equal(readBearerToken(undefined), null)
  assert.equal(readBearerToken('Basic abc'), null)
  assert.equal(readBearerToken('Bearer'), null)
  assert.equal(readBearerToken('Bearer    '), null)
})

test('bounds public usage query values without accepting malformed input', () => {
  assert.equal(boundedInteger('7', 30, 1, 90), 7)
  assert.equal(boundedInteger('7.8', 30, 1, 90), 7)
  assert.equal(boundedInteger('999', 30, 1, 90), 90)
  assert.equal(boundedInteger('-3', 30, 1, 90), 1)
  assert.equal(boundedInteger('abc', 30, 1, 90), 30)
  assert.equal(boundedInteger('', 30, 1, 90), 30)
  assert.equal(boundedInteger(undefined, 30, 1, 90), 30)
})
