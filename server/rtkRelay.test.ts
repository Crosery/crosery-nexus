import { testDataDir } from './testDataDir.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import { hashKey } from './cpa.js'
import { db } from './db.js'
import { parseRtkCompress, relayEnabled, rtkRelayStatus, setKeyRtkCompress, setRelayEnabled } from './rtkRelay.js'
import { writeRelayStatus } from './rtkRelayConfig.js'
import { RelayLedgerBuffer } from './rtkRelayLedger.js'

function seedKey(value: string, name: string) {
  const now = new Date().toISOString()
  db.prepare(`INSERT INTO api_keys (key_hash,key_value,name,note,enabled,groups_json,total_concurrency,group_concurrency_json,created_at,updated_at)
    VALUES (?,?,?,'',1,'["g"]',0,'{}',?,?)`).run(hashKey(value), value, name, now, now)
}

test('rtkCompress input: boolean or absent only', () => {
  assert.equal(parseRtkCompress(undefined), undefined)
  assert.equal(parseRtkCompress(true), true)
  assert.equal(parseRtkCompress(false), false)
  for (const bad of ['true', 1, null, {}]) assert.throws(() => parseRtkCompress(bad), /rtkCompress/)
})

test('status combines the switches, the relay status file and the ledger the relay wrote', () => {
  assert.equal(relayEnabled(), true, 'on unless switched off')
  assert.deepEqual(rtkRelayStatus().listener.state, 'off', 'no relay expected, none reported')
  seedKey('sk-relay-status-on', 'on')
  seedKey('sk-relay-status-off', 'off')
  setKeyRtkCompress(hashKey('sk-relay-status-on'), 'on', true)
  setKeyRtkCompress(hashKey('sk-relay-status-on'), 'on', true)
  setRelayEnabled(false)
  setRelayEnabled(true)

  const now = Date.now()
  writeRelayStatus(testDataDir, { state: 'listening', pid: 1, port: 8792, target: 'http://127.0.0.1:8316', error: '', startedAt: now, updatedAt: now, inFlight: 4 })
  const buffer = new RelayLedgerBuffer()
  buffer.saved(120)
  buffer.failed()
  assert.equal(buffer.flush(db), true)

  const status = rtkRelayStatus(now)
  assert.equal(status.enabled, true)
  assert.equal(status.optedInKeys, 1)
  assert.deepEqual(status.listener, { state: 'listening', port: 8792, target: 'http://127.0.0.1:8316', error: '', inFlight: 4, updatedAt: now })
  assert.deepEqual(status.today, { savedTokens: 120, requests: 1, errors: 1 })
  assert.equal(rtkRelayStatus(now + 60_000).listener.state, 'down', 'a relay that stopped refreshing its file is down')

  const audits = db.prepare("SELECT action, details FROM audit_log WHERE action IN ('toggle_rtk_relay', 'set_key_rtk_compress') ORDER BY id").all()
  assert.deepEqual(audits.map((row) => ({ ...row })), [
    { action: 'set_key_rtk_compress', details: 'rtkCompress=true' },
    { action: 'toggle_rtk_relay', details: 'enabled=false' },
    { action: 'toggle_rtk_relay', details: 'enabled=true' },
  ], 'an unchanged opt-in is not audited twice')
})
