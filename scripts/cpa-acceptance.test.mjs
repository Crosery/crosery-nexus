import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  checkJsonReply, checkModelsList, checkStream, checkToolAnswer, checkToolCall, checkVersionHeader, gatewayRoot, redact, runAcceptance,
} from './cpa-acceptance.mjs'

const KEY = 'sk-accept-fixture-0123456789'
const json = value => JSON.stringify(value)
const sse = (...chunks) => `${chunks.map(chunk => `data: ${typeof chunk === 'string' ? chunk : json(chunk)}\n\n`).join('')}`
const delta = content => ({ choices: [{ delta: { content } }] })

/** A canned gateway: answers by request shape; `over` swaps single answers to break one check at a time. */
function gateway(over = {}) {
  const calls = []
  const answer = (status, text, headers = {}) => ({ status, text: async () => text, headers: new Headers(headers) })
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    assert.equal(init.headers.authorization, `Bearer ${KEY}`)
    if (url.endsWith('/v1/models')) return over.models ?? answer(200, json({ data: [{ id: 'm1' }, { id: 'm2' }] }), { 'x-cpa-version': '8.0.21-patched.a' })
    const body = JSON.parse(init.body)
    if (body.stream) return over.stream ?? answer(200, sse(delta(''), delta('1'), delta(' 2'), '[DONE]'))
    if (body.tools && body.messages.length === 1) {
      return over.toolCall ?? answer(200, json({ choices: [{ message: { content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_build_number', arguments: '{}' } }] } }] }))
    }
    if (body.tools) {
      assert.deepEqual(body.messages.at(-1), { role: 'tool', tool_call_id: 'call_1', content: '4217' })
      return over.toolAnswer ?? answer(200, json({ choices: [{ message: { content: 'The build number is 4217.' } }] }))
    }
    return over.reply ?? answer(200, json({ choices: [{ message: { content: 'pong' } }] }))
  }
  return { fetchImpl, calls, answer }
}

test('acceptance: models, then JSON, SSE and a tool round trip per model; all pass', async () => {
  const g = gateway()
  const result = await runAcceptance({ baseUrl: 'https://api.example.com/v1/', key: KEY, models: 'm1, m2,m1', expectVersion: '8.0.21-patched.a', fetchImpl: g.fetchImpl, now: () => Date.UTC(2026, 9, 9) })
  assert.equal(result.ok, true, JSON.stringify(result.checks))
  assert.deepEqual(result.models, ['m1', 'm2'])
  assert.equal(result.baseUrl, 'https://api.example.com')
  assert.equal(result.cpaVersion, '8.0.21-patched.a')
  assert.deepEqual(result.checks.map(item => item.name), ['网关 /v1/models', 'm1 JSON', 'm1 SSE', 'm1 工具往返', 'm2 JSON', 'm2 SSE', 'm2 工具往返'])
  assert.equal(result.ranAt, '2026-10-09T00:00:00.000Z')
  assert.ok(g.calls.every(call => call.url.startsWith('https://api.example.com/v1/')))
  assert.equal(JSON.stringify(result).includes(KEY), false)
})

test('acceptance: each broken answer fails exactly its own check', async () => {
  const g = gateway()
  const cases = [
    ['models', g.answer(401, json({ error: 'bad key' })), '网关 /v1/models', /HTTP 401/],
    ['reply', g.answer(200, json({ choices: [{ message: { content: '  ' } }] })), 'm1 JSON', /没有回复内容/],
    ['stream', g.answer(200, sse(delta('1'))), 'm1 SSE', /\[DONE\]/],
    ['stream', g.answer(200, sse(delta(''), '[DONE]')), 'm1 SSE', /内容增量/],
    ['toolCall', g.answer(200, json({ choices: [{ message: { content: '4217' } }] })), 'm1 工具往返', /没有调用工具/],
    ['toolAnswer', g.answer(200, json({ choices: [{ message: { content: 'I cannot tell.' } }] })), 'm1 工具往返', /没有工具结果/],
  ]
  for (const [slot, answer, name, detail] of cases) {
    const broken = gateway({ [slot]: answer })
    const result = await runAcceptance({ baseUrl: 'https://api.example.com', key: KEY, models: ['m1'], fetchImpl: broken.fetchImpl })
    assert.equal(result.ok, false, slot)
    assert.deepEqual(result.checks.filter(item => !item.ok).map(item => item.name), [name], slot)
    assert.match(result.checks.find(item => item.name === name).detail, detail)
    assert.match(result.summary, /^1\/4 项没过/)
  }
})

test('acceptance: a gateway answering as another version fails; a missing header is only noted; a network error is a failed check', async () => {
  const g = gateway()
  const other = await runAcceptance({ baseUrl: 'https://api.example.com', key: KEY, models: ['m1'], expectVersion: '8.0.22-patched.b', fetchImpl: g.fetchImpl })
  assert.match(other.checks[0].detail, /在跑 8\.0\.21-patched\.a，不是 8\.0\.22-patched\.b/)
  assert.equal(other.ok, false)
  assert.match(checkVersionHeader(null, 'x'), /没有 x-cpa-version 头/)
  const down = await runAcceptance({ baseUrl: 'https://api.example.com', key: KEY, models: ['m1'], fetchImpl: async () => { throw new TypeError(`fetch failed for Bearer ${KEY}`) } })
  assert.equal(down.ok, false)
  assert.equal(down.checks.every(item => !item.ok), true)
  assert.equal(JSON.stringify(down).includes(KEY), false, 'the key never reaches the record')
  await assert.rejects(runAcceptance({ baseUrl: 'https://api.example.com', key: '', models: ['m1'], fetchImpl: g.fetchImpl }), /CPA_ACCEPT_KEY/)
  await assert.rejects(runAcceptance({ baseUrl: 'https://api.example.com', key: KEY, models: ' , ', fetchImpl: g.fetchImpl }), /no models/)
})

test('acceptance parsers: canned bodies', () => {
  assert.equal(checkModelsList({ status: 200, text: json({ data: [{ id: 'a' }] }) }), '1 个模型')
  assert.throws(() => checkModelsList({ status: 200, text: json({ data: [] }) }), /为空/)
  assert.throws(() => checkModelsList({ status: 200, text: '<html>' }), /为空/)
  assert.equal(checkJsonReply({ status: 200, text: json({ choices: [{ message: { content: ' pong ' } }] }) }), '"pong"')
  assert.match(checkStream({ status: 200, text: 'event: x\ndata: {"choices":[{"delta":{"content":"hi"}}]}\r\ndata: [DONE]\n' }), /2 个事件 · 1 个内容增量/)
  assert.throws(() => checkStream({ status: 500, text: 'oops' }), /HTTP 500/)
  const assistant = checkToolCall({ status: 200, text: json({ choices: [{ message: { tool_calls: [{ id: 't', function: { name: 'get_build_number' } }] } }] }) })
  assert.equal(assistant.content, null)
  assert.throws(() => checkToolCall({ status: 200, text: json({ choices: [{ message: { tool_calls: [{ function: { name: 'other' } }] } }] }) }), /没有调用工具/)
  assert.equal(checkToolAnswer({ status: 200, text: json({ choices: [{ message: { content: '4217' } }] }) }), 'tool result returned')
  assert.equal(gatewayRoot('https://h.example/v1'), 'https://h.example')
  assert.equal(gatewayRoot('http://127.0.0.1:8317/'), 'http://127.0.0.1:8317')
  assert.throws(() => gatewayRoot('file:///etc/passwd'), /http/)
  assert.equal(redact(`Bearer ${KEY} and ${KEY}`, KEY), 'Bearer *** and ***')
})

test('cli: key from the environment, JSON on stdout, exit code follows the result', async () => {
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      if (req.headers.authorization !== `Bearer ${KEY}`) { res.writeHead(401); res.end('{}'); return }
      if (req.url === '/v1/models') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(json({ data: [{ id: 'm1' }] })); return }
      const parsed = JSON.parse(body)
      if (parsed.stream) { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(sse(delta('1'), '[DONE]')); return }
      if (parsed.tools && parsed.messages.length === 1) { res.writeHead(200); res.end(json({ choices: [{ message: { tool_calls: [{ id: 'c', function: { name: 'get_build_number' } }] } }] })); return }
      res.writeHead(200)
      res.end(json({ choices: [{ message: { content: parsed.tools ? '4217' : 'pong' } }] }))
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const script = fileURLToPath(new URL('./cpa-acceptance.mjs', import.meta.url))
  const runCli = env => new Promise(resolve => execFile(process.execPath, [script, '--base-url', base, '--models', 'm1'], { env: { ...process.env, ...env } }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr })))
  try {
    const good = await runCli({ CPA_ACCEPT_KEY: KEY })
    assert.equal(good.code, 0, good.stderr)
    assert.equal(JSON.parse(good.stdout).ok, true)
    const bad = await runCli({ CPA_ACCEPT_KEY: 'sk-wrong-key-0000000000' })
    assert.equal(bad.code, 1)
    assert.equal(JSON.parse(bad.stdout).ok, false)
    assert.equal(bad.stdout.includes('sk-wrong-key-0000000000'), false)
  } finally {
    server.close()
  }
})
