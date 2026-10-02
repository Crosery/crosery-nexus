import './testDataDir.js'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { countingServer, FakeCpa } from './testing/proxyFakeCpa.js'

// env before config.ts is evaluated: the console's own control plane is the fake CPA; the bridge is a trap
const fake = await new FakeCpa().start()
const bridge = await countingServer()
process.env.GATEWAY_ENGINE = 'cpa'
process.env.CPA_BASE_URL = fake.base
process.env.CPA_MANAGEMENT_KEY = fake.key
process.env.MAGPIE_SOURCE_CPA_BASE_URL = bridge.base
process.env.MAGPIE_SOURCE_CPA_KEY = 'bridge-key-should-never-be-used'
process.env.PROXY_PRESETS = '美国住宅=socks5://pre:prepw@203.0.113.50:1080;http://198.51.100.60:3128'

const { ProxyPoolStore } = await import('./proxyPoolStore.js')
const { defaultControlPlane, resetControlPlaneCacheForTests } = await import('./proxyPoolControl.js')
const { clearScanCacheForTests, collectMigrationSources, planMigration, planView, runMigration } = await import('./proxyMigrate.js')
const { createProxyService } = await import('./proxyRoutes.js')
const { registerProxyPoolJobs } = await import('./proxyPoolJobs.js')
const { SyncRegistry } = await import('./syncRegistry.js')

const SECRETS = ['pw1', 'respw', 'gpw', 'prepw', FakeCpa.token('c1.json'), 'fake-refresh-c1.json', fake.key]

function seed() {
  fake.credentials.clear()
  const add = (name: string, type: string, proxy?: string) => fake.credentials.set(name, { name, type, email: `${name.replace('.json', '')}@example.test`, ...(proxy !== undefined ? { proxy_url: proxy } : {}) })
  add('c1.json', 'claude', 'http://u1:pw1@203.0.113.10:8080')
  add('c2.json', 'claude', 'http://u1:pw1@203.0.113.10:8080')
  add('c3.json', 'codex', 'socks5h://res-user-country-us:respw@gw.example.test:7777')
  add('c4.json', 'codex', 'socks5://res-user-country-us:respw@GW.example.test:7777')
  add('c5.json', 'xai', '')
  add('c6.json', 'xai', 'direct')
  add('c7.json', 'antigravity', 'socks5://127.0.0.1:7890')
  add('c8.json', 'claude')
  add('c9.json', 'gemini', 'ftp://not-a-proxy')
  fake.globalProxy = 'http://g:gpw@198.51.100.70:3128'
  fake.compat = [{ name: 'kimi', 'base-url': 'https://api.example.test/v1', 'proxy-url': 'socks5://203.0.113.80:1080', 'api-key-entries': [{ 'api-key': 'sk-fake-compat-key-000000', 'proxy-url': 'direct' }], models: [] }]
  fake.providerKeys = { 'claude-api-key': [{ 'api-key': 'sk-fake-claude-key-000000', 'base-url': 'https://relay.example.test', 'proxy-url': 'http://203.0.113.81:3128' }] }
  fake.requests.length = 0
  fake.failDownloads.clear()
  fake.down = false
}

const newStore = () => new ProxyPoolStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-migrate-')), 'proxy'))

function noSecrets(value: unknown) {
  const text = JSON.stringify(value)
  for (const secret of SECRETS) assert.equal(text.includes(secret), false, `leaked ${secret}`)
}

test.after(async () => { await fake.stop(); await bridge.stop() })

test('dry-run: groups exits, counts inherit/direct/invalid, reads each credential once, shows no secret', async () => {
  seed()
  clearScanCacheForTests()
  resetControlPlaneCacheForTests()
  const store = newStore()
  const sources = await collectMigrationSources(defaultControlPlane())
  assert.equal(fake.requests.filter(item => item.path.startsWith('/v0/management/auth-files/download')).length, 9)
  const plan = planMigration(store.read(), sources)
  assert.equal(plan.totals.accounts, 9)
  assert.equal(plan.totals.inherit, 2)
  assert.equal(plan.totals.direct, 1)
  assert.equal(plan.totals.invalid, 1)
  const view = planView(plan, sources, 'scan')
  noSecrets(view)
  const byMasked = Object.fromEntries(view.exits.map(exit => [exit.maskedUrl, exit]))
  assert.equal(byMasked['http://***@203.0.113.10:8080'].accounts.total, 2)
  assert.equal(byMasked['http://***@203.0.113.10:8080'].action, 'create')
  const gateway = view.exits.find(exit => exit.maskedUrl.includes('gw.example.test') || exit.maskedUrl.includes('GW.example.test'))
  assert.equal(gateway?.accounts.total, 2, 'socks5h and socks5 with host case are one exit')
  assert.equal(byMasked['socks5://127.0.0.1:7890'].external, true)
  assert.deepEqual(byMasked['http://***@198.51.100.70:3128'].others, ['global'])
  assert.deepEqual(byMasked['socks5://203.0.113.80:1080'].others, ['channel'])
  assert.deepEqual(byMasked['http://203.0.113.81:3128'].others, ['key'])
  assert.equal(byMasked['socks5://***@203.0.113.50:1080'].name, '美国住宅')
  assert.equal(byMasked['socks5://***@203.0.113.50:1080'].source, 'preset')
  assert.equal(view.exits.find(exit => exit.key === 'invalid')?.action, 'skip')
  assert.equal(fake.writes().length, 0)
  assert.equal(bridge.hits(), 0)
})

test('first run applies: entries + links, zero account writes; a re-run changes nothing', async () => {
  seed()
  clearScanCacheForTests()
  resetControlPlaneCacheForTests()
  const store = newStore()
  const control = defaultControlPlane()
  const first = await runMigration(store, control, { mode: 'auto' })
  assert.equal(first.mode, 'first-run')
  assert.equal(fake.writes().length, 0, 'migration never writes an account')
  const pool = store.read()
  assert.ok(pool.migration.firstRunAt)
  assert.equal(pool.entries.length, 8, '203.0.113.10, gw, loopback, global, channel, key, 2 presets')
  assert.equal(pool.migration.firstRunImported, 8)
  assert.equal(pool.links['cpa:c1.json'].entryId, pool.links['cpa:c2.json'].entryId)
  assert.equal(pool.links['cpa:c3.json'].entryId, pool.links['cpa:c4.json'].entryId)
  const external = pool.entries.find(entry => entry.id === pool.links['cpa:c7.json'].entryId)
  assert.equal(external?.external, true)
  assert.equal(pool.links['cpa:c5.json'], undefined)
  assert.equal(pool.observed['cpa:c5.json'].mode, 'inherit')
  assert.equal(pool.observed['cpa:c6.json'].mode, 'direct')
  assert.equal(pool.observed['cpa:c9.json'].mode, 'invalid')
  assert.ok(pool.links['cpa:global'])
  assert.ok(pool.links['cpa:channel:kimi'])
  assert.equal(pool.entries.every(entry => entry.kind === 'url' && entry.validity === 'ok'), true)
  assert.equal(pool.migration.pending, null)

  clearScanCacheForTests()
  const again = await runMigration(store, control, { mode: 'apply', force: true })
  assert.equal(again.applied.created.length, 0)
  assert.deepEqual([...new Set(again.plan.exits.map(exit => exit.action))].sort(), ['skip', 'unchanged'])
  assert.equal(store.read().entries.length, 8)
  assert.equal(fake.writes().length, 0)
  assert.equal(bridge.hits(), 0)
})

test('weekly scan: new exits become pending (banner), not entries; drifted links are dropped; deleted credentials leave the index', async () => {
  seed()
  clearScanCacheForTests()
  resetControlPlaneCacheForTests()
  const store = newStore()
  const control = defaultControlPlane()
  await runMigration(store, control, { mode: 'auto' })
  fake.credentials.get('c2.json')!.proxy_url = 'http://n:newpw@203.0.113.99:8080'
  fake.credentials.delete('c8.json')
  fake.credentials.get('c1.json')!.proxy_url = 'direct'
  clearScanCacheForTests()
  resetControlPlaneCacheForTests()
  const scan = await runMigration(store, control, { mode: 'auto', force: true })
  assert.equal(scan.mode, 'scan')
  const pool = store.read()
  assert.equal(pool.entries.length, 8, 'a scan adds no entries')
  assert.deepEqual({ exits: pool.migration.pending?.exits, accounts: pool.migration.pending?.accounts }, { exits: 1, accounts: 1 })
  assert.equal(pool.links['cpa:c1.json'], undefined)
  assert.equal(pool.links['cpa:c2.json'], undefined)
  assert.equal(pool.observed['cpa:c8.json'], undefined)
  noSecrets(pool.migration)
})

test('ignored exits are not re-created; partial read failures skip one account; CPA down is an error', async () => {
  seed()
  clearScanCacheForTests()
  resetControlPlaneCacheForTests()
  const store = newStore()
  const control = defaultControlPlane()
  await runMigration(store, control, { mode: 'auto' })
  const loopback = store.read().entries.find(entry => entry.external)!
  store.update((pool) => {
    pool.entries = pool.entries.filter(entry => entry.id !== loopback.id)
    pool.migration.ignored.push(loopback.fingerprint)
  })
  clearScanCacheForTests()
  const result = await runMigration(store, control, { mode: 'apply', force: true })
  assert.equal(result.applied.created.length, 0)
  assert.equal(result.plan.exits.find(exit => exit.url === 'socks5://127.0.0.1:7890')?.reason, '已忽略')

  fake.failDownloads.add('c3.json')
  clearScanCacheForTests()
  resetControlPlaneCacheForTests()
  const partial = await collectMigrationSources(control)
  assert.equal(partial.readErrors, 1)
  assert.equal(partial.rows.some(row => row.ref === 'cpa:c3.json'), false)

  fake.down = true
  clearScanCacheForTests()
  resetControlPlaneCacheForTests()
  await assert.rejects(runMigration(store, control, { mode: 'auto', force: true }))
  fake.down = false
})

test('proxy-migrate job: registered in the sync registry, first run summary, no account writes; manual migrate route keeps zero writes', async () => {
  seed()
  clearScanCacheForTests()
  resetControlPlaneCacheForTests()
  const store = newStore()
  const audits: string[][] = []
  const service = createProxyService({ store, audit: (...args) => audits.push(args) })
  const registry = new SyncRegistry({ file: null, log: () => undefined })
  registerProxyPoolJobs(registry, service)
  const run = await registry.run('proxy-migrate', 'boot')
  assert.equal(run.outcome.result, 'ok')
  assert.equal(run.outcome.summary, '已从现有账号导入 8 个出口')
  const status = await registry.status()
  assert.ok(status.jobs.some(job => job.id === 'proxy-subscriptions' && job.label === '代理订阅'))
  assert.ok(status.jobs.some(job => job.id === 'proxy-migrate' && job.label === '账号代理扫描'))
  const dry = await service.migrate({ dryRun: true }) as Record<string, unknown>
  noSecrets(dry)
  const applied = await service.migrate({ dryRun: false, scanId: dry.scanId }) as Record<string, unknown>
  assert.equal(applied.created, 0)
  assert.equal(fake.writes().length, 0)
  assert.equal(bridge.hits(), 0)
  for (const [, , details] of audits) assert.equal(/\d+\.\d+\.\d+\.\d+|example\.test|:\/\//.test(details), false)
})
