import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import test from 'node:test'
import zlib from 'node:zlib'
import {
  fetchSubscription, isPrivateAddress, maskSubscriptionUrl, parseContentDispositionName, parseRetryAfter,
  parseSubscriptionUserinfo, SubscriptionFetchError,
} from './proxyParseSubscription.js'

type Handler = (req: IncomingMessage, res: ServerResponse) => void

async function serve(handler: Handler): Promise<{ base: string; hits: IncomingMessage[]; close: () => Promise<void>; server: Server }> {
  const hits: IncomingMessage[] = []
  const server = createServer((req, res) => { hits.push(req); handler(req, res) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return {
    base: `http://127.0.0.1:${port}`, hits, server,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()) }),
  }
}

// a loopback server stands in for a public host in these tests
const loopbackIsPublic = (address: string) => address !== '127.0.0.1' && isPrivateAddress(address)

const TOKEN = 'SUBTOKEN-7f3a9c'

test('fetch: body + headers (userinfo, update interval, filename*), UA clash.meta, no cookies, env proxies ignored', async () => {
  const fake = await serve((_req, res) => {
    res.setHeader('subscription-userinfo', 'upload=100; download=2048; total=1073741824; expire=1798761600')
    res.setHeader('profile-update-interval', '24')
    res.setHeader('content-disposition', "attachment; filename*=UTF-8''%E6%9C%BA%E5%9C%BA.yaml")
    res.end('proxies: []\n')
  })
  const saved = { HTTP_PROXY: process.env.HTTP_PROXY, HTTPS_PROXY: process.env.HTTPS_PROXY, http_proxy: process.env.http_proxy }
  process.env.HTTP_PROXY = 'http://127.0.0.1:9'
  process.env.http_proxy = 'http://127.0.0.1:9'
  process.env.HTTPS_PROXY = 'http://127.0.0.1:9'
  try {
    const result = await fetchSubscription(`${fake.base}/sub?token=${TOKEN}`, { allowPrivate: true })
    assert.equal(result.body, 'proxies: []\n')
    assert.deepEqual(result.info, { upload: 100, download: 2048, total: 1073741824, expire: 1798761600 })
    assert.equal(result.updateIntervalH, 24)
    assert.equal(result.filename, '机场')
    assert.equal(result.insecureHttp, true)
    assert.equal(fake.hits.length, 1)
    assert.equal(fake.hits[0].headers['user-agent'], 'clash.meta')
    assert.equal(fake.hits[0].headers.cookie, undefined)
  } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    await fake.close()
  }
})

test('loopback / private targets are refused before any connection (literal IP and via DNS)', async () => {
  const fake = await serve((_req, res) => res.end('x'))
  try {
    await assert.rejects(fetchSubscription(`${fake.base}/s?token=${TOKEN}`), (error: unknown) => error instanceof SubscriptionFetchError && error.code === 'private_target' && !error.message.includes(TOKEN))
    await assert.rejects(fetchSubscription(`http://internal.example.test:${new URL(fake.base).port}/s`, {
      lookup: async () => [{ address: '10.1.2.3', family: 4 }],
    }), (error: unknown) => error instanceof SubscriptionFetchError && error.code === 'private_target')
    const port = new URL(fake.base).port
    await assert.rejects(fetchSubscription(`http://[::ffff:127.0.0.1]:${port}/s`), (error: unknown) => error instanceof SubscriptionFetchError && error.code === 'private_target')
    await assert.rejects(fetchSubscription(`http://mapped.example.test:${port}/s`, {
      lookup: async () => [{ address: '::ffff:7f00:1', family: 6 }],
    }), (error: unknown) => error instanceof SubscriptionFetchError && error.code === 'private_target')
    assert.equal(fake.hits.length, 0)
  } finally {
    await fake.close()
  }
})

test('redirects: each hop is re-checked; more than 3 hops fail', async () => {
  const fake = await serve((req, res) => {
    const step = Number(new URL(req.url ?? '/', 'http://x').searchParams.get('n') ?? '0')
    if (req.url?.startsWith('/private')) { res.writeHead(302, { location: 'http://192.168.10.1/admin' }); res.end(); return }
    if (req.url?.startsWith('/once')) { res.writeHead(302, { location: '/final' }); res.end(); return }
    if (req.url?.startsWith('/final')) { res.end('ok'); return }
    res.writeHead(302, { location: `/loop?n=${step + 1}` })
    res.end()
  })
  try {
    const options = { isPrivate: loopbackIsPublic }
    assert.equal((await fetchSubscription(`${fake.base}/once`, options)).body, 'ok')
    await assert.rejects(fetchSubscription(`${fake.base}/loop?n=0`, options), (error: unknown) => error instanceof SubscriptionFetchError && error.code === 'redirects')
    await assert.rejects(fetchSubscription(`${fake.base}/private`, options), (error: unknown) => error instanceof SubscriptionFetchError && error.code === 'private_target')
  } finally {
    await fake.close()
  }
})

test('size cap (plain and gzip), timeout, HTTP status with Retry-After', async () => {
  const big = 'a'.repeat(64 * 1024)
  const fake = await serve((req, res) => {
    if (req.url === '/big') { res.end(big); return }
    if (req.url === '/gzip') { res.setHeader('content-encoding', 'gzip'); res.end(zlib.gzipSync(big)); return }
    if (req.url === '/gzip-small') { res.setHeader('content-encoding', 'gzip'); res.end(zlib.gzipSync('proxies: []')); return }
    if (req.url === '/slow') return
    res.writeHead(429, { 'retry-after': '120' })
    res.end('slow down')
  })
  try {
    const options = { allowPrivate: true, maxBytes: 16 * 1024 }
    await assert.rejects(fetchSubscription(`${fake.base}/big`, options), (error: unknown) => error instanceof SubscriptionFetchError && error.code === 'too_large')
    await assert.rejects(fetchSubscription(`${fake.base}/gzip`, options), (error: unknown) => error instanceof SubscriptionFetchError && error.code === 'too_large')
    assert.equal((await fetchSubscription(`${fake.base}/gzip-small`, options)).body, 'proxies: []')
    await assert.rejects(fetchSubscription(`${fake.base}/slow`, { ...options, timeoutMs: 300 }), (error: unknown) => error instanceof SubscriptionFetchError && error.code === 'timeout')
    await assert.rejects(fetchSubscription(`${fake.base}/limited?token=${TOKEN}`, options), (error: unknown) =>
      error instanceof SubscriptionFetchError && error.code === 'http_status' && error.retryAfterMs === 120_000 && error.status === 429 && !error.message.includes(TOKEN))
  } finally {
    await fake.close()
  }
})

test('bad addresses: userinfo, non-http scheme', async () => {
  await assert.rejects(fetchSubscription('https://u:p@sub.example.test/s'), (error: unknown) => error instanceof SubscriptionFetchError && error.code === 'bad_url')
  await assert.rejects(fetchSubscription('ftp://sub.example.test/s'), (error: unknown) => error instanceof SubscriptionFetchError && error.code === 'bad_url')
})

test('helpers: masking, private ranges, header parsers', () => {
  assert.equal(maskSubscriptionUrl(`https://sub.example.test/api/v1/client/subscribe?token=${TOKEN}`), 'https://sub.example.test/***')
  assert.equal(maskSubscriptionUrl('https://sub.example.test'), 'https://sub.example.test')
  for (const address of ['127.0.0.1', '10.0.0.1', '172.20.1.1', '192.168.1.1', '169.254.1.1', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1', '224.0.0.1']) {
    assert.equal(isPrivateAddress(address), true, address)
  }
  for (const address of ['203.0.113.1', '8.8.8.8', '2001:4860::8888', '198.18.0.1']) assert.equal(isPrivateAddress(address), false, address)
  // every spelling of an IPv4 inside IPv6 is judged by that IPv4 (a URL normalizes [::ffff:127.0.0.1] to ::ffff:7f00:1)
  for (const address of ['::ffff:7f00:1', '::ffff:a00:1', '::ffff:a9fe:a9fe', '[::ffff:7f00:1]', '0:0:0:0:0:ffff:7f00:1', '::7f00:1', '::127.0.0.1', '64:ff9b::7f00:1', '64:ff9b::10.0.0.1', '2002:7f00:1::1', '2002:a9fe:a9fe::', '::ffff:0:7f00:1', '::ffff:0:10.0.0.1', '0::0', '0:0:0:0:0:0:0:1', 'fec0::1']) {
    assert.equal(isPrivateAddress(address), true, address)
  }
  for (const address of ['::ffff:808:808', '::ffff:0:808:808', '64:ff9b::808:808', '2002:808:808::1']) assert.equal(isPrivateAddress(address), false, address)
  assert.deepEqual(parseSubscriptionUserinfo('upload=1; total=x'), { upload: 1 })
  assert.equal(parseSubscriptionUserinfo(''), null)
  assert.deepEqual(parseSubscriptionUserinfo('upload=1; download=2; total=3; expire=0'), { upload: 1, download: 2, total: 3, expire: 0 })
  assert.equal(parseContentDispositionName('attachment; filename="My Airport.yaml"'), 'My Airport')
  assert.equal(parseRetryAfter('30'), 30_000)
  assert.equal(parseRetryAfter(new Date(Date.now() + 60_000).toUTCString()) !== null, true)
})
