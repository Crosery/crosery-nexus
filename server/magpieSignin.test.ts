import './testDataDir.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import { loadMagpieCatalog, type MagpieCatalog } from './accountCatalog.js'
import { AccountsError } from './accountsError.js'
import { kernelCaller, parseKernelHealth, type KernelCall, type KernelHealth } from './magpieKernel.js'
import { loopbackRelay, SIGNIN_LIMITS, SignInManager } from './magpieSignin.js'
import { FakeKernel, fakeListener, secretFindings } from './testing/fakeKernel.js'

const catalog = loadMagpieCatalog() as MagpieCatalog

async function harness(options: { hostExec?: boolean; wrap?: (call: KernelCall) => KernelCall } = {}) {
  const kernel = await new FakeKernel().start()
  let now = Date.parse('2026-10-02T10:00:00Z')
  const audits: Array<[string, string, string]> = []
  const done: string[] = []
  const manager = new SignInManager({
    call: (options.wrap ?? (call => call))(kernelCaller(() => kernel.socket)), now: () => now, relay: loopbackRelay,
    audit: (action, target, details) => audits.push([action, target, details]), onDone: agent => done.push(agent),
  })
  const health = () => parseKernelHealth(JSON.parse(JSON.stringify({
    ok: true, engine: 'magpie', revision: catalog.revision, capabilities: ['signin', 'accounts', 'usage', 'codex-reset'],
    loginAgents: kernel.loginAgents, signinDeny: kernel.signinDeny, keychain: false,
  }))) as KernelHealth
  const context = () => ({ health: health(), catalog, hostExec: options.hostExec ?? false })
  return {
    kernel, manager, audits, done, context,
    advance: (ms: number) => { now += ms },
    start: (agent: string, extra: Record<string, unknown> = {}) => manager.start({ agent, ...extra }, context()),
    close: async () => { manager.dispose(); await kernel.stop() },
  }
}

const refused = (code: string, status?: number) => (error: unknown) => {
  assert.ok(error instanceof AccountsError, `expected AccountsError, got ${String(error)}`)
  assert.equal(error.code, code)
  if (status !== undefined) assert.equal(error.status, status)
  return true
}

test('catalog: the committed file loads and matches the pin', () => {
  assert.ok(catalog, 'deploy/magpie/catalog.json must load and validate')
  assert.equal(catalog.items.length, 18)
  assert.ok(catalog.relayForbiddenPaths.includes('/cancel'))
  assert.equal(catalog.items.find(item => item.agent === 'claude')?.risk, false, 'Magpie does not flag Claude at the pin')
})

test('start → waiting → done: polls coalesce, done invalidates and audits a masked target', async () => {
  const h = await harness()
  try {
    const started = await h.start('copilot')
    assert.equal(started.state, 'waiting')
    assert.equal(started.url, 'https://github.com/login/device')
    assert.equal(started.code, 'ABCD-1234')
    assert.equal(started.completion, 'poll')
    assert.equal(started.pasteCallback, false)
    // two reads inside 300 ms → one kernel status call
    h.advance(SIGNIN_LIMITS.pollCoalesceMs + 1)
    await h.manager.status(started.id)
    await h.manager.status(started.id)
    assert.equal(h.kernel.count('GET', `/internal/signin/${started.id}`), 1)
    h.kernel.set(started.id, { state: 'done', user: 'octo.cat@example.test', plan: 'Pro', using: true })
    h.advance(SIGNIN_LIMITS.pollCoalesceMs + 1)
    const finished = await h.manager.status(started.id)
    assert.equal(finished.state, 'done')
    assert.equal(finished.user, 'octo.cat@example.test')
    assert.equal(finished.userMasked, 'oc•••••t@•••')
    assert.equal(finished.url, null, 'a finished flow no longer offers its page')
    assert.deepEqual(h.done, ['copilot'])
    const doneAudit = h.audits.find(([action]) => action === 'account-signin-done')
    assert.ok(doneAudit && !doneAudit[1].includes('octo.cat@example.test'), 'audit target is masked')
    // terminal: no more kernel reads
    const before = h.kernel.count('GET', '/internal/signin/')
    h.advance(10_000)
    await h.manager.status(started.id)
    assert.equal(h.kernel.count('GET', '/internal/signin/'), before)
  } finally { await h.close() }
})

test('ids this console did not start are 404, even when the kernel knows them', async () => {
  const h = await harness()
  try {
    const foreign = h.kernel.foreignFlow()
    await assert.rejects(h.manager.status(foreign), refused('signin_not_found', 404))
    await assert.rejects(h.manager.cancel(foreign), refused('signin_not_found', 404))
    await assert.rejects(h.manager.callback(foreign, 'http://localhost:1/callback?code=x'), refused('signin_not_found', 404))
    await assert.rejects(h.manager.status('../internal/accounts'), refused('signin_not_found', 404))
    assert.equal(h.kernel.count('GET', '/internal/signin/'), 0, 'the kernel is never asked about a foreign id')
  } finally { await h.close() }
})

test('guards: risk needs confirmation, host-exec agents are gated, sites are checked, unknown agents refused', async () => {
  const h = await harness()
  try {
    await assert.rejects(h.start('qoder'), refused('risk_unconfirmed', 409))
    assert.equal((await h.start('qoder', { confirmRisk: true })).state, 'waiting')
    for (const agent of ['cursor', 'grok', 'devin']) await assert.rejects(h.start(agent), refused('signin_gated', 403))
    await assert.rejects(h.start('kimi'), refused('agent_unsupported', 422))
    await assert.rejects(h.start('zcode'), refused('site_required', 400))
    await assert.rejects(h.start('zcode', { site: 'evil' }), refused('site_required', 400))
    await assert.rejects(h.start('copilot', { site: 'zai' }), refused('invalid_request', 400))
    await h.start('zcode', { site: 'bigmodel' })
    const sent = h.kernel.calls.filter(call => call.path === '/internal/signin')
    assert.deepEqual(sent.map(call => (call.body as { agent: string }).agent), ['qoder', 'zcode'], 'refused starts never reach the kernel')
    assert.deepEqual(sent[1].body, { agent: 'zcode', site: 'bigmodel' })
  } finally { await h.close() }
})

test('host exec: console switch alone is not enough while the kernel denies the agent', async () => {
  const h = await harness({ hostExec: true })
  try {
    await assert.rejects(h.start('cursor'), refused('signin_gated', 403))
    h.kernel.signinDeny = ['cursor', 'grok']
    h.kernel.installing.add('devin')
    const devin = await h.start('devin')
    assert.equal(devin.state, 'installing')
    assert.equal(devin.installing, 'Devin CLI')
    assert.equal(devin.url, null)
    // installing extends the deadline by 10 minutes once
    assert.equal(Date.parse(devin.deadline) - Date.parse(devin.startedAt), SIGNIN_LIMITS.waitMs + SIGNIN_LIMITS.installExtraMs)
  } finally { await h.close() }
})

test('one live sign-in per agent (the new one replaces it), three overall', async () => {
  const h = await harness()
  try {
    const first = await h.start('copilot')
    const second = await h.start('copilot')
    assert.notEqual(first.id, second.id)
    assert.equal((await h.manager.status(first.id)).state, 'canceled')
    assert.deepEqual(h.kernel.calls.filter(call => call.path === '/internal/signin/cancel').map(call => call.body), [{ id: first.id }])
    await h.start('workbuddy')
    await h.start('factory', { confirmRisk: true })
    await assert.rejects(h.start('mimo-app', { confirmRisk: true }), refused('signin_limit', 429))
    // replacing an agent's own flow is still allowed at the cap
    assert.equal((await h.start('workbuddy')).state, 'waiting')
  } finally { await h.close() }
})

test('deadline: past it (+30 s) the console cancels the kernel flow and reports a timeout', async () => {
  const h = await harness()
  try {
    const started = await h.start('qoder', { confirmRisk: true })
    assert.equal(Date.parse(started.deadline) - Date.parse(started.startedAt), SIGNIN_LIMITS.qoderWaitMs)
    h.advance(SIGNIN_LIMITS.qoderWaitMs + SIGNIN_LIMITS.graceMs + 1)
    const view = await h.manager.status(started.id)
    assert.equal(view.state, 'failed')
    assert.equal(view.errorCode, 'signin_timeout')
    assert.equal(view.error, '登录超时，请重新开始')
    assert.deepEqual(h.kernel.calls.filter(call => call.path === '/internal/signin/cancel').map(call => call.body), [{ id: started.id }])
    // finished entries are dropped after 15 minutes
    h.advance(SIGNIN_LIMITS.keepMs + 1)
    await h.manager.sweep()
    await assert.rejects(h.manager.status(started.id), refused('signin_not_found'))
  } finally { await h.close() }
})

test('kernel failures map to codes: port busy, disabled, outdated kernel', async () => {
  const h = await harness()
  try {
    h.kernel.nextStartError = { status: 400, code: 'rejected', error: 'port 1455, where ChatGPT sends the sign-in back, is busy; close any other Codex sign-in and try again' }
    await assert.rejects(h.start('codex'), refused('port_busy', 409))
    h.kernel.signinDeny = []
    h.kernel.nextStartError = { status: 400, code: 'agent_disabled', error: 'disabled' }
    await assert.rejects(h.start('copilot'), refused('signin_gated', 403))
    h.kernel.health = 'old'
    await assert.rejects(h.start('copilot'), refused('kernel_outdated', 501))
  } finally { await h.close() }
})

test('relay: one GET to the flow\'s own loopback listener; every other address is refused', async () => {
  const listener = await fakeListener()
  const h = await harness()
  try {
    h.kernel.listenerPort = listener.port
    const started = await h.start('claude')
    assert.equal(started.completion, 'relay')
    assert.equal(started.pasteCallback, true)
    const state = new URL(String(started.url)).searchParams.get('state')
    const good = `http://localhost:${listener.port}/callback?code=fixture-code&state=${state}`
    const bad: Array<[string, string]> = [
      [`http://evil.example:${listener.port}/callback?code=x&state=${state}`, 'callback_mismatch'],
      [`http://localhost:${listener.port + 1}/callback?code=x&state=${state}`, 'callback_mismatch'],
      [`http://localhost:${listener.port}/cancel?code=x&state=${state}`, 'callback_mismatch'],
      [`http://localhost:${listener.port}/auth/callback?code=x&state=${state}`, 'callback_mismatch'],
      [`http://localhost:${listener.port}/callback/../cancel?code=x`, 'callback_mismatch'],
      [`http://user:pw@localhost:${listener.port}/callback?code=x&state=${state}`, 'callback_mismatch'],
      [`https://localhost:${listener.port}/callback?code=x&state=${state}`, 'callback_mismatch'],
      [`http://localhost:${listener.port}/callback?state=${state}`, 'callback_no_code'],
      [`http://localhost:${listener.port}/callback?code=x&state=another`, 'callback_mismatch'],
      // the page's state must come back: an `error` return without it would end the flow on the listener
      [`http://localhost:${listener.port}/callback?code=x`, 'callback_mismatch'],
      [`http://localhost:${listener.port}/callback?error=access_denied`, 'callback_mismatch'],
      ['not a url', 'callback_mismatch'],
    ]
    for (const [url, code] of bad) await assert.rejects(h.manager.callback(started.id, url), refused(code), url)
    await assert.rejects(h.manager.callback(started.id, `${good}&pad=${'x'.repeat(SIGNIN_LIMITS.maxCallbackBytes)}`), refused('callback_too_large', 413))
    assert.equal(listener.requests.length, 0, 'nothing refused reaches the listener')

    const view = await h.manager.callback(started.id, good)
    assert.deepEqual(listener.requests, [`/callback?code=fixture-code&state=${state}`], 'exactly one GET, path and query as pasted')
    assert.equal(view.callbackLocked, true)
    await assert.rejects(h.manager.callback(started.id, good), refused('callback_locked', 409))
    assert.equal(listener.requests.length, 1)

    // audits and their details never carry the URL, code or state
    const text = JSON.stringify(h.audits)
    for (const secret of ['fixture-code', String(state), `:${listener.port}`]) assert.ok(!text.includes(secret), `audit leaked ${secret}`)
  } finally { await h.close(); await listener.close() }
})

test('relay: a flow that is no longer waiting, or a poll flow, takes no callback', async () => {
  const listener = await fakeListener()
  const h = await harness()
  try {
    h.kernel.listenerPort = listener.port
    const started = await h.start('codex')
    h.kernel.set(started.id, { state: 'failed', error: 'access_denied' })
    await assert.rejects(h.manager.callback(started.id, `http://localhost:${listener.port}/auth/callback?code=x`), refused('signin_not_waiting', 409))
    const poll = await h.start('copilot')
    await assert.rejects(h.manager.callback(poll.id, `http://localhost:${listener.port}/callback?code=x`), refused('callback_not_supported', 409))
    assert.equal(listener.requests.length, 0)
  } finally { await h.close(); await listener.close() }
})

test('relay: the listener refusing the address (wrong state on its side) is 422 and the input stays open', async () => {
  const listener = await fakeListener(() => ({ status: 400 }))
  const h = await harness()
  try {
    h.kernel.listenerPort = listener.port
    const started = await h.start('gemini')
    const state = new URL(String(started.url)).searchParams.get('state')
    await assert.rejects(h.manager.callback(started.id, `http://127.0.0.1:${listener.port}/oauth2callback?code=x&state=${state}`), refused('callback_rejected', 422))
    assert.equal(listener.requests.length, 1)
    assert.equal((await h.manager.status(started.id)).callbackLocked, false)
  } finally { await h.close(); await listener.close() }
})

test('kiro: the Builder ID hop relays without a code and hands the AWS page back as `next`', async () => {
  const listener = await fakeListener(() => ({ status: 302, location: 'https://oidc.us-east-1.amazonaws.com/authorize?client_id=x' }))
  const h = await harness()
  try {
    h.kernel.listenerPort = listener.port
    const started = await h.start('kiro')
    const state = new URL(String(started.url)).searchParams.get('state')
    const view = await h.manager.callback(started.id, `http://localhost:${listener.port}/signin/callback?login_option=builderid&issuer_url=x&idc_region=us-east-1&state=${state}`)
    assert.equal(view.next, 'https://oidc.us-east-1.amazonaws.com/authorize?client_id=x')
    assert.equal(view.callbackLocked, false, 'the AWS return is pasted next')
  } finally { await h.close(); await listener.close() }
})

test('dimagent: Magpie\'s own paste goes to the kernel callback, never to the relay', async () => {
  const listener = await fakeListener()
  const h = await harness()
  try {
    const started = await h.start('dimagent', { confirmRisk: true })
    assert.equal(started.completion, 'paste')
    await assert.rejects(h.manager.callback(started.id, 'http://127.0.0.1:54321/auth/callback?state=x'), refused('callback_no_code', 422))
    const view = await h.manager.callback(started.id, 'http://127.0.0.1:54321/auth/callback?code=fixture-dim&state=x')
    assert.equal(view.state, 'done')
    assert.equal(listener.requests.length, 0)
    assert.equal(h.kernel.calls.filter(call => call.path === '/internal/signin/callback').length, 2)
    assert.deepEqual(secretFindings(h.audits, ['fixture-dim']), [])
  } finally { await h.close(); await listener.close() }
})

test('cancel: idempotent, sends the kernel cancel once and audits it', async () => {
  const h = await harness()
  try {
    const started = await h.start('workbuddy')
    assert.equal((await h.manager.cancel(started.id)).state, 'canceled')
    assert.equal((await h.manager.cancel(started.id)).state, 'canceled')
    assert.equal(h.kernel.calls.filter(call => call.path === '/internal/signin/cancel').length, 1)
    assert.ok(h.audits.some(([action, , details]) => action === 'account-signin-cancel' && details === 'user'))
  } finally { await h.close() }
})

test('finished is final: a status read that left before a cancel cannot bring the flow back', async () => {
  const releases: Array<() => void> = []
  let hold = false
  const h = await harness({
    wrap: call => async (route, options) => {
      const reply = await call(route, options)
      // this read saw `waiting`; its answer arrives only after the cancel below
      if (hold && /^\/internal\/signin\/flow/.test(route)) await new Promise<void>((resolve) => { releases.push(resolve) })
      return reply
    },
  })
  try {
    const started = await h.start('copilot')
    hold = true
    h.advance(SIGNIN_LIMITS.pollCoalesceMs + 1)
    const late = h.manager.status(started.id)
    while (!releases.length) await new Promise(resolve => setTimeout(resolve, 5))
    hold = false
    assert.equal((await h.manager.cancel(started.id)).state, 'canceled')
    releases[0]()
    assert.equal((await late).state, 'canceled')
    assert.deepEqual(h.manager.live(), [], 'no live sign-in left to hold a slot or be attached to')
    assert.equal((await h.manager.status(started.id)).state, 'canceled')
    assert.deepEqual(h.done, [])
  } finally { await h.close() }
})

test('a kernel that answers the start with a finished flow ends it there (done hook, audit, swept later)', async () => {
  const h = await harness({
    wrap: call => async (route, options) => {
      const reply = await call(route, options)
      if (route === '/internal/signin' && reply.body && typeof reply.body === 'object') {
        return { ...reply, body: { ...reply.body, state: 'done', user: 'fast.one@example.test', using: true } }
      }
      return reply
    },
  })
  try {
    const started = await h.start('copilot')
    assert.equal(started.state, 'done')
    assert.deepEqual(h.done, ['copilot'])
    assert.ok(h.audits.some(([action]) => action === 'account-signin-done'))
    h.advance(SIGNIN_LIMITS.keepMs + 1)
    await h.manager.sweep()
    await assert.rejects(h.manager.status(started.id), refused('signin_not_found', 404))
  } finally { await h.close() }
})
