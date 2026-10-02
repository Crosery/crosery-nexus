#!/usr/bin/env node
/**
 * Safe auto-update of the console's Magpie kernel (the owner's「安全自动更新」).
 *
 *   node scripts/magpie-autoupdate.mjs status                  config + state + what `auto` would do now (read-only)
 *   node scripts/magpie-autoupdate.mjs rehearse [--candidate <sha40>] [--fast]
 *                                                              full rehearsal of the checked candidate; never installs
 *   node scripts/magpie-autoupdate.mjs auto [--dry-run]        what launchd runs after `magpie-upstream.mjs check`
 *   node scripts/magpie-autoupdate.mjs rollback --confirm      restore the last auto-update backup and restart
 *
 * A new upstream candidate is rehearsed (fresh candidate checkout + this repo's kernel overlay → build-magpie-kernel.mjs
 * --candidate --test: contract verify, catalog drift, go vet/test; then a standalone kernel smoke) and classified
 * (magpie-autoupdate-policy.mjs). Only an eligible candidate is applied, only inside the quiet window, never during an
 * active sign-in, at most once per revision: backup binary + kernel HOME → atomic install → launchctl kickstart -k →
 * kernel/gateway/console health within 60 s → otherwise restore both and restart. The restart ends the console
 * process, so `auto` must run in launchd's job process (magpie-upstream.mjs scheduled), never inside the console.
 */
import fs from 'node:fs/promises'
import { createReadStream, createWriteStream } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { request } from 'node:http'
import { fileURLToPath } from 'node:url'
import { candidateCheckout, compareContracts, nextAttemptDelay, upstreamRuntime, withUpstreamLock } from './magpie-upstream.mjs'
import { settingsDrift } from './magpie-settings.mjs'
import { classifyCandidate, normalizeConfig, windowState } from './magpie-autoupdate-policy.mjs'
import { REQUIRED_CAPABILITIES, smokeKernel, socketJSON } from './magpie-kernel-smoke.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const SERVICE_LABEL = 'com.crosery.console-magpie'
const SHA = /^[a-f0-9]{40}$/
const HEALTH_DEADLINE_MS = 60_000
const BUILD_TIMEOUT_MS = 25 * 60_000
const KEEP_BACKUPS = 3

export function autoPaths(runtime = upstreamRuntime, consoleRuntime = path.resolve(process.env.MAGPIE_CONSOLE_RUNTIME || path.join(os.homedir(), '.agents/crosery/magpie-console'))) {
  return {
    runtime, consoleRuntime,
    config: path.join(runtime, 'autoupdate.json'),
    state: path.join(runtime, 'autoupdate-magpie.json'),
    lease: path.join(runtime, 'signin-active.json'),
    status: path.join(runtime, 'status.json'),
    stage: path.join(runtime, 'autoupdate'),
    manifest: path.join(consoleRuntime, 'console-manifest.json'),
    binary: path.join(consoleRuntime, 'bin/magpie-kernel'),
    home: path.join(consoleRuntime, 'home'),
    backups: path.join(consoleRuntime, 'autoupdate-backups'),
  }
}

const json = value => `${JSON.stringify(value, null, 2)}\n`
const iso = ms => new Date(ms).toISOString()
const short = revision => (typeof revision === 'string' ? revision.slice(0, 7) : null)

export async function readJSON(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')) } catch { return null }
}

export async function writeAtomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  await fs.writeFile(temporary, typeof value === 'string' ? value : json(value), { flag: 'wx', mode: 0o600 })
  try { await fs.rename(temporary, file) } finally { await fs.rm(temporary, { force: true }) }
}

export async function sha256File(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

const exists = async file => { try { await fs.access(file); return true } catch { return false } }

export function emptyState() {
  return { version: 1, candidate: null, release: null, result: null, why: null, reasons: [], rehearsal: null, attempts: {},
    applied: null, lastApply: null, failures: 0, nextAttemptAt: null, checkedAt: null }
}

export async function readState(file) {
  const raw = await readJSON(file)
  if (!raw || raw.version !== 1) return emptyState()
  return { ...emptyState(), ...raw, attempts: raw.attempts && typeof raw.attempts === 'object' ? raw.attempts : {} }
}

/** Inputs of a rehearsal verdict besides the candidate: change any of them (fix the overlay, bump the pin) and it is re-rehearsed. */
export async function rehearsalFingerprint() {
  const hash = createHash('sha256')
  const kernel = path.join(root, 'deploy/magpie/kernel')
  const files = [
    ...(await fs.readdir(kernel)).filter(name => name.endsWith('.go')).sort().map(name => path.join(kernel, name)),
    ...['scripts/build-magpie-kernel.mjs', 'scripts/magpie-autoupdate-policy.mjs', 'scripts/magpie-kernel-smoke.mjs', 'scripts/magpie-catalog.mjs',
      'scripts/magpie-settings.mjs', 'deploy/magpie/upstream/api.json', 'deploy/magpie/catalog.json'].map(name => path.join(root, name)),
  ]
  for (const file of files) hash.update(path.relative(root, file)).update('\0').update(await fs.readFile(file)).update('\0')
  return hash.digest('hex').slice(0, 16)
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true } catch (error) { return error.code === 'EPERM' }
}

/** The console writes the lease while a sign-in is live (accountsRoutes.ts); a lease of a dead console is ignored. */
export async function signinActive(file, now = Date.now()) {
  const lease = await readJSON(file)
  if (!lease || !(Number(lease.live) > 0)) return false
  const until = Date.parse(lease.until || '')
  if (!Number.isFinite(until) || until <= now) return false
  return !(Number.isInteger(lease.pid) && lease.pid > 0 && !processAlive(lease.pid))
}

async function readManifest(paths) {
  const manifest = await readJSON(paths.manifest)
  if (!manifest || typeof manifest.socket !== 'string' || !Number.isInteger(manifest.gatewayPort) || !Number.isInteger(manifest.consolePort)) return null
  return manifest
}

export async function runningRevision(paths) {
  const manifest = await readManifest(paths)
  if (!manifest) return null
  try {
    const health = await socketJSON(manifest.socket, '/internal/health', { timeoutMs: 3_000 })
    return health.status === 200 && SHA.test(health.body?.revision) ? health.body.revision : null
  } catch {
    return null
  }
}

/* ── decision (pure) ─────────────────────────────────────────────────── */

/**
 * What `auto` does now. action: none | rehearse | apply | wait. `why` is one word the console renders:
 * disabled · no-local-kernel · no-status · up-to-date · kernel-offline · running-unknown · backoff · held · error ·
 * attempted · window · signin · rehearse · apply.
 */
export function decideMagpie({ now, config, state, status, local, running, baselineRevision, fingerprint, signin }) {
  const window = windowState(now, config.magpie.window)
  const base = { window: window.label, nextWindowAt: iso(window.nextStart), inWindow: window.inside }
  if (!config.magpie.enabled) return { action: 'none', why: 'disabled', ...base }
  if (!local.manifest || !local.binary) return { action: 'none', why: 'no-local-kernel', ...base }
  const candidate = status && SHA.test(status.candidateRevision) ? status.candidateRevision : null
  if (!candidate || status.version !== 1 || status.baselineRevision !== baselineRevision) return { action: 'none', why: 'no-status', ...base }
  const pending = { candidate, release: typeof status.latestRelease === 'string' ? status.latestRelease : null }
  if (status.status === 'unchanged' || candidate === running || candidate === baselineRevision) return { action: 'none', why: 'up-to-date', ...pending, ...base }
  if (!running) return { action: 'none', why: 'kernel-offline', ...pending, ...base }
  if (running !== baselineRevision && running !== state.applied?.revision) return { action: 'none', why: 'running-unknown', ...pending, running, ...base }
  const retryAt = Date.parse(state.nextAttemptAt || '')
  if (Number.isFinite(retryAt) && retryAt > now) return { action: 'none', why: 'backoff', retryAt: state.nextAttemptAt, ...pending, ...base }
  const rehearsal = state.rehearsal
  if (!rehearsal || rehearsal.revision !== candidate || rehearsal.fingerprint !== fingerprint || rehearsal.verdict === 'error') {
    return { action: 'rehearse', why: 'rehearse', ...pending, ...base }
  }
  if (rehearsal.verdict !== 'eligible') return { action: 'none', why: 'held', reasons: rehearsal.reasons, ...pending, ...base }
  if ((state.attempts[candidate] || 0) >= 1) return { action: 'none', why: 'attempted', last: state.lastApply, ...pending, ...base }
  if (!window.inside) return { action: 'wait', why: 'window', ...pending, ...base }
  if (signin) return { action: 'wait', why: 'signin', ...pending, ...base }
  return { action: 'apply', why: 'apply', ...pending, ...base }
}

/* ── rehearsal ───────────────────────────────────────────────────────── */

class StageError extends Error {
  constructor(stage, message) { super(message); this.stage = stage }
}

/** Run a command with stdout+stderr to `log`; resolves { code, tail } (tail = the last lines that say what failed). */
export function runLogged(command, args, { cwd = root, env = process.env, log, timeoutMs = BUILD_TIMEOUT_MS } = {}) {
  return new Promise(resolve => {
    const out = createWriteStream(log, { flags: 'a', mode: 0o600 })
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    const lines = []
    const keep = chunk => {
      out.write(chunk)
      for (const line of String(chunk).split('\n')) if (line.trim()) { lines.push(line.trim()); if (lines.length > 400) lines.shift() }
    }
    child.stdout.on('data', keep)
    child.stderr.on('data', keep)
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs)
    child.once('close', code => {
      clearTimeout(timer)
      out.end()
      // skip Node's stack/report noise: the line worth showing is the thrown message or the go error
      const noise = /^(at |node:|file:\/\/|\^|const err|Node\.js v|status:|signal:|output:|pid:|stdout:|stderr:|[{}[\],]+$|.*\bthrow new\b)/
      const telling = lines.filter(line => !noise.test(line) && /error|fail|panic|cannot|undefined|stale|changed|refus|drift|mismatch|review/i.test(line) && !/^ok\s/.test(line))
      resolve({ code: code ?? 1, tail: (telling.length ? telling : lines).slice(-3) })
    })
    child.once('error', error => { clearTimeout(timer); out.end(); resolve({ code: 1, tail: [error.message] }) })
  })
}

/**
 * Rehearse one candidate. `full` runs every stage even when the contract already holds it (the manual report);
 * `auto` stops at the first holding stage. Infra failures (checkout, module download) throw StageError → retried later.
 */
export async function rehearseCandidate({ revision, full = true, paths = autoPaths(), deps = {} }) {
  const checkout = deps.checkout ?? candidateCheckout
  const build = deps.build ?? defaultBuild
  const smoke = deps.smoke ?? smokeKernel
  const drift = deps.settings ?? (source => settingsDrift(source, path.join(root, 'deploy/magpie/catalog.json')))
  const catalog = deps.catalog ?? defaultCatalogDrift
  const modules = deps.modules ?? defaultModules
  const status = await readJSON(paths.status)
  if (!status || status.candidateRevision !== revision || typeof status.artifact !== 'string' || !/^candidates\/[a-f0-9]{40}-[a-f0-9]{16}$/.test(status.artifact)) {
    throw new StageError('status', 'status.json does not describe this candidate; run the check first')
  }
  const artifacts = path.join(paths.runtime, status.artifact)
  const baseline = JSON.parse(await fs.readFile(path.join(root, 'deploy/magpie/upstream/api.json'), 'utf8'))
  const candidate = JSON.parse(await fs.readFile(path.join(artifacts, 'api.json'), 'utf8'))
  if (candidate.revision !== revision) throw new StageError('status', 'candidate artifacts belong to another revision')
  const fingerprint = await rehearsalFingerprint()
  const stages = []
  const reasons = []
  const timed = async (name, fn) => {
    const started = Date.now()
    try {
      const value = await fn()
      stages.push({ name, ok: true, ms: Date.now() - started })
      return value
    } catch (error) {
      stages.push({ name, ok: false, ms: Date.now() - started, error: String(error?.message || error).slice(0, 300) })
      throw error instanceof StageError ? error : new StageError(name, String(error?.message || error))
    }
  }
  const result = extra => ({
    revision, release: typeof status.latestRelease === 'string' ? status.latestRelease : null, at: iso(Date.now()),
    fingerprint, full, stages, reasons, verdict: reasons.length ? 'held' : 'eligible', binary: null, ...extra,
  })
  return (deps.lock ?? (action => withUpstreamLock(paths.runtime, action)))(async () => {
    const source = await timed('checkout', () => checkout(revision))
    const diff = { ...compareContracts(baseline, candidate), ...await timed('settings', () => drift(source)) }
    const catalogDrift = await timed('catalog', () => catalog(source, path.join(artifacts, 'api.json')))
    reasons.push(...classifyCandidate({ baseline, candidate, diff, catalogDrift }).reasons)
    // one staged build at a time: an older candidate's binary/log is superseded (backups of installed kernels live elsewhere)
    for (const name of await fs.readdir(paths.stage).catch(() => [])) {
      if (/^[a-f0-9]{12}$/.test(name)) await fs.rm(path.join(paths.stage, name), { recursive: true, force: true })
    }
    if (reasons.length && !full) return result()
    const out = path.join(paths.stage, revision.slice(0, 12))
    await fs.mkdir(out, { recursive: true, mode: 0o700 })
    const log = path.join(out, 'build.log')
    await timed('modules', () => modules(source, log))
    // already held for catalog drift (full report only): compile and test the overlay anyway, the verdict stays held
    const allowCatalogDrift = reasons.some(reason => reason.code === 'catalog-drift')
    const built = await timed('build', () => build({ source, artifacts, out, log, allowCatalogDrift }))
    if (built.code !== 0) {
      Object.assign(stages.at(-1), { ok: false, error: `exit ${built.code}` })
      const tidy = line => line.replaceAll(os.homedir(), '~').replace(/^Error: Command failed: \S*node /, '命令失败：').replace(/^Error: /, '')
      reasons.push({ code: 'build', text: `用当前内核接缝构建或测试没过：${tidy(built.tail.at(-1) ?? `退出码 ${built.code}`)}`.slice(0, 220), items: built.tail.map(tidy) })
      return result({ log })
    }
    const binary = path.join(out, 'magpie-kernel')
    const checked = await timed('smoke', () => smoke({ binary, revision, loginAgents: candidate.loginAgents }))
    const failed = checked.checks.filter(item => !item.ok)
    if (failed.length) {
      reasons.push({ code: 'smoke', text: `单独启动的内核冒烟没过：${failed.map(item => item.name).slice(0, 2).join('、')}`, items: failed.map(item => `${item.name}${item.detail ? ` · ${item.detail}` : ''}`) })
    }
    return result({ log, smoke: checked.checks, binary: reasons.length ? null : { path: binary, sha256: await sha256File(binary) } })
  })
}

/** The candidate's account catalog against the committed one; a catalog that cannot be generated is drift too. */
async function defaultCatalogDrift(source, contractFile) {
  try {
    const { extractCatalog, compareCatalogs } = await import('./magpie-catalog.mjs')
    const committed = JSON.parse(await fs.readFile(path.join(root, 'deploy/magpie/catalog.json'), 'utf8'))
    return compareCatalogs(committed, await extractCatalog(source, { contractFile }))
  } catch (error) {
    return { error: error?.message || String(error) }
  }
}

/** Module download is the network part of a build: its failure is an infra error (retried), not a verdict. */
async function defaultModules(source, log) {
  const fetched = await runLogged('go', ['mod', 'download'], { cwd: source, log, timeoutMs: 10 * 60_000 })
  if (fetched.code !== 0) throw new Error(`go mod download: ${fetched.tail.join(' | ')}`)
}

function defaultBuild({ source, artifacts, out, log, allowCatalogDrift = false }) {
  return runLogged(process.execPath, [path.join(root, 'scripts/build-magpie-kernel.mjs'), '--source', source, '--candidate', artifacts, '--out', out, '--test',
    ...(allowCatalogDrift ? ['--allow-catalog-drift'] : [])], { log })
}

/* ── apply / rollback (launchd job process only) ─────────────────────── */

function execFileAsync(command, args, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: timeoutMs }, (error, stdout, stderr) => (error ? reject(new Error(`${path.basename(command)}: ${String(stderr || error.message).trim().slice(0, 200)}`)) : resolve(stdout)))
  })
}

export const kickstart = () => execFileAsync('/bin/launchctl', ['kickstart', '-k', `gui/${process.getuid()}/${SERVICE_LABEL}`])

function httpStatus({ port, route, host }) {
  return new Promise(resolve => {
    const req = request({ host: '127.0.0.1', port, path: route, method: 'GET', headers: { host: host ?? `127.0.0.1:${port}` }, timeout: 4_000, agent: false }, res => {
      const chunks = []
      res.on('data', chunk => { if (chunks.length < 64) chunks.push(chunk) })
      res.once('end', () => {
        let body = null
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { /* not JSON */ }
        resolve({ status: res.statusCode || 0, body })
      })
    })
    req.once('timeout', () => req.destroy(new Error('timeout')))
    req.once('error', () => resolve({ status: 0, body: null }))
    req.end()
  })
}

/** Kernel (socket), gateway (/health on the inference port) and console (/api/session) must all answer for `revision`. */
export async function liveHealth({ manifest, revision, timeoutMs = HEALTH_DEADLINE_MS, intervalMs = 2_000 }) {
  const deadline = Date.now() + timeoutMs
  let last = []
  while (Date.now() < deadline) {
    const checks = []
    try {
      const kernel = await socketJSON(manifest.socket, '/internal/health', { timeoutMs: 3_000 })
      const caps = Array.isArray(kernel.body?.capabilities) ? kernel.body.capabilities : []
      checks.push({ name: 'kernel', ok: kernel.status === 200 && kernel.body?.revision === revision && kernel.body?.keychain === false && REQUIRED_CAPABILITIES.every(c => caps.includes(c)), detail: `HTTP ${kernel.status} ${short(kernel.body?.revision) ?? ''}` })
    } catch (error) {
      checks.push({ name: 'kernel', ok: false, detail: error.message })
    }
    const gateway = await httpStatus({ port: manifest.gatewayPort, route: '/health' })
    checks.push({ name: 'gateway', ok: gateway.status === 200 && gateway.body?.revision === revision, detail: `HTTP ${gateway.status}` })
    const consoleProbe = await httpStatus({ port: manifest.consolePort, route: '/api/session' })
    checks.push({ name: 'console', ok: consoleProbe.status === 200, detail: `HTTP ${consoleProbe.status}` })
    last = checks
    if (checks.every(item => item.ok)) return { ok: true, checks }
    await new Promise(resolve => setTimeout(resolve, intervalMs))
  }
  return { ok: false, checks: last }
}

async function copyTree(from, to) {
  // sockets/FIFOs (a live kernel can leave one under HOME) are not data; skip them
  await fs.cp(from, to, { recursive: true, preserveTimestamps: true, errorOnExist: true, force: false,
    filter: async source => { const stat = await fs.lstat(source); return !stat.isSocket() && !stat.isFIFO() } })
}

async function installBinary(from, target, sha256) {
  const incoming = path.join(path.dirname(target), `.${path.basename(target)}.incoming-${process.pid}`)
  await fs.copyFile(from, incoming)
  try {
    await fs.chmod(incoming, 0o755)
    if (await sha256File(incoming) !== sha256) throw new Error('staged binary changed while copying')
    await fs.rename(incoming, target)
  } finally {
    await fs.rm(incoming, { force: true })
  }
}

async function pruneBackups(directory, keep = KEEP_BACKUPS) {
  const names = (await fs.readdir(directory).catch(() => [])).filter(name => /^\d{4}-\d{2}-\d{2}T/.test(name)).sort()
  for (const name of names.slice(0, Math.max(0, names.length - keep))) await fs.rm(path.join(directory, name), { recursive: true, force: true })
}

export async function restoreBackup({ backup, paths, deps, expectRevision }) {
  const meta = await readJSON(path.join(backup, 'backup.json'))
  if (!meta?.binarySha256) throw new Error('backup has no metadata')
  const stamp = iso(Date.now()).replace(/[:.]/g, '-')
  // the slow copy goes to a staging dir first: the kernel being replaced is still running and writes its HOME by path,
  // so the live HOME is swapped with two renames right before the restart
  const staging = `${paths.home}.restore-${stamp}`
  const withHome = await exists(path.join(backup, 'home'))
  if (withHome) await copyTree(path.join(backup, 'home'), staging)
  await installBinary(path.join(backup, 'magpie-kernel'), paths.binary, meta.binarySha256)
  if (withHome) {
    if (await exists(paths.home)) await fs.rename(paths.home, `${paths.home}.failed-${stamp}`)
    await fs.rename(staging, paths.home)
  }
  await deps.kickstart()
  const manifest = await readManifest(paths)
  return deps.liveHealth({ manifest, revision: expectRevision ?? meta.revision })
}

/** restoreBackup that never throws: a rollback that cannot finish is reported, not lost in an exception. */
async function tryRestore(options) {
  try {
    return await restoreBackup(options)
  } catch (error) {
    return { ok: false, checks: [{ name: 'rollback', ok: false, detail: String(error?.message || error).slice(0, 200) }] }
  }
}

/**
 * Backup → atomic install → restart → health; on failure restore binary + HOME and restart again.
 * Checks that fail before anything is touched throw StageError('preflight'); `onCommit` runs right before the first
 * change (the caller counts the one attempt there). Once the binary is replaced, every failure — a launchctl error
 * included — ends in a restore, never in an exception.
 */
export async function applyCandidate({ revision, rehearsal, previous, paths = autoPaths(), deps = {}, onCommit = async () => {} }) {
  const run = { kickstart: deps.kickstart ?? kickstart, liveHealth: deps.liveHealth ?? liveHealth, now: deps.now ?? Date.now }
  const manifest = await readManifest(paths)
  if (!manifest) throw new StageError('preflight', 'console-manifest.json is missing; not a local Magpie kernel')
  if (!rehearsal?.binary || rehearsal.revision !== revision || rehearsal.verdict !== 'eligible') throw new StageError('preflight', 'no eligible rehearsal for this revision')
  const staged = await sha256File(rehearsal.binary.path).catch(() => null)
  if (staged !== rehearsal.binary.sha256) throw new StageError('preflight', 'the rehearsed binary changed since the rehearsal')
  await onCommit()
  const stamp = iso(run.now()).replace(/[:.]/g, '-')
  const backup = path.join(paths.backups, `${stamp}-${short(previous) ?? 'unknown'}`)
  await fs.mkdir(backup, { recursive: true, mode: 0o700 })
  await fs.copyFile(paths.binary, path.join(backup, 'magpie-kernel'))
  const binarySha256 = await sha256File(path.join(backup, 'magpie-kernel'))
  if (binarySha256 !== await sha256File(paths.binary)) throw new StageError('backup', 'binary backup does not match the running binary')
  if (await exists(paths.home)) await copyTree(paths.home, path.join(backup, 'home'))
  await writeAtomic(path.join(backup, 'backup.json'), { revision: previous, at: iso(run.now()), binarySha256, candidate: revision })
  await installBinary(rehearsal.binary.path, paths.binary, rehearsal.binary.sha256)
  let health
  let restartError = null
  try {
    await run.kickstart()
    health = await run.liveHealth({ manifest, revision })
  } catch (error) {
    restartError = String(error?.message || error).slice(0, 200)
    health = { ok: false, checks: [{ name: 'restart', ok: false, detail: restartError }] }
  }
  if (health.ok) {
    await pruneBackups(paths.backups).catch(() => undefined)
    return { result: 'applied', backup, checks: health.checks }
  }
  const failed = health.checks.filter(item => !item.ok)
  const restored = await tryRestore({ backup, paths, deps: run, expectRevision: previous })
  const text = restartError
    ? `替换后重启没成功：${restartError}`
    : `替换后 ${HEALTH_DEADLINE_MS / 1000} 秒内没通过健康检查：${failed.map(item => `${item.name} ${item.detail}`).join('、')}`
  return {
    result: restored.ok ? 'rolled-back' : 'rollback-failed', backup, checks: health.checks, rollbackChecks: restored.checks,
    reasons: [{ code: restartError ? 'restart' : 'health', text, items: restored.ok ? [] : restored.checks.filter(item => !item.ok).map(item => `回滚 ${item.name} ${item.detail ?? ''}`.trim()) }],
  }
}

/**
 * Manual `rollback --confirm`: only the kernel this job installed (state.applied), and only while it is still the one
 * running (or the kernel is down) — its backup is the HOME of the moment it was installed. The current HOME is kept
 * aside as home.failed-<time>.
 */
export async function rollbackApplied({ paths = autoPaths(), deps = {} } = {}) {
  const lock = deps.lock ?? (action => withUpstreamLock(paths.runtime, action))
  const run = { kickstart: deps.kickstart ?? kickstart, liveHealth: deps.liveHealth ?? liveHealth }
  return lock(async () => {
    const state = await readState(paths.state)
    const applied = state.applied
    if (!applied?.backup || !SHA.test(applied.revision || '')) throw new Error('No auto-applied kernel to roll back (a failed apply is already rolled back)')
    const running = await (deps.runningRevision ?? runningRevision)(paths)
    if (running && running !== applied.revision) {
      throw new Error(`The running kernel ${short(running)} is not the auto-applied ${short(applied.revision)}; refusing to restore an older backup over it`)
    }
    const meta = await readJSON(path.join(applied.backup, 'backup.json'))
    const health = await tryRestore({ backup: applied.backup, paths, deps: run, expectRevision: meta?.revision })
    await writeAtomic(paths.state, {
      ...state, applied: health.ok ? null : applied,
      lastApply: { revision: applied.revision, release: applied.release ?? null, at: iso(Date.now()), result: health.ok ? 'rolled-back-manually' : 'rollback-failed', backup: applied.backup, reasons: [], checks: health.checks },
    })
    return { rollback: health.ok ? 'ok' : 'failed', backup: applied.backup, checks: health.checks }
  })
}

/* ── auto ────────────────────────────────────────────────────────────── */

async function gather(paths, now, deps = {}) {
  const [configRaw, state, status, fingerprint, running, signin, manifestOk, binaryOk] = await Promise.all([
    readJSON(paths.config), readState(paths.state), readJSON(paths.status), rehearsalFingerprint(), (deps.runningRevision ?? runningRevision)(paths),
    signinActive(paths.lease, now), exists(paths.manifest), exists(paths.binary),
  ])
  const baselineRevision = JSON.parse(await fs.readFile(path.join(root, 'deploy/magpie/upstream/api.json'), 'utf8')).revision
  return { config: normalizeConfig(configRaw), state, status, fingerprint, running, signin, local: { manifest: manifestOk, binary: binaryOk }, baselineRevision }
}

export async function runAuto({ dryRun = false, paths = autoPaths(), deps = {} } = {}) {
  const now = (deps.now ?? Date.now)()
  const facts = await gather(paths, now, deps)
  let decision = decideMagpie({ now, ...facts })
  if (dryRun) return { dryRun: true, magpie: decision, running: facts.running, config: facts.config }
  let state = { ...facts.state, checkedAt: iso(now) }
  const save = async patch => { state = { ...state, ...patch }; await writeAtomic(paths.state, state) }
  if (decision.action === 'rehearse') {
    try {
      const rehearsal = await (deps.rehearse ?? rehearseCandidate)({ revision: decision.candidate, full: false, paths })
      await save({ candidate: rehearsal.revision, release: rehearsal.release, rehearsal, failures: 0, nextAttemptAt: null })
    } catch (error) {
      const failures = (Number(state.failures) || 0) + 1
      const delay = Math.max(30 * 60_000, nextAttemptDelay(failures))
      await save({
        candidate: decision.candidate, release: decision.release, result: 'error', why: 'error', failures, nextAttemptAt: iso(now + delay),
        reasons: [{ code: `stage-${error.stage ?? 'unknown'}`, text: `演练在 ${error.stage ?? '未知阶段'} 出错：${String(error.message).slice(0, 160)}`, items: [] }],
        rehearsal: { revision: decision.candidate, verdict: 'error', at: iso(now), fingerprint: facts.fingerprint, stages: [], reasons: [] },
      })
      return { magpie: { action: 'rehearse', why: 'error', error: error.message } }
    }
    decision = decideMagpie({ now: (deps.now ?? Date.now)(), ...facts, state })
  }
  if (decision.action === 'apply') {
    // the upstream lock keeps a check / manual rehearsal from replacing the staged build mid-apply
    const lock = deps.lock ?? (action => withUpstreamLock(paths.runtime, action))
    let outcome
    try {
      outcome = await lock(async () => {
        // the decision above can be a rehearsal old: window, sign-in lease, switch, candidate and rehearsal are
        // decided again from disk, under the lock, right before anything is touched
        const freshNow = (deps.now ?? Date.now)()
        const fresh = await gather(paths, freshNow, deps)
        const recheck = decideMagpie({ now: freshNow, ...fresh })
        if (recheck.action !== 'apply' || recheck.candidate !== decision.candidate) return { recheck }
        state = { ...fresh.state, checkedAt: state.checkedAt }
        const previous = fresh.running
        // counted right before the first change (onCommit): whatever happens next, this revision is not tried again automatically
        const commit = async () => save({ attempts: { ...state.attempts, [recheck.candidate]: (state.attempts[recheck.candidate] || 0) + 1 } })
        try {
          return { previous, ...await (deps.apply ?? applyCandidate)({ revision: recheck.candidate, rehearsal: state.rehearsal, previous, paths, onCommit: commit }) }
        } catch (error) {
          if (error?.stage === 'preflight') return { preflight: error }
          return { previous, result: 'error', reasons: [{ code: `stage-${error?.stage ?? 'apply'}`, text: `替换前停住：${String(error?.message || error).slice(0, 160)}`, items: [] }] }
        }
      })
    } catch (error) {
      // lock busy: nothing was touched and the attempt is not spent; the next round inside the window tries again
      await save({ candidate: decision.candidate, release: decision.release, result: 'eligible', why: 'busy', reasons: [] })
      return { magpie: { action: 'wait', why: 'busy', error: error.message } }
    }
    if (outcome.recheck) return settle(outcome.recheck)
    if (outcome.preflight) {
      // nothing was touched and the attempt is not spent: the staged build is gone or changed, so rehearse again (with backoff)
      const failures = (Number(state.failures) || 0) + 1
      await save({
        result: 'error', why: 'error', failures, nextAttemptAt: iso(now + Math.max(30 * 60_000, nextAttemptDelay(failures))),
        reasons: [{ code: 'stage-preflight', text: `替换前检查没过，下一轮重新演练：${String(outcome.preflight.message).slice(0, 160)}`, items: [] }],
        rehearsal: { ...(state.rehearsal || {}), verdict: 'error' },
      })
      return { magpie: { action: 'apply', why: 'error', error: outcome.preflight.message } }
    }
    const at = iso((deps.now ?? Date.now)())
    const lastApply = { revision: decision.candidate, release: decision.release, at, result: outcome.result, backup: outcome.backup ?? null, reasons: outcome.reasons ?? [], checks: outcome.checks ?? [] }
    const failed = outcome.result !== 'applied'
    const failures = failed ? (Number(state.failures) || 0) + 1 : 0
    await save({
      // an apply that returned without calling onCommit (an injected one) still spends the attempt
      attempts: { ...state.attempts, [decision.candidate]: Math.max(1, state.attempts[decision.candidate] || 0) },
      lastApply, result: outcome.result, why: failed ? 'attempted' : 'applied', reasons: outcome.reasons ?? [],
      ...(outcome.result === 'applied' ? { applied: { revision: decision.candidate, release: decision.release, at, previous: outcome.previous, backup: outcome.backup } } : {}),
      failures, nextAttemptAt: failed ? iso(now + Math.max(30 * 60_000, nextAttemptDelay(failures))) : null,
    })
    return { magpie: { action: 'apply', ...lastApply } }
  }
  return settle(decision)

  async function settle(final) {
    const held = final.why === 'held'
    await save({
      candidate: final.candidate ?? state.candidate, release: final.release ?? state.release,
      result: held ? 'held' : final.action === 'wait' ? 'eligible' : final.why === 'up-to-date' ? 'up-to-date' : state.result,
      why: final.why, reasons: held ? final.reasons : ['backoff', 'attempted'].includes(final.why) ? state.reasons : [],
    })
    return { magpie: final }
  }
}

/** launchd: magpie + rtk, each guarded so one failing never skips the other. */
export async function runScheduled() {
  const paths = autoPaths()
  const config = normalizeConfig(await readJSON(paths.config))
  const magpie = await runAuto({ paths }).catch(error => ({ error: error.message }))
  let rtk = { action: 'none', why: 'disabled' }
  if (config.rtk.enabled) {
    const { runRtkAuto } = await import('./rtk-autoupdate.mjs')
    rtk = await runRtkAuto().catch(error => ({ error: error.message }))
  }
  return { magpie, rtk }
}

async function main() {
  const action = process.argv[2]
  const arg = name => { const at = process.argv.indexOf(name); return at < 0 ? undefined : process.argv[at + 1] }
  const paths = autoPaths()
  if (action === 'status') {
    const now = Date.now()
    const facts = await gather(paths, now)
    console.log(json({ config: facts.config, running: facts.running, state: facts.state, decision: decideMagpie({ now, ...facts }) }))
  } else if (action === 'auto') {
    console.log(json(await runAuto({ dryRun: process.argv.includes('--dry-run'), paths })))
  } else if (action === 'rehearse') {
    const status = await readJSON(paths.status)
    const revision = arg('--candidate') || status?.candidateRevision
    if (!SHA.test(revision || '')) throw new Error('No candidate: run `node scripts/magpie-upstream.mjs check` first or pass --candidate <sha40>')
    const rehearsal = await rehearseCandidate({ revision, full: !process.argv.includes('--fast'), paths })
    const state = await readState(paths.state)
    await writeAtomic(paths.state, { ...state, candidate: revision, release: rehearsal.release, rehearsal, result: rehearsal.verdict === 'eligible' ? 'eligible' : 'held', why: rehearsal.verdict === 'eligible' ? 'window' : 'held', reasons: rehearsal.reasons, checkedAt: rehearsal.at })
    console.log(json(rehearsal))
  } else if (action === 'rollback') {
    if (!process.argv.includes('--confirm')) throw new Error('rollback restarts the console and the kernel; pass --confirm')
    const outcome = await rollbackApplied({ paths })
    console.log(json(outcome))
    if (outcome.rollback !== 'ok') process.exitCode = 1
  } else {
    throw new Error('Use status, rehearse [--candidate <sha40>] [--fast], auto [--dry-run], or rollback --confirm')
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}
