import './testDataDir.js'

import assert from 'node:assert/strict'
import test from 'node:test'
import { attachCredentialModels, summarizeCredentialFiles } from './credentials.js'
import { buildGroups } from './groups.js'
import { buildKeyAccessPlan, DENY_ALL_MODEL } from './keyModelAccess.js'
import type { ChannelView } from './channelView.js'

/**
 * 2026-08-20 事故的完整链路回归：
 * 凭据模型目录为空 -> OAuth 渠道组 0 模型 -> Key 白名单被削成 DENY_ALL
 * -> 所有 gpt/claude/grok 请求 403 model_not_allowed。
 * 这三步任意一环恢复都不够，必须证明整条链在网关短暂查不到模型时仍然稳住。
 */
const oauthProvidersFrom = (credentials: Awaited<ReturnType<typeof attachCredentialModels>>['credentials']) => {
  const byProvider = new Map<string, { models: Set<string>; activeAccounts: number; accounts: number }>()
  for (const credential of credentials) {
    if (!credential.type) continue
    const entry = byProvider.get(credential.type) || { models: new Set<string>(), activeAccounts: 0, accounts: 0 }
    entry.accounts += 1
    if (!credential.disabled) {
      entry.activeAccounts += 1
      for (const model of credential.models) entry.models.add(model)
    }
    byProvider.set(credential.type, entry)
  }
  return [...byProvider].map(([provider, entry]) => ({
    provider, models: [...entry.models], excluded: [], activeAccounts: entry.activeAccounts, accounts: entry.accounts,
  }))
}

const AUTH_FILES = [
  { name: 'claude-crosery.json', type: 'claude', disabled: false },
  { name: 'codex-a.json', type: 'codex', disabled: false },
]
const KEY_ROW = { keyValue: 'sk-teacher', enabled: true, groups: ['claude', 'codex'] }
const NO_COMPAT_CHANNELS: ChannelView[] = []

test('网关能查到模型时，Key 拿到完整白名单', async () => {
  const { credentials } = await attachCredentialModels(summarizeCredentialFiles(AUTH_FILES), async (name) =>
    name.startsWith('claude') ? ['claude-opus-5'] : ['gpt-5.6-sol'])
  const groups = buildGroups(NO_COMPAT_CHANNELS, oauthProvidersFrom(credentials))
  const plan = buildKeyAccessPlan(groups, [KEY_ROW])

  assert.deepEqual(plan.access['sk-teacher'], ['claude-opus-5', 'gpt-5.6-sol'])
})

test('网关临时查不到模型时，Key 白名单不被削成 DENY_ALL', async () => {
  const lastKnown = { claude: ['claude-opus-5'], codex: ['gpt-5.6-sol'] }
  const { credentials } = await attachCredentialModels(summarizeCredentialFiles(AUTH_FILES), async () => [], { lastKnown })
  const groups = buildGroups(NO_COMPAT_CHANNELS, oauthProvidersFrom(credentials))
  const plan = buildKeyAccessPlan(groups, [KEY_ROW])

  assert.deepEqual(plan.access['sk-teacher'], ['claude-opus-5', 'gpt-5.6-sol'])
  assert.ok(!plan.access['sk-teacher'].includes(DENY_ALL_MODEL))
})

test('没有兜底目录时仍如实降级为 DENY_ALL，不假装有模型', async () => {
  const { credentials } = await attachCredentialModels(summarizeCredentialFiles(AUTH_FILES), async () => [])
  const groups = buildGroups(NO_COMPAT_CHANNELS, oauthProvidersFrom(credentials))
  const plan = buildKeyAccessPlan(groups, [KEY_ROW])

  assert.deepEqual(plan.access['sk-teacher'], [DENY_ALL_MODEL])
})

test('凭据全部停用时，渠道保留为不可用分组，Key 白名单与成员关系不变（2026-10-09 事故）', async () => {
  const lastKnown = { claude: ['claude-opus-5'], codex: ['gpt-5.6-sol'] }
  const files = [{ name: 'claude-crosery.json', type: 'claude', disabled: true }, AUTH_FILES[1]]
  const { credentials } = await attachCredentialModels(summarizeCredentialFiles(files), async () => ['gpt-5.6-sol'], { lastKnown })
  const groups = buildGroups(NO_COMPAT_CHANNELS, oauthProvidersFrom(credentials), { lastKnown })
  const plan = buildKeyAccessPlan(groups, [KEY_ROW])

  assert.equal(groups.find((group) => group.id === 'claude')?.available, false)
  assert.deepEqual(plan.normalizedGroups.get('sk-teacher'), ['claude', 'codex'])
  assert.deepEqual(plan.access['sk-teacher'], ['claude-opus-5', 'gpt-5.6-sol'])
})
