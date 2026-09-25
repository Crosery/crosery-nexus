#!/usr/bin/env node
/**
 * 为历史用量补齐请求发生时刻的成本。
 *
 * 用法：
 *   node --import tsx scripts/backfill-cost.mjs /opt/crosery-api-console/data/console.db
 *
 * 每批只读有限行并在一个短事务内更新，适合 WAL 模式下在线运行。已有 cost_usd
 * 的行永不覆盖，未定价模型保持 NULL，方便页面继续显式提示部分成本。
 */
import { DatabaseSync } from 'node:sqlite'
import { normalizeTokens } from '../server/cacheStats.ts'
import { restoreGatewayPricing } from '../server/modelCatalog.ts'
import { priceRequest } from '../server/pricing.ts'

const filename = process.argv[2]
const batchSize = Math.max(100, Math.min(10_000, Number(process.argv[3] || 2_000)))
if (!filename) {
  console.error('usage: node --import tsx scripts/backfill-cost.mjs <console.db> [batch-size]')
  process.exit(2)
}

// 静态表没有的模型（gemini-3.8-flash / gpt-6-astra 等）价格来自网关，进程内存里没有，
// 先读回落盘的网关价，否则这些模型的历史用量会被判成「仍未定价」跳过。
const restored = restoreGatewayPricing()
if (restored) console.log(`装入网关价 ${restored} 条`)

const db = new DatabaseSync(filename)
db.exec('PRAGMA busy_timeout = 10000')
const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name))
function calculate(row) {
  const inputTokens = Number(row.input_tokens) || 0
  const outputTokens = Number(row.output_tokens) || 0
  const cachedTokens = Number(row.cached_tokens) || 0
  const cacheWriteTokens = Number(row.cache_write_tokens) || 0
  const billed = normalizeTokens({
    model: String(row.model || ''),
    provider: String(row.provider || ''),
    inputTokens,
    outputTokens,
    cachedTokens,
    cacheWriteTokens,
  })
  return priceRequest(String(row.model || ''), {
    newInputTokens: billed.freshInputTokens,
    outputTokens: billed.outputTokens,
    cacheReadTokens: billed.cacheReadTokens,
    cacheWriteTokens: billed.cacheWriteTokens,
    promptTokens: billed.promptTokens,
    at: String(row.timestamp || ''),
  })
}

function backfill(table) {
  if (!tables.has(table)) return { table, updated: 0, skipped: 0 }
  const read = db.prepare(`SELECT rowid AS _rowid, request_id, timestamp, model, provider, input_tokens, output_tokens, cached_tokens, cache_write_tokens FROM ${table} WHERE cost_usd IS NULL AND rowid > ? ORDER BY rowid LIMIT ?`)
  const write = db.prepare(`UPDATE ${table} SET cost_usd = ? WHERE request_id = ? AND cost_usd IS NULL`)
  let updated = 0
  let skipped = 0
  let cursor = 0
  while (true) {
    const rows = read.all(cursor, batchSize)
    if (!rows.length) break
    cursor = Number(rows[rows.length - 1]._rowid)
    db.exec('BEGIN IMMEDIATE')
    try {
      for (const row of rows) {
        const cost = calculate(row)
        if (cost === null) skipped += 1
        else updated += Number(write.run(cost, row.request_id).changes || 0)
      }
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    console.log(`${table}: updated=${updated} skipped_unpriced=${skipped}`)
  }
  return { table, updated, skipped }
}

const results = [backfill('usage_events'), backfill('quota_usage_events')]
console.log(JSON.stringify({ ok: true, batchSize, results }))
