import assert from 'node:assert/strict'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { resolveMihomoBinary, type MihomoBinary } from './mihomoBinary.js'
import { MihomoKernel, socksGreeting } from './mihomoKernel.js'
import { listenerProxyUrl, type MihomoNodeEntry } from './mihomoConfig.js'
import { ProxyChecker, ProxyHealthStore } from './proxyCheck.js'
import { parseProxyEndpoint, probeRequest, ProbeError } from './proxyCheckClient.js'

/**
 * Local end-to-end run against the real mihomo (opt-in: `PROXY_E2E=1`, skipped without a binary or openssl).
 *
 * A second, throwaway mihomo plays the remote server with shadowsocks and trojan inbounds (self-signed cert inside its own
 * `-d`); the managed kernel exposes one authenticated socks5 port per node; the console's probe client fetches an in-test
 * HTTP target through each port. Everything binds 127.0.0.1. Clash Party's process is only observed (read-only `ps`/
 * `netstat`), never touched, and must look the same before and after.
 */

const enabled = process.env.PROXY_E2E === '1'
const hasOpenssl = (() => { try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); return true } catch { return false } })()
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mihomo-e2e-'))
const kernelDir = path.join(root, 'data', 'proxy', 'mihomo')
const children: ChildProcess[] = []
let kernel: MihomoKernel | null = null
let binary: MihomoBinary = { ok: false, reason: 'not resolved' }
if (enabled) binary = await resolveMihomoBinary({ dir: kernelDir })
const skip = !enabled ? 'set PROXY_E2E=1 to run' : !binary.ok ? `no mihomo binary (${binary.reason})` : !hasOpenssl ? 'openssl not installed' : false

test.after(async () => {
  await kernel?.stop().catch(() => undefined)
  for (const child of children) child.kill('SIGTERM')
  fs.rmSync(root, { recursive: true, force: true })
})

async function freePort(): Promise<number> {
  const server = net.createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as net.AddressInfo).port
  await new Promise<void>(resolve => server.close(() => resolve()))
  return port
}

async function freeRange(count: number): Promise<number> {
  for (let base = 41_000 + Math.floor(Math.random() * 5_000); base < 60_000; base += count + 3) {
    let free = true
    for (let port = base; port < base + count && free; port++) {
      free = await new Promise<boolean>((resolve) => {
        const server = net.createServer()
        server.once('error', () => resolve(false))
        server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)))
      })
    }
    if (free) return base
  }
  throw new Error('no free range')
}

/** Read-only snapshot of Clash Party: its mihomo pids/argv and the 789x listening ports on this machine. */
function clashPartySnapshot() {
  const processes = execFileSync('ps', ['-axww', '-o', 'pid=,args='], { encoding: 'utf8' })
    .split('\n').filter(line => line.includes('Clash Party.app/Contents/Resources/sidecar/mihomo')).map(line => line.trim()).sort()
  let ports: string[] = []
  try {
    ports = execFileSync('netstat', ['-an', '-p', 'tcp'], { encoding: 'utf8' })
      .split('\n').filter(line => /LISTEN/.test(line)).map(line => line.trim().split(/\s+/)[3]).filter(address => /[.:]789\d$/.test(address)).sort()
  } catch { /* netstat unavailable */ }
  return { processes, ports }
}

async function waitFor(check: () => Promise<boolean>, ms = 5_000) {
  const deadline = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timed out')
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

test('managed mihomo: ss + trojan nodes as local socks5 ports, reload, bad node, loopback only, Clash Party untouched', { skip, timeout: 60_000 }, async () => {
  assert.ok(binary.ok)
  const before = clashPartySnapshot()

  // 1. throwaway "remote" server mihomo with ss + trojan inbounds
  const serverDir = path.join(root, 'server')
  fs.mkdirSync(serverDir, { recursive: true, mode: 0o700 })
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1', '-subj', '/CN=localhost',
    '-keyout', path.join(serverDir, 'key.pem'), '-out', path.join(serverDir, 'cert.pem')], { stdio: 'ignore' })
  const ssPassword = crypto.randomBytes(12).toString('hex')
  const trojanPassword = crypto.randomBytes(12).toString('hex')
  const [ssPort, trojanPort, serverCtl, targetPort] = [await freePort(), await freePort(), await freePort(), await freePort()]
  const serverSecret = crypto.randomBytes(16).toString('hex')
  const serverConfig = {
    'mixed-port': 0, 'allow-lan': false, 'bind-address': '127.0.0.1', mode: 'direct', 'log-level': 'warning', ipv6: false,
    'external-controller': `127.0.0.1:${serverCtl}`, secret: serverSecret,
    profile: { 'store-selected': false, 'store-fake-ip': false }, dns: { enable: false }, tun: { enable: false },
    listeners: [
      { name: 'ss-in', type: 'shadowsocks', port: ssPort, listen: '127.0.0.1', password: ssPassword, cipher: 'aes-128-gcm' },
      { name: 'trojan-in', type: 'trojan', port: trojanPort, listen: '127.0.0.1', users: [{ username: 'u', password: trojanPassword }], certificate: 'cert.pem', 'private-key': 'key.pem' },
    ],
    rules: ['MATCH,DIRECT'],
  }
  fs.writeFileSync(path.join(serverDir, 'config.yaml'), JSON.stringify(serverConfig), { mode: 0o600 })
  const serverLog = fs.openSync(path.join(serverDir, 'out.log'), 'a', 0o600)
  const server = spawn(binary.runPath, ['-d', serverDir, '-f', path.join(serverDir, 'config.yaml')], { stdio: ['ignore', serverLog, serverLog], env: { PATH: process.env.PATH, HOME: serverDir, SAFE_PATHS: '' } })
  fs.closeSync(serverLog)
  children.push(server)
  await waitFor(async () => socksLikePortOpen(ssPort))

  // 2. in-test HTTP target
  const target = http.createServer((req, res) => res.writeHead(200, { 'content-type': 'text/plain' }).end(`e2e-ok ${req.url}`))
  await new Promise<void>(resolve => target.listen(targetPort, '127.0.0.1', resolve))
  try {
    // 3. the console-managed kernel
    const base = await freeRange(10)
    kernel = new MihomoKernel({ dir: kernelDir, env: { PATH: process.env.PATH, PROXY_PORT_BASE: String(base), PROXY_PORT_COUNT: '10' }, resolveBinary: async () => binary, debounceMs: 10, log: () => undefined })
    const auth = { username: 'cu', password: crypto.randomBytes(10).toString('hex') }
    const ssNode = (password = ssPassword): MihomoNodeEntry => ({ id: 'px_ss', port: base, node: { type: 'ss', server: '127.0.0.1', port: ssPort, cipher: 'aes-128-gcm', password, udp: false } })
    const trojanNode: MihomoNodeEntry = { id: 'px_trojan', port: base + 1, node: { type: 'trojan', server: '127.0.0.1', port: trojanPort, password: trojanPassword, sni: 'localhost', 'skip-cert-verify': true, udp: false } }
    const fetchVia = (port: number) => probeRequest(parseProxyEndpoint(listenerProxyUrl(port, auth)), `http://127.0.0.1:${targetPort}/hello`, { connectTimeoutMs: 3_000, totalTimeoutMs: 5_000 })

    const started = await kernel.apply({ entries: [ssNode(), trojanNode], listenerAuth: auth })
    assert.equal(started.state, 'running', JSON.stringify(kernel.status()))
    assert.deepEqual(started.running.sort(), ['px_ss', 'px_trojan'])
    for (const port of [base, base + 1]) {
      const response = await fetchVia(port)
      assert.equal(response.status, 200)
      assert.equal(response.body, 'e2e-ok /hello')
    }

    // listener auth is enforced
    const anonymous = await probeRequest({ kind: 'socks5', host: '127.0.0.1', port: base }, `http://127.0.0.1:${targetPort}/x`).then(() => null, (error: unknown) => error)
    assert.ok(anonymous instanceof ProbeError && anonymous.code === 'proxy-auth-failed')

    // the reachability checker classifies through the managed port
    const checker = new ProxyChecker({
      store: new ProxyHealthStore(path.join(root, 'data', 'proxy', 'health.json')),
      limiter: { run: task => task() },
      targets: [{ service: 'exit', url: `http://127.0.0.1:${targetPort}/cdn-cgi/trace` }, { service: 'claude', url: `http://127.0.0.1:${targetPort}/v1/models` }],
    })
    const health = await checker.check({ id: 'px_ss', proxyUrl: listenerProxyUrl(base, auth) })
    assert.equal(health.health.services.claude.state, 'ok')

    // reload: wrong password → the node fails; restore → works again (same kernel pid)
    const pid = kernel.status().pid
    await kernel.apply({ entries: [ssNode('wrong-password-1234'), trojanNode], listenerAuth: auth })
    const broken = await fetchVia(base).then(() => null, (error: unknown) => error)
    assert.ok(broken instanceof ProbeError, 'wrong ss password must not reach the target')
    await kernel.apply({ entries: [ssNode(), trojanNode], listenerAuth: auth })
    assert.equal((await fetchVia(base)).status, 200)
    assert.equal(kernel.status().pid, pid, 'hot reload, no restart')

    // remove trojan → its port closes; add it back → open again
    await kernel.apply({ entries: [ssNode()], listenerAuth: auth })
    assert.equal(await socksGreeting(base + 1, true), false)
    await kernel.apply({ entries: [ssNode(), trojanNode], listenerAuth: auth })
    assert.equal((await fetchVia(base + 1)).status, 200)

    // a bad node is marked invalid while the others keep serving
    const bad: MihomoNodeEntry = { id: 'px_bad', port: base + 2, node: { type: 'ss', server: '127.0.0.1', port: ssPort, cipher: 'bogus-cipher', password: 'x-bad-password' } }
    const withBad = await kernel.apply({ entries: [ssNode(), trojanNode, bad], listenerAuth: auth })
    assert.deepEqual(withBad.invalid.map(item => item.id), ['px_bad'])
    assert.ok(!withBad.invalid[0].reason.includes('x-bad-password'))
    assert.equal(withBad.state, 'running')
    assert.equal((await fetchVia(base)).status, 200)
    assert.equal(await socksGreeting(base + 2, true), false)

    // every socket the managed kernel holds is on loopback
    const kernelPid = kernel.status().pid!
    const sockets = execFileSync('lsof', ['-nP', '-a', '-p', String(kernelPid), '-i'], { encoding: 'utf8' }).split('\n').slice(1).filter(Boolean)
    assert.ok(sockets.length >= 3, 'controller + two listeners')
    for (const line of sockets) assert.match(line, /\b127\.0\.0\.1:\d+/, line)
    for (const line of sockets) assert.ok(!/\*:\d+|0\.0\.0\.0:|\[::\]:/.test(line), line)

    // our directory holds only our files
    const files = fs.readdirSync(kernelDir).sort()
    for (const name of files) assert.ok(['bin', 'config.yaml', 'config.next.yaml', 'controller.json', 'mihomo.log', 'mihomo.pid', 'cache.db'].includes(name), name)

    await kernel.stop()
    assert.equal(await socksGreeting(base, true), false)
  } finally {
    await new Promise<void>(resolve => target.close(() => resolve()))
  }

  const after = clashPartySnapshot()
  assert.deepEqual(after, before, 'Clash Party process and 789x ports unchanged')
})

function socksLikePortOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1')
    socket.once('connect', () => { socket.destroy(); resolve(true) })
    socket.once('error', () => resolve(false))
  })
}
