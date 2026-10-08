import { testDataDir } from './testDataDir.js'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import { createServer, request, type IncomingMessage, type Server } from 'node:http'
import { connect } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { hashKey } from './cpa.js'
import { db } from './db.js'
import { setKeyRtkCompress, setRelayEnabled } from './rtkRelay.js'
import { readRelayStatus } from './rtkRelayConfig.js'
import { relayTallies } from './rtkRelayLedger.js'

/** The relay as its own process (server/rtkRelayMain.ts) against this test's console database. */
const REPO = new URL('../', import.meta.url).pathname
const payload = (model: string) => JSON.stringify({ model, messages: [{ role: 'tool', content: 'diagnostic repeated line\n'.repeat(500) }] })

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
async function until(check: () => boolean, what: string, ms = 15_000) {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}
function relay(env: Record<string, string>, dataDir = testDataDir): ChildProcess & { output: () => string } {
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/rtkRelayMain.ts'], {
    cwd: REPO,
    env: { ...process.env, DATA_DIR: dataDir, RTK_RELAY_PORT: '', RTK_RELAY_TARGET: '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout!.on('data', (chunk) => { output += chunk })
  child.stderr!.on('data', (chunk) => { output += chunk })
  return Object.assign(child, { output: () => output })
}
const exited = async (child: ChildProcess) => child.exitCode ?? (await once(child, 'exit'))[0] as number | null
const refused = (port: number) => new Promise<boolean>((resolve) => {
  const socket = connect(port, '127.0.0.1')
  socket.once('connect', () => { socket.destroy(); resolve(false) })
  socket.once('error', (error: NodeJS.ErrnoException) => resolve(error.code === 'ECONNREFUSED'))
})

test('SIGTERM drains: new connections are refused at once, an open SSE stream completes, the ledger is written', async (t) => {
  const now = new Date().toISOString()
  for (const [value, name] of [['sk-relay-proc-on', 'on'], ['sk-relay-proc-off', 'off']]) {
    db.prepare(`INSERT INTO api_keys (key_hash,key_value,name,note,enabled,groups_json,total_concurrency,group_concurrency_json,created_at,updated_at)
      VALUES (?,?,?,'',1,'["g"]',0,'{}',?,?)`).run(hashKey(value), value, name, now, now)
  }
  setKeyRtkCompress(hashKey('sk-relay-proc-on'), 'on', true)

  const bodies: string[] = []
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  const guard = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    bodies.push(body)
    if (!body.includes('"model":"hold"')) return void res.writeHead(200, { 'content-type': 'application/json' }).end('{"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}]}')
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('event: message_start\ndata: {"type":"message_start"}\n\n')
    await held
    res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n')
  })
  const guardPort = await listen(guard)
  const port = await freePort()
  const child = relay({ RTK_RELAY_PORT: String(port), RTK_RELAY_TARGET: `http://127.0.0.1:${guardPort}` })
  t.after(() => { child.kill('SIGKILL'); release(); guard.closeAllConnections(); guard.close() })
  await until(() => readRelayStatus(testDataDir)?.state === 'listening' && readRelayStatus(testDataDir)?.pid === child.pid, 'relay listening')

  const post = async (key: string, model: string) => {
    const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key }, body: payload(model) })
    await response.text()
    return bodies.at(-1)!
  }
  assert.equal(await post('sk-relay-proc-off', 'm'), payload('m'), 'not opted in')
  setRelayEnabled(false)
  assert.equal(await post('sk-relay-proc-on', 'm'), payload('m'), 'global switch off')
  setRelayEnabled(true)

  const stream = await new Promise<IncomingMessage>((resolve, reject) => {
    request(`http://127.0.0.1:${port}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'sk-relay-proc-on' } }, resolve)
      .on('error', reject).end(payload('hold'))
  })
  let received = ''
  stream.setEncoding('utf8')
  stream.on('data', (chunk) => { received += chunk })
  await until(() => received.includes('message_start'), 'first SSE event')
  assert.match(bodies.at(-1)!, /\[RTK identical line: 500 times\]/, 'opted in: compressed before the guard')

  child.kill('SIGTERM')
  await until(() => readRelayStatus(testDataDir)?.state === 'draining', 'draining reported', 5_000)
  assert.equal(await refused(port), true, 'the listener is closed while the stream is still open')
  assert.equal(readRelayStatus(testDataDir)?.inFlight, 1)
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal(child.exitCode, null, 'still draining')

  const ended = once(stream, 'end')
  release()
  await ended
  assert.match(received, /message_start[\s\S]*message_stop/)
  assert.equal(await exited(child), 0)
  assert.equal(readRelayStatus(testDataDir)?.state, 'stopped')
  const { today } = relayTallies(db)
  assert.equal(today.requests, 1)
  assert.ok(today.savedTokens > 0)
  assert.match(child.output(), /rtk_relay_draining[\s\S]*rtk_relay_stopped/)
  assert.doesNotMatch(child.output(), /sk-relay-proc|diagnostic repeated line/, 'no keys or bodies in the log')
})

test('a port in use fails the process (systemd restarts it) and reports the code', async () => {
  const blocker = createServer()
  const port = await listen(blocker)
  try {
    const child = relay({ RTK_RELAY_PORT: String(port) })
    assert.equal(await exited(child), 1)
    assert.deepEqual({ state: readRelayStatus(testDataDir)?.state, error: readRelayStatus(testDataDir)?.error }, { state: 'failed', error: 'EADDRINUSE' })
  } finally { blocker.close() }
})

test('without RTK_RELAY_PORT the process exits cleanly; a bad target or a missing database is a failure', async () => {
  const off = relay({})
  assert.equal(await exited(off), 0)
  assert.equal(readRelayStatus(testDataDir)?.state, 'off')

  const bad = relay({ RTK_RELAY_PORT: String(await freePort()), RTK_RELAY_TARGET: 'http://198.51.100.1:8316' })
  assert.notEqual(await exited(bad), 0)
  assert.match(bad.output(), /RTK_RELAY_TARGET/)

  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'crosery-relay-nodb-'))
  try {
    const missing = relay({ RTK_RELAY_PORT: String(await freePort()) }, empty)
    assert.equal(await exited(missing), 1)
    assert.equal(readRelayStatus(empty)?.error, 'no_console_database')
  } finally { fs.rmSync(empty, { recursive: true, force: true }) }
})
