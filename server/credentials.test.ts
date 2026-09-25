import assert from 'node:assert/strict'
import test from 'node:test'
import { attachCredentialModels, resolveProviderModels, summarizeCredentialFiles } from './credentials.js'

test('summarizes auth-files without downloading every credential', () => {
  assert.deepEqual(summarizeCredentialFiles([
    { name: 'codex.json', type: 'codex', disabled: false, status: 'ok', email: 'a@example.com', proxy_url: 'direct' },
    { filename: 'xai.json', provider: 'xai', disabled: true, account: 'xAI 1' },
  ]), [
    { name: 'codex.json', type: 'codex', disabled: false, status: 'ok', label: 'a@example.com', modelCount: 0, models: [], proxyUrl: 'direct' },
    { name: 'xai.json', type: 'xai', disabled: true, status: '', label: 'xAI 1', modelCount: 0, models: [], proxyUrl: '' },
  ])
})

test('fills每个凭据的模型目录，OAuth 渠道才不会以空模型集参与授权', async () => {
  const catalog: Record<string, string[]> = {
    'claude-crosery.json': ['claude-opus-5', 'claude-sonnet-5'],
    'codex-a.json': ['gpt-5.6-sol'],
    'codex-b.json': ['gpt-5.6-terra'],
  }
  const asked: string[] = []
  const fetchModels = async (name: string) => {
    asked.push(name)
    return catalog[name] || []
  }

  const { credentials } = await attachCredentialModels(summarizeCredentialFiles([
    { name: 'claude-crosery.json', type: 'claude', disabled: false },
    { name: 'codex-a.json', type: 'codex', disabled: false },
    { name: 'codex-b.json', type: 'codex', disabled: false },
  ]), fetchModels)

  assert.deepEqual(credentials.find((c) => c.type === 'claude')?.models, ['claude-opus-5', 'claude-sonnet-5'])
  assert.equal(credentials.find((c) => c.type === 'claude')?.modelCount, 2)
  // 同 provider 的账号共享目录：两个 codex 账号都拿到并集
  for (const credential of credentials.filter((c) => c.type === 'codex')) {
    assert.deepEqual(credential.models, ['gpt-5.6-sol', 'gpt-5.6-terra'])
  }
  assert.deepEqual(asked.sort(), ['claude-crosery.json', 'codex-a.json', 'codex-b.json'])
})

test('按 provider 取样，不会给每个凭据都打一次网关', async () => {
  const files = Array.from({ length: 400 }, (_, index) => ({ name: `xai-${index}.json`, type: 'xai', disabled: false }))
  const asked: string[] = []
  const { credentials } = await attachCredentialModels(summarizeCredentialFiles(files), async (name) => {
    asked.push(name)
    return ['grok-4.6']
  })

  assert.equal(asked.length, 3)
  assert.equal(credentials.length, 400)
  assert.ok(credentials.every((credential) => credential.models.length === 1 && credential.models[0] === 'grok-4.6'))
})

test('停用的凭据不参与取样', async () => {
  const asked: string[] = []
  await attachCredentialModels(summarizeCredentialFiles([
    { name: 'dead.json', type: 'codex', disabled: true },
    { name: 'live.json', type: 'codex', disabled: false },
  ]), async (name) => {
    asked.push(name)
    return ['gpt-5.6-sol']
  })

  assert.deepEqual(asked, ['live.json'])
})

test('网关返回空目录时沿用上一次结果，不把渠道削成 0 模型', async () => {
  const { credentials, models, degraded } = await attachCredentialModels(summarizeCredentialFiles([
    { name: 'claude-crosery.json', type: 'claude', disabled: false },
  ]), async () => [], { lastKnown: { claude: ['claude-opus-5', 'claude-sonnet-5'] } })

  assert.deepEqual(credentials[0].models, ['claude-opus-5', 'claude-sonnet-5'])
  assert.deepEqual(models.claude, ['claude-opus-5', 'claude-sonnet-5'])
  assert.deepEqual(degraded, ['claude'])
})

test('没有历史目录可退时如实报空，避免凭空造出模型', () => {
  assert.deepEqual(
    resolveProviderModels({ claude: [] }, {}),
    { models: { claude: [] }, degraded: [] },
  )
})

test('拿到新目录时以新目录为准，不与历史合并', () => {
  assert.deepEqual(
    resolveProviderModels({ claude: ['claude-opus-5'] }, { claude: ['claude-opus-4-6', 'claude-opus-5'] }),
    { models: { claude: ['claude-opus-5'] }, degraded: [] },
  )
})
