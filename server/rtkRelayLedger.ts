import type { DatabaseSync } from 'node:sqlite'

/** Global compression switch in app_settings: missing or 'true' = on, 'false' = off. */
export const RELAY_ENABLED_SETTING = 'rtk.relay.enabled'

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

/**
 * The relay process counts in memory and writes one small transaction per flush, so a busy console
 * database never blocks a request. A failed flush keeps its counts for the next one.
 */
export class RelayLedgerBuffer {
  private pending = new Map<string, RelayTally>()

  saved(savedTokens: number, now = new Date()) {
    if (!Number.isSafeInteger(savedTokens) || savedTokens <= 0) return
    const tally = this.entry(relayDay(now))
    tally.requests++
    tally.savedTokens += savedTokens
  }

  failed(now = new Date()) {
    this.entry(relayDay(now)).errors++
  }

  get size() {
    return this.pending.size
  }

  /** True when nothing is left to write. */
  flush(database: DatabaseSync): boolean {
    if (!this.pending.size) return true
    const batch = this.pending
    this.pending = new Map()
    try {
      database.exec('BEGIN IMMEDIATE')
      try {
        const upsert = database.prepare(`
          INSERT INTO rtk_compression_daily (day, requests, saved_tokens, errors) VALUES (?, ?, ?, ?)
          ON CONFLICT(day) DO UPDATE SET requests = requests + excluded.requests,
            saved_tokens = saved_tokens + excluded.saved_tokens, errors = errors + excluded.errors
        `)
        for (const [day, tally] of batch) upsert.run(day, tally.requests, tally.savedTokens, tally.errors)
        database.exec('COMMIT')
      } catch (error) {
        database.exec('ROLLBACK')
        throw error
      }
      return !this.pending.size
    } catch {
      for (const [day, tally] of batch) {
        const merged = this.entry(day)
        merged.requests += tally.requests
        merged.savedTokens += tally.savedTokens
        merged.errors += tally.errors
      }
      return false
    }
  }

  private entry(day: string) {
    let tally = this.pending.get(day)
    if (!tally) this.pending.set(day, (tally = { savedTokens: 0, requests: 0, errors: 0 }))
    return tally
  }
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
