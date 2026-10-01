import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { parseUsageSnapshot, type IngestUsageResponse, type UsageSnapshot } from '../packages/contracts/index.js'
import {
  DataPlaneRelay,
  DataPlaneSnapshotClient,
  nextLegacyUsageRequestId,
  stableUsageRequestId,
  type DataPlaneRelayOptions,
  type DataPlaneUsageEvent,
} from './dataPlane.js'
import { SnapshotStore } from './snapshotStore.js'

const usageEvent = (requestId: string): DataPlaneUsageEvent => ({
  requestId,
  timestamp: '2026-08-31T00:00:00.000Z',
  timestampMs: Date.parse('2026-08-31T00:00:00.000Z'),
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
})

function options(overrides: Partial<DataPlaneRelayOptions> = {}): DataPlaneRelayOptions {
  return {
    enabled: true,
    baseUrl: 'http://100.64.0.8:8788',
    token: 'relay-secret',
    timeoutMs: 100,
    batchSize: 100,
    intervalMs: 1_000,
    backoffBaseMs: 500,
    backoffMaxMs: 10_000,
    ...overrides,
  }
}

function acknowledgement(init: RequestInit | undefined, overrides: Partial<IngestUsageResponse> = {}): Response {
  const body = JSON.parse(String(init?.body)) as { batchId: string; events: DataPlaneUsageEvent[] }
  const received = body.events.length
  return Response.json({
    batchId: body.batchId,
    accepted: received,
    received,
    inserted: received,
    duplicates: 0,
    sourceWatermark: body.events.at(-1)?.timestamp ?? null,
    ...overrides,
  })
}

const emptySummary = {
  requests: 0,
  errors: 0,
  totalTokens: 0,
  inputTokens: 0,
  outputTokens: 0,
  cachedTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  averageLatencyMs: 0,
  averageTtftMs: 0,
}

function usageSnapshot(generatedAt: string): UsageSnapshot {
  return {
    version: 1,
    days: 7,
    generatedAt,
    sourceWatermark: null,
    summary: emptySummary,
    trend: [],
    providers: [],
    models: [],
    keys: [],
    clients: [],
  }
}

test('deduplicates requestId and replays durable rows after a failed delivery', async () => {
  const database = new DatabaseSync(':memory:')
  let now = 1_000
  const failed = new DataPlaneRelay(database, options({
    now: () => now,
    fetch: (async () => new Response('', { status: 503 })) as typeof fetch,
  }))
  assert.equal(failed.enqueue(usageEvent('req-1')), true)
  assert.equal(failed.enqueue(usageEvent('req-1')), false)
  assert.deepEqual(await failed.flush(), { sent: 0, pending: 1, errorCode: 'http_503' })

  let sentBody = ''
  let authorization = ''
  now += 501
  const replay = new DataPlaneRelay(database, options({
    now: () => now,
    fetch: (async (_url, init) => {
      sentBody = String(init?.body || '')
      authorization = new Headers(init?.headers).get('authorization') || ''
      return acknowledgement(init)
    }) as typeof fetch,
  }))
  assert.deepEqual(await replay.flush(), { sent: 1, pending: 0, errorCode: null })
  assert.equal(JSON.parse(sentBody).events[0].requestId, 'req-1')
  assert.equal(authorization, 'Bearer relay-secret')
  assert.equal(sentBody.includes('relay-secret'), false)
  assert.deepEqual(replay.status(), {
    enabled: true,
    pending: 0,
    deadLetters: 0,
    oldestPendingAgeMs: null,
    lastErrorCode: null,
    lastAttemptAt: 1_501,
    lastSuccessAt: 1_501,
    effectiveBatchSize: 100,
  })
  database.close()
})

test('times out without losing the row and records only a bounded error code', async () => {
  const database = new DatabaseSync(':memory:')
  const relay = new DataPlaneRelay(database, options({
    timeoutMs: 10,
    fetch: ((...args: Parameters<typeof fetch>) => new Promise<Response>((_resolve, reject) => {
      const signal = args[1]?.signal
      signal?.addEventListener('abort', () => reject(new DOMException('secret upstream detail', 'AbortError')), { once: true })
    })) as typeof fetch,
  }))
  relay.enqueue(usageEvent('req-timeout'))

  assert.deepEqual(await relay.flush(), { sent: 0, pending: 1, errorCode: 'timeout' })
  const row = database.prepare(`
    SELECT attempts, last_error_code errorCode FROM data_plane_outbox WHERE request_id = ?
  `).get('req-timeout') as { attempts: number; errorCode: string }
  assert.equal(row.attempts, 1)
  assert.equal(row.errorCode, 'timeout')
  database.close()
})

test('requestFlush schedules remote work instead of running it on the caller path', async () => {
  const database = new DatabaseSync(':memory:')
  const scheduled: Array<() => void> = []
  let calls = 0
  const relay = new DataPlaneRelay(database, options({
    schedule: (task) => scheduled.push(task),
    fetch: (async (_url, init) => { calls += 1; return acknowledgement(init) }) as typeof fetch,
  }))
  relay.enqueue(usageEvent('req-deferred'))
  relay.requestFlush()
  assert.equal(calls, 0)
  assert.equal(scheduled.length, 1)

  scheduled.shift()?.()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(calls, 1)
  assert.equal(relay.pending(), 0)
  database.close()
})

test('keeps the whole batch when the receiver does not acknowledge every event', async () => {
  const database = new DatabaseSync(':memory:')
  const relay = new DataPlaneRelay(database, options({
    fetch: (async (_url, init) => acknowledgement(init, { accepted: 1 })) as typeof fetch,
  }))
  relay.enqueue(usageEvent('req-partial-1'))
  relay.enqueue(usageEvent('req-partial-2'))

  assert.deepEqual(await relay.flush(), { sent: 0, pending: 2, errorCode: 'invalid_ack' })
  assert.equal(relay.status().lastErrorCode, 'invalid_ack')
  database.close()
})

test('keeps the whole batch when any acknowledgement identity or count is invalid', async (t) => {
  const cases: Array<[string, Partial<IngestUsageResponse>]> = [
    ['wrong batch id', { batchId: 'another-batch' }],
    ['wrong received count', { received: 0 }],
    ['unbalanced inserted and duplicates', { inserted: 0, duplicates: 0 }],
    ['invalid watermark', { sourceWatermark: 'not-a-timestamp' }],
  ]
  for (const [name, override] of cases) {
    await t.test(name, async () => {
      const database = new DatabaseSync(':memory:')
      const relay = new DataPlaneRelay(database, options({
        fetch: (async (_url, init) => acknowledgement(init, override)) as typeof fetch,
      }))
      relay.enqueue(usageEvent(`req-${name}`))
      assert.deepEqual(await relay.flush(), { sent: 0, pending: 1, errorCode: 'invalid_ack' })
      database.close()
    })
  }
})

test('quarantines wrong runtime types and non-finite or inconsistent numeric fields', () => {
  const database = new DatabaseSync(':memory:')
  const relay = new DataPlaneRelay(database, options())
  const invalid = [
    { ...usageEvent('bad-string'), inputTokens: '100' },
    { ...usageEvent('bad-nan'), latencyMs: Number.NaN },
    { ...usageEvent('bad-infinity'), outputTokens: Number.POSITIVE_INFINITY },
    { ...usageEvent('bad-boolean'), success: 1 },
    { ...usageEvent('bad-status'), statusCode: 999 },
    { ...usageEvent('bad-time'), timestampMs: usageEvent('unused').timestampMs + 1 },
    { ...usageEvent('bad-request-id'), requestId: 'r'.repeat(201) },
    { ...usageEvent('bad-client-type'), clientType: 'c'.repeat(129) },
  ]
  for (const event of invalid) {
    assert.equal(relay.enqueue(event as unknown as DataPlaneUsageEvent), false)
  }

  assert.equal(relay.pending(), 0)
  assert.equal(relay.quarantined(), invalid.length)
  const payload = database.prepare(`
    SELECT payload_json payload FROM data_plane_dead_letters WHERE request_id = 'bad-infinity'
  `).get() as { payload: string }
  assert.match(payload.payload, /"invalidNumber":"Infinity"/)
  database.close()
})

test('quarantines one corrupt outbox row and continues relaying valid rows behind it', async () => {
  const database = new DatabaseSync(':memory:')
  let sentRequestIds: string[] = []
  const relay = new DataPlaneRelay(database, options({
    now: () => 1_000,
    fetch: (async (_url, init) => {
      sentRequestIds = (JSON.parse(String(init?.body)).events as DataPlaneUsageEvent[]).map((event) => event.requestId)
      return acknowledgement(init)
    }) as typeof fetch,
  }))
  database.prepare(`
    INSERT INTO data_plane_outbox
      (request_id, payload_json, created_at, attempts, next_attempt_at, last_error_code)
    VALUES (?, ?, 0, 3, 0, '')
  `).run('bad-first', '{not-json')
  relay.enqueue(usageEvent('good-second'))

  assert.deepEqual(await relay.flush(), { sent: 1, pending: 0, errorCode: 'invalid_outbox' })
  assert.deepEqual(sentRequestIds, ['good-second'])
  assert.equal(relay.quarantined(), 1)
  const dead = database.prepare(`
    SELECT request_id requestId, payload_json payload, attempts, error_code errorCode
    FROM data_plane_dead_letters
  `).get() as { requestId: string; payload: string; attempts: number; errorCode: string }
  assert.equal(dead.requestId, 'bad-first')
  assert.equal(dead.payload, '{not-json')
  assert.equal(dead.attempts, 3)
  assert.equal(dead.errorCode, 'invalid_outbox')
  database.close()
})

test('retains contract failures with maximum backoff instead of dropping validated rows', async () => {
  const database = new DatabaseSync(':memory:')
  const relay = new DataPlaneRelay(database, options({
    now: () => 4_000,
    backoffMaxMs: 9_000,
    fetch: (async () => new Response('', { status: 422 })) as typeof fetch,
  }))
  relay.enqueue(usageEvent('req-unprocessable'))

  assert.deepEqual(await relay.flush(), { sent: 0, pending: 1, errorCode: 'http_422' })
  const pending = database.prepare(`
    SELECT last_error_code errorCode, attempts, next_attempt_at nextAttemptAt
    FROM data_plane_outbox WHERE request_id = ?
  `).get('req-unprocessable') as { errorCode: string; attempts: number; nextAttemptAt: number }
  assert.deepEqual({ ...pending }, { errorCode: 'http_422', attempts: 1, nextAttemptAt: 13_000 })
  assert.deepEqual(relay.status(), {
    enabled: true,
    pending: 1,
    deadLetters: 0,
    oldestPendingAgeMs: 0,
    lastErrorCode: 'http_422',
    lastAttemptAt: 4_000,
    lastSuccessAt: null,
    effectiveBatchSize: 100,
  })
  database.close()
})

test('classifies deterministic and retryable HTTP failures without losing retryable rows', async (t) => {
  for (const status of [400, 404, 405, 415, 422]) {
    await t.test(`HTTP ${status} is retained`, async () => {
      const database = new DatabaseSync(':memory:')
      const relay = new DataPlaneRelay(database, options({
        fetch: (async () => new Response('', { status })) as typeof fetch,
      }))
      relay.enqueue(usageEvent(`req-http-${status}`))
      assert.deepEqual(await relay.flush(), { sent: 0, pending: 1, errorCode: `http_${status}` })
      assert.equal(relay.quarantined(), 0)
      database.close()
    })
  }
  for (const status of [408, 429, 500]) {
    await t.test(`HTTP ${status} is retried`, async () => {
      const database = new DatabaseSync(':memory:')
      const relay = new DataPlaneRelay(database, options({
        fetch: (async () => new Response('', { status })) as typeof fetch,
      }))
      relay.enqueue(usageEvent(`req-http-${status}`))
      assert.deepEqual(await relay.flush(), { sent: 0, pending: 1, errorCode: `http_${status}` })
      assert.equal(relay.quarantined(), 0)
      database.close()
    })
  }
  await t.test('network errors are retried', async () => {
    const database = new DatabaseSync(':memory:')
    const relay = new DataPlaneRelay(database, options({
      fetch: (async () => { throw new TypeError('connection detail') }) as typeof fetch,
    }))
    relay.enqueue(usageEvent('req-network'))
    assert.deepEqual(await relay.flush(), { sent: 0, pending: 1, errorCode: 'network' })
    assert.equal(relay.quarantined(), 0)
    database.close()
  })
})

test('narrows a conflicting batch and delivers every non-conflicting row', async () => {
  const database = new DatabaseSync(':memory:')
  let now = 50_000
  const delivered: string[] = []
  const relay = new DataPlaneRelay(database, options({
    now: () => now,
    batchSize: 4,
    backoffBaseMs: 100,
    fetch: (async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { events: DataPlaneUsageEvent[] }
      if (body.events.some((event) => event.requestId === 'a-poison')) return new Response('', { status: 409 })
      delivered.push(...body.events.map((event) => event.requestId))
      return acknowledgement(init)
    }) as typeof fetch,
  }))
  for (const id of ['a-poison', 'b-valid', 'c-valid', 'd-valid']) relay.enqueue(usageEvent(id))

  assert.equal((await relay.flush()).errorCode, 'http_409')
  assert.equal(relay.status().effectiveBatchSize, 2)
  now += 101
  assert.equal((await relay.flush()).errorCode, 'http_409')
  assert.equal(relay.status().effectiveBatchSize, 1)
  now += 201
  assert.equal((await relay.flush()).errorCode, 'http_409')
  assert.equal(relay.quarantined(), 1)
  assert.equal((await relay.flush()).sent, 1)
  assert.equal(relay.status().effectiveBatchSize, 2)
  assert.equal((await relay.flush()).sent, 2)
  assert.equal(relay.status().effectiveBatchSize, 4)
  assert.deepEqual(delivered, ['b-valid', 'c-valid', 'd-valid'])
  assert.equal(relay.pending(), 0)
  database.close()
})

test('retains authentication failures and applies the maximum retry delay', async (t) => {
  for (const status of [401, 403]) {
    await t.test(`HTTP ${status}`, async () => {
      const database = new DatabaseSync(':memory:')
      let now = 10_000
      const relay = new DataPlaneRelay(database, options({
        now: () => now,
        backoffBaseMs: 500,
        backoffMaxMs: 9_000,
        fetch: (async () => new Response('', { status })) as typeof fetch,
      }))
      relay.enqueue(usageEvent(`req-auth-${status}`))

      assert.deepEqual(await relay.flush(), { sent: 0, pending: 1, errorCode: `http_${status}` })
      const row = database.prepare(`
        SELECT attempts, next_attempt_at nextAttemptAt FROM data_plane_outbox WHERE request_id = ?
      `).get(`req-auth-${status}`) as { attempts: number; nextAttemptAt: number }
      assert.equal(row.attempts, 1)
      assert.equal(row.nextAttemptAt, 19_000)
      now += 250
      assert.equal(relay.status().oldestPendingAgeMs, 250)
      assert.equal(relay.quarantined(), 0)
      database.close()
    })
  }
})

test('retains a single-event 413 with maximum backoff instead of dropping it', async () => {
  const database = new DatabaseSync(':memory:')
  const relay = new DataPlaneRelay(database, options({
    now: () => 30_000,
    batchSize: 1,
    backoffMaxMs: 7_000,
    fetch: (async () => new Response('', { status: 413 })) as typeof fetch,
  }))
  relay.enqueue(usageEvent('req-single-too-large'))

  assert.deepEqual(await relay.flush(), { sent: 0, pending: 1, errorCode: 'http_413' })
  const row = database.prepare(`
    SELECT next_attempt_at nextAttemptAt FROM data_plane_outbox WHERE request_id = ?
  `).get('req-single-too-large') as { nextAttemptAt: number }
  assert.equal(row.nextAttemptAt, 37_000)
  assert.equal(relay.quarantined(), 0)
  database.close()
})

test('shrinks a 413 batch and later delivers smaller batches without dropping rows', async () => {
  const database = new DatabaseSync(':memory:')
  let now = 20_000
  const batchLengths: number[] = []
  const relay = new DataPlaneRelay(database, options({
    now: () => now,
    batchSize: 4,
    backoffBaseMs: 100,
    fetch: (async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { events: DataPlaneUsageEvent[] }
      batchLengths.push(body.events.length)
      return batchLengths.length === 1
        ? new Response('', { status: 413 })
        : acknowledgement(init)
    }) as typeof fetch,
  }))
  for (let index = 0; index < 4; index += 1) relay.enqueue(usageEvent(`req-large-${index}`))

  assert.deepEqual(await relay.flush(), { sent: 0, pending: 4, errorCode: 'http_413' })
  assert.equal(relay.status().effectiveBatchSize, 2)
  now += 101
  assert.deepEqual(await relay.flush(), { sent: 2, pending: 2, errorCode: null })
  assert.deepEqual(batchLengths, [4, 2])
  assert.equal(relay.quarantined(), 0)
  database.close()
})

test('recovers cautiously after a 413 once reduced full batches keep succeeding', async () => {
  const database = new DatabaseSync(':memory:')
  let now = 70_000
  let first = true
  const relay = new DataPlaneRelay(database, options({
    now: () => now,
    batchSize: 4,
    backoffBaseMs: 100,
    fetch: (async (_url, init) => {
      if (first) {
        first = false
        return new Response('', { status: 413 })
      }
      return acknowledgement(init)
    }) as typeof fetch,
  }))
  for (let index = 0; index < 20; index += 1) relay.enqueue(usageEvent(`payload-${String(index).padStart(2, '0')}`))

  assert.equal((await relay.flush()).errorCode, 'http_413')
  assert.equal(relay.status().effectiveBatchSize, 2)
  now += 101
  for (let index = 0; index < 8; index += 1) assert.equal((await relay.flush()).sent, 2)
  assert.equal(relay.status().effectiveBatchSize, 3)
  const persisted = database.prepare(`
    SELECT effective_batch_size effectiveBatchSize FROM data_plane_relay_state WHERE id = 1
  `).get() as { effectiveBatchSize: number }
  assert.equal(persisted.effectiveBatchSize, 3)
  database.close()
})

test('resumes a persisted reduced batch cautiously after restart', async () => {
  const database = new DatabaseSync(':memory:')
  let now = 80_000
  const firstRelay = new DataPlaneRelay(database, options({
    now: () => now,
    batchSize: 4,
    backoffBaseMs: 100,
    fetch: (async () => new Response('', { status: 413 })) as typeof fetch,
  }))
  for (let index = 0; index < 20; index += 1) firstRelay.enqueue(usageEvent(`restart-${String(index).padStart(2, '0')}`))
  assert.equal((await firstRelay.flush()).errorCode, 'http_413')
  assert.equal(firstRelay.status().effectiveBatchSize, 2)

  now += 101
  const restartedRelay = new DataPlaneRelay(database, options({
    now: () => now,
    batchSize: 4,
    fetch: (async (_url, init) => acknowledgement(init)) as typeof fetch,
  }))
  assert.equal((await restartedRelay.flush()).sent, 2)
  assert.equal(restartedRelay.status().effectiveBatchSize, 2)
  for (let index = 1; index < 8; index += 1) assert.equal((await restartedRelay.flush()).sent, 2)
  assert.equal(restartedRelay.status().effectiveBatchSize, 3)
  database.close()
})

test('a failed reduced batch resets the consecutive recovery streak', async () => {
  const database = new DatabaseSync(':memory:')
  let now = 90_000
  let initial = true
  let reducedAttempts = 0
  const relay = new DataPlaneRelay(database, options({
    now: () => now,
    batchSize: 4,
    backoffBaseMs: 100,
    fetch: (async (_url, init) => {
      if (initial) {
        initial = false
        return new Response('', { status: 413 })
      }
      reducedAttempts += 1
      return reducedAttempts === 5 ? new Response('', { status: 500 }) : acknowledgement(init)
    }) as typeof fetch,
  }))
  for (let index = 0; index < 32; index += 1) relay.enqueue(usageEvent(`streak-${String(index).padStart(2, '0')}`))

  assert.equal((await relay.flush()).errorCode, 'http_413')
  now += 101
  for (let index = 0; index < 4; index += 1) assert.equal((await relay.flush()).sent, 2)
  assert.equal((await relay.flush()).errorCode, 'http_500')
  now += 101
  for (let index = 0; index < 7; index += 1) assert.equal((await relay.flush()).sent, 2)
  assert.equal(relay.status().effectiveBatchSize, 2)
  assert.equal((await relay.flush()).sent, 2)
  assert.equal(relay.status().effectiveBatchSize, 3)
  database.close()
})

test('rejects relay batches larger than the shared contract maximum', () => {
  const database = new DatabaseSync(':memory:')
  assert.throws(() => new DataPlaneRelay(database, options({ batchSize: 501 })), /between 1 and 500/)
  database.close()
})

test('snapshot client accepts only the complete shared envelope', async () => {
  const database = new DatabaseSync(':memory:')
  const generatedAt = '2026-08-31T00:00:00.000Z'
  const store = new SnapshotStore(database, parseUsageSnapshot, {
    now: () => Date.parse(generatedAt),
  })
  let valid = true
  let requestedUrl = ''
  let authorization = ''
  const client = new DataPlaneSnapshotClient(store, {
    enabled: true,
    baseUrl: 'http://100.64.0.8:8788',
    token: 'snapshot-secret',
    timeoutMs: 100,
    fetch: (async (url, init) => {
      requestedUrl = String(url)
      authorization = String(new Headers(init?.headers).get('authorization') || '')
      return Response.json(valid
        ? { data: usageSnapshot(generatedAt), generatedAt }
        : { data: { ...usageSnapshot(generatedAt), summary: { ...emptySummary, requests: '0' } }, generatedAt })
    }) as typeof fetch,
  })

  const loaded = await client.read('usage:7:all', '/internal/v1/snapshots/7', 60_000)
  assert.equal(loaded?.stale, false)
  assert.equal(loaded?.value.version, 1)
  assert.equal(requestedUrl, 'http://100.64.0.8:8788/internal/v1/snapshots/7')
  assert.equal(authorization, 'Bearer snapshot-secret')

  valid = false
  store.clearMemory()
  database.prepare('DELETE FROM data_plane_snapshots').run()
  assert.equal(await client.read('usage:7:invalid', '/internal/v1/snapshots/7', 60_000), null)
  database.close()
})

test('data-plane status route remains behind the existing administrator middleware', () => {
  const source = fs.readFileSync(new URL('./index.ts', import.meta.url), 'utf8')
  // task-58：鉴权从「`/api` 前缀中间件」改成**全局默认拒绝守卫**（`createSessionGuard`），
  // 断言的**意图不变**——这条路由仍然注册在鉴权之后、且不是公开白名单的一员。
  const guard = source.indexOf('app.use(createSessionGuard(app))')
  const status = source.indexOf("app.get('/api/data-plane/status'")
  const notFound = source.indexOf("app.use('/api', (_req, res) => res.status(404)")
  assert.ok(guard >= 0, '必须存在全局会话守卫')
  assert.ok(status > guard, 'data-plane status 必须注册在守卫之后（默认拒绝）')
  assert.ok(notFound > status)
})

test('builds a stable canonical fallback id and deduplicates replayed missing-id events', () => {
  const first = stableUsageRequestId({ model: 'gpt-5.6-sol', timestamp: '2026-08-31T00:00:00Z', tokens: 10 })
  const replay = stableUsageRequestId({ tokens: 10, timestamp: '2026-08-31T00:00:00Z', model: 'gpt-5.6-sol' })
  const changed = stableUsageRequestId({ model: 'gpt-5.6-sol', timestamp: '2026-08-31T00:00:00Z', tokens: 11 })
  assert.equal(first, replay)
  assert.notEqual(first, changed)
  assert.match(first, /^fallback-[a-f0-9]{64}$/)

  const database = new DatabaseSync(':memory:')
  const relay = new DataPlaneRelay(database, options())
  assert.equal(relay.enqueue(usageEvent(first)), true)
  assert.equal(relay.enqueue(usageEvent(replay)), false)
  assert.equal(relay.pending(), 1)
  database.close()
})

test('allocates distinct legacy ids transactionally for identical CPA records', () => {
  const database = new DatabaseSync(':memory:')
  new DataPlaneRelay(database, options({ enabled: false }))
  const identity = { model: 'gpt-5.6-sol', timestamp: null, tokens: 10 }
  database.exec('BEGIN IMMEDIATE')
  const first = nextLegacyUsageRequestId(database, identity)
  const second = nextLegacyUsageRequestId(database, identity)
  database.exec('COMMIT')
  assert.notEqual(first, second)

  database.exec('BEGIN IMMEDIATE')
  const rolledBack = nextLegacyUsageRequestId(database, identity)
  database.exec('ROLLBACK')
  assert.equal(nextLegacyUsageRequestId(database, identity), rolledBack)
  database.close()
})

test('batch identity is unambiguous when request ids contain newlines', async () => {
  const batchIds: string[] = []
  const capture = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { batchId: string }
    batchIds.push(body.batchId)
    return acknowledgement(init)
  }) as typeof fetch
  for (const ids of [['a\nb', 'c'], ['a', 'b\nc']]) {
    const database = new DatabaseSync(':memory:')
    const relay = new DataPlaneRelay(database, options({ fetch: capture }))
    ids.forEach((id) => relay.enqueue(usageEvent(id)))
    await relay.flush()
    database.close()
  }
  assert.notEqual(batchIds[0], batchIds[1])
})
