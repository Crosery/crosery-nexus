import './testDataDir.js'
import assert from 'node:assert/strict'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import { createServer, type Server } from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import cookieParser from 'cookie-parser'
import express from 'express'
import { FakeCpa } from './testing/proxyFakeCpa.js'
import { startSocksNode, writeRelayMihomo } from './testing/fakeMihomoRelay.js'

/**
 * The two halves together (PROXY-SPEC §2, §4, §6, §7): paste a Clash ss node → preview → import → the managed kernel
 * exposes it as an authenticated socks5 port → assign it to a CPA account → 「立即检测」 goes through that port and the
 * node → the pool view shows the health. Everything over the real `/api/proxies` routes, behind the session guard.
 *
 * - always: the relay fake mihomo (`testing/fakeMihomoRelay.ts`) carries the traffic to an in-test socks5 "node" that
 *   checks the node password, so a wrong secret or a wrong listener breaks like it would with mihomo;
 * - `PROXY_E2E=1`: the real mihomo binary, and a second throwaway mihomo as the remote shadowsocks server.
 * All sockets are on 127.0.0.1; no upstream service is contacted.
 */

const fake = await new FakeCpa().start()
process.env.CPA_BASE_URL = fake.base
process.env.CPA_MANAGEMENT_KEY = fake.key
process.env.SESSION_SECRET ||= 'proxy-pipeline-secret'
delete process.env.PROXY_PRESETS
delete process.env.PROXY_LISTENER_AUTH
delete process.env.PROXY_CPA_SAME_HOST

async function isFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)))
  })
}

async function freeRange(count: number): Promise<number> {
  for (let base = 36_000 + Math.floor(Math.random() * 8_000); base < 60_000; base += count + 7) {
    let free = true
    for (let port = base; port < base + count && free; port++) free = await isFree(port)
    if (free) return base
  }
  throw new Error('no free port range')
}

const portBase = await freeRange(10)
process.env.PROXY_PORT_BASE = String(portBase)
process.env.PROXY_PORT_COUNT = '10'

const auth = await import('./auth.js')
const { ProxyPoolStore } = await import('./proxyPoolStore.js')
const { createProxyService, registerProxyRoutes } = await import('./proxyRoutes.js')
const { attachProxyChecker, attachProxyKernel } = await import('./proxyPoolHooks.js')
const { resetControlPlaneCacheForTests } = await import('./proxyPoolControl.js')
const { startManagedMihomo } = await import('./mihomoPool.js')
const { MihomoKernel } = await import('./mihomoKernel.js')
const { resolveMihomoBinary } = await import('./mihomoBinary.js')
const { installProxyChecks } = await import('./proxyCheckPool.js')
const { ProxyChecker, ProxyHealthStore } = await import('./proxyCheck.js')
const { SyncRegistry } = await import('./syncRegistry.js')
const { parseProxyEndpoint, probeRequest } = await import('./proxyCheckClient.js')

const ADMIN = `${auth.SESSION_COOKIE}=${auth.createSessionToken({ role: 'admin' })}`
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-pipeline-'))
const cleanups: Array<() => Promise<unknown> | unknown> = []

test.after(async () => {
  for (const cleanup of cleanups.reverse()) await Promise.resolve(cleanup()).catch(() => undefined)
  attachProxyKernel(null)
  attachProxyChecker(null)
  auth.setKeySessionLookup(null)
  await fake.stop()
  fs.rmSync(root, { recursive: true, force: true })
})

async function listen(server: Server): Promise<number> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())))
  return (server.address() as net.AddressInfo).port
}

/** The in-test "internet": a trace endpoint and the per-service hosts, all on one loopback HTTP server. */
async function startTargets() {
  const hits: string[] = []
  const server = createServer((req, res) => {
    hits.push(String(req.url))
    if (req.url === '/cdn-cgi/trace') return void res.writeHead(200, { 'content-type': 'text/plain' }).end('fl=1\nip=203.0.113.9\nloc=JP\n')
    if (req.url === '/v1/models') return void res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"unauthorized"}')
    res.writeHead(200, { 'content-type': 'text/html' }).end('<html>ok</html>')
  })
  const port = await listen(server)
  const url = (route: string) => `http://127.0.0.1:${port}${route}`
  return {
    hits,
    targets: [
      { service: 'exit' as const, url: url('/cdn-cgi/trace') },
      { service: 'claude' as const, url: url('/v1/models') },
      { service: 'claude' as const, url: url('/login') },
      { service: 'openai' as const, url: url('/v1/models') },
      { service: 'google' as const, url: url('/') },
    ],
  }
}

type BinaryOk = { ok: true; source: 'env' | 'bundle' | 'path'; sourcePath: string; runPath: string; copied: boolean; version: string }

async function harness(binary: BinaryOk, label: string) {
  fake.credentials.clear()
  fake.credentials.set('c1.json', { name: 'c1.json', type: 'claude', email: 'one@example.test', proxy_url: '' })
  fake.globalProxy = ''
  fake.compat = []
  fake.providerKeys = {}
  fake.requests.length = 0
  resetControlPlaneCacheForTests()
  auth.setKeySessionLookup(() => 'active')

  const dir = fs.mkdtempSync(path.join(root, `${label}-`))
  const store = new ProxyPoolStore(path.join(dir, 'proxy'))
  const kernel = new MihomoKernel({
    dir: path.join(dir, 'proxy', 'mihomo'),
    env: { PATH: process.env.PATH, PROXY_PORT_BASE: String(portBase), PROXY_PORT_COUNT: '10' },
    resolveBinary: async () => binary,
    debounceMs: 5,
    log: () => undefined,
  })
  cleanups.push(() => kernel.stop())
  await startManagedMihomo({ kernel, store, signals: false })

  const target = await startTargets()
  const registry = new SyncRegistry({ file: null, setTimer: () => 0 as unknown as ReturnType<typeof setTimeout>, clearTimer: () => undefined, log: () => undefined })
  const checker = new ProxyChecker({
    store: new ProxyHealthStore(store.healthFile),
    limiter: { run: task => task() },
    targets: target.targets,
    requestOptions: { connectTimeoutMs: 3_000, totalTimeoutMs: 6_000 },
  })
  installProxyChecks({ registry, store, checker })

  const audits: string[] = []
  const service = createProxyService({ store, audit: (action, targetId, details) => audits.push(`${action} ${targetId} ${details}`) })
  const app = express()
  app.use(express.json({ limit: '1mb' }))
  app.use(cookieParser())
  app.use(auth.createSessionGuard(app))
  registerProxyRoutes(app, service)
  const base = `http://127.0.0.1:${await listen(createServer(app))}`
  const bodies: string[] = []
  const send = async (method: string, url: string, body?: unknown) => {
    const response = await fetch(`${base}${url}`, {
      method, headers: { 'content-type': 'application/json', cookie: ADMIN },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await response.text()
    bodies.push(text)
    return { status: response.status, body: JSON.parse(text) as Record<string, any> }
  }
  return { store, kernel, target, send, bodies, audits }
}

async function waitFor<T>(read: () => Promise<T>, ok: (value: T) => boolean, ms = 10_000): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const value = await read()
    if (ok(value)) return value
    if (Date.now() > deadline) throw new Error(`timed out: ${JSON.stringify((value as any)?.body?.entries ?? value).slice(0, 900)}`)
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

/**
 * Paste → import → kernel → assign → check, then the negative path: a wrong node password breaks the same port
 * (the node refuses it) and the check says so.
 */
async function runPipeline(h: Awaited<ReturnType<typeof harness>>, node: { server: string; port: number; password: string; cipher: string }) {
  const yaml = [
    'mixed-port: 7890',
    'proxies:',
    `  - {name: 东京 ss, type: ss, server: ${node.server}, port: ${node.port}, cipher: ${node.cipher}, password: "${node.password}", udp: false}`,
    'rules:',
    '  - MATCH,DIRECT',
    '',
  ].join('\n')
  const preview = await h.send('POST', '/api/proxies/parse', { text: yaml })
  assert.equal(preview.status, 200, JSON.stringify(preview.body))
  assert.equal(preview.body.format, 'clash')
  assert.deepEqual(preview.body.ignoredSections.includes('rules'), true)
  const row = preview.body.rows.find((item: any) => item.name === '东京 ss')
  // a loopback server reads like a subscription banner row: hidden by default, importable when picked
  assert.equal(row.status, 'info')
  assert.equal(row.kind, 'mihomo')

  const imported = await h.send('POST', '/api/proxies/import', { previewId: preview.body.previewId, keys: [row.key] })
  assert.equal(imported.status, 200, JSON.stringify(imported.body))
  assert.equal(imported.body.added, 1)
  const id = imported.body.ids[0] as string
  const entry = imported.body.entries.find((item: any) => item.id === id)
  assert.equal(entry.kind, 'mihomo')
  assert.equal(entry.protocol, 'ss')
  assert.ok(entry.port >= portBase && entry.port < portBase + 10, `port ${entry.port} in the managed range`)

  // the kernel picks it up (validate → reload → listener verified) and the pool marks it ok
  const ready = await waitFor(() => h.send('GET', '/api/proxies'), (view) => view.body.kernel.state === 'running'
    && view.body.entries.find((item: any) => item.id === id)?.validity === 'ok')
  assert.equal(ready.body.summary.mihomo, 1)
  assert.equal(ready.body.entries[0].assignable, true)
  const config = fs.readFileSync(path.join(h.store.dir, 'mihomo', 'config.yaml'), 'utf8')
  assert.ok(config.includes(`"port": ${entry.port}`) && config.includes(`"server": "${node.server}"`), 'the pasted node is in the running config')

  // assign it to a CPA account: the account gets the authenticated local socks5 URL through the existing writer
  const assigned = await h.send('POST', '/api/proxies/assign', { target: id, accounts: ['cpa:c1.json'], confirm: true })
  assert.equal(assigned.status, 200, JSON.stringify(assigned.body))
  assert.equal(assigned.body.updated, 1)
  const accountUrl = String(fake.credentials.get('c1.json')?.proxy_url)
  const endpoint = new URL(accountUrl)
  assert.equal(endpoint.protocol, 'socks5:')
  assert.equal(endpoint.hostname, '127.0.0.1')
  assert.equal(Number(endpoint.port), entry.port)
  assert.ok(endpoint.username && endpoint.password, 'listener credential is part of the account URL')
  const listenerPassword = decodeURIComponent(endpoint.password)

  // the exact path the account uses carries traffic
  const direct = await probeRequest(parseProxyEndpoint(accountUrl), h.target.targets[0].url, { connectTimeoutMs: 3_000, totalTimeoutMs: 6_000 })
  assert.equal(direct.status, 200)
  assert.match(direct.body, /loc=JP/)
  // without the listener credential the port refuses
  const anonymous = await probeRequest({ kind: 'socks5', host: '127.0.0.1', port: entry.port }, h.target.targets[0].url).then(() => null, (error: unknown) => error)
  assert.equal((anonymous as { code?: string } | null)?.code, 'proxy-auth-failed')

  // 立即检测 through the port; the pool view shows the result
  const tested = await h.send('POST', `/api/proxies/${id}/test`, {})
  assert.equal(tested.status, 202, JSON.stringify(tested.body))
  assert.equal(tested.body.skipped, null)
  assert.equal(tested.body.health.exit.country, 'JP')
  const view = await h.send('GET', '/api/proxies')
  const checked = view.body.entries.find((item: any) => item.id === id)
  assert.equal(checked.usedBy.total, 1)
  assert.equal(checked.health.exit.ip, '203.0.113.9')
  assert.equal(checked.health.exit.country, 'JP')
  assert.equal(checked.health.services.claude.state, 'auth-expected')
  assert.equal(checked.health.services.openai.state, 'auth-expected')
  assert.equal(checked.health.services.google.state, 'ok')
  assert.ok(h.target.hits.includes('/cdn-cgi/trace'))
  const accounts = await h.send('GET', '/api/proxies/accounts')
  const row1 = accounts.body.accounts.find((item: any) => item.ref === 'cpa:c1.json')
  assert.equal(row1.entryId, id)

  // a repeat within 60 s is served from the stored result (no second round of requests)
  const hitsBefore = h.target.hits.length
  const again = await h.send('POST', `/api/proxies/${id}/test`, {})
  assert.equal(again.body.cached, true)
  assert.equal(h.target.hits.length, hitsBefore)

  // nothing secret left the server: node password, listener password, management key
  for (const text of h.bodies) {
    for (const secret of [node.password, listenerPassword, fake.key]) assert.equal(text.includes(secret), false, `secret in ${text.slice(0, 120)}`)
  }
  for (const line of h.audits) assert.equal(/:\/\/|127\.0\.0\.1|password/.test(line), false, line)
  return { id, port: entry.port as number, accountUrl }
}

test('pipeline (relay kernel): Clash ss paste → import → managed port → assign to a CPA account → check through the node', { timeout: 30_000 }, async () => {
  const relay = writeRelayMihomo(path.join(root, 'bin'))
  const nodePassword = `node-${crypto.randomBytes(6).toString('hex')}`
  const node = await startSocksNode(nodePassword)
  cleanups.push(() => node.close())
  const h = await harness({ ok: true, source: 'env', sourcePath: relay, runPath: relay, copied: false, version: '1.19.31' }, 'relay')
  const { id, port } = await runPipeline(h, { server: '127.0.0.1', port: node.port, password: nodePassword, cipher: 'aes-128-gcm' })
  assert.ok(node.requested.length >= 5, 'every check request went through the pasted node')

  // the same server with a wrong password is a different exit (the credential is part of the dedup key): it gets its
  // own port, the kernel serves it, and the check reports the node, not the listener, as broken
  const wrong = await h.send('POST', '/api/proxies/parse', { text: `proxies:\n  - {name: 东京 ss 旧密码, type: ss, server: 127.0.0.1, port: ${node.port}, cipher: aes-128-gcm, password: "stale-password"}\n` })
  const wrongRow = wrong.body.rows[0]
  const added = await h.send('POST', '/api/proxies/import', { previewId: wrong.body.previewId, keys: [wrongRow.key] })
  const wrongId = added.body.ids[0] as string
  assert.notEqual(wrongId, id)
  const wrongEntry = await waitFor(() => h.send('GET', '/api/proxies'), view => view.body.entries.find((item: any) => item.id === wrongId)?.validity === 'ok')
  const wrongPort = wrongEntry.body.entries.find((item: any) => item.id === wrongId).port
  assert.notEqual(wrongPort, port)
  const failed = await h.send('POST', `/api/proxies/${wrongId}/test`, {})
  assert.equal(failed.status, 202)
  assert.notEqual(failed.body.health.exit.state, 'ok')
  assert.equal(failed.body.health.exit.ip, null)

  // the first entry keeps its port across the reload, and an in-use entry cannot be switched off without a reassign
  const after = (await h.send('GET', '/api/proxies')).body.entries.find((item: any) => item.id === id)
  assert.equal(after.port, port)
  const disable = await h.send('PATCH', `/api/proxies/${id}`, { enabled: false })
  assert.equal(disable.status, 409)
  assert.equal(disable.body.code, 'proxy_in_use')
})

const e2e = process.env.PROXY_E2E === '1'
const hasOpenssl = (() => { try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); return true } catch { return false } })()

test('pipeline (real mihomo, PROXY_E2E=1): a pasted ss node served by a throwaway mihomo, checked through the managed port', { timeout: 60_000, skip: e2e ? false : 'set PROXY_E2E=1 to run' }, async (t) => {
  const binary = await resolveMihomoBinary({ dir: path.join(root, 'e2e-bin') })
  if (!binary.ok) return t.skip(`no mihomo binary (${binary.reason})`)
  if (!hasOpenssl) return t.skip('openssl not installed')
  const serverDir = path.join(root, 'ss-server')
  fs.mkdirSync(serverDir, { recursive: true, mode: 0o700 })
  const ssPassword = crypto.randomBytes(12).toString('hex')
  const free = async () => { const s = net.createServer(); await new Promise<void>(r => s.listen(0, '127.0.0.1', r)); const p = (s.address() as net.AddressInfo).port; await new Promise<void>(r => s.close(() => r())); return p }
  const [ssPort, controllerPort] = [await free(), await free()]
  fs.writeFileSync(path.join(serverDir, 'config.yaml'), JSON.stringify({
    'mixed-port': 0, 'allow-lan': false, 'bind-address': '127.0.0.1', mode: 'direct', 'log-level': 'warning', ipv6: false,
    'external-controller': `127.0.0.1:${controllerPort}`, secret: crypto.randomBytes(16).toString('hex'),
    profile: { 'store-selected': false, 'store-fake-ip': false }, dns: { enable: false }, tun: { enable: false },
    listeners: [{ name: 'ss-in', type: 'shadowsocks', port: ssPort, listen: '127.0.0.1', password: ssPassword, cipher: 'aes-128-gcm' }],
    rules: ['MATCH,DIRECT'],
  }), { mode: 0o600 })
  const log = fs.openSync(path.join(serverDir, 'out.log'), 'a', 0o600)
  const server: ChildProcess = spawn(binary.runPath, ['-d', serverDir, '-f', path.join(serverDir, 'config.yaml')], { stdio: ['ignore', log, log], env: { PATH: process.env.PATH, HOME: serverDir, SAFE_PATHS: '' } })
  fs.closeSync(log)
  cleanups.push(() => server.kill('SIGTERM'))
  await waitFor(async () => !(await isFree(ssPort)), Boolean, 5_000)

  const h = await harness(binary, 'e2e')
  const result = await runPipeline(h, { server: '127.0.0.1', port: ssPort, password: ssPassword, cipher: 'aes-128-gcm' })
  // every socket the managed kernel holds is on loopback
  const pid = h.kernel.status().pid
  assert.ok(pid)
  const sockets = execFileSync('lsof', ['-nP', '-a', '-p', String(pid), '-i'], { encoding: 'utf8' }).split('\n').slice(1).filter(Boolean)
  for (const line of sockets) assert.ok(!/\*:\d+|0\.0\.0\.0:|\[::\]:/.test(line), line)
  assert.ok(result.port >= portBase)
})

test('kernelNode: the entry protocol goes back into the node as mihomo `type` (https → http + tls)', async () => {
  const { kernelNode } = await import('./mihomoPool.js')
  const base = { id: 'px_aaaaaaaaaa', name: 'n', nameAuto: false, kind: 'mihomo' as const, server: 'h.example.test', serverPort: 443, fingerprint: 'f', source: 'clash' as const, tags: [], enabled: true, validity: 'ok' as const, createdAt: '', updatedAt: '' }
  assert.equal(kernelNode({ ...base, protocol: 'vless', node: { server: 'h.example.test', port: 443, uuid: 'u' } } as never).type, 'vless')
  const https = kernelNode({ ...base, protocol: 'https', node: { server: 'h.example.test', port: 443, tls: true } } as never)
  assert.equal(https.type, 'http')
  assert.equal(https.tls, true)
  assert.equal(kernelNode({ ...base, protocol: 'ss', node: { type: 'ss', server: 'h', port: 1 } } as never).type, 'ss')
})
