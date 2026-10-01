// 红队第二十七轮：崩溃与 rollup 一致性演练的写入器（只在临时库上跑）
// 用法: node docs/qa/red-team/evidence/r27/crash-writer.mjs <db> <mode:auto|txn> <rows>
import { DatabaseSync } from 'node:sqlite'

const [dbPath, mode, rowsRaw] = process.argv.slice(2)
const rows = Number(rowsRaw || 500)
const db = new DatabaseSync(dbPath)
const insert = db.prepare(`
  INSERT OR IGNORE INTO usage_events
    (request_id, timestamp_ms, timestamp, provider, model, model_group, endpoint, key_hash,
     client_type, success, status_code, error_category, total_tokens, input_tokens, cached_tokens,
     output_tokens, cache_write_tokens, reasoning_tokens, latency_ms, ttft_ms, cost_usd, user_agent)
  VALUES (?, ?, ?, 'openai', 'gpt-5.6-luna', 'gpt-5.6-luna', '/v1/chat/completions', NULL,
     'codex-cli', 1, 200, '', 1000, 800, 200, 200, 0, 0, 120, 30, 0.01, 'codex-cli/1.0')
`)

const base = Date.now() - 3 * 3600_000 // 落在近 3 小时内，保证对齐窗口能统计到
const write = (i) => insert.run(`r27-${process.pid}-${i}`, base + i * 1000, new Date(base + i * 1000).toISOString())

if (mode === 'txn') {
  db.exec('BEGIN IMMEDIATE')
  for (let i = 0; i < rows; i++) write(i)
  console.log(`txn: ${rows} 行已写入未提交，等待被 kill -9`)
  setTimeout(() => { db.exec('COMMIT'); console.log('committed') }, 30_000)
  await new Promise(() => {})
} else {
  for (let i = 0; i < rows; i++) {
    write(i)
    if (i % 50 === 0) process.stdout.write(`auto: ${i}\n`)
    await new Promise((r) => setTimeout(r, 2))
  }
  console.log(`auto: 完成 ${rows} 行`)
}
