import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { config } from './config.js'
import { migrateQuotaLedger } from './quotaLedger.js'
import { categorizeUsageError } from './usageDetails.js'
import { CACHE_CEILING_INDEX_DDL } from './cacheStats.js'
import { migrateUsageRollup } from './usageRollup.js'
import { migrateRtkRelay } from './rtkRelayLedger.js'

fs.mkdirSync(config.dataDir, { recursive: true })

export const db = new DatabaseSync(path.join(config.dataDir, 'console.db'))
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL; PRAGMA temp_store = MEMORY; PRAGMA mmap_size = 268435456; PRAGMA cache_size = -65536;')

db.exec(`
  CREATE TABLE IF NOT EXISTS api_keys (
    key_hash TEXT PRIMARY KEY,
    key_value TEXT NOT NULL,
    name TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    enabled INTEGER NOT NULL DEFAULT 1,
    groups_json TEXT NOT NULL DEFAULT '[]',
    total_concurrency INTEGER NOT NULL DEFAULT 4,
    group_concurrency_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_used_at TEXT
  );

  CREATE TABLE IF NOT EXISTS usage_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id TEXT UNIQUE,
    timestamp TEXT NOT NULL,
    timestamp_ms INTEGER NOT NULL DEFAULT 0,
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
    cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL,
    user_agent TEXT NOT NULL DEFAULT '',
    client_type TEXT NOT NULL DEFAULT '',
    client_ip TEXT NOT NULL DEFAULT '',
    error_detail TEXT NOT NULL DEFAULT '',
    error_category TEXT NOT NULL DEFAULT '',
    upstream_request_id TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT '',
    auth_index TEXT NOT NULL DEFAULT '',
    reasoning_effort TEXT NOT NULL DEFAULT '',
    service_tier TEXT NOT NULL DEFAULT '',
    response_headers_json TEXT NOT NULL DEFAULT '{}',
    cost_usd REAL,
    FOREIGN KEY(key_hash) REFERENCES api_keys(key_hash) ON DELETE SET NULL
  );

  CREATE INDEX IF NOT EXISTS idx_usage_timestamp ON usage_events(timestamp);
  CREATE INDEX IF NOT EXISTS idx_usage_key_timestamp ON usage_events(key_hash, timestamp);
  CREATE INDEX IF NOT EXISTS idx_usage_group_timestamp ON usage_events(model_group, timestamp);

  /*
   * 详细请求明细按 USAGE_RETENTION_DAYS 清理；额度账本不能随之清理，
   * 否则「总额度」过了保留期会错误变小。按 request_id 去重，保留计费所需的最小字段。
   */
  CREATE TABLE IF NOT EXISTS quota_usage_events (
    request_id TEXT PRIMARY KEY,
    timestamp TEXT NOT NULL,
    timestamp_ms INTEGER NOT NULL DEFAULT 0,
    key_hash TEXT NOT NULL,
    provider TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL,
    input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    cached_tokens INTEGER NOT NULL,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL
  );
  CREATE INDEX IF NOT EXISTS idx_quota_usage_key_timestamp ON quota_usage_events(key_hash, timestamp);

  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action TEXT NOT NULL,
    target TEXT NOT NULL,
    details TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS channel_states (
    name TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 1,
    snapshot_json TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS channel_model_states (
    channel TEXT NOT NULL,
    model TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    snapshot_json TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL,
    PRIMARY KEY (channel, model)
  );

  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`)

const keyColumns = new Set((db.prepare('PRAGMA table_info(api_keys)').all() as Array<{ name: string }>).map((column) => column.name))
for (const [name, definition] of [
  // 额度上限，单位美元；0 表示不限额
  ['quota_total_usd', 'REAL NOT NULL DEFAULT 0'],
  ['quota_daily_usd', 'REAL NOT NULL DEFAULT 0'],
  ['quota_weekly_usd', 'REAL NOT NULL DEFAULT 0'],
  // 超限自动停用时记录原因，与人工停用区分
  ['quota_blocked_reason', "TEXT NOT NULL DEFAULT ''"],
  // 额度周期起算点，重置时前移，旧用量不再计入
  ['quota_total_since', "TEXT NOT NULL DEFAULT ''"],
  ['quota_daily_since', "TEXT NOT NULL DEFAULT ''"],
  ['quota_weekly_since', "TEXT NOT NULL DEFAULT ''"],
] as const) {
  if (!keyColumns.has(name)) db.exec(`ALTER TABLE api_keys ADD COLUMN ${name} ${definition}`)
}

const usageColumns = new Set((db.prepare('PRAGMA table_info(usage_events)').all() as Array<{ name: string }>).map((column) => column.name))
for (const [name, definition] of [
  ['timestamp_ms', 'INTEGER NOT NULL DEFAULT 0'],
  ['error_detail', "TEXT NOT NULL DEFAULT ''"],
  ['error_category', "TEXT NOT NULL DEFAULT ''"],
  ['upstream_request_id', "TEXT NOT NULL DEFAULT ''"],
  ['source', "TEXT NOT NULL DEFAULT ''"],
  ['auth_index', "TEXT NOT NULL DEFAULT ''"],
  ['reasoning_effort', "TEXT NOT NULL DEFAULT ''"],
  ['service_tier', "TEXT NOT NULL DEFAULT ''"],
  ['response_headers_json', "TEXT NOT NULL DEFAULT '{}'"],
  // Anthropic 缓存写入段。漏接期间命中率恒 100%、成本低估约 12%。
  ['cache_write_tokens', 'INTEGER NOT NULL DEFAULT 0'],
  // 调用方身份：CPA 一直在下发，早期没落库。
  ['user_agent', "TEXT NOT NULL DEFAULT ''"],
  ['client_type', "TEXT NOT NULL DEFAULT ''"],
  ['client_ip', "TEXT NOT NULL DEFAULT ''"],
  // 入库时按请求时刻的价格段与长上下文分档结算的单条成本；NULL = 未定价或历史行尚未回填
  // （scripts/backfill-cost.mjs）。汇总时优先 SUM(cost_usd)，缺失再按当前单价估算。
  ['cost_usd', 'REAL'],
] as const) {
  if (!usageColumns.has(name)) db.exec(`ALTER TABLE usage_events ADD COLUMN ${name} ${definition}`)
}
if (!usageColumns.has('timestamp_ms')) {
  // 一次性把历史 ISO 8601 偏移时间归一化为 epoch 毫秒；后续窗口查询可直接命中索引。
  db.exec("UPDATE usage_events SET timestamp_ms = CAST((julianday(timestamp) - 2440587.5) * 86400000 AS INTEGER) WHERE timestamp_ms = 0")
}
if (!usageColumns.has('error_category')) {
  const rows = db.prepare('SELECT id, status_code, error_detail FROM usage_events WHERE success = 0').all() as Array<{ id: number; status_code: number; error_detail: string }>
  const update = db.prepare('UPDATE usage_events SET error_category = ? WHERE id = ?')
  db.exec('BEGIN IMMEDIATE')
  try {
    for (const row of rows) update.run(categorizeUsageError(row.status_code, row.error_detail), row.id)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_usage_timestamp_ms ON usage_events(timestamp_ms);
  CREATE INDEX IF NOT EXISTS idx_usage_key_timestamp_ms ON usage_events(key_hash, timestamp_ms);
  CREATE INDEX IF NOT EXISTS idx_usage_success_timestamp_ms ON usage_events(success, timestamp_ms);
  CREATE INDEX IF NOT EXISTS idx_usage_error_timestamp_ms ON usage_events(error_category, timestamp_ms);
  CREATE INDEX IF NOT EXISTS idx_usage_client_timestamp_ms ON usage_events(client_type, timestamp_ms);
  CREATE INDEX IF NOT EXISTS idx_usage_model_success_timestamp_ms ON usage_events(
    (CASE WHEN instr(model,'/')>0 THEN substr(model,instr(model,'/')+1) ELSE model END),
    success,
    timestamp_ms DESC
  );
  /*
   * Reporting indexes are ordered by each report's GROUP BY keys. SQLite can
   * stream the aggregates from these narrower covering indexes instead of
   * reading response_headers_json and building a 300k-row temporary B-tree.
   */
  CREATE INDEX IF NOT EXISTS idx_usage_key_rollup ON usage_events(
    key_hash,
    substr(timestamp,1,10),
    model,
    provider,
    timestamp,
    timestamp_ms,
    input_tokens,
    cached_tokens,
    output_tokens,
    cache_write_tokens,
    reasoning_tokens,
    total_tokens,
    success,
    latency_ms,
    client_type
  );
  CREATE INDEX IF NOT EXISTS idx_usage_latency_rollup ON usage_events(
    (CASE WHEN instr(model,'/')>0 THEN substr(model,instr(model,'/')+1) ELSE model END),
    success,
    latency_ms,
    lower(trim(provider)),
    timestamp_ms,
    ttft_ms,
    model
  );
  CREATE INDEX IF NOT EXISTS idx_usage_cache_rollup ON usage_events(
    success,
    lower(trim(provider)),
    CAST(timestamp_ms / 3600000 AS INTEGER),
    CAST(timestamp_ms / 60000 AS INTEGER),
    (CASE WHEN instr(model,'/')>0 THEN substr(model,instr(model,'/')+1) ELSE model END),
    provider,
    client_type,
    model,
    timestamp_ms,
    input_tokens,
    cached_tokens,
    cache_write_tokens,
    output_tokens
  );
  /*
   * The default charts page derives its five low-cardinality datasets from one
   * streaming covering-index pass. Keep only the grouping, value and cutoff
   * fields here; selected-key charts continue to use the key index above.
   */
  CREATE INDEX IF NOT EXISTS idx_usage_charts_rollup ON usage_events(
    substr(timestamp,1,13),
    lower(trim(provider)),
    (CASE WHEN instr(model,'/')>0 THEN substr(model,instr(model,'/')+1) ELSE model END),
    success,
    status_code,
    error_category,
    total_tokens,
    timestamp_ms
  );
  /*
   * The over-ceiling probe in the 缓存 tab asks for successful requests whose prompt
   * crossed CACHE_WRITE_CEILING — under 2% of rows. Without a partial index that one
   * predicate forces a full pass over every retained event (measured 13.4s at ~1M
   * rows on the relay, versus 0.03s through this index). DDL and query conjunct are
   * one shared text (CACHE_CEILING_INDEX_DDL): SQLite only lets a partial index
   * serve a statement whose WHERE implies the index WHERE verbatim.
   */
  ${CACHE_CEILING_INDEX_DDL};
`)
const quotaColumns = new Set((db.prepare('PRAGMA table_info(quota_usage_events)').all() as Array<{ name: string }>).map((column) => column.name))
if (!quotaColumns.has('provider')) {
  db.exec("ALTER TABLE quota_usage_events ADD COLUMN provider TEXT NOT NULL DEFAULT ''")
}
if (!quotaColumns.has('cache_write_tokens')) {
  db.exec('ALTER TABLE quota_usage_events ADD COLUMN cache_write_tokens INTEGER NOT NULL DEFAULT 0')
}
if (!quotaColumns.has('cost_usd')) {
  db.exec('ALTER TABLE quota_usage_events ADD COLUMN cost_usd REAL')
}
migrateQuotaLedger(db)
migrateUsageRollup(db)
migrateRtkRelay(db)

const CLAUDE_PROVIDER_SQL = "lower(trim(provider)) IN ('claude','claude-api-key','anthropic','anthropic-api-key')"
const QUOTA_LEDGER_BACKFILL = 'quota-ledger-cost-backfill-v2'
const quotaLedgerBackfilled = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(QUOTA_LEDGER_BACKFILL)
if (!quotaLedgerBackfilled) {
  db.exec('BEGIN IMMEDIATE')
  try {
    // 只有实际原生 Anthropic provider 才允许存在独立 cache_creation 段。
    db.exec(`
      UPDATE usage_events SET cache_write_tokens = 0
      WHERE cache_write_tokens != 0
        AND lower(trim(provider)) NOT IN ('claude','claude-api-key','anthropic','anthropic-api-key')
    `)
    /*
     * 历史行的缓存写入段可从总量反推：total - (input + output + cached)。
     * 仅对 Anthropic 且差值为正的行回填，避免 OpenAI 口径重复扣除 cached。
     */
    db.exec(`
      UPDATE usage_events SET cache_write_tokens =
        total_tokens - (input_tokens + output_tokens + cached_tokens)
      WHERE cache_write_tokens = 0
        AND ${CLAUDE_PROVIDER_SQL}
        AND total_tokens > (input_tokens + output_tokens + cached_tokens)
    `)
    // 升级前的明细进入永久账本；先修明细再复制，避免同一批数据二次回写。
    db.exec(`
      INSERT OR IGNORE INTO quota_usage_events
        (request_id,timestamp,timestamp_ms,key_hash,provider,model,input_tokens,output_tokens,cached_tokens,cache_write_tokens)
      SELECT request_id,timestamp,timestamp_ms,key_hash,provider,model,input_tokens,output_tokens,cached_tokens,cache_write_tokens
      FROM usage_events WHERE key_hash IS NOT NULL
    `)
    db.exec(`
      UPDATE quota_usage_events SET cache_write_tokens = 0
      WHERE cache_write_tokens != 0
        AND lower(trim(provider)) NOT IN ('claude','claude-api-key','anthropic','anthropic-api-key')
    `)
    db.exec(`
      UPDATE quota_usage_events SET provider = (
        SELECT u.provider FROM usage_events u WHERE u.request_id = quota_usage_events.request_id
      )
      WHERE provider = ''
        AND EXISTS (SELECT 1 FROM usage_events u WHERE u.request_id = quota_usage_events.request_id)
    `)
    db.exec(`
      UPDATE quota_usage_events SET cache_write_tokens = (
        SELECT u.cache_write_tokens FROM usage_events u WHERE u.request_id = quota_usage_events.request_id
      )
      WHERE cache_write_tokens = 0
        AND EXISTS (
          SELECT 1 FROM usage_events u
          WHERE u.request_id = quota_usage_events.request_id AND u.cache_write_tokens > 0
        )
    `)
    db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?)').run(QUOTA_LEDGER_BACKFILL, 'done')
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export function transaction<T>(fn: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export function addAudit(action: string, target: string, details = '') {
  db.prepare('INSERT INTO audit_log (action, target, details, created_at) VALUES (?, ?, ?, ?)')
    .run(action, target, details, new Date().toISOString())
}
