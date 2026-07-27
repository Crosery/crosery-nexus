import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { config } from './config.js'

fs.mkdirSync(config.dataDir, { recursive: true })

export const db = new DatabaseSync(path.join(config.dataDir, 'console.db'))
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')

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
    total_tokens INTEGER NOT NULL,
    error_detail TEXT NOT NULL DEFAULT '',
    upstream_request_id TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT '',
    auth_index TEXT NOT NULL DEFAULT '',
    reasoning_effort TEXT NOT NULL DEFAULT '',
    service_tier TEXT NOT NULL DEFAULT '',
    response_headers_json TEXT NOT NULL DEFAULT '{}',
    FOREIGN KEY(key_hash) REFERENCES api_keys(key_hash) ON DELETE SET NULL
  );

  CREATE INDEX IF NOT EXISTS idx_usage_timestamp ON usage_events(timestamp);
  CREATE INDEX IF NOT EXISTS idx_usage_key_timestamp ON usage_events(key_hash, timestamp);
  CREATE INDEX IF NOT EXISTS idx_usage_group_timestamp ON usage_events(model_group, timestamp);

  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action TEXT NOT NULL,
    target TEXT NOT NULL,
    details TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
`)

const usageColumns = new Set((db.prepare('PRAGMA table_info(usage_events)').all() as Array<{ name: string }>).map((column) => column.name))
for (const [name, definition] of [
  ['error_detail', "TEXT NOT NULL DEFAULT ''"],
  ['upstream_request_id', "TEXT NOT NULL DEFAULT ''"],
  ['source', "TEXT NOT NULL DEFAULT ''"],
  ['auth_index', "TEXT NOT NULL DEFAULT ''"],
  ['reasoning_effort', "TEXT NOT NULL DEFAULT ''"],
  ['service_tier', "TEXT NOT NULL DEFAULT ''"],
  ['response_headers_json', "TEXT NOT NULL DEFAULT '{}'"],
] as const) {
  if (!usageColumns.has(name)) db.exec(`ALTER TABLE usage_events ADD COLUMN ${name} ${definition}`)
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
