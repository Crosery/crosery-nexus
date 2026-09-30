import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes, createHash } from 'node:crypto'
import { spawn, execFileSync } from 'node:child_process'
import { DatabaseSync, backup } from 'node:sqlite'
import { consolePasswordEnvironment } from './magpie-console-password.mjs'
import { upstreamRevision } from '../deploy/magpie/local.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const runtime = path.resolve(process.env.MAGPIE_CONSOLE_RUNTIME || path.join(os.homedir(), '.agents/crosery/magpie-console'))
const label = 'com.crosery.console-magpie'
const plist = path.join(os.homedir(), 'Library/LaunchAgents', `${label}.plist`)
const credentials = path.join(os.homedir(), '.agents/crosery/credentials')
process.env.MAGPIE_SOURCE_CPA_BASE_URL ||= 'https://ai.crosery.com'
process.env.MAGPIE_SOURCE_CPA_KEY_FILE ||= path.join(credentials, 'AI_CROSERY_MGMT_SECRET')
const manifestPath = path.join(runtime, 'console-manifest.json')
const exists = async filename => { try { await fs.access(filename); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error } }
const readManifest = async () => JSON.parse(await fs.readFile(manifestPath, 'utf8'))
const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
const action = process.argv[2]

if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Use Node >= 24, matching the Console package engines')

if (action === 'prepare') {
  if (await exists(manifestPath) || await exists(path.join(runtime, 'data'))) throw new Error('Console runtime already exists; refusing to overwrite')
  const { readMagpieSource } = await import('../server/magpieControl.ts')
  const { projectMagpieChannels } = await import('../server/magpieMigration.ts')
  const endpoints = ['openai-compatibility', 'claude-api-key', 'codex-api-key', 'gemini-api-key', 'vertex-api-key', 'auth-files']
  const source = Object.fromEntries(await Promise.all(endpoints.map(async endpoint => [endpoint, await readMagpieSource(endpoint)])))
  const projection = projectMagpieChannels(source)
  const sourceDatabase = path.join(root, 'data/console.db')
  const database = new DatabaseSync(sourceDatabase, { readOnly: true })
  const keyCount = Number(database.prepare('SELECT COUNT(*) c FROM api_keys').get().c)
  const providerCount = Number(database.prepare('SELECT COUNT(*) c FROM channel_states').get().c)
  // This local rehearsal must not make a second copy of an existing secret store.
  if (keyCount || providerCount) {
    database.close()
    throw new Error('Source DB contains keys or provider snapshots; use a reviewed in-place cutover, not this sample-data rehearsal')
  }
  await fs.mkdir(path.join(runtime, 'data'), { recursive: true, mode: 0o700 })
  try {
    const destination = path.join(runtime, 'data/console.db')
    await backup(database, destination)
    await fs.chmod(destination, 0o600)
    const restored = new DatabaseSync(destination, { readOnly: true })
    if (restored.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('Snapshot integrity check failed')
    const tables = ['api_keys', 'usage_events', 'quota_usage_events', 'channel_states', 'app_settings', 'audit_log']
    const counts = Object.fromEntries(tables.map(table => {
      const before = Number(database.prepare(`SELECT COUNT(*) c FROM ${table}`).get().c)
      const after = Number(restored.prepare(`SELECT COUNT(*) c FROM ${table}`).get().c)
      if (before !== after) throw new Error('Snapshot row-count mismatch')
      return [table, after]
    }))
    restored.close()
    await fs.writeFile(path.join(runtime, 'data/magpie-channels.json'), `${JSON.stringify({ version: 1, channels: projection.channels }, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    const pricing = path.join(root, 'data/gateway-pricing.json')
    if (await exists(pricing)) await fs.copyFile(pricing, path.join(runtime, 'data/gateway-pricing.json'))
    const manifest = {
      version: 1, createdAt: new Date().toISOString(), revision: upstreamRevision,
      sourceDatabase, source: process.env.MAGPIE_SOURCE_CPA_BASE_URL,
      dataDir: path.join(runtime, 'data'), consolePort: 8791, gatewayPort: 8790,
      socket: path.join(runtime, 'kernel.sock'), databaseRows: counts,
      restoredDatabaseSha256: createHash('sha256').update(await fs.readFile(destination)).digest('hex'),
      migratedChannels: projection.channels.map(channel => ({ name: channel.name, disabled: channel.disabled, models: channel.models.length })),
      pending: [...projection.pending, ...(source['auth-files'].length ? [{ channel: 'OAuth accounts', reason: `${source['auth-files'].length} source accounts were not copied or switched` }] : [])],
      credentialSourceKeyFile: process.env.MAGPIE_SOURCE_CPA_KEY_FILE,
      credentialSourceBaseUrl: process.env.MAGPIE_SOURCE_CPA_BASE_URL,
      consolePasswordFile: path.join(credentials, 'CROSERY_API_CONSOLE_PASSWORD'),
    }
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    console.log(JSON.stringify({ ...manifest, note: 'Only the local sample database was restored; production data and credentials remain at their source.' }))
  } finally { database.close() }
} else if (action === 'run') {
  const manifest = await readManifest()
  const passwordEnvironment = consolePasswordEnvironment(manifest)
  const home = path.join(runtime, 'home')
  await fs.mkdir(home, { recursive: true, mode: 0o700 })
  const socket = manifest.socket
  // A stale socket is removed only after proving no server answers on it.
  if (await exists(socket)) {
    const { kernelJSON } = await import('../server/magpieEngine.ts')
    try { await kernelJSON(socket, '/internal/health'); throw new Error('Kernel is already running') } catch (error) {
      if (!['ECONNREFUSED', 'ENOENT'].includes(error.code)) throw error
      const stat = await fs.lstat(socket)
      if (!stat.isSocket()) throw new Error('Refusing to remove a non-socket kernel path')
      await fs.unlink(socket)
    }
  }
  const env = Object.fromEntries(['PATH', 'LANG', 'LC_ALL', 'TMPDIR'].filter(key => process.env[key]).map(key => [key, process.env[key]]))
  const kernel = spawn(path.join(runtime, 'bin/magpie-kernel'), [], {
    cwd: home, env: { ...env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache'),
      MAGPIE_KERNEL_SOCKET: socket, MAGPIE_NO_STATS: '1', DO_NOT_TRACK: '1' }, stdio: 'ignore',
  })
  const { kernelJSON } = await import('../server/magpieEngine.ts')
  let ready = false
  for (let i = 0; i < 100; i++) {
    if (kernel.exitCode !== null) break
    try { await kernelJSON(socket, '/internal/health'); ready = true; break } catch { await new Promise(resolve => setTimeout(resolve, 50)) }
  }
  if (!ready) { kernel.kill('SIGTERM'); throw new Error('Magpie kernel did not become ready') }
  const consoleServer = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: root, env: {
      ...env, HOST: '127.0.0.1', PORT: String(manifest.consolePort), COOKIE_SECURE: 'false',
      CONSOLE_USERNAME: 'admin', ...passwordEnvironment, SESSION_SECRET: randomBytes(32).toString('hex'),
      DATA_DIR: manifest.dataDir, GATEWAY_ENGINE: 'magpie', MAGPIE_CONTROL_PLANE: 'local',
      MAGPIE_KERNEL_SOCKET: socket, MAGPIE_PORT: String(manifest.gatewayPort),
      MAGPIE_CHANNELS_FILE: path.join(manifest.dataDir, 'magpie-channels.json'),
      MAGPIE_SOURCE_CPA_BASE_URL: manifest.credentialSourceBaseUrl, MAGPIE_SOURCE_CPA_KEY_FILE: manifest.credentialSourceKeyFile,
    }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  consoleServer.stdout.pipe(process.stdout)
  consoleServer.stderr.pipe(process.stderr)
  let stopping = false
  const stop = () => {
    if (stopping) return
    stopping = true
    consoleServer.kill('SIGTERM')
    kernel.kill('SIGTERM')
  }
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
  kernel.once('error', stop)
  consoleServer.once('error', stop)
  kernel.once('exit', code => { stop(); process.exitCode = code || 0 })
  consoleServer.once('exit', code => { stop(); process.exitCode = code || 0 })
  console.log(JSON.stringify({ event: 'console_magpie_started', console: `http://127.0.0.1:${manifest.consolePort}`, gateway: `http://127.0.0.1:${manifest.gatewayPort}/v1` }))
} else if (action === 'install') {
  if (process.platform !== 'darwin') throw new Error('LaunchAgent install is macOS-only')
  await readManifest()
  if (await exists(plist)) throw new Error('Service already exists; refusing to overwrite')
  await fs.mkdir(path.dirname(plist), { recursive: true })
  const args = [process.execPath, '--import', 'tsx', path.join(root, 'scripts/magpie-console.mjs'), 'run']
  await fs.writeFile(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array>${args.map(arg => `<string>${xml(arg)}</string>`).join('')}</array>
<key>WorkingDirectory</key><string>${xml(root)}</string>
<key>EnvironmentVariables</key><dict><key>MAGPIE_CONSOLE_RUNTIME</key><string>${xml(runtime)}</string><key>PATH</key><string>${xml(process.env.PATH)}</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer>
<key>StandardOutPath</key><string>${xml(path.join(runtime, 'service.log'))}</string>
<key>StandardErrorPath</key><string>${xml(path.join(runtime, 'service-errors.log'))}</string>
</dict></plist>\n`, { flag: 'wx', mode: 0o600 })
  execFileSync('launchctl', ['bootstrap', `gui/${process.getuid()}`, plist])
  console.log(JSON.stringify({ installed: label, console: 'http://127.0.0.1:8791', gateway: 'http://127.0.0.1:8790/v1' }))
} else if (['start', 'stop', 'status'].includes(action)) {
  if (action === 'stop') execFileSync('launchctl', ['bootout', `gui/${process.getuid()}/${label}`])
  else if (action === 'start') execFileSync('launchctl', ['bootstrap', `gui/${process.getuid()}`, plist])
  else {
    const state = execFileSync('launchctl', ['print', `gui/${process.getuid()}/${label}`], { encoding: 'utf8' })
    console.log(state.split('\n').filter(line => /state =|pid =|last exit code =/.test(line)).join('\n'))
  }
} else {
  throw new Error('Use prepare, run, install, start, stop, or status')
}
