import assert from 'node:assert/strict'
import test from 'node:test'
import { buildKeyAccessPlan, DENY_ALL_MODEL, sameKeyAccess } from './keyModelAccess.js'
import type { ConsoleGroup } from './groups.js'

const groups: ConsoleGroup[] = [
  { id: 'codex', name: 'Codex', color: '#0f0', kind: 'oauth', models: ['gpt-5.6-sol', 'gpt-5.6-terra'] },
  { id: 'kimi', name: 'Kimi', color: '#00f', kind: 'compat', models: ['kimi-k2.7-code', 'kimi-k3'] },
]

test('only selected live groups contribute models', () => {
  const plan = buildKeyAccessPlan(groups, [{ keyValue: 'sk-codex', enabled: true, groups: ['codex'] }])
  assert.deepEqual(plan.access['sk-codex'], ['gpt-5.6-sol', 'gpt-5.6-terra'])
  assert.ok(!plan.access['sk-codex'].includes('kimi-k3'))
})

test('removed legacy groups are pruned instead of remaining as ghost labels', () => {
  const plan = buildKeyAccessPlan(groups, [{ keyValue: 'sk-old', enabled: true, groups: ['codex', 'grok', 'image'] }])
  assert.deepEqual(plan.normalizedGroups.get('sk-old'), ['codex'])
})

test('no live groups means deny all instead of legacy unrestricted access', () => {
  const plan = buildKeyAccessPlan(groups, [{ keyValue: 'sk-empty', enabled: true, groups: ['grok'] }])
  assert.deepEqual(plan.access['sk-empty'], [DENY_ALL_MODEL])
  assert.deepEqual(plan.normalizedGroups.get('sk-empty'), [])
})

test('disabled keys are not added to the CPA access map', () => {
  const plan = buildKeyAccessPlan(groups, [{ keyValue: 'sk-off', enabled: false, groups: ['codex'] }])
  assert.deepEqual(plan.access, {})
})

test('access comparisons ignore key and model ordering but detect real changes', () => {
  assert.equal(sameKeyAccess({ b: ['y', 'x'], a: ['z'] }, { a: ['z'], b: ['x', 'y'] }), true)
  assert.equal(sameKeyAccess({ a: ['x'] }, { a: ['y'] }), false)
})

test('duplicate groups do not duplicate models', () => {
  const plan = buildKeyAccessPlan(groups, [{ keyValue: 'sk-dupe', enabled: true, groups: ['codex', 'codex'] }])
  assert.deepEqual(plan.normalizedGroups.get('sk-dupe'), ['codex'])
  assert.deepEqual(plan.access['sk-dupe'], ['gpt-5.6-sol', 'gpt-5.6-terra'])
})
