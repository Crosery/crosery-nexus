// e2e：cradmin proxy 在一次性控制台实例（子进程 + 临时数据 + 假 CPA）上跑每个子命令。
// mihomo 用 server/testing/fakeMihomoRelay.ts 写出的假内核；检测只打到关闭的本机端口，不连任何外部服务，也不连 8791。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { after, before, test } from 'node:test'
import { main } from './cradmin.mjs'
import { adminCall, freePort, startThrowawayServer } from './helpers/throwawayServer.mjs'
import { RELAY_MIHOMO_SOURCE } from '../server/testing/fakeMihomoRelay.ts'

const PASSWORD = 'cradmin-proxy-e2e-pass-3c1d'
const SECRETS = ['url-secret-pw-71', 'ss-node-secret-82', 'sock-user-secret-93', PASSWORD]
let server
let home
let cwd
let deadPort
const outputs = []

const sink = () => {
  const chunks = []
  return { isTTY: false, columns: 0, write: chunk => { chunks.push(String(chunk)); return true }, text: () => chunks.join('') }
}

async function cli(argv, { stdin = '' } = {}) {
  const stdout = sink()
  const stderr = sink()
  const code = await main(argv, {
    env: {
      PATH: process.env.PATH, CONSOLE_PASSWORD: PASSWORD, CRADMIN_SESSION_CACHE: 'off', CRADMIN_KEYCHAIN: 'off',
      CRADMIN_BASE: server.base, CRADMIN_HOME: home, NO_COLOR: '1',
    },
    stdin: Readable.from(stdin ? [stdin] : []), stdout, stderr, interactive: false, cwd, home, installSignals: false, pollMs: 50, platform: 'linux',
  })
  const result = { argv, code, stdout: stdout.text(), stderr: stderr.text() }
  outputs.push(result)
  return result
}

async function freeRange(count) {
  for (let base = 46_000 + Math.floor(Math.random() * 6_000); base < 60_000; base += count + 9) {
    let free = true
    for (let port = base; port < base + count && free; port++) {
      free = await new Promise((resolve) => {
        const probe = net.createServer()
        probe.once('error', () => resolve(false))
        probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)))
      })
    }
    if (free) return base
  }
  throw new Error('no free port range')
}

const pool = async () => (await adminCall(server, 'GET', '/api/proxies')).body
const accounts = async () => (await adminCall(server, 'GET', '/api/proxies/accounts')).body.accounts
const entryNamed = async name => (await pool()).entries.find(entry => entry.name === name)

before(async () => {
  deadPort = await freePort()
  const portBase = await freeRange(10)
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'cradmin-proxy-home-'))
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cradmin-proxy-cwd-'))
  const bin = path.join(home, 'fake-mihomo-relay.mjs')
  fs.writeFileSync(bin, RELAY_MIHOMO_SOURCE, { mode: 0o755 })
  server = await startThrowawayServer({
    password: PASSWORD,
    env: { PROXY_PORT_BASE: String(portBase), PROXY_PORT_COUNT: '10', MIHOMO_BIN: bin, PROXY_LISTENER_AUTH: 'on', PROXY_KERNEL_KEEPALIVE: '0' },
    prepare: ({ cpa }) => cpa.credentials.set('codex-proxy.json', {
      name: 'codex-proxy.json', type: 'codex', email: 'proxy.fixture@example.test', proxy_url: 'http://legacy:url-secret-pw-71@198.51.100.50:8080',
    }),
  })
})

after(async () => {
  // the managed kernel is detached; KEEPALIVE=0 makes the console stop it, and this is the safety net
  let kernelPid = null
  try { kernelPid = JSON.parse(fs.readFileSync(path.join(server.dataDir, 'proxy', 'mihomo', 'mihomo.pid'), 'utf8')).pid } catch { /* never started */ }
  await server?.stop()
  if (kernelPid) {
    await new Promise(resolve => setTimeout(resolve, 300))
    try { process.kill(kernelPid, 0); process.kill(kernelPid, 'SIGKILL') } catch { /* already gone */ }
  }
  for (const dir of [home, cwd]) if (dir) fs.rmSync(dir, { recursive: true, force: true })
})

test('ls on an empty pool; import --dry-run parses but writes nothing; import from a file and from stdin', async () => {
  const empty = await cli(['proxy', 'ls', '--json'])
  assert.equal(empty.code, 0, empty.stderr)
  assert.deepEqual(JSON.parse(empty.stdout).entries, [])

  const yaml = [
    'proxies:',
    `  - {name: 本机死端口, type: socks5, server: 127.0.0.1, port: ${deadPort}}`,
    '  - {name: 远端 HTTP, type: http, server: 198.51.100.7, port: 3128, username: u1, password: "url-secret-pw-71"}',
    '  - {name: 东京 SS, type: ss, server: jp.node.example, port: 8388, cipher: aes-128-gcm, password: "ss-node-secret-82"}',
    '  - {name: 旧 snell, type: snell, server: s.example, port: 1, psk: x}',
    '',
  ].join('\n')
  fs.writeFileSync(path.join(cwd, 'clash.yaml'), yaml)
  const dry = await cli(['proxy', 'import', 'clash.yaml', '--dry-run'])
  assert.equal(dry.code, 0, dry.stderr)
  assert.match(dry.stdout, /导入预览/)
  assert.match(dry.stdout, /POST \/api\/proxies\/import/)
  assert.equal((await pool()).entries.length, 0, 'dry-run imports nothing')

  const imported = await cli(['proxy', 'import', 'clash.yaml', '--tags', 'e2e'])
  assert.equal(imported.code, 0, imported.stderr)
  assert.match(imported.stdout, /跳过 旧 snell/)
  assert.match(imported.stdout, /新增 3/)
  const after = await pool()
  assert.deepEqual(after.entries.map(entry => entry.name).sort(), ['东京 SS', '本机死端口', '远端 HTTP'].sort())
  assert.ok(after.entries.every(entry => entry.tags.includes('e2e')))

  const fromStdin = await cli(['proxy', 'import', '-'], { stdin: 'socks5://sock-user:sock-user-secret-93@203.0.113.30:1080\n' })
  assert.equal(fromStdin.code, 0, fromStdin.stderr)
  assert.ok(await entryNamed('203.0.113.30'))
})

test('ls shows the table and kernel; kernel runs the encrypted node on a managed port (fake relay binary)', async () => {
  const ls = await cli(['proxy', 'ls'])
  assert.equal(ls.code, 0, ls.stderr)
  assert.match(ls.stdout, /东京 SS/)
  assert.match(ls.stdout, /外部本机/)
  assert.match(ls.stdout, /内核/)
  const tagged = await cli(['proxy', 'ls', '--tag', 'e2e', '--json'])
  assert.equal(JSON.parse(tagged.stdout).entries.length, 3)
  let status
  for (let i = 0; i < 60; i++) {
    status = JSON.parse((await cli(['proxy', 'kernel', 'status', '--json'])).stdout)
    if (status.kernel.state === 'running') break
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.equal(status.kernel.state, 'running', JSON.stringify(status.kernel))
})

test('test <entry> reports the failure as data; test --in-use starts the job, a second run is in cooldown (exit 4)', async () => {
  const one = await cli(['proxy', 'test', '本机死端口'])
  assert.equal(one.code, 0, one.stderr)
  assert.match(one.stdout, /代理不可达/)
  const started = await cli(['proxy', 'test', '--in-use'])
  assert.equal(started.code, 0, started.stderr)
  const cooling = await cli(['proxy', 'test', '--all'])
  assert.equal(cooling.code, 4, cooling.stderr)
  const ambiguous = await cli(['proxy', 'test', '1'])
  assert.equal(ambiguous.code, 2)
  const missing = await cli(['proxy', 'test'])
  assert.equal(missing.code, 2)
})

test('assign needs --yes non-interactively (zero writes); assign → unassign --restore puts the old exit back', async () => {
  const target = await entryNamed('远端 HTTP')
  const refused = await cli(['proxy', 'assign', 'codex-proxy', target.id])
  assert.equal(refused.code, 2)
  assert.equal((await accounts()).find(row => row.name === 'codex-proxy.json').entryId, null)

  const done = await cli(['proxy', 'assign', 'proxy.fixture', '远端 HTTP', '--yes'])
  assert.equal(done.code, 0, done.stderr)
  const row = (await accounts()).find(item => item.name === 'codex-proxy.json')
  assert.equal(row.entryId, target.id)
  assert.equal(row.restorable, true)
  const again = await cli(['proxy', 'assign', 'codex-proxy', target.id, '--yes'])
  assert.equal(again.code, 0)
  assert.match(again.stdout, /已经在用这个出口/)

  const inUse = await cli(['proxy', 'rm', '远端 HTTP', '--yes'])
  assert.equal(inUse.code, 2)
  assert.match(inUse.stderr, /还有 1 个账号在用/)

  const restored = await cli(['proxy', 'unassign', 'codex-proxy', '--restore', '--yes'])
  assert.equal(restored.code, 0, restored.stderr)
  const back = (await accounts()).find(item => item.name === 'codex-proxy.json')
  assert.equal(back.mode, 'url')
  assert.equal(back.masked, 'http://***@198.51.100.50:8080')
})

test('migrate --dry-run lists the account exits without writing; migrate --yes imports them; a re-run has nothing to do', async () => {
  const before = (await pool()).entries.length
  const dry = await cli(['proxy', 'migrate', '--dry-run'])
  assert.equal(dry.code, 0, dry.stderr)
  assert.match(dry.stdout, /198\.51\.100\.50:8080/)
  assert.match(dry.stdout, /新建/)
  assert.equal((await pool()).entries.length, before)
  const applied = await cli(['proxy', 'migrate', '--yes'])
  assert.equal(applied.code, 0, applied.stderr)
  assert.equal((await pool()).entries.length, before + 1)
  const again = await cli(['proxy', 'migrate', '--yes'])
  assert.equal(again.code, 0)
  assert.match(again.stdout, /代理池已包含这些出口/)
})

test('default writes the CPA global proxy (an entry, then direct clears it); rm with --reassign; subscriptions ls', async () => {
  const target = await entryNamed('远端 HTTP')
  const def = await cli(['proxy', 'default', '远端 HTTP', '--yes'])
  assert.equal(def.code, 0, def.stderr)
  assert.equal((await pool()).default.entryId, target.id)
  assert.notEqual(server.cpa.globalProxy, '')
  const direct = await cli(['proxy', 'default', 'direct', '--yes'])
  assert.equal(direct.code, 0, direct.stderr)
  assert.equal(server.cpa.globalProxy, '')
  const victim = await entryNamed('203.0.113.30')
  assert.equal((await cli(['proxy', 'assign', 'codex-proxy', victim.id, '--yes'])).code, 0)
  const removed = await cli(['proxy', 'rm', victim.id, '--reassign', 'direct', '--yes'])
  assert.equal(removed.code, 0, removed.stderr)
  assert.equal(await entryNamed('203.0.113.30'), undefined)
  assert.equal((await accounts()).find(item => item.name === 'codex-proxy.json').mode, 'direct')
  const subs = await cli(['proxy', 'subscriptions'])
  assert.equal(subs.code, 0)
  assert.match(subs.stdout, /没有订阅/)
})

test('export: masked to stdout; --with-secrets writes 0600, never overwrites without --force, prints only path and counts', async () => {
  const masked = await cli(['proxy', 'export'])
  assert.equal(masked.code, 0, masked.stderr)
  const file = JSON.parse(masked.stdout)
  assert.equal(file.format, 'crosery-proxy-pool')
  assert.ok(file.entries.length >= 3)

  const noYes = await cli(['proxy', 'export', '--with-secrets', '--out', 'pool.secret.json'])
  assert.equal(noYes.code, 2)
  assert.equal(fs.existsSync(path.join(cwd, 'pool.secret.json')), false)

  const out = path.join(cwd, 'pool.secret.json')
  const written = await cli(['proxy', 'export', '--with-secrets', '--out', 'pool.secret.json', '--yes'])
  assert.equal(written.code, 0, written.stderr)
  assert.match(written.stdout, /已写入 .*pool\.secret\.json · \d+ 个出口/)
  assert.equal(fs.statSync(out).mode & 0o777, 0o600)
  const text = fs.readFileSync(out, 'utf8')
  assert.ok(text.includes('ss-node-secret-82'), 'the secret export carries the node password')

  fs.writeFileSync(out, 'keep me')
  const clash = await cli(['proxy', 'export', '--with-secrets', '--out', 'pool.secret.json', '--yes'])
  assert.equal(clash.code, 2)
  assert.equal(fs.readFileSync(out, 'utf8'), 'keep me')
  const forced = await cli(['proxy', 'export', '--with-secrets', '--out', 'pool.secret.json', '--yes', '--force'])
  assert.equal(forced.code, 0)
  assert.equal(fs.statSync(out).mode & 0o777, 0o600)

  // round trip: the secret file re-imports into the same pool as "already there"
  const reimport = await cli(['proxy', 'import', 'pool.secret.json', '--dry-run'])
  assert.equal(reimport.code, 0, reimport.stderr)
  assert.match(reimport.stdout, /代理池导出文件/)
  assert.match(reimport.stdout, /已存在 \d+/)
})

test('migration file: assignments in a secret export come back on import (pending → assign with --yes; without it only a note)', async () => {
  const target = await entryNamed('远端 HTTP')
  assert.equal((await cli(['proxy', 'assign', 'codex-proxy', target.id, '--yes'])).code, 0)
  assert.equal((await cli(['proxy', 'export', '--with-secrets', '--out', 'move.json', '--yes'])).code, 0)
  assert.equal((await cli(['proxy', 'unassign', 'codex-proxy', '--yes'])).code, 0)
  assert.equal((await accounts()).find(item => item.name === 'codex-proxy.json').mode, 'inherit')

  const noted = await cli(['proxy', 'import', 'move.json'])
  assert.equal(noted.code, 0, noted.stderr)
  assert.match(noted.stdout, /1 个账号的分配还没恢复/)
  assert.equal((await accounts()).find(item => item.name === 'codex-proxy.json').mode, 'inherit')

  const restored = await cli(['proxy', 'import', 'move.json', '--yes', '--json'])
  assert.equal(restored.code, 0, restored.stderr)
  assert.equal(JSON.parse(restored.stdout).assignments.applied, 1)
  assert.equal((await accounts()).find(item => item.name === 'codex-proxy.json').entryId, target.id)
})

test('output scan: no proxy password, node secret or admin password in any stdout / stderr (incl. --json)', () => {
  for (const item of outputs) {
    for (const secret of SECRETS) {
      assert.equal(item.stdout.includes(secret) || item.stderr.includes(secret), false, `${item.argv.join(' ')} leaked ${secret.slice(0, 6)}…`)
    }
  }
})
