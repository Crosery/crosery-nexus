import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { parentPort, workerData } from 'node:worker_threads'
import { createRelayCompressionProxy } from './relayCompressionProxy.js'
import { compressRequestToolOutputs } from './toolCompress.js'

/**
 * RTK relay listener thread. It owns its own event loop, so console work on the main thread (SQLite
 * reports, sync jobs) never delays relayed streams. Reads opt-in state from a read-only connection;
 * every write (ledger) goes back to the main thread as a message.
 */
export type RelayWorkerData = { port: number; target: string; databaseFile: string; enabledSetting: string }
export type RelayWorkerMessage =
  | { type: 'listening' }
  | { type: 'fatal'; code: string }
  | { type: 'saved'; savedTokens: number }
  | { type: 'failed'; stage: 'lookup' | 'compress' }

const data = workerData as RelayWorkerData
const port = parentPort!
const post = (message: RelayWorkerMessage) => port.postMessage(message)

const database = new DatabaseSync(data.databaseFile, { readOnly: true })
database.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 1000;')
const readSetting = database.prepare('SELECT value FROM app_settings WHERE key = ?')
const readKey = database.prepare('SELECT enabled, rtk_compress FROM api_keys WHERE key_hash = ?')

const server = createRelayCompressionProxy({
  target: data.target,
  optedIn: (token) => {
    if ((readSetting.get(data.enabledSetting) as { value: string } | undefined)?.value === 'false') return false
    // Same digest as cpa.ts hashKey.
    const row = readKey.get(createHash('sha256').update(token).digest('hex')) as { enabled: number; rtk_compress: number } | undefined
    return Boolean(row?.enabled) && row?.rtk_compress === 1
  },
  compress: (body) => compressRequestToolOutputs(body).saved,
  saved: (savedTokens) => post({ type: 'saved', savedTokens }),
  failed: (stage) => post({ type: 'failed', stage }),
})
server.once('error', (error: NodeJS.ErrnoException) => {
  post({ type: 'fatal', code: error.code || 'listen_failed' })
  process.exit(1)
})
server.listen(data.port, '127.0.0.1', () => post({ type: 'listening' }))
