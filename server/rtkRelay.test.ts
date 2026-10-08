import { testDataDir } from './testDataDir.js'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer, type Server } from 'node:http'
import path from 'node:path'
import test from 'node:test'
import { hashKey } from './cpa.js'
import { db } from './db.js'
import { parseRtkCompress, rtkRelayStatus, setKeyRtkCompress, setRelayEnabled, startRtkRelay, type RtkRelayHandle } from './rtkRelay.js'

const databaseFile = path.join(testDataDir, 'console.db')
const payload = JSON.stringify({ messages: [{ role: 'tool', content: 'diagnostic repeated line\n'.repeat(500) }] })

async function freePort() {
  const probe = createServer()
  probe.listen(0, '127.0.0.1')
  await once(probe, 'listening')
  const { port } = probe.address() as { port: number }
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  return port
}
async function until(check: () => boolean, what: string, ms = 10_000) {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}
function seedKey(value: string, name: string) {
  const now = new Date().toISOString()
  db.prepare(`INSERT INTO api_keys (key_hash,key_value,name,note,enabled,groups_json,total_concurrency,group_concurrency_json,created_at,updated_at)
    VALUES (?,?,?,'',1,'["g"]',0,'{}',?,?)`).run(hashKey(value), value, name, now, now)
}

test('rtkCompress input: boolean or absent only', () => {
  assert.equal(parseRtkCompress(undefined), undefined)
  assert.equal(parseRtkCompress(true), true)
  assert.equal(parseRtkCompress(false), false)
  for (const bad of ['true', 1, null, {}]) assert.throws(() => parseRtkCompress(bad), /rtkCompress/)
})

test('the relay thread compresses only opted-in keys, honours the global switch and records into the ledger', async (t) => {
  const bodies: string[] = []
  const guard = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    bodies.push(body)
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}]}')
  })
  guard.listen(0, '127.0.0.1')
  await once(guard, 'listening')
  const port = await freePort()
  const relay = startRtkRelay({ port, target: `http://127.0.0.1:${(guard.address() as { port: number }).port}`, databaseFile })
  t.after(async () => { await relay.close(); guard.closeAllConnections(); guard.close() })
  seedKey('sk-relay-on', 'on')
  seedKey('sk-relay-off', 'off')
  setKeyRtkCompress(hashKey('sk-relay-on'), 'on', true)
  await until(() => relay.listener().state === 'listening', 'relay listening')
  assert.equal(rtkRelayStatus().listener.state, 'listening')
  assert.equal(rtkRelayStatus().optedInKeys, 1)

  const send = async (key: string) => {
    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: payload })
    assert.equal(response.status, 200)
    await response.text()
    return bodies.at(-1)!
  }
  assert.equal(await send('sk-relay-off'), payload)
  const compressed = await send('sk-relay-on')
  assert.ok(compressed.length < payload.length)
  assert.match(compressed, /\[RTK identical line: 500 times\]/)
  await until(() => rtkRelayStatus().today.requests === 1, 'ledger row')
  assert.ok(rtkRelayStatus().today.savedTokens > 0)

  setRelayEnabled(false)
  assert.equal(await send('sk-relay-on'), payload, 'global switch off: forwarded unchanged')
  setRelayEnabled(true)
  setKeyRtkCompress(hashKey('sk-relay-on'), 'on', false)
  assert.equal(await send('sk-relay-on'), payload, 'key switched off: forwarded unchanged')
  assert.equal(rtkRelayStatus().total.requests, 1)
  const audits = db.prepare("SELECT action, details FROM audit_log WHERE action IN ('toggle_rtk_relay', 'set_key_rtk_compress') ORDER BY id").all()
  assert.deepEqual(audits.map((row) => ({ ...row })), [
    { action: 'set_key_rtk_compress', details: 'rtkCompress=true' },
    { action: 'toggle_rtk_relay', details: 'enabled=false' },
    { action: 'toggle_rtk_relay', details: 'enabled=true' },
    { action: 'set_key_rtk_compress', details: 'rtkCompress=false' },
  ])
})

test('a port in use leaves the console up, reports the failure and binds once the port frees', async (t) => {
  const blocker: Server = createServer()
  blocker.listen(0, '127.0.0.1')
  await once(blocker, 'listening')
  const port = (blocker.address() as { port: number }).port
  let relay: RtkRelayHandle | undefined
  t.after(async () => { await relay?.close(); blocker.close() })
  relay = startRtkRelay({ port, target: 'http://127.0.0.1:9', databaseFile })
  await until(() => relay!.listener().state === 'failed', 'bind failure reported')
  assert.equal(relay.listener().error, 'EADDRINUSE')
  await new Promise<void>((resolve) => blocker.close(() => resolve()))
  await until(() => relay!.listener().state === 'listening', 'relay restarted after backoff')
  assert.equal(relay.listener().error, '')
})

test('port 0 starts nothing', async () => {
  const relay = startRtkRelay({ port: 0, target: '', databaseFile })
  assert.equal(relay.listener().state, 'off')
  await relay.close()
})
