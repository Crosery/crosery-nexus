import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { parseRelayEnv, readRelayStatus, RELAY_HEARTBEAT_MS, relayListener, writeRelayStatus, type RelayStatusFile } from './rtkRelayConfig.js'

test('relay env: off by default; a set port needs a loopback target and its own port', () => {
  assert.deepEqual(parseRelayEnv({ DATA_DIR: '/data' }), { port: 0, target: '', dataDir: '/data' })
  assert.deepEqual(parseRelayEnv({ DATA_DIR: '/data', RTK_RELAY_PORT: '0', RTK_RELAY_TARGET: 'not checked while off' }), { port: 0, target: '', dataDir: '/data' })
  assert.deepEqual(parseRelayEnv({ DATA_DIR: '/data', RTK_RELAY_PORT: '8792' }), { port: 8792, target: 'http://127.0.0.1:8316', dataDir: '/data' })
  assert.equal(parseRelayEnv({ RTK_RELAY_PORT: '8792', RTK_RELAY_TARGET: 'http://[::1]:9000/' }).target, 'http://[::1]:9000')
  for (const port of ['-1', '65536', '1.5', 'abc']) assert.throws(() => parseRelayEnv({ RTK_RELAY_PORT: port }), /RTK_RELAY_PORT/, port)
  assert.throws(() => parseRelayEnv({ RTK_RELAY_PORT: '8792', RTK_RELAY_TARGET: 'http://198.51.100.1:8316' }), /RTK_RELAY_TARGET/)
  assert.throws(() => parseRelayEnv({ RTK_RELAY_PORT: '8787' }), /不能与 PORT/)
  assert.throws(() => parseRelayEnv({ RTK_RELAY_PORT: '9000', PORT: '9000' }), /不能与 PORT/)
  assert.throws(() => parseRelayEnv({ RTK_RELAY_PORT: '8316' }), /RTK_RELAY_TARGET 的端口/)
})

test('status file round-trips; a missing or broken file reads as none', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crosery-relay-status-'))
  try {
    assert.equal(readRelayStatus(dir), null)
    const status: RelayStatusFile = { state: 'listening', pid: 42, port: 8792, target: 'http://127.0.0.1:8316', error: '', startedAt: 1, updatedAt: 2, inFlight: 3 }
    writeRelayStatus(dir, status)
    assert.deepEqual(readRelayStatus(dir), status)
    assert.deepEqual(fs.readdirSync(dir), ['rtk-relay-status.json'], 'written through a temporary file')
    fs.writeFileSync(path.join(dir, 'rtk-relay-status.json'), '{"state":')
    assert.equal(readRelayStatus(dir), null)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('listener view: running states need a fresh heartbeat, exits are reported as written', () => {
  const now = 1_000_000
  const configured = { port: 8792, target: 'http://127.0.0.1:8316' }
  const file = (over: Partial<RelayStatusFile>): RelayStatusFile => ({ state: 'listening', pid: 1, port: 8792, target: configured.target, error: '', startedAt: 0, updatedAt: now, inFlight: 2, ...over })
  assert.equal(relayListener(null, { port: 0, target: '' }, now).state, 'off')
  assert.equal(relayListener(null, configured, now).state, 'down', 'expected here but never wrote a status')
  assert.deepEqual(relayListener(file({}), configured, now), { state: 'listening', port: 8792, target: configured.target, error: '', inFlight: 2, updatedAt: now })
  assert.equal(relayListener(file({ state: 'draining' }), configured, now).state, 'draining')
  const stale = relayListener(file({ updatedAt: now - 3 * RELAY_HEARTBEAT_MS - 1 }), configured, now)
  assert.deepEqual({ state: stale.state, inFlight: stale.inFlight }, { state: 'down', inFlight: 0 }, 'died without saying so')
  assert.equal(relayListener(file({ updatedAt: now - 3 * RELAY_HEARTBEAT_MS }), configured, now).state, 'listening')
  assert.equal(relayListener(file({ state: 'stopped', updatedAt: 0 }), configured, now).state, 'stopped')
  assert.deepEqual(relayListener(file({ state: 'failed', error: 'EADDRINUSE', updatedAt: 0 }), configured, now).error, 'EADDRINUSE')
  assert.equal(relayListener(file({ state: 'off', port: 0, updatedAt: 0 }), { port: 0, target: '' }, now).state, 'off')
})
