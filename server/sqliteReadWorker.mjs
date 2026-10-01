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

/**
 * 占位符计数（task-62 ②）。
 *
 * 为什么必须显式校验：`node:sqlite` 在**参数少于占位符**时不会报错，而是把缺的参数当 NULL
 * 绑定 —— 查询静默返回空结果。2026-10-01（task-59）我两次踩到这个坑，表现都是「查询突然变快」
 * （0.4ms），而不是失败；靠聚合指纹比对才发现。所以这里在 `prepare` 之前主动比对个数，
 * 不匹配就抛错。
 *
 * 计数规则（与 SQLite 的绑定语义对齐）：
 * - 先剥掉字符串字面量（`'…'`、`"…"`、`` `…` ``）与注释（`--` 行注释、块注释），其中的 `?` 不算占位符；
 * - 匿名占位符 `?`（后面不跟数字）逐个计数；
 * - 编号占位符 `?NNN` 取其**最大编号**（SQLite 允许稀疏使用，最大编号即需要的参数个数）；
 * - 命名占位符（`:name` / `@name` / `$name`）出现时返回 `null`（表示"用数组长度无法判定"），
 *   调用方跳过校验 —— 本仓库目前不使用命名参数。
 */
export function countPlaceholders(sql) {
  if (typeof sql !== 'string') return null
  let stripped = ''
  let index = 0
  let named = false
  while (index < sql.length) {
    const char = sql[index]
    const next = sql[index + 1]
    if (char === '-' && next === '-') {
      const end = sql.indexOf('\n', index)
      index = end === -1 ? sql.length : end + 1
      continue
    }
    if (char === '/' && next === '*') {
      const end = sql.indexOf('*/', index + 2)
      index = end === -1 ? sql.length : end + 2
      continue
    }
    if (char === "'" || char === '"' || char === '`') {
      index += 1
      while (index < sql.length) {
        if (sql[index] === char) {
          if (sql[index + 1] === char) { index += 2; continue } // 转义的双写引号
          index += 1
          break
        }
        index += 1
      }
      stripped += ' '
      continue
    }
    if ((char === ':' || char === '@' || char === '$') && /[A-Za-z_]/.test(next || '')) named = true
    stripped += char
    index += 1
  }
  if (named) return null
  let anonymous = 0
  let maxNumbered = 0
  const matches = stripped.match(/\?(\d*)/g) || []
  for (const match of matches) {
    if (match === '?') anonymous += 1
    else maxNumbered = Math.max(maxNumbered, Number(match.slice(1)) || 0)
  }
  return maxNumbered + anonymous
}

/** 参数个数与占位符不一致时**显式报错**（而不是让 SQLite 静默按 NULL 绑定）。 */
export function assertParamCount(sql, params) {
  const expected = countPlaceholders(sql)
  if (expected === null) return
  const actual = params?.length ?? 0
  if (actual !== expected) {
    const head = String(sql).replace(/\s+/g, ' ').trim().slice(0, 160)
    throw new Error(`SQLite read worker: 参数个数与占位符不匹配（需要 ${expected} 个，收到 ${actual} 个）—— 参数不足会被 SQLite 当成 NULL 静默返回空结果，因此在此显式失败。 SQL: ${head}`)
  }
}

// 只在 worker 线程里挂监听：测试会从主线程 import 本模块取 `countPlaceholders`，
// 主线程的 `parentPort` 是 null，直接调用会抛错。
if (parentPort) parentPort.on('message', ({ id, operations }) => {
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
      // 改写之后再校验：路由路径的参数是 worker 自己映射的，这里能挡住映射错误（task-62 ②）。
      assertParamCount(finalSql, finalParams)
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
