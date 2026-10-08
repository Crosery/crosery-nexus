import path from 'node:path'
import { Worker } from 'node:worker_threads'
import type express from 'express'
import { config } from './config.js'
import { addAudit, db, transaction } from './db.js'
import { recordRelayFailure, recordRelaySaved, relayTallies, type RelayTally } from './rtkRelayLedger.js'
import type { RelayWorkerData, RelayWorkerMessage } from './rtkRelayWorker.js'

/**
 * RTK relay control: the global switch, the per-key opt-in, the ledger and the listener thread.
 * The listener runs in a worker (server/rtkRelayWorker.ts); a crashed or unbindable worker is
 * restarted with backoff while the console keeps serving.
 */
export const RELAY_ENABLED_SETTING = 'rtk.relay.enabled'

type ListenerState = 'off' | 'starting' | 'listening' | 'failed'
type Listener = { state: ListenerState; port: number; target: string; error: string }

export type RtkRelayStatus = {
  /** Global switch (default on); a key is compressed only when it also opted in. */
  enabled: boolean
  listener: Listener
  optedInKeys: number
  /** Estimated input tokens removed (UTF-8 bytes / 4), not billed tokens. */
  today: RelayTally
  total: RelayTally
}

export type RtkRelayHandle = { listener: () => Listener; close: () => Promise<void> }

const MAX_RESTART_DELAY_MS = 30_000

/** Missing setting = on: the listener port and the per-key opt-in already default to off. */
export function relayEnabled(): boolean {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(RELAY_ENABLED_SETTING) as { value: string } | undefined
  return row?.value !== 'false'
}

export function setRelayEnabled(enabled: boolean) {
  transaction(() => {
    db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(RELAY_ENABLED_SETTING, String(enabled))
    addAudit('toggle_rtk_relay', 'relay', `enabled=${enabled}`)
  })
}

/** `rtkCompress` in a key create/update body; undefined keeps the stored value. */
export function parseRtkCompress(raw: unknown): boolean | undefined {
  if (raw === undefined) return undefined
  if (typeof raw !== 'boolean') throw new Error('rtkCompress 必须是 true 或 false')
  return raw
}

export function setKeyRtkCompress(keyHash: string, name: string, on: boolean) {
  const value = on ? 1 : 0
  const { changes } = db.prepare('UPDATE api_keys SET rtk_compress = ? WHERE key_hash = ? AND rtk_compress != ?').run(value, keyHash, value)
  if (changes) addAudit('set_key_rtk_compress', name, `rtkCompress=${on}`)
}

let current: RtkRelayHandle | null = null

export function rtkRelayStatus(): RtkRelayStatus {
  const listener = current?.listener() ?? { state: 'off', port: config.rtkRelayPort, target: config.rtkRelayTarget, error: '' }
  const optedIn = db.prepare('SELECT COUNT(*) n FROM api_keys WHERE enabled = 1 AND rtk_compress = 1').get() as { n: number }
  return { enabled: relayEnabled(), listener, optedInKeys: Number(optedIn.n), ...relayTallies(db) }
}

const log = (event: Record<string, unknown>) => console.info(JSON.stringify({ category: '[RTK]', ...event }))

export function startRtkRelay(options: { port: number; target: string; databaseFile: string } = {
  port: config.rtkRelayPort,
  target: config.rtkRelayTarget,
  databaseFile: path.join(config.dataDir, 'console.db'),
}): RtkRelayHandle {
  const listener: Listener = { state: options.port ? 'starting' : 'off', port: options.port, target: options.target, error: '' }
  let worker: Worker | null = null
  let stopped = false
  let delay = 1_000
  let timer: NodeJS.Timeout | undefined
  // Failures are counted per request in the ledger; the log gets at most one line a minute.
  let failures = 0
  let failureLoggedAt = 0

  const record = (message: RelayWorkerMessage) => {
    try {
      if (message.type === 'saved') recordRelaySaved(db, message.savedTokens)
      else if (message.type === 'failed') {
        recordRelayFailure(db)
        failures++
        if (Date.now() - failureLoggedAt >= 60_000) {
          log({ event: 'rtk_relay_compression_skipped', stage: message.stage, failures })
          failureLoggedAt = Date.now()
          failures = 0
        }
      }
    } catch (error) {
      log({ event: 'rtk_relay_ledger_failed', error: error instanceof Error ? error.name : 'unknown' })
    }
  }

  const spawn = () => {
    listener.state = 'starting'
    let attemptError = ''
    const data: RelayWorkerData = { port: options.port, target: options.target, databaseFile: options.databaseFile, enabledSetting: RELAY_ENABLED_SETTING }
    const next = new Worker(new URL('./rtkRelayWorker.ts', import.meta.url), { workerData: data })
    worker = next
    next.on('message', (message: RelayWorkerMessage) => {
      if (message.type === 'listening') {
        Object.assign(listener, { state: 'listening', error: '' })
        delay = 1_000
        log({ event: 'rtk_relay_listening', port: options.port, target: options.target })
      } else if (message.type === 'fatal') attemptError = message.code
      else record(message)
    })
    // Names and codes only: an error message may quote request data.
    next.on('error', (error: NodeJS.ErrnoException) => { attemptError ||= error.code || error.name })
    next.on('exit', (code) => {
      if (worker === next) worker = null
      if (stopped) return
      Object.assign(listener, { state: 'failed', error: attemptError || `exit ${code}` })
      log({ event: 'rtk_relay_exited', code, error: listener.error, restartInMs: delay })
      timer = setTimeout(spawn, delay)
      timer.unref()
      delay = Math.min(delay * 2, MAX_RESTART_DELAY_MS)
    })
  }

  const handle: RtkRelayHandle = {
    listener: () => ({ ...listener }),
    close: async () => {
      stopped = true
      clearTimeout(timer)
      if (current === handle) current = null
      await worker?.terminate()
    },
  }
  if (options.port) {
    spawn()
    current = handle
  }
  return handle
}

export function registerRtkRelayRoutes(app: express.Express) {
  app.get('/api/rtk/relay', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.json(rtkRelayStatus())
  })
  app.post('/api/rtk/relay', (req, res) => {
    const enabled = req.body?.enabled
    if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled 必须是 true 或 false' })
    setRelayEnabled(enabled)
    res.setHeader('Cache-Control', 'no-store')
    res.json(rtkRelayStatus())
  })
}
