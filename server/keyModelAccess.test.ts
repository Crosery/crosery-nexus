import assert from 'node:assert/strict'
import test from 'node:test'
import { buildKeyAccessPlan, DENY_ALL_MODEL, sameKeyAccess } from './keyModelAccess.js'
import type { ConsoleGroup } from './groups.js'

const groups: ConsoleGroup[] = [
  { id: 'claude', name: 'Claude', color: '#d97757', kind: 'oauth', models: ['claude-haiku-4-5-20251001', 'claude-opus-5'] },
  { id: 'codex', name: 'Codex', color: '#0f0', kind: 'oauth', models: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-image-2'] },
  { id: 'kimi', name: 'Kimi', color: '#00f', kind: 'compat', models: ['kimi-k2.7-code', 'kimi-k3'] },
]

/** 默认开放：claude haiku（09-17）+ gpt-image 全系（09-26），都只取实时目录里存在的型号。 */
const DEFAULTS = ['claude-haiku-4-5-20251001', 'gpt-image-2']

test('only selected live groups contribute models', () => {
  const plan = buildKeyAccessPlan(groups, [{ keyValue: 'sk-codex', enabled: true, groups: ['codex'] }])
  assert.deepEqual(plan.access['sk-codex'], ['claude-haiku-4-5-20251001', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-image-2'])
  assert.ok(!plan.access['sk-codex'].includes('kimi-k3'))
})

test('removed legacy groups are pruned instead of remaining as ghost labels', () => {
  const plan = buildKeyAccessPlan(groups, [{ keyValue: 'sk-old', enabled: true, groups: ['codex', 'grok', 'image'] }])
  assert.deepEqual(plan.normalizedGroups.get('sk-old'), ['codex'])
})

test('no live groups leaves only the default-open models, never legacy unrestricted access', () => {
  const plan = buildKeyAccessPlan(groups, [{ keyValue: 'sk-empty', enabled: true, groups: ['grok'] }])
  assert.deepEqual(plan.access['sk-empty'], DEFAULTS)
  assert.deepEqual(plan.normalizedGroups.get('sk-empty'), [])
})

test('gpt-image family is open to every key without opening the rest of codex', () => {
  const plan = buildKeyAccessPlan(groups, [{ keyValue: 'sk-kimi', enabled: true, groups: ['kimi'] }])
  assert.ok(plan.access['sk-kimi'].includes('gpt-image-2'))
  assert.ok(plan.access['sk-kimi'].includes('kimi-k3'))
  assert.ok(!plan.access['sk-kimi'].includes('gpt-5.6-sol'))
})

test('new gpt-image models in live groups are picked up automatically, retired ones drop out', () => {
  const next: ConsoleGroup[] = [groups[0], { ...groups[1], models: ['gpt-5.6-sol', 'gpt-image-3'] }, groups[2]]
  const plan = buildKeyAccessPlan(next, [{ keyValue: 'sk-new', enabled: true, groups: [] }])
  assert.deepEqual(plan.access['sk-new'], ['claude-haiku-4-5-20251001', 'gpt-image-3'])
})

test('default-open models absent from the live catalog are not whitelisted; nothing left means DENY_ALL', () => {
  const kimiOnly: ConsoleGroup[] = [groups[2]]
  assert.deepEqual(buildKeyAccessPlan(kimiOnly, [{ keyValue: 'sk-k', enabled: true, groups: ['kimi'] }]).access['sk-k'], ['kimi-k2.7-code', 'kimi-k3'])
  assert.deepEqual(buildKeyAccessPlan([], [{ keyValue: 'sk-none', enabled: true, groups: ['kimi'] }]).access['sk-none'], [DENY_ALL_MODEL])
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
  assert.deepEqual(plan.access['sk-dupe'], ['claude-haiku-4-5-20251001', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-image-2'])
})
