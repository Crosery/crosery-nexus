#!/usr/bin/env node
/**
 * Gateway-kernel applier (root, systemd) on both hosts: the installing half of「网关内核自动更新」for CPA (serving
 * traffic) and Magpie (standby, serves nothing).
 *
 *   node scripts/kernel-applier.mjs status                     config + state + what `auto` would do now (read-only)
 *   node scripts/kernel-applier.mjs auto [--dry-run]           crosery-kernel-update.service (timer, path unit, gates)
 *   node scripts/kernel-applier.mjs rollback --kernel cpa|magpie --confirm
 *   node scripts/kernel-applier.mjs adopt --version <v> --sha256 <hex> [--previous <v> --backup <file>]
 *                                                              preview: the binary installed by hand becomes the trial
 *   node scripts/kernel-applier.mjs probe --out <dir> --phase baseline|verify|restored --budget <s>
 *                                                              the install script's hook: one real request per OAuth type
 *
 * Builders never install. The CPA builder (upstream tag + our patches, go test, smoke; its coordinator
 * scripts/cpa-coordinator.mjs) and the Magpie builder drop binaries, reports and records through forced-command gates
 * into <lib>/<kernel>/inbox. AUTOUPDATE_ROLE (/etc/crosery/autoupdate.env) says which half of the CPA promotion this
 * host is; anything but `preview` is production:
 * - preview installs a new candidate right away (one trial at a time), keeps it ≥ AUTOUPDATE_SOAK_HOURS, takes the
 *   coordinator's two acceptance runs, rolls back and rejects it on any failure, and writes the promotion record;
 * - production installs only a binary whose promotion record matches it (sha256, version, soak, both acceptance runs,
 *   age), only inside the quiet window, once per version, never while the hold file is set.
 * Both install only through /usr/local/sbin/cpa-install-binary.sh (gates, backup, swap, real requests per OAuth type,
 * restore within 30 s). Magpie goes into a new release dir, boots once in the console's sandbox, then flips `current`.
 * The console writes only <data>/kernel-autoupdate.json and <data>/kernel-requests/*.json, and reads
 * <data>/kernels/<kernel>.json, which only this job writes.
 */
import fs from 'node:fs/promises'
import { createReadStream, realpathSync } from 'node:fs'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import { request } from 'node:http'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { promotionPolicy, updateRole } from './autoupdate-common.mjs'

export const DEFAULT_WINDOW = Object.freeze({ start: '05:00', end: '07:00', tz: 'Asia/Shanghai' })
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/
const SHA40 = /^[a-f0-9]{40}$/
const SHA256 = /^[a-f0-9]{64}$/
const CPA_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/
const TAG = /^v\d+\.\d+\.\d+$/
const ACCOUNT_TYPE = /^[a-z0-9][a-z0-9-]{0,39}$/
const KEEP_STAGED = 2
const KEEP_MAGPIE = 3
const KEEP_PROBE_RUNS = 10
const RETRY_MS = 30 * 60_000
const DAY_GAP_MS = 20 * 3_600_000
const MAX_REPORT_BYTES = 64 * 1024
const PROBE_TIMEOUT_MS = 15_000
const CLOCK_SKEW_MS = 5 * 60_000
const APPLIER = fileURLToPath(import.meta.url)

export function applierPaths(env = process.env) {
  const data = path.resolve(env.KERNEL_DATA_DIR || '/opt/crosery-api-console/data')
  const lib = path.resolve(env.KERNEL_LIB_DIR || '/var/lib/crosery-kernels')
  return {
    data, lib,
    role: updateRole(env),
    policy: promotionPolicy(env),
    config: path.join(data, 'kernel-autoupdate.json'),
    states: path.join(data, 'kernels'),
    requests: path.join(data, 'kernel-requests'),
    systemKeys: path.join(data, 'system-keys.json'),
    lock: path.join(lib, 'applier.lock'),
    cpa: {
      inbox: path.join(lib, 'cpa/inbox'), staged: path.join(lib, 'cpa/staged'), probes: path.join(lib, 'cpa/probes'),
      promotion: path.join(data, 'kernels/cpa-promotion.json'),
      binary: env.CPA_BINARY || '/usr/local/bin/cli-proxy-api',
      install: env.CPA_INSTALL || '/usr/local/sbin/cpa-install-binary.sh',
      hold: env.CPA_HOLD_FILE || '/etc/cli-proxy-api/auto-update.hold',
      config: env.CPA_CONFIG || '/etc/cli-proxy-api/config.yaml',
      service: env.CPA_SERVICE || 'cli-proxy-api',
      authDir: env.CPA_AUTH_DIR || null,
      probeBase: env.CPA_PROBE_BASE_URL || 'http://127.0.0.1:8317',
      probeModels: parseProbeModels(env.CPA_PROBE_MODELS),
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
    heldNewer, candidate, reasons: reasonList(raw.reasons), preview: previewStage(raw.preview),
  }
}

const PREVIEW_STAGES = new Set(['uploaded', 'installed', 'soaking', 'accepted', 'rejected', 'delivered'])

/** The coordinator's word on where the candidate stands on preview (production's console shows it; nothing decides on it). */
function previewStage(raw) {
  if (!isObject(raw) || !CPA_VERSION.test(String(raw.version)) || !PREVIEW_STAGES.has(raw.stage)) return null
  return { version: raw.version, stage: raw.stage, soakUntil: when(raw.soakUntil), at: when(raw.at), reason: text(raw.reason, 300) }
}

const candidateRef = raw => (isObject(raw) && CPA_VERSION.test(String(raw.version)) && SHA256.test(String(raw.sha256)) ? { version: raw.version, sha256: raw.sha256 } : null)

/** One acceptance run as preview recorded it: `at` is preview's clock when it took the record, `ranAt` the coordinator's. */
function parseRun(raw) {
  if (!isObject(raw) || !when(raw.at) || typeof raw.ok !== 'boolean') return null
  return { at: raw.at, ranAt: when(raw.ranAt), ok: raw.ok, checks: checkList(raw.checks), summary: text(raw.summary, 300) }
}

/** The coordinator's acceptance run against preview's public API (preview inbox/acceptance.json). */
export function parseAcceptance(raw) {
  if (!isObject(raw) || raw.version !== 1 || raw.kind !== 'cpa-acceptance' || !['first', 'soak'].includes(raw.phase)) return null
  const candidate = candidateRef(raw.candidate)
  if (!candidate || typeof raw.ok !== 'boolean' || !when(raw.ranAt)) return null
  return { phase: raw.phase, candidate, ranAt: raw.ranAt, ok: raw.ok, checks: checkList(raw.checks), summary: text(raw.summary, 300) }
}

/** Preview's promotion record, carried to production by the coordinator (production inbox/promotion.json). */
export function parsePromotion(raw) {
  if (!isObject(raw) || raw.version !== 1 || raw.kind !== 'cpa-promotion') return null
  const candidate = candidateRef(raw.candidate)
  const first = parseRun(raw.acceptance?.first)
  const soak = parseRun(raw.acceptance?.soak)
  const soakMs = Number(raw.soakMs)
  if (!candidate || !first || !soak || !when(raw.installedAt) || !when(raw.acceptedAt) || !Number.isFinite(soakMs) || soakMs <= 0) return null
  return { version: 1, kind: 'cpa-promotion', candidate, installedAt: raw.installedAt, soakMs, acceptance: { first, soak }, acceptedAt: raw.acceptedAt }
}

/**
 * Why production must not install `staged` on this record ([] = it may). Production checks the soak with its own
 * policy, measured between preview's install and the soak acceptance, not the soak the record claims.
 */
export function promotionProblems({ record, staged, now, policy }) {
  const problems = []
  const add = (code, text) => problems.push({ code, text })
  if (!staged) return problems
  if (!record) { add('no-record', `${staged.version} 没有预发布验收记录`); return problems }
  if (record.candidate.version !== staged.version || record.candidate.sha256 !== staged.sha256) {
    add('mismatch', `预发布记录是 ${record.candidate.version}（${record.candidate.sha256.slice(0, 12)}），暂存的是 ${staged.version}（${String(staged.sha256).slice(0, 12)}）`)
    return problems
  }
  const { first, soak } = record.acceptance
  const installed = Date.parse(record.installedAt)
  if (!first.ok) add('acceptance', '预发布首次验收没过')
  if (!soak.ok) add('acceptance', '预发布浸泡后验收没过')
  if (Date.parse(first.at) < installed || Date.parse(soak.at) <= Date.parse(first.at)) add('order', '预发布记录的时间顺序不对（安装 → 首次验收 → 浸泡验收）')
  const soaked = Date.parse(soak.at) - installed
  if (!(soaked >= policy.soakMs)) add('soak', `预发布只跑了 ${Math.max(0, Math.floor(soaked / 3_600_000))} 小时，要满 ${Math.round(policy.soakMs / 3_600_000)} 小时`)
  const accepted = Date.parse(record.acceptedAt)
  if (accepted > now + CLOCK_SKEW_MS) add('future', '预发布记录的验收时间在未来')
  else if (now - accepted > policy.maxAgeMs) add('stale', `预发布记录已超过 ${Math.round(policy.maxAgeMs / 86_400_000)} 天，要重新验收`)
  return problems
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
    ...(kernel === 'cpa' ? { env: null, trial: null, promotion: null } : {}),
  }
}

export async function readState(paths, kernel) {
  const raw = await readJSON(path.join(paths.states, `${kernel}.json`))
  if (!raw || raw.version !== 1 || raw.kernel !== kernel) return emptyState(kernel)
  return { ...emptyState(kernel), ...raw, attempts: isObject(raw.attempts) ? raw.attempts : {} }
}

const saveState = (paths, state) => writeAtomic(path.join(paths.states, `${state.kernel}.json`), state)

/* ── decisions (pure) ───────────────────────────────────────────────── */

const TRIAL_ACTIVE = new Set(['installed', 'soaking'])

/**
 * What `auto` does with CPA now. action: none | wait | apply. `why` is the one word the console renders:
 * disabled · no-candidate · up-to-date · held · offline · hold-file · trial-active · attempted · backoff · not-promoted ·
 * daily · window · apply.
 * preview: no window and no daily limit, but one trial at a time. production: the promotion record must match.
 */
export function decideCpa({ now, config, state, running, hold, role = 'production', policy = promotionPolicy({}) }) {
  const window = windowState(now, config.window)
  const base = role === 'preview'
    ? { role, window: null, tz: config.window.tz, nextWindowAt: null, inWindow: true }
    : { role, window: window.label, tz: config.window.tz, nextWindowAt: iso(window.nextStart), inWindow: window.inside }
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
  if (hold) return { action: 'none', why: 'hold-file', reasons: [{ code: 'hold', text: `这台机器上有补丁锁（auto-update.hold）：${hold.slice(0, 160)}` }], ...target, ...base }
  const trial = state.trial
  if (role === 'preview' && trial && TRIAL_ACTIVE.has(trial.status) && trial.version !== staged.version) {
    return { action: 'none', why: 'trial-active', trial: trial.version, ...target, ...base }
  }
  if ((state.attempts[staged.version] || 0) >= 1) return { action: 'none', why: 'attempted', ...target, ...base }
  const retryAt = Date.parse(state.nextAttemptAt || '')
  if (Number.isFinite(retryAt) && retryAt > now) return { action: 'none', why: 'backoff', retryAt: state.nextAttemptAt, ...target, ...base }
  if (role === 'preview') return { action: 'apply', why: 'apply', ...target, ...base }
  const problems = promotionProblems({ record: state.promotion, staged, now, policy })
  if (problems.length) return { action: 'none', why: 'not-promoted', reasons: problems, ...target, ...base }
  // one replacement per window: a release that lands mid-window after one went in waits for tomorrow's
  const last = state.lastApply
  if (last?.action === 'apply' && last.result !== 'refused' && now - Date.parse(last.at || '') < DAY_GAP_MS) return { action: 'wait', why: 'daily', ...target, ...base }
  if (!window.inside) return { action: 'wait', why: 'window', ...target, ...base }
  return { action: 'apply', why: 'apply', ...target, ...base }
}

/* ── preview trial (pure) ───────────────────────────────────────────── */

/** Right after preview installed a candidate: the soak runs from this moment. */
export function startTrial({ version, sha256, previous, backup, at, policy }) {
  return {
    version, sha256, installedAt: at, previous: previous ?? null, backup: backup ?? null,
    soakMs: policy.soakMs, soakUntil: iso(Date.parse(at) + policy.soakMs),
    status: 'installed', acceptance: { first: null, soak: null }, offlineTicks: 0, rejected: null, acceptedAt: null,
  }
}

/**
 * The coordinator's acceptance run for the trial. Returns the next trial, plus `reject` when the candidate failed
 * (the caller rolls preview back), or `note` when the record does not apply (another candidate, wrong phase, too early).
 */
export function applyAcceptance({ trial, record, now }) {
  if (!trial || record.candidate.version !== trial.version || record.candidate.sha256 !== trial.sha256) {
    return { trial, note: `acceptance for ${record.candidate.version} ignored (the trial is ${trial?.version ?? 'none'})` }
  }
  if (!TRIAL_ACTIVE.has(trial.status)) return { trial, note: `acceptance ignored: ${trial.version} is ${trial.status}` }
  const run = { at: iso(now), ranAt: record.ranAt, ok: record.ok, checks: record.checks, summary: record.summary }
  if (record.phase === 'first') {
    if (trial.acceptance.first) return { trial, note: `first acceptance of ${trial.version} already recorded` }
    const next = { ...trial, acceptance: { ...trial.acceptance, first: run } }
    if (!record.ok) return { trial: next, reject: { code: 'acceptance', reason: `首次验收没过：${record.summary ?? '见记录'}` } }
    return { trial: { ...next, status: 'soaking' } }
  }
  if (trial.status !== 'soaking') return { trial, note: `soak acceptance of ${trial.version} before the first one passed` }
  if (now < Date.parse(trial.soakUntil)) return { trial, note: `soak acceptance of ${trial.version} too early (soak until ${trial.soakUntil})` }
  const next = { ...trial, acceptance: { ...trial.acceptance, soak: run } }
  if (!record.ok) return { trial: next, reject: { code: 'acceptance', reason: `浸泡后验收没过：${record.summary ?? '见记录'}` } }
  return { trial: { ...next, status: 'accepted', acceptedAt: iso(now) } }
}

/**
 * Every tick of an active trial: the candidate must keep running. Offline on two ticks in a row rejects it; another
 * binary in its place voids it (someone installed something else; nothing to roll back to).
 */
export function trialTick({ trial, running, runningSha }) {
  if (!trial || !TRIAL_ACTIVE.has(trial.status)) return { trial }
  if (!running) {
    const offlineTicks = (Number(trial.offlineTicks) || 0) + 1
    const next = { ...trial, offlineTicks }
    return offlineTicks >= 2 ? { trial: next, reject: { code: 'offline', reason: `${trial.version} 在预发布连续两次检查都不在运行` } } : { trial: next }
  }
  if (running !== trial.version || (runningSha && runningSha !== trial.sha256)) {
    return { trial: { ...trial, offlineTicks: 0 }, reject: { code: 'replaced', reason: `运行中的已不是 ${trial.version}（${running}），这次试运行作废`, noRollback: true } }
  }
  return { trial: trial.offlineTicks ? { ...trial, offlineTicks: 0 } : trial }
}

/** What preview hands the coordinator once the trial is accepted (production checks it again with its own policy). */
export function promotionRecord(trial) {
  return {
    version: 1, kind: 'cpa-promotion', candidate: { version: trial.version, sha256: trial.sha256 }, installedAt: trial.installedAt,
    soakMs: trial.soakMs, acceptance: { first: trial.acceptance.first, soak: trial.acceptance.soak }, acceptedAt: trial.acceptedAt,
  }
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

/** Take one inbox file: parsed value or null; whatever was there is removed (an unreadable or invalid one with a note). */
async function takeInbox(inbox, name, parse, notes) {
  const file = path.join(inbox, name)
  const raw = await readJSON(file, MAX_REPORT_BYTES)
  if (!raw) {
    if (await exists(file)) { notes.push(`cpa: unreadable ${name} dropped`); await fs.rm(file, { force: true }) }
    return null
  }
  await fs.rm(file, { force: true })
  const value = parse(raw)
  if (!value) notes.push(`cpa: invalid ${name} ignored`)
  return value
}

/**
 * A CPA drop through the gate: report.json (the builder's round), acceptance.json (preview: the coordinator's run against
 * this host), promotion.json (production: preview's record), and <version>.bin. A binary is staged only when it is what
 * this host may stage — preview: the reported candidate; production: the promoted one — its sha256 is that one and it
 * says it is that version. Binaries are looked at only once the sender finished (a report or a record arrived).
 */
export async function ingestCpa(paths, state, deps = {}) {
  const notes = []
  const role = paths.role ?? 'production'
  const now = iso((deps.now ?? Date.now)())
  const inbox = paths.cpa.inbox
  let next = state
  const report = await takeInbox(inbox, 'report.json', parseCpaReport, notes)
  if (report) next = { ...next, builder: report }
  const promotion = await takeInbox(inbox, 'promotion.json', parsePromotion, notes)
  if (promotion && role === 'production') next = { ...next, promotion: { ...promotion, receivedAt: now } }
  else if (promotion) notes.push('cpa: promotion record ignored on preview')
  const acceptance = await takeInbox(inbox, 'acceptance.json', parseAcceptance, notes)
  if (acceptance && role !== 'preview') notes.push('cpa: acceptance record ignored on production')
  const taken = role === 'preview' ? acceptance : null
  if (!report && !promotion) return { state: next, notes, acceptance: taken }

  const wanted = role === 'production' ? next.promotion?.candidate ?? null : report?.candidate ?? null
  if (wanted && next.staged?.version !== wanted.version) {
    const drop = path.join(inbox, `${wanted.version}.bin`)
    if (await exists(drop)) {
      const staged = path.join(paths.cpa.staged, wanted.version)
      await fs.mkdir(staged, { recursive: true, mode: 0o700 })
      const binary = path.join(staged, 'cli-proxy-api')
      await fs.rename(drop, binary)
      await fs.chmod(binary, 0o755)
      const sha = await sha256File(binary)
      const says = sha === wanted.sha256 ? await binaryVersion(binary, deps.run ?? run) : null
      if (sha !== wanted.sha256 || says !== wanted.version) {
        await fs.rm(staged, { recursive: true, force: true })
        notes.push(`cpa: ${wanted.version} rejected (${sha !== wanted.sha256 ? 'sha256 mismatch' : `binary says ${says}`})`)
        const reason = { code: 'verify', text: `${role === 'preview' ? '预发布' : '正式'}机校验 ${wanted.version} 没过（${sha !== wanted.sha256 ? 'sha256 不符' : '版本号不符'}），没有暂存` }
        if (next.builder) next = { ...next, builder: { ...next.builder, status: 'upload-failed', reasons: [reason] } }
      } else {
        const tag = report?.candidate?.version === wanted.version ? report.candidate.tag : next.builder?.candidate?.version === wanted.version ? next.builder.candidate.tag : null
        next = { ...next, staged: { version: wanted.version, sha256: sha, tag, at: now } }
        notes.push(`cpa: staged ${wanted.version}`)
        await prune(paths.cpa.staged, KEEP_STAGED, [wanted.version])
      }
    }
  }
  for (const name of await fs.readdir(inbox).catch(() => [])) if (name.endsWith('.bin')) await fs.rm(path.join(inbox, name), { force: true })
  return { state: next, notes, acceptance: taken }
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

/* ── real requests per OAuth account type (the install script's hook) ── */

/** CPA_PROBE_MODELS=`claude=claude-haiku-4-5,codex=gpt-5-codex-mini` → { claude: …, codex: … }. */
export function parseProbeModels(value) {
  const out = {}
  for (const item of String(value ?? '').split(',')) {
    const [service, model] = item.split('=').map(part => part?.trim())
    if (service && model && ACCOUNT_TYPE.test(service) && /^[\w.:/@-]{1,120}$/.test(model)) out[service] = model
  }
  return out
}

/** config.yaml's top-level `auth-dir:` (quotes and `~` handled); null when it has none. */
export async function configAuthDir(file) {
  try {
    const line = (await fs.readFile(file, 'utf8')).split(/\r?\n/).find(item => /^auth-dir\s*:/.test(item))
    const value = line?.replace(/^auth-dir\s*:\s*/, '').replace(/\s+#.*$/, '').trim().replace(/^(['"])(.*)\1$/, '$2')
    if (!value) return null
    return value.startsWith('~') ? path.join(os.homedir(), value.slice(1)) : value
  } catch {
    return null
  }
}

/** OAuth account types present in CPA's auth dir (enabled files only); only `type` is read out of each file. */
export async function accountTypes(dir) {
  const counts = new Map()
  for (const name of await fs.readdir(dir).catch(() => [])) {
    if (!name.endsWith('.json')) continue
    const value = await readJSON(path.join(dir, name), 1024 * 1024)
    if (!value || value.disabled === true || !ACCOUNT_TYPE.test(String(value.type ?? ''))) continue
    counts.set(value.type, (counts.get(value.type) ?? 0) + 1)
  }
  return [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([type, accounts]) => ({ type, accounts }))
}

/** <data>/system-keys.json → { service: key } (per-service probe keys; another package writes the file). */
export async function readProbeKeys(file) {
  const raw = await readJSON(file, 256 * 1024)
  if (!raw || raw.version !== 1 || !isObject(raw.probes)) return {}
  const out = {}
  for (const [service, key] of Object.entries(raw.probes)) {
    if (ACCOUNT_TYPE.test(service) && typeof key === 'string' && /^[\x21-\x7e]{8,512}$/.test(key)) out[service] = key
  }
  return out
}

/** Without a configured model: the cheapest-looking one the service's key may use, else the first in name order. */
export function pickProbeModel(ids) {
  const list = [...new Set(ids.filter(id => typeof id === 'string' && id))].sort()
  return list.find(id => /(haiku|mini|flash|lite|nano|small)/i.test(id) && !/(image|embed|tts|audio|vision-preview)/i.test(id))
    ?? list.find(id => !/(image|embed|tts|audio)/i.test(id)) ?? null
}

const scrub = (value, key) => String(value ?? '').split(key).join('***').replace(/\s+/g, ' ').slice(0, 160)

/**
 * One small real completion per OAuth account type, all in parallel, each bounded by the deadline the install script
 * gave. A type without a probe key is skipped and says so; no type at all is not a failure. Never returns a key.
 */
export async function runProbes({ types, keys, models = {}, reuse = {}, base, deadline, fetchImpl = fetch, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const results = await Promise.all(types.map(async ({ type }) => {
    const service = type
    const key = keys[service]
    if (!key) return { type, service, ok: null, skipped: 'no-probe-key', detail: `没有 ${service} 的系统探测 Key` }
    const headers = { authorization: `Bearer ${key}`, 'content-type': 'application/json' }
    const timeout = () => Math.min(PROBE_TIMEOUT_MS, deadline - now() - 250)
    let model = models[service] ?? reuse[service] ?? null
    if (!model && timeout() > 0) {
      try {
        const listed = await fetchImpl(`${base}/v1/models`, { headers, signal: AbortSignal.timeout(Math.min(5_000, timeout())) })
        const body = listed.ok ? await listed.json().catch(() => null) : (await listed.body?.cancel(), null)
        model = pickProbeModel(Array.isArray(body?.data) ? body.data.map(item => item?.id) : [])
      } catch { /* the completion below reports the failure */ }
    }
    if (!model) return { type, service, ok: false, detail: 'Key 没有可用模型（/v1/models 为空或不通）' }
    let last = { type, service, model, ok: false, detail: '没有剩余时间' }
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const budget = timeout()
      if (budget <= 0) break
      const started = now()
      try {
        const response = await fetchImpl(`${base}/v1/chat/completions`, {
          method: 'POST', headers, signal: AbortSignal.timeout(budget),
          body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Reply with the single word: ok' }], max_tokens: 64 }),
        })
        const text = await response.text()
        let body = null
        try { body = JSON.parse(text) } catch { /* not JSON */ }
        const ok = response.status === 200 && Array.isArray(body?.choices) && body.choices.length > 0
        last = { type, service, model, ok, status: response.status, ms: now() - started, attempt, ...(ok ? {} : { detail: scrub(`HTTP ${response.status} ${body?.error?.message ?? text}`, key) }) }
      } catch (error) {
        last = { type, service, model, ok: false, status: 0, ms: now() - started, attempt, detail: scrub(`${error?.name ?? 'Error'}: ${error?.message ?? error}`, key) }
      }
      if (last.ok || deadline - now() < 4_000) break
      await sleep(1_000)
    }
    return last
  }))
  const tested = results.filter(item => item.skipped === undefined)
  return { ok: tested.every(item => item.ok), results }
}

export function probeSummary({ ok, results }) {
  if (!results.length) return '没有 OAuth 账号，无需探测'
  return `${ok ? 'ok' : 'failed'}: ${results.map(item => (item.skipped ? `${item.type} 跳过（${item.detail}）` : `${item.type} ${item.ok ? '✓' : `✗ ${item.detail ?? ''}`.trim()}`)).join(' · ')}`
}

/** `kernel-applier.mjs probe`: what cpa-install-binary.sh runs before the swap, after it, and after a restore. */
export async function probeCommand({ paths, out, phase, budgetS, deps = {} }) {
  if (!['baseline', 'verify', 'restored'].includes(phase)) throw new Error('--phase baseline|verify|restored')
  const now = deps.now ?? Date.now
  const started = now()
  const deadline = started + Math.max(1, Math.min(600, Number(budgetS) || 20)) * 1000
  const authDir = paths.cpa.authDir ?? await configAuthDir(paths.cpa.config) ?? '/root/.cli-proxy-api'
  const types = await accountTypes(authDir)
  const keys = await readProbeKeys(paths.systemKeys)
  // after the swap: the same models the baseline used, so a pass/fail compares like with like
  const baseline = phase === 'baseline' ? null : await readJSON(path.join(out, 'probe-baseline.json'))
  const reuse = Object.fromEntries((baseline?.results ?? []).filter(item => item.model).map(item => [item.service, item.model]))
  const outcome = await runProbes({ types, keys, models: paths.cpa.probeModels, reuse, base: paths.cpa.probeBase, deadline, fetchImpl: deps.fetch ?? fetch, now, sleep: deps.sleep })
  const record = { version: 1, phase, at: iso(started), finishedAt: iso(now()), budgetS: Number(budgetS) || null, base: paths.cpa.probeBase, types, ...outcome }
  await writeAtomic(path.join(out, `probe-${phase}.json`), record)
  return record
}

async function readProbes(dir) {
  const out = {}
  for (const phase of ['baseline', 'verify', 'restored']) {
    const value = await readJSON(path.join(dir, `probe-${phase}.json`))
    if (value) out[phase] = { at: value.at, ok: value.ok === true, results: Array.isArray(value.results) ? value.results.slice(0, 20) : [] }
  }
  return out
}

/* ── CPA install (through cpa-install-binary.sh) ────────────────────── */

const epoch = value => (value ? iso(Number(value) * 1000) : null)

/**
 * Map cpa-install-binary.sh's exit + log lines to one result:
 * applied · up-to-date · refused (nothing touched: baseline gate or probe, hold, config changed, lock) · rolled-back ·
 * rollback-failed. `swapAt`/`restoreAt` are when the new binary went in and the old one came back.
 */
export function classifyInstall({ code, stdout }) {
  const lines = stdout.split('\n').map(line => line.trim()).filter(Boolean)
  const backup = /备份 (\/[^）)\s]+)/.exec(stdout)?.[1] ?? null
  const started = lines.some(line => line.startsWith('开始安装'))
  const last = lines.at(-1) ?? ''
  const swap = /swap-at=(\d+)/.exec(stdout)?.[1] ?? null
  const restore = /restore-at=(\d+)/.exec(stdout)?.[1] ?? null
  const times = { swapAt: epoch(swap), restoreAt: epoch(restore), restoreSeconds: swap && restore ? Number(restore) - Number(swap) : null }
  if (code === 0) return { result: lines.some(line => line.startsWith('线上已是')) ? 'up-to-date' : 'applied', backup, lines, ...times }
  // stopped (or failed to stop) and gave up before replacing anything: the binary is the old one
  if (!started || lines.some(line => line.includes('二进制未改动'))) return { result: 'refused', backup: null, lines, reason: last, ...times }
  if (lines.some(line => line.startsWith('已回滚到'))) return { result: 'rolled-back', backup, lines, reason: lines.find(line => /；准备回滚到/.test(line)) ?? last, ...times }
  return { result: 'rollback-failed', backup, lines, reason: lines.find(line => line.startsWith('严重')) ?? last, ...times }
}

const TRIM = line => line.replace(/（备份 [^）]*）/, '').slice(0, 200)

export async function applyCpa({ paths, state, version, deps = {} }) {
  if (await readHold(paths.cpa.hold)) return { result: 'refused', reason: '补丁锁（auto-update.hold）仍生效；不替换', lines: [] }
  const runner = deps.run ?? run
  const binary = path.join(paths.cpa.staged, version, 'cli-proxy-api')
  if (!await exists(binary) || await sha256File(binary) !== state.staged?.sha256) {
    return { result: 'refused', reason: '暂存的二进制不见了或被改过，等构建机重新上传', lines: [] }
  }
  const probes = path.join(paths.cpa.probes, `${iso((deps.now ?? Date.now)()).replace(/[:.]/g, '-')}-${version}`)
  await fs.mkdir(probes, { recursive: true, mode: 0o700 })
  // the install script runs the gates, backup, restart, the hook (real requests) and the restore (flock /run/cpa-auto-update.lock)
  const hook = [process.execPath, APPLIER, 'probe', '--out', probes]
  const out = await runner(paths.cpa.install, [binary, version, '--', ...hook], { timeoutMs: 15 * 60_000 })
  const outcome = { ...classifyInstall(out), probes: await readProbes(probes) }
  await prune(paths.cpa.probes, KEEP_PROBE_RUNS, [path.basename(probes)])
  return outcome
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

/**
 * preview: the trial failed. Roll back to what it replaced through the same install transaction (unless something else
 * already replaced it), spend nothing more on this version, and say why. The record is what the console shows.
 */
async function rejectTrial({ paths, cpa, reject, deps, now }) {
  const at = iso(now())
  let rollback = { result: 'not-needed' }
  if (!reject.noRollback) {
    try {
      rollback = await rollbackCpa({ paths, state: cpa, deps })
    } catch (error) {
      rollback = { result: 'refused', reason: String(error?.message || error).slice(0, 200) }
    }
  }
  const restored = rollback.result === 'applied'
  const outcome = restored ? 'rolled-back' : rollback.result === 'not-needed' ? 'voided' : rollback.result === 'refused' ? 'rollback-refused' : 'rollback-failed'
  const trial = { ...cpa.trial, status: 'rejected', rejected: { at, code: reject.code, reason: reject.reason, rollback: outcome, ...(rollback.reason ? { detail: TRIM(rollback.reason) } : {}) } }
  return {
    ...cpa,
    trial,
    attempts: { ...cpa.attempts, [trial.version]: Math.max(1, cpa.attempts[trial.version] || 0) },
    lastApply: { version: trial.version, from: trial.version, at, action: 'reject', result: outcome, backup: rollback.backup ?? null,
      reasons: [{ code: reject.code, text: reject.reason }, ...(rollback.reason && !restored ? [{ code: 'rollback', text: TRIM(rollback.reason) }] : [])] },
    ...(restored ? { applied: null, installed: { version: trial.previous, at } } : {}),
  }
}

/**
 * Preview, by hand: the binary preview already runs (installed outside the pipeline) becomes the trial, and is then
 * accepted, soaked and promoted like any build. It must be exactly the binary named (version and sha256). With the
 * previous version and its backup a rejection rolls back to it; without them a rejection needs a person.
 */
export async function adoptCpa({ paths, version, sha256, previous = null, backup = null, deps = {} }) {
  const now = deps.now ?? Date.now
  if ((paths.role ?? 'production') !== 'preview') throw new Error('adopt runs on preview only (AUTOUPDATE_ROLE=preview)')
  if (!CPA_VERSION.test(String(version)) || !SHA256.test(String(sha256))) throw new Error('--version <CPA version> --sha256 <64 hex>')
  if (Boolean(previous) !== Boolean(backup)) throw new Error('--previous and --backup go together')
  if (previous && !CPA_VERSION.test(previous)) throw new Error('--previous must be a CPA version')
  const cpa = await readState(paths, 'cpa')
  if (cpa.trial && TRIAL_ACTIVE.has(cpa.trial.status)) throw new Error(`${cpa.trial.version} is still on trial; adopt after it ends`)
  const running = await runningCpa(paths, deps)
  if (running !== version) throw new Error(`preview runs ${running ?? 'nothing'}, not ${version}`)
  const actual = await sha256File(paths.cpa.binary)
  if (actual !== sha256) throw new Error(`${paths.cpa.binary} has sha256 ${actual.slice(0, 12)}…, not ${sha256.slice(0, 12)}…`)
  if (backup) {
    if (!await exists(backup)) throw new Error(`backup ${backup} does not exist`)
    const was = await binaryVersion(backup, deps.run ?? run)
    if (was !== previous) throw new Error(`backup ${backup} reports ${was ?? 'no version'}, not ${previous}`)
  }
  const at = iso(now())
  const next = {
    ...cpa, env: 'preview',
    staged: { version, sha256, tag: cpa.staged?.version === version ? cpa.staged.tag ?? null : null, at },
    installed: { version, at },
    applied: previous ? { version, previous, backup, at } : null,
    attempts: { ...cpa.attempts, [version]: Math.max(1, cpa.attempts[version] || 0) },
    trial: startTrial({ version, sha256, previous, backup, at, policy: paths.policy ?? promotionPolicy({}) }),
    lastApply: { version, from: previous, at, action: 'adopt', result: 'adopted', backup, reasons: [] },
  }
  await saveState(paths, next)
  return { result: 'adopted', trial: next.trial }
}

export async function runAuto({ dryRun = false, paths = applierPaths(), deps = {} } = {}) {
  const now = deps.now ?? Date.now
  const config = normalizeConfig(await readJSON(paths.config))
  const role = paths.role ?? 'production'
  const policy = paths.policy ?? promotionPolicy({})
  const decide = (state, running, hold) => decideCpa({ now: now(), config, state, running, hold, role, policy })
  if (dryRun) {
    const [cpaState, magpieState, running, hold] = await Promise.all([readState(paths, 'cpa'), readState(paths, 'magpie'), runningCpa(paths, deps), readHold(paths.cpa.hold)])
    return { dryRun: true, role, config, running, cpa: decide(cpaState, running, hold), magpie: decideMagpie({ config, state: magpieState }) }
  }
  return withLock(paths.lock, async () => {
    const log = []
    for (const item of await takeRequests(paths)) log.push(await rollbackKernel({ paths, kernel: item.kernel, deps, now }))

    /* CPA */
    let cpa = await readState(paths, 'cpa')
    const ingested = await ingestCpa(paths, cpa, deps)
    cpa = { ...ingested.state, env: role, checkedAt: iso(now()) }
    log.push(...ingested.notes)
    let running = await runningCpa(paths, deps)

    if (role === 'preview' && cpa.trial && TRIAL_ACTIVE.has(cpa.trial.status)) {
      const before = cpa.trial.status
      let step = ingested.acceptance ? applyAcceptance({ trial: cpa.trial, record: ingested.acceptance, now: now() }) : null
      if (step?.note) log.push(`cpa: ${step.note}`)
      if (!step?.reject) {
        const runningSha = running && await exists(paths.cpa.binary) ? await sha256File(paths.cpa.binary).catch(() => null) : null
        const tick = trialTick({ trial: step?.trial ?? cpa.trial, running, runningSha })
        step = { ...step, ...tick }
      }
      cpa.trial = step.trial
      if (step.reject) {
        cpa = await rejectTrial({ paths, cpa, reject: step.reject, deps, now })
        log.push({ kernel: 'cpa', action: 'reject', version: cpa.trial.version, result: cpa.trial.rejected.rollback, reason: step.reject.code })
        running = await runningCpa(paths, deps)
      } else if (cpa.trial.status === 'accepted' && before !== 'accepted') {
        await writeAtomic(paths.cpa.promotion, promotionRecord(cpa.trial))
        log.push({ kernel: 'cpa', action: 'accept', version: cpa.trial.version, result: 'accepted' })
      }
    } else if (ingested.acceptance) {
      log.push(`cpa: acceptance for ${ingested.acceptance.candidate.version} ignored (no active trial)`)
    }

    cpa.installed = running ? { version: running, at: cpa.installed?.version === running ? cpa.installed.at : iso(now()) } : cpa.installed
    cpa.configLayout = await configLayout(paths.cpa.config)
    const decision = decide(cpa, running, await readHold(paths.cpa.hold))
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
        // a refused install touched nothing: it is retried (after a pause), the attempt is not spent
        attempts: touched ? { ...cpa.attempts, [decision.version]: (cpa.attempts[decision.version] || 0) + 1 } : cpa.attempts,
        lastApply: { version: decision.version, from: running, at, action: 'apply', result: outcome.result, backup: outcome.backup ?? null,
          reasons: outcome.reason ? [{ code: outcome.result, text: TRIM(outcome.reason) }] : [],
          swapAt: outcome.swapAt ?? null, restoreAt: outcome.restoreAt ?? null, restoreSeconds: outcome.restoreSeconds ?? null, probes: outcome.probes ?? {} },
        ...(outcome.result === 'applied' ? { applied: { version: decision.version, previous: running, backup: outcome.backup ?? null, at }, installed: { version: decision.version, at } } : {}),
        ...(outcome.result === 'applied' && role === 'preview'
          ? { trial: startTrial({ version: decision.version, sha256: cpa.staged.sha256, previous: running, backup: outcome.backup ?? null, at, policy }) }
          : {}),
        failures, nextAttemptAt: ok ? null : iso(now() + RETRY_MS),
      }
      log.push({ kernel: 'cpa', action: 'apply', version: decision.version, result: outcome.result })
      // what the console shows next is the state after the apply, not the decision that started it
      const after = outcome.result === 'refused' ? running : await runningCpa(paths, deps)
      cpa.configLayout = await configLayout(paths.cpa.config)
      cpa.decision = { ...decide(cpa, after, await readHold(paths.cpa.hold)), at: iso(now()) }
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
  } else if (action === 'adopt') {
    const outcome = await withLock(paths.lock, () => adoptCpa({ paths, version: arg('--version'), sha256: arg('--sha256'), previous: arg('--previous') ?? null, backup: arg('--backup') ?? null }))
    console.log(json(outcome))
  } else if (action === 'probe') {
    // called by cpa-install-binary.sh while `auto` holds the applier lock: no lock here
    const out = arg('--out')
    if (!out || !path.isAbsolute(out)) throw new Error('--out <absolute dir>')
    const record = await probeCommand({ paths, out, phase: arg('--phase'), budgetS: arg('--budget') })
    console.log(probeSummary(record))
    if (!record.ok) process.exitCode = 1
  } else {
    throw new Error('Use status, auto [--dry-run], rollback --kernel cpa|magpie --confirm, adopt --version <v> --sha256 <hex> [--previous <v> --backup <file>], or probe --out <dir> --phase <phase> --budget <s>')
  }
}

// realpath: systemd runs it through /opt/crosery-api-console-current (a symlink); import.meta.url is the resolved file
if (process.argv[1] && realpathSync(path.resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}

