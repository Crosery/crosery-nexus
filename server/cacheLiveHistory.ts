import { scopedProviderPredicate } from './currentChannels.js'
import type { ConsoleGroup } from './groups.js'
import { providerAliases, toLiveEvent, type LiveUsageEvent } from './liveStream.js'
import { canonicalModelSql } from './modelIdentity.js'
import { clientTypeSql } from './clientAgent.js'
import type { ReadOperation } from './sqliteReadWorker.js'

type Reader = {
  run(operations: readonly ReadOperation[]): Promise<unknown[]>
}

type LiveHistoryRow = {
  requestId?: string
  timestamp?: string
  model?: string
  endpoint?: string
  keyName?: string | null
  keyHash?: string | null
  source?: string
  latencyMs?: number
  success?: number | boolean
  statusCode?: number
  ttftMs?: number
  provider?: string
  modelGroup?: string
  inputTokens?: number
  outputTokens?: number
  reasoningTokens?: number
  cachedTokens?: number
  cacheWriteTokens?: number
  totalTokens?: number
  clientType?: string
  userAgent?: string
}

/**
 * Reads the bounded SSE history on a reporting worker. Keeping this query off
 * the Express thread prevents a cold model/client filter from pausing every
 * connected request while SQLite scans the history window.
 */
export async function loadCacheLiveHistory(
  reader: Reader,
  groups: ConsoleGroup[],
  limit: number,
  model: string,
  clientType: string,
  keyId = '',
  provider = '',
  /** 默认回放全部渠道（含已移除渠道的历史），与缓存页签的报表同一口径；true = 只看当前渠道 */
  currentOnly = false,
): Promise<LiveUsageEvent[]> {
  const active = scopedProviderPredicate(groups, 'u.provider', currentOnly)
  const clauses = ['u.success = 1', active.sql]
  const params: Array<string | number> = [...active.params]
  if (model) {
    clauses.push(`${canonicalModelSql('u')} = ?`)
    params.push(model)
  }
  if (keyId) {
    clauses.push('u.key_hash = ?')
    params.push(keyId)
  }
  const aliases = providerAliases(provider)
  if (aliases.length) {
    clauses.push(`lower(trim(u.provider)) IN (${aliases.map(() => '?').join(', ')})`)
    params.push(...aliases)
  }
  if (clientType) {
    // Match the displayed identity, including recovered historical OMP/AGY rows.
    clauses.push(`${clientTypeSql('u')} = ?`)
    params.push(clientType)
  }
  params.push(limit)

  const [rowsValue] = await reader.run([{
    method: 'all',
    sql: `
      SELECT u.request_id requestId, u.timestamp, u.model, u.endpoint, a.name keyName,
        u.key_hash keyHash, u.source, u.latency_ms latencyMs, u.success, u.status_code statusCode,
        u.ttft_ms ttftMs, u.provider, u.model_group modelGroup,
        u.input_tokens inputTokens, u.output_tokens outputTokens,
        u.reasoning_tokens reasoningTokens, u.cached_tokens cachedTokens,
        u.cache_write_tokens cacheWriteTokens, u.total_tokens totalTokens,
        ${clientTypeSql('u')} clientType, u.user_agent userAgent
      FROM usage_events u LEFT JOIN api_keys a ON a.key_hash = u.key_hash
      WHERE ${clauses.join(' AND ')}
      ORDER BY u.timestamp_ms DESC LIMIT ?
    `,
    params,
  }])

  return (rowsValue as LiveHistoryRow[])
    .map((row) => toLiveEvent({
      requestId: String(row.requestId || ''),
      timestamp: String(row.timestamp || ''),
      model: String(row.model || ''),
      modelGroup: String(row.modelGroup || ''),
      endpoint: String(row.endpoint || ''),
      keyName: row.keyName ?? null,
      keyHash: row.keyHash ?? null,
      source: String(row.source || ''),
      provider: String(row.provider || ''),
      statusCode: Number(row.statusCode) || 200,
      ttftMs: Number(row.ttftMs) || 0,
      success: Boolean(row.success),
      latencyMs: Number(row.latencyMs) || 0,
      inputTokens: Number(row.inputTokens) || 0,
      outputTokens: Number(row.outputTokens) || 0,
      cachedTokens: Number(row.cachedTokens) || 0,
      cacheWriteTokens: Number(row.cacheWriteTokens) || 0,
      reasoningTokens: Number(row.reasoningTokens) || 0,
      totalTokens: Number(row.totalTokens) || 0,
      clientType: String(row.clientType || 'legacy-unknown'),
      userAgent: String(row.userAgent || ''),
    }))
    .reverse()
}
