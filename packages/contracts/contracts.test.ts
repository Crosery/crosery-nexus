import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ContractValidationError,
  MAX_INGEST_BATCH_SIZE,
  parseIngestUsageRequest,
  parseIngestUsageResponse,
  parseSnapshotEnvelope,
  parseSnapshotPeriod,
  parseUsageQuery,
  parseUsageSnapshot,
  type UsageSnapshot,
} from './index.js'

const validEvent = {
  requestId: 'req-1',
  timestamp: '2026-08-31T10:00:00+08:00',
  timestampMs: Date.parse('2026-08-31T10:00:00+08:00'),
  keyHash: 'a'.repeat(64),
  provider: 'codex',
  model: 'gpt-5.6-sol',
  modelGroup: 'codex',
  endpoint: '/v1/responses',
  source: 'responses',
  authIndex: 'account-1',
  success: true,
  statusCode: 200,
  latencyMs: 42,
  ttftMs: 12,
  inputTokens: 100,
  outputTokens: 20,
  reasoningTokens: 5,
  cachedTokens: 40,
  cacheWriteTokens: 0,
  totalTokens: 125,
  clientType: 'codex',
  errorCategory: '',
}

test('parseIngestUsageRequest normalizes timestamps and defaults optional strings', () => {
  const parsed = parseIngestUsageRequest({ batchId: 'batch-1', events: [{ ...validEvent, source: undefined }] })
  assert.equal(parsed.events[0].timestamp, '2026-08-31T02:00:00.000Z')
  assert.equal(parsed.events[0].source, '')
})

test('parseIngestUsageRequest rejects unsafe batch and field sizes', () => {
  assert.equal(MAX_INGEST_BATCH_SIZE, 500)
  assert.throws(() => parseIngestUsageRequest({ batchId: 'batch-1', events: [] }), ContractValidationError)
  assert.throws(() => parseIngestUsageRequest({ batchId: 'batch-1', events: Array.from({ length: 501 }, () => validEvent) }), /between 1 and 500/)
  assert.throws(() => parseIngestUsageRequest({ batchId: 'batch-1', events: [{ ...validEvent, requestId: 'x'.repeat(201) }] }), /requestId/)
  assert.throws(() => parseIngestUsageRequest({ batchId: 'batch-1', events: [{ ...validEvent, statusCode: 99 }] }), /statusCode/)
  assert.throws(() => parseIngestUsageRequest({ batchId: 'batch-1', events: [{ ...validEvent, keyHash: 'A'.repeat(64) }] }), /keyHash/)
  assert.throws(() => parseIngestUsageRequest({ batchId: 'batch-1', events: [{ ...validEvent, keyHash: 'a'.repeat(63) }] }), /keyHash/)
  assert.throws(() => parseIngestUsageRequest({ batchId: 'batch-1', events: [{ ...validEvent, clientType: 'x'.repeat(129) }] }), /clientType/)
  assert.throws(() => parseIngestUsageRequest({ batchId: 'batch-1', events: [{ ...validEvent, latencyMs: 86_400_001 }] }), /latencyMs/)
  assert.throws(() => parseIngestUsageRequest({ batchId: 'batch-1', events: [{ ...validEvent, totalTokens: 1_000_000_000_001 }] }), /totalTokens/)
  assert.throws(() => parseIngestUsageRequest({ batchId: 'batch-1', events: [{ ...validEvent, timestamp: '1999-12-31T23:59:59.999Z', timestampMs: Date.parse('1999-12-31T23:59:59.999Z') }] }), /timestamp/)
  assert.throws(() => parseIngestUsageRequest({ batchId: 'batch-1', events: [{ ...validEvent, timestampMs: validEvent.timestampMs + 1 }] }), /must match/)
  assert.throws(() => parseIngestUsageRequest({ batchId: 'batch-1', events: [validEvent, validEvent] }), /duplicate requestId/)
})

test('period and query parsing only accepts bounded values', () => {
  assert.equal(parseSnapshotPeriod('30'), 30)
  assert.throws(() => parseSnapshotPeriod('14'), /days/)
  assert.deepEqual(parseUsageQuery(new URLSearchParams('days=7&limit=50&keyHash=abc')), { days: 7, limit: 50, keyHash: 'abc' })
  assert.throws(() => parseUsageQuery(new URLSearchParams('limit=201')), /limit/)
})

test('ingest response parser enforces batch identity and count conservation', () => {
  const valid = { batchId: 'batch-1', accepted: 2, received: 2, inserted: 1, duplicates: 1, sourceWatermark: '2026-08-31T00:00:00Z' }
  assert.deepEqual(parseIngestUsageResponse(valid, 'batch-1', 2), { ...valid, sourceWatermark: '2026-08-31T00:00:00.000Z' })
  assert.throws(() => parseIngestUsageResponse({ ...valid, batchId: 'batch-2' }, 'batch-1', 2), /batchId/)
  assert.throws(() => parseIngestUsageResponse({ ...valid, accepted: 1 }, 'batch-1', 2), /complete batch/)
  assert.throws(() => parseIngestUsageResponse({ ...valid, inserted: 2 }, 'batch-1', 2), /balance/)
  assert.throws(() => parseIngestUsageResponse({ ...valid, duplicates: -1 }, 'batch-1', 2), /duplicates/)
  assert.throws(() => parseIngestUsageResponse({ ...valid, sourceWatermark: 'not-a-date' }, 'batch-1', 2), /sourceWatermark/)
})

const summary = { requests: 2, errors: 1, totalTokens: 120, inputTokens: 100, outputTokens: 20, cachedTokens: 40, cacheWriteTokens: 0, reasoningTokens: 5, averageLatencyMs: 25.5, averageTtftMs: 10 }
const snapshot: UsageSnapshot = {
  version: 1,
  days: 7,
  generatedAt: '2026-08-31T00:00:00.000Z',
  sourceWatermark: '2026-08-30T23:59:59.000Z',
  summary,
  trend: [{ bucket: '2026-08-30T23:00:00.000Z', ...summary }],
  providers: [{ name: 'codex', ...summary }],
  models: [{ name: 'gpt-5.6-sol', ...summary }],
  keys: [{ name: 'key-1', ...summary }],
  clients: [{ name: 'codex', ...summary }],
}

test('snapshot parsers reject version drift, non-finite metrics, and mismatched envelopes', () => {
  assert.deepEqual(parseUsageSnapshot(snapshot), snapshot)
  assert.deepEqual(parseSnapshotEnvelope({ data: snapshot, generatedAt: snapshot.generatedAt }), { data: snapshot, generatedAt: snapshot.generatedAt })
  assert.throws(() => parseUsageSnapshot({ ...snapshot, version: 2 }), /version/)
  assert.throws(() => parseUsageSnapshot({ ...snapshot, days: 14 }), /days/)
  assert.throws(() => parseUsageSnapshot({ ...snapshot, summary: { ...summary, averageLatencyMs: Number.NaN } }), /averageLatencyMs/)
  assert.throws(() => parseUsageSnapshot({ ...snapshot, summary: { ...summary, errors: 3 } }), /cannot exceed/)
  assert.throws(() => parseUsageSnapshot({ ...snapshot, providers: [{ name: 'codex', ...summary, totalTokens: -1 }] }), /providers\[0\]\.totalTokens/)
  assert.throws(() => parseUsageSnapshot({ ...snapshot, trend: [{ bucket: snapshot.generatedAt, ...summary, averageTtftMs: Number.POSITIVE_INFINITY }] }), /trend\[0\]\.averageTtftMs/)
  assert.throws(() => parseSnapshotEnvelope({ data: snapshot, generatedAt: '2026-08-31T00:00:01.000Z' }), /must match/)
})
