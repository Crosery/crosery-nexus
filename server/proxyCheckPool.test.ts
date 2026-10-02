import './testDataDir.js'

import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { ProxyChecker, ProxyHealthStore } from './proxyCheck.js'
import { installProxyChecks, inUseEntryIds, poolCandidates, type EntryTestResult } from './proxyCheckPool.js'
import { attachProxyKernel } from './proxyPoolHooks.js'
import { ProxyError, ProxyPoolStore, type ProxyEntry } from './proxyPoolStore.js'
import { createLimiter, SyncRegistry } from './syncRegistry.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-check-pool-'))
const servers: net.Server[] = []
test.after(() => { for (const server of servers) server.close() })

const now = new Date().toISOString()
const base = (id: string, extra: Partial<ProxyEntry>): ProxyEntry => ({
  id, name: 'h.example.com', nameAuto: true, kind: 'url', protocol: 'http' as ProxyEntry['protocol'], server: 'h.example.com', serverPort: 8080,
  fingerprint: id, source: 'manual', tags: [], enabled: true, validity: 'ok', createdAt: now, updatedAt: now, ...extra,
})

async function listen(server: net.Server): Promise<number> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  servers.push(server)
  return (server.address() as net.AddressInfo).port
}

/** Minimal HTTP CONNECT proxy to 127.0.0.1:<port>, requiring Basic pu:pp. */
async function connectProxy(): Promise<number> {
  const server = http.createServer((_req, res) => res.writeHead(400).end())
  server.on('connect', (req: http.IncomingMessage, client: net.Socket) => {
    client.on('error', () => undefined)
    if (req.headers['proxy-authorization'] !== `Basic ${Buffer.from('pu:pp').toString('base64')}`) {
      client.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n')
      return
    }
    const upstream = net.connect(Number(String(req.url).split(':').pop()), '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      client.pipe(upstream).pipe(client)
    })
    upstream.on('error', () => client.destroy())
  })
  return listen(server)
}

test('in-use = linked entries + default; candidates resolve managed ports and external scope', () => {
  const store = new ProxyPoolStore(path.join(fs.mkdtempSync(path.join(root, 'p-')), 'proxy'))
  store.update((pool) => {
    pool.entries.push(
      base('px_aaaaaaaaaa', { url: 'http://pu:pp@h.example.com:8080' }),
      base('px_bbbbbbbbbb', { url: 'http://h.example.com:8081' }),
      base('px_cccccccccc', { kind: 'mihomo', protocol: 'ss' as ProxyEntry['protocol'], port: 27895, url: undefined }),
      base('px_dddddddddd', { url: 'socks5://127.0.0.1:7890', external: true }),
    )
    pool.links['cpa:a.json'] = { entryId: 'px_aaaaaaaaaa', urlKey: 'k', at: now, via: 'assign' }
    pool.links['cpa:b.json'] = { entryId: 'px_dddddddddd', urlKey: 'k', at: now, via: 'migrate' }
    pool.defaultEntryId = 'px_cccccccccc'
  })
  const pool = store.read()
  const ids = inUseEntryIds(pool)
  assert.deepEqual([...ids].sort(), ['px_aaaaaaaaaa', 'px_cccccccccc', 'px_dddddddddd'])
  const remote = poolCandidates(pool, ids, { listenerAuth: true, coResident: false })
  const byId = Object.fromEntries(remote.map(item => [item.id, item]))
  assert.match(String(byId.px_cccccccccc.proxyUrl), /^socks5:\/\/[^@]+@127\.0\.0\.1:27895$/)
  assert.equal(byId.px_dddddddddd.skip, '此处无法检测')
  assert.equal(poolCandidates(pool, ids, { listenerAuth: true, coResident: true }).find(item => item.id === 'px_dddddddddd')!.skip, undefined)
})

test('testEntry probes through the entry URL, stores health, counts requests; testInUse goes through the job cooldown', async () => {
  const target = await listen(http.createServer((req, res) => {
    if (String(req.url).includes('trace')) res.writeHead(200).end('ip=198.51.100.4\nloc=SG\n')
    else res.writeHead(401).end()
  }))
  const proxyPort = await connectProxy()
  const store = new ProxyPoolStore(path.join(fs.mkdtempSync(path.join(root, 'p-')), 'proxy'))
  store.update((pool) => {
    pool.entries.push(
      base('px_eeeeeeeeee', { url: `http://pu:pp@127.0.0.1:${proxyPort}` }),
      base('px_ffffffffff', { kind: 'mihomo', protocol: 'ss' as ProxyEntry['protocol'], port: 27896, url: undefined }),
      base('px_gggggggggg', { url: `http://pu:wrong@127.0.0.1:${proxyPort}` }),
    )
    pool.links['cpa:e.json'] = { entryId: 'px_eeeeeeeeee', urlKey: 'k', at: now, via: 'assign' }
  })
  const registry = new SyncRegistry({ file: null, log: () => undefined, setTimer: () => 0 as unknown as ReturnType<typeof setTimeout>, clearTimer: () => undefined })
  const checker = new ProxyChecker({
    store: new ProxyHealthStore(store.healthFile),
    limiter: createLimiter(4),
    targets: [
      { service: 'exit', url: `http://exit.test:${target}/cdn-cgi/trace` },
      { service: 'claude', url: `http://api.anthropic.test:${target}/v1/models` },
      { service: 'openai', url: `http://api.openai.test:${target}/v1/models` },
      { service: 'google', url: `http://cloudcode.test:${target}/x` },
    ],
  })
  attachProxyKernel(null)
  const { port } = installProxyChecks({ registry, store, checker })

  const result = await port.testEntry('px_eeeeeeeeee') as EntryTestResult
  assert.equal(result.skipped, null)
  assert.equal(store.read().entries.find(item => item.id === 'px_eeeeeeeeee')!.name, 'h.example.com · SG', 'auto-named entry picks up the exit country')
  assert.deepEqual([result.health?.exit.ip, result.health?.exit.country], ['198.51.100.4', 'SG'])
  assert.equal(result.health?.services.claude.state, 'auth-expected')
  const health = JSON.parse(fs.readFileSync(store.healthFile, 'utf8'))
  assert.ok(health.entries.px_eeeeeeeeee.lastAt)
  assert.ok(!fs.readFileSync(store.healthFile, 'utf8').includes('pu:pp'))
  const view = (await registry.status()).jobs.find(job => job.id === 'proxy-health')!
  assert.equal(view.requests24h, 4)

  const denied = await port.testEntry('px_gggggggggg') as EntryTestResult
  assert.equal(denied.health?.exit.state, 'proxy-auth-failed')
  assert.equal(denied.health?.services.google.state, 'proxy-auth-failed')

  const managed = await port.testEntry('px_ffffffffff') as EntryTestResult
  assert.equal(managed.skipped, '内核未运行')
  await assert.rejects(port.testEntry('px_missing00'), (error: unknown) => error instanceof ProxyError && error.status === 404)

  const first = await port.testInUse() as { accepted: boolean }
  assert.equal(first.accepted, true)
  await assert.rejects(port.testInUse(), (error: unknown) => error instanceof ProxyError && [409, 429].includes(error.status))
})
