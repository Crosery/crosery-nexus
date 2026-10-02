import './testDataDir.js'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  candidatePorts, effectiveProxyUrl, emptyPool, ENTRY_ID, fingerprintOf, matchEntryForUrl, observeAccount, ProxyError,
  ProxyPoolStore, randomId, retirePort, scrubProxySecrets, takePort, urlKeyOf, type PoolFile, type ProxyEntry,
} from './proxyPoolStore.js'
import { entryView, maskedExport, secretExport, subscriptionView } from './proxyPoolView.js'
import { parseProxyInput } from './proxyParse.js'
import { parseProxyUrl, urlDedupKey, nodeDedupKey } from './proxyParseClash.js'

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-store-'))
const mode = (file: string) => fs.statSync(file).mode & 0o777
const now = '2026-10-02T00:00:00.000Z'

function urlEntry(pool: PoolFile, url: string, extra: Partial<ProxyEntry> = {}): ProxyEntry {
  const endpoint = parseProxyUrl(url) as NonNullable<ReturnType<typeof parseProxyUrl>>
  return {
    id: randomId('px_'), name: endpoint.host, nameAuto: true, kind: 'url', protocol: endpoint.scheme === 'socks5h' ? 'socks5' : endpoint.scheme,
    url, server: endpoint.host, serverPort: endpoint.port, fingerprint: fingerprintOf(pool, urlDedupKey(endpoint)), source: 'manual',
    tags: [], enabled: true, validity: 'ok', createdAt: now, updatedAt: now, ...extra,
  }
}

function nodeEntry(pool: PoolFile, node: Record<string, unknown>, port: number, extra: Partial<ProxyEntry> = {}): ProxyEntry {
  return {
    id: randomId('px_'), name: 'node', nameAuto: false, kind: 'mihomo', protocol: 'trojan', node, server: String(node.server), serverPort: Number(node.port),
    fingerprint: fingerprintOf(pool, nodeDedupKey('trojan', node)), port, source: 'clash', tags: [], enabled: true, validity: 'unverified',
    createdAt: now, updatedAt: now, ...extra,
  }
}

test('missing directory is an empty pool; the first write creates 0700 dir + 0600 file atomically', () => {
  const root = tempDir()
  const store = new ProxyPoolStore(path.join(root, 'proxy'))
  assert.deepEqual(store.read().entries, [])
  assert.equal(fs.existsSync(store.dir), false, 'reading never creates files')
  store.update((pool) => { pool.entries.push(urlEntry(pool, 'http://u:p@203.0.113.1:8080')) })
  assert.equal(mode(store.dir), 0o700)
  assert.equal(mode(store.poolFile), 0o600)
  assert.deepEqual(fs.readdirSync(store.dir), ['pool.json'])
  const pool = store.read()
  assert.equal(pool.version, 1)
  assert.match(pool.salt, /^[0-9a-f]{64}$/)
  assert.ok(pool.listenerAuth.username && pool.listenerAuth.password)
  assert.equal(pool.entries.length, 1)
  // a looser pre-existing directory is tightened
  fs.chmodSync(store.dir, 0o755)
  store.update(() => undefined)
  assert.equal(mode(store.dir), 0o700)
  store.updateHealth((health) => { health.entries.x = { lastAt: now } })
  assert.equal(mode(store.healthFile), 0o600)
})

test('a mutator that throws leaves the file untouched', () => {
  const store = new ProxyPoolStore(path.join(tempDir(), 'proxy'))
  store.update((pool) => { pool.entries.push(urlEntry(pool, 'socks5://198.51.100.1:1080')) })
  const before = fs.readFileSync(store.poolFile, 'utf8')
  assert.throws(() => store.update((pool) => { pool.entries = []; throw new Error('boom') }), /boom/)
  assert.equal(fs.readFileSync(store.poolFile, 'utf8'), before)
  assert.equal(store.read().entries.length, 1)
})

test('unknown version, corrupt JSON, oversize: read-only, never overwritten', () => {
  for (const content of [JSON.stringify({ version: 2, entries: [{ id: 'px_aaaaaaaaaa' }] }), '{not json', ' '.repeat(9 * 1024 * 1024)]) {
    const store = new ProxyPoolStore(path.join(tempDir(), 'proxy'))
    fs.mkdirSync(store.dir, { recursive: true })
    fs.writeFileSync(store.poolFile, content)
    const snapshot = store.snapshot()
    assert.ok(snapshot.readOnly)
    assert.deepEqual(snapshot.pool.entries, [])
    assert.throws(() => store.update(() => undefined), (error: unknown) => error instanceof ProxyError && error.code === 'pool_read_only')
    assert.equal(fs.readFileSync(store.poolFile, 'utf8'), content)
  }
})

test('ids are px_ + 10 base32 characters, random; fingerprints depend on the salt only', () => {
  const ids = new Set(Array.from({ length: 200 }, () => randomId('px_')))
  assert.equal(ids.size, 200)
  for (const id of ids) assert.match(id, ENTRY_ID)
  const a = { salt: 'a'.repeat(64) }
  const b = { salt: 'b'.repeat(64) }
  assert.equal(fingerprintOf(a, 'k'), fingerprintOf(a, 'k'))
  assert.notEqual(fingerprintOf(a, 'k'), fingerprintOf(b, 'k'))
  assert.match(fingerprintOf(a, 'k'), /^[0-9a-f]{16}$/)
})

test('ports: lowest free in range, skipping used/retired/busy; retired ports are not reused while the range has room', async () => {
  const pool = { ...emptyPool(), salt: 's'.repeat(64) }
  const settings = { portBase: 30000, portCount: 5, listenerAuth: true, cpaSameHostOverride: null }
  pool.entries.push(nodeEntry(pool, { server: 'a.test', port: 1, password: 'x' }, 30000))
  retirePort(pool, 30001)
  const busy = new Set([30002])
  const probed = await candidatePorts(pool, 2, async port => !busy.has(port), settings)
  assert.deepEqual(probed, [30003, 30004])
  assert.equal(takePort(pool, probed, settings), 30003)
  pool.entries.push(nodeEntry(pool, { server: 'b.test', port: 1, password: 'y' }, 30003))
  pool.entries.push(nodeEntry(pool, { server: 'c.test', port: 1, password: 'z' }, 30004))
  // never an unprobed port: 30002 is busy (another local proxy), so it is not handed out
  assert.equal(takePort(pool, [], settings), null, 'no probed port, no allocation')
  assert.deepEqual(await candidatePorts(pool, 2, async port => !busy.has(port), settings), [30001], 'range exhausted: the retired port, probed')
  busy.add(30001)
  assert.deepEqual(await candidatePorts(pool, 2, async port => !busy.has(port), settings), [], 'a busy retired port is not offered')
  busy.delete(30001)
  const reused = await candidatePorts(pool, 1, async port => !busy.has(port), settings)
  assert.equal(takePort(pool, reused, settings), 30001)
  assert.equal(pool.retiredPorts.includes(30001), false, 'a reused port leaves the retired list')
})

test('effective URL: url entries as is; mihomo entries socks5 with listener auth unless PROXY_LISTENER_AUTH=off', () => {
  const pool = { ...emptyPool(), salt: 's'.repeat(64), listenerAuth: { username: 'cru', password: 'p@ss/word' } }
  const url = urlEntry(pool, 'http://u:p@203.0.113.1:8080')
  const node = nodeEntry(pool, { server: 'n.test', port: 443, password: 'x' }, 27891)
  assert.equal(effectiveProxyUrl(pool, url), 'http://u:p@203.0.113.1:8080')
  assert.equal(effectiveProxyUrl(pool, node, { portBase: 27890, portCount: 1000, listenerAuth: true, cpaSameHostOverride: null }), 'socks5://cru:p%40ss%2Fword@127.0.0.1:27891')
  assert.equal(effectiveProxyUrl(pool, node, { portBase: 27890, portCount: 1000, listenerAuth: false, cpaSameHostOverride: null }), 'socks5://127.0.0.1:27891')
})

test('link index: same dedup key links (socks5h, case), a managed port links its node, drift unlinks, prev survives', () => {
  const pool = { ...emptyPool(), salt: 's'.repeat(64), listenerAuth: { username: 'u', password: 'p' } }
  const url = urlEntry(pool, 'socks5://user:pw@Res.Example.test:1080')
  const node = nodeEntry(pool, { server: 'n.test', port: 443, password: 'x' }, 27895)
  pool.entries.push(url, node)
  assert.equal(matchEntryForUrl(pool, 'socks5h://user:pw@res.example.test')?.id, url.id)
  assert.equal(matchEntryForUrl(pool, 'socks5://u:p@127.0.0.1:27895')?.id, node.id)
  assert.equal(matchEntryForUrl(pool, 'socks5://other:pw@res.example.test:1080'), null)
  observeAccount(pool, 'cpa:a.json', 'socks5h://user:pw@res.example.test', 'claude', 'migrate', now)
  assert.equal(pool.links['cpa:a.json'].entryId, url.id)
  assert.equal(pool.links['cpa:a.json'].urlKey, urlKeyOf(pool, 'socks5h://user:pw@res.example.test'))
  assert.equal(pool.observed['cpa:a.json'].masked, 'socks5h://***@res.example.test')
  pool.links['cpa:a.json'].prev = 'http://old:secret@198.51.100.9:3128'
  observeAccount(pool, 'cpa:a.json', 'socks5://user:pw@res.example.test:1080', 'claude', 'scan', now)
  assert.equal(pool.links['cpa:a.json'].prev, 'http://old:secret@198.51.100.9:3128')
  observeAccount(pool, 'cpa:a.json', 'direct', 'claude', 'scan', now)
  assert.equal(pool.links['cpa:a.json'], undefined)
  assert.equal(pool.observed['cpa:a.json'].mode, 'direct')
})

const SECRET_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
const randomSecret = () => `S${Array.from(randomBytes(14), byte => SECRET_ALPHABET[byte % SECRET_ALPHABET.length]).join('')}`

test('masking property: random secrets never reach any projection, export or scrubbed message', () => {
  for (let round = 0; round < 25; round++) {
    const secrets = Array.from({ length: 10 }, randomSecret)
    const uuid = '0f0e0d0c-0b0a-4908-8706-050403020100'
    const pool: PoolFile = { ...emptyPool(), salt: 's'.repeat(64), listenerAuth: { username: 'lu', password: secrets[0] } }
    const url = urlEntry(pool, `socks5://${secrets[1]}:${secrets[2]}@203.0.113.${round}:1080`)
    // transport header values are credentials under any header name (Cookie, X-Api-Key, …)
    const node = nodeEntry(pool, {
      server: 'n.example.test', port: 443, password: secrets[3], 'ws-opts': { path: '/w', headers: { Host: 'cdn.example.test', Cookie: secrets[8] } },
      'http-opts': { headers: { 'X-Api-Key': [secrets[9]] } }, 'plugin-opts': { password: secrets[4] },
    }, 27900 + round)
    const vless: ProxyEntry = { ...nodeEntry(pool, { server: 'v.example.test', port: 443, uuid }, 28000 + round), protocol: 'vless' }
    pool.entries.push(url, node, vless)
    pool.subscriptions.push({ id: randomId('sub_'), name: 'air', url: `https://sub.example.test/api/${secrets[5]}?token=${secrets[6]}`, intervalH: 12, lastFetchAt: null, nextAt: null, failures: 0, nodeCount: 0, createdAt: now })
    pool.links['cpa:x.json'] = { entryId: url.id, urlKey: 'k', prev: `http://a:${secrets[7]}@198.51.100.1:1`, at: now, via: 'assign' }
    const context = { backend: 'cpa' as const, cpaSameHost: true, kernel: { state: 'running' as const } }
    const outputs = [
      JSON.stringify(pool.entries.map(entry => entryView(entry, undefined, undefined, context))),
      JSON.stringify(pool.subscriptions.map(subscriptionView)),
      JSON.stringify(maskedExport(pool)),
      scrubProxySecrets(`failed ${url.url} with ${secrets[3]} uuid ${uuid} sub ${pool.subscriptions[0].url} trojan://${secrets[3]}@x:1 proxy 3: bad`, pool),
      scrubProxySecrets(`ws handshake sent Cookie: ${secrets[8]} and X-Api-Key ${secrets[9]}`, pool),
      scrubProxySecrets(`dial socks5://${secrets[1]}:${secrets[2]}@h:1 then https://other.test/path?key=${secrets[6]}`),
    ]
    for (const output of outputs) {
      for (const secret of [...secrets, uuid]) assert.equal(output.includes(secret), false, `secret leaked in ${output.slice(0, 200)}`)
    }
    assert.ok(outputs[3].includes('proxy *'))
  }
})

test('export round-trip: the full export re-imports to the same fingerprints; the masked one does not import secrets', () => {
  const pool: PoolFile = { ...emptyPool(), salt: 's'.repeat(64), listenerAuth: { username: 'lu', password: 'lp' } }
  const url = urlEntry(pool, 'http://u:p@203.0.113.7:3128', { tags: ['us'] })
  const open = urlEntry(pool, 'socks5://198.51.100.20:1080')
  const node = nodeEntry(pool, { server: 't.example.test', port: 443, password: 'tp', sni: 's.test' }, 27890)
  pool.entries.push(url, open, node)
  pool.links['cpa:claude-a.json'] = { entryId: url.id, urlKey: 'k', at: now, via: 'migrate', provider: 'claude' }
  const full = secretExport(pool)
  assert.equal(full.assignments.length, 1)
  const reparsed = parseProxyInput(JSON.stringify(full))
  assert.equal(reparsed.format, 'export')
  assert.deepEqual(reparsed.candidates.map(candidate => candidate.status), ['ok', 'ok', 'ok'])
  assert.deepEqual(reparsed.candidates.map(candidate => fingerprintOf(pool, candidate.dedupKey as string)), [url.fingerprint, open.fingerprint, node.fingerprint])
  assert.deepEqual(reparsed.candidates[0].tags, ['us'])
  const masked = parseProxyInput(JSON.stringify(maskedExport(pool)))
  assert.deepEqual(masked.candidates.map(candidate => candidate.status), ['invalid', 'ok', 'invalid'])
  assert.equal(masked.candidates[0].reason, '脱敏导出不含密码，无法导入')
})
