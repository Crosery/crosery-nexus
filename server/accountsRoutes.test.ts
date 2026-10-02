import './testDataDir.js'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import test from 'node:test'
import cookieParser from 'cookie-parser'
import express from 'express'

process.env.SESSION_SECRET ||= 'accounts-routes-unit-secret'

const auth = await import('./auth.js')
const { createAccountsService, registerAccountsRoutes, ROUTING_NOTE } = await import('./accountsRoutes.js')
const { FakeKernel, idOf, secretFindings } = await import('./testing/fakeKernel.js')
type FakeKernelType = InstanceType<typeof FakeKernel>

const ADMIN = `${auth.SESSION_COOKIE}=${auth.createSessionToken({ role: 'admin' })}`
const KEY = `${auth.SESSION_COOKIE}=${auth.createSessionToken({ role: 'key', keyHash: 'a'.repeat(64) })}`

type Mode = { magpie: boolean; socket?: string; catalogFile?: string }

async function harness(kernel: FakeKernelType, mode: Mode) {
  auth.setKeySessionLookup(() => 'active')
  const audits: Array<[string, string, string]> = []
  const service = createAccountsService({
    socket: () => mode.socket ?? kernel.socket,
    magpieLocal: () => mode.magpie,
    hostExec: () => false,
    catalogFile: mode.catalogFile,
    audit: (action, target, details) => audits.push([action, target, details]),
    limiter: { run: task => task() },
    registry: { observe: (_id, task) => task(), countRequests: () => {} },
  })
  const app = express()
  app.use(express.json({ limit: '1mb' }))
  app.use(cookieParser())
  app.use(auth.createSessionGuard(app))
  registerAccountsRoutes(app, service)
  const server: Server = createServer(app)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  const send = async (method: string, path: string, body?: unknown, cookie: string | null = ADMIN) => {
    const response = await fetch(`${base}${path}`, {
      method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return { status: response.status, body: await response.json() as Record<string, any>, cacheControl: response.headers.get('cache-control') }
  }
  return {
    service, audits, send,
    close: async () => {
      service.signins.dispose()
      auth.setKeySessionLookup(null)
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}

const ROUTES: Array<[string, string, unknown?]> = [
  ['GET', '/api/accounts'],
  ['GET', '/api/accounts/catalog'],
  ['POST', '/api/accounts/signin', { agent: 'copilot' }],
  ['GET', '/api/accounts/signin/flow1x'],
  ['POST', '/api/accounts/signin/flow1x/callback', { url: 'http://localhost:1455/auth/callback?code=x' }],
  ['POST', '/api/accounts/signin/flow1x/cancel', {}],
  ['POST', '/api/accounts/login/on', { agent: 'codex', id: '0123456789abcdef' }],
  ['POST', '/api/accounts/codex-reset', { id: '0123456789abcdef' }],
  ['POST', '/api/accounts/quota/refresh', {}],
]

test('roles: key sessions get 403 and anonymous requests 401 on every accounts route; the kernel is never reached', async () => {
  const kernel = await new FakeKernel().start()
  const h = await harness(kernel, { magpie: true })
  try {
    for (const [method, path, body] of ROUTES) {
      const asKey = await h.send(method, path, body, KEY)
      assert.equal(asKey.status, 403, `${method} ${path} as a key session`)
      assert.equal(asKey.body.code, 'forbidden_role')
      const anonymous = await h.send(method, path, body, null)
      assert.equal(anonymous.status, 401, `${method} ${path} without a session`)
    }
    assert.equal(kernel.calls.length, 0)
  } finally { await h.close(); await kernel.stop() }
})

test('CPA backend: list and catalog answer without touching the kernel, writes are 409 cpa_backend', async () => {
  const kernel = await new FakeKernel().start()
  const h = await harness(kernel, { magpie: false })
  try {
    const list = await h.send('GET', '/api/accounts')
    assert.equal(list.status, 200)
    assert.equal(list.body.backend, 'cpa')
    assert.equal(list.cacheControl, 'no-store')
    const catalog = await h.send('GET', '/api/accounts/catalog')
    assert.deepEqual(catalog.body.items.map((item: { agent: string }) => item.agent), ['codex', 'claude', 'antigravity', 'kimi', 'kimi-ai', 'xai', 'devin', 'meta'])
    for (const [method, path, body] of ROUTES.slice(2)) {
      const response = await h.send(method, path, body)
      assert.equal(response.status, 409, `${method} ${path}`)
      assert.equal(response.body.code, 'cpa_backend')
    }
    assert.equal(kernel.calls.length, 0, 'CPA mode never talks to a Magpie kernel')
  } finally { await h.close(); await kernel.stop() }
})

test('magpie backend unavailable: an old kernel, an unsafe one, a missing one, a missing catalog — each says why', async () => {
  const kernel = await new FakeKernel().start()
  try {
    kernel.health = 'old'
    let h = await harness(kernel, { magpie: true })
    let list = await h.send('GET', '/api/accounts')
    assert.deepEqual([list.status, list.body.backend, list.body.available, list.body.reason], [200, 'magpie-unavailable', false, 'kernel_outdated'])
    assert.equal(list.body.message, '当前内核不支持账号登录，需要重新构建内核')
    const catalog = await h.send('GET', '/api/accounts/catalog')
    assert.deepEqual([catalog.body.available, catalog.body.items], [false, []])
    const start = await h.send('POST', '/api/accounts/signin', { agent: 'copilot' })
    assert.deepEqual([start.status, start.body.code], [501, 'kernel_outdated'])
    await h.close()

    kernel.health = { keychain: true }
    h = await harness(kernel, { magpie: true })
    list = await h.send('GET', '/api/accounts')
    assert.equal(list.body.reason, 'kernel_outdated', 'a kernel that may read the login keychain gets no account routes')
    await h.close()

    kernel.health = 'ok'
    h = await harness(kernel, { magpie: true, socket: `${kernel.socket}.missing` })
    list = await h.send('GET', '/api/accounts')
    assert.equal(list.body.reason, 'kernel_unavailable')
    const down = await h.send('POST', '/api/accounts/signin', { agent: 'copilot' })
    assert.deepEqual([down.status, down.body.code, down.body.error], [503, 'kernel_unavailable', '内核未运行'])
    await h.close()

    h = await harness(kernel, { magpie: true, catalogFile: '/nonexistent/catalog.json' })
    list = await h.send('GET', '/api/accounts')
    assert.equal(list.body.reason, 'catalog_missing')
    await h.close()
  } finally { await kernel.stop() }
})

test('magpie backend: catalog = committed catalog ∩ kernel login agents, Magpie\'s zh copy, gates and risk', async () => {
  const kernel = await new FakeKernel().start()
  kernel.loginAgents = kernel.loginAgents.filter(agent => agent !== 'zed')
  kernel.logins = [{ agent: 'codex', user: 'alpha.one@example.test', active: true }]
  const h = await harness(kernel, { magpie: true })
  try {
    const catalog = await h.send('GET', '/api/accounts/catalog')
    assert.equal(catalog.status, 200)
    assert.equal(catalog.body.backend, 'magpie')
    assert.equal(catalog.body.stale, false)
    assert.equal(catalog.body.routingNote, ROUTING_NOTE)
    const items = new Map(catalog.body.items.map((item: { agent: string }) => [item.agent, item]))
    assert.equal(items.size, 17)
    assert.ok(!items.has('zed'), 'an agent the kernel cannot sign in to is not offered')
    for (const agent of ['kimi', 'kimi-ai', 'meta']) assert.ok(!items.has(agent), `${agent} is CPA-only`)
    const qoder = items.get('qoder') as Record<string, any>
    assert.equal(qoder.risk.title, 'Qoder 账号可能被封禁')
    assert.match(qoder.risk.note, /Qoder/)
    assert.equal((items.get('claude') as Record<string, any>).risk, null)
    assert.deepEqual(['cursor', 'grok', 'devin'].map(agent => (items.get(agent) as Record<string, any>).gated), [true, true, true])
    assert.deepEqual((items.get('zcode') as Record<string, any>).sites.map((site: { id: string }) => site.id), ['zai', 'bigmodel'])
    assert.equal((items.get('codex') as Record<string, any>).signedIn, 1)
    assert.equal(catalog.body.copy.riskConfirm, '仍然登录')
  } finally { await h.close(); await kernel.stop() }
})

test('magpie backend: list, sign-in, actions, reset and refresh over HTTP; no secret leaves', async () => {
  const kernel = await new FakeKernel().start()
  kernel.logins = [
    { agent: 'codex', user: 'alpha.one@example.test', plan: 'Plus', active: true },
    { agent: 'codex', user: 'beta.two@example.test', on: true },
  ]
  kernel.usage.codex = { 'alpha.one@example.test': { windows: [{ name: '5 hours', used: 81 }], resets: { count: 1 } } }
  const h = await harness(kernel, { magpie: true })
  try {
    const first = await h.send('GET', '/api/accounts')
    assert.equal(first.status, 200)
    assert.equal(first.body.backend, 'magpie')
    assert.equal(first.body.routing, false)
    assert.equal(first.body.routingNote, ROUTING_NOTE)
    assert.deepEqual(first.body.providers.map((provider: { agent: string }) => provider.agent), ['codex'], 'only providers with accounts')
    const [alpha, beta] = first.body.providers[0].accounts
    assert.deepEqual([alpha.status, alpha.first, alpha.userMasked, beta.status], ['first', true, 'al••••••e@•••', 'on'])
    assert.equal(alpha.quota, null, 'the first answer does not wait for the allowance read')
    await new Promise(resolve => setTimeout(resolve, 50))
    const second = await h.send('GET', '/api/accounts')
    assert.equal(second.body.providers[0].accounts[0].quota.windows[0].usedPercent, 81)
    assert.equal(second.body.providers[0].accounts[0].canReset, true)
    assert.equal(kernel.count('GET', '/internal/accounts/usage'), 1, 'two page loads, one usage read')
    assert.deepEqual(secretFindings(second.body, ['fixture-access-token-should-never-leave']), [])
    assert.ok(!JSON.stringify(second.body).includes('/Users/someone'))

    const started = await h.send('POST', '/api/accounts/signin', { agent: 'copilot' })
    assert.equal(started.status, 200)
    assert.equal(started.body.code, 'ABCD-1234')
    const polled = await h.send('GET', `/api/accounts/signin/${started.body.id}`)
    assert.equal(polled.body.state, 'waiting')
    const callback = await h.send('POST', `/api/accounts/signin/${started.body.id}/callback`, { url: 'http://localhost:1/callback?code=x' })
    assert.deepEqual([callback.status, callback.body.code], [409, 'callback_not_supported'])
    const canceled = await h.send('POST', `/api/accounts/signin/${started.body.id}/cancel`, {})
    assert.equal(canceled.body.state, 'canceled')
    const risky = await h.send('POST', '/api/accounts/signin', { agent: 'qoder' })
    assert.deepEqual([risky.status, risky.body.code, risky.body.error], [409, 'risk_unconfirmed', '请先确认封号风险'])
    const gated = await h.send('POST', '/api/accounts/signin', { agent: 'cursor' })
    assert.deepEqual([gated.status, gated.body.code], [403, 'signin_gated'])

    const betaId = idOf('codex', 'beta.two@example.test')
    const off = await h.send('POST', '/api/accounts/login/off', { agent: 'codex', id: betaId })
    assert.equal(off.status, 200)
    assert.equal(off.body.provider.accounts.find((account: { id: string }) => account.id === betaId).on, false)
    const activeOff = await h.send('POST', '/api/accounts/login/off', { agent: 'codex', id: idOf('codex', 'alpha.one@example.test') })
    assert.deepEqual([activeOff.status, activeOff.body.code, activeOff.body.error], [409, 'account_active', '首选账号不能停用'])
    const bogus = await h.send('POST', '/api/accounts/login/delete-everything', { agent: 'codex', id: betaId })
    assert.deepEqual([bogus.status, bogus.body.code], [404, 'invalid_action'])

    const reset = await h.send('POST', '/api/accounts/codex-reset', { id: idOf('codex', 'alpha.one@example.test') })
    assert.deepEqual([reset.status, reset.body.outcome, reset.body.cooldownCleared], [200, 'reset', null])

    const refresh = await h.send('POST', '/api/accounts/quota/refresh', { agent: 'codex' })
    assert.equal(refresh.status, 200)
    assert.equal(refresh.body.results[0].refreshed, false, 'inside the 5 min floor a manual refresh does not read again')
    assert.equal(kernel.count('GET', '/internal/accounts/usage'), 1)

    const text = JSON.stringify(h.audits)
    for (const user of ['alpha.one@example.test', 'beta.two@example.test']) assert.ok(!text.includes(user), 'audit never holds an email')
    assert.deepEqual(h.audits.map(([action]) => action), ['account-signin-start', 'account-signin-cancel', 'account-off', 'account-codex-reset'])
  } finally { await h.close(); await kernel.stop() }
})
