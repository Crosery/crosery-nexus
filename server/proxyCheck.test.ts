import './testDataDir.js'

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  classifyResponse, entryHealthy, parseTrace, ProxyChecker, ProxyHealthStore, scrubProbeText, worstState,
  type ProbeTargetSpec,
} from './proxyCheck.js'
import { parseProxyEndpoint, probeRequest, ProbeError, type ProxyEndpoint } from './proxyCheckClient.js'

/* ────────────────────────── fixtures ────────────────────────── */

type Closable = { close: () => Promise<void> }
const cleanups: Closable[] = []
test.after(async () => { for (const item of cleanups.reverse()) await item.close().catch(() => undefined) })

function closable(server: net.Server): Closable {
  const sockets = new Set<net.Socket>()
  server.on('connection', (socket: net.Socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
  return { close: () => new Promise<void>(resolve => { for (const socket of sockets) socket.destroy(); server.close(() => resolve()) }) }
}

async function listen(server: net.Server): Promise<number> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(closable(server))
  return (server.address() as net.AddressInfo).port
}

type SocksOptions = { auth?: { username: string; password: string }; rep?: number; hang?: boolean; requested?: string[] }

/** In-test SOCKS5 server: every CONNECT goes to 127.0.0.1:<requested port>, whatever the hostname. */
async function fakeSocks(options: SocksOptions = {}): Promise<number> {
  const server = net.createServer((client) => {
    client.on('error', () => undefined)
    let buffer = Buffer.alloc(0)
    let phase: 'greet' | 'auth' | 'request' | 'piped' = 'greet'
    client.on('data', (chunk: Buffer) => {
      if (phase === 'piped' || options.hang) return
      buffer = Buffer.concat([buffer, chunk])
      for (;;) {
        if (phase === 'greet') {
          if (buffer.length < 2 || buffer.length < 2 + buffer[1]) return
          const methods = [...buffer.subarray(2, 2 + buffer[1])]
          buffer = buffer.subarray(2 + buffer[1])
          if (options.auth) {
            if (!methods.includes(2)) { client.end(Buffer.from([5, 0xff])); return }
            client.write(Buffer.from([5, 2]))
            phase = 'auth'
          } else {
            client.write(Buffer.from([5, 0]))
            phase = 'request'
          }
        } else if (phase === 'auth') {
          if (buffer.length < 2) return
          const ulen = buffer[1]
          if (buffer.length < 3 + ulen) return
          const plen = buffer[2 + ulen]
          if (buffer.length < 3 + ulen + plen) return
          const user = buffer.subarray(2, 2 + ulen).toString()
          const pass = buffer.subarray(3 + ulen, 3 + ulen + plen).toString()
          buffer = buffer.subarray(3 + ulen + plen)
          if (user !== options.auth!.username || pass !== options.auth!.password) { client.end(Buffer.from([1, 1])); return }
          client.write(Buffer.from([1, 0]))
          phase = 'request'
        } else if (phase === 'request') {
          if (buffer.length < 5) return
          const atyp = buffer[3]
          const addressLength = atyp === 1 ? 4 : atyp === 4 ? 16 : buffer[4] + 1
          if (buffer.length < 4 + addressLength + 2) return
          const host = atyp === 3 ? buffer.subarray(5, 5 + buffer[4]).toString() : atyp === 1 ? [...buffer.subarray(4, 8)].join('.') : 'ipv6'
          const port = buffer.readUInt16BE(4 + addressLength)
          buffer = buffer.subarray(4 + addressLength + 2)
          options.requested?.push(`${host}:${port}`)
          if (options.rep) { client.end(Buffer.from([5, options.rep, 0, 1, 0, 0, 0, 0, 0, 0])); return }
          phase = 'piped'
          const upstream = net.connect(port, '127.0.0.1', () => {
            client.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, port >> 8, port & 0xff]))
            if (buffer.length) upstream.write(buffer)
            client.pipe(upstream).pipe(client)
          })
          upstream.on('error', () => client.destroy())
          return
        } else return
      }
    })
  })
  return listen(server)
}

/** In-test HTTP CONNECT proxy (407 on bad credentials, `status` to refuse CONNECT). */
async function fakeConnectProxy(options: { auth?: string; status?: number; requested?: string[] } = {}): Promise<number> {
  const server = http.createServer((_req, res) => { res.writeHead(400).end() })
  server.on('connect', (req: http.IncomingMessage, client: net.Socket, head: Buffer) => {
    client.on('error', () => undefined)
    options.requested?.push(String(req.url))
    const expected = options.auth ? `Basic ${Buffer.from(options.auth).toString('base64')}` : null
    if (expected && req.headers['proxy-authorization'] !== expected) {
      client.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="x"\r\n\r\n')
      return
    }
    if (options.status) { client.end(`HTTP/1.1 ${options.status} Refused\r\n\r\n`); return }
    const port = Number(String(req.url).split(':').pop())
    const upstream = net.connect(port, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) upstream.write(head)
      client.pipe(upstream).pipe(client)
    })
    upstream.on('error', () => client.destroy())
  })
  return listen(server)
}

type Route = { status: number; headers?: Record<string, string>; body?: string }
const ROUTES: Record<string, Route> = {
  '/trace': { status: 200, body: 'fl=1\nh=www.cloudflare.com\nip=203.0.113.7\nts=1\nloc=US\n' },
  '/ok': { status: 200, body: 'ok' },
  '/unauth': { status: 401, body: '{"error":"unauthorized"}' },
  '/method': { status: 405 },
  '/notfound': { status: 404 },
  '/anthropic-region': { status: 403, body: '{"type":"error","error":{"type":"forbidden","message":"Request not allowed"}}' },
  '/openai-region': { status: 403, body: '{"error":{"code":"unsupported_country_region_territory","message":"Country, region, or territory not supported","type":"request_forbidden"}}' },
  '/claude-region': { status: 302, headers: { location: 'https://www.anthropic.com/app-unavailable-in-region' } },
  '/google-region': { status: 400, body: '{"error":{"code":400,"message":"User location is not supported for the API use.","status":"FAILED_PRECONDITION"}}' },
  '/challenge': { status: 403, headers: { 'cf-mitigated': 'challenge' }, body: '<html>Just a moment...</html>' },
  '/blocked': { status: 403, body: 'Forbidden' },
  '/ratelimited': { status: 429 },
  '/sorry': { status: 302, headers: { location: 'https://www.google.com/sorry/index?continue=x' } },
  '/redirect-ok': { status: 302, headers: { location: '/login' } },
  '/server-error': { status: 503 },
  '/big': { status: 200, body: 'x'.repeat(100_000) },
}

function routeHandler(req: http.IncomingMessage, res: http.ServerResponse) {
  const route = ROUTES[String(req.url).split('?')[0]] ?? { status: 404 }
  res.writeHead(route.status, { 'content-type': 'text/plain', ...(route.headers ?? {}) })
  res.end(route.body ?? '')
}

let upstreamPort = 0
async function upstream(): Promise<number> {
  if (!upstreamPort) upstreamPort = await listen(http.createServer(routeHandler))
  return upstreamPort
}

function hasOpenssl(): boolean {
  try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); return true } catch { return false }
}

function selfSigned(): { key: string; cert: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-tls-'))
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1',
    '-subj', '/CN=api.anthropic.test', '-addext', 'subjectAltName=DNS:api.anthropic.test,DNS:localhost',
    '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem')], { stdio: 'ignore' })
  return { key: fs.readFileSync(path.join(dir, 'key.pem'), 'utf8'), cert: fs.readFileSync(path.join(dir, 'cert.pem'), 'utf8') }
}

async function closedPort(): Promise<number> {
  const server = net.createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as net.AddressInfo).port
  await new Promise<void>(resolve => server.close(() => resolve()))
  return port
}

async function failure(promise: Promise<unknown>): Promise<ProbeError> {
  try {
    await promise
  } catch (error) {
    assert.ok(error instanceof ProbeError, String(error))
    return error
  }
  assert.fail('expected a probe failure')
}

/* ────────────────────────── classification ────────────────────────── */

test('classifyResponse: every row of the spec table', () => {
  const cases: Array<[string, ReturnType<typeof classifyResponse>]> = [
    ['/ok', 'ok'], ['/notfound', 'ok'], ['/redirect-ok', 'ok'], ['/server-error', 'service-error'],
    ['/unauth', 'auth-expected'], ['/method', 'auth-expected'],
    ['/anthropic-region', 'region-blocked'], ['/openai-region', 'region-blocked'], ['/claude-region', 'region-blocked'], ['/google-region', 'region-blocked'],
    ['/challenge', 'challenge'],
    ['/blocked', 'blocked'], ['/ratelimited', 'blocked'], ['/sorry', 'blocked'],
  ]
  for (const [route, expected] of cases) {
    const fixture = ROUTES[route]
    assert.equal(classifyResponse({ status: fixture.status, headers: fixture.headers ?? {}, body: fixture.body ?? '' }, 'https://claude.ai/login'), expected, route)
  }
  assert.equal(classifyResponse({ status: 400, headers: {}, body: '{"error":"bad request"}' }), 'auth-expected')
  assert.equal(classifyResponse({ status: 451, headers: {}, body: '' }), 'region-blocked')
  // only 400/401/405 are what an unauthenticated probe expects; any other failure status is not a reachable service
  for (const status of [408, 410, 422, 500, 502, 503, 504]) {
    assert.equal(classifyResponse({ status, headers: {}, body: '' }), 'service-error', String(status))
  }
})

test('a service answering 5xx or an unexpected 4xx is not healthy', () => {
  const at = '2026-10-02T00:00:00.000Z'
  const cell = (state: ReturnType<typeof classifyResponse>, status: number) => ({ state, ms: 10, hosts: [{ host: 'h.test', state, status, ms: 10 }], at })
  const health = (google: ReturnType<typeof cell>) => ({
    lastAt: at, requests: 8,
    exit: { ip: '203.0.113.7', country: 'US', state: 'ok' as const, ms: 10, at },
    services: { claude: cell('auth-expected', 401), openai: cell('ok', 200), google },
  })
  assert.equal(entryHealthy(health(cell('auth-expected', 405))), true)
  for (const status of [408, 410, 500, 503]) {
    assert.equal(entryHealthy(health(cell(classifyResponse({ status, headers: {}, body: '' }), status))), false, String(status))
  }
  assert.equal(worstState(['ok', 'service-error']), 'service-error')
  assert.equal(worstState(['service-error', 'region-blocked']), 'region-blocked')
})

test('parseTrace and worstState', () => {
  assert.deepEqual(parseTrace(ROUTES['/trace'].body!), { ip: '203.0.113.7', country: 'US' })
  assert.deepEqual(parseTrace('ip=2001:db8::1\nloc=XX\n'), { ip: '2001:db8::1', country: null })
  assert.deepEqual(parseTrace('<html>'), { ip: null, country: null })
  assert.equal(worstState(['ok', 'auth-expected', 'challenge']), 'challenge')
  assert.equal(worstState(['region-blocked', 'blocked']), 'region-blocked')
  assert.equal(worstState(['ok', 'proxy-down']), 'proxy-down')
})

test('parseProxyEndpoint: schemes, default ports, percent-decoded credentials, direct', () => {
  assert.deepEqual(parseProxyEndpoint(''), { kind: 'direct' })
  assert.deepEqual(parseProxyEndpoint('direct'), { kind: 'direct' })
  assert.deepEqual(parseProxyEndpoint('socks5h://u%40x:p%3Aw@proxy.example.com'), { kind: 'socks5', host: 'proxy.example.com', port: 1080, username: 'u@x', password: 'p:w' })
  assert.deepEqual(parseProxyEndpoint('https://[2001:db8::1]:8443'), { kind: 'http', tls: true, host: '2001:db8::1', port: 8443 })
  assert.deepEqual(parseProxyEndpoint('http://h.example.com'), { kind: 'http', tls: false, host: 'h.example.com', port: 80 })
  assert.throws(() => parseProxyEndpoint('ftp://x'))
  assert.throws(() => parseProxyEndpoint('not a url'))
})

/* ────────────────────────── client paths ────────────────────────── */

test('socks5 with and without auth: hostname sent unresolved, response read', async () => {
  const target = await upstream()
  const requested: string[] = []
  const open = await fakeSocks({ requested })
  const authed = await fakeSocks({ auth: { username: 'lu', password: 'lp' }, requested })
  const plain = await probeRequest({ kind: 'socks5', host: '127.0.0.1', port: open }, `http://api.openai.test:${target}/openai-region`)
  assert.equal(plain.status, 403)
  assert.equal(classifyResponse(plain), 'region-blocked')
  const withAuth = await probeRequest(parseProxyEndpoint(`socks5://lu:lp@127.0.0.1:${authed}`), `http://exit.test:${target}/trace`)
  assert.deepEqual(parseTrace(withAuth.body), { ip: '203.0.113.7', country: 'US' })
  assert.ok(withAuth.ms >= 0)
  assert.deepEqual(requested, [`api.openai.test:${target}`, `exit.test:${target}`], 'remote DNS: the proxy gets the hostname')
})

test('socks5 failures: wrong password, missing auth, REP codes, hang, refused, unknown host', async () => {
  const target = await upstream()
  const authed = await fakeSocks({ auth: { username: 'lu', password: 'lp' } })
  const wrong = await failure(probeRequest(parseProxyEndpoint(`socks5://lu:nope@127.0.0.1:${authed}`), `http://x.test:${target}/ok`))
  assert.deepEqual([wrong.code, wrong.stage], ['proxy-auth-failed', 'proxy'])
  const missing = await failure(probeRequest({ kind: 'socks5', host: '127.0.0.1', port: authed }, `http://x.test:${target}/ok`))
  assert.equal(missing.code, 'proxy-auth-failed')
  for (const rep of [1, 3, 4, 5]) {
    const port = await fakeSocks({ rep })
    const error = await failure(probeRequest({ kind: 'socks5', host: '127.0.0.1', port }, `http://x.test:${target}/ok`))
    assert.deepEqual([error.code, error.stage], ['upstream', 'target'], `REP ${rep}`)
  }
  const hang = await fakeSocks({ hang: true })
  const timeout = await failure(probeRequest({ kind: 'socks5', host: '127.0.0.1', port: hang }, `http://x.test:${target}/ok`, { connectTimeoutMs: 150, totalTimeoutMs: 300 }))
  assert.deepEqual([timeout.code, timeout.stage], ['timeout', 'proxy'])
  const refused = await failure(probeRequest({ kind: 'socks5', host: '127.0.0.1', port: await closedPort() }, `http://x.test:${target}/ok`))
  assert.deepEqual([refused.code, refused.stage], ['proxy-down', 'proxy'])
  const dns = await failure(probeRequest({ kind: 'socks5', host: 'no-such-proxy.invalid', port: 1080 }, `http://x.test:${target}/ok`))
  assert.deepEqual([dns.code, dns.stage], ['dns', 'proxy'])
})

test('http CONNECT proxy: credentials, 407, refused CONNECT', async () => {
  const target = await upstream()
  const requested: string[] = []
  const proxy = await fakeConnectProxy({ auth: 'pu:pp', requested })
  const ok = await probeRequest(parseProxyEndpoint(`http://pu:pp@127.0.0.1:${proxy}`), `http://claude.test:${target}/claude-region`)
  assert.equal(classifyResponse(ok, 'https://claude.ai/login'), 'region-blocked')
  assert.deepEqual(requested, [`claude.test:${target}`])
  const denied = await failure(probeRequest(parseProxyEndpoint(`http://pu:bad@127.0.0.1:${proxy}`), `http://claude.test:${target}/ok`))
  assert.deepEqual([denied.code, denied.stage], ['proxy-auth-failed', 'proxy'])
  const refusing = await fakeConnectProxy({ status: 502 })
  const refused = await failure(probeRequest(parseProxyEndpoint(`http://127.0.0.1:${refusing}`), `http://claude.test:${target}/ok`))
  assert.deepEqual([refused.code, refused.stage], ['upstream', 'target'])
})

test('https target through the tunnel: verified TLS ok, untrusted cert → tls, early close → upstream', { skip: !hasOpenssl() && 'openssl not installed' }, async () => {
  const { key, cert } = selfSigned()
  const secure = https.createServer({ key, cert }, routeHandler)
  const securePort = await listen(secure)
  const socks = await fakeSocks()
  const endpoint: ProxyEndpoint = { kind: 'socks5', host: '127.0.0.1', port: socks }
  const ok = await probeRequest(endpoint, `https://api.anthropic.test:${securePort}/anthropic-region`, { tls: { ca: cert } })
  assert.equal(classifyResponse(ok), 'region-blocked')
  const untrusted = await failure(probeRequest(endpoint, `https://api.anthropic.test:${securePort}/ok`))
  assert.deepEqual([untrusted.code, untrusted.stage], ['tls', 'target'])
  const slammer = net.createServer(socket => socket.destroy())
  const slamPort = await listen(slammer)
  const closed = await failure(probeRequest(endpoint, `https://api.anthropic.test:${slamPort}/ok`, { tls: { ca: cert } }))
  assert.deepEqual([closed.code, closed.stage], ['upstream', 'target'])
})

test('env proxy variables are ignored (no HTTP_PROXY / ALL_PROXY / NO_PROXY trap)', async () => {
  const target = await upstream()
  const socks = await fakeSocks()
  const saved = { ...process.env }
  const trap = `http://127.0.0.1:${await closedPort()}`
  Object.assign(process.env, { HTTP_PROXY: trap, HTTPS_PROXY: trap, ALL_PROXY: trap, http_proxy: trap, https_proxy: trap, all_proxy: trap, NO_PROXY: '', no_proxy: '' })
  try {
    const viaSocks = await probeRequest({ kind: 'socks5', host: '127.0.0.1', port: socks }, `http://exit.test:${target}/trace`)
    assert.equal(viaSocks.status, 200)
    const direct = await probeRequest({ kind: 'direct' }, `http://127.0.0.1:${target}/ok`)
    assert.equal(direct.status, 200)
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
    Object.assign(process.env, saved)
  }
})

test('body is capped at 16 KiB', async () => {
  const target = await upstream()
  const response = await probeRequest({ kind: 'direct' }, `http://127.0.0.1:${target}/big`)
  assert.equal(response.body.length, 16 * 1024)
})

/* ────────────────────────── checker + store ────────────────────────── */

function storeIn(): { store: ProxyHealthStore; file: string } {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-health-')), 'proxy')
  const file = path.join(dir, 'health.json')
  return { store: new ProxyHealthStore(file), file }
}

async function targetsAt(port: number, routes: Record<string, string> = {}): Promise<ProbeTargetSpec[]> {
  const route = (service: string, fallback: string) => `http://${service}.test:${port}${routes[service] ?? fallback}`
  return [
    { service: 'exit', url: `http://exit.test:${port}/trace` },
    { service: 'claude', url: route('anthropic', '/unauth') },
    { service: 'claude', url: route('claude', '/redirect-ok') },
    { service: 'openai', url: route('openai', '/unauth') },
    { service: 'openai', url: route('chatgpt', '/method') },
    { service: 'openai', url: route('auth', '/ok') },
    { service: 'google', url: route('cloudcode', '/notfound') },
    { service: 'google', url: route('accounts', '/ok') },
  ]
}

function countingLimiter(limit = 4) {
  const state = { active: 0, max: 0, calls: 0 }
  const waiting: Array<() => void> = []
  return {
    state,
    async run<T>(task: () => Promise<T>): Promise<T> {
      state.calls += 1
      if (state.active >= limit) await new Promise<void>(resolve => waiting.push(resolve))
      state.active += 1
      state.max = Math.max(state.max, state.active)
      try { return await task() } finally {
        state.active -= 1
        waiting.shift()?.()
      }
    },
  }
}

test('checker: 8 requests through the limiter, per-service cells, exit ip/country, stored without secrets', async () => {
  const port = await upstream()
  const socks = await fakeSocks({ auth: { username: 'listener-user', password: 'SECRET-LISTENER-PASS' } })
  const { store, file } = storeIn()
  const limiter = countingLimiter()
  const checker = new ProxyChecker({ store, limiter, targets: await targetsAt(port, { openai: '/openai-region' }) })
  const outcome = await checker.check({ id: 'px_abc', proxyUrl: `socks5://listener-user:SECRET-LISTENER-PASS@127.0.0.1:${socks}` })
  assert.equal(outcome.requests, 8)
  assert.equal(limiter.state.calls, 8)
  assert.equal(outcome.cached, false)
  const health = outcome.health
  assert.deepEqual([health.exit.ip, health.exit.country, health.exit.state], ['203.0.113.7', 'US', 'ok'])
  assert.equal(health.services.claude.state, 'auth-expected', 'auth-expected and ok tie; the first host wins')
  assert.equal(health.services.openai.state, 'region-blocked')
  assert.equal(health.services.google.state, 'ok')
  assert.equal(health.services.openai.hosts.length, 3)
  assert.equal(entryHealthy(health), false)
  const text = fs.readFileSync(file, 'utf8')
  for (const leak of ['SECRET-LISTENER-PASS', 'listener-user', 'socks5://']) assert.ok(!text.includes(leak), leak)
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700)
  // reload from disk
  assert.deepEqual(new ProxyHealthStore(file).get('px_abc'), health)
})

test('checker: single-flight, 60 s reuse, short-circuit on a dead proxy', async () => {
  const port = await upstream()
  const socks = await fakeSocks()
  const { store } = storeIn()
  const clock = { now: Date.parse('2026-10-02T00:00:00Z') }
  let requests = 0
  const checker = new ProxyChecker({
    store, limiter: countingLimiter(), now: () => clock.now, targets: await targetsAt(port),
    request: async (proxy, url, options) => { requests += 1; return probeRequest(proxy, url, options) },
  })
  const target = { id: 'px_one', proxyUrl: `socks5://127.0.0.1:${socks}` }
  const [first, second] = await Promise.all([checker.check(target), checker.check(target)])
  assert.equal(first, second)
  assert.equal(requests, 8)
  clock.now += 30_000
  const reused = await checker.check(target)
  assert.equal(reused.cached, true)
  assert.equal(requests, 8)
  clock.now += 31_000
  await checker.check(target)
  assert.equal(requests, 16)

  const dead = await checker.check({ id: 'px_dead', proxyUrl: `socks5://127.0.0.1:${await closedPort()}` })
  assert.equal(dead.requests, 1, 'one failed exit probe, the other seven skipped')
  assert.equal(dead.health.exit.state, 'proxy-down')
  for (const service of ['claude', 'openai', 'google'] as const) assert.equal(dead.health.services[service].state, 'proxy-down')
  const invalid = await checker.check({ id: 'px_bad', proxyUrl: 'ftp://nope' })
  assert.equal(invalid.requests, 0)

  const hole = new ProxyChecker({
    store, limiter: countingLimiter(), now: () => clock.now, targets: await targetsAt(port),
    request: async (_proxy, url) => {
      if (url.includes('/trace')) return { status: 200, headers: {}, body: 'ip=192.0.2.1\nloc=DE\n', ms: 5 }
      throw new ProbeError('timeout', 'target')
    },
  })
  const blackHole = await hole.check({ id: 'px_hole', proxyUrl: 'socks5://127.0.0.1:1' })
  assert.equal(blackHole.requests, 3, 'exit + two timeouts, the remaining five are skipped')
  assert.equal(blackHole.health.services.google.state, 'timeout')
})

test('checker: many entries at once never exceed 4 requests in flight', async () => {
  const { createLimiter } = await import('./syncRegistry.js')
  const { store } = storeIn()
  let active = 0
  let max = 0
  const checker = new ProxyChecker({
    store, limiter: createLimiter(4),
    request: async () => {
      active += 1
      max = Math.max(max, active)
      await new Promise(resolve => setTimeout(resolve, 5))
      active -= 1
      return { status: 401, headers: {}, body: '', ms: 5 }
    },
  })
  await Promise.all(Array.from({ length: 6 }, (_, index) => checker.check({ id: `px_${index}`, proxyUrl: 'socks5://127.0.0.1:1' })))
  assert.ok(max <= 4, `max in flight ${max}`)
  assert.ok(max >= 2)
})

test('health store: unknown version is read-only, prune drops gone entries, corrupt file starts empty', () => {
  const { store, file } = storeIn()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ version: 2, entries: {} }))
  const health = {
    lastAt: '2026-10-02T00:00:00.000Z',
    exit: { ip: null, country: null, state: 'ok' as const, ms: 1, at: '2026-10-02T00:00:00.000Z' },
    services: Object.fromEntries(['claude', 'openai', 'google'].map(service => [service, { state: 'ok' as const, ms: 1, hosts: [], at: '2026-10-02T00:00:00.000Z' }])) as never,
    requests: 8,
  }
  store.set('px_a', health)
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).version, 2, 'a newer file is never overwritten')

  fs.writeFileSync(file, '{not json')
  const fresh = new ProxyHealthStore(file)
  assert.deepEqual(fresh.all(), {})
  fresh.set('px_a', health)
  fresh.set('px_b', health)
  fresh.set('../evil', health)
  fresh.prune(['px_b'])
  assert.deepEqual(Object.keys(new ProxyHealthStore(file).all()), ['px_b'])
})

test('scrubProbeText masks userinfo, subscription paths, uuids and known secrets', () => {
  const text = scrubProbeText('fetch https://sub.example.com/api/v1/client/subscribe?token=abc failed via socks5://u:p@127.0.0.1:27890 uuid 0b5c5b9e-7d3f-4b8e-9c55-8f7e6b3a2d10 pass KNOWNSECRET', ['KNOWNSECRET'])
  for (const leak of ['token=abc', '/api/v1', 'u:p@', '0b5c5b9e', 'KNOWNSECRET']) assert.ok(!text.includes(leak), leak)
  assert.match(text, /https:\/\/sub\.example\.com\/\*\*\*/)
})
