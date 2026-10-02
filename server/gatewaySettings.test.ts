import './testDataDir.js'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createServer, type Server } from 'node:http'
import test from 'node:test'
import cookieParser from 'cookie-parser'
import express from 'express'

process.env.SESSION_SECRET ||= 'gateway-settings-unit-secret'

const auth = await import('./auth.js')
const { createGatewaySettingsService, registerGatewaySettingsRoutes, settingsFromKernel, IMAGE_ROUTES_ADMITTED } = await import('./gatewaySettings.js')

const ADMIN = `${auth.SESSION_COOKIE}=${auth.createSessionToken({ role: 'admin' })}`
const KEY = `${auth.SESSION_COOKIE}=${auth.createSessionToken({ role: 'key', keyHash: 'b'.repeat(64) })}`
const LAN_KEY = 'sk-magpie-' + 'ab'.repeat(20)

/** A stand-in for the kernel's /internal/settings on a unix socket: partial merge, Magpie-style refusals. */
async function fakeKernel(options: { old?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gws-'))
  const socket = path.join(dir, 'k.sock')
  const state: Record<string, unknown> = { redact: false, redactPersonal: false, redactWords: [], redactRules: [], vision: '', imageGen: '' }
  const calls: Array<{ method: string; body: unknown }> = []
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined
    calls.push({ method: req.method || '', body })
    const send = (status: number, value: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)) }
    if (options.old || req.url !== '/internal/settings') return send(404, { error: 'no such kernel route', code: 'not_found' })
    if (req.method === 'POST') {
      const rules = (body.redactRules ?? []) as Array<{ regex?: string }>
      if (rules.some(rule => rule.regex === '(')) return send(400, { error: "the masking rule CUSTOM has a regular expression that doesn't work: missing closing )", code: 'invalid_setting' })
      Object.assign(state, body)
    }
    send(200, {
      ...state, lanKey: undefined,
      visionAuto: 'c-1/gpt-4o-mini', imageGenAuto: 'c-2/gpt-image-1',
      visionEffective: state.vision === 'off' ? '' : state.vision || 'c-1/gpt-4o-mini',
      imageGenEffective: state.imageGen === 'off' ? '' : state.imageGen === 'c-9/gone' ? 'c-2/gpt-image-1' : state.imageGen || 'c-2/gpt-image-1',
      visionModels: [{ id: 'c-1/gpt-4o-mini', name: 'gpt-4o-mini', providerName: 'OpenAI 兼容' }],
      imageGenModels: [{ id: 'c-2/gpt-image-1', name: 'gpt-image-1', providerName: '绘图' }],
      models: [
        { id: 'c-1/gpt-4o-mini', name: 'gpt-4o-mini', providerName: 'OpenAI 兼容' },
        { id: 'c-3/seedream-4', name: 'seedream-4', providerName: '豆包' },
        { id: 'c-2/gpt-image-1', name: 'gpt-image-1', providerName: '绘图' },
      ],
      telemetry: { off: true, forced: true, sender: false }, applies: 'next-request',
    })
  })
  await new Promise<void>(resolve => server.listen(socket, resolve))
  return { socket, state, calls, close: () => new Promise<void>(resolve => server.close(() => { fs.rmSync(dir, { recursive: true, force: true }); resolve() })) }
}

async function harness(socket: string, magpie = true) {
  auth.setKeySessionLookup(() => 'active')
  const audits: Array<[string, string, string]> = []
  const service = createGatewaySettingsService({
    socket: () => socket, magpie: () => magpie,
    audit: (action, target, details) => audits.push([action, target, details]),
    upstream: () => ({ candidateRevision: 'c'.repeat(40), added: ['webSearch'], changed: ['vision'], removed: [] }),
    kind: id => (/image|seedream/.test(id) ? 'image' : 'chat'),
  })
  const app = express()
  app.use(express.json({ limit: '1mb' }))
  app.use(cookieParser())
  app.use(auth.createSessionGuard(app))
  registerGatewaySettingsRoutes(app, service)
  const server: Server = createServer(app)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  const send = async (method: string, body?: unknown, cookie: string | null = ADMIN) => {
    const response = await fetch(`${base}/api/gateway/settings`, {
      method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await response.text()
    return { status: response.status, text, body: JSON.parse(text) as Record<string, any> }
  }
  return { audits, send, close: async () => { auth.setKeySessionLookup(null); await new Promise<void>(resolve => server.close(() => resolve())) } }
}

test('admin only: key sessions get 403 and anonymous 401; the kernel is never reached', async () => {
  const kernel = await fakeKernel()
  const h = await harness(kernel.socket)
  try {
    for (const [method, body] of [['GET', undefined], ['PUT', { redact: true }]] as const) {
      assert.equal((await h.send(method, body, KEY)).status, 403)
      assert.equal((await h.send(method, body, null)).status, 401)
    }
    assert.equal(kernel.calls.length, 0)
  } finally { await h.close(); await kernel.close() }
})

test('GET merges the kernel values with Magpie copy; 生图 options are drawers plus kind=image gateway models', async () => {
  const kernel = await fakeKernel()
  const h = await harness(kernel.socket)
  try {
    const { status, body, text } = await h.send('GET')
    assert.equal(status, 200)
    assert.equal(body.available, true)
    assert.equal(body.revision, '3fe2ff99587e17dfe0ea707ffd0eccc088824433')
    assert.equal(body.catalog.items.find((item: { key: string }) => item.key === 'redact').name.zh, '脱敏密钥')
    assert.deepEqual(body.models.imageGen.options.map((option: { id: string }) => option.id), ['c-2/gpt-image-1', 'c-3/seedream-4'])
    assert.deepEqual(body.models.vision.options.map((option: { id: string }) => option.id), ['c-1/gpt-4o-mini'])
    assert.equal(body.models.imageGen.admitted, IMAGE_ROUTES_ADMITTED)
    assert.deepEqual(body.telemetry, { off: true, forced: true })
    assert.deepEqual(body.upstream.added, ['webSearch'])
    assert.ok(!text.includes(LAN_KEY) && !text.includes('lanKey'))
  } finally { await h.close(); await kernel.close() }
})

test('PUT validates, forwards only the whitelisted keys, audits without the words, and reports kernel refusals', async () => {
  const kernel = await fakeKernel()
  const h = await harness(kernel.socket)
  try {
    const ok = await h.send('PUT', { redact: true, redactWords: [' 项目代号 ', '项目代号', 'acme'], redactRules: [{ kind: 'gw', prefix: 'oc_sk_' }] })
    assert.equal(ok.status, 200)
    assert.equal(ok.body.values.redact, true)
    assert.deepEqual(kernel.calls.at(-1)?.body, { redact: true, redactWords: ['项目代号', 'acme'], redactRules: [{ kind: 'gw', prefix: 'oc_sk_' }] })
    assert.deepEqual(h.audits.at(-1), ['gateway_settings', 'redact,redactWords,redactRules', 'redact=on, redactWords=2项, redactRules=1项, outcome=ok'])
    assert.ok(!JSON.stringify(h.audits).includes('项目代号'))

    const before = kernel.calls.length
    for (const [body, code] of [
      [{ lanKey: 'x' }, 'unknown_setting'], [{ noStats: false }, 'unknown_setting'], [{}, 'invalid_setting'],
      [{ redact: 'yes' }, 'invalid_setting'], [{ redactWords: ['a'] }, 'invalid_setting'],
      [{ redactWords: Array.from({ length: 101 }, (_, i) => `word-${i}`) }, 'invalid_setting'],
      [{ redactRules: [{ kind: 'x', prefix: 'ab' }] }, 'invalid_setting'],
      [{ redactRules: [{ kind: 'x', prefix: 'abc', regex: 'abc' }] }, 'invalid_setting'],
      [{ redactRules: [{ kind: 'x', regex: 'a'.repeat(301) }] }, 'invalid_setting'],
      [{ redactRules: Array.from({ length: 33 }, (_, i) => ({ kind: 'k', prefix: `pre${i}` })) }, 'invalid_setting'],
      [{ vision: 'no-slash' }, 'invalid_setting'],
    ] as const) {
      const refused = await h.send('PUT', body)
      assert.equal(refused.status, 400, JSON.stringify(body))
      assert.equal(refused.body.code, code, JSON.stringify(body))
    }
    assert.equal(kernel.calls.length, before, 'refused bodies never reach the kernel')

    const bad = await h.send('PUT', { redactRules: [{ kind: '', regex: '(' }] })
    assert.equal(bad.status, 400)
    assert.match(bad.body.error, /^内核拒绝：.*regular expression/)
    assert.match(h.audits.at(-1)?.[2] ?? '', /outcome=error, code=invalid_setting/)

    const stale = await h.send('PUT', { imageGen: 'c-9/gone' })
    assert.equal(stale.body.models.imageGen.stale, true)
    assert.equal(stale.body.models.imageGen.effective, 'c-2/gpt-image-1')
  } finally { await h.close(); await kernel.close() }
})

test('CPA engine: honest unavailable state, writes refused with 409; an old kernel is reported as outdated', async () => {
  const kernel = await fakeKernel()
  const cpa = await harness(kernel.socket, false)
  try {
    const read = await cpa.send('GET')
    assert.equal(read.status, 200)
    assert.equal(read.body.available, false)
    assert.equal(read.body.reason, 'cpa_engine')
    assert.match(read.body.message, /仅 Magpie 网关可用/)
    assert.ok(read.body.catalog.items.length > 0, 'the catalog still names what Magpie offers')
    assert.equal((await cpa.send('PUT', { redact: true })).status, 409)
    assert.equal(kernel.calls.length, 0)
  } finally { await cpa.close(); await kernel.close() }

  const old = await fakeKernel({ old: true })
  const h = await harness(old.socket)
  try {
    const read = await h.send('GET')
    assert.equal(read.body.available, false)
    assert.equal(read.body.reason, 'kernel_outdated')
    assert.equal((await h.send('PUT', { redact: true })).body.code, 'kernel_outdated')
  } finally { await h.close(); await old.close() }

  const down = await harness('/nonexistent/gws.sock')
  try {
    assert.equal((await down.send('GET')).body.reason, 'kernel_unavailable')
  } finally { await down.close() }
})

test('the console still admits no /v1/images route, so 生图模型 says it has no console client yet', () => {
  const engine = fs.readFileSync(new URL('./magpieEngine.ts', import.meta.url), 'utf8')
  assert.equal(engine.includes('/v1/images'), IMAGE_ROUTES_ADMITTED, 'flip IMAGE_ROUTES_ADMITTED when admission adds /v1/images')
  const view = settingsFromKernel({ imageGen: 'off', imageGenEffective: '', models: [] })
  assert.equal(view.models.imageGen.stale, false)
})
