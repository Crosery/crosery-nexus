import './testDataDir.js'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createServer, type Server } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import cookieParser from 'cookie-parser'
import express from 'express'
import { FakeCpa } from './testing/proxyFakeCpa.js'

const fake = await new FakeCpa().start()
process.env.CPA_BASE_URL = fake.base
process.env.CPA_MANAGEMENT_KEY = fake.key
process.env.SESSION_SECRET ||= 'proxy-routes-unit-secret'
delete process.env.PROXY_PRESETS

const auth = await import('./auth.js')
const { ProxyPoolStore } = await import('./proxyPoolStore.js')
const { createProxyService, registerProxyRoutes, SUBSCRIPTION_REFRESH_COOLDOWN_MS } = await import('./proxyRoutes.js')
const { attachProxyKernel } = await import('./proxyPoolHooks.js')
const { clearScanCacheForTests } = await import('./proxyMigrate.js')
const { resetControlPlaneCacheForTests } = await import('./proxyPoolControl.js')
const { installCredentialProxyHook } = await import('./proxyPoolJobs.js')
const { setCredentialProxy } = await import('./channels.js')

const ADMIN = `${auth.SESSION_COOKIE}=${auth.createSessionToken({ role: 'admin' })}`
const KEY = `${auth.SESSION_COOKIE}=${auth.createSessionToken({ role: 'key', keyHash: 'b'.repeat(64) })}`
const SUB_URL = 'https://sub.example.test/api/v1/client/subscribe?token=ROUTE-SUB-TOKEN'
const SECRETS = ['pw1', 'pw2', 'newpw', 'tj-secret', 'ROUTE-SUB-TOKEN', fake.key, FakeCpa.token('c1.json')]

function seed() {
  fake.credentials.clear()
  fake.credentials.set('c1.json', { name: 'c1.json', type: 'claude', email: 'one@example.test', proxy_url: 'http://u1:pw1@203.0.113.10:8080' })
  fake.credentials.set('c2.json', { name: 'c2.json', type: 'claude', email: 'two@example.test', proxy_url: 'http://u1:pw1@203.0.113.10:8080' })
  fake.credentials.set('c3.json', { name: 'c3.json', type: 'codex', email: 'three@example.test', proxy_url: 'http://u2:pw2@198.51.100.20:3128' })
  fake.credentials.set('c4.json', { name: 'c4.json', type: 'codex', email: 'four@example.test', proxy_url: '' })
  fake.globalProxy = ''
  fake.compat = []
  fake.providerKeys = {}
  fake.requests.length = 0
}

async function harness(options: { now?: () => number } = {}) {
  seed()
  clearScanCacheForTests()
  resetControlPlaneCacheForTests()
  attachProxyKernel(null)
  auth.setKeySessionLookup(() => 'active')
  const store = new ProxyPoolStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-routes-')), 'proxy'))
  const audits: Array<[string, string, string]> = []
  let subscriptionNodes = [{ name: 'S1', type: 'trojan', server: 's1.example.test', port: 443, password: 'tj-secret' }]
  let subscriptionFetches = 0
  const service = createProxyService({
    store,
    audit: (action, target, details) => audits.push([action, target, details]),
    probe: async () => true,
    ...(options.now ? { now: options.now } : {}),
    preview: {
      fetch: async () => {
        subscriptionFetches++
        return { body: `proxies:\n${subscriptionNodes.map(node => `  - ${JSON.stringify(node)}`).join('\n')}\n`, status: 200, info: null, updateIntervalH: null, filename: 'air', insecureHttp: false }
      },
      limit: task => task(),
    },
  })
  const app = express()
  app.use(express.json({ limit: '1mb' }))
  app.use(cookieParser())
  app.use(auth.createSessionGuard(app))
  registerProxyRoutes(app, service)
  const server: Server = createServer(app)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  const bodies: string[] = []
  const send = async (method: string, url: string, body?: unknown, cookie: string | null = ADMIN) => {
    const response = await fetch(`${base}${url}`, {
      method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await response.text()
    if (url !== '/api/proxies/export' || method !== 'POST') bodies.push(text)
    return { status: response.status, body: JSON.parse(text) as Record<string, any>, headers: response.headers }
  }
  return {
    store, service, audits, send, bodies,
    setSubscriptionNodes: (nodes: typeof subscriptionNodes) => { subscriptionNodes = nodes },
    subscriptionFetches: () => subscriptionFetches,
    close: async () => {
      auth.setKeySessionLookup(null)
      attachProxyKernel(null)
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}

function assertMasked(h: { bodies: string[]; audits: Array<[string, string, string]> }) {
  for (const text of h.bodies) for (const secret of SECRETS) assert.equal(text.includes(secret), false, `secret ${secret} in ${text.slice(0, 160)}`)
  for (const [, target, details] of h.audits) {
    assert.equal(/:\/\/|\d+\.\d+\.\d+\.\d+|example\.test/.test(`${target} ${details}`), false, `audit leaks: ${target} ${details}`)
  }
}

test.after(async () => { await fake.stop() })

const ROUTES: Array<[string, string, unknown?]> = [
  ['GET', '/api/proxies'], ['GET', '/api/proxies/options'], ['GET', '/api/proxies/accounts'], ['GET', '/api/proxies/export'],
  ['POST', '/api/proxies/export', {}], ['POST', '/api/proxies/parse', { text: 'x' }], ['POST', '/api/proxies/import', {}],
  ['POST', '/api/proxies/test', {}], ['POST', '/api/proxies/assign', {}], ['POST', '/api/proxies/unassign', {}],
  ['PUT', '/api/proxies/default', {}], ['POST', '/api/proxies/migrate', {}], ['POST', '/api/proxies/migrate/unignore', {}],
  ['POST', '/api/proxies/kernel/start', {}], ['PATCH', '/api/proxies/subscriptions/sub_aaaaaaaaaa', {}],
  ['DELETE', '/api/proxies/subscriptions/sub_aaaaaaaaaa'], ['POST', '/api/proxies/subscriptions/sub_aaaaaaaaaa/refresh', {}],
  ['POST', '/api/proxies/px_aaaaaaaaaa/test', {}], ['PATCH', '/api/proxies/px_aaaaaaaaaa', {}], ['DELETE', '/api/proxies/px_aaaaaaaaaa'],
]

test('admin only: key sessions get 403 and anonymous requests 401 on every route', async () => {
  const h = await harness()
  try {
    for (const [method, url, body] of ROUTES) {
      assert.equal((await h.send(method, url, body, KEY)).status, 403, `${method} ${url}`)
      assert.equal((await h.send(method, url, body, null)).status, 401, `${method} ${url}`)
    }
    assert.equal(fake.requests.length, 0)
  } finally { await h.close() }
})

test('GET is local only; migrate → masked pool view and accounts; no kernel → mihomo entries refused (409); same-host gate', async () => {
  const h = await harness()
  try {
    const empty = await h.send('GET', '/api/proxies')
    assert.equal(empty.status, 200)
    assert.equal(empty.body.kernel.state, 'unavailable')
    assert.equal(empty.headers.get('cache-control'), 'no-store')
    assert.equal(fake.requests.length, 0, 'page loads never reach the control plane')
    const migrated = await h.send('POST', '/api/proxies/migrate', { dryRun: false })
    assert.equal(migrated.body.created, 2)
    const view = await h.send('GET', '/api/proxies')
    assert.equal(view.body.entries.length, 2)
    const shared = view.body.entries.find((entry: any) => entry.server === '203.0.113.10')
    assert.equal(shared.usedBy.total, 2)
    assert.equal(shared.display, 'http://***@203.0.113.10:8080')
    const accounts = await h.send('GET', '/api/proxies/accounts')
    const c1 = accounts.body.accounts.find((row: any) => row.ref === 'cpa:c1.json')
    assert.equal(c1.entryId, shared.id)
    assert.equal(c1.masked, 'http://***@203.0.113.10:8080')

    const imported = await h.send('POST', '/api/proxies/parse', { text: 'trojan://tj-secret@t.example.test:443#tj' })
    assert.equal(imported.body.counts.new, 1)
    assert.equal(imported.body.kernelAvailable, false)
    const committed = await h.send('POST', '/api/proxies/import', { previewId: imported.body.previewId })
    const nodeId = committed.body.ids[0]
    const refused = await h.send('POST', '/api/proxies/assign', { target: nodeId, accounts: ['cpa:c4.json'], confirm: true })
    assert.equal(refused.status, 409)
    assert.equal(refused.body.code, 'kernel_unavailable')

    const reloads: string[] = []
    attachProxyKernel({ status: () => ({ state: 'running', version: 'v1.19.31' }), requestReload: reason => reloads.push(reason), validate: async () => new Map() })
    process.env.PROXY_CPA_SAME_HOST = '0'
    const remote = await h.send('POST', '/api/proxies/assign', { target: nodeId, accounts: ['cpa:c4.json'], confirm: true })
    assert.equal(remote.body.code, 'proxy_scope_mismatch')
    delete process.env.PROXY_CPA_SAME_HOST
    const ok = await h.send('POST', '/api/proxies/assign', { target: nodeId, accounts: ['cpa:c4.json'], confirm: true })
    assert.equal(ok.status, 200)
    assert.deepEqual(ok.body.warnings, ['这个出口还没检测过'])
    const port = h.store.read().entries.find(entry => entry.id === nodeId)?.port
    const auth = h.store.read().listenerAuth
    assert.equal(fake.credentials.get('c4.json')?.proxy_url, `socks5://${auth.username}:${encodeURIComponent(auth.password)}@127.0.0.1:${port}`)
    const reimport = await h.send('POST', '/api/proxies/parse', { text: 'trojan://tj-secret@t.example.test:443?type=ws&path=%2Fn#tj' })
    await h.send('POST', '/api/proxies/import', { previewId: reimport.body.previewId })
    assert.deepEqual(reloads, ['import'])
    assertMasked(h)
  } finally { await h.close() }
})

test('assign needs confirm, stores prev; unassign --restore puts it back; default writes the CPA global proxy after confirm', async () => {
  const h = await harness()
  try {
    await h.send('POST', '/api/proxies/migrate', { dryRun: false })
    const target = h.store.read().entries.find(entry => entry.server === '198.51.100.20')!
    assert.equal((await h.send('POST', '/api/proxies/assign', { target: target.id, accounts: ['cpa:c1.json'] })).body.code, 'confirm_required')
    const assigned = await h.send('POST', '/api/proxies/assign', { target: target.id, accounts: ['cpa:c1.json', 'cpa:missing.json'], confirm: true })
    assert.equal(assigned.body.updated, 1)
    assert.equal(assigned.body.results[1].code, 'account_not_found')
    assert.equal(fake.credentials.get('c1.json')?.proxy_url, 'http://u2:pw2@198.51.100.20:3128')
    assert.equal(h.store.read().links['cpa:c1.json'].prev, 'http://u1:pw1@203.0.113.10:8080')
    const restored = await h.send('POST', '/api/proxies/unassign', { accounts: ['cpa:c1.json'], restore: true, confirm: true })
    assert.equal(restored.body.results[0].status, 'restored')
    assert.equal(fake.credentials.get('c1.json')?.proxy_url, 'http://u1:pw1@203.0.113.10:8080')
    await h.send('POST', '/api/proxies/unassign', { accounts: ['cpa:c3.json'], confirm: true })
    assert.equal(fake.credentials.get('c3.json')?.proxy_url, '')

    const unconfirmed = await h.send('PUT', '/api/proxies/default', { target: target.id })
    assert.equal(unconfirmed.body.code, 'confirm_required')
    assert.equal(unconfirmed.body.accounts, 2)
    const set = await h.send('PUT', '/api/proxies/default', { target: target.id, confirm: true })
    assert.equal(set.status, 200)
    assert.equal(fake.globalProxy, 'http://u2:pw2@198.51.100.20:3128')
    assert.equal((await h.send('GET', '/api/proxies')).body.default.entryId, target.id)
    await h.send('PUT', '/api/proxies/default', { target: 'inherit', confirm: true })
    assert.equal(fake.globalProxy, '')
    assert.ok(fake.requests.some(item => item.method === 'DELETE' && item.path.endsWith('/proxy-url')))
    assert.equal((await h.send('POST', '/api/proxies/assign', { target: 'px_zzzzzzzzzz', accounts: ['cpa:c1.json'], confirm: true })).status, 404)
    const loopback = await h.send('POST', '/api/proxies/parse', { text: 'socks5://127.0.0.1:7890' })
    const external = (await h.send('POST', '/api/proxies/import', { previewId: loopback.body.previewId })).body.ids[0]
    const warned = await h.send('POST', '/api/proxies/assign', { target: external, accounts: ['cpa:c4.json'], confirm: true })
    assert.deepEqual(warned.body.warnings, ['依赖该主机上的其它代理程序', '这个出口还没检测过'])
    assert.equal((await h.send('POST', '/api/proxies/assign', { target: target.id, accounts: ['cpa:channel:x'], confirm: true })).body.results[0].code, 'account_read_only')
    assertMasked(h)
  } finally { await h.close() }
})

test('url edit re-PATCHes only accounts still on the old URL; drifted ones are reported, not overwritten', async () => {
  const h = await harness()
  try {
    await h.send('POST', '/api/proxies/migrate', { dryRun: false })
    const entry = h.store.read().entries.find(item => item.server === '203.0.113.10')!
    fake.credentials.get('c2.json')!.proxy_url = 'direct'
    const unconfirmed = await h.send('PATCH', `/api/proxies/${entry.id}`, { url: 'http://u1:newpw@203.0.113.11:8080' })
    assert.equal(unconfirmed.body.code, 'confirm_required')
    assert.equal(unconfirmed.body.accounts, 2)
    const patched = await h.send('PATCH', `/api/proxies/${entry.id}`, { url: 'http://u1:newpw@203.0.113.11:8080', confirm: true, name: '新出口' })
    assert.equal(patched.status, 200)
    assert.deepEqual(patched.body.reapplied, { updated: 1, drifted: 1, failed: 0, readOnly: 0 })
    assert.equal(fake.credentials.get('c1.json')?.proxy_url, 'http://u1:newpw@203.0.113.11:8080')
    assert.equal(fake.credentials.get('c2.json')?.proxy_url, 'direct')
    assert.equal(patched.body.entry.name, '新出口')
    assert.equal(h.store.read().links['cpa:c1.json'].entryId, entry.id)
    assert.equal(h.store.read().links['cpa:c2.json'], undefined)
    assertMasked(h)
  } finally { await h.close() }
})

test('delete/disable guards: linked → 409; keep (url only) ignores the exit for scans; reassign moves accounts first', async () => {
  const h = await harness()
  try {
    await h.send('POST', '/api/proxies/migrate', { dryRun: false })
    const shared = h.store.read().entries.find(item => item.server === '203.0.113.10')!
    const other = h.store.read().entries.find(item => item.server === '198.51.100.20')!
    const blocked = await h.send('DELETE', `/api/proxies/${shared.id}`)
    assert.equal(blocked.status, 409)
    assert.equal(blocked.body.code, 'proxy_in_use')
    assert.equal(blocked.body.accounts, 2)
    assert.equal((await h.send('PATCH', `/api/proxies/${shared.id}`, { enabled: false })).body.code, 'proxy_in_use')
    const kept = await h.send('DELETE', `/api/proxies/${shared.id}?reassign=keep`)
    assert.equal(kept.status, 200)
    assert.equal(fake.credentials.get('c1.json')?.proxy_url, 'http://u1:pw1@203.0.113.10:8080', 'keep leaves accounts as they are')
    clearScanCacheForTests()
    resetControlPlaneCacheForTests()
    const rescan = await h.send('POST', '/api/proxies/migrate', { dryRun: false })
    assert.equal(rescan.body.created, 0, 'an ignored exit is not re-created')
    assert.equal((await h.send('GET', '/api/proxies')).body.migration.ignored, 1)

    const needsConfirm = await h.send('DELETE', `/api/proxies/${other.id}?reassign=inherit`)
    assert.equal(needsConfirm.body.code, 'confirm_required')
    const moved = await h.send('DELETE', `/api/proxies/${other.id}?reassign=inherit&confirm=1`)
    assert.equal(moved.status, 200)
    assert.equal(moved.body.moved, 1)
    assert.equal(fake.credentials.get('c3.json')?.proxy_url, '')
    assert.equal((await h.send('POST', '/api/proxies/migrate/unignore', { all: true })).body.unignored, 2)
    assertMasked(h)
  } finally { await h.close() }
})

test('index hook: a write through setCredentialProxy (accounts UI / cradmin path) relinks the account', async () => {
  const h = await harness()
  try {
    await h.send('POST', '/api/proxies/migrate', { dryRun: false })
    assert.equal(await installCredentialProxyHook(h.service), true)
    const other = h.store.read().entries.find(item => item.server === '198.51.100.20')!
    await setCredentialProxy('c4.json', 'http://u2:pw2@198.51.100.20:3128')
    assert.equal(h.store.read().links['cpa:c4.json'].entryId, other.id)
    assert.equal(h.store.read().links['cpa:c4.json'].via, 'hook')
    await setCredentialProxy('c4.json', 'direct')
    assert.equal(h.store.read().links['cpa:c4.json'], undefined)
    assert.equal(h.store.read().observed['cpa:c4.json'].mode, 'direct')
  } finally { await h.close() }
})

test('subscriptions over HTTP: parse fetches once, import creates it, manual refresh has a cooldown; export masked vs secrets', async () => {
  let clock = Date.now()
  const h = await harness({ now: () => clock })
  try {
    const parsed = await h.send('POST', '/api/proxies/parse', { text: SUB_URL })
    assert.equal(parsed.body.subscriptions[0].maskedUrl, 'https://sub.example.test/***')
    const committed = await h.send('POST', '/api/proxies/import', { previewId: parsed.body.previewId, subscriptions: [{ key: 's0', intervalH: 24 }] })
    const subId = committed.body.subscriptions[0].id
    assert.equal((await h.send('POST', '/api/proxies/import', { previewId: parsed.body.previewId })).body.code, 'preview_expired')
    const sub = (await h.send('GET', '/api/proxies')).body.subscriptions[0]
    assert.equal(sub.intervalH, 24)
    h.setSubscriptionNodes([{ name: 'S2', type: 'trojan', server: 's2.example.test', port: 443, password: 'tj-secret' }])
    // right after the parse, a refresh shares that request's result: the provider is not asked again
    const early = await h.send('POST', `/api/proxies/subscriptions/${subId}/refresh`, {})
    assert.deepEqual([early.body.added, early.body.removed, h.subscriptionFetches()], [0, 0, 1])
    clock += SUBSCRIPTION_REFRESH_COOLDOWN_MS
    const refreshed = await h.send('POST', `/api/proxies/subscriptions/${subId}/refresh`, {})
    assert.equal(h.subscriptionFetches(), 2)
    assert.equal(refreshed.body.added, 1)
    assert.equal(refreshed.body.removed, 1)
    const again = await h.send('POST', `/api/proxies/subscriptions/${subId}/refresh`, {})
    assert.equal(again.status, 429)
    assert.ok(Number(again.headers.get('retry-after')) > 0)
    assert.equal((await h.send('PATCH', `/api/proxies/subscriptions/${subId}`, { intervalH: 3 })).status, 400)

    const masked = await h.send('GET', '/api/proxies/export')
    assert.equal(masked.body.masked, true)
    assert.equal((await h.send('POST', '/api/proxies/export', { withSecrets: true })).body.code, 'export_confirm_required')
    const full = await h.send('POST', '/api/proxies/export', { withSecrets: true, confirm: 'EXPORT-SECRETS' })
    assert.equal(full.body.subscriptions[0].url, SUB_URL)
    assert.ok(h.audits.some(([action]) => action === 'proxy-export-secrets'))
    const removed = await h.send('DELETE', `/api/proxies/subscriptions/${subId}`)
    assert.equal(removed.body.removed, 1)
    assert.equal((await h.send('POST', '/api/proxies/test', {})).body.code, 'checker_unavailable')
    assert.equal((await h.send('POST', '/api/proxies/kernel/restart', {})).body.code, 'kernel_not_attached')
    assert.equal((await h.send('POST', '/api/proxies/parse', { text: '{"outbounds": []}' })).body.hint?.includes('flag=clash'), true)
    assertMasked(h)
  } finally { await h.close() }
})
