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

/**
 * Account egress (PROXY-SPEC §7, §12 accounts page): the /accounts read model and the authoritative per-account read
 * (fake CPA control plane).
 */

const fake = await new FakeCpa().start()
process.env.CPA_BASE_URL = fake.base
process.env.CPA_MANAGEMENT_KEY = fake.key
process.env.SESSION_SECRET ||= 'proxy-egress-unit-secret'
process.env.PROXY_PRESETS = '住宅=http://u1:pw1@203.0.113.10:8080;东京=socks5://pre:PRESET-PW@198.51.100.70:1080'
delete process.env.PROXY_CPA_SAME_HOST

const auth = await import('./auth.js')
const { ProxyPoolStore } = await import('./proxyPoolStore.js')
const { createProxyService, registerProxyRoutes, EGRESS_READ_TTL_MS } = await import('./proxyRoutes.js')
const { attachProxyKernel } = await import('./proxyPoolHooks.js')
const { clearScanCacheForTests } = await import('./proxyMigrate.js')
const { defaultControlPlane, resetControlPlaneCacheForTests } = await import('./proxyPoolControl.js')
const { serviceOf } = await import('./proxyEgress.js')
type Control = import('./proxyPoolControl.js').ProxyControlPlane

const ADMIN = `${auth.SESSION_COOKIE}=${auth.createSessionToken({ role: 'admin' })}`
const KEY = `${auth.SESSION_COOKIE}=${auth.createSessionToken({ role: 'key', keyHash: 'c'.repeat(64) })}`
const SECRETS = ['pw1', 'pw2', 'pw9', 'PRESET-PW', 'ss-secret-pass', fake.key, FakeCpa.token('c1.json')]
const AT = '2026-10-02T10:00:00.000Z'

function seed() {
  fake.credentials.clear()
  fake.credentials.set('c1.json', { name: 'c1.json', type: 'claude', email: 'one@example.test', proxy_url: 'http://u1:pw1@203.0.113.10:8080' })
  fake.credentials.set('c3.json', { name: 'c3.json', type: 'codex', email: 'three@example.test', proxy_url: 'http://u2:pw2@198.51.100.20:3128' })
  fake.credentials.set('c4.json', { name: 'c4.json', type: 'codex', email: 'four@example.test', proxy_url: '' })
  fake.globalProxy = ''
  fake.compat = []
  fake.providerKeys = {}
  fake.requests.length = 0
}

type Options = { control?: (base: Control) => Control; now?: () => number }

async function harness(options: Options = {}) {
  seed()
  clearScanCacheForTests()
  resetControlPlaneCacheForTests()
  attachProxyKernel(null)
  auth.setKeySessionLookup(() => 'active')
  const store = new ProxyPoolStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-egress-')), 'proxy'))
  const audits: Array<[string, string, string]> = []
  const base = defaultControlPlane()
  const service = createProxyService({
    store,
    control: options.control ? options.control(base) : base,
    audit: (action, target, details) => audits.push([action, target, details]),
    probe: async () => true,
    now: options.now,
  })
  const app = express()
  app.use(express.json({ limit: '1mb' }))
  app.use(cookieParser())
  app.use(auth.createSessionGuard(app))
  registerProxyRoutes(app, service)
  const server: Server = createServer(app)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  const bodies: string[] = []
  const send = async (method: string, route: string, body?: unknown, cookie: string | null = ADMIN) => {
    const response = await fetch(`${url}${route}`, {
      method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await response.text()
    bodies.push(text)
    return { status: response.status, body: JSON.parse(text) as Record<string, any> }
  }
  const importText = async (text: string) => {
    const preview = await send('POST', '/api/proxies/parse', { text })
    return (await send('POST', '/api/proxies/import', { previewId: preview.body.previewId })).body.ids[0] as string
  }
  return {
    store, service, audits, send, bodies, importText,
    close: async () => {
      auth.setKeySessionLookup(null)
      attachProxyKernel(null)
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}

function assertMasked(h: { bodies: string[]; audits: Array<[string, string, string]> }) {
  for (const text of h.bodies) for (const secret of SECRETS) assert.equal(text.includes(secret), false, `secret ${secret} in ${text.slice(0, 200)}`)
  for (const [, target, details] of h.audits) assert.equal(/:\/\/|\d+\.\d+\.\d+\.\d+|example\.test/.test(`${target} ${details}`), false, `audit leaks: ${target} ${details}`)
}

test.after(async () => { await fake.stop() })

test('service of an account: the probe that tells whether its exit reaches the vendor', () => {
  assert.equal(serviceOf('claude'), 'claude')
  assert.equal(serviceOf('codex'), 'openai')
  assert.equal(serviceOf('antigravity'), 'google')
  assert.equal(serviceOf('gemini-cli'), 'google')
  assert.equal(serviceOf('kimi'), null)
})

test('egress routes are admin only', async () => {
  const h = await harness()
  try {
    for (const route of ['/api/proxies/egress', '/api/proxies/egress/account?ref=cpa:c1.json']) {
      assert.equal((await h.send('GET', route, undefined, KEY)).status, 403)
      assert.equal((await h.send('GET', route, undefined, null)).status, 401)
    }
    assert.equal(fake.requests.length, 0)
  } finally { await h.close() }
})

test('CPA: the page model is local only — entries with country and per-service checks, accounts as last seen, presets deduped', async () => {
  const h = await harness()
  try {
    await h.send('POST', '/api/proxies/migrate', { dryRun: false })
    const nodeId = await h.importText('ss://YWVzLTI1Ni1nY206c3Mtc2VjcmV0LXBhc3M@198.51.100.30:8388#node-ss')
    const shared = h.store.read().entries.find(entry => entry.server === '203.0.113.10')!
    h.store.updateHealth((health) => {
      health.entries[shared.id] = {
        exit: { ip: '203.0.113.10', country: 'JP', state: 'ok', at: AT },
        services: { claude: { state: 'ok', ms: 230, at: AT, hosts: [] }, openai: { state: 'region-blocked', ms: 410, at: AT, hosts: [] } },
        lastAt: AT,
      }
    })
    fake.requests.length = 0
    const view = await h.send('GET', '/api/proxies/egress')
    assert.equal(view.status, 200)
    assert.equal(fake.requests.length, 0, 'no control-plane call on a page load')
    assert.equal(view.body.backend, 'cpa')
    assert.deepEqual(view.body.accountProxy, { supported: true, reason: null })
    assert.equal(view.body.signin.via, 'cpa-global')
    assert.equal(view.body.signin.perSignin, false)
    const entry = view.body.entries.find((item: any) => item.id === shared.id)
    assert.equal(entry.country, 'JP')
    assert.deepEqual(entry.checks.claude, { state: 'ok', ms: 230, at: AT })
    assert.equal(entry.checks.openai.state, 'region-blocked')
    assert.equal(entry.usedBy, 1)
    const node = view.body.entries.find((item: any) => item.id === nodeId)
    assert.equal(node.assignable, false)
    assert.equal(node.reason, '内核未安装')
    assert.deepEqual(view.body.accounts['cpa:c1.json'], { mode: 'url', entryId: shared.id, masked: 'http://***@203.0.113.10:8080', at: view.body.accounts['cpa:c1.json'].at })
    assert.equal(view.body.accounts['cpa:c4.json'].mode, 'inherit')
    // migration takes presets into the pool too: the picker then lists them once, as pool entries
    const tokyo = h.store.read().entries.find(item => item.server === '198.51.100.70')!
    assert.equal(tokyo.source, 'preset')
    assert.deepEqual(view.body.presets.map((preset: any) => [preset.label, preset.entryId]), [['住宅', shared.id], ['东京', tokyo.id]])
    assertMasked(h)
  } finally { await h.close() }
})

test('CPA: the per-account read asks CPA once per TTL, never returns the URL, keeps the index in step; a write clears it', async () => {
  let clock = Date.parse(AT)
  const h = await harness({ now: () => clock })
  try {
    await h.send('POST', '/api/proxies/migrate', { dryRun: false })
    const shared = h.store.read().entries.find(entry => entry.server === '203.0.113.10')!
    fake.credentials.get('c4.json')!.proxy_url = 'http://u1:pw1@203.0.113.10:8080'
    fake.requests.length = 0
    const first = await h.send('GET', '/api/proxies/egress/account?ref=cpa:c4.json&provider=codex')
    assert.equal(first.status, 200)
    assert.equal(first.body.mode, 'url')
    assert.equal(first.body.entryId, shared.id)
    assert.equal(first.body.entryName, shared.name)
    assert.equal(first.body.preset, 0, 'the 住宅 preset holds the same address')
    assert.equal(h.store.read().links['cpa:c4.json'].entryId, shared.id, 'the drifted account is linked now')
    assert.equal(h.store.read().observed['cpa:c4.json'].provider, 'codex')
    await h.send('GET', '/api/proxies/egress/account?ref=cpa:c4.json')
    assert.equal(fake.requests.filter(item => item.path.includes('/auth-files/download')).length, 1, 'coalesced within the TTL')
    clock += EGRESS_READ_TTL_MS + 1
    await h.send('GET', '/api/proxies/egress/account?ref=cpa:c4.json')
    assert.equal(fake.requests.filter(item => item.path.includes('/auth-files/download')).length, 2)

    const other = h.store.read().entries.find(entry => entry.server === '198.51.100.20')!
    const assigned = await h.send('POST', '/api/proxies/assign', { target: other.id, accounts: ['cpa:c4.json'], confirm: true })
    assert.equal(assigned.body.updated, 1)
    const after = await h.send('GET', '/api/proxies/egress/account?ref=cpa:c4.json')
    assert.equal(after.body.entryId, other.id, 'the assign cleared the cached read')
    assert.equal(after.body.preset, null)
    assert.equal((await h.send('GET', '/api/proxies/egress/account?ref=cpa:channel:x')).status, 409)
    assert.equal((await h.send('GET', '/api/proxies/egress/account?ref=nope')).status, 400)
    assert.equal((await h.send('GET', '/api/proxies/egress/account?ref=magpie:codex:a@example.test')).status, 400, 'a retired backend\'s ref is not an account here')
    assertMasked(h)
  } finally { await h.close() }
})
