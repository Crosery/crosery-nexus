import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'

/**
 * A fake mihomo that actually carries traffic, for the pool → kernel → check pipeline test (no real binary needed).
 * It answers `-v` / `-t` and the controller (`/version`, `PUT /configs`) like `fakeMihomo.ts`, and every listener is a
 * real socks5 server: it enforces the listener credential, then dials the listener's node at `server:port` as a plain
 * socks5 upstream, authenticating with `username: node`, `password: <node password>`. A node with the wrong
 * password or port therefore breaks exactly like a real one, and the in-test node (`startSocksNode`) proves which
 * node the traffic went through.
 */
export const RELAY_MIHOMO_SOURCE = String.raw`#!/usr/bin/env node
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
const args = process.argv.slice(2)
if (args.includes('-v')) { console.log('Mihomo Meta v1.19.31 darwin arm64 (fake relay)'); process.exit(0) }
const file = args[args.indexOf('-f') + 1]
const load = (f) => JSON.parse(fs.readFileSync(f, 'utf8'))
function check(config) {
  for (const [i, p] of (config.proxies || []).entries()) if (p.cipher === 'bogus') return 'proxy ' + i + ': ss cipher: bogus initialize error'
  return null
}
if (args.includes('-t')) {
  const error = check(load(file))
  if (error) { console.log('time="x" level=error msg="' + error + '"'); console.log('configuration file test failed'); process.exit(1) }
  console.log('configuration file test is successful')
  process.exit(0)
}
function reader(socket) {
  let buf = Buffer.alloc(0)
  let waiting = null
  const pump = () => {
    if (waiting && buf.length >= waiting.n) { const out = buf.subarray(0, waiting.n); buf = buf.subarray(waiting.n); const w = waiting; waiting = null; w.resolve(out) }
  }
  const onData = (chunk) => { buf = Buffer.concat([buf, chunk]); pump() }
  socket.on('data', onData)
  socket.once('close', () => { if (waiting) { const w = waiting; waiting = null; w.reject(new Error('closed')) } })
  return {
    need: (n) => new Promise((resolve, reject) => { waiting = { n, resolve, reject }; pump() }),
    detach: () => { socket.pause(); socket.off('data', onData); const out = buf; buf = Buffer.alloc(0); return out },
  }
}
async function readAddress(r, atyp) {
  if (atyp === 1) return [...await r.need(4)].join('.')
  if (atyp === 3) { const [len] = await r.need(1); return (await r.need(len)).toString() }
  return (await r.need(16)).toString('hex').match(/.{4}/g).join(':')
}
let config = load(file)
async function serve(client, server) {
  client.on('error', () => {})
  const fail = (code) => client.end(Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0]))
  const r = reader(client)
  const [, count] = await r.need(2)
  const methods = [...await r.need(count)]
  const users = server.listener.users || []
  if (users.length) {
    if (!methods.includes(2)) return client.end(Buffer.from([5, 0xff]))
    client.write(Buffer.from([5, 2]))
    const [, ulen] = await r.need(2)
    const user = (await r.need(ulen)).toString()
    const [plen] = await r.need(1)
    const pass = (await r.need(plen)).toString()
    const ok = users.some((u) => u.username === user && u.password === pass)
    client.write(Buffer.from([1, ok ? 0 : 1]))
    if (!ok) return client.end()
  } else client.write(Buffer.from([5, 0]))
  const [, cmd, , atyp] = await r.need(4)
  const host = await readAddress(r, atyp)
  const port = (await r.need(2)).readUInt16BE(0)
  const node = (config.proxies || []).find((p) => p.name === server.listener.proxy)
  if (!node || cmd !== 1) return fail(1)
  const upstream = net.connect(Number(node.port), String(node.server))
  upstream.on('error', () => { fail(5) })
  upstream.once('connect', async () => {
    try {
      const u = reader(upstream)
      upstream.write(Buffer.from([5, 1, 2]))
      const [, method] = await u.need(2)
      if (method !== 2) return fail(1)
      const name = Buffer.from('node')
      const secret = Buffer.from(String(node.password || ''))
      upstream.write(Buffer.concat([Buffer.from([1, name.length]), name, Buffer.from([secret.length]), secret]))
      const [, status] = await u.need(2)
      if (status !== 0) { upstream.destroy(); return fail(1) }
      const target = Buffer.from(host)
      upstream.write(Buffer.concat([Buffer.from([5, 1, 0, 3, target.length]), target, Buffer.from([port >> 8, port & 255])]))
      const head = await u.need(4)
      await readAddress(u, head[3])
      await u.need(2)
      if (head[1] !== 0) { upstream.destroy(); return fail(head[1]) }
      client.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]))
      const fromClient = r.detach()
      const fromUpstream = u.detach()
      if (fromClient.length) upstream.write(fromClient)
      if (fromUpstream.length) client.write(fromUpstream)
      client.pipe(upstream)
      upstream.pipe(client)
      client.resume()
      upstream.resume()
    } catch { client.destroy(); upstream.destroy() }
  })
}
const servers = new Map()
function bind(next) {
  const wanted = new Map((next.listeners || []).map((l) => [l.port, l]))
  for (const [port, server] of servers) if (!wanted.has(port)) { server.close(); servers.delete(port) }
  for (const [port, listener] of wanted) {
    if (servers.has(port)) { servers.get(port).listener = listener; continue }
    const server = net.createServer((client) => { serve(client, server).catch(() => client.destroy()) })
    server.listener = listener
    server.on('error', () => {})
    server.listen(port, '127.0.0.1')
    servers.set(port, server)
  }
}
bind(config)
const [host, port] = config['external-controller'].split(':')
http.createServer((req, res) => {
  if (req.headers.authorization !== 'Bearer ' + config.secret) { res.writeHead(401).end('{"message":"Unauthorized"}'); return }
  if (req.url === '/version') { res.writeHead(200, { 'content-type': 'application/json' }).end('{"meta":true,"version":"v1.19.31"}'); return }
  if (req.method === 'PUT' && req.url.startsWith('/configs')) {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      const next = load(JSON.parse(body).path)
      const error = check(next)
      if (error) { res.writeHead(400).end(JSON.stringify({ message: error })); return }
      config = next
      bind(config)
      res.writeHead(204).end()
    })
    return
  }
  res.writeHead(404).end()
}).listen(Number(port), host)
process.on('SIGTERM', () => process.exit(0))
`

/** Writes the relay as an executable `fake-mihomo-relay.mjs` in `dir` and returns its path. */
export function writeRelayMihomo(dir: string): string {
  const file = path.join(dir, 'fake-mihomo-relay.mjs')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(file, RELAY_MIHOMO_SOURCE, { mode: 0o755 })
  return file
}

export type SocksNode = { port: number; requested: string[]; close: () => Promise<void> }

/**
 * The "remote node" for the relay: a socks5 server on 127.0.0.1 that requires `node:<password>` and dials every
 * CONNECT target itself. `requested` records `host:port` per tunnel.
 */
export async function startSocksNode(password: string): Promise<SocksNode> {
  const requested: string[] = []
  const sockets = new Set<net.Socket>()
  const server = net.createServer((client) => {
    sockets.add(client)
    client.once('close', () => sockets.delete(client))
    client.on('error', () => undefined)
    let buffer = Buffer.alloc(0)
    let phase: 'greet' | 'auth' | 'request' | 'piped' = 'greet'
    client.on('data', (chunk: Buffer) => {
      if (phase === 'piped') return
      buffer = Buffer.concat([buffer, chunk])
      for (;;) {
        if (phase === 'greet') {
          if (buffer.length < 2 || buffer.length < 2 + buffer[1]) return
          const methods = [...buffer.subarray(2, 2 + buffer[1])]
          buffer = buffer.subarray(2 + buffer[1])
          if (!methods.includes(2)) { client.end(Buffer.from([5, 0xff])); return }
          client.write(Buffer.from([5, 2]))
          phase = 'auth'
        } else if (phase === 'auth') {
          if (buffer.length < 2) return
          const ulen = buffer[1]
          if (buffer.length < 3 + ulen) return
          const plen = buffer[2 + ulen]
          if (buffer.length < 3 + ulen + plen) return
          const user = buffer.subarray(2, 2 + ulen).toString()
          const pass = buffer.subarray(3 + ulen, 3 + ulen + plen).toString()
          buffer = buffer.subarray(3 + ulen + plen)
          if (user !== 'node' || pass !== password) { client.end(Buffer.from([1, 1])); return }
          client.write(Buffer.from([1, 0]))
          phase = 'request'
        } else if (phase === 'request') {
          if (buffer.length < 5) return
          const atyp = buffer[3]
          const addressLength = atyp === 1 ? 4 : atyp === 4 ? 16 : buffer[4] + 1
          if (buffer.length < 4 + addressLength + 2) return
          const host = atyp === 3 ? buffer.subarray(5, 5 + buffer[4]).toString() : atyp === 1 ? [...buffer.subarray(4, 8)].join('.') : '::1'
          const port = buffer.readUInt16BE(4 + addressLength)
          buffer = buffer.subarray(4 + addressLength + 2)
          requested.push(`${host}:${port}`)
          phase = 'piped'
          const upstream = net.connect(port, host, () => {
            client.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, port >> 8, port & 0xff]))
            if (buffer.length) upstream.write(buffer)
            client.pipe(upstream).pipe(client)
          })
          upstream.on('error', () => client.end(Buffer.from([5, 5, 0, 1, 0, 0, 0, 0, 0, 0])))
          return
        } else return
      }
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return {
    port: (server.address() as net.AddressInfo).port,
    requested,
    close: () => new Promise<void>((resolve) => {
      for (const socket of sockets) socket.destroy()
      server.close(() => resolve())
    }),
  }
}
