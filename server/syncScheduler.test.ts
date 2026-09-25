import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'

import { ReportingGroupStore } from './reportingGroups.js'

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'console-sync-scheduler-'))
const originalFetch = globalThis.fetch
process.env.DATA_DIR = directory
process.env.CPA_BASE_URL = 'https://cpa.example.test'
process.env.CPA_MANAGEMENT_KEY = 'test-management-key'
process.env.DATA_PLANE_ENABLED = 'false'

const sync = await import(`./sync.ts?test=${Date.now()}`)
const { db } = await import('./db.js')

after(() => {
  globalThis.fetch = originalFetch
  db.close()
  fs.rmSync(directory, { recursive: true, force: true })
})

test('single-flight cycle skips overlapping ticks and runs again after completion', async () => {
  let calls = 0
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => { release = resolve })
  const run = sync.createSingleFlightCycle(async () => {
    calls += 1
    await gate
  })

  const first = run()
  assert.equal(await run(), false)
  assert.equal(calls, 1)
  release?.()
  assert.equal(await first, true)
  assert.equal(await run(), true)
  assert.equal(calls, 2)
})

test('single-flight cycle releases its guard after a failure', async () => {
  let fail = true
  let calls = 0
  const run = sync.createSingleFlightCycle(async () => {
    calls += 1
    if (fail) throw new Error('temporary')
  })

  await assert.rejects(run(), /temporary/)
  fail = false
  assert.equal(await run(), true)
  assert.equal(calls, 2)
})

test('control-plane reconciliation keeps quota enforcement but excludes usage collection', async () => {
  const order: string[] = []
  await sync.runReconciliationSteps({
    syncKeys: async () => { order.push('keys') },
    reconcileModelAccess: async () => { order.push('models') },
    enforceQuotaLimits: async () => { order.push('quotas') },
    reconcileNginx: async () => { order.push('nginx') },
    prune: () => { order.push('prune') },
  })
  assert.deepEqual(order, ['keys', 'models', 'quotas', 'nginx', 'prune'])
})

test('schedules collector and reconciliation at independent intervals', async () => {
  const delays: number[] = []
  const callbacks: Array<() => void> = []
  const starts: string[] = []
  const fakeHandle = { unref() {} } as ReturnType<typeof setInterval>

  sync.scheduleSyncCycles({
    usageCollectIntervalMs: 1_000,
    syncIntervalMs: 15_000,
    runUsageCollector: async () => { starts.push('collect') },
    runReconciliation: async () => { starts.push('reconcile') },
    schedule: (callback: () => void, delay: number) => {
      callbacks.push(callback)
      delays.push(delay)
      return fakeHandle
    },
  })

  assert.deepEqual(starts, ['collect', 'reconcile'])
  assert.deepEqual(delays, [1_000, 15_000])
  callbacks.forEach((callback) => callback())
  await Promise.resolve()
  assert.deepEqual(starts, ['collect', 'reconcile', 'collect', 'reconcile'])
})

test('collector leaves the destructive queue untouched until local groups exist', async () => {
  const calls: string[] = []
  globalThis.fetch = async (input) => {
    calls.push(String(input))
    throw new Error('collector must not call CPA before local groups exist')
  }

  assert.equal(await sync.collectUsage(), 0)
  assert.deepEqual(calls, [])
})

test('high-frequency collector reads only persisted reporting groups', async () => {
  new ReportingGroupStore(db).write([{
    id: 'claude',
    name: 'Claude',
    color: '#8b5cf6',
    kind: 'oauth',
    models: ['claude-opus-5'],
  }])
  const calls: string[] = []
  globalThis.fetch = async (input) => {
    const url = String(input)
    calls.push(url)
    if (url === 'https://cpa.example.test/v0/management/usage-queue?count=500') {
      return new Response(JSON.stringify([{
        request_id: 'usage-local-groups',
        timestamp: '2026-08-31T12:00:00.000Z',
        provider: 'claude',
        model: 'claude-opus-5',
        endpoint: '/v1/messages',
        tokens: { input_tokens: 2, cached_tokens: 100, output_tokens: 4, total_tokens: 106 },
      }]), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    throw new Error(`unexpected control-plane request: ${url}`)
  }

  assert.equal(await sync.collectUsage(), 1)
  assert.deepEqual(calls, ['https://cpa.example.test/v0/management/usage-queue?count=500'])
  const row = db.prepare('SELECT provider, model_group modelGroup FROM usage_events WHERE request_id = ?')
    .get('usage-local-groups') as { provider: string; modelGroup: string }
  assert.equal(row.provider, 'claude')
  assert.equal(row.modelGroup, 'claude')
})

test('collector durably records usage when a CPA key arrives before reconciliation', async () => {
  new ReportingGroupStore(db).write([{
    id: 'claude',
    name: 'Claude',
    color: '#8b5cf6',
    kind: 'oauth',
    models: ['claude-opus-5'],
  }])
  const key = 'sk-late-00112233445566778899aabbccddeeff'
  const keyHash = createHash('sha256').update(key).digest('hex')
  const timestamp = '2026-08-31T12:01:00.000Z'
  const calls: string[] = []
  globalThis.fetch = async (input) => {
    const url = String(input)
    calls.push(url)
    if (url === 'https://cpa.example.test/v0/management/usage-queue?count=500') {
      return new Response(JSON.stringify([{
        request_id: 'usage-before-key-sync',
        timestamp,
        api_key: key,
        provider: 'claude',
        model: 'claude-opus-5',
        endpoint: '/v1/messages',
        tokens: { input_tokens: 10, cached_tokens: 20, output_tokens: 5, total_tokens: 35 },
      }]), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    if (url === 'https://cpa.example.test/v0/management/api-keys') {
      return new Response(JSON.stringify({ 'api-keys': [key] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    throw new Error(`unexpected control-plane request: ${url}`)
  }

  assert.equal(await sync.collectUsage(), 1)
  assert.equal(db.prepare('SELECT 1 FROM api_keys WHERE key_hash = ?').get(keyHash), undefined)
  assert.deepEqual(
    { ...db.prepare('SELECT key_hash keyHash FROM usage_events WHERE request_id = ?').get('usage-before-key-sync') },
    { keyHash: null },
  )
  assert.deepEqual(
    { ...db.prepare('SELECT key_hash keyHash FROM quota_usage_events WHERE request_id = ?').get('usage-before-key-sync') },
    { keyHash },
  )

  await sync.syncKeysFromCPA()

  assert.deepEqual(
    { ...db.prepare('SELECT key_value keyValue, name, enabled, last_used_at lastUsedAt FROM api_keys WHERE key_hash = ?').get(keyHash) },
    { keyValue: key, name: 'late', enabled: 1, lastUsedAt: timestamp },
  )
  assert.deepEqual(
    { ...db.prepare('SELECT key_hash keyHash FROM usage_events WHERE request_id = ?').get('usage-before-key-sync') },
    { keyHash },
  )
  assert.deepEqual(calls, [
    'https://cpa.example.test/v0/management/usage-queue?count=500',
    'https://cpa.example.test/v0/management/api-keys',
  ])
})
