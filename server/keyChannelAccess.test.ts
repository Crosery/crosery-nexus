import assert from 'node:assert/strict'
import test from 'node:test'
import { buildKeyChannelAccessPlan, mergeChannelAccess } from './keyChannelAccess.js'
import { sameKeyAccess } from './keyModelAccess.js'
import type { ConsoleGroup } from './groups.js'

/**
 * 2026-09-07 事故回归：面板上给「非雨」开了 Antigravity + Codex，模型白名单同步成功，
 * 但网关渠道白名单仍是 09-03 手工写死的 [antigravity]，于是 gpt-6-astra 一律
 * 503 auth_not_found。控制台必须把分组同时翻译成渠道白名单。
 */
const GROUPS: ConsoleGroup[] = [
  { id: 'antigravity', name: 'Antigravity', color: '#a3e635', kind: 'oauth', models: ['gemini-3.8-flash'] },
  { id: 'claude', name: 'Claude', color: '#d97757', kind: 'oauth', models: ['claude-opus-5'] },
  { id: 'codex', name: 'Codex', color: '#6ee7b7', kind: 'oauth', models: ['gpt-6-astra'] },
  { id: 'minimax', name: 'MiniMax', color: '#c084fc', kind: 'compat', models: ['minimax-m3'] },
]

const row = (keyValue: string, groups: string[], enabled = true) => ({ keyValue, enabled, groups })
const configured = (...keys: string[]) => new Set(keys)

test('面板开了 codex 组，渠道白名单就补上 codex', () => {
  const plan = buildKeyChannelAccessPlan(GROUPS, [row('sk-feiyu', ['antigravity', 'codex'])], { 'sk-feiyu': ['antigravity'] }, configured('sk-feiyu'))
  assert.deepEqual(plan['sk-feiyu'], ['antigravity', 'codex'])
})

test('分组与网关不一致时以分组为准，多余渠道被收回', () => {
  const plan = buildKeyChannelAccessPlan(GROUPS, [row('sk-zixian', ['antigravity', 'codex'])], { 'sk-zixian': ['claude', 'minimax'] }, configured('sk-zixian'))
  assert.deepEqual(plan['sk-zixian'], ['antigravity', 'codex'])
})

test('未明确授权的渠道必须移除，旧 Mox 条目不能进入独立候选池', () => {
  const plan = buildKeyChannelAccessPlan(GROUPS, [row('sk-ibuki', ['antigravity', 'claude', 'codex'])], {
    'sk-ibuki': ['antigravity', 'claude', 'codex', 'mox-aigw'],
  }, configured('sk-ibuki'))
  assert.deepEqual(plan['sk-ibuki'], ['antigravity', 'claude', 'codex'])
})

/**
 * 额度停用会把 Key 从网关 api-keys 摘掉，网关随即删掉它的渠道条目；恢复启用后如果控制台
 * 不重建条目，这把 Key 就变成「无条目 = 不限渠道」，会绕过分组打到 priority 更高的渠道
 * （2026-09-07 非雨 460 次 gpt-6-astra 打进 mox-aigw）。所以没有条目也必须写。
 */
test('网关里没有条目的 Key 也要按分组写入，不能留成不限渠道', () => {
  const plan = buildKeyChannelAccessPlan(GROUPS, [row('sk-feiyu', ['antigravity', 'codex'])], {}, configured('sk-feiyu'))
  assert.deepEqual(plan['sk-feiyu'], ['antigravity', 'codex'])
})

test('停用的 Key 不写入，避免整份 PUT 被网关 400 掉', () => {
  const plan = buildKeyChannelAccessPlan(GROUPS, [row('sk-off', ['codex'], false)], { 'sk-off': ['codex'] }, configured('sk-off'))
  assert.equal('sk-off' in plan, false)
})

test('网关 api-keys 里没有的 Key 不写入', () => {
  const plan = buildKeyChannelAccessPlan(GROUPS, [row('sk-ghost', ['codex'])], {}, configured())
  assert.equal('sk-ghost' in plan, false)
})

test('空候选池必须独立拒绝，不能写会被网关归一化为不限渠道的空数组', () => {
  const plan = buildKeyChannelAccessPlan(GROUPS, [row('sk-empty', [])], { 'sk-empty': ['codex', 'mox-aigw'] }, configured('sk-empty'))
  assert.deepEqual(plan['sk-empty'], ['__console_no_channels_allowed__'])
})

test('只有明确开启 Mox 的 Key 才能把 Mox 放进候选池', () => {
  const groups: ConsoleGroup[] = [...GROUPS, { id: 'mox-aigw', name: 'Mox', color: '#fff', kind: 'compat', models: ['gpt-6-astra'] }]
  const plan = buildKeyChannelAccessPlan(groups, [row('sk-codex', ['codex']), row('sk-both', ['codex', 'mox-aigw'])], {}, configured('sk-codex', 'sk-both'))
  assert.deepEqual(plan['sk-codex'], ['codex'])
  assert.deepEqual(plan['sk-both'], ['codex', 'mox-aigw'])
})

test('整份替换时未接管的 Key 原样带上', () => {
  const current = { 'sk-a': ['antigravity'], 'sk-b': ['claude'] }
  const merged = mergeChannelAccess(current, { 'sk-a': ['antigravity', 'codex'] })
  assert.deepEqual(merged, { 'sk-a': ['antigravity', 'codex'], 'sk-b': ['claude'] })
})

test('已经一致时不产生写操作', () => {
  const current = { 'sk-feiyu': ['antigravity', 'codex'] }
  const merged = mergeChannelAccess(current, buildKeyChannelAccessPlan(GROUPS, [row('sk-feiyu', ['codex', 'antigravity'])], current, configured('sk-feiyu')))
  assert.equal(sameKeyAccess(current, merged), true)
})
