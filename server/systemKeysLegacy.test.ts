import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

/**
 * v0.2.0-rc.4 在预发布 CPA 里写过旧格式探测 Key（sk-probe-<64 hex>，没有服务段）和 cpa-probe-keys.json。
 * 升级后它们仍要被认成系统 Key：读时隐藏、绝不导入成用户 Key、下一次写 api-keys 时清掉。
 */
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'system-keys-legacy-'))
process.env.DATA_DIR = dataDir
process.env.CPA_BASE_URL = 'https://legacy-gateway.example.test'
process.env.CPA_MANAGEMENT_KEY = 'fixture-management-key'
const originalFetch = globalThis.fetch
const { db } = await import('./db.js')
const { syncKeysFromCPA } = await import('./sync.js')
const { getCPAKeys, registerProbeKeys, replaceCPAKeys } = await import('./cpa.js')
const { ensureProbeKeys, readSystemKeys } = await import('./systemKeys.js')

const legacyLockout = `sk-lockout-${'1'.repeat(64)}`
const legacyProbe = `sk-probe-${'2'.repeat(64)}`
const userKey = `sk-teacher-${'3'.repeat(32)}`
fs.writeFileSync(path.join(dataDir, 'cpa-lockout-key'), `${legacyLockout}\n`, { mode: 0o600 })
fs.writeFileSync(path.join(dataDir, 'cpa-probe-keys.json'), JSON.stringify({ version: 1, keys: { codex: legacyProbe } }), { mode: 0o600 })

let apiKeys: string[] = []
const puts: string[][] = []
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const route = new URL(String(input)).pathname.replace('/v0/management', '')
  const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } })
  if (route === '/api-keys') {
    if (init?.method === 'PUT') {
      apiKeys = JSON.parse(String(init.body))
      puts.push(apiKeys)
    }
    return json({ 'api-keys': apiKeys })
  }
  if (route === '/api-key-channel-access') return json({ 'api-key-channel-access': {} })
  throw new Error(`Unexpected fixture route: ${route}`)
}) as typeof fetch

test('旧格式探测 Key + 新格式探测 Key + 用户 Key：只导入用户 Key，下一次写入只留当前系统 Key', async () => {
  const current = ensureProbeKeys(dataDir, ['codex']).codex
  assert.match(current, /^sk-probe-codex-[0-9a-f]{64}$/)
  assert.equal(readSystemKeys(dataDir).lockout, legacyLockout, '旧封锁 Key 原值迁入')
  assert.ok(!fs.existsSync(path.join(dataDir, 'cpa-probe-keys.json')), '旧探测 Key 文件在新文件落盘后删掉')

  apiKeys = [userKey, legacyProbe, current]
  assert.deepEqual(await getCPAKeys(), [userKey])
  await syncKeysFromCPA()
  assert.deepEqual((db.prepare('SELECT key_value FROM api_keys').all() as Array<{ key_value: string }>).map((row) => row.key_value), [userKey])

  await replaceCPAKeys(await getCPAKeys())
  assert.deepEqual(puts.at(-1), [userKey, current])
})

test('探测轮次注册 Key 时也清掉没人持有的系统 Key（旧格式、旧数据目录留下的）', async () => {
  const orphan = `sk-probe-gone-${'4'.repeat(64)}`
  const current = readSystemKeys(dataDir).probes.codex
  apiKeys = [userKey, legacyProbe, orphan, current]
  await registerProbeKeys(['codex'])
  assert.deepEqual(apiKeys, [userKey, current])
  const writes = puts.length
  await registerProbeKeys(['codex'])
  assert.equal(puts.length, writes, '没有变化就不写')
})

test.after(() => {
  globalThis.fetch = originalFetch
  db.close()
  fs.rmSync(dataDir, { recursive: true, force: true })
})
