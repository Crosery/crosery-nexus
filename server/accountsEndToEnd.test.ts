import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { secretFindings } from './testing/secretFindings.js'

/**
 * The real console process (server/index.ts): what GET /api/monitor and /api/accounts send to a browser must not
 * carry a token, cookie, key or proxy password; and a data dir and environment an older release left Magpie state
 * in (the retired gateway kernel) start a console that serves CPA and ignores that state.
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

async function fakeCpa() {
  const calls: string[] = []
  const cpa = createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://cpa')
    calls.push(`${req.method} ${url.pathname}`)
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
  return { calls, baseUrl: `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`, close: () => cpa.close() }
}

test('/api/monitor projects gateway records; OAuth start goes to CPA; /api/accounts says cpa', { timeout: 120_000 }, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cac-acc-cpa-'))
  const cpa = await fakeCpa()
  const app = await launch({ DATA_DIR: dataDir, CPA_BASE_URL: cpa.baseUrl, CPA_MANAGEMENT_KEY: 'e2e-management-key' })
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
    assert.equal(start.status, 200)
    assert.equal(start.body.state, 'cpa-state-1')
    assert.ok(cpa.calls.includes('GET /v0/management/codex-auth-url'))
  } finally {
    await app.stop()
    cpa.close()
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

test('Magpie leftovers in the environment, the data dir and the database: the console starts, serves CPA and ignores them', { timeout: 120_000 }, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cac-acc-leftover-'))
  const put = (file: string, value: unknown) => {
    fs.mkdirSync(path.dirname(path.join(dataDir, file)), { recursive: true })
    fs.writeFileSync(path.join(dataDir, file), typeof value === 'string' ? value : JSON.stringify(value))
  }
  put('kernels/magpie.json', { kernel: 'magpie', role: 'standby', current: { revision: 'abc1234' } })
  put('kernel-autoupdate.json', { version: 1, cpa: { enabled: true }, magpie: { enabled: true } })
  put('kernel-requests/rollback-magpie.json', { confirm: true, at: '2026-10-01T08:00:00Z', to: 'abc1234' })
  put('magpie-upstream/autoupdate.json', { version: 1, magpie: { enabled: true }, rtk: { enabled: true } })
  put('magpie-upstream/status.json', { revision: 'abc1234' })
  // HOME is the data dir here: the runtime dir older releases kept under ~/.agents/crosery
  put('.agents/crosery/magpie-upstream/autoupdate.json', { version: 1, magpie: { enabled: false }, rtk: { enabled: false } })
  put('magpie-channels.json', [{ name: 'old', 'base-url': 'https://upstream.example/v1', models: [] }])
  put('auth-files/codex-a.json', credential('codex-a.json', 'codex'))
  put('auth-files-meta.json', { 'codex-a.json': { disabled: false } })
  put('magpie-kernel.sock', '')
  put('proxy/pool.json', {
    version: 1, entries: [], subscriptions: [],
    links: { 'magpie:codex:kernel.user@example.test': { entryId: 'px_aaaaaaaaaa', provider: 'codex' } },
    observed: {
      'magpie:codex:kernel.user@example.test': { mode: 'url', masked: 'http://***@proxy.example:7890', at: '2026-10-01T08:00:00Z' },
      'cpa:codex-a.json': { mode: 'inherit', masked: null, at: '2026-10-01T08:00:00Z' },
    },
  })
  const seeded = new DatabaseSync(path.join(dataDir, 'console.db'))
  seeded.exec("CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT NOT NULL, target TEXT NOT NULL, details TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL)")
  seeded.prepare('INSERT INTO audit_log (action, target, details, created_at) VALUES (?, ?, ?, ?)').run('magpie_update', 'apply', 'exit=0', '2026-10-01T08:00:00Z')
  seeded.close()
  const cpa = await fakeCpa()
  const app = await launch({
    DATA_DIR: dataDir, CPA_BASE_URL: cpa.baseUrl, CPA_MANAGEMENT_KEY: 'e2e-management-key',
    GATEWAY_ENGINE: 'magpie', MAGPIE_CONTROL_PLANE: 'local', MAGPIE_PORT: '8790', MAGPIE_KERNEL_SOCKET: path.join(dataDir, 'magpie-kernel.sock'),
    MAGPIE_CHANNELS_FILE: path.join(dataDir, 'magpie-channels.json'), MAGPIE_TIMEOUT_MS: 'not-a-number',
  })
  try {
    const monitor = await app.send('GET', '/api/monitor')
    assert.equal(monitor.status, 200, app.log())
    assert.equal(monitor.body.accounts.length, 2, 'accounts come from CPA, not the local auth-files dir')
    assert.deepEqual(secretFindings(monitor.body, SECRETS), [])
    const accounts = await app.send('GET', '/api/accounts')
    assert.deepEqual([accounts.status, accounts.body.backend], [200, 'cpa'])
    const start = await app.send('POST', '/api/cpa/oauth/start', { provider: 'codex' })
    assert.deepEqual([start.status, start.body.state], [200, 'cpa-state-1'], 'GATEWAY_ENGINE=magpie no longer retires the CPA sign-in')

    const version = await app.send('GET', '/api/version')
    assert.equal(version.status, 200, version.text)
    assert.equal('engine' in version.body.cpa, false)
    const auto = await app.send('GET', '/api/autoupdate')
    assert.deepEqual([auto.status, Object.keys(auto.body)], [200, ['rtk']])
    assert.equal(auto.body.rtk.enabled, true, 'the switch lives in the rtk state dir, not the retired one')
    const kernels = await app.send('GET', '/api/kernels')
    assert.equal(kernels.status, 200)
    assert.ok(kernels.body.kernels.every((kernel: { id: string }) => kernel.id === 'cpa'))
    const egress = await app.send('GET', '/api/proxies/egress')
    assert.equal(egress.status, 200, egress.text)
    assert.deepEqual(Object.keys(egress.body.accounts), ['cpa:codex-a.json'])
    for (const route of ['/api/gateway/settings', '/api/magpie/update-status']) assert.equal((await app.send('GET', route)).status, 404, route)
    const audit = await app.send('GET', '/api/audit')
    assert.ok(audit.body.items.some((item: { action: string }) => item.action === 'magpie_update'), 'history stays readable')

    for (const file of ['kernels/magpie.json', 'magpie-upstream/autoupdate.json', 'magpie-channels.json', 'auth-files/codex-a.json']) {
      assert.ok(fs.existsSync(path.join(dataDir, file)), `${file} is left alone`)
    }
    assert.match(fs.readFileSync(path.join(dataDir, 'proxy/pool.json'), 'utf8'), /magpie:codex:/, 'reading the pool does not rewrite it')
  } finally {
    await app.stop()
    cpa.close()
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})
