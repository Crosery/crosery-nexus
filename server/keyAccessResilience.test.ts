import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

/**
 * 2026-10-09 403 事故的整条链路回归：OAuth provider 的账号归零（迁走 / 全部停用）
 * → 分组被丢 → 对账把它从 Key 的 groups_json 里永久删掉 → 账号回来也不恢复。
 * 这里用真实的 listGroups + reconcileKeyModelAccess + SQLite，只把网关换成内存假实现。
 */
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'key-access-resilience-'))
process.env.DATA_DIR = dataDir
process.env.CPA_BASE_URL = 'https://resilience-gateway.example.test'
process.env.CPA_MANAGEMENT_KEY = 'fixture-management-key'
process.env.CROSERY_SHARED_CATALOG = path.join(dataDir, 'no-shared-catalog.json')
const originalFetch = globalThis.fetch
const { db } = await import('./db.js')
const { reconcileKeyModelAccess } = await import('./sync.js')
const { hashKey } = await import('./cpa.js')
const { invalidateGatewaySnapshot } = await import('./channels.js')

const key = 'fixture-teacher-key'
const now = new Date().toISOString()
db.prepare('INSERT INTO api_keys (key_hash,key_value,name,enabled,groups_json,created_at,updated_at) VALUES (?,?,?,1,?,?,?)')
  .run(hashKey(key), key, 'teacher', '["antigravity","codex"]', now, now)

type AuthFile = { name: string; type: string; disabled: boolean }
const MODELS: Record<string, string[]> = { antigravity: ['gemini-3-pro', 'gemini-3-flash'], codex: ['gpt-5.6-sol'] }

const gateway = {
  files: [] as AuthFile[],
  channelAccess: {} as Record<string, string[]>,
  modelAccess: {} as Record<string, string[]>,
}

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input))
  const route = url.pathname.replace('/v0/management', '')
  const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } })
  if (route === '/api-key-channel-access') {
    if (init?.method === 'PUT') gateway.channelAccess = JSON.parse(String(init.body))
    return json({ 'api-key-channel-access': gateway.channelAccess })
  }
  if (route === '/api-key-model-access') {
    if (init?.method === 'PUT') gateway.modelAccess = JSON.parse(String(init.body))
    return json({ 'api-key-model-access': gateway.modelAccess })
  }
  if (route === '/api-keys') return json({ 'api-keys': [key] })
  if (route === '/openai-compatibility') return json({ 'openai-compatibility': [] })
  if (route === '/auth-files') return json({ files: gateway.files })
  if (route === '/auth-files/models') {
    const file = gateway.files.find((item) => item.name === url.searchParams.get('name'))
    return json({ models: (file ? MODELS[file.type] : []).map((id) => ({ id })) })
  }
  if (route === '/oauth-excluded-models') return json({ 'oauth-excluded-models': {} })
  if (route.endsWith('-api-key')) return json({ [route.slice(1)]: [] })
  throw new Error(`Unexpected fixture route: ${route}`)
}) as typeof fetch

const CODEX = { name: 'codex-a.json', type: 'codex', disabled: false }
const ANTIGRAVITY = [
  { name: 'antigravity-a.json', type: 'antigravity', disabled: false },
  { name: 'antigravity-b.json', type: 'antigravity', disabled: false },
]

async function reconcileWith(files: AuthFile[]) {
  gateway.files = files
  invalidateGatewaySnapshot()
  await reconcileKeyModelAccess()
  const row = db.prepare('SELECT groups_json FROM api_keys WHERE key_value = ?').get(key) as { groups_json: string }
  return { groups: JSON.parse(row.groups_json) as string[], models: gateway.modelAccess[key], channels: gateway.channelAccess[key] }
}

test('账号归零（删光或全部停用）再回来：Key 的 groups_json 与网关两份白名单都不变', async () => {
  const baseline = await reconcileWith([...ANTIGRAVITY, CODEX])
  assert.deepEqual(baseline.groups, ['antigravity', 'codex'])
  assert.deepEqual(baseline.models, ['gemini-3-flash', 'gemini-3-pro', 'gpt-5.6-sol'])
  assert.ok(baseline.channels.includes('antigravity'))

  assert.deepEqual(await reconcileWith([CODEX]), baseline, '凭据全部迁走')
  assert.deepEqual(await reconcileWith([...ANTIGRAVITY.map((file) => ({ ...file, disabled: true })), CODEX]), baseline, '凭据全部停用')
  assert.deepEqual(await reconcileWith([...ANTIGRAVITY, CODEX]), baseline, '账号回来')
})

test('只有管理员编辑 Key 才去掉分组', async () => {
  await reconcileWith([CODEX])
  db.prepare('UPDATE api_keys SET groups_json = ? WHERE key_value = ?').run('["codex"]', key)
  const edited = await reconcileWith([CODEX])
  assert.deepEqual(edited.groups, ['codex'])
  assert.deepEqual(edited.models, ['gpt-5.6-sol'])
  assert.ok(!edited.channels.includes('antigravity'))
})

test.after(() => {
  globalThis.fetch = originalFetch
  db.close()
  fs.rmSync(dataDir, { recursive: true, force: true })
})
