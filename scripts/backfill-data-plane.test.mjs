import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'

import {
  buildBatch,
  loadBearerToken,
  readCheckpoint,
  rowToUsageEvent,
  runBackfill,
} from './backfill-data-plane.mjs'

const TOKEN = 'backfill-test-token-that-is-long-enough'

function createFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cpe-backfill-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const sqlitePath = path.join(directory, 'console.backup.db')
  const checkpointPath = path.join(directory, 'backfill.checkpoint.json')
  const database = new DatabaseSync(sqlitePath)
  database.exec(`
    CREATE TABLE usage_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id TEXT UNIQUE,
      timestamp TEXT NOT NULL,
      key_hash TEXT,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      model_group TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      success INTEGER NOT NULL,
      status_code INTEGER NOT NULL,
      latency_ms INTEGER NOT NULL,
      ttft_ms INTEGER NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      reasoning_tokens INTEGER NOT NULL,
      cached_tokens INTEGER NOT NULL,
      cache_write_tokens INTEGER NOT NULL,
      total_tokens INTEGER NOT NULL,
      source TEXT NOT NULL,
      auth_index TEXT NOT NULL,
      client_type TEXT NOT NULL,
      error_category TEXT NOT NULL
    );
    CREATE TABLE quota_usage_events (
      request_id TEXT PRIMARY KEY,
      key_hash TEXT NOT NULL
    );
  `)
  return { directory, sqlitePath, checkpointPath, database }
}

function insertEvent(database, id, overrides = {}) {
  const event = {
    requestId: `request-${id}`,
    timestamp: `2026-08-31T00:00:0${Math.min(id, 9)}.000Z`,
    keyHash: 'a'.repeat(64),
    provider: 'codex',
    model: 'gpt-5.6-sol',
    modelGroup: 'codex',
    endpoint: '/v1/responses',
    success: 1,
    statusCode: 200,
    latencyMs: 25,
    ttftMs: 10,
    inputTokens: 100,
    outputTokens: 20,
    reasoningTokens: 5,
    cachedTokens: 40,
    cacheWriteTokens: 0,
    totalTokens: 125,
    source: 'oauth',
    authIndex: 'account-1',
    clientType: 'codex',
    errorCategory: '',
    ...overrides,
  }
  database.prepare(`
    INSERT INTO usage_events (
      id, request_id, timestamp, key_hash, provider, model, model_group, endpoint,
      success, status_code, latency_ms, ttft_ms, input_tokens, output_tokens,
      reasoning_tokens, cached_tokens, cache_write_tokens, total_tokens, source,
      auth_index, client_type, error_category
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, event.requestId, event.timestamp, event.keyHash, event.provider, event.model,
    event.modelGroup, event.endpoint, event.success, event.statusCode, event.latencyMs,
    event.ttftMs, event.inputTokens, event.outputTokens, event.reasoningTokens,
    event.cachedTokens, event.cacheWriteTokens, event.totalTokens, event.source,
    event.authIndex, event.clientType, event.errorCategory,
  )
  if (event.quotaKeyHash && event.requestId) {
    database.prepare('INSERT INTO quota_usage_events (request_id, key_hash) VALUES (?, ?)')
      .run(event.requestId, event.quotaKeyHash)
  }
}

function fileSha256(filename) {
  return createHash('sha256').update(fs.readFileSync(filename)).digest('hex')
}

function backfillOptions(fixture, overrides = {}) {
  return {
    sqlitePath: fixture.sqlitePath,
    checkpointPath: fixture.checkpointPath,
    sourceId: 'backup-2026-08-31T00-00-00Z',
    baseUrl: 'http://100.64.0.8:8792',
    token: TOKEN,
    batchRows: 2,
    batchBytes: 64 * 1024,
    timeoutMs: 1_000,
    maxRetries: 1,
    retryBaseMs: 10,
    retryMaxMs: 20,
    sleep: async () => undefined,
    logger: () => undefined,
    ...overrides,
  }
}

function acknowledgement(body, inserted, duplicates) {
  return Response.json({
    batchId: body.batchId,
    accepted: body.events.length,
    received: body.events.length,
    inserted,
    duplicates,
    sourceWatermark: body.events.at(-1)?.timestamp ?? null,
  })
}

test('backfills an immutable SQLite snapshot in id order and safely replays an ambiguous batch', async (t) => {
  const fixture = createFixture(t)
  insertEvent(fixture.database, 1)
  insertEvent(fixture.database, 3, { requestId: null, keyHash: null })
  insertEvent(fixture.database, 5)
  fixture.database.close()
  const before = fileSha256(fixture.sqlitePath)

  const target = new Map()
  const requests = []
  const logs = []
  let calls = 0
  const fetchImpl = async (url, init) => {
    calls += 1
    const body = JSON.parse(Buffer.from(init.body).toString('utf8'))
    const headers = new Headers(init.headers)
    requests.push({ url, body, headers })
    assert.equal(headers.get('authorization'), `Bearer ${TOKEN}`)
    assert.equal(headers.get('x-idempotency-key'), body.batchId)
    assert.equal(headers.get('content-type'), 'application/json')
    assert.equal(init.redirect, 'error')
    assert.ok(Buffer.byteLength(JSON.stringify(body)) <= 64 * 1024)

    let inserted = 0
    let duplicates = 0
    for (const event of body.events) {
      const serialized = JSON.stringify(event)
      if (target.has(event.requestId)) {
        assert.equal(target.get(event.requestId), serialized)
        duplicates += 1
      } else {
        target.set(event.requestId, serialized)
        inserted += 1
      }
    }
    if (calls === 1) {
      assert.equal(readCheckpoint(fixture.checkpointPath).cursor.lastId, 0)
      throw new Error('response was lost after the receiver committed')
    }
    return acknowledgement(body, inserted, duplicates)
  }

  const result = await runBackfill(backfillOptions(fixture, {
    fetchImpl,
    logger: (entry) => logs.push(entry),
  }))

  assert.equal(calls, 3)
  assert.deepEqual(requests.map((request) => request.url), [
    'http://100.64.0.8:8792/internal/v1/usage/batches',
    'http://100.64.0.8:8792/internal/v1/usage/batches',
    'http://100.64.0.8:8792/internal/v1/usage/batches',
  ])
  assert.equal(requests[0].body.batchId, requests[1].body.batchId)
  assert.deepEqual(requests[0].body.events.map((event) => event.requestId), [
    'request-1',
    rowToUsageEvent({
      id: 3, request_id: null, timestamp: '2026-08-31T00:00:03.000Z', key_hash: 'a'.repeat(64),
      provider: 'codex', model: 'gpt-5.6-sol', model_group: 'codex', endpoint: '/v1/responses',
      success: 1, status_code: 200, latency_ms: 25, ttft_ms: 10, input_tokens: 100,
      output_tokens: 20, reasoning_tokens: 5, cached_tokens: 40, cache_write_tokens: 0,
      total_tokens: 125, source: 'oauth', auth_index: 'account-1', client_type: 'codex', error_category: '',
    }, 'backup-2026-08-31T00-00-00Z').requestId,
  ])
  assert.equal(target.size, 3)
  assert.deepEqual(result.totals, { acknowledged: 3, inserted: 1, duplicates: 2, batches: 2 })
  assert.equal(result.cursor.lastId, 5)
  assert.equal(result.source.maxId, 5)
  assert.equal(result.source.rowCount, 3)
  assert.equal(result.status, 'complete')
  assert.equal(fileSha256(fixture.sqlitePath), before)
  assert.equal(fs.statSync(fixture.checkpointPath).mode & 0o777, 0o600)
  assert.equal(fs.readdirSync(fixture.directory).some((name) => name.endsWith('.tmp')), false)
  assert.equal(JSON.stringify(logs).includes(TOKEN), false)

  let replayed = false
  const resumed = await runBackfill(backfillOptions(fixture, {
    fetchImpl: async () => { replayed = true; throw new Error('must not fetch a completed checkpoint') },
  }))
  assert.equal(replayed, false)
  assert.deepEqual(resumed, result)
})

test('does not advance the atomic checkpoint until a complete v1 acknowledgement arrives', async (t) => {
  const fixture = createFixture(t)
  insertEvent(fixture.database, 1)
  insertEvent(fixture.database, 2)
  fixture.database.close()
  const delays = []

  await assert.rejects(
    runBackfill(backfillOptions(fixture, {
      fetchImpl: async () => new Response('', { status: 503 }),
      sleep: async (delay) => delays.push(delay),
    })),
    /HTTP 503/,
  )
  assert.deepEqual(delays, [10])
  assert.deepEqual(readCheckpoint(fixture.checkpointPath).cursor, { lastId: 0 })

  await assert.rejects(
    runBackfill(backfillOptions(fixture, {
      maxRetries: 0,
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(Buffer.from(init.body).toString('utf8'))
        return new Response(JSON.stringify({
          batchId: body.batchId,
          accepted: body.events.length,
          received: body.events.length,
          inserted: body.events.length,
          duplicates: 0,
          sourceWatermark: body.events.at(-1).timestamp,
        }), { headers: { 'content-type': 'text/plain' } })
      },
    })),
    /must be application\/json/,
  )
  assert.deepEqual(readCheckpoint(fixture.checkpointPath).cursor, { lastId: 0 })

  await assert.rejects(
    runBackfill(backfillOptions(fixture, {
      maxRetries: 0,
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(Buffer.from(init.body).toString('utf8'))
        return acknowledgement(body, body.events.length - 1, 0)
      },
    })),
    /acknowledgement violates the v1 contract/,
  )
  assert.deepEqual(readCheckpoint(fixture.checkpointPath).cursor, { lastId: 0 })

  const completed = await runBackfill(backfillOptions(fixture, {
    maxRetries: 0,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(Buffer.from(init.body).toString('utf8'))
      return acknowledgement(body, body.events.length, 0)
    },
  }))
  assert.equal(completed.status, 'complete')
  assert.deepEqual(completed.totals, { acknowledged: 2, inserted: 2, duplicates: 0, batches: 1 })
})

test('binds a checkpoint to one source identity and fixed maximum id', async (t) => {
  const fixture = createFixture(t)
  insertEvent(fixture.database, 1)
  fixture.database.close()

  await assert.rejects(
    runBackfill(backfillOptions(fixture, {
      maxRetries: 0,
      fetchImpl: async () => new Response('', { status: 503 }),
    })),
    /HTTP 503/,
  )

  await assert.rejects(
    runBackfill(backfillOptions(fixture, { sourceId: 'different-backup-id' })),
    /source identity does not match/,
  )

  const writable = new DatabaseSync(fixture.sqlitePath)
  insertEvent(writable, 2)
  writable.close()
  await assert.rejects(
    runBackfill(backfillOptions(fixture)),
    /source maximum id changed/,
  )
})

test('enforces row and byte bounds before sending and uses stable fallback identities', () => {
  const row = {
    id: 9, request_id: '', timestamp: '2026-08-31T00:00:09.000Z', key_hash: null,
    provider: 'codex', model: 'gpt-5.6-sol', model_group: 'codex', endpoint: '',
    success: 1, status_code: 200, latency_ms: 1, ttft_ms: 0, input_tokens: 1,
    output_tokens: 1, reasoning_tokens: 0, cached_tokens: 0, cache_write_tokens: 0,
    total_tokens: 2, source: '', auth_index: '', client_type: '', error_category: '',
  }
  const first = rowToUsageEvent(row, 'fixed-source')
  const second = rowToUsageEvent(row, 'fixed-source')
  assert.equal(first.requestId, second.requestId)
  assert.match(first.requestId, /^sqlite-[a-f0-9]{64}$/)

  assert.throws(() => buildBatch([row], 'fixed-source', 128), /byte limit/)
  const batch = buildBatch([row, { ...row, id: 10 }], 'fixed-source', 700)
  assert.equal(batch.events.length, 1)
  assert.ok(batch.body.length <= 700)
})

test('reconstructs the live outbox key hash from the durable quota row when SQLite reconciliation lagged', async (t) => {
  const fixture = createFixture(t)
  insertEvent(fixture.database, 1, { keyHash: null, quotaKeyHash: 'b'.repeat(64) })
  fixture.database.close()
  let received
  await runBackfill(backfillOptions(fixture, {
    maxRetries: 0,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(Buffer.from(init.body).toString('utf8'))
      received = body.events[0]
      return acknowledgement(body, 1, 0)
    },
  }))
  assert.equal(received.keyHash, 'b'.repeat(64))
})

test('loads a Bearer token from either environment or a private file without accepting ambiguity', (t) => {
  assert.equal(loadBearerToken({ DATA_PLANE_TOKEN: TOKEN }), TOKEN)
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cpe-token-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const filename = path.join(directory, 'token')
  fs.writeFileSync(filename, `${TOKEN}\n`, { mode: 0o600 })
  assert.equal(loadBearerToken({ DATA_PLANE_TOKEN_FILE: filename }), TOKEN)
  assert.throws(
    () => loadBearerToken({ DATA_PLANE_TOKEN: TOKEN, DATA_PLANE_TOKEN_FILE: filename }),
    /cannot both be set/,
  )
  fs.chmodSync(filename, 0o644)
  assert.throws(() => loadBearerToken({ DATA_PLANE_TOKEN_FILE: filename }), /private regular file/)
})

test('runs the CLI when invoked through the production current-release symlink', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cpe-backfill-link-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const link = path.join(directory, 'backfill-data-plane.mjs')
  fs.symlinkSync(new URL('./backfill-data-plane.mjs', import.meta.url), link)
  const result = spawnSync(process.execPath, [link, '--help'], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /^Usage:/)
})
