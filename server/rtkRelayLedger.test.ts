import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { migrateRtkRelay, recordRelayFailure, recordRelaySaved, relayDay, relayTallies } from './rtkRelayLedger.js'

/** A pre-relay database: the old api_keys shape plus usage rows that must stay untouched. */
function legacyDatabase() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crosery-rtk-ledger-'))
  const database = new DatabaseSync(path.join(dir, 'console.db'))
  database.exec(`
    CREATE TABLE api_keys (key_hash TEXT PRIMARY KEY, key_value TEXT NOT NULL, name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE usage_events (id INTEGER PRIMARY KEY AUTOINCREMENT, key_hash TEXT, model TEXT NOT NULL, total_tokens INTEGER NOT NULL);
    INSERT INTO api_keys VALUES ('h1', 'sk-one', 'one', 1), ('h2', 'sk-two', 'two', 0);
    WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 20000)
    INSERT INTO usage_events (key_hash, model, total_tokens) SELECT 'h1', 'm', i FROM n;
  `)
  return { database, cleanup: () => { database.close(); fs.rmSync(dir, { recursive: true, force: true }) } }
}

const keyColumns = (database: DatabaseSync) =>
  (database.prepare('PRAGMA table_info(api_keys)').all() as Array<{ name: string; dflt_value: string }>)

test('migration is additive and idempotent: one opt-in column defaulting to off, no rows rewritten', () => {
  const { database, cleanup } = legacyDatabase()
  try {
    const usageBefore = database.prepare('SELECT COUNT(*) n, SUM(total_tokens) s FROM usage_events').get()
    const usageSchema = database.prepare("SELECT sql FROM sqlite_master WHERE name = 'usage_events'").get()
    const fresh = new DatabaseSync(':memory:')
    const changesBefore = (database.prepare('SELECT total_changes() n').get() as { n: number }).n
    migrateRtkRelay(database)
    migrateRtkRelay(database)
    migrateRtkRelay(database)
    assert.equal((database.prepare('SELECT total_changes() n').get() as { n: number }).n, changesBefore, 'schema-only: no INSERT/UPDATE/DELETE')
    const optIn = keyColumns(database).filter((column) => column.name === 'rtk_compress')
    assert.equal(optIn.length, 1)
    assert.equal(optIn[0]!.dflt_value, '0')
    assert.deepEqual(database.prepare('SELECT key_hash, rtk_compress FROM api_keys ORDER BY key_hash').all().map((row) => ({ ...row })), [
      { key_hash: 'h1', rtk_compress: 0 },
      { key_hash: 'h2', rtk_compress: 0 },
    ])
    assert.deepEqual(database.prepare('SELECT COUNT(*) n, SUM(total_tokens) s FROM usage_events').get(), usageBefore)
    assert.deepEqual(database.prepare("SELECT sql FROM sqlite_master WHERE name = 'usage_events'").get(), usageSchema)
    assert.ok(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'rtk_compression_daily'").get())
    assert.equal((database.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check, 'ok')
    // A database that already has the column (a newer release ran first) is left as it is.
    fresh.exec('CREATE TABLE api_keys (key_hash TEXT PRIMARY KEY, rtk_compress INTEGER NOT NULL DEFAULT 0)')
    migrateRtkRelay(fresh)
    assert.equal(keyColumns(fresh).filter((column) => column.name === 'rtk_compress').length, 1)
  } finally { cleanup() }
})

test('ledger: one row per server-local day; savings and failures add up into today and total', () => {
  const { database, cleanup } = legacyDatabase()
  try {
    migrateRtkRelay(database)
    const yesterday = new Date(2026, 9, 8, 23, 59)
    const today = new Date(2026, 9, 9, 0, 1)
    assert.equal(relayDay(today), '2026-10-09')
    assert.equal(relayDay(yesterday), '2026-10-08')
    recordRelaySaved(database, 100, yesterday)
    recordRelaySaved(database, 40, today)
    recordRelaySaved(database, 2, today)
    recordRelaySaved(database, 0, today)
    recordRelaySaved(database, -5, today)
    recordRelayFailure(database, today)
    assert.deepEqual(relayTallies(database, today), {
      today: { savedTokens: 42, requests: 2, errors: 1 },
      total: { savedTokens: 142, requests: 3, errors: 1 },
    })
    assert.equal((database.prepare('SELECT COUNT(*) n FROM rtk_compression_daily').get() as { n: number }).n, 2)
    assert.deepEqual(relayTallies(database, new Date(2000, 0, 1)).today, { savedTokens: 0, requests: 0, errors: 0 }, 'a day without rows reads as zeros')
  } finally { cleanup() }
})
