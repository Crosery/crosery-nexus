import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import { once } from 'node:events'
import { prepare, verifySnapshots, createBridge, mapCatalog, endpoint,
  childEnvironment, runtimeProviders } from '../deploy/magpie/local.mjs'

const catalog = { version: 1, baseUrl: 'https://gateway.example/v1', generatedAt: Date.now(), models: [
  { id: 'model', name: 'Audited Model', contextWindow: 123456, maxTokens: 2345,
    supportsReasoning: true, efforts: ['off', 'low', 'max'], input: ['text', 'image'] },
] }

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'magpie-migrate-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const source = path.join(root, 'original')
  await fs.mkdir(source)
  const providers = { providers: [
    { id: 'relay', name: 'Existing relay', chat: 'https://vendor.example/v1',
      key: 'fixture-secret-not-for-output', headers: { Authorization: 'fixture-private-header' },
      models: ['model'], keys: [{ name: 'other', key: 'fixture-second-secret' }] },
    { id: 'commandcode-plan', models: ['legacy-model'] },
  ], groups: [{ id: 'old-group', models: ['relay/model'] }] }
  await fs.writeFile(path.join(source, 'providers.json'), JSON.stringify(providers), { mode: 0o600 })
  await fs.writeFile(path.join(source, 'settings.json'), JSON.stringify({ lang: 'zh', lan: true,
    lanKey: 'fixture-lan-secret', codexWarmup: 'all', visible: { codex: ['relay'] } }))
  await fs.writeFile(path.join(source, 'usage.jsonl'), '{"t":"2026-09-29T01:00:00Z","in":12,"out":3}\n')
  await fs.writeFile(path.join(source, 'profiles.json'), '{"work":{"model":"relay/model"}}')
  await fs.writeFile(path.join(source, 'library.json'), '{"mcp":[{"apiKey":"fixture-private-mcp-key"}]}')
  const catalogPath = path.join(root, 'catalog.json')
  await fs.writeFile(catalogPath, JSON.stringify(catalog))
  return { source, catalogPath, runtime: path.join(root, 'runtime') }
}

test('migration preserves ids, groups and history without copying credentials or changing originals', async t => {
  const opts = await fixture(t)
  const original = await fs.readFile(path.join(opts.source, 'providers.json'))
  const manifest = await prepare(opts)
  const config = path.join(opts.runtime, 'home/.config/magpie')
  const output = await fs.readFile(path.join(config, 'providers.json'), 'utf8')
  assert.ok(!output.includes('fixture-secret'))
  assert.ok(!output.includes('fixture-private-header'))
  assert.ok(!output.includes('fixture-second-secret'))
  const parsed = JSON.parse(output)
  assert.equal(parsed.providers.find(p => p.id === 'relay').key, 'slot-0')
  assert.equal(parsed.providers.find(p => p.id === 'relay').keys[0].key, 'slot-1')
  assert.deepEqual(parsed.groups, [{ id: 'old-group', models: ['relay/model'] }])
  assert.deepEqual(manifest.needsSignIn, ['commandcode-plan'])
  assert.deepEqual(await fs.readFile(path.join(opts.source, 'providers.json')), original)
  assert.ok(!await fs.access(path.join(config, 'library.json')).then(() => true, () => false))
  const settings = JSON.parse(await fs.readFile(path.join(config, 'settings.json')))
  assert.equal(settings.lang, 'zh')
  assert.equal(settings.lan, false)
  assert.equal(settings.lanKey, undefined)
  assert.equal(settings.codexWarmup, '')
  assert.ok((await verifySnapshots(opts.runtime)).every(s => s.originalUnchanged && s.copyUnchanged))
  await assert.rejects(prepare(opts), /already exists/)
})

test('catalog mapping preserves audited metadata without declaring unverified protocol capabilities', () => {
  const [model] = mapCatalog(catalog)
  assert.equal(model.Context, 123456)
  assert.equal(model.Output, 2345)
  assert.equal(model.Images, true)
  assert.deepEqual(model.Efforts, ['low', 'max'])
  assert.equal(model.APIs, undefined)
  assert.throws(() => mapCatalog({ ...catalog, models: [] }), /empty/)
  assert.throws(() => mapCatalog({ ...catalog, models: [...catalog.models, ...catalog.models] }), /duplicate/)
})

test('migration refuses sensitive profiles and never follows snapshot symlinks', async t => {
  const opts = await fixture(t)
  await fs.writeFile(path.join(opts.source, 'profiles.json'), JSON.stringify({
    work: { library: { env: { ANTHROPIC_AUTH_TOKEN: 'fixture-private-value' } } },
  }))
  await fs.unlink(path.join(opts.source, 'usage.jsonl'))
  await fs.symlink(path.join(opts.source, 'providers.json'), path.join(opts.source, 'usage.jsonl'))
  const manifest = await prepare(opts)
  assert.ok(manifest.warnings.some(w => w.startsWith('profiles.json:')))
  assert.ok(manifest.warnings.some(w => w.startsWith('usage.jsonl:')))
  assert.deepEqual(manifest.snapshots, [])
})

test('endpoint validation rejects embedded credentials, unsafe HTTP, query and non-HTTP schemes', () => {
  for (const url of ['https://user:pass@example.com', 'https://example.com?key=x',
    'http://example.com', 'file:///tmp/key', 'https://example.com#token']) assert.throws(() => endpoint(url))
  assert.equal(endpoint('http://127.0.0.1:8080/v1/'), 'http://127.0.0.1:8080/v1')
})

test('child HOME and config directories are isolated and environment secrets are not forwarded', () => {
  const env = childEnvironment('/tmp/magpie-runtime', { gatewayPort: 3465 }, 'ephemeral-admin-key')
  assert.equal(env.HOME, '/tmp/magpie-runtime/home')
  assert.equal(env.XDG_CONFIG_HOME, '/tmp/magpie-runtime/home/.config')
  assert.equal(env.CROSERY_API_KEY, undefined)
  assert.equal(env.CODEX_HOME, undefined)
  assert.equal(env.MAGPIE_NO_STATS, '1')
})

test('runtime credentials resolve from private originals/injected env, never the generated configuration', async t => {
  const opts = await fixture(t)
  const manifest = await prepare(opts)
  const providers = await runtimeProviders(manifest, { CROSERY_API_KEY: 'ephemeral-crosery-key' })
  assert.equal(providers.get('crosery').key, 'ephemeral-crosery-key')
  assert.equal(providers.get('relay').key, 'fixture-secret-not-for-output')
  const keyPath = path.join(path.dirname(opts.runtime), 'public-key')
  await fs.writeFile(keyPath, 'fixture-key', { mode: 0o644 })
  await assert.rejects(runtimeProviders(manifest, { CROSERY_API_KEY_FILE: keyPath }), /private regular/)
})

async function bridges(t, upstreamHandler, options = {}) {
  const upstream = http.createServer(upstreamHandler)
  upstream.listen(0, '127.0.0.1')
  await once(upstream, 'listening')
  const base = `http://127.0.0.1:${upstream.address().port}`
  const providers = new Map([['crosery', { key: 'fixture-upstream-key',
    chat: base + '/v1', responses: base + '/v1', anthropic: base }]])
  const reserve = http.createServer()
  reserve.listen(0, '127.0.0.1')
  await once(reserve, 'listening')
  const port = reserve.address().port
  await new Promise(resolve => reserve.close(resolve))
  const bridge = createBridge({ providers, port, models: mapCatalog(catalog), ...options })
  bridge.listen(port, '127.0.0.1')
  await once(bridge, 'listening')
  t.after(async () => {
    bridge.closeAllConnections()
    upstream.closeAllConnections()
    await Promise.all([new Promise(r => bridge.close(r)), new Promise(r => upstream.close(r))])
  })
  return `http://127.0.0.1:${port}`
}

test('bridge preserves native paths, bodies, reasoning, tools and statuses across three protocols', async t => {
  const seen = []
  const base = await bridges(t, (req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      seen.push({ url: req.url, body, authorization: req.headers.authorization,
        key: req.headers['x-api-key'], cookie: req.headers.cookie })
      res.writeHead(req.url.includes('count_tokens') ? 429 : 200,
        { 'content-type': 'application/json', 'x-request-id': 'fixture-request-id', 'set-cookie': 'private=1' })
      res.end(body)
    })
  })
  const body = '{"model":"model","reasoning":{"effort":"max"},"tools":[{"type":"function"}]}'
  for (const [route, status] of [
    ['chat/v1/chat/completions', 200], ['responses/v1/responses', 200],
    ['anthropic/v1/messages', 200], ['anthropic/v1/messages/count_tokens', 429],
    ['chat/v1/images/generations', 200], ['chat/v1/images/edits', 200],
  ]) {
    const res = await fetch(`${base}/p/crosery/${route}`, {
      method: 'POST', headers: { authorization: 'Bearer slot-0', cookie: 'private-client=1',
        'content-type': 'application/json' }, body,
    })
    assert.equal(res.status, status)
    assert.equal(await res.text(), body)
    assert.equal(res.headers.get('x-request-id'), 'fixture-request-id')
    assert.equal(res.headers.get('set-cookie'), null)
  }
  assert.deepEqual(seen.map(s => s.url), ['/v1/chat/completions', '/v1/responses',
    '/v1/messages', '/v1/messages/count_tokens', '/v1/images/generations', '/v1/images/edits'])
  assert.equal(seen[0].authorization, 'Bearer fixture-upstream-key')
  assert.equal(seen[2].key, 'fixture-upstream-key')
  assert.ok(seen.every(s => s.cookie === undefined))
})

test('bridge delivers streaming SSE before upstream completes and serves models without external requests', async t => {
  let finish
  let upstreamCalls = 0
  const base = await bridges(t, (_req, res) => {
    upstreamCalls++
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: {"delta":"hello"}\n\n')
    finish = () => res.end('data: [DONE]\n\n')
  })
  const listed = await fetch(base + '/models')
  assert.equal((await listed.json()).data[0].id, 'model')
  assert.equal(upstreamCalls, 0)
  const res = await fetch(base + '/p/crosery/chat/v1/chat/completions', {
    method: 'POST', headers: { authorization: 'Bearer slot-0' }, body: '{"stream":true}',
  })
  const reader = res.body.getReader()
  const first = await reader.read()
  assert.ok(new TextDecoder().decode(first.value).includes('hello'))
  finish()
  let tail = ''
  for (let part = await reader.read(); !part.done; part = await reader.read()) {
    tail += new TextDecoder().decode(part.value)
  }
  assert.ok(tail.includes('[DONE]'))
})

test('bridge rejects foreign origin/host, key slots, arbitrary routes and oversized uploads', async t => {
  const base = await bridges(t, (_req, res) => res.end('{}'), { maxBytes: 10 })
  assert.equal((await fetch(base + '/health', { headers: { origin: 'https://evil.example' } })).status, 403)
  const wrongHostStatus = await new Promise((resolve, reject) => {
    http.get(base + '/health', { headers: { host: 'evil.example' } }, res => {
      res.resume()
      resolve(res.statusCode)
    }).once('error', reject)
  })
  assert.equal(wrongHostStatus, 403)
  for (const route of ['/p/crosery/chat/v1/management', '/p/unknown/chat/v1/chat/completions']) {
    assert.equal((await fetch(base + route, { method: 'POST' })).status, 404)
  }
  const route = base + '/p/crosery/chat/v1/chat/completions'
  assert.equal((await fetch(route, { method: 'POST', body: '{}' })).status, 401)
  assert.equal((await fetch(route, { method: 'POST', headers: { authorization: 'Bearer slot-0' },
    body: '12345678901' })).status, 413)
})

test('bridge aborts a stalled upstream and does not expose its errors', async t => {
  const base = await bridges(t, () => {}, { timeoutMs: 25 })
  const res = await fetch(base + '/p/crosery/chat/v1/chat/completions', {
    method: 'POST', headers: { authorization: 'Bearer slot-0' }, body: '{}',
  })
  assert.equal(res.status, 502)
  assert.equal((await res.json()).error.code, 'upstream_unavailable')
})
