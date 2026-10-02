import fs from 'node:fs'
import path from 'node:path'

/**
 * Fake mihomo: answers `-v` and `-t` like the real one (an error line `proxy <i>: …` for `cipher: bogus`, an unindexed
 * error for `cipher: bogus-noindex`), runs a Bearer-protected controller (`/version`, `PUT /configs`), and binds one
 * socks5 greeting + RFC 1929 auth server per listener. `<dir>/fake-mode.json` switches: `crash`, `skipBind: [ports]`, `rejectReload`.
 */
export const FAKE_MIHOMO_SOURCE = String.raw`#!/usr/bin/env node
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
const args = process.argv.slice(2)
if (args.includes('-v')) { console.log('Mihomo Meta v1.19.31 darwin arm64 (fake)'); process.exit(0) }
const dir = args[args.indexOf('-d') + 1]
const file = args[args.indexOf('-f') + 1]
const readMode = () => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'fake-mode.json'), 'utf8')) } catch { return {} } }
const load = (f) => JSON.parse(fs.readFileSync(f, 'utf8'))
function check(config) {
  for (const [i, p] of (config.proxies || []).entries()) {
    if (p.cipher === 'bogus') return 'proxy ' + i + ': ss ' + p.server + ':' + p.port + ' cipher: bogus initialize error: unknown method: bogus ' + p.password
    if (p.cipher === 'bogus-noindex') return 'Parse config error: something about ' + p.server
  }
  return null
}
if (args.includes('-t')) {
  const error = check(load(file))
  if (error) { console.log('time="x" level=error msg="' + error.replace(/"/g, '\\"') + '"'); console.log('configuration file ' + file + ' test failed'); process.exit(1) }
  console.log('configuration file ' + file + ' test is successful')
  process.exit(0)
}
fs.appendFileSync(path.join(dir, 'fake-starts.log'), process.pid + '\n')
let mode = readMode()
if (mode.crash) { console.log('time="x" level=fatal msg="fake crash"'); setTimeout(() => process.exit(2), mode.crashAfterMs ?? 60) }
const servers = new Map()
function bind(config) {
  const wanted = new Map((config.listeners || []).map(l => [l.port, l]))
  for (const [port, server] of servers) if (!wanted.has(port)) { server.close(); servers.delete(port) }
  for (const [port, listener] of wanted) {
    if (servers.has(port)) { servers.get(port).listener = listener; continue }
    if ((mode.skipBind || []).includes(port)) continue
    const server = net.createServer(socket => {
      socket.on('error', () => {})
      socket.once('data', () => {
        const users = server.listener.users
        if (!users) { socket.end(Buffer.from([5, 0])); return }
        socket.write(Buffer.from([5, 2]))
        // RFC 1929: 01 ulen user plen pass → 01 00 only for the configured credential
        socket.once('data', (auth) => {
          const ulen = auth[1]
          const user = auth.subarray(2, 2 + ulen).toString('utf8')
          const pass = auth.subarray(3 + ulen, 3 + ulen + auth[2 + ulen]).toString('utf8')
          const ok = users.some(u => u.username === user && u.password === pass)
          socket.end(Buffer.from([1, ok ? 0 : 1]))
        })
      })
    })
    server.listener = listener
    server.on('error', () => {})
    server.listen(port, '127.0.0.1')
    servers.set(port, server)
  }
}
let config = load(file)
bind(config)
const [host, port] = config['external-controller'].split(':')
http.createServer((req, res) => {
  if (req.headers.authorization !== 'Bearer ' + config.secret) { res.writeHead(401).end('{"message":"Unauthorized"}'); return }
  if (req.url === '/version') { res.writeHead(200, { 'content-type': 'application/json' }).end('{"meta":true,"version":"v1.19.31"}'); return }
  if (req.method === 'PUT' && req.url.startsWith('/configs')) {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      mode = readMode()
      if (mode.rejectReload) { res.writeHead(500).end('{"message":"nope"}'); return }
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

/** Writes the fake as an executable `fake-mihomo.mjs` in `dir` and returns its path. */
export function writeFakeMihomo(dir: string): string {
  const file = path.join(dir, 'fake-mihomo.mjs')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(file, FAKE_MIHOMO_SOURCE, { mode: 0o755 })
  return file
}
