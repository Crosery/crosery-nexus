import { DatabaseSync } from 'node:sqlite'
import { parentPort, workerData } from 'node:worker_threads'

const database = new DatabaseSync(workerData.filename, { readOnly: true })
database.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 5000; PRAGMA cache_size = -65536; PRAGMA mmap_size = 268435456; PRAGMA temp_store = MEMORY;')

const hasRollup = Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='usage_hourly_rollup'").get())
const hasCostUsd = Boolean(database.prepare("SELECT 1 FROM pragma_table_info('usage_events') WHERE name='cost_usd'").get())

function routeToRollup(sql, params) {
  if (hasRollup && sql.includes('INDEXED BY idx_usage_cache_rollup')) {
    const hasKey = sql.includes('AND key_hash = ?')
    return {
      sql: `SELECT (hour_ms / 60000) AS minuteBucket,
        CASE WHEN instr(model,'/')>0 THEN substr(model, instr(model,'/')+1) ELSE model END model, provider,
        client_type clientType,
        first_timestamp_ms firstTimestampMs, SUM(request_count) requests,
        COALESCE(SUM(input_tokens),0) inputTokens,
        COALESCE(SUM(uncached_input_tokens),0) uncachedInputTokens,
        COALESCE(SUM(cached_tokens),0) cacheReadTokens,
        COALESCE(SUM(cache_write_tokens),0) cacheWriteTokens,
        COALESCE(SUM(output_tokens),0) outputTokens,
        CASE WHEN SUM(cost_usd_count) = SUM(request_count) THEN COALESCE(SUM(cost_usd_sum),0) ELSE NULL END costUsd
        FROM usage_hourly_rollup
        WHERE hour_ms >= ? AND success = 1 AND lower(trim(provider)) = ? ${hasKey ? 'AND key_hash = ?' : ''}
        GROUP BY hour_ms, CASE WHEN instr(model,'/')>0 THEN substr(model, instr(model,'/')+1) ELSE model END,
          provider, client_type`,
      params: hasKey ? [params[0], params[2], params[3]] : [params[0], params[2]],
    }
  }
  return { sql, params }
}

function rewriteRollupToEvents(sql) {
  let s = sql
    .replace(/FROM usage_hourly_rollup/g, 'FROM usage_events')
    .replace(/\bhour_ms\b/g, 'timestamp_ms')
    .replace(/\bday_text\b/g, 'substr(timestamp,1,10)')
    .replace(/\bhour_text\b/g, 'substr(timestamp,1,13)')
    .replace(/\brequest_count\b/g, '1')
    .replace(/\buncached_input_tokens\b/g, 'MAX(input_tokens - cached_tokens, 0)')
    .replace(/\blatency_sum_ms\b/g, 'latency_ms')
    .replace(/\bttft_sum_ms\b/g, 'ttft_ms')
    .replace(/\bcost_usd_sum\b/g, hasCostUsd ? 'cost_usd' : '0')
    .replace(/\bcost_usd_count\b/g, hasCostUsd ? '(CASE WHEN cost_usd IS NOT NULL THEN 1 ELSE 0 END)' : '0')
    .replace(/\bfirst_timestamp_ms\b/g, 'timestamp_ms')
  if (!hasCostUsd) {
    s = s.replace(/cost_usd/g, 'NULL')
  }
  return s
}

parentPort.on('message', ({ id, operations }) => {
  try {
    const results = operations.map(({ method, sql, params = [] }) => {
      let finalSql = sql
      let finalParams = params
      if (!hasRollup && finalSql.includes('usage_hourly_rollup')) {
        finalSql = rewriteRollupToEvents(finalSql)
      } else if (hasRollup && finalSql.includes('INDEXED BY idx_usage_cache_rollup')) {
        const routed = routeToRollup(finalSql, finalParams)
        finalSql = routed.sql
        finalParams = routed.params
      } else if (!hasCostUsd && finalSql.includes('cost_usd')) {
        finalSql = finalSql.replace(/cost_usd/g, 'NULL')
      }
      const statement = database.prepare(finalSql)
      return method === 'get' ? statement.get(...finalParams) : statement.all(...finalParams)
    })
    parentPort.postMessage({ id, results })
  } catch (error) {
    parentPort.postMessage({
      id,
      error: error instanceof Error ? error.message : 'SQLite read worker failed',
    })
  }
})
