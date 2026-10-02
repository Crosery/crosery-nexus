import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { FakeKernel, secretFindings } from './testing/fakeKernel.js'

/**
 * The real console process (server/index.ts) in both engine modes: what GET /api/monitor, /api/accounts and
 * /api/channels send to a browser must not carry a token, cookie, key or proxy password, and the retired
 * local OAuth simulator answers 410 only in magpie + local (CPA mode keeps its OAuth routes).
 */

const REPO = new URL('../', import.meta.url).pathname
const SECRETS = ['fixture-access-0001', 'fixture-refresh-0002', 'fixture-id-0003', 'fixture-cookie-0004', 'fixture-key-0005', 'proxy-pass-0006',
  'fixture-access-token-should-never-leave']
const credential = (name: string, type: string) => ({
  name, type, provider: type, email: `${type}.owner@example.test`, status: 'active', disabled: false, auth_index: `${type}-1`,
  proxy_url: 'http://user:proxy-pass-0006@proxy.example:7890',
  access_token: 'fixture-access-0001', refresh_token: 'fixture-refresh-0002', id_token: 'fixture-id-0003',
  cookie: 'fixture-cookie-0004', 'api-key': 'fixture-key-0005', metadata: { refresh_token: 'fixture-refresh-0002' },
})

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address ? address.port : 0
      probe.close(() => (port ? resolve(port) : reject(new Error('no free port'))))
    })
  })
}

async function launch(env: Record<string, string>) {
  const port = await freePort()
  const dataDir = env.DATA_DIR
  const child: ChildProcess = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: REPO,
    env: {
      PATH: process.env.PATH ?? '', HOME: dataDir, TMPDIR: os.tmpdir(),
      PORT: String(port), HOST: '127.0.0.1', CONSOLE_USERNAME: 'admin', CONSOLE_PASSWORD: 'accounts-e2e-password',
      SESSION_SECRET: 'accounts-e2e-session-secret', COOKIE_SECURE: 'false', NATIVE_RESPONSES_ENABLED: 'false', ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  child.stdout?.on('data', chunk => { log += chunk })
  child.stderr?.on('data', chunk => { log += chunk })
  const base = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 40_000
  for (;;) {
    if (child.exitCode !== null) throw new Error(`console exited early (${child.exitCode})`)
    try { if ((await fetch(`${base}/api/session`)).status < 500) break } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error('console did not start in 40 s')
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'accounts-e2e-password' }) })
  assert.equal(login.status, 200)
  const cookie = String(login.headers.get('set-cookie') || '').split(';')[0]
  const send = async (method: string, route: string, body?: unknown) => {
    const response = await fetch(`${base}${route}`, { method, headers: { cookie, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    const text = await response.text()
    let json: Record<string, any> = {}
    try { json = JSON.parse(text) } catch { /* not JSON */ }
    return { status: response.status, body: json, text }
  }
  return {
    send,
    log: () => log,
    stop: async () => {
      child.kill('SIGTERM')
      if (child.exitCode === null) await once(child, 'exit')
    },
  }
}

test('CPA mode: /api/monitor projects gateway records; OAuth start still goes to CPA; /api/accounts says cpa', { timeout: 120_000 }, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cac-acc-cpa-'))
  const cpaCalls: string[] = []
  const cpa = createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://cpa')
    cpaCalls.push(`${req.method} ${url.pathname}`)
    const json = (status: number, value: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)) }
    req.resume()
    if (url.pathname === '/v0/management/auth-files') return json(200, { files: [credential('codex-a.json', 'codex'), credential('claude-a.json', 'claude')] })
    if (url.pathname === '/v0/management/api-call') return json(500, { error: 'upstream refused Bearer fixture-access-0001' })
    if (url.pathname === '/v0/management/usage-queue') return json(200, [])
    if (url.pathname === '/v0/management/codex-auth-url') return json(200, { status: 'ok', url: 'https://auth.openai.com/oauth/authorize?x=1', state: 'cpa-state-1' })
    return json(200, {})
  })
  cpa.listen(0, '127.0.0.1')
  await once(cpa, 'listening')
  const address = cpa.address()
  const app = await launch({
    DATA_DIR: dataDir, GATEWAY_ENGINE: 'cpa', CPA_BASE_URL: `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`,
    CPA_MANAGEMENT_KEY: 'e2e-management-key',
  })
  try {
    const monitor = await app.send('GET', '/api/monitor')
    assert.equal(monitor.status, 200, app.log())
    assert.equal(monitor.body.accounts.length, 2)
    assert.deepEqual(secretFindings(monitor.body, SECRETS), [])
    assert.equal(monitor.body.accounts[0].email, 'codex.owner@example.test')
    assert.equal(monitor.body.accounts[0].proxy_url, 'http://***@proxy.example:7890')

    const accounts = await app.send('GET', '/api/accounts')
    assert.deepEqual([accounts.status, accounts.body.backend], [200, 'cpa'])
    const start = await app.send('POST', '/api/cpa/oauth/start', { provider: 'codex' })
    assert.equal(start.status, 200, 'CPA mode keeps its OAuth start')
    assert.equal(start.body.state, 'cpa-state-1')
    assert.ok(cpaCalls.includes('GET /v0/management/codex-auth-url'))
  } finally {
    await app.stop()
    cpa.close()
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

test('magpie + local: monitor, channels and accounts carry no credential; the simulator is 410; oauthConnected follows Magpie', { timeout: 120_000 }, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cac-acc-mag-'))
  fs.mkdirSync(path.join(dataDir, 'auth-files'), { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(dataDir, 'auth-files', 'codex-a.json'), JSON.stringify(credential('codex-a.json', 'codex')), { mode: 0o600 })
  const kernel = await new FakeKernel().start()
  kernel.logins = [{ agent: 'codex', user: 'kernel.user@example.test', plan: 'Plus', active: true }]
  const app = await launch({
    DATA_DIR: dataDir, GATEWAY_ENGINE: 'magpie', MAGPIE_CONTROL_PLANE: 'local', MAGPIE_PORT: String(await freePort()),
    MAGPIE_KERNEL_SOCKET: kernel.socket, CPA_BASE_URL: 'http://127.0.0.1:9',
  })
  try {
    for (const route of ['/api/monitor', '/api/channels', '/api/accounts', '/api/accounts/catalog']) {
      const response = await app.send('GET', route)
      assert.equal(response.status, 200, `${route}: ${response.text.slice(0, 200)}`)
      assert.deepEqual(secretFindings(response.body, SECRETS), [], route)
    }
    const accounts = await app.send('GET', '/api/accounts')
    assert.equal(accounts.body.backend, 'magpie')
    assert.equal(accounts.body.providers[0].accounts[0].userMasked, 'ke••••••r@•••')

    const start = await app.send('POST', '/api/cpa/oauth/start', { provider: 'codex' })
    assert.deepEqual([start.status, start.body.code], [410, 'use_accounts_signin'])
    const callback = await app.send('POST', '/api/cpa/oauth/callback', { provider: 'codex', redirectUrl: 'http://localhost:1455/auth/callback?code=x&state=y', state: 'y' })
    assert.equal(callback.status, 410)
    assert.equal((await app.send('GET', '/api/cpa/oauth/status?state=y')).status, 404)
    assert.deepEqual(fs.readdirSync(path.join(dataDir, 'auth-files')), ['codex-a.json'], 'no fabricated credential was written')

    const version = await app.send('GET', '/api/version')
    assert.equal(version.status, 200)
    assert.equal(version.body.cpa?.upstream?.oauthConnected, true, 'a Magpie login that is on counts as connected')
  } finally {
    await app.stop()
    await kernel.stop()
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})
