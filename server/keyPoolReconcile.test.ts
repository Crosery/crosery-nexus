import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'key-pool-reconcile-'))
process.env.DATA_DIR = dataDir
process.env.CPA_BASE_URL = 'https://pool-gateway.example.test'
process.env.CPA_MANAGEMENT_KEY = 'fixture-management-key'
const originalFetch = globalThis.fetch
const { db } = await import('./db.js')
const { reconcileKeyModelAccess } = await import('./sync.js')
const { hashKey } = await import('./cpa.js')
const key = 'fixture-pool-key'
const now = new Date().toISOString()
db.prepare('INSERT INTO api_keys (key_hash,key_value,name,enabled,groups_json,created_at,updated_at) VALUES (?,?,?,1,?,?,?)').run(hashKey(key), key, 'fixture', '["codex"]', now, now)

function gateway(options: { modelError?: boolean; pauseChannelRead?: () => Promise<void> } = {}) {
  let access: Record<string, string[]> = { [key]: ['codex', 'mox-aigw'] }
  const writes: Record<string, string[]>[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const route = new URL(String(input)).pathname.replace('/v0/management', '')
    const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } })
    if (route === '/api-key-channel-access') {
      if (init?.method === 'PUT') {
        access = JSON.parse(String(init.body))
        writes.push(structuredClone(access))
      } else await options.pauseChannelRead?.()
      return json({ 'api-key-channel-access': access })
    }
    if (route === '/api-key-model-access') return options.modelError ? new Response('fixture unavailable', { status: 503 }) : json({})
    if (route === '/api-keys') return json({ 'api-keys': [key] })
    if (route === '/openai-compatibility') return json({ 'openai-compatibility': [{ name: 'mox-aigw', models: [{ name: 'shared-model' }] }] })
    if (route === '/auth-files') return json({ files: [{ name: 'fixture-codex.json', type: 'codex', disabled: false, status: 'active' }] })
    if (route === '/auth-files/models') return json({ models: [{ id: 'shared-model' }] })
    if (route === '/available-models') return json({ models: [{ id: 'shared-model' }] })
    if (route === '/oauth-excluded-models') return json({ 'oauth-excluded-models': {} })
    if (route.endsWith('-api-key')) return json({ [route.slice(1)]: [] })
    if (route === '/proxy-url') return json({ 'proxy-url': '' })
    throw new Error(`Unexpected fixture route: ${route}`)
  }) as typeof fetch
  return { writes, access: () => access }
}

test('模型权限接口故障不能阻止撤销 Mox 渠道权限', async () => {
  const mock = gateway({ modelError: true })
  await assert.rejects(reconcileKeyModelAccess, /CPA 503/)
  assert.deepEqual(mock.access()[key], ['codex'])
})

test('并发对账排队后重读授权，旧快照不能在撤权完成后写回 Mox', async () => {
  db.prepare('UPDATE api_keys SET groups_json=? WHERE key_value=?').run('["codex","mox-aigw"]', key)
  let release!: () => void
  let entered!: () => void
  const blocked = new Promise<void>((resolve) => { release = resolve })
  const started = new Promise<void>((resolve) => { entered = resolve })
  let first = true
  const mock = gateway({ pauseChannelRead: async () => { if (first) { first = false; entered(); await blocked } } })
  const old = reconcileKeyModelAccess()
  await started
  db.prepare('UPDATE api_keys SET groups_json=? WHERE key_value=?').run('["codex"]', key)
  const revoke = reconcileKeyModelAccess()
  // 允许新调用运行至首个异步边界；正确实现会排在旧调用后面。
  await new Promise<void>((resolve) => setImmediate(resolve))
  release()
  await Promise.all([old, revoke])
  assert.deepEqual(mock.access()[key], ['codex'])
})

test.after(() => {
  globalThis.fetch = originalFetch
  db.close()
  fs.rmSync(dataDir, { recursive: true, force: true })
})
