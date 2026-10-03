#!/usr/bin/env node
/**
 * Black-box smoke of a CPA (CLIProxyAPI + our patches) binary before it may reach the relay.
 *
 *   node scripts/cpa-smoke.mjs --binary <cli-proxy-api> [--version <expected>] [--config deploy/kernels/cpa-builder/smoke-config.yaml]
 *
 * Runs on the CPA builder (ibuki-wsl-crosery, after go test) and anywhere for a manual check. Starts the binary on a
 * free loopback port with the production-shaped fixture (every key path production's config.yaml has, fake values)
 * and checks what the console and the clients rely on: management reads, per-key model / channel allowlists, the
 * compat channel, /v1/models per key; then a management write (the one that migrates a legacy config.yaml to a newer
 * layout), a restart on the written file, and the same checks again. Prints { ok, checks } as JSON; exit 1 when any failed.
 * No network beyond loopback is needed; nothing outside the temp dir is written.
 */
import fs from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { spawn, execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const arg = name => { const at = process.argv.indexOf(name); return at < 0 ? undefined : process.argv[at + 1] }
const OPEN = 'sk-smoke-open'
const LIMITED = 'sk-smoke-limited'
const CHANNEL = 'sk-smoke-channel'
const ADDED = 'sk-smoke-added'
/** fork keys at the top level that no schema declares: a config write must keep them as live YAML, not comments */
const FORK_TOP_LEVEL = ['claude-cache-ttl-upgrade', 'api-key-channel-access-required']

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)) })
  })
}

async function call(base, route, { method = 'GET', key, management, body } = {}) {
  const headers = { 'content-type': 'application/json' }
  if (key) headers.authorization = `Bearer ${key}`
  if (management) headers.authorization = `Bearer ${management}`
  try {
    const response = await fetch(base + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10_000) })
    const text = await response.text()
    let json = null
    try { json = JSON.parse(text) } catch { /* not JSON */ }
    return { status: response.status, json, headers: response.headers }
  } catch (error) {
    return { status: 0, json: null, error: error.message }
  }
}

function start(binary, dir, env) {
  const child = spawn(binary, ['-config', path.join(dir, 'config.yaml')], {
    cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32',
  })
  const tail = []
  const keep = chunk => { for (const line of String(chunk).split('\n')) if (line.trim()) { tail.push(line.trim()); if (tail.length > 40) tail.shift() } }
  child.stdout.on('data', keep)
  child.stderr.on('data', keep)
  let exited = null
  child.once('exit', code => { exited = code ?? -1 })
  return {
    child, tail, exited: () => exited,
    async stop() {
      if (exited !== null) return
      try { process.kill(-child.pid, 'SIGTERM') } catch { child.kill('SIGTERM') }
      for (let i = 0; i < 50 && exited === null; i += 1) await sleep(100)
      if (exited === null) { try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') } }
    },
  }
}

async function waitReady(base, proc, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (proc.exited() !== null) return false
    const probe = await call(base, '/v1/models')
    if (probe.status === 401 || probe.status === 200) return true
    await sleep(250)
  }
  return false
}

const ids = response => (Array.isArray(response.json?.data) ? response.json.data.map(model => model.id) : [])

/** The checks that must hold both on the fixture as given and after a write + restart. */
async function surface(base, management, round, { expectAdded }) {
  const checks = []
  const check = (name, ok, detail = '') => { checks.push({ name: `${round}:${name}`, ok: Boolean(ok), ...(detail ? { detail: String(detail).slice(0, 160) } : {}) }); return ok }
  const keys = await call(base, '/v0/management/api-keys', { management })
  const list = Array.isArray(keys.json?.['api-keys']) ? keys.json['api-keys'] : []
  check('management api-keys', keys.status === 200 && [OPEN, LIMITED, CHANNEL].every(key => list.includes(key)) && list.includes(ADDED) === expectAdded, `HTTP ${keys.status} n=${list.length}`)
  const model = await call(base, '/v0/management/api-key-model-access', { management })
  check('api-key-model-access kept', model.status === 200 && JSON.stringify(model.json?.['api-key-model-access']?.[LIMITED]) === '["smoke-model-a"]', `HTTP ${model.status}`)
  const channel = await call(base, '/v0/management/api-key-channel-access', { management })
  check('api-key-channel-access kept', channel.status === 200 && JSON.stringify(channel.json?.['api-key-channel-access']?.[CHANNEL]) === '["smoke-compat"]', `HTTP ${channel.status}`)
  const compat = await call(base, '/v0/management/openai-compatibility', { management })
  const entries = Array.isArray(compat.json?.['openai-compatibility']) ? compat.json['openai-compatibility'] : []
  const entry = entries.find(item => item?.name === 'smoke-compat')
  check('openai-compatibility kept', compat.status === 200 && entry && Array.isArray(entry.models) && entry.models.length === 2, `HTTP ${compat.status} n=${entries.length}`)
  check('compat per-key proxy-url kept', entry?.['api-key-entries']?.[0]?.['proxy-url'] === 'http://127.0.0.1:9')
  const auth = await call(base, '/v0/management/auth-files', { management })
  check('management auth-files', auth.status === 200 && Array.isArray(auth.json?.files) && auth.json.files.length === 1, `HTTP ${auth.status} n=${auth.json?.files?.length ?? '-'}`)
  const available = await call(base, '/v0/management/available-models', { management })
  check('management available-models', available.status === 200 && Array.isArray(available.json?.models), `HTTP ${available.status}`)
  const open = ids(await call(base, '/v1/models', { key: OPEN }))
  check('/v1/models open key', open.includes('smoke-model-a') && open.includes('smoke-model-b'), `n=${open.length}`)
  const limited = await call(base, '/v1/models', { key: LIMITED })
  check('/v1/models limited key sees only its allowlist', limited.status === 200 && ids(limited).includes('smoke-model-a') && !ids(limited).includes('smoke-model-b'), `HTTP ${limited.status} ${ids(limited).slice(0, 4).join(',')}`)
  const denied = await call(base, '/v1/chat/completions', { method: 'POST', key: LIMITED, body: { model: 'smoke-model-b', messages: [{ role: 'user', content: 'x' }] } })
  check('limited key refused a model outside its allowlist', denied.status === 403, `HTTP ${denied.status}`)
  const bad = await call(base, '/v1/models', { key: 'sk-smoke-unknown' })
  check('/v1/models unknown key 401', bad.status === 401, `HTTP ${bad.status}`)
  return checks
}

export async function smoke({ binary, version, config = path.join(root, 'deploy/kernels/cpa-builder/smoke-config.yaml') }) {
  const checks = []
  const check = (name, ok, detail = '') => { checks.push({ name, ok: Boolean(ok), ...(detail ? { detail: String(detail).slice(0, 160) } : {}) }); return ok }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cpa-smoke-'))
  const management = `smoke-${randomBytes(12).toString('hex')}`
  let proc = null
  try {
    const said = await new Promise(resolve => execFile(binary, ['--version'], { timeout: 15_000 }, (error, stdout, stderr) => resolve(`${stdout}${stderr}${error && !stdout ? error.message : ''}`)))
    if (version) check('version', said.includes(`Version: ${version}`), said.split('\n')[0])
    const port = await freePort()
    const auth = path.join(dir, 'auths')
    await fs.mkdir(auth, { recursive: true, mode: 0o700 })
    // one disabled OAuth file: listed by the management API, never refreshed
    await fs.writeFile(path.join(auth, 'codex-smoke@example.invalid.json'), JSON.stringify({ type: 'codex', email: 'smoke@example.invalid', disabled: true, access_token: 'smoke', refresh_token: 'smoke', expired: '2000-01-01T00:00:00Z' }), { mode: 0o600 })
    const fixture = (await fs.readFile(config, 'utf8')).replace(/^port: __PORT__$/m, `port: ${port}`).replace(/^auth-dir: "__AUTH_DIR__"$/m, `auth-dir: "${auth}"`)
    await fs.writeFile(path.join(dir, 'config.yaml'), fixture, { mode: 0o600 })
    const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: path.join(dir, 'home'), MANAGEMENT_PASSWORD: management, TZ: 'UTC' }
    await fs.mkdir(env.HOME, { recursive: true })
    const base = `http://127.0.0.1:${port}`

    const why = p => (p.exited() !== null ? `exited ${p.exited()}: ${p.tail.at(-1) ?? ''}` : 'no answer in 30s')
    proc = start(binary, dir, env)
    let ready = await waitReady(base, proc)
    if (!check('starts on the production-shaped config', ready, ready ? '' : why(proc))) return { ok: false, checks }
    const header = (await call(base, '/v0/management/api-keys', { management })).headers?.get('x-cpa-version')
    if (version) check('x-cpa-version header', header === version, header ?? 'missing')
    checks.push(...await surface(base, management, 'loaded', { expectAdded: false }))

    // a management write: the console does this all the time (keys, allowlists); a newer layout migrates the file here
    const before = await fs.readFile(path.join(dir, 'config.yaml'), 'utf8')
    const put = await call(base, '/v0/management/api-keys', { method: 'PUT', management, body: [OPEN, LIMITED, CHANNEL, ADDED] })
    check('management write (PUT api-keys)', put.status === 200, `HTTP ${put.status}`)
    await sleep(1500)
    const after = await fs.readFile(path.join(dir, 'config.yaml'), 'utf8')
    check('config.yaml written', after !== before)
    const live = line => new RegExp(`^${line}\\s*:`, 'm')
    for (const key of FORK_TOP_LEVEL) check(`write keeps ${key}`, live(key).test(after), live(key).test(after) ? '' : live(key).test(before) ? 'gone or commented out' : 'not in fixture')
    checks.push(...await surface(base, management, 'written', { expectAdded: true }))

    await proc.stop()
    proc = start(binary, dir, env)
    ready = await waitReady(base, proc)
    if (check('restarts on the written config', ready, ready ? '' : why(proc))) {
      checks.push(...await surface(base, management, 'restarted', { expectAdded: true }))
    }
    return { ok: checks.every(item => item.ok), checks }
  } finally {
    await proc?.stop()
    await fs.rm(dir, { recursive: true, force: true })
  }
}

// realpath: systemd runs it through /opt/crosery-api-console-current (a symlink); import.meta.url is the resolved file
if (process.argv[1] && realpathSync(path.resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  const binary = arg('--binary')
  if (!binary) { console.error('--binary <cli-proxy-api> is required'); process.exit(2) }
  const result = await smoke({ binary: path.resolve(binary), version: arg('--version'), ...(arg('--config') ? { config: path.resolve(arg('--config')) } : {}) })
  console.log(JSON.stringify(result, null, 2))
  if (!result.ok) process.exitCode = 1
}
