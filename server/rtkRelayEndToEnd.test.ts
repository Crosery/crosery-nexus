import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import fs from 'node:fs'
import { createServer, type Server } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

/**
 * End to end with both processes on one DATA_DIR: the console (`server/index.ts`) stores the key opt-in and the
 * global switch and reports status; the relay (`server/rtkRelayMain.ts`) compresses, writes the ledger and its
 * status file. Local CPA and guard stubs, temporary DATA_DIR.
 */
const REPO = new URL('../', import.meta.url).pathname
const payload = JSON.stringify({ messages: [{ role: 'tool', content: 'diagnostic repeated line\n'.repeat(500) }] })

async function listen(server: Server) {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return (server.address() as { port: number }).port
}
async function freePort() {
  const probe = createServer()
  const port = await listen(probe)
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  return port
}
async function until<T>(read: () => Promise<T>, ok: (value: T) => boolean, what: string, ms = 25_000): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    try {
      const value = await read()
      if (ok(value)) return value
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`timed out: ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
}

function start(entry: string, env: Record<string, string>, dataDir: string): ChildProcess {
  return spawn(process.execPath, ['--import', 'tsx', entry], {
    cwd: REPO,
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      HOST: '127.0.0.1',
      CPA_MANAGEMENT_KEY: 'test-management-key',
      CONSOLE_USERNAME: 'admin',
      CONSOLE_PASSWORD: 'test-password',
      SESSION_SECRET: 'test-session-secret',
      COOKIE_SECURE: 'false',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

test('an invalid RTK_RELAY_TARGET stops startup instead of relaying elsewhere', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crosery-rtk-e2e-'))
  try {
    const child = start('server/index.ts', { PORT: String(await freePort()), RTK_RELAY_PORT: String(await freePort()), RTK_RELAY_TARGET: 'http://192.0.2.10:8316' }, dataDir)
    let stderr = ''
    child.stderr!.on('data', (chunk) => { stderr += chunk })
    const [code] = await once(child, 'exit')
    assert.notEqual(code, 0)
    assert.match(stderr, /RTK_RELAY_TARGET/)
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }) }
})

test('console API switches what the relay process compresses and reports what it wrote', async (t) => {
  const cpa = createServer((req, res) => {
    req.resume()
    res.setHeader('content-type', 'application/json')
    res.end(req.url?.startsWith('/api-keys') && req.method !== 'PUT' ? '{"api-keys":[]}' : '{}')
  })
  const bodies: string[] = []
  const guard = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    bodies.push(body)
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
  })
  const cpaPort = await listen(cpa)
  const guardPort = await listen(guard)
  const port = await freePort()
  const relayPort = await freePort()
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crosery-rtk-e2e-'))
  const relayEnv = { PORT: String(port), RTK_RELAY_PORT: String(relayPort), RTK_RELAY_TARGET: `http://127.0.0.1:${guardPort}` }
  const child = start('server/index.ts', { ...relayEnv, CPA_BASE_URL: `http://127.0.0.1:${cpaPort}` }, dataDir)
  let relay: ChildProcess | undefined
  t.after(async () => {
    relay?.kill('SIGKILL')
    child.kill('SIGTERM')
    await new Promise((resolve) => setTimeout(resolve, 300))
    if (child.exitCode === null) child.kill('SIGKILL')
    cpa.closeAllConnections(); cpa.close()
    guard.closeAllConnections(); guard.close()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })
  const base = `http://127.0.0.1:${port}`
  await until(() => fetch(`${base}/api/session`), (res) => res.status < 500, 'console ready')
  assert.equal((await fetch(`${base}/api/rtk/relay`)).status, 401, 'admin only')
  const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'test-password' }) })
  assert.equal(login.status, 200)
  const auth = { 'content-type': 'application/json', cookie: (login.headers.get('set-cookie') ?? '').split(';')[0]! }
  const status = () => fetch(`${base}/api/rtk/relay`, { headers: auth }).then((res) => res.json())

  const value = 'sk-rtk-e2e-key'
  const id = createHash('sha256').update(value).digest('hex')
  const database = new DatabaseSync(path.join(dataDir, 'console.db'))
  const now = new Date().toISOString()
  database.prepare(`INSERT INTO api_keys (key_hash,key_value,name,note,enabled,groups_json,total_concurrency,group_concurrency_json,created_at,updated_at)
    VALUES (?,?,'rtk-e2e','',1,'["g1"]',0,'{}',?,?)`).run(id, value, now, now)
  database.close()

  assert.equal((await status()).listener.state, 'down', 'expected by this host env, not running yet')
  relay = start('server/rtkRelayMain.ts', relayEnv, dataDir)
  const listening = await until(status, (body) => body.listener?.state === 'listening', 'relay listening')
  assert.deepEqual({ enabled: listening.enabled, port: listening.listener.port, optedInKeys: listening.optedInKeys },
    { enabled: true, port: relayPort, optedInKeys: 0 })

  const send = async () => {
    const response = await fetch(`http://127.0.0.1:${relayPort}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${value}` }, body: payload })
    assert.equal(response.status, 200)
    await response.text()
    return bodies.at(-1)!
  }
  assert.equal(await send(), payload, 'not opted in yet')

  const patch = (body: unknown) => fetch(`${base}/api/keys/${id}`, { method: 'PATCH', headers: auth, body: JSON.stringify(body) })
  assert.equal((await patch({ rtkCompress: 'yes' })).status, 400)
  const saved = await patch({ rtkCompress: true })
  assert.equal(saved.status, 200)
  assert.equal(((await saved.json()) as { item: { rtkCompress: boolean } }).item.rtkCompress, true)

  assert.match(await send(), /\[RTK identical line: 500 times\]/)

  assert.equal((await fetch(`${base}/api/rtk/relay`, { method: 'POST', headers: auth, body: JSON.stringify({ enabled: 'no' }) })).status, 400)
  const off = await fetch(`${base}/api/rtk/relay`, { method: 'POST', headers: auth, body: JSON.stringify({ enabled: false }) })
  assert.equal(((await off.json()) as { enabled: boolean }).enabled, false)
  assert.equal(await send(), payload, 'global switch off')

  // The relay flushes its ledger every 10 s and on exit; a stop makes the write immediate.
  relay.kill('SIGTERM')
  await once(relay, 'exit')
  const stopped = await status()
  assert.equal(stopped.listener.state, 'stopped')
  assert.equal(stopped.today.requests, 1)
  assert.ok(stopped.today.savedTokens > 0)
  assert.equal(stopped.optedInKeys, 1)
})
