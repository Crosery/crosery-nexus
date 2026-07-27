import assert from 'node:assert/strict'
import test from 'node:test'
import { validateCredentials } from './auth.js'

test('accepts the configured administrator credentials', () => {
  assert.equal(validateCredentials('admin', 'secret', 'admin', 'secret'), true)
})

test('rejects a wrong administrator username or password', () => {
  assert.equal(validateCredentials('guest', 'secret', 'admin', 'secret'), false)
  assert.equal(validateCredentials('admin', 'wrong', 'admin', 'secret'), false)
})
