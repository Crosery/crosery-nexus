import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { Agent, createServer, request, type IncomingMessage, type Server } from 'node:http'
import { connect } from 'node:net'
import test from 'node:test'
import { createRelayCompressionProxy, MAX_BODY_BYTES, relayTarget, type RelayDependencies } from './relayCompressionProxy.js'
import { compressRequestToolOutputs } from './toolCompress.js'

async function listen(server: Server) {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`
}
async function close(server: Server) {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
}
const within = <T>(promise: Promise<T>, ms: number, what: string) => Promise.race([
  promise,
  new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`timed out: ${what}`)), ms).unref()),
])
const headers = { 'content-type': 'application/json', authorization: 'Bearer smoke' }
const payload = JSON.stringify({ messages: [{ role: 'tool', content: 'diagnostic repeated line\n'.repeat(500) }] })
const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex')

type Seen = { method: string; url: string; rawHeaders: string[]; headers: IncomingMessage['headers']; body: Buffer }
/** Upstream that records each complete request and answers with `respond` (default: 200 JSON with the byte count). */
async function recordingUpstream(respond?: (req: IncomingMessage, res: import('node:http').ServerResponse, seen: Seen) => void) {
  const seen: Seen[] = []
  const state = { aborted: 0 }
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    try {
      for await (const chunk of req) chunks.push(chunk)
    } catch {
      state.aborted++
      return
    }
    const entry = { method: req.method!, url: req.url!, rawHeaders: req.rawHeaders, headers: req.headers, body: Buffer.concat(chunks) }
    seen.push(entry)
    if (respond) return respond(req, res, entry)
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ bytes: entry.body.length }))
  })
  return { server, seen, state, base: await listen(server) }
}
function relay(target: string, overrides: Partial<RelayDependencies> = {}) {
  const calls = { saved: [] as number[], failed: [] as string[] }
  const server = createRelayCompressionProxy({
    target,
    optedIn: (token) => token === 'on',
    compress: (body) => compressRequestToolOutputs(body).saved,
    saved: (tokens) => calls.saved.push(tokens),
    failed: (stage) => calls.failed.push(stage),
    ...overrides,
  })
  return { server, calls }
}
const completeChat = '{"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}]}'

test('target must be a loopback HTTP origin', () => {
  for (const ok of ['http://127.0.0.1:8316', 'http://127.0.0.1:8316/', 'http://[::1]:8316', 'http://localhost:8316']) {
    assert.equal(relayTarget(ok).protocol, 'http:', ok)
  }
  for (const bad of ['https://127.0.0.1:8316', 'http://198.51.100.1:8316', 'http://example.test', 'http://user:pw@127.0.0.1:8316',
    'http://127.0.0.1:8316/v1', 'http://127.0.0.1:8316/?x=1', 'http://127.0.0.1:8316/#h', 'not a url', '']) {
    assert.throws(() => relayTarget(bad), /RTK_RELAY_TARGET/, bad)
    assert.throws(() => createRelayCompressionProxy({ target: bad, optedIn: () => false, compress: () => 0, saved: () => {}, failed: () => {} }))
  }
})

test('pass-through keeps method, path, body bytes, raw headers and the response unchanged, minus hop-by-hop fields', async () => {
  const upstream = await recordingUpstream((_req, res) => {
    res.writeHead(418, 'Custom Reason', [
      'Content-Type', 'application/json', 'X-Upstream', 'kept', 'Set-Cookie', 'a=1', 'Set-Cookie', 'b=2',
      'Connection', 'x-secret-hop', 'X-Secret-Hop', 'dropped',
    ]).end('{"error":{"code":"teapot"}}')
  })
  const { server, calls } = relay(upstream.base)
  const base = await listen(server)
  try {
    const body = Buffer.from('{"model":"m","input":"\\u00e9 raw  spacing"}')
    const response = await new Promise<{ status: number; message: string; rawHeaders: string[]; body: string }>((resolve, reject) => {
      const req = request(`${base}/v1/responses?beta=true`, {
        method: 'POST',
        headers: [
          'Host', 'relay.test', 'Content-Type', 'application/json', 'Authorization', 'Bearer on', 'X-Api-Key', 'secondary',
          'X-Forwarded-For', '203.0.113.1', 'X-Forwarded-For', '203.0.113.2', 'Connection', 'x-drop-me', 'X-Drop-Me', 'gone',
          'Keep-Alive', 'timeout=5', 'Content-Length', String(body.length),
        ],
      }, (res) => {
        let text = ''
        res.on('data', (chunk) => { text += chunk }).on('end', () => resolve({ status: res.statusCode!, message: res.statusMessage!, rawHeaders: res.rawHeaders, body: text }))
      })
      req.on('error', reject).end(body)
    })
    const [seen] = upstream.seen
    assert.equal(seen!.method, 'POST')
    assert.equal(seen!.url, '/v1/responses?beta=true')
    assert.equal(sha(seen!.body), sha(body), 'nothing to compress: original bytes, escapes and spacing kept')
    const names = seen!.rawHeaders.filter((_, index) => index % 2 === 0)
    assert.ok(names.includes('Authorization') && names.includes('X-Api-Key'), 'credentials reach the guard with their original case')
    assert.equal(seen!.headers.authorization, 'Bearer on')
    assert.equal(names.filter((name) => name === 'X-Forwarded-For').length, 2, 'duplicate headers are not folded')
    assert.equal(seen!.headers['x-drop-me'], undefined)
    assert.equal(seen!.headers['keep-alive'], undefined)
    assert.equal(seen!.headers['content-length'], String(body.length))
    assert.equal(seen!.headers.host, 'relay.test', 'the client Host header is kept')
    assert.equal(response.status, 418)
    assert.equal(response.message, 'Custom Reason')
    assert.equal(response.body, '{"error":{"code":"teapot"}}')
    const pairs = response.rawHeaders.join('\n')
    assert.match(pairs, /X-Upstream\nkept/)
    assert.match(pairs, /Set-Cookie\na=1\nSet-Cookie\nb=2/)
    assert.doesNotMatch(pairs, /X-Secret-Hop/)
    assert.deepEqual(calls, { saved: [], failed: [] })
  } finally { await close(server); await close(upstream.server) }
})

test('only opted-in keys are compressed; others, GETs and non-JSON bodies are forwarded byte for byte', async () => {
  const upstream = await recordingUpstream((_req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end(completeChat))
  const { server, calls } = relay(upstream.base)
  const base = await listen(server)
  try {
    const original = Buffer.from(payload)
    for (const [label, init] of [
      ['other key', { method: 'POST', headers: { ...headers, authorization: 'Bearer off' }, body: payload }],
      ['no key', { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload }],
      ['text body', { method: 'POST', headers: { ...headers, authorization: 'Bearer on', 'content-type': 'text/plain' }, body: payload }],
      ['encoded body', { method: 'POST', headers: { ...headers, authorization: 'Bearer on', 'content-encoding': 'gzip' }, body: payload }],
    ] as const) {
      await (await fetch(`${base}/v1/chat/completions`, init)).text()
      assert.equal(sha(upstream.seen.at(-1)!.body), sha(original), label)
    }
    await (await fetch(`${base}/v1/models`, { headers: { authorization: 'Bearer on' } })).text()
    assert.equal(upstream.seen.at(-1)!.method, 'GET')
    assert.deepEqual(calls.saved, [])

    for (const auth of [{ authorization: 'Bearer on' }, { 'x-api-key': 'on' }] as Array<Record<string, string>>) {
      const response = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', ...auth }, body: payload })
      assert.equal(await response.text(), completeChat)
      const seen = upstream.seen.at(-1)!
      assert.ok(seen.body.length < original.length, 'opted-in tool output is smaller')
      assert.equal(seen.headers['content-length'], String(seen.body.length))
      assert.equal(seen.headers['accept-encoding'], 'identity')
      assert.match(seen.body.toString(), /\[RTK identical line: 500 times\]/)
      const expected = structuredClone(JSON.parse(payload))
      compressRequestToolOutputs(expected)
      assert.equal(seen.body.toString(), JSON.stringify(expected))
    }
    const savedTokens = Math.floor((compressRequestToolOutputs(JSON.parse(payload)).saved) / 4)
    assert.deepEqual(calls, { saved: [savedTokens, savedTokens], failed: [] })
  } finally { await close(server); await close(upstream.server) }
})

test('console probe and lockout keys are never looked up, compressed or counted', async () => {
  const upstream = await recordingUpstream((_req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end(completeChat))
  const { server, calls } = relay(upstream.base, { optedIn: () => assert.fail('system keys are not looked up') })
  const base = await listen(server)
  try {
    for (const key of [`sk-probe-claude-${'a'.repeat(64)}`, `sk-probe-${'b'.repeat(64)}`, `sk-lockout-${'c'.repeat(64)}`]) {
      for (const auth of [{ authorization: `Bearer ${key}` }, { 'x-api-key': key }] as Array<Record<string, string>>) {
        const response = await fetch(`${base}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', ...auth }, body: payload })
        assert.equal(await response.text(), completeChat)
        assert.equal(upstream.seen.at(-1)!.body.toString(), payload, key)
      }
    }
    assert.deepEqual(calls, { saved: [], failed: [] })
  } finally { await close(server); await close(upstream.server) }
})

test('a failing compressor or key lookup forwards the original body and counts the failure', async () => {
  const upstream = await recordingUpstream((_req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end(completeChat))
  const throwing = relay(upstream.base, { compress: () => { throw new Error('rtk exploded') } })
  const lookup = relay(upstream.base, { optedIn: () => { throw new Error('database is locked') } })
  try {
    for (const { server, calls } of [throwing, lookup]) {
      const base = await listen(server)
      const response = await fetch(`${base}/v1/messages`, { method: 'POST', headers: { ...headers, authorization: 'Bearer on' }, body: payload })
      assert.equal(response.status, 200)
      assert.equal(await response.text(), completeChat)
      assert.equal(upstream.seen.at(-1)!.body.toString(), payload)
      assert.deepEqual(calls.saved, [])
    }
    assert.deepEqual(throwing.calls.failed, ['compress'])
    assert.deepEqual(lookup.calls.failed, ['lookup'])
  } finally { await close(throwing.server); await close(lookup.server); await close(upstream.server) }
})

test('SSE chunks reach the client one by one while the upstream is still streaming', async () => {
  let firstSeen!: () => void
  const clientHasFirst = new Promise<void>((resolve) => { firstSeen = resolve })
  const upstream = await recordingUpstream(async (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('event: message_start\ndata: {"type":"message_start"}\n\n')
    await clientHasFirst
    res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n')
  })
  const { server, calls } = relay(upstream.base)
  const base = await listen(server)
  try {
    const response = await fetch(`${base}/v1/messages`, { method: 'POST', headers: { ...headers, authorization: 'Bearer on' }, body: payload })
    const reader = response.body!.getReader()
    const first = await within(reader.read(), 5_000, 'first SSE chunk before the upstream finished')
    assert.match(new TextDecoder().decode(first.value), /message_start/)
    firstSeen()
    let rest = ''
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) rest += new TextDecoder().decode(chunk.value)
    assert.match(rest, /message_stop/)
    assert.equal(calls.saved.length, 1, 'a completed compressed stream is recorded once')
  } finally { await close(server); await close(upstream.server) }
})

test('a client abort mid-stream closes the upstream request', async () => {
  let upstreamClosed!: () => void
  const closed = new Promise<void>((resolve) => { upstreamClosed = resolve })
  const upstream = await recordingUpstream((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n')
    res.once('close', upstreamClosed)
  })
  const { server, calls } = relay(upstream.base)
  const base = await listen(server)
  try {
    const abort = new AbortController()
    const response = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { ...headers, authorization: 'Bearer on' }, body: payload, signal: abort.signal })
    await response.body!.getReader().read()
    abort.abort()
    await within(closed, 5_000, 'upstream close after the client aborted')
    assert.deepEqual(calls.saved, [], 'an aborted stream records nothing')
  } finally { await close(server); await close(upstream.server) }
})

test('websocket upgrades are tunnelled both ways with their headers', async () => {
  const upstream = createServer((_req, res) => res.writeHead(404).end())
  let upgradeAuth = ''
  upstream.on('upgrade', (req, socket) => {
    upgradeAuth = String(req.headers.authorization)
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: test\r\n\r\n')
    socket.on('data', (data) => socket.write(Buffer.concat([Buffer.from('echo:'), data])))
    socket.on('end', () => socket.end())
  })
  const target = await listen(upstream)
  const { server } = relay(target)
  const base = await listen(server)
  try {
    const { status, accept, socket } = await new Promise<{ status: number; accept: string; socket: import('node:net').Socket }>((resolve, reject) => {
      request(`${base}/v1/responses`, { headers: { connection: 'Upgrade', upgrade: 'websocket', authorization: 'Bearer on' } })
        .on('upgrade', (res, socket) => resolve({ status: res.statusCode!, accept: String(res.headers['sec-websocket-accept']), socket: socket as import('node:net').Socket }))
        .on('error', reject)
        .end()
    })
    assert.equal(status, 101)
    assert.equal(accept, 'test')
    assert.equal(upgradeAuth, 'Bearer on')
    socket.write('ping')
    const [echo] = await within(once(socket, 'data'), 5_000, 'websocket echo') as [Buffer]
    assert.equal(echo.toString(), 'echo:ping')
    socket.destroy()
  } finally { await close(server); await close(upstream) }
})

test('rejected websocket upgrades retain quota payload and retry headers', async () => {
  const body = '{"error":{"code":"quota_exceeded"}}'
  const upstream = createServer((_req, res) => res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '31', 'content-length': Buffer.byteLength(body) }).end(body))
  const target = await listen(upstream)
  const { server } = relay(target, { optedIn: () => assert.fail('upgrade is not compressed') })
  const base = await listen(server)
  try {
    const response = await new Promise<{ status: number; retry: string | undefined; body: string }>((resolve, reject) => {
      const req = request(`${base}/v1/responses`, { headers: { connection: 'Upgrade', upgrade: 'websocket' } }, (res) => {
        let text = ''
        res.on('data', (chunk) => { text += chunk })
        res.on('end', () => resolve({ status: res.statusCode!, retry: res.headers['retry-after'], body: text }))
      })
      req.on('error', reject).end()
    })
    assert.deepEqual(response, { status: 429, retry: '31', body })
  } finally { await close(server); await close(upstream) }
})

test('HTTP-200 protocol errors never count, and SSE bytes remain unchanged across split frames', async () => {
  let responseText = ''
  let responseType = ''
  const upstream = createServer(async (req, res) => {
    for await (const _chunk of req) { /* Drain the compressed request. */ }
    res.writeHead(200, { 'content-type': responseType })
    const bytes = Buffer.from(responseText)
    for (let start = 0; start < bytes.length; start += 7) res.write(bytes.subarray(start, start + 7))
    res.end()
  })
  const target = await listen(upstream)
  const { server, calls } = relay(target, { optedIn: () => true })
  const base = await listen(server)
  try {
    const cases = [
      ['text/event-stream', 'event: error\r\ndata: {"error":{"message":"限额 exceeded"}}\r\n\r\n'],
      ['text/event-stream', 'data: {"type":"response.failed","response":{"status":"failed"}}\n\n'],
      ['text/event-stream', 'data: {"type":"response.incomplete","response":{"status":"incomplete"}}\n\n'],
      ['application/json', '{"status":"incomplete","incomplete_details":{"reason":"max_output_tokens"}}'],
      ['application/json', '{"error":{"code":"overloaded"}}'],
      ['text/event-stream', 'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'],
    ]
    for (const [type, text] of cases) {
      responseType = type!; responseText = text!
      const response = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers, body: payload })
      assert.equal(response.status, 200)
      assert.equal(await response.text(), text)
      assert.equal(calls.saved.length, 0)
    }
    responseType = 'text/event-stream'
    responseText = 'data: {"choices":[{"delta":{"content":"complete"}}]}\n\ndata: [DONE]\n\n'
    const response = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers, body: payload })
    assert.equal(await response.text(), responseText)
    assert.equal(calls.saved.length, 1)
  } finally { await close(server); await close(upstream) }
})

test('an upstream disconnect returns JSON 502 during an unfinished passthrough upload', async () => {
  const upstream = createServer((req) => { req.once('data', () => req.socket.destroy()) })
  const target = await listen(upstream)
  const { server } = relay(target, { optedIn: () => assert.fail('disabled traffic is not compressed') })
  const base = new URL(await listen(server))
  try {
    const raw = await new Promise<string>((resolve, reject) => {
      const socket = connect(Number(base.port), '127.0.0.1')
      let response = ''
      socket.setTimeout(5000, () => { socket.destroy(); reject(new Error('missing 502 while upload remains unfinished')) })
      socket.on('error', reject)
      socket.on('data', (chunk) => { response += chunk })
      socket.on('end', () => resolve(response))
      socket.on('connect', () => socket.write('POST /v1/chat/completions HTTP/1.1\r\nHost: local\r\nContent-Length: 9000\r\nConnection: close\r\n\r\n{"start":'))
    })
    assert.match(raw, /^HTTP\/1\.1 502 /)
    assert.match(raw, /relay_unavailable/)
  } finally { await close(server); await close(upstream) }
})

test('bodies over 100 MiB get 413 without reaching the guard; chunked bodies are cut at the cap', async () => {
  assert.equal(MAX_BODY_BYTES, 100 * 1024 * 1024)
  const upstream = await recordingUpstream()
  const { server } = relay(upstream.base)
  const small = relay(upstream.base, { maxBodyBytes: 64 * 1024 })
  const base = new URL(await listen(server))
  const smallBase = await listen(small.server)
  try {
    const raw = await new Promise<string>((resolve, reject) => {
      const socket = connect(Number(base.port), '127.0.0.1')
      let response = ''
      socket.setTimeout(5000, () => { socket.destroy(); reject(new Error('missing 413')) })
      socket.on('error', reject).on('data', (chunk) => { response += chunk }).on('end', () => resolve(response))
      socket.on('connect', () => socket.write(`POST /v1/messages HTTP/1.1\r\nHost: local\r\nContent-Type: application/json\r\nAuthorization: Bearer on\r\nContent-Length: ${MAX_BODY_BYTES + 1}\r\n\r\n{`))
    })
    assert.match(raw, /^HTTP\/1\.1 413 /)
    assert.match(raw, /request_too_large/)
    assert.equal(upstream.seen.length, 0, 'the guard never saw the oversized request')

    // 80 KiB of a chunked body against a 64 KiB cap, request left open: the relay must not wait for the end.
    const status = await within(new Promise<number>((resolve, reject) => {
      const req = request(`${smallBase}/v1/files`, { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'transfer-encoding': 'chunked' } }, (res) => {
        res.resume()
        resolve(res.statusCode!)
      })
      req.on('error', reject)
      for (let index = 0; index < 5; index++) req.write(Buffer.alloc(16 * 1024, 1))
    }), 5_000, '413 for an oversized chunked body')
    assert.equal(status, 413)
    await within((async () => { while (!upstream.state.aborted) await new Promise((r) => setTimeout(r, 10)) })(), 5_000, 'upstream request cut')
    assert.equal(upstream.seen.length, 0, 'the guard never received the complete oversized body')
  } finally { await close(server); await close(small.server); await close(upstream.server) }
})

test('large bodies stream through intact; opted-in bodies above the compression cap are not buffered or rewritten', async () => {
  const upstream = await recordingUpstream((_req, res, seen) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ sha: sha(seen.body) })))
  const { server, calls } = relay(upstream.base, { maxCompressBytes: 1024 * 1024 })
  const base = await listen(server)
  try {
    const big = Buffer.from(JSON.stringify({ messages: [{ role: 'tool', content: 'repeated tool line\n'.repeat(1_200_000) }] }))
    assert.ok(big.length > 20 * 1024 * 1024)
    const declared = await (await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { ...headers, authorization: 'Bearer on' }, body: big })).json()
    assert.equal(declared.sha, sha(big), 'Content-Length above the compression cap: forwarded unchanged')
    const chunked = await new Promise<{ sha: string }>((resolve, reject) => {
      const req = request(`${base}/v1/chat/completions`, { method: 'POST', headers: { ...headers, authorization: 'Bearer on', 'transfer-encoding': 'chunked' } }, async (res) => {
        let text = ''
        for await (const chunk of res) text += chunk
        resolve(JSON.parse(text))
      })
      req.on('error', reject)
      for (let start = 0; start < big.length; start += 256 * 1024) req.write(big.subarray(start, start + 256 * 1024))
      req.end()
    })
    assert.equal(chunked.sha, sha(big), 'chunked body crossing the compression cap spills through unchanged')
    assert.deepEqual(calls, { saved: [], failed: [] })
  } finally { await close(server); await close(upstream.server) }
})

test('drain: idle keep-alive connections close, an open stream may finish, the bound cuts what is left', async () => {
  let finishStream = () => {}
  const upstream = await recordingUpstream((req, res) => {
    if (req.method === 'GET') return void res.writeHead(200, { 'content-type': 'application/json' }).end('{"data":[]}')
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n')
    finishStream = () => res.end('data: [DONE]\n\n')
  })
  const quick = relay(upstream.base)
  const idleBase = await listen(quick.server)
  const keepAlive = new Agent({ keepAlive: true })
  const idleSocket = await new Promise<import('node:net').Socket>((resolve, reject) => {
    request(`${idleBase}/v1/models`, { agent: keepAlive }, (res) => {
      const socket = res.socket as import('node:net').Socket
      res.resume()
      res.once('end', () => resolve(socket))
    }).on('error', reject).end()
  })
  const idleClosed = once(idleSocket, 'close')
  assert.equal(await within(quick.server.drain(5_000), 5_000, 'drain with only an idle connection'), true)
  await within(idleClosed, 5_000, 'idle keep-alive socket closed')
  keepAlive.destroy()

  for (const [bound, finishes] of [[5_000, true], [300, false]] as const) {
    const { server } = relay(upstream.base)
    const base = await listen(server)
    const response = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers, body: payload })
    const reader = response.body!.getReader()
    await reader.read()
    assert.equal(server.inFlight(), 1)
    const drained = server.drain(bound)
    const port = Number(new URL(base).port)
    const refusal = await new Promise<string>((resolve) => {
      const socket = connect(port, '127.0.0.1')
      socket.once('connect', () => { socket.destroy(); resolve('accepted') }).once('error', (e: NodeJS.ErrnoException) => resolve(String(e.code)))
    })
    assert.equal(refusal, 'ECONNREFUSED', 'no new connections once draining')
    if (finishes) finishStream()
    assert.equal(await within(drained, 6_000, 'drain settles'), finishes)
    let rest = ''
    try {
      for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) rest += new TextDecoder().decode(chunk.value)
    } catch { rest += '<cut>' }
    assert.equal(rest.includes('[DONE]'), finishes, finishes ? 'the stream completed during the drain' : 'the bound cut the stream')
  }
  await close(upstream.server)
})
