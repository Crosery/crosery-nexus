import type express from 'express'
import { config } from './config.js'
import { addAudit, db, transaction } from './db.js'
import { readRelayStatus, relayListener, type RelayListener } from './rtkRelayConfig.js'
import { RELAY_ENABLED_SETTING, relayTallies, type RelayTally } from './rtkRelayLedger.js'

/**
 * Console side of the RTK relay: the global switch and per-key opt-in (both read by the relay process from
 * this database), the ledger it writes, and its status file. The relay itself is server/rtkRelayMain.ts.
 */
export type RtkRelayStatus = {
  /** Global switch (default on); a key is compressed only when it also opted in. */
  enabled: boolean
  listener: RelayListener
  optedInKeys: number
  /** Estimated input tokens removed (UTF-8 bytes / 4), not billed tokens. */
  today: RelayTally
  total: RelayTally
}

/** Missing setting = on: the relay port and the per-key opt-in already default to off. */
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

export function rtkRelayStatus(now = Date.now()): RtkRelayStatus {
  const optedIn = db.prepare('SELECT COUNT(*) n FROM api_keys WHERE enabled = 1 AND rtk_compress = 1').get() as { n: number }
  return {
    enabled: relayEnabled(),
    listener: relayListener(readRelayStatus(config.dataDir), { port: config.rtkRelayPort, target: config.rtkRelayTarget }, now),
    optedInKeys: Number(optedIn.n),
    ...relayTallies(db, new Date(now)),
  }
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
