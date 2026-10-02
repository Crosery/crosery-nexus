import { testDataDir } from './testDataDir.js'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { countingServer } from './testing/proxyFakeCpa.js'

const bridge = await countingServer()
process.env.GATEWAY_ENGINE = 'magpie'
process.env.MAGPIE_CONTROL_PLANE = 'local'
process.env.MAGPIE_SOURCE_CPA_BASE_URL = bridge.base
process.env.MAGPIE_SOURCE_CPA_KEY = 'bridge-key-should-never-be-used'
delete process.env.PROXY_PRESETS

const authDir = path.join(testDataDir, 'auth-files')
fs.mkdirSync(authDir, { recursive: true })
const writeAuth = (name: string, body: Record<string, unknown>) => fs.writeFileSync(path.join(authDir, name), JSON.stringify(body), { mode: 0o600 })
writeAuth('a.json', { type: 'claude', email: 'a@example.test', access_token: 'tok-a-SECRET', proxy_url: 'http://x:xpw@203.0.113.30:8080' })
writeAuth('b.json', { type: 'codex', email: 'b@example.test', access_token: 'tok-b-SECRET', proxy_url: '' })
writeAuth('c.json', { type: 'codex', email: 'c@example.test', access_token: 'tok-c-SECRET' })
const metaFile = path.join(testDataDir, 'auth-files-meta.json')
fs.writeFileSync(metaFile, JSON.stringify({ 'b.json': { proxy_url: 'socks5://203.0.113.31:1080' } }), { mode: 0o600 })
const channelsFile = path.join(testDataDir, 'magpie-channels.json')
fs.writeFileSync(channelsFile, JSON.stringify({
  version: 1,
  channels: [{ name: 'kimi', 'base-url': 'https://api.example.test/v1', 'api-key-entries': [{ 'api-key': 'env:KIMI_KEY', 'proxy-url': 'socks5://203.0.113.32:1080' }], models: [{ name: 'k2' }], 'proxy-url': 'direct' }],
  accounts: { claude: { proxy: 'http://203.0.113.33:3128', accountProxies: { 'user@example.test': 'socks5://203.0.113.34:1080' } } },
}), { mode: 0o600 })

const { ProxyPoolStore } = await import('./proxyPoolStore.js')
const { defaultControlPlane } = await import('./proxyPoolControl.js')
const { clearScanCacheForTests, runMigration } = await import('./proxyMigrate.js')
const { createProxyService } = await import('./proxyRoutes.js')

test.after(async () => { await bridge.stop() })

test('magpie local: auth files (meta overrides), registry channels/keys and the accounts section become entries + links; nothing else is written', async () => {
  clearScanCacheForTests()
  const before = { meta: fs.readFileSync(metaFile, 'utf8'), channels: fs.readFileSync(channelsFile, 'utf8'), a: fs.readFileSync(path.join(authDir, 'a.json'), 'utf8') }
  const store = new ProxyPoolStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-magpie-')), 'proxy'))
  const result = await runMigration(store, defaultControlPlane(), { mode: 'auto' })
  assert.equal(result.mode, 'first-run')
  const pool = store.read()
  assert.equal(pool.entries.length, 5)
  for (const ref of ['cpa:a.json', 'cpa:b.json', 'cpa:key:kimi:0', 'magpie:claude', 'magpie:claude:user@example.test']) assert.ok(pool.links[ref], ref)
  assert.equal(pool.observed['cpa:c.json'].mode, 'inherit')
  assert.equal(pool.links['cpa:global'], undefined, 'the magpie backend has no CPA global proxy')
  assert.deepEqual({ meta: fs.readFileSync(metaFile, 'utf8'), channels: fs.readFileSync(channelsFile, 'utf8'), a: fs.readFileSync(path.join(authDir, 'a.json'), 'utf8') }, before)
  assert.equal(bridge.hits(), 0)
  const text = JSON.stringify(pool.observed) + JSON.stringify(result.plan.totals)
  assert.equal(/tok-.-SECRET|xpw/.test(text), false)
})

test('magpie local: kernel accounts are read-only (501), credential files assign through the local shim and record prev', async () => {
  clearScanCacheForTests()
  const store = new ProxyPoolStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-magpie-')), 'proxy'))
  const audits: string[][] = []
  const service = createProxyService({ store, audit: (...args) => audits.push(args) })
  await service.migrate({ dryRun: false })
  const target = store.read().entries.find(entry => entry.server === '203.0.113.34')!
  const magpie = await service.assign({ target: target.id, accounts: ['magpie:claude:user@example.test'], confirm: true })
  assert.equal(magpie.results[0].code, 'accounts_proxy_unavailable')
  const credential = await service.assign({ target: target.id, accounts: ['cpa:c.json'], confirm: true })
  assert.equal(credential.results[0].status, 'updated')
  assert.equal(JSON.parse(fs.readFileSync(metaFile, 'utf8'))['c.json'].proxy_url, 'socks5://203.0.113.34:1080')
  assert.equal(store.read().links['cpa:c.json'].entryId, target.id)
  assert.equal(store.read().links['cpa:c.json'].prev, '')
  const restored = await service.unassign({ accounts: ['cpa:c.json'], restore: true, confirm: true })
  assert.equal(restored.results[0].status, 'restored')
  assert.equal(JSON.parse(fs.readFileSync(metaFile, 'utf8'))['c.json'].proxy_url, '')
  await assert.rejects(service.setDefault({ target: 'direct', confirm: true }), (error: { code?: string }) => error.code === 'accounts_proxy_unavailable')
  for (const [, target, details] of audits) assert.equal(/@example\.test|203\.0\.113|:\/\//.test(`${target} ${details}`), false, `${target} ${details}`)
})
