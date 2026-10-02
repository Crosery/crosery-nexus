import './testDataDir.js'

import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createKernelPort, desiredFromPool, recordApplyOutcome } from './mihomoPool.js'
import { MihomoKernel, socksGreeting } from './mihomoKernel.js'
import { ProxyPoolStore, type ProxyEntry } from './proxyPoolStore.js'
import { writeFakeMihomo } from './testing/fakeMihomo.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mihomo-pool-'))
const fakeBin = writeFakeMihomo(root)
const kernels: MihomoKernel[] = []
test.after(async () => { for (const kernel of kernels) await kernel.stop().catch(() => undefined) })

const now = new Date().toISOString()
let counter = 0
function entry(port: number, extra: Partial<ProxyEntry> = {}, node: Record<string, unknown> = {}): ProxyEntry {
  const id = `px_${'abcdefghij'.slice(0, 9)}${'klmnopqrst'[counter++ % 10]}`
  return {
    id, name: `日本 ${id}`, nameAuto: false, kind: 'mihomo', protocol: 'ss' as ProxyEntry['protocol'],
    node: { type: 'ss', server: 'jp.example.com', port: 8388, cipher: 'aes-128-gcm', password: `pw-${id}`, ...node } as unknown as ProxyEntry['node'],
    server: 'jp.example.com', serverPort: 8388, fingerprint: id, port, source: 'manual', tags: [], enabled: true, validity: 'unverified', createdAt: now, updatedAt: now,
    ...extra,
  }
}

function poolWith(entries: ProxyEntry[]): ProxyPoolStore {
  const store = new ProxyPoolStore(path.join(fs.mkdtempSync(path.join(root, 'p-')), 'proxy'))
  store.update((pool) => { pool.entries.push(...entries) })
  return store
}

async function freeBase(count: number): Promise<number> {
  for (let base = 33_000 + Math.floor(Math.random() * 6_000); base < 60_000; base += count + 5) {
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

function kernelFor(base: number, available = true) {
  const kernel = new MihomoKernel({
    dir: path.join(fs.mkdtempSync(path.join(root, 'k-')), 'mihomo'),
    env: { PATH: process.env.PATH, PROXY_PORT_BASE: String(base), PROXY_PORT_COUNT: '10' },
    resolveBinary: async () => (available ? { ok: true, source: 'env', sourcePath: fakeBin, runPath: fakeBin, copied: false, version: '1.19.31' } : { ok: false, reason: '未找到 mihomo' }),
    debounceMs: 5,
    log: () => undefined,
  })
  kernels.push(kernel)
  return kernel
}

test('desiredFromPool: only enabled, valid, ported mihomo entries; listener auth unless turned off', () => {
  const keep = entry(27890)
  const store = poolWith([
    keep,
    entry(27891, { enabled: false }),
    entry(27892, { validity: 'invalid' }),
    entry(0, { port: undefined }),
    { ...entry(27893), kind: 'url', url: 'http://u:p@h.example.com:8080', node: undefined },
  ])
  const desired = desiredFromPool(store, { portBase: 27890, portCount: 1000, listenerAuth: true, cpaSameHostOverride: null })!
  assert.deepEqual(desired.entries.map(item => item.id), [keep.id])
  assert.ok(desired.listenerAuth?.username && desired.listenerAuth.password)
  assert.equal(desiredFromPool(store, { portBase: 27890, portCount: 1000, listenerAuth: false, cpaSameHostOverride: null })!.listenerAuth, null)
  // a pool written by a newer console is read-only: no desired state, so a running kernel is left alone
  fs.writeFileSync(store.poolFile, JSON.stringify({ version: 2 }))
  assert.equal(desiredFromPool(store), null)
})

test('recordApplyOutcome: marks rejected nodes invalid (scrubbed), unverified → ok, no write when nothing changes', () => {
  const good = entry(27890)
  const bad = entry(27891)
  const store = poolWith([good, bad])
  const changed = recordApplyOutcome(store, { state: 'running', invalid: [{ id: bad.id, reason: `ss jp.example.com:8388 bad pw-${bad.id}` }], bindFailed: [], running: [good.id] })
  assert.equal(changed, 2)
  const pool = store.read()
  const savedBad = pool.entries.find(item => item.id === bad.id)!
  assert.equal(savedBad.validity, 'invalid')
  assert.ok(!String(savedBad.invalidReason).includes(`pw-${bad.id}`), String(savedBad.invalidReason))
  assert.equal(pool.entries.find(item => item.id === good.id)!.validity, 'ok')
  const stamp = fs.statSync(store.poolFile).mtimeMs
  assert.equal(recordApplyOutcome(store, { state: 'running', invalid: [], bindFailed: [], running: [good.id] }), 0)
  assert.equal(fs.statSync(store.poolFile).mtimeMs, stamp)
})

test('kernel port: reload from the pool, invalid nodes written back, validate, stop/start actions', async () => {
  const base = await freeBase(10)
  const good = entry(base)
  const bad = entry(base + 1, {}, { cipher: 'bogus' })
  const store = poolWith([good, bad])
  const kernel = kernelFor(base)
  await kernel.boot()
  const port = createKernelPort(kernel, store, () => undefined)
  assert.equal(port.status().state, 'idle')
  port.requestReload('test')
  const deadline = Date.now() + 5_000
  while (store.read().entries.find(item => item.id === bad.id)!.validity !== 'invalid') {
    assert.ok(Date.now() < deadline, 'bad node marked invalid')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.equal(port.status().state, 'running')
  assert.equal(store.read().entries.find(item => item.id === good.id)!.validity, 'ok')
  assert.equal(await socksGreeting(base, true), true)

  const checked = await port.validate!([entry(0, {}, { cipher: 'bogus' }), entry(0)])
  assert.equal(checked?.size, 1)

  assert.equal((await port.action!('stop')).state, 'stopped')
  assert.equal(await socksGreeting(base, true), false)
  assert.equal((await port.action!('start')).state, 'running')
  assert.equal(await socksGreeting(base, true), true)
})

test('kernel port without a binary: unavailable, validate → null (nodes stay unverified)', async () => {
  const kernel = kernelFor(27890, false)
  await kernel.boot()
  const store = poolWith([entry(27890)])
  const port = createKernelPort(kernel, store, () => undefined)
  assert.equal(port.status().state, 'unavailable')
  assert.equal(await port.validate!([entry(0)]), null)
})
