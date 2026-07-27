import assert from 'node:assert/strict'
import test from 'node:test'
import { validatePolicy } from './policy.js'

test('accepts total and per-group concurrency limits', () => {
  const policy = { enabled: true, groups: ['claude', 'codex'], totalConcurrency: 6, groupConcurrency: { claude: 3, codex: 2 } }
  assert.equal(validatePolicy(policy), policy)
})

test('accepts unlimited concurrency with zero limits', () => {
  const policy = { enabled: true, groups: ['claude'], totalConcurrency: 0, groupConcurrency: {} }
  assert.equal(validatePolicy(policy), policy)
})

test('rejects group concurrency above total concurrency', () => {
  assert.throws(() => validatePolicy({ enabled: true, groups: ['claude'], totalConcurrency: 2, groupConcurrency: { claude: 3 } }), /总并发/)
})

test('rejects empty channel groups', () => {
  assert.throws(() => validatePolicy({ enabled: true, groups: [], totalConcurrency: 2, groupConcurrency: {} }), /至少选择/)
})
