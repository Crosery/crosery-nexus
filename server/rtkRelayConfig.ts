import fs from 'node:fs'
import path from 'node:path'
import { relayTarget } from './relayCompressionProxy.js'

/**
 * Shared by the console (status, validation) and the relay process (server/rtkRelayMain.ts). Built-ins only,
 * so the relay never loads the console's config or migrations.
 */
export const DEFAULT_RELAY_TARGET = 'http://127.0.0.1:8316'
export const RELAY_STATUS_FILE = 'rtk-relay-status.json'
/** The relay rewrites its status file at least this often while it runs (with each ledger flush). */
export const RELAY_HEARTBEAT_MS = 10_000

export type RelayEnv = { port: number; target: string; dataDir: string }

export function parseRelayEnv(env: NodeJS.ProcessEnv): RelayEnv {
  const dataDir = env.DATA_DIR || path.resolve('data')
  const raw = env.RTK_RELAY_PORT
  const port = raw === undefined || raw === '' ? 0 : Number(raw)
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error('RTK_RELAY_PORT 必须是 0 到 65535 的整数')
  if (!port) return { port: 0, target: '', dataDir }
  const target = relayTarget(env.RTK_RELAY_TARGET || DEFAULT_RELAY_TARGET).origin
  if ([Number(env.PORT || 8787), Number(new URL(target).port || 80)].includes(port)) {
    throw new Error('RTK_RELAY_PORT 不能与 PORT 或 RTK_RELAY_TARGET 的端口相同')
  }
  return { port, target, dataDir }
}

export type RelayProcessState = 'off' | 'listening' | 'draining' | 'stopped' | 'failed'
export type RelayStatusFile = {
  state: RelayProcessState
  pid: number
  port: number
  target: string
  /** error code only (EADDRINUSE …), never a message */
  error: string
  startedAt: number
  updatedAt: number
  /** requests and websocket tunnels still open */
  inFlight: number
}

export function writeRelayStatus(dataDir: string, status: RelayStatusFile) {
  const file = path.join(dataDir, RELAY_STATUS_FILE)
  const temporary = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(status)}\n`)
  fs.renameSync(temporary, file)
}

export function readRelayStatus(dataDir: string): RelayStatusFile | null {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(dataDir, RELAY_STATUS_FILE), 'utf8')) as RelayStatusFile
    return value && typeof value === 'object' && typeof value.state === 'string' && Number.isFinite(value.updatedAt) ? value : null
  } catch {
    return null
  }
}

export type RelayListenerState = RelayProcessState | 'down'
export type RelayListener = { state: RelayListenerState; port: number; target: string; error: string; inFlight: number; updatedAt: number | null }

/**
 * What the console shows. A running relay (listening / draining) must have refreshed its file within three
 * heartbeats; otherwise it died without saying so (SIGKILL, OOM) and the state is `down`. Without any file the
 * relay is `down` when this host's env expects one, else `off`.
 */
export function relayListener(file: RelayStatusFile | null, configured: { port: number; target: string }, now = Date.now()): RelayListener {
  if (!file) return { state: configured.port ? 'down' : 'off', port: configured.port, target: configured.target, error: '', inFlight: 0, updatedAt: null }
  const running = file.state === 'listening' || file.state === 'draining'
  const stale = now - file.updatedAt > 3 * RELAY_HEARTBEAT_MS
  return {
    state: running && stale ? 'down' : file.state,
    port: file.port,
    target: file.target,
    error: file.error,
    inFlight: running && !stale ? file.inFlight : 0,
    updatedAt: file.updatedAt,
  }
}
