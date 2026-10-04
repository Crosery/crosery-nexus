#!/usr/bin/env node
/**
 * Relay gateway-kernel applier (root, systemd): the production half of「网关内核自动更新」for CPA (serving traffic)
 * and Magpie (standby, serves nothing).
 *
 *   node scripts/kernel-applier.mjs status                     config + state + what `auto` would do now (read-only)
 *   node scripts/kernel-applier.mjs auto [--dry-run]           crosery-kernel-update.service (timer, path unit, gates)
 *   node scripts/kernel-applier.mjs rollback --kernel cpa|magpie --confirm
 *
 * Builders never install. The CPA builder (ibuki-wsl-crosery ~/cpa-pipeline: upstream tag + our patches, go test, smoke)
 * and the Magpie builder (the owner's Mac, after its own rehearsal) drop a binary + report through their forced-command
 * gates into <lib>/<kernel>/inbox. `auto` runs the console's queued requests, verifies the drops, records what the
 * builders said, then installs:
 * - CPA (kept at upstream's latest release, majors included) only inside the quiet window, once per version, never
 *   while the hold file is set, and only through /usr/local/sbin/cpa-install-binary.sh — its console/AGY gates,
 *   backup and config-aware rollback stay the one install transaction;
 * - Magpie into a new release dir, boots it once in the console's sandbox, checks /internal/health, then flips `current`.
 * The console writes only <data>/kernel-autoupdate.json and <data>/kernel-requests/*.json, and reads
 * <data>/kernels/<kernel>.json, which only this job writes.
 */
import fs from 'node:fs/promises'
import { createReadStream, realpathSync } from 'node:fs'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import { request } from 'node:http'
import { fileURLToPath } from 'node:url'

export const DEFAULT_WINDOW = Object.freeze({ start: '05:00', end: '07:00', tz: 'Asia/Shanghai' })
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/
const SHA40 = /^[a-f0-9]{40}$/
const SHA256 = /^[a-f0-9]{64}$/
const CPA_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/
const TAG = /^v\d+\.\d+\.\d+$/
const KEEP_STAGED = 2
const KEEP_MAGPIE = 3
const RETRY_MS = 30 * 60_000
const DAY_GAP_MS = 20 * 3_600_000
const MAX_REPORT_BYTES = 64 * 1024

export function applierPaths(env = process.env) {
  const data = path.resolve(env.KERNEL_DATA_DIR || '/opt/crosery-api-console/data')
  const lib = path.resolve(env.KERNEL_LIB_DIR || '/var/lib/crosery-kernels')
  return {
    data, lib,
    config: path.join(data, 'kernel-autoupdate.json'),
    states: path.join(data, 'kernels'),
    requests: path.join(data, 'kernel-requests'),
    lock: path.join(lib, 'applier.lock'),
    cpa: {
      inbox: path.join(lib, 'cpa/inbox'), staged: path.join(lib, 'cpa/staged'),
      binary: env.CPA_BINARY || '/usr/local/bin/cli-proxy-api',
      install: env.CPA_INSTALL || '/usr/local/sbin/cpa-install-binary.sh',
      hold: env.CPA_HOLD_FILE || '/etc/cli-proxy-api/auto-update.hold',
      config: env.CPA_CONFIG || '/etc/cli-proxy-api/config.yaml',
      service: env.CPA_SERVICE || 'cli-proxy-api',
    },
    magpie: {
      inbox: path.join(lib, 'magpie/inbox'),
      root: path.resolve(env.MAGPIE_STANDBY_DIR || '/opt/crosery-magpie-kernel'),
      smoke: path.join(lib, 'magpie/smoke'),
    },
  }
}

const json = value => `${JSON.stringify(value, null, 2)}\n`
const iso = ms => new Date(ms).toISOString()
const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const exists = async file => { try { await fs.access(file); return true } catch { return false } }

export async function readJSON(file, maxBytes = MAX_REPORT_BYTES * 4) {
  try {
    const stat = await fs.lstat(file)
    if (!stat.isFile() || stat.size > maxBytes) return null
    const value = JSON.parse(await fs.readFile(file, 'utf8'))
    return isObject(value) ? value : null
  } catch {
    return null
  }
}

export async function writeAtomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  await fs.writeFile(temporary, json(value), { flag: 'wx', mode: 0o600 })
  try { await fs.rename(temporary, file) } finally { await fs.rm(temporary, { force: true }) }
}

export async function sha256File(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

/* ── config (written by the console) ─────────────────────────────────── */

function validZone(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true } catch { return false }
}

export function parseWindow(value) {
  if (!isObject(value)) return null
  const start = String(value.start ?? '')
  const end = String(value.end ?? '')
  const tz = value.tz === undefined ? DEFAULT_WINDOW.tz : String(value.tz)
  if (!HHMM.test(start) || !HHMM.test(end) || start === end || !validZone(tz)) return null
  return { start, end, tz }
}

/** Missing file or field = ON (the same default as the Mac's Magpie auto-update); the window is in its own time zone. */
export function normalizeConfig(raw) {
  const value = isObject(raw) ? raw : {}
  return {
    version: 1,
    cpa: { enabled: value.cpa?.enabled !== false },
    magpie: { enabled: value.magpie?.enabled !== false },
    window: parseWindow(value.window) ?? { ...DEFAULT_WINDOW },
    ...(typeof value.updatedAt === 'string' ? { updatedAt: value.updatedAt } : {}),
  }
}

/* ── quiet window ───────────────────────────────────────────────────── */

const minutesOf = text => { const [, h, m] = HHMM.exec(text); return Number(h) * 60 + Number(m) }

function zonedMinute(now, tz) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(now)).map(part => [part.type, part.value]))
  return Number(parts.hour) * 60 + Number(parts.minute)
}

/** Wall-clock window in `window.tz`; `end` before `start` wraps past midnight. */
export function windowState(now, window = DEFAULT_WINDOW) {
  const minute = zonedMinute(now, window.tz)
  const start = minutesOf(window.start)
  const end = minutesOf(window.end)
  const inside = start < end ? minute >= start && minute < end : minute >= start || minute < end
  const ahead = (start - minute + 1440) % 1440 || 1440
  const nextStart = Math.floor(now / 60_000) * 60_000 + ahead * 60_000
  return { inside, nextStart, label: `${window.start}–${window.end}` }
}

/* ── versions ───────────────────────────────────────────────────────── */

/** `7.3.15-patched.498fcc2b` → [7, 3, 15]; null for anything else. */
export function versionParts(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(value ?? ''))
  return match ? match.slice(1, 4).map(Number) : null
}

export function sameMajor(left, right) {
  const [a, b] = [versionParts(left), versionParts(right)]
  return Boolean(a && b && a[0] === b[0])
}

export function compareVersions(left, right) {
  const [a, b] = [versionParts(left) ?? [0, 0, 0], versionParts(right) ?? [0, 0, 0]]
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] - b[i]
  return 0
}

/* ── builder reports (dropped by the gates; strictly validated before anything reads them) ── */

const text = (value, max) => (typeof value === 'string' && value.length > 0 ? value.slice(0, max) : null)
const when = value => (typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null)

function reasonList(value) {
  if (!Array.isArray(value)) return []
  return value.filter(isObject).slice(0, 20).map(item => ({ code: String(item.code ?? '').slice(0, 40), text: String(item.text ?? '').slice(0, 300) })).filter(item => item.text)
}

function checkList(value) {
  if (!Array.isArray(value)) return []
  return value.filter(isObject).slice(0, 100).map(item => ({ name: String(item.name ?? '').slice(0, 80), ok: item.ok === true, ...(item.detail ? { detail: String(item.detail).slice(0, 200) } : {}) })).filter(item => item.name)
}

const CPA_BUILDER_STATUS = new Set(['built', 'up-to-date', 'held', 'merge-conflict', 'build-failed', 'smoke-failed', 'fetch-failed', 'upload-failed'])
const MAGPIE_BUILDER_STATUS = new Set(['built', 'up-to-date', 'held', 'build-failed', 'error'])

/**
 * The CPA builder's report: what upstream has, which line it follows, what it built and how the build went.
 * `candidate` is only set for a build that passed go test + smoke; its binary arrives as <inbox>/<version>.bin.
 */
export function parseCpaReport(raw) {
  if (!isObject(raw) || raw.version !== 1 || raw.kernel !== 'cpa' || !CPA_BUILDER_STATUS.has(raw.status) || !when(raw.checkedAt)) return null
  const candidate = isObject(raw.candidate) && CPA_VERSION.test(String(raw.candidate.version)) && SHA256.test(String(raw.candidate.sha256))
    ? { version: raw.candidate.version, sha256: raw.candidate.sha256, commit: text(raw.candidate.commit, 40), tag: TAG.test(String(raw.candidate.tag)) ? raw.candidate.tag : null, checks: checkList(raw.candidate.checks) }
    : null
  if (raw.status === 'built' && !candidate) return null
  const heldNewer = isObject(raw.heldNewer) && TAG.test(String(raw.heldNewer.tag)) ? { tag: raw.heldNewer.tag, text: text(raw.heldNewer.text, 300) ?? '' } : null
  return {
    version: 1, kernel: 'cpa', status: raw.status, checkedAt: raw.checkedAt,
    upstreamLatest: TAG.test(String(raw.upstreamLatest)) ? raw.upstreamLatest : null,
    line: /^v\d+\.\d+$/.test(String(raw.line)) ? raw.line : null,
    base: TAG.test(String(raw.base)) ? raw.base : null,
    heldNewer, candidate, reasons: reasonList(raw.reasons),
  }
}

/** The Magpie builder's report: the revision its own pipeline proved (rehearsed + applied on the Mac) and the linux build of it. */
export function parseMagpieReport(raw) {
  if (!isObject(raw) || raw.version !== 1 || raw.kernel !== 'magpie' || !MAGPIE_BUILDER_STATUS.has(raw.status) || !when(raw.checkedAt)) return null
  const candidate = isObject(raw.candidate) && SHA40.test(String(raw.candidate.revision)) && SHA256.test(String(raw.candidate.sha256))
    ? { revision: raw.candidate.revision, sha256: raw.candidate.sha256, release: text(raw.candidate.release, 40), checks: checkList(raw.candidate.checks) }
    : null
  if (raw.status === 'built' && !candidate) return null
  return {
    version: 1, kernel: 'magpie', status: raw.status, checkedAt: raw.checkedAt,
    upstreamLatest: text(raw.upstreamLatest, 40), upstreamRevision: SHA40.test(String(raw.upstreamRevision)) ? raw.upstreamRevision : null,
    candidate, reasons: reasonList(raw.reasons),
  }
}

/* ── state (the console reads it) ───────────────────────────────────── */

export function emptyState(kernel) {
  return {
    version: 1, kernel, role: kernel === 'cpa' ? 'serving' : 'standby',
    builder: null, staged: null, installed: null, decision: null,
    attempts: {}, applied: null, lastApply: null, failures: 0, nextAttemptAt: null, checkedAt: null,
  }
}

export async function readState(paths, kernel) {
  const raw = await readJSON(path.join(paths.states, `${kernel}.json`))
  if (!raw || raw.version !== 1 || raw.kernel !== kernel) return emptyState(kernel)
  return { ...emptyState(kernel), ...raw, attempts: isObject(raw.attempts) ? raw.attempts : {} }
}

const saveState = (paths, state) => writeAtomic(path.join(paths.states, `${state.kernel}.json`), state)

/* ── decisions (pure) ───────────────────────────────────────────────── */

/**
 * What `auto` does with CPA now. action: none | wait | apply. `why` is the one word the console renders:
 * disabled · no-candidate · up-to-date · held · offline · hold-file · attempted · backoff · daily · window · apply.
 */
export function decideCpa({ now, config, state, running, hold }) {
  const window = windowState(now, config.window)
  const base = { window: window.label, tz: config.window.tz, nextWindowAt: iso(window.nextStart), inWindow: window.inside }
  if (!config.cpa.enabled) return { action: 'none', why: 'disabled', ...base }
  const builder = state.builder
  const staged = state.staged
  if (!staged) {
    if (builder && builder.status !== 'built' && builder.status !== 'up-to-date') return { action: 'none', why: 'held', reasons: builder.reasons, ...base }
    return { action: 'none', why: running && builder?.candidate?.version === running ? 'up-to-date' : 'no-candidate', ...base }
  }
  const target = { version: staged.version }
  if (!running) return { action: 'none', why: 'offline', ...target, ...base }
  if (staged.version === running || compareVersions(staged.version, running) < 0) return { action: 'none', why: 'up-to-date', ...target, ...base }
  if (hold) return { action: 'none', why: 'hold-file', reasons: [{ code: 'hold', text: `生产机上有补丁锁（auto-update.hold）：${hold.slice(0, 160)}` }], ...target, ...base }
  if ((state.attempts[staged.version] || 0) >= 1) return { action: 'none', why: 'attempted', ...target, ...base }
  const retryAt = Date.parse(state.nextAttemptAt || '')
  if (Number.isFinite(retryAt) && retryAt > now) return { action: 'none', why: 'backoff', retryAt: state.nextAttemptAt, ...target, ...base }
  // one replacement per window: a release that lands mid-window after one went in waits for tomorrow's
  const last = state.lastApply
  if (last?.action === 'apply' && last.result !== 'refused' && now - Date.parse(last.at || '') < DAY_GAP_MS) return { action: 'wait', why: 'daily', ...target, ...base }
  if (!window.inside) return { action: 'wait', why: 'window', ...target, ...base }
  return { action: 'apply', why: 'apply', ...target, ...base }
}

/** Magpie standby: no window (it serves nothing), once per revision. */
export function decideMagpie({ config, state }) {
  if (!config.magpie.enabled) return { action: 'none', why: 'disabled' }
  const staged = state.staged
  if (!staged) {
    const builder = state.builder
    if (builder && builder.status !== 'built' && builder.status !== 'up-to-date') return { action: 'none', why: 'held', reasons: builder.reasons }
    return { action: 'none', why: state.installed ? 'up-to-date' : 'no-candidate' }
  }
  if (state.installed?.revision === staged.revision) return { action: 'none', why: 'up-to-date', revision: staged.revision }
  if ((state.attempts[staged.revision] || 0) >= 1) return { action: 'none', why: 'attempted', revision: staged.revision }
  return { action: 'apply', why: 'apply', revision: staged.revision }
}

/* ── processes ──────────────────────────────────────────────────────── */

/** Run a command; resolves { code, stdout, stderr } (never rejects). */
export function run(command, args, { timeoutMs = 120_000, env } = {}) {
  return new Promise(resolve => {
    execFile(command, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, ...(env ? { env } : {}) }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0
      resolve({ code, stdout: String(stdout || ''), stderr: String(stderr || error?.message || '') })
    })
  })
}

/** `cli-proxy-api --version` → `7.3.15-patched.498fcc2b`; null when it cannot say. */
export async function binaryVersion(binary, runner = run) {
  const out = await runner(binary, ['--version'], { timeoutMs: 15_000 })
  const match = /Version:\s*([^,\s]+)/.exec(`${out.stdout}\n${out.stderr}`)
  return match && CPA_VERSION.test(match[1]) ? match[1] : null
}

async function serviceActive(service, runner = run) {
  const out = await runner('systemctl', ['is-active', service], { timeoutMs: 10_000 })
  return out.stdout.trim() === 'active'
}

/** The version that is installed and running; null when the service is down or the binary cannot say. */
export async function runningCpa(paths, deps = {}) {
  const runner = deps.run ?? run
  if (!await serviceActive(paths.cpa.service, runner)) return null
  return binaryVersion(paths.cpa.binary, runner)
}

/** An older major cannot start on migrated config; unfamiliar version markers must never look legacy. */
export async function configLayout(file) {
  try {
    const source = (await fs.readFile(file, 'utf8')).replace(/^﻿/, '')
    if (!source.trim()) return null
    const markers = source.split(/\r?\n/).filter(line => !/^\s*#/.test(line) && line.includes('config-version'))
    if (!markers.length) return 'legacy'
    const match = markers.length === 1 && /^\s*(?:config-version|"config-version"|'config-version')\s*:\s*(\d+)[ \t]*(?:#.*)?$/.exec(markers[0])
    return match ? `v${match[1]}` : null
  } catch {
    return null
  }
}

async function readHold(file) {
  try {
    return (await fs.readFile(file, 'utf8')).trim() || '已设置（空文件）'
  } catch (error) {
    return error.code === 'ENOENT' ? null : '补丁锁无法读取；不替换'
  }
}

/* ── inbox → staged ─────────────────────────────────────────────────── */

async function prune(directory, keep, protect = []) {
  const names = (await fs.readdir(directory).catch(() => [])).filter(name => !name.startsWith('.') && !protect.includes(name))
  const stats = await Promise.all(names.map(async name => ({ name, at: (await fs.stat(path.join(directory, name))).mtimeMs })))
  for (const { name } of stats.sort((a, b) => b.at - a.at).slice(keep)) await fs.rm(path.join(directory, name), { recursive: true, force: true })
}

/**
 * A CPA drop: report.json (+ <version>.bin when it built one). The report is recorded as is; the binary is staged only
 * when its sha256 is the reported one and it says it is that version. Returns notes for the log.
 */
export async function ingestCpa(paths, state, deps = {}) {
  const notes = []
  const reportFile = path.join(paths.cpa.inbox, 'report.json')
  const raw = await readJSON(reportFile, MAX_REPORT_BYTES)
  if (!raw) {
    if (await exists(reportFile)) { notes.push('cpa: unreadable report dropped'); await fs.rm(reportFile, { force: true }) }
    return { state, notes }
  }
  await fs.rm(reportFile, { force: true })
  const report = parseCpaReport(raw)
  if (!report) { notes.push('cpa: invalid report ignored'); return { state, notes } }
  let next = { ...state, builder: report }
  const candidate = report.candidate
  if (candidate && state.staged?.version !== candidate.version) {
    const drop = path.join(paths.cpa.inbox, `${candidate.version}.bin`)
    if (await exists(drop)) {
      const staged = path.join(paths.cpa.staged, candidate.version)
      await fs.mkdir(staged, { recursive: true, mode: 0o700 })
      const binary = path.join(staged, 'cli-proxy-api')
      await fs.rename(drop, binary)
      await fs.chmod(binary, 0o755)
      const sha = await sha256File(binary)
      const says = sha === candidate.sha256 ? await binaryVersion(binary, deps.run ?? run) : null
      if (sha !== candidate.sha256 || says !== candidate.version) {
        await fs.rm(staged, { recursive: true, force: true })
        notes.push(`cpa: ${candidate.version} rejected (${sha !== candidate.sha256 ? 'sha256 mismatch' : `binary says ${says}`})`)
        next = { ...next, builder: { ...report, status: 'upload-failed', reasons: [{ code: 'verify', text: `生产机校验 ${candidate.version} 没过（${sha !== candidate.sha256 ? 'sha256 不符' : '版本号不符'}），没有暂存` }] } }
      } else {
        next = { ...next, staged: { version: candidate.version, sha256: sha, tag: candidate.tag, at: iso((deps.now ?? Date.now)()) } }
        notes.push(`cpa: staged ${candidate.version}`)
        await prune(paths.cpa.staged, KEEP_STAGED, [candidate.version])
      }
    }
  }
  for (const name of await fs.readdir(paths.cpa.inbox).catch(() => [])) if (name.endsWith('.bin')) await fs.rm(path.join(paths.cpa.inbox, name), { force: true })
  return { state: next, notes }
}

export async function ingestMagpie(paths, state, deps = {}) {
  const notes = []
  const reportFile = path.join(paths.magpie.inbox, 'report.json')
  const raw = await readJSON(reportFile, MAX_REPORT_BYTES)
  if (!raw) {
    if (await exists(reportFile)) { notes.push('magpie: unreadable report dropped'); await fs.rm(reportFile, { force: true }) }
    return { state, notes }
  }
  await fs.rm(reportFile, { force: true })
  const report = parseMagpieReport(raw)
  if (!report) { notes.push('magpie: invalid report ignored'); return { state, notes } }
  let next = { ...state, builder: report }
  const candidate = report.candidate
  if (candidate && state.staged?.revision !== candidate.revision && state.installed?.revision !== candidate.revision) {
    const drop = path.join(paths.magpie.inbox, `${candidate.revision}.bin`)
    if (await exists(drop)) {
      const sha = await sha256File(drop)
      if (sha !== candidate.sha256) {
        notes.push(`magpie: ${candidate.revision.slice(0, 7)} rejected (sha256 mismatch)`)
        next = { ...next, builder: { ...report, status: 'error', reasons: [{ code: 'verify', text: `生产机校验 ${candidate.revision.slice(0, 7)} 的 sha256 没过，没有暂存` }] } }
      } else {
        const staged = path.join(paths.magpie.root, 'staged')
        await fs.mkdir(staged, { recursive: true, mode: 0o700 })
        await fs.rename(drop, path.join(staged, candidate.revision))
        next = { ...next, staged: { revision: candidate.revision, sha256: sha, release: candidate.release, at: iso((deps.now ?? Date.now)()) } }
        notes.push(`magpie: staged ${candidate.revision.slice(0, 7)}`)
        await prune(staged, KEEP_STAGED, [candidate.revision])
      }
    }
  }
  for (const name of await fs.readdir(paths.magpie.inbox).catch(() => [])) if (name.endsWith('.bin')) await fs.rm(path.join(paths.magpie.inbox, name), { force: true })
  return { state: next, notes }
}

/* ── CPA install (through cpa-install-binary.sh) ────────────────────── */

/**
 * Map cpa-install-binary.sh's exit + log lines to one result:
 * applied · up-to-date · refused (nothing touched: baseline gate, hold, config changed, lock) · rolled-back · rollback-failed.
 */
export function classifyInstall({ code, stdout }) {
  const lines = stdout.split('\n').map(line => line.trim()).filter(Boolean)
  const backup = /备份 (\/[^）)\s]+)/.exec(stdout)?.[1] ?? null
  const started = lines.some(line => line.startsWith('开始安装'))
  const last = lines.at(-1) ?? ''
  if (code === 0) return { result: lines.some(line => line.startsWith('线上已是')) ? 'up-to-date' : 'applied', backup, lines }
  // stopped (or failed to stop) and gave up before replacing anything: the binary is the old one
  if (!started || lines.some(line => line.includes('二进制未改动'))) return { result: 'refused', backup: null, lines, reason: last }
  if (lines.some(line => line.startsWith('已回滚到'))) return { result: 'rolled-back', backup, lines, reason: lines.find(line => /；准备回滚到/.test(line)) ?? last }
  return { result: 'rollback-failed', backup, lines, reason: lines.find(line => line.startsWith('严重')) ?? last }
}

const TRIM = line => line.replace(/（备份 [^）]*）/, '').slice(0, 200)

export async function applyCpa({ paths, state, version, deps = {} }) {
  if (await readHold(paths.cpa.hold)) return { result: 'refused', reason: '补丁锁（auto-update.hold）仍生效；不替换', lines: [] }
  const runner = deps.run ?? run
  const binary = path.join(paths.cpa.staged, version, 'cli-proxy-api')
  if (!await exists(binary) || await sha256File(binary) !== state.staged?.sha256) {
    return { result: 'refused', reason: '暂存的二进制不见了或被改过，等构建机重新上传', lines: [] }
  }
  // the install script runs its own gates, backup, restart and rollback (flock /run/cpa-auto-update.lock)
  const out = await runner(paths.cpa.install, [binary, version], { timeoutMs: 15 * 60_000 })
  return classifyInstall(out)
}

/* ── Magpie standby install ─────────────────────────────────────────── */

function socketHealth(socket, timeoutMs = 3_000) {
  return new Promise(resolve => {
    const req = request({ socketPath: socket, path: '/internal/health', method: 'GET', timeout: timeoutMs }, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
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

const SANDBOX = ['NoNewPrivileges=yes', 'CapabilityBoundingSet=', 'PrivateTmp=yes', 'PrivateDevices=yes', 'ProtectSystem=strict', 'ProtectHome=yes',
  'RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6', 'RestrictNamespaces=yes', 'SystemCallArchitectures=native', 'TasksMax=128', 'UMask=0077']

/** Boot the standby once in the console unit's sandbox (empty HOME), read /internal/health, stop it. */
export async function smokeMagpie({ paths, binary, revision, deps = {} }) {
  const runner = deps.run ?? run
  const dir = path.join(paths.magpie.smoke, `${revision.slice(0, 12)}-${randomBytes(3).toString('hex')}`)
  await fs.mkdir(path.join(dir, 'home'), { recursive: true, mode: 0o700 })
  const socket = path.join(dir, 'kernel.sock')
  const unit = `crosery-magpie-standby-smoke-${randomBytes(3).toString('hex')}`
  const props = [...SANDBOX, `ReadWritePaths=${dir}`, `Environment=HOME=${dir}/home`, `Environment=XDG_CONFIG_HOME=${dir}/home/.config`,
    `Environment=XDG_CACHE_HOME=${dir}/home/.cache`, `Environment=MAGPIE_KERNEL_SOCKET=${socket}`, 'Environment=MAGPIE_NO_STATS=1', 'Environment=DO_NOT_TRACK=1']
  const started = await runner('systemd-run', ['--quiet', `--unit=${unit}`, ...props.flatMap(prop => ['-p', prop]), binary], { timeoutMs: 20_000 })
  const checks = []
  try {
    if (started.code !== 0) return { ok: false, checks: [{ name: 'start', ok: false, detail: started.stderr.trim().slice(0, 200) }] }
    const deadline = (deps.now ?? Date.now)() + 20_000
    let health = { status: 0, body: null }
    while ((deps.now ?? Date.now)() < deadline) {
      if (await exists(socket)) { health = await (deps.health ?? socketHealth)(socket); if (health.status === 200) break }
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    const body = health.body ?? {}
    checks.push({ name: 'health', ok: health.status === 200 && body.ok === true, detail: `HTTP ${health.status}` })
    checks.push({ name: 'revision', ok: body.revision === revision, detail: String(body.revision ?? '').slice(0, 12) })
    checks.push({ name: 'keychain-off', ok: body.keychain === false })
    return { ok: checks.every(check => check.ok), checks }
  } finally {
    await runner('systemctl', ['stop', unit], { timeoutMs: 30_000 })
    await runner('systemctl', ['reset-failed', unit], { timeoutMs: 10_000 })
    await fs.rm(dir, { recursive: true, force: true })
  }
}

const releaseName = revision => revision.slice(0, 12)

async function currentMagpie(paths) {
  try { return path.basename(await fs.readlink(path.join(paths.magpie.root, 'current'))) } catch { return null }
}

async function pointCurrent(paths, name) {
  const link = path.join(paths.magpie.root, 'current')
  const temporary = `${link}.${process.pid}.tmp`
  await fs.rm(temporary, { force: true })
  await fs.symlink(path.join('releases', name), temporary)
  await fs.rename(temporary, link)
}

export async function applyMagpie({ paths, state, revision, deps = {} }) {
  const staged = path.join(paths.magpie.root, 'staged', revision)
  if (!await exists(staged) || await sha256File(staged) !== state.staged?.sha256) return { result: 'refused', reason: '暂存的内核不见了或被改过', checks: [] }
  const name = releaseName(revision)
  const release = path.join(paths.magpie.root, 'releases', name)
  await fs.rm(release, { recursive: true, force: true })
  await fs.mkdir(release, { recursive: true, mode: 0o755 })
  const binary = path.join(release, 'magpie-kernel')
  await fs.copyFile(staged, binary)
  await fs.chmod(binary, 0o755)
  const smoke = await (deps.smoke ?? smokeMagpie)({ paths, binary, revision, deps })
  if (!smoke.ok) {
    await fs.rm(release, { recursive: true, force: true })
    return { result: 'failed', checks: smoke.checks, reason: `备用内核单独启动没过：${smoke.checks.filter(check => !check.ok).map(check => `${check.name} ${check.detail ?? ''}`.trim()).join('、')}` }
  }
  const previous = await currentMagpie(paths)
  await pointCurrent(paths, name)
  await prune(path.join(paths.magpie.root, 'releases'), KEEP_MAGPIE, [name, ...(previous ? [previous] : [])])
  return { result: 'applied', checks: smoke.checks, previous }
}

/* ── rollback ───────────────────────────────────────────────────────── */

/**
 * CPA: back to the version the last auto-install replaced, through the same install transaction (gates, backup, rollback).
 * Only while that auto-installed version is the one running, only from the backup the install recorded, and across a
 * major version only while config.yaml is still in the legacy layout (an older binary cannot start on a migrated one).
 */
export async function rollbackCpa({ paths, state, deps = {} }) {
  if (await readHold(paths.cpa.hold)) throw new Error('补丁锁（auto-update.hold）仍生效；不回滚')
  const applied = state.applied
  if (!applied?.version || !applied.previous) throw new Error('没有可回滚的自动更新（失败的替换已经自动回滚过）')
  if (!sameMajor(applied.previous, applied.version)) {
    const layout = await configLayout(paths.cpa.config)
    if (layout === null) throw new Error('无法确认 config.yaml 仍是旧格式（读不到或格式不明），不能跨大版本回滚，需人工处理')
    if (layout !== 'legacy') throw new Error(`config.yaml 已被 ${applied.version} 迁移成新格式（${layout}），${applied.previous} 起不来，需人工处理`)
  }
  const running = await runningCpa(paths, deps)
  if (running && running !== applied.version) throw new Error(`运行中的是 ${running}，不是自动更新装的 ${applied.version}；不覆盖`)
  if (!applied.backup || !await exists(applied.backup)) throw new Error('替换前的备份不在了')
  const out = await (deps.run ?? run)(paths.cpa.install, [applied.backup, applied.previous], { timeoutMs: 15 * 60_000 })
  return classifyInstall(out)
}

export async function rollbackMagpie({ paths, state, deps = {} }) {
  const applied = state.applied
  if (!applied?.revision || !applied.previous) throw new Error('没有可回滚的备用内核版本')
  const current = await currentMagpie(paths)
  if (current !== releaseName(applied.revision)) throw new Error('当前备用内核不是自动更新装的那个；不覆盖')
  const binary = path.join(paths.magpie.root, 'releases', applied.previous, 'magpie-kernel')
  if (!await exists(binary)) throw new Error('上一个备用内核已被清理')
  const previousRevision = applied.previousRevision
  if (previousRevision) {
    const smoke = await (deps.smoke ?? smokeMagpie)({ paths, binary, revision: previousRevision, deps })
    if (!smoke.ok) return { result: 'failed', checks: smoke.checks, reason: '上一个备用内核启动没过，没有切回' }
  }
  await pointCurrent(paths, applied.previous)
  return { result: 'rolled-back-manually', checks: [] }
}

/* ── lock (timer, path unit and a manual run never overlap) ─────────── */

function processAlive(pid) {
  try { process.kill(pid, 0); return true } catch (error) { return error.code === 'EPERM' }
}

export async function withLock(file, action) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  try {
    await fs.writeFile(file, String(process.pid), { flag: 'wx', mode: 0o600 })
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    const holder = Number.parseInt(await fs.readFile(file, 'utf8').catch(() => ''), 10)
    if (Number.isInteger(holder) && holder > 0 && processAlive(holder)) throw new Error(`busy: applier ${holder} is running`)
    await fs.rm(file, { force: true })
    await fs.writeFile(file, String(process.pid), { flag: 'wx', mode: 0o600 })
  }
  try { return await action() } finally { await fs.rm(file, { force: true }) }
}

/* ── console requests ───────────────────────────────────────────────── */

/** <data>/kernel-requests/rollback-<kernel>.json → { kernel, at }. Anything else there is removed unread. */
export async function takeRequests(paths) {
  const names = await fs.readdir(paths.requests).catch(() => [])
  const taken = []
  for (const name of names) {
    const file = path.join(paths.requests, name)
    const match = /^rollback-(cpa|magpie)\.json$/.exec(name)
    const body = match ? await readJSON(file, 4096) : null
    await fs.rm(file, { force: true })
    if (match && body?.confirm === true) taken.push({ action: 'rollback', kernel: match[1], at: when(body.at) })
  }
  return taken
}

/* ── auto ───────────────────────────────────────────────────────────── */

async function rollbackKernel({ paths, kernel, deps, now }) {
  let state = await readState(paths, kernel)
  let outcome
  try {
    outcome = kernel === 'cpa' ? await rollbackCpa({ paths, state, deps }) : await rollbackMagpie({ paths, state, deps })
  } catch (error) {
    outcome = { result: 'refused', reason: String(error?.message || error).slice(0, 200) }
  }
  const at = iso(now())
  const ok = kernel === 'cpa' ? outcome.result === 'applied' : outcome.result === 'rolled-back-manually'
  const target = kernel === 'cpa' ? state.applied?.version : state.applied?.revision
  state = {
    ...state,
    lastApply: { [kernel === 'cpa' ? 'version' : 'revision']: target ?? null, at, action: 'rollback', result: ok ? 'rolled-back-manually' : outcome.result,
      reasons: outcome.reason ? [{ code: 'rollback', text: outcome.reason }] : [], backup: outcome.backup ?? null },
    ...(ok ? { applied: null, ...(kernel === 'magpie' ? { installed: { revision: state.applied.previousRevision ?? null, at } } : {}) } : {}),
  }
  await saveState(paths, state)
  return { kernel, action: 'rollback', ...outcome }
}

export async function runAuto({ dryRun = false, paths = applierPaths(), deps = {} } = {}) {
  const now = deps.now ?? Date.now
  const config = normalizeConfig(await readJSON(paths.config))
  if (dryRun) {
    const [cpaState, magpieState, running, hold] = await Promise.all([readState(paths, 'cpa'), readState(paths, 'magpie'), runningCpa(paths, deps), readHold(paths.cpa.hold)])
    return { dryRun: true, config, running, cpa: decideCpa({ now: now(), config, state: cpaState, running, hold }), magpie: decideMagpie({ config, state: magpieState }) }
  }
  return withLock(paths.lock, async () => {
    const log = []
    for (const item of await takeRequests(paths)) log.push(await rollbackKernel({ paths, kernel: item.kernel, deps, now }))

    /* CPA */
    let cpa = await readState(paths, 'cpa')
    const ingested = await ingestCpa(paths, cpa, deps)
    cpa = { ...ingested.state, checkedAt: iso(now()) }
    log.push(...ingested.notes)
    const running = await runningCpa(paths, deps)
    cpa.installed = running ? { version: running, at: cpa.installed?.version === running ? cpa.installed.at : iso(now()) } : cpa.installed
    cpa.configLayout = await configLayout(paths.cpa.config)
    const decision = decideCpa({ now: now(), config, state: cpa, running, hold: await readHold(paths.cpa.hold) })
    cpa.decision = { ...decision, at: iso(now()) }
    if (decision.action === 'apply') {
      // the install runs minutes (gates, restart, maybe a rollback): the console shows 「正在替换」 meanwhile
      await saveState(paths, cpa)
      const outcome = await applyCpa({ paths, state: cpa, version: decision.version, deps })
      const at = iso(now())
      const touched = outcome.result !== 'refused'
      const ok = outcome.result === 'applied' || outcome.result === 'up-to-date'
      const failures = ok ? 0 : (Number(cpa.failures) || 0) + 1
      cpa = {
        ...cpa,
        // a refused install touched nothing: it is retried (after a pause) inside the window, the attempt is not spent
        attempts: touched ? { ...cpa.attempts, [decision.version]: (cpa.attempts[decision.version] || 0) + 1 } : cpa.attempts,
        lastApply: { version: decision.version, from: running, at, action: 'apply', result: outcome.result, backup: outcome.backup ?? null,
          reasons: outcome.reason ? [{ code: outcome.result, text: TRIM(outcome.reason) }] : [] },
        ...(outcome.result === 'applied' ? { applied: { version: decision.version, previous: running, backup: outcome.backup ?? null, at }, installed: { version: decision.version, at } } : {}),
        failures, nextAttemptAt: ok ? null : iso(now() + RETRY_MS),
      }
      log.push({ kernel: 'cpa', action: 'apply', version: decision.version, result: outcome.result })
      // what the console shows next is the state after the apply, not the decision that started it
      const after = outcome.result === 'refused' ? running : await runningCpa(paths, deps)
      cpa.configLayout = await configLayout(paths.cpa.config)
      cpa.decision = { ...decideCpa({ now: now(), config, state: cpa, running: after, hold: await readHold(paths.cpa.hold) }), at: iso(now()) }
    }
    await saveState(paths, cpa)

    /* Magpie standby */
    let magpie = await readState(paths, 'magpie')
    const dropped = await ingestMagpie(paths, magpie, deps)
    magpie = { ...dropped.state, checkedAt: iso(now()) }
    log.push(...dropped.notes)
    const current = await currentMagpie(paths)
    if (current && magpie.installed?.revision && releaseName(magpie.installed.revision) !== current) magpie.installed = null
    const standby = decideMagpie({ config, state: magpie })
    magpie.decision = { ...standby, at: iso(now()) }
    if (standby.action === 'apply') {
      await saveState(paths, magpie)
      const outcome = await applyMagpie({ paths, state: magpie, revision: standby.revision, deps })
      const at = iso(now())
      magpie = {
        ...magpie,
        attempts: outcome.result === 'refused' ? magpie.attempts : { ...magpie.attempts, [standby.revision]: (magpie.attempts[standby.revision] || 0) + 1 },
        lastApply: { revision: standby.revision, at, action: 'apply', result: outcome.result, checks: outcome.checks ?? [], reasons: outcome.reason ? [{ code: outcome.result, text: outcome.reason }] : [] },
        ...(outcome.result === 'applied' ? {
          applied: { revision: standby.revision, previous: outcome.previous, previousRevision: magpie.installed?.revision ?? null, at },
          installed: { revision: standby.revision, release: magpie.staged?.release ?? null, at },
        } : {}),
      }
      log.push({ kernel: 'magpie', action: 'apply', revision: standby.revision, result: outcome.result })
      magpie.decision = { ...decideMagpie({ config, state: magpie }), at: iso(now()) }
    }
    await saveState(paths, magpie)
    return { config, running, cpa: cpa.decision, magpie: magpie.decision, log }
  })
}

async function main() {
  const action = process.argv[2]
  const arg = name => { const at = process.argv.indexOf(name); return at < 0 ? undefined : process.argv[at + 1] }
  const paths = applierPaths()
  if (action === 'status') {
    const [cpa, magpie] = await Promise.all([readState(paths, 'cpa'), readState(paths, 'magpie')])
    const dry = await runAuto({ dryRun: true, paths })
    console.log(json({ ...dry, state: { cpa, magpie } }))
  } else if (action === 'auto') {
    console.log(json(await runAuto({ dryRun: process.argv.includes('--dry-run'), paths })))
  } else if (action === 'rollback') {
    const kernel = arg('--kernel')
    if (kernel !== 'cpa' && kernel !== 'magpie') throw new Error('--kernel cpa|magpie')
    if (!process.argv.includes('--confirm')) throw new Error('rollback restarts the gateway kernel; pass --confirm')
    const outcome = await withLock(paths.lock, () => rollbackKernel({ paths, kernel, deps: {}, now: Date.now }))
    console.log(json(outcome))
    if (!['applied', 'rolled-back-manually'].includes(outcome.result)) process.exitCode = 1
  } else {
    throw new Error('Use status, auto [--dry-run], or rollback --kernel cpa|magpie --confirm')
  }
}

// realpath: systemd runs it through /opt/crosery-api-console-current (a symlink); import.meta.url is the resolved file
if (process.argv[1] && realpathSync(path.resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}

