import assert from 'node:assert/strict'
import test from 'node:test'
import { performance } from 'node:perf_hooks'
import { DatabaseSync } from 'node:sqlite'

import { parseUsageSnapshot, type UsageSnapshot } from '../packages/contracts/index.js'
import { DataPlaneRelay, DataPlaneSnapshotClient, type DataPlaneRelayOptions, type DataPlaneUsageEvent } from './dataPlane.js'
import { dashboardFromSnapshot, dashboardSnapshotIsSuitable, providerPolicyHash, readDashboardSnapshot } from './dashboardSnapshot.js'
import { SnapshotStore } from './snapshotStore.js'

const generatedAt = '2026-08-31T10:15:00.000Z'
const snapshot: UsageSnapshot = {
  version: 1,
  days: 7,
  generatedAt,
  sourceWatermark: '2026-08-31T10:14:59.000Z',
  summary: {
    requests: 20,
    errors: 3,
    totalTokens: 450,
    inputTokens: 300,
    outputTokens: 150,
    cachedTokens: 75,
    cacheWriteTokens: 0,
    reasoningTokens: 25,
    averageLatencyMs: 42.5,
    averageTtftMs: 11,
  },
  trend: [{
    bucket: '2026-08-31T10:00:00.000Z',
    requests: 20,
    errors: 3,
    totalTokens: 450,
    inputTokens: 300,
    outputTokens: 150,
    cachedTokens: 75,
    cacheWriteTokens: 0,
    reasoningTokens: 25,
    averageLatencyMs: 42.5,
    averageTtftMs: 11,
  }],
  providers: [{
    name: 'codex',
    requests: 20,
    errors: 3,
    totalTokens: 450,
    inputTokens: 300,
    outputTokens: 150,
    cachedTokens: 75,
    cacheWriteTokens: 0,
    reasoningTokens: 25,
    averageLatencyMs: 42.5,
    averageTtftMs: 11,
  }],
  models: [],
  keys: [],
  clients: [],
}

const caughtUpRelay = () => ({ pending: 0, deadLetters: 0 })

function relayOptions(overrides: Partial<DataPlaneRelayOptions> = {}): DataPlaneRelayOptions {
  return {
    enabled: true,
    baseUrl: 'http://100.64.0.8:8788',
    token: 'x'.repeat(32),
    timeoutMs: 100,
    batchSize: 1,
    intervalMs: 1_000,
    backoffBaseMs: 60_000,
    backoffMaxMs: 60_000,
    ...overrides,
  }
}

function relayEvent(requestId: string, timestamp: string): DataPlaneUsageEvent {
  return {
    requestId,
    timestamp,
    timestampMs: Date.parse(timestamp),
    keyHash: 'a'.repeat(64),
    provider: 'codex',
    model: 'gpt-5.6-sol',
    modelGroup: 'codex',
    endpoint: '/v1/responses',
    success: true,
    statusCode: 200,
    latencyMs: 25,
    ttftMs: 10,
    inputTokens: 100,
    outputTokens: 20,
    reasoningTokens: 5,
    cachedTokens: 40,
    cacheWriteTokens: 0,
    totalTokens: 120,
    errorCategory: '',
    source: 'oauth',
    authIndex: 'account-1',
    clientType: 'codex',
  }
}

function acknowledgeRelay(init: RequestInit | undefined): Response {
  const body = JSON.parse(String(init?.body)) as { batchId: string; events: DataPlaneUsageEvent[] }
  return Response.json({
    batchId: body.batchId,
    accepted: body.events.length,
    received: body.events.length,
    inserted: body.events.length,
    duplicates: 0,
    sourceWatermark: body.events.at(-1)?.timestamp ?? null,
  })
}

test('maps a validated data-plane snapshot to the existing dashboard contract (activeKeys: null = not known in snapshot mode)', () => {
  assert.deepEqual(dashboardFromSnapshot({ value: snapshot, generatedAt: Date.parse(generatedAt), storedAt: Date.parse(generatedAt), stale: true }), {
    days: 7,
    summary: { requests: 20, tokens: 450, avgLatency: 42.5, errorRate: 0.15, activeKeys: null },
    trend: [{ bucket: '2026-08-31T10', requests: 20, tokens: 450, errors: 3 }],
    generatedAt,
    sourceWatermark: '2026-08-31T10:14:59.000Z',
    stale: true,
    source: 'data-plane',
  })
})

test('reads only supported, policy-scoped all-key dashboard snapshots', async () => {
  const calls: Array<{ key: string; endpoint: string; freshForMs: number }> = []
  const reader = {
    async read(key: string, endpoint: string, freshForMs: number) {
      calls.push({ key, endpoint, freshForMs })
      return { value: snapshot, generatedAt: Date.parse(generatedAt), storedAt: Date.parse(generatedAt), stale: false }
    },
  }

  const policyHash = providerPolicyHash(['codex'])
  assert.equal((await readDashboardSnapshot(reader, 7, '', ['codex'], Date.parse(snapshot.sourceWatermark!), caughtUpRelay, 30_000, 60_000))?.source, 'data-plane')
  assert.deepEqual(calls, [{ key: `dashboard:v1:7:all:${policyHash}`, endpoint: '/internal/v1/snapshots/7', freshForMs: 30_000 }])
  assert.equal(await readDashboardSnapshot(reader, 14, '', ['codex'], null, caughtUpRelay, 30_000, 60_000), null)
  assert.equal(await readDashboardSnapshot(reader, 7, 'key-hash', ['codex'], null, caughtUpRelay, 30_000, 60_000), null)
  assert.equal(calls.length, 1)
})

test('rejects snapshots that cannot preserve the active-provider or relay-watermark semantics', () => {
  const value = {
    ...snapshot,
    providers: [{ name: 'codex', ...snapshot.summary }],
  }
  const wrapped = { value, generatedAt: Date.parse(generatedAt), storedAt: Date.parse(generatedAt), stale: false }
  assert.equal(dashboardSnapshotIsSuitable(wrapped, ['codex'], Date.parse(value.sourceWatermark!), 60_000, caughtUpRelay(), Date.parse(generatedAt)), true)
  assert.equal(dashboardSnapshotIsSuitable(wrapped, ['codex'], Date.parse(value.sourceWatermark!), 60_000, { pending: 1, deadLetters: 0 }, Date.parse(generatedAt)), false)
  assert.equal(dashboardSnapshotIsSuitable(wrapped, ['codex'], Date.parse(value.sourceWatermark!), 60_000, { pending: 0, deadLetters: 1 }, Date.parse(generatedAt)), false)
  assert.equal(dashboardSnapshotIsSuitable(wrapped, ['claude'], Date.parse(value.sourceWatermark!), 60_000, caughtUpRelay(), Date.parse(generatedAt)), false)
  assert.equal(dashboardSnapshotIsSuitable(wrapped, ['codex'], Date.parse(value.sourceWatermark!) + 60_001, 60_000, caughtUpRelay(), Date.parse(generatedAt)), false)
  assert.equal(dashboardSnapshotIsSuitable({ ...wrapped, value: { ...value, providers: [{ name: '__other__', ...value.summary }] } }, ['__other__'], null, 60_000, caughtUpRelay(), Date.parse(generatedAt)), false)
  assert.equal(dashboardSnapshotIsSuitable({ ...wrapped, value: { ...value, providers: [{ name: 'codex', ...value.summary, requests: 19 }] } }, ['codex'], null, 60_000, caughtUpRelay(), Date.parse(generatedAt)), false)
})

test('rechecks relay integrity after reading a snapshot', async () => {
  let statusReads = 0
  const result = await readDashboardSnapshot(
    { async read() { return { value: snapshot, generatedAt: Date.parse(generatedAt), storedAt: Date.parse(generatedAt), stale: false } } },
    7,
    '',
    ['codex'],
    Date.parse(snapshot.sourceWatermark!),
    () => statusReads++ === 0 ? caughtUpRelay() : { pending: 1, deadLetters: 0 },
    30_000,
    60_000,
  )
  assert.equal(result, null)
  assert.equal(statusReads, 2)
})

test('rejects a snapshot when an older failed row is backing off after a newer event was sent', async () => {
  const database = new DatabaseSync(':memory:')
  let now = Date.parse('2026-08-31T10:15:00.000Z')
  let attempts = 0
  const delivered: string[] = []
  const relay = new DataPlaneRelay(database, relayOptions({
    now: () => now,
    fetch: (async (_url, init) => {
      attempts += 1
      if (attempts === 1) return new Response('', { status: 503 })
      const body = JSON.parse(String(init?.body)) as { events: DataPlaneUsageEvent[] }
      delivered.push(...body.events.map((event) => event.requestId))
      return acknowledgeRelay(init)
    }) as typeof fetch,
  }))

  relay.enqueue(relayEvent('older-failed', '2026-08-31T10:14:00.000Z'))
  assert.deepEqual(await relay.flush(), { sent: 0, pending: 1, errorCode: 'http_503' })
  now += 1_000
  relay.enqueue(relayEvent('newer-sent', snapshot.sourceWatermark!))
  assert.deepEqual(await relay.flush(), { sent: 1, pending: 1, errorCode: null })
  assert.deepEqual(delivered, ['newer-sent'])
  assert.deepEqual({ pending: relay.status().pending, deadLetters: relay.status().deadLetters }, { pending: 1, deadLetters: 0 })

  let snapshotReads = 0
  const result = await readDashboardSnapshot(
    { async read() {
      snapshotReads += 1
      return { value: snapshot, generatedAt: Date.parse(generatedAt), storedAt: Date.parse(generatedAt), stale: false }
    } },
    7,
    '',
    ['codex'],
    Date.parse(snapshot.sourceWatermark!),
    () => relay.status(),
    30_000,
    60_000,
  )
  assert.equal(result, null)
  assert.equal(snapshotReads, 0)
  database.close()
})

test('returns a stale SQLite L2 snapshot without awaiting a hanging remote refresh', async () => {
  const database = new DatabaseSync(':memory:')
  const now = Date.parse(generatedAt) + 31_000
  const store = new SnapshotStore(database, parseUsageSnapshot, { now: () => now })
  const policyHash = providerPolicyHash(['codex'])
  store.put(`dashboard:v1:7:all:${policyHash}`, snapshot, Date.parse(generatedAt))
  let remoteCalls = 0
  const client = new DataPlaneSnapshotClient(store, {
    enabled: true,
    baseUrl: 'http://100.64.0.9:8792',
    token: 'x'.repeat(32),
    timeoutMs: 500,
    fetch: (async () => {
      remoteCalls += 1
      return await new Promise<Response>(() => undefined)
    }) as typeof fetch,
  })

  const started = performance.now()
  const result = await readDashboardSnapshot(client, 7, '', ['codex'], Date.parse(snapshot.sourceWatermark!), caughtUpRelay, 30_000, 60_000)
  const elapsedMs = performance.now() - started
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(result?.stale, true)
  assert.equal(remoteCalls, 1)
  assert.ok(elapsedMs < 50, `stale L2 read took ${elapsedMs.toFixed(1)}ms`)
  database.close()
})
