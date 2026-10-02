import './testDataDir.js'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { buildPreview, clearPreviewsForTests, commitImport, previewView, refreshSubscription, SUBSCRIPTION_REUSE_MS, takePreview } from './proxyPoolImport.js'
import { ProxyError, ProxyPoolStore } from './proxyPoolStore.js'
import type { SubscriptionFetchResult } from './proxyParseSubscription.js'

const store = () => new ProxyPoolStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-import-')), 'proxy'))
const allFree = async () => true
const SUB_URL = 'https://sub.example.test/api/v1/client/subscribe?token=SUBTOKEN-abc123'

function body(nodes: Array<Record<string, unknown>>): SubscriptionFetchResult {
  const lines = nodes.map(node => `  - ${JSON.stringify(node)}`).join('\n')
  return { body: `proxies:\n${lines}\n`, status: 200, info: { upload: 1, download: 2, total: 100 }, updateIntervalH: 24, filename: '机场A', insecureHttp: false }
}

test('paste → preview (masked, counts) → import; re-paste is all duplicates; a changed node is an update with the same id and port', async () => {
  clearPreviewsForTests()
  const pool = store()
  const paste = [
    'trojan://tpass-1@t1.example.test:443#T1',
    'trojan://tpass-2@t2.example.test:443#T2',
    'socks5://alice:apw@198.51.100.4:1080#res',
    'trojan://tpass-1@t1.example.test:443#T1-again',
    'snell://x@s.test:1',
  ].join('\n')
  const preview = await buildPreview(pool, paste)
  const view = previewView(preview, { kernelAvailable: false })
  assert.deepEqual(view.counts, { new: 3, update: 0, duplicate: 1, unsupported: 1, invalid: 0, info: 0 })
  assert.equal(view.needsKernel, 2)
  const text = JSON.stringify(view)
  for (const secret of ['tpass-1', 'tpass-2', 'apw', 'alice']) assert.equal(text.includes(secret), false)

  const result = await commitImport(pool, takePreview(preview.id), {}, { probe: allFree })
  assert.equal(result.added.length, 3)
  assert.throws(() => takePreview(preview.id), (error: unknown) => error instanceof ProxyError && error.code === 'preview_expired')
  const entries = pool.read().entries
  const t1 = entries.find(entry => entry.name === 'T1')
  assert.ok(t1?.port && t1.port >= 27890)
  assert.equal(t1?.validity, 'unverified')
  assert.equal(entries.find(entry => entry.name === 'res')?.kind, 'url')
  assert.equal(entries.find(entry => entry.name === 'res')?.source, 'manual')

  const again = previewView(await buildPreview(pool, paste), { kernelAvailable: false })
  assert.equal(again.counts.new, 0)
  assert.equal(again.counts.duplicate, 4)

  const changed = await buildPreview(pool, 'trojan://tpass-1@t1.example.test:443?type=ws&path=%2Fnew#T1')
  assert.equal(changed.rows[0].status, 'update')
  await commitImport(pool, changed, {}, { probe: allFree })
  const updated = pool.read().entries.find(entry => entry.id === t1?.id)
  assert.equal(updated?.port, t1?.port)
  assert.equal(updated?.node?.network, 'ws')
})

test('keys select rows; tags apply; managed-port URLs are refused', async () => {
  clearPreviewsForTests()
  const pool = store()
  const preview = await buildPreview(pool, 'http://u:p@203.0.113.1:8080#a\nhttp://u:p@203.0.113.2:8080#b\nsocks5://127.0.0.1:27891')
  assert.equal(preview.rows[2].status, 'invalid')
  const result = await commitImport(pool, preview, { keys: ['r1'], tags: ['美国', ' x '] }, { probe: allFree })
  assert.equal(result.added.length, 1)
  assert.deepEqual(pool.read().entries[0].tags, ['美国', 'x'])
  assert.equal(pool.read().entries[0].name, 'b')
})

test('subscription in a paste: fetched once, rows previewed; import creates the subscription; refresh merges by key keeping ids, ports and links', async () => {
  clearPreviewsForTests()
  const pool = store()
  let fetches = 0
  let nodes: Array<Record<string, unknown>> = [
    { name: 'A', type: 'trojan', server: 'a.example.test', port: 443, password: 'pa' },
    { name: 'B', type: 'trojan', server: 'b.example.test', port: 443, password: 'pb' },
    { name: 'C', type: 'trojan', server: 'c.example.test', port: 443, password: 'pc' },
    { name: '剩余流量：1 GB', type: 'trojan', server: '0.0.0.0', port: 1, password: 'x' },
  ]
  const fetch = async (url: string) => { fetches++; assert.equal(url, SUB_URL); return body(nodes) }
  const preview = await buildPreview(pool, SUB_URL, { fetch })
  assert.equal(fetches, 1)
  const view = previewView(preview, { kernelAvailable: true })
  assert.equal(view.subscriptions.length, 1)
  assert.equal(view.subscriptions[0].maskedUrl, 'https://sub.example.test/***')
  assert.equal(view.subscriptions[0].intervalH, 24, 'profile-update-interval is a lower bound')
  assert.equal(view.counts.info, 1)
  assert.equal(JSON.stringify(view).includes('SUBTOKEN'), false)
  const committed = await commitImport(pool, preview, {}, { probe: allFree, random: () => 0.5 })
  assert.equal(fetches, 1, 'import reuses the fetched result')
  assert.equal(committed.subscriptions[0].added, 3)
  const subscription = pool.read().subscriptions[0]
  assert.equal(subscription.name, '机场A')
  assert.equal(subscription.nodeCount, 3)
  const before = new Map(pool.read().entries.map(entry => [entry.name, entry]))
  assert.deepEqual(before.get('A')?.tags, ['机场A'])

  // B is linked to an account, C is not; both vanish; A changes transport; D appears
  pool.update((next) => { next.links['cpa:acc.json'] = { entryId: before.get('B')?.id as string, urlKey: 'k', at: '', via: 'assign' } })
  nodes = [
    { name: 'A', type: 'trojan', server: 'a.example.test', port: 443, password: 'pa', network: 'grpc', 'grpc-opts': { 'grpc-service-name': 's' } },
    { name: 'D', type: 'trojan', server: 'd.example.test', port: 443, password: 'pd' },
  ]
  // within the reuse window a refresh would get the preview's result; this one is a later, scheduled refresh
  const merged = await refreshSubscription(pool, subscription.id, { fetch, probe: allFree, now: () => Date.now() + SUBSCRIPTION_REUSE_MS })
  assert.equal(fetches, 2)
  assert.deepEqual({ added: merged.added.length, updated: merged.updated.length, removed: merged.removed, stale: merged.stale }, { added: 1, updated: 1, removed: 1, stale: 1 })
  const after = new Map(pool.read().entries.map(entry => [entry.name, entry]))
  assert.equal(after.get('A')?.id, before.get('A')?.id)
  assert.equal(after.get('A')?.port, before.get('A')?.port)
  assert.equal(after.get('B')?.staleInSubscription, true)
  assert.equal(after.has('C'), false)
  assert.notEqual(after.get('D')?.port, before.get('C')?.port, 'a removed port is not handed to the next node')
  assert.equal(pool.read().links['cpa:acc.json'].entryId, before.get('B')?.id)
})

test('one fetch per subscription address: duplicates in a paste, repeated parses and a refresh right after share it', async () => {
  clearPreviewsForTests()
  const pool = store()
  let fetches = 0
  const fetch = async (url: string) => { fetches++; assert.equal(url, SUB_URL); return body([{ name: 'A', type: 'trojan', server: 'a.example.test', port: 443, password: 'pa' }]) }
  const preview = await buildPreview(pool, Array.from({ length: 10 }, () => SUB_URL).join('\n'), { fetch })
  assert.equal(fetches, 1, 'ten identical links, one request')
  assert.equal(previewView(preview, { kernelAvailable: true }).subscriptions.length, 1)
  assert.ok(preview.notes.includes('重复的订阅链接已合并'))
  await Promise.all([buildPreview(pool, SUB_URL, { fetch }), buildPreview(pool, SUB_URL, { fetch })])
  assert.equal(fetches, 1, 'repeated 解析 within the window reuse the result')
  await buildPreview(pool, SUB_URL, { fetch, now: () => Date.now() + SUBSCRIPTION_REUSE_MS })
  assert.equal(fetches, 2, 'after the window the provider is asked again')
  // a failure is shared too: a burst of retries does not hammer a provider that just refused
  let failures = 0
  const { SubscriptionFetchError } = await import('./proxyParseSubscription.js')
  const failing = async () => { failures++; throw new SubscriptionFetchError('http_status', '订阅服务返回 HTTP 429', null, 429) }
  for (let i = 0; i < 3; i++) await buildPreview(pool, SUB_URL, { fetch: failing })
  assert.equal(failures, 1)
})

test('a queued or in-flight subscription request is joined, never duplicated, however long it takes', async () => {
  clearPreviewsForTests()
  const pool = store()
  let fetches = 0
  let released = false
  const waiting: Array<() => void> = []
  const slow = async () => {
    fetches++
    if (!released) await new Promise<void>(resolve => waiting.push(resolve))
    return body([{ name: 'A', type: 'trojan', server: 'a.example.test', port: 443, password: 'pa' }])
  }
  let clock = Date.now()
  const first = buildPreview(pool, SUB_URL, { fetch: slow, now: () => clock })
  // the first request is still waiting (limiter queue, slow provider) when the reuse window has long passed
  clock += 3 * SUBSCRIPTION_REUSE_MS
  const second = buildPreview(pool, SUB_URL, { fetch: slow, now: () => clock })
  released = true
  for (const resolve of waiting) resolve()
  await Promise.all([first, second])
  assert.equal(fetches, 1)
  // the window counts from when the request settled
  clock += SUBSCRIPTION_REUSE_MS - 1
  await buildPreview(pool, SUB_URL, { fetch: slow, now: () => clock })
  assert.equal(fetches, 1)
})

test('no free managed port: a mihomo row is skipped, never handed an unprobed (possibly occupied) port', async () => {
  clearPreviewsForTests()
  const pool = store()
  const preview = await buildPreview(pool, 'trojan://tpass-9@t9.example.test:443#T9\nhttp://u:p@203.0.113.9:8080#plain')
  const result = await commitImport(pool, preview, {}, { probe: async () => false })
  assert.equal(result.skipped, 1)
  assert.deepEqual(pool.read().entries.map(entry => entry.kind), ['url'])
})

test('subscription failures back off 1 h → 24 h and honour Retry-After; the error is masked', async () => {
  clearPreviewsForTests()
  const pool = store()
  const preview = await buildPreview(pool, SUB_URL, { fetch: async () => body([{ name: 'A', type: 'trojan', server: 'a.example.test', port: 443, password: 'pa' }]) })
  await commitImport(pool, preview, {}, { probe: allFree })
  const id = pool.read().subscriptions[0].id
  const { SubscriptionFetchError } = await import('./proxyParseSubscription.js')
  const failing = async () => { throw new SubscriptionFetchError('http_status', '订阅服务返回 HTTP 429', 3 * 3_600_000, 429) }
  const t0 = Date.parse('2026-10-02T00:00:00Z')
  await assert.rejects(refreshSubscription(pool, id, { fetch: failing, now: () => t0 }))
  let sub = pool.read().subscriptions[0]
  assert.equal(sub.failures, 1)
  assert.equal(Date.parse(sub.nextAt as string) - t0, 3 * 3_600_000, 'Retry-After wins over the 1 h backoff')
  await assert.rejects(refreshSubscription(pool, id, { fetch: async () => { throw new SubscriptionFetchError('network', '订阅连接失败') }, now: () => t0 }))
  sub = pool.read().subscriptions[0]
  assert.equal(Date.parse(sub.nextAt as string) - t0, 2 * 3_600_000)
  assert.equal(JSON.stringify(sub.error).includes('SUBTOKEN'), false)
})
