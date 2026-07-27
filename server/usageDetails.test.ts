import assert from 'node:assert/strict'
import test from 'node:test'
import { extractUsageDiagnostics } from './usageDetails.js'

test('extracts error body and upstream request id from a usage record', () => {
  const result = extractUsageDiagnostics({
    fail: { status_code: 429, body: 'upstream saturated' },
    response_headers: { 'CF-Ray': ['abc-HKG'] },
    source: 'config:qijichuangtan',
    auth_index: '42',
    reasoning_effort: 'high',
    service_tier: 'standard',
  })
  assert.equal(result.errorDetail, 'upstream saturated')
  assert.equal(result.upstreamRequestId, 'abc-HKG')
  assert.equal(result.source, 'config:qijichuangtan')
  assert.equal(result.authIndex, '42')
  assert.equal(result.reasoningEffort, 'high')
})

test('prefers an explicit upstream request id over generic request headers', () => {
  const result = extractUsageDiagnostics({
    response_headers: {
      'X-Request-Id': 'generic-id',
      'X-Upstream-Request-Id': 'upstream-id',
    },
  })
  assert.equal(result.upstreamRequestId, 'upstream-id')
})
