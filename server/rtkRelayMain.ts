import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import { createRelayCompressionProxy } from './relayCompressionProxy.js'
import { parseRelayEnv, RELAY_HEARTBEAT_MS, writeRelayStatus, type RelayProcessState } from './rtkRelayConfig.js'
import { RELAY_ENABLED_SETTING, RelayLedgerBuffer } from './rtkRelayLedger.js'
import { compressRequestToolOutputs } from './toolCompress.js'

/**
 * RTK relay process (deploy/systemd/crosery-rtk-relay.service, docs/ops/rtk-relay.md). Runs apart from the
 * console so console releases never cut relayed streams. Reads the opt-in switches from the console database
 * (read-only connection), writes only its daily ledger (batched) and DATA_DIR/rtk-relay-status.json.
 * SIGTERM drains: the listener closes at once, open requests and streams finish within DRAIN_MS.
 * Logs carry event names and codes only, never request data or keys.
 */
const DRAIN_MS = 15 * 60_000
const log = (event: Record<string, unknown>) => console.info(JSON.stringify({ category: '[RTK]', ...event }))
const errorCode = (error: unknown) => (error as NodeJS.ErrnoException)?.code || (error as Error)?.name || 'unknown'

const env = parseRelayEnv(process.env)
const startedAt = Date.now()
let state: RelayProcessState = 'off'
let failure = ''
let server: ReturnType<typeof createRelayCompressionProxy> | null = null

function status() {
  try {
    writeRelayStatus(env.dataDir, {
      state, pid: process.pid, port: env.port, target: env.target, error: failure,
      startedAt, updatedAt: Date.now(), inFlight: server?.inFlight() ?? 0,
    })
  } catch (error) {
    log({ event: 'rtk_relay_status_write_failed', error: errorCode(error) })
  }
}

if (!env.port) {
  status()
  log({ event: 'rtk_relay_disabled' })
  process.exit(0)
}

const databaseFile = path.join(env.dataDir, 'console.db')
if (!fs.existsSync(databaseFile)) {
  state = 'failed'
  failure = 'no_console_database'
  status()
  log({ event: 'rtk_relay_failed', error: failure })
  process.exit(1)
}
// Short busy timeouts: SQLite waits on this thread, and a stalled loop would stall every stream.
const reader = new DatabaseSync(databaseFile, { readOnly: true })
reader.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 100;')
const writer = new DatabaseSync(databaseFile)
writer.exec('PRAGMA busy_timeout = 50;')
const ledger = new RelayLedgerBuffer()
const skipped = { lookup: 0, compress: 0 }

// Prepared on first use: a console that has not migrated yet makes lookups fail (counted), never requests.
let readSetting: StatementSync | undefined
let readKey: StatementSync | undefined

server = createRelayCompressionProxy({
  target: env.target,
  optedIn: (token) => {
    readSetting ??= reader.prepare('SELECT value FROM app_settings WHERE key = ?')
    readKey ??= reader.prepare('SELECT enabled, rtk_compress FROM api_keys WHERE key_hash = ?')
    if ((readSetting.get(RELAY_ENABLED_SETTING) as { value: string } | undefined)?.value === 'false') return false
    // Same digest as cpa.ts hashKey.
    const row = readKey.get(createHash('sha256').update(token).digest('hex')) as { enabled: number; rtk_compress: number } | undefined
    return Boolean(row?.enabled) && row?.rtk_compress === 1
  },
  compress: (body) => compressRequestToolOutputs(body).saved,
  saved: (savedTokens) => ledger.saved(savedTokens),
  failed: (stage) => {
    ledger.failed()
    skipped[stage]++
  },
})

function flush() {
  if (!ledger.flush(writer)) log({ event: 'rtk_relay_ledger_deferred', days: ledger.size })
  if (skipped.lookup || skipped.compress) {
    log({ event: 'rtk_relay_compression_skipped', ...skipped })
    skipped.lookup = 0
    skipped.compress = 0
  }
  status()
}
const heartbeat = setInterval(flush, RELAY_HEARTBEAT_MS)

server.once('error', (error) => {
  state = 'failed'
  failure = errorCode(error)
  status()
  log({ event: 'rtk_relay_failed', error: failure, port: env.port })
  process.exit(1)
})
server.listen(env.port, '127.0.0.1', () => {
  state = 'listening'
  status()
  log({ event: 'rtk_relay_listening', port: env.port, target: env.target })
})

let stopping = false
async function stop(signal: string) {
  if (stopping) return
  stopping = true
  state = 'draining'
  const draining = server!.drain(DRAIN_MS)
  status()
  log({ event: 'rtk_relay_draining', signal, inFlight: server!.inFlight() })
  const clean = await draining
  clearInterval(heartbeat)
  for (let attempt = 0; attempt < 10 && !ledger.flush(writer); attempt++) await new Promise((resolve) => setTimeout(resolve, 200))
  state = 'stopped'
  status()
  log({ event: 'rtk_relay_stopped', clean, unwritten: ledger.size })
  process.exit(0)
}
process.on('SIGTERM', () => void stop('SIGTERM'))
process.on('SIGINT', () => void stop('SIGINT'))
// Name, code and frames only: a message can quote request data.
process.on('uncaughtException', (error) => {
  state = 'failed'
  failure = errorCode(error)
  status()
  log({ event: 'rtk_relay_crashed', error: failure, stack: String(error?.stack || '').split('\n').slice(1, 8).join('\n') })
  process.exit(1)
})
