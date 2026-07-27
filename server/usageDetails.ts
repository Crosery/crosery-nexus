import type { UsageRecord } from './cpa.js'

export function extractUsageDiagnostics(record: UsageRecord) {
  const responseHeaders = record.response_headers && typeof record.response_headers === 'object' ? record.response_headers : {}
  const upstreamRequestId = ['x-upstream-request-id', 'x-request-id', 'request-id', 'cf-ray']
    .flatMap((name) => Object.entries(responseHeaders).filter(([key]) => key.toLowerCase() === name).flatMap(([, value]) => Array.isArray(value) ? value : [value]))
    .map(String)[0] || ''

  return {
    errorDetail: String(record.fail?.body || ''),
    upstreamRequestId,
    source: String(record.source || ''),
    authIndex: String(record.auth_index || ''),
    reasoningEffort: String(record.reasoning_effort || ''),
    serviceTier: String(record.service_tier || ''),
    responseHeadersJson: JSON.stringify(responseHeaders),
  }
}
