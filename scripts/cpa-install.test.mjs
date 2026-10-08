import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { classifyInstall } from './kernel-applier.mjs'

const script = fileURLToPath(new URL('../deploy/kernels/relay/cpa-install-binary.sh', import.meta.url))
const applier = fileURLToPath(new URL('./kernel-applier.mjs', import.meta.url))
const OLD = '8.0.13-patched.0ld0ld00'
const NEW = '8.0.21-patched.6e86e800'
const binary = (version, mark = '') => `#!/bin/sh\n# ${mark}\necho "CLIProxyAPI Version: ${version}, Commit: fixture, BuiltAt: now"\n`

/**
 * The real cpa-install-binary.sh with the real probe hook (kernel-applier.mjs probe) against a fake gateway on
 * 127.0.0.1. Only systemctl, flock and logger are stand-ins. The gateway answers chat completions according to the
 * binary that is "installed" right now: a `BROKEN` mark → 502, `HANG` → never answers.
 */
async function host(t, { live = binary(OLD), budget = 10, gate = '', watch = false } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cpa-install-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const p = name => path.join(dir, name)
  for (const sub of ['bin', 'backups', 'auth', 'data', 'probes']) await fs.mkdir(p(sub))
  await fs.writeFile(p('cli-proxy-api'), live, { mode: 0o755 })
  await fs.writeFile(p('config.yaml'), 'port: 8317\n')
  await fs.writeFile(p('auth/claude.json'), JSON.stringify({ type: 'claude' }))
  await fs.writeFile(p('auth/codex.json'), JSON.stringify({ type: 'codex' }))
  await fs.writeFile(p('watched.json'), '{"token":"a"}')
  await fs.writeFile(p('data/system-keys.json'), JSON.stringify({ version: 1, probes: { claude: `sk-probe-claude-${'0'.repeat(64)}` } }))
  const executable = (name, body) => fs.writeFile(p(`bin/${name}`), `#!/bin/bash\n${body}`, { mode: 0o755 })
  // `show -p TimeoutStopUSec`: what the drop-in sets, unless FAKE_STOP_TIMEOUT says otherwise
  await executable('systemctl', `echo "$*" >> "${p('systemctl.log')}"; [ "$1" = is-active ] && echo active
    [ "$1" = show ] && echo "TimeoutStopUSec=\${FAKE_STOP_TIMEOUT-5s}"; exit 0\n`)
  await executable('flock', 'exit 0\n')
  await executable('logger', 'exit 0\n')
  // console gate stand-in: baseline passes; after the swap it fails (and may touch config.yaml, like a migration)
  const after = {
    migrate: `echo 'config-version: 8' >> "${p('config.yaml')}"; exit 1`,
    'refresh-watched': `echo '{"token":"b"}' > "${p('watched.json')}"; exit 1`,
    'fail-new': `grep -q 6e86e800 "${p('cli-proxy-api')}" && exit 1; exit 0`,
  }[gate] ?? 'exit 0'
  await executable('gate', `case "$*" in *--baseline*) ${after};; *) exit 0;; esac\n`)
  const server = http.createServer(async (req, res) => {
    const installed = await fs.readFile(p('cli-proxy-api'), 'utf8')
    if (req.url === '/v1/models') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data: [{ id: 'm1' }] })); return }
    if (installed.includes('HANG')) return
    if (installed.includes('BROKEN')) { res.writeHead(502); res.end(JSON.stringify({ error: { message: 'bad gateway' } })); return }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const base = `http://127.0.0.1:${server.address().port}`
  const env = {
    ...process.env, PATH: `${p('bin')}:${process.env.PATH}`, CPA_INSTALL_ENV: p('none.env'),
    CPA_BINARY: p('cli-proxy-api'), CPA_SERVICE: 'cli-proxy-api-fixture', CPA_BACKUP_DIR: p('backups'), CPA_INSTALL_LOCK: p('install.lock'),
    CPA_CONFIG: p('config.yaml'), CPA_HOLD_FILE: p('hold'), CPA_CONSOLE_GATE: p('bin/gate'), CPA_READY_URL: `${base}/v1/models`,
    CPA_VERIFY_BUDGET: String(budget), CPA_RESTORE_VERIFY_BUDGET: '10', CPA_BASELINE_BUDGET: '20', ...(watch ? { CPA_WATCH_FILES: p('watched.json') } : {}),
    // the hook's own settings (kernel-applier.mjs probe)
    KERNEL_DATA_DIR: p('data'), KERNEL_LIB_DIR: p('lib'), CPA_AUTH_DIR: p('auth'), CPA_PROBE_BASE_URL: base, CPA_PROBE_MODELS: 'claude=m1',
  }
  const install = async (candidate, version, { hook = true, extra = {} } = {}) => {
    await fs.writeFile(p('candidate'), candidate, { mode: 0o755 })
    const out = p(`probes/${Date.now()}`)
    await fs.mkdir(out)
    const args = [script, p('candidate'), version, ...(hook ? ['--', process.execPath, applier, 'probe', '--out', out] : [])]
    const started = Date.now()
    const child = spawn('bash', args, { env: { ...env, ...extra } })
    let stdout = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stdout += chunk })
    const code = await new Promise(resolve => child.on('close', resolve))
    const probe = async phase => { try { return JSON.parse(await fs.readFile(path.join(out, `probe-${phase}.json`), 'utf8')) } catch { return null } }
    return { code, stdout, ms: Date.now() - started, ...classifyInstall({ code, stdout }), probe, live: await fs.readFile(p('cli-proxy-api'), 'utf8'),
      systemctl: await fs.readFile(p('systemctl.log'), 'utf8').catch(() => '') }
  }
  return { p, install }
}

test('install: gates and real requests before and after the swap; backup kept; the applier reads the outcome', async t => {
  const h = await host(t)
  const out = await h.install(binary(NEW), NEW)
  assert.equal(out.code, 0, out.stdout)
  assert.equal(out.result, 'applied')
  assert.match(out.live, new RegExp(NEW.replaceAll('.', '\\.')))
  assert.match(out.backup, /cli-proxy-api\.8\.0\.13-patched\.0ld0ld00\./)
  assert.match(await fs.readFile(out.backup, 'utf8'), /0ld0ld00/)
  assert.ok(out.swapAt)
  const [baseline, verify] = [await out.probe('baseline'), await out.probe('verify')]
  assert.deepEqual([baseline.ok, verify.ok], [true, true])
  assert.deepEqual(verify.results.map(item => [item.type, item.ok ?? item.skipped]), [['claude', true], ['codex', 'no-probe-key']], 'a type without a probe key is skipped and recorded')
  assert.match(out.systemctl, /stop cli-proxy-api-fixture\nstart cli-proxy-api-fixture/)
})

test('install: real requests failing after the swap → old binary back within the budget, old one verified', async t => {
  const h = await host(t)
  const out = await h.install(binary(NEW, 'BROKEN'), NEW)
  assert.equal(out.code, 1)
  assert.equal(out.result, 'rolled-back', out.stdout)
  assert.match(out.reason, /真实请求验证没过.*claude ✗ HTTP 502.*；准备回滚到 8\.0\.13/)
  assert.match(out.live, /0ld0ld00/)
  assert.ok(out.restoreSeconds !== null && out.restoreSeconds <= 30, `restored after ${out.restoreSeconds} s`)
  assert.deepEqual([(await out.probe('verify')).ok, (await out.probe('restored')).ok], [false, true])
})

test('install: a gateway that hangs after the swap is cut at the budget and the old binary is back within 30 s', async t => {
  const h = await host(t, { budget: 5 })
  const out = await h.install(binary(NEW, 'HANG'), NEW)
  assert.equal(out.result, 'rolled-back', out.stdout)
  assert.match(out.live, /0ld0ld00/)
  assert.ok(out.restoreSeconds <= 8, `restored after ${out.restoreSeconds} s with a 5 s budget`)
})

test('install: an existing failure blocks before anything is touched (refused, retried later)', async t => {
  const h = await host(t, { live: binary(OLD, 'BROKEN') })
  const out = await h.install(binary(NEW), NEW)
  assert.equal(out.result, 'refused', out.stdout)
  assert.match(out.reason, /真实请求基线没过，线上未改动/)
  assert.match(out.live, /0ld0ld00/)
  assert.doesNotMatch(out.systemctl, /stop/)
  await fs.writeFile(h.p('hold'), '')
  const held = await h.install(binary(NEW), NEW)
  assert.equal(held.result, 'refused')
  assert.match(held.reason, /hold/)
})

test('install: config or a watched credential changed after the swap → no automatic restore, needs a human', async t => {
  const h = await host(t, { gate: 'migrate', budget: 5 })
  const out = await h.install(binary(NEW), NEW)
  assert.equal(out.result, 'rollback-failed', out.stdout)
  assert.match(out.reason, /^严重：配置\/凭据已变更/)
  assert.match(out.live, /6e86e800/, 'the new binary stays: an older one must not start on a migrated config')

  const w = await host(t, { gate: 'refresh-watched', watch: true, budget: 5 })
  const refreshed = await w.install(binary(NEW), NEW, { hook: false })
  assert.equal(refreshed.result, 'rollback-failed', refreshed.stdout)
  assert.match(refreshed.live, /6e86e800/)

  const u = await host(t, { gate: 'fail-new', watch: true, budget: 5 })
  const plain = await u.install(binary(NEW), NEW, { hook: false })
  assert.equal(plain.result, 'rolled-back', `unchanged watched file: the restore goes ahead\n${plain.stdout}`)
  assert.match(plain.reason, /管理API\/Console或兼容门禁回归/)
  assert.match(plain.live, /0ld0ld00/)
})

test('install: same version is up to date; old backups are pruned to CPA_KEEP_BACKUPS', async t => {
  const h = await host(t)
  const same = await h.install(binary(OLD), OLD)
  assert.deepEqual([same.code, same.result], [0, 'up-to-date'])
  for (let i = 0; i < 6; i += 1) {
    const file = h.p(`backups/cli-proxy-api.old.2026010${i}T000000.${i}`)
    await fs.writeFile(file, 'x')
    await fs.mkdir(`${file}.state`)
    await fs.utimes(file, 1_700_000_000 + i, 1_700_000_000 + i)
  }
  const out = await h.install(binary(NEW), NEW, { hook: false })
  assert.equal(out.result, 'applied', out.stdout)
  const left = (await fs.readdir(h.p('backups'))).sort()
  assert.equal(left.filter(name => !name.endsWith('.state')).length, 5)
  assert.equal(left.filter(name => name.endsWith('.state')).length, 5, 'each kept binary keeps its snapshot')
  assert.ok(left.includes(path.basename(out.backup)))
})

test('install: a stop timeout over 10 s (the systemd default is 90 s) is refused before anything is touched', async t => {
  const h = await host(t)
  for (const value of ['1min 30s', '11s', 'infinity', '']) {
    const out = await h.install(binary(NEW), NEW, { extra: { FAKE_STOP_TIMEOUT: value } })
    assert.equal(out.result, 'refused', `${value}: ${out.stdout}`)
    assert.match(out.reason, /停止超时.*10-stop-timeout\.conf.*线上未改动/)
    assert.match(out.live, /0ld0ld00/)
    assert.doesNotMatch(out.systemctl, /stop cli-proxy-api-fixture/)
  }
  for (const value of ['10s', '500ms', '5s 500ms']) {
    const out = await h.install(binary(NEW, value), NEW, { extra: { FAKE_STOP_TIMEOUT: value } })
    assert.equal(out.result, 'applied', `${value}: ${out.stdout}`)
    await fs.writeFile(h.p('cli-proxy-api'), binary(OLD), { mode: 0o755 })
  }
})
