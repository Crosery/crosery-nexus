import { classifyClient, resolveClientIp } from './clientAgent.js'
import { cacheDialectFor } from './cacheStats.js'
import type { UsageRecord } from './cpa.js'

export type UsageErrorCategory = 'upstream_eof' | 'client_cancelled' | 'context_too_large' | 'rate_limited' | 'quota_exhausted' | 'auth_failed' | 'wrong_endpoint' | 'upstream_5xx' | 'other'

export function categorizeUsageError(statusCode: number, detail: string): UsageErrorCategory | '' {
  const text = detail.toLowerCase()
  if (!text && statusCode < 400) return ''
  if (text.includes('context_too_large') || text.includes('exceeds the context window')) return 'context_too_large'
  if (text.includes('context canceled') || text.includes('cancelled')) return 'client_cancelled'
  if (text.includes('unexpected eof') || /\beof\b/.test(text) || text.includes('protocol_error') || text.includes('stream disconnected')) return 'upstream_eof'
  if (statusCode === 429 || text.includes('rate limit')) return 'rate_limited'
  if (statusCode === 402 || text.includes('insufficient balance') || text.includes('run out of credits') || text.includes('usage-exhausted') || text.includes('spending-limit')) return 'quota_exhausted'
  if ([401, 403].includes(statusCode) || text.includes('missing api key') || text.includes('token has been revoked') || text.includes('authentication_error')) return 'auth_failed'
  if (text.includes('not available on this endpoint') || text.includes('compatible endpoint')) return 'wrong_endpoint'
  if (statusCode >= 500) return 'upstream_5xx'
  return 'other'
}

export function extractUsageDiagnostics(record: UsageRecord) {
  const responseHeaders = record.response_headers && typeof record.response_headers === 'object' ? record.response_headers : {}
  const upstreamRequestId = ['x-upstream-request-id', 'x-request-id', 'request-id', 'cf-ray']
    .flatMap((name) => Object.entries(responseHeaders).filter(([key]) => key.toLowerCase() === name).flatMap(([, value]) => Array.isArray(value) ? value : [value]))
    .map(String)[0] || ''

  const errorDetail = String(record.fail?.body || '')
  const statusCode = Number(record.fail?.status_code || (record.failed ? 500 : 200))
  const userAgent = String(record.user_agent || '')
  return {
    errorDetail,
    errorCategory: categorizeUsageError(statusCode, errorDetail),
    upstreamRequestId,
    source: String(record.source || ''),
    authIndex: String(record.auth_index || ''),
    reasoningEffort: String(record.reasoning_effort || ''),
    serviceTier: String(record.service_tier || ''),
    responseHeadersJson: JSON.stringify(responseHeaders),
    userAgent,
    clientType: classifyClient(userAgent, { provider: record.provider }),
    clientIp: resolveClientIp(String(record.client_ip || ''), String(record.x_forwarded_for || '')),
  }
}

/**
 * 缓存写入 token 的取值。CPA 在 `cache_creation_tokens` 下发，
 * 但历史上也出现过只给 `total_tokens` 的情况；此时用总量减去已知三段反推。
 * 反推仅在差值为正时生效，避免上游口径不一致时写入负数。
 */
export function resolveCacheReadTokens(record: UsageRecord): number {
  const tokens = record.tokens || {}
  // CPA 新契约用 cache_read_tokens_present 区分「明确为 0」和「字段缺失」。
  // 明确存在时必须信任新字段，即使值为 0，不能回退到旧 cached_tokens 残值。
  if (tokens.cache_read_tokens_present === true) {
    return Math.max(Number(tokens.cache_read_tokens || 0), 0)
  }
  if (typeof tokens.cache_read_tokens === 'number' && Number.isFinite(tokens.cache_read_tokens)) {
    return Math.max(tokens.cache_read_tokens, 0)
  }
  return Math.max(Number(tokens.cached_tokens || 0), 0)
}

export function resolveCacheWriteTokens(record: UsageRecord): number {
  const tokens = record.tokens || {}
  // 只有实际走原生 Anthropic 口径时，cache_creation_tokens 才是独立计费段。
  // DSH / qiji 等兼容渠道即便模型名叫 claude，也把 cached_tokens 包在 input_tokens 内，
  // 对它们做 total-(input+output+cached) 会把协议转换差异误报成缓存写入。
  const dialect = cacheDialectFor(String(record.alias || record.model || ''), { provider: record.provider })
  if (dialect !== 'anthropic') return 0
  if (typeof tokens.cache_creation_tokens === 'number' && Number.isFinite(tokens.cache_creation_tokens)) {
    return Math.max(tokens.cache_creation_tokens, 0)
  }
  const total = Number(tokens.total_tokens || 0)
  if (!total) return 0
  const known = Number(tokens.input_tokens || 0) + Number(tokens.output_tokens || 0) + resolveCacheReadTokens(record)
  const derived = total - known
  return derived > 0 ? derived : 0
}
