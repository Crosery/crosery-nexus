import test from 'node:test'
import assert from 'node:assert/strict'
import { consolePasswordEnvironment } from './magpie-console-password.mjs'

const reference = { service: 'console-test-service', account: 'console-test-account' }

test('existing private-file references are passed through without reading or copying them', () => {
  const filename = '/private/existing-console-password'
  const environment = consolePasswordEnvironment({ consolePasswordFile: filename }, {
    execute: () => assert.fail('File references must not query Keychain'),
  })
  assert.deepEqual(environment, { CONSOLE_PASSWORD_FILE: filename })
})

test('a local Keychain password is injected only into the child environment', () => {
  const environment = consolePasswordEnvironment({ consolePasswordKeychain: reference }, {
    platform: 'darwin',
    execute: (command, args, options) => {
      assert.equal(command, '/usr/bin/security')
      assert.deepEqual(args, ['find-generic-password', '-s', reference.service, '-a', reference.account, '-w'])
      assert.deepEqual(options.stdio, ['ignore', 'pipe', 'ignore'])
      assert.equal(options.timeout, 10_000)
      assert.equal(options.maxBuffer, 16 * 1024)
      return 'test-only-value\n'
    },
  })
  assert.deepEqual(environment, { CONSOLE_PASSWORD: 'test-only-value' })
})

test('ambiguous references fail without falling back to the shared password', () => {
  assert.throws(() => consolePasswordEnvironment({
    consolePasswordFile: '/private/shared-password', consolePasswordKeychain: reference,
  }), /Choose one/)
})

test('a Keychain read error is redacted and never falls back to shared credentials', () => {
  assert.throws(() => consolePasswordEnvironment({ consolePasswordKeychain: reference }, {
    platform: 'darwin',
    execute: () => { throw new Error('test-only-sensitive-output') },
  }), error => {
    assert.equal(error.message, 'Unable to read the local Console password from Keychain')
    assert.equal(error.cause, undefined)
    assert.ok(!error.stack.includes('test-only-sensitive-output'))
    return true
  })
})

test('empty and invalid Keychain values fail closed', () => {
  for (const value of ['', '\n', 'test\0value']) {
    assert.throws(() => consolePasswordEnvironment({ consolePasswordKeychain: reference }, {
      platform: 'darwin', execute: () => value,
    }), /Unable to read/)
  }
})

test('invalid password references are rejected', () => {
  for (const value of [null, {}, { service: '' }, { service: ' ', account: 'admin' }, { service: 'test', account: '' }]) {
    assert.throws(() => consolePasswordEnvironment({ consolePasswordKeychain: value }, {
      platform: 'darwin', execute: () => assert.fail('Invalid references must not query Keychain'),
    }), /requires a service and account/)
  }
  for (const value of [undefined, null, '', ' ']) {
    assert.throws(() => consolePasswordEnvironment({ consolePasswordFile: value }), /reference is required/)
  }
})

test('Keychain references cannot silently run on another platform', () => {
  assert.throws(() => consolePasswordEnvironment({ consolePasswordKeychain: reference }, {
    platform: 'linux', execute: () => assert.fail('Unsupported platforms must not query Keychain'),
  }), /require macOS/)
})
