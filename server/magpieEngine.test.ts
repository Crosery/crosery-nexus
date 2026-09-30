import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { once } from 'node:events'
import test from 'node:test'
import { allowedMagpieRoutes, createMagpieAdmission, kernelJSON, mapMagpieRoutes, type AdmissionKey } from './magpieEngine.js'
import type { UsageRecord } from './cpa.js'

const channel = (name = 'allowed', base = 'https://upstream.invalid/v1') => ({
  name, 'base-url': base, 'api-key-entries': [{ 'api-key': 'fixture-upstream-key' }],
  models: [{ name: 'real-model', alias: 'public-model' }],
})
const key: AdmissionKey = {
  key_value: 'fixture-client-key', key_hash: 'fixture-hash', enabled: 1, groups_json: '["allowed"]',
  total_concurrency: 1, group_concurrency_json: '{"allowed":1}',
}

test('aliases map to separate kernel slots without cross-channel fallback', () => {
  const routes = mapMagpieRoutes([channel(), channel('denied')])
  assert.equal(routes.length, 2)
  assert.equal(routes[0].upstream, 'real-model')
  assert.notEqual(routes[0].provider.id, routes[1].provider.id)
  assert.deepEqual(allowedMagpieRoutes(routes, key).map(route => route.channel), ['allowed'])
  assert.deepEqual(allowedMagpieRoutes(routes, { ...key, enabled: 0 }), [])
  assert.deepEqual(allowedMagpieRoutes(routes, { ...key, groups_json: 'malformed' }), [])
})

test('native Responses and Messages use their declared upstream slots', () => {
  const routes = mapMagpieRoutes([], [
    { endpoint: 'claude-api-key', name: 'claude', entry: { 'api-key': 'fixture', models: [{ name: 'claude-test' }] } },
    { endpoint: 'codex-api-key', name: 'codex', entry: { 'api-key': 'fixture', models: [{ name: 'gpt-test' }] } },
    { endpoint: 'gemini-api-key', name: 'gemini', entry: { 'api-key': 'fixture', models: [{ name: 'gemini-test' }] } },
  ])
  assert.equal(routes[0].provider.anthropic, 'https://api.anthropic.com')
  assert.equal(routes[1].provider.responses, 'https://api.openai.com/v1')
  assert.equal(routes.length, 2)
})

test('mixed per-key proxies and credential-bearing URLs fail closed', () => {
  assert.throws(() => mapMagpieRoutes([{ ...channel(), 'api-key-entries': [
    { 'api-key': 'a', 'proxy-url': 'direct' }, { 'api-key': 'b', 'proxy-url': 'http://proxy.invalid' },
  ] }]), /proxies/)
  assert.throws(() => mapMagpieRoutes([channel('bad', 'https://user:password@upstream.invalid/v1')]), /upstream/)
})

test('real headless kernel: four protocols, streaming, admission and accounting', { timeout: 30_000 }, async t => {
  const binary = process.env.MAGPIE_KERNEL_TEST_BINARY
  if (!binary) {
    t.skip('Run npm run test:magpie:kernel with the pinned kernel binary')
    return
  }
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cros-kernel-'))
  const socket = path.join(directory, 'k.sock')
  const calls: Array<{ model: string; authorization?: string }> = []
  const upstream = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString())
      calls.push({ model: body.model, authorization: req.headers.authorization })
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: body.model,
          choices: [{ index: 0, delta: { role: 'assistant', content: 'OK' }, finish_reason: null }] })}\n\n`)
        setTimeout(() => res.end(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: body.model,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, prompt_tokens_details: { cached_tokens: 3 } } })}\n\ndata: [DONE]\n\n`), 100)
      } else {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ id: 'fixture', object: 'chat.completion', model: body.model,
          choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, prompt_tokens_details: { cached_tokens: 3 } } }))
      }
    })
  })
  upstream.listen(0, '127.0.0.1')
  await once(upstream, 'listening')
  const upstreamPort = (upstream.address() as { port: number }).port
  const child = spawn(binary, [], {
    env: { PATH: process.env.PATH, HOME: directory, XDG_CONFIG_HOME: path.join(directory, 'config'),
      XDG_CACHE_HOME: path.join(directory, 'cache'), MAGPIE_KERNEL_SOCKET: socket, MAGPIE_NO_STATS: '1' },
    stdio: 'ignore',
  })
  child.once('error', error => { throw error })
  let ready = false
  for (let i = 0; i < 100; i++) {
    try { await kernelJSON(socket, '/internal/health'); ready = true; break } catch { await new Promise(resolve => setTimeout(resolve, 20)) }
  }
  assert.equal(ready, true)
  assert.equal((await fs.stat(socket)).mode & 0o777, 0o600)
  const routes = mapMagpieRoutes([channel('allowed', `http://127.0.0.1:${upstreamPort}/v1`), channel('denied', `http://127.0.0.1:${upstreamPort}/v1`)])
  const records: UsageRecord[] = []
  let exceeded = false
  let currentKey = { ...key }
  const admission = createMagpieAdmission({
    socket, port: 0, timeoutMs: 5_000, routes: async () => routes,
    key: token => token === key.key_value ? currentKey : undefined, exceeded: () => exceeded,
    settle: items => records.push(...items),
  })
  admission.listen(0, '127.0.0.1')
  await once(admission, 'listening')
  const port = (admission.address() as { port: number }).port
  const headers = { authorization: `Bearer ${key.key_value}`, 'content-type': 'application/json' }
  const base = `http://127.0.0.1:${port}`
  t.after(async () => {
    admission.closeAllConnections(); upstream.closeAllConnections()
    await Promise.all([new Promise<void>(resolve => admission.close(() => resolve())), new Promise<void>(resolve => upstream.close(() => resolve()))])
    child.kill('SIGTERM')
    await once(child, 'exit')
    await fs.rm(directory, { recursive: true, force: true })
  })
  const models = await fetch(`${base}/v1/models`, { headers })
  assert.equal(models.status, 200)
  assert.equal((await models.json()).data.length, 1)
  const requests = [
    ['/v1/chat/completions', { model: 'public-model', messages: [{ role: 'user', content: 'OK' }] }],
    ['/v1/responses', { model: 'public-model', input: 'OK' }],
    ['/v1/messages', { model: 'public-model', max_tokens: 16, messages: [{ role: 'user', content: 'OK' }] }],
    ['/v1beta/models/public-model:generateContent', { contents: [{ role: 'user', parts: [{ text: 'OK' }] }] }],
  ] as const
  for (const [route, body] of requests) {
    const response = await fetch(base + route, { method: 'POST', headers, body: JSON.stringify(body) })
    const text = await response.text()
    assert.equal(response.status, 200, `${route}: ${text}`)
    assert.equal(response.headers.get('x-crosery-engine'), 'magpie')
    assert.match(text, /OK/)
  }
  assert.equal(records.length, 4)
  assert.ok(records.every(record => record.provider === 'allowed' && record.alias === 'public-model' && record.tokens?.input_tokens === 10))
  assert.ok(calls.every(call => call.authorization === 'Bearer fixture-upstream-key' && call.model === 'real-model'))
  const stream = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers,
    body: JSON.stringify({ model: 'public-model', stream: true, messages: [{ role: 'user', content: 'OK' }] }) })
  const reader = stream.body!.getReader()
  const first = await reader.read()
  assert.match(new TextDecoder().decode(first.value), /OK/)
  const busy = await fetch(base + requests[0][0], { method: 'POST', headers, body: JSON.stringify(requests[0][1]) })
  assert.equal(busy.status, 429)
  await busy.text()
  while (!(await reader.read()).done) { /* drain the admitted stream */ }
  assert.equal(records.length, 5)
  routes.push(...mapMagpieRoutes([{ ...channel('allowed', `http://127.0.0.1:${upstreamPort}/v1`),
    models: [{ name: 'real-model:tag', alias: 'public-model:tag' }],
  }]))
  const tagged = await fetch(`${base}/v1beta/models/public-model:tag:generateContent`, { method: 'POST', headers,
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'OK' }] }] }) })
  assert.equal(tagged.status, 200)
  await tagged.text()
  assert.equal(records.length, 6)
  const before = calls.length
  for (const body of [
    { model: 'denied-model', messages: [] },
    { model: 'public-model', messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'http://127.0.0.1/private' } }] }] },
    { model: 'public-model', tools: [{ type: 'web_search' }] },
  ]) {
    const response = await fetch(base + requests[0][0], { method: 'POST', headers, body: JSON.stringify(body) })
    assert.ok(response.status >= 400)
    await response.text()
  }
  exceeded = true
  assert.equal((await fetch(`${base}/v1/models`, { headers })).status, 429)
  exceeded = false
  currentKey = { ...currentKey, enabled: 0 }
  assert.equal((await fetch(`${base}/v1/models`, { headers })).status, 401)
  assert.equal(calls.length, before)
  const files = await fs.readdir(directory)
  assert.equal(files.includes('usage.jsonl'), false)
})
