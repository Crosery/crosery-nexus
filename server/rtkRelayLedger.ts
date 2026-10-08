import type { DatabaseSync } from 'node:sqlite'

/**
 * RTK relay schema and daily ledger. Additive only: the key opt-in column takes a constant default
 * (SQLite rewrites no rows for that), and the ledger is one row per server-local day.
 */
export function migrateRtkRelay(database: DatabaseSync) {
  const keyColumns = new Set((database.prepare('PRAGMA table_info(api_keys)').all() as Array<{ name: string }>).map((column) => column.name))
  // Opt-in per key: existing and new keys stay uncompressed until switched on.
  if (!keyColumns.has('rtk_compress')) database.exec('ALTER TABLE api_keys ADD COLUMN rtk_compress INTEGER NOT NULL DEFAULT 0')
  database.exec(`
    CREATE TABLE IF NOT EXISTS rtk_compression_daily (
      day TEXT PRIMARY KEY,
      requests INTEGER NOT NULL DEFAULT 0,
      saved_tokens INTEGER NOT NULL DEFAULT 0,
      errors INTEGER NOT NULL DEFAULT 0
    )
  `)
}

export type RelayTally = { savedTokens: number; requests: number; errors: number }

/** Server-local calendar day, the same clock as the quota windows. */
export function relayDay(now = new Date()) {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

export function recordRelaySaved(database: DatabaseSync, savedTokens: number, now = new Date()) {
  if (!Number.isSafeInteger(savedTokens) || savedTokens <= 0) return
  database.prepare(`
    INSERT INTO rtk_compression_daily (day, requests, saved_tokens) VALUES (?, 1, ?)
    ON CONFLICT(day) DO UPDATE SET requests = requests + 1, saved_tokens = saved_tokens + excluded.saved_tokens
  `).run(relayDay(now), savedTokens)
}

export function recordRelayFailure(database: DatabaseSync, now = new Date()) {
  database.prepare(`
    INSERT INTO rtk_compression_daily (day, errors) VALUES (?, 1)
    ON CONFLICT(day) DO UPDATE SET errors = errors + 1
  `).run(relayDay(now))
}

export function relayTallies(database: DatabaseSync, now = new Date()): { today: RelayTally; total: RelayTally } {
  const read = (where: string, ...params: string[]): RelayTally => {
    const row = database.prepare(`
      SELECT COALESCE(SUM(saved_tokens), 0) savedTokens, COALESCE(SUM(requests), 0) requests, COALESCE(SUM(errors), 0) errors
      FROM rtk_compression_daily ${where}
    `).get(...params) as RelayTally
    return { savedTokens: Number(row.savedTokens), requests: Number(row.requests), errors: Number(row.errors) }
  }
  return { today: read('WHERE day = ?', relayDay(now)), total: read('') }
}
