#!/usr/bin/env node
/**
 * Promotion coordinator on the build machine (deploy/kernels/cpa-builder/run.sh calls it at the end of every round):
 * preview first, production only with preview's record. It never installs; each host's applier does.
 *
 *   node cpa-coordinator.mjs round --root <pipeline root>
 *
 * Reads <root>/state/report.json (this round's builder result) and the local candidate store
 * <root>/state/candidates/<version>/{cli-proxy-api,candidate.json}, asks both gates for their state, then per round:
 * 1. preview runs the trial candidate → run scripts/cpa-acceptance.mjs against preview's public API (after install, and
 *    again once the soak is over) and hand the result to preview (`cpa-accept`);
 * 2. preview accepted it → upload the same binary (sha256 checked against the store) + preview's promotion record to
 *    production (`cpa-upload`, `cpa-stage`, `cpa-promote`);
 * 3. the slot on preview is free (no trial, or the last one rejected or delivered) → upload this round's build to preview;
 * 4. report the round to both hosts (`cpa-report`) with where the candidate stands on preview;
 * 5. RTK: preview accepted a version → forward that record to production (`rtk-promote`).
 *
 * Environment (<root>/pipeline.env on the build machine, not in the repo):
 *   CPA_PIPELINE_PREVIEW / CPA_PIPELINE_PRODUCTION   command prefix that reaches each gate, e.g. `ssh -o BatchMode=yes <alias>`
 *   CPA_ACCEPT_BASE_URL / CPA_ACCEPT_KEY / CPA_ACCEPT_MODELS   preview's public API, a key for it, models to accept
 */
import fs from 'node:fs/promises'
import { createReadStream, realpathSync } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { pipeline } from 'node:stream/promises'
import { createGzip } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { compareVersions } from './autoupdate-common.mjs'
import { runAcceptance } from './cpa-acceptance.mjs'

const CPA_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/
const SHA256 = /^[a-f0-9]{64}$/
const KEEP_CANDIDATES = 4
const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const iso = ms => new Date(ms).toISOString()
/** `a` is the same as or newer than `b` (same x.y.z with another patch suffix counts as newer only when it differs) */
const atLeast = (a, b) => Boolean(a && b) && (a === b || compareVersions(a, b) > 0)

export function coordinatorConfig(env = process.env) {
  const prefix = name => {
    const words = String(env[name] ?? '').trim().split(/\s+/).filter(Boolean)
    if (!words.length) throw new Error(`${name} is not set (the command that reaches the gate, from pipeline.env)`)
    return words
  }
  const missing = ['CPA_ACCEPT_BASE_URL', 'CPA_ACCEPT_KEY', 'CPA_ACCEPT_MODELS'].filter(name => !String(env[name] ?? '').trim())
  if (missing.length) throw new Error(`${missing.join(', ')} not set: preview acceptance cannot run, nothing could ever be promoted`)
  return {
    preview: prefix('CPA_PIPELINE_PREVIEW'), production: prefix('CPA_PIPELINE_PRODUCTION'),
    accept: { baseUrl: env.CPA_ACCEPT_BASE_URL.trim(), key: env.CPA_ACCEPT_KEY.trim(), models: env.CPA_ACCEPT_MODELS },
  }
}

/* ── local candidate store (what this machine built and smoke-tested) ── */

export async function sha256File(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

export async function readStore(root) {
  const dir = path.join(root, 'state/candidates')
  const store = new Map()
  for (const name of await fs.readdir(dir).catch(() => [])) {
    if (!CPA_VERSION.test(name)) continue
    try {
      const candidate = JSON.parse(await fs.readFile(path.join(dir, name, 'candidate.json'), 'utf8'))
      if (candidate?.version === name && SHA256.test(String(candidate.sha256))) store.set(name, { ...candidate, binary: path.join(dir, name, 'cli-proxy-api') })
    } catch { /* an unreadable entry is not a candidate */ }
  }
  return store
}

/** Keep the newest few builds, and always the one still in flight on preview or production. */
export async function pruneStore(root, keep = KEEP_CANDIDATES, protect = []) {
  const dir = path.join(root, 'state/candidates')
  const names = (await fs.readdir(dir).catch(() => [])).filter(name => CPA_VERSION.test(name))
  const stats = await Promise.all(names.map(async name => ({ name, at: (await fs.stat(path.join(dir, name))).mtimeMs })))
  for (const { name } of stats.sort((a, b) => b.at - a.at).slice(keep)) {
    if (!protect.includes(name)) await fs.rm(path.join(dir, name), { recursive: true, force: true })
  }
}

/* ── the plan (pure) ─────────────────────────────────────────────────── */

const delivered = (production, version) => production?.promotion?.candidate?.version === version || atLeast(production?.installed?.version, version)

/**
 * What this round does, from the builder's report and both hosts' kernel state (null = that host did not answer).
 * One candidate is in flight at a time: preview takes the next build only once the last one was rejected or reached
 * production.
 */
export function planRound({ report, store, preview, production, now }) {
  const actions = []
  const trial = isObject(preview?.trial) ? preview.trial : null
  const previewRunning = preview?.installed?.version ?? null
  if (preview && trial && previewRunning === trial.version) {
    if (trial.status === 'installed' && !trial.acceptance?.first) actions.push({ kind: 'accept', phase: 'first', version: trial.version, sha256: trial.sha256 })
    else if (trial.status === 'soaking' && !trial.acceptance?.soak && now >= Date.parse(trial.soakUntil)) actions.push({ kind: 'accept', phase: 'soak', version: trial.version, sha256: trial.sha256 })
  }
  let promoting = false
  if (preview && production && trial?.status === 'accepted' && !delivered(production, trial.version) && !((production.attempts ?? {})[trial.version] >= 1)) {
    actions.push({ kind: 'promote', version: trial.version, sha256: trial.sha256 })
    promoting = true
  }
  const candidate = report?.status === 'built' ? report.candidate : null
  const slotFree = !trial || trial.status === 'rejected' || (trial.status === 'accepted' && (promoting || delivered(production, trial.version)))
  if (preview && candidate && slotFree && store.has(candidate.version) && store.get(candidate.version).sha256 === candidate.sha256
    && candidate.version !== previewRunning && preview.staged?.version !== candidate.version && !((preview.attempts ?? {})[candidate.version] >= 1)
    && (!previewRunning || compareVersions(candidate.version, previewRunning) >= 0)) {
    actions.push({ kind: 'upload-preview', version: candidate.version, sha256: candidate.sha256 })
  }
  return actions
}

/** Where the candidate stands on preview, for both consoles. */
export function previewStage({ preview, production, uploaded, now }) {
  const trial = isObject(preview?.trial) ? preview.trial : null
  if (uploaded) return { version: uploaded, stage: 'uploaded', soakUntil: null, at: iso(now), reason: null }
  if (!trial) return null
  const stage = trial.status === 'accepted' && delivered(production, trial.version) ? 'delivered' : trial.status
  return { version: trial.version, stage, soakUntil: trial.soakUntil ?? null, at: iso(now), reason: trial.rejected?.reason ?? null }
}

/** The builder's report as one host sees it: `up-to-date` when that host already runs the candidate. */
export function hostReport(report, host, stage) {
  const status = report.status === 'built' && report.candidate && host?.installed?.version === report.candidate.version ? 'up-to-date' : report.status
  return { ...report, status, preview: stage }
}

/**
 * RTK: preview's last accepted trial (kept as `accepted` while the next trial runs) as the record production checks;
 * production re-checks everything with its own policy.
 */
export function rtkForward({ preview, production }) {
  const trial = isObject(preview?.accepted) ? preview.accepted : null
  if (!trial || trial.status !== 'accepted' || !production) return null
  if (production.promotion?.candidate?.version === trial.version || atLeast(production.local, trial.version)) return null
  return {
    version: 1, kind: 'rtk-promotion', candidate: { version: trial.version, tag: trial.tag, sha256: trial.sha256, asset: trial.asset },
    installedAt: trial.installedAt, checks: trial.checks, acceptedAt: trial.acceptedAt,
  }
}

/* ── gates ──────────────────────────────────────────────────────────── */

/** Run one gate command; `file` is streamed gzip-compressed on stdin, `input` as is. Never rejects. */
export function gateCall(prefix, command, { input = '', file = null, timeoutMs = 10 * 60_000 } = {}) {
  return new Promise(resolve => {
    const child = spawn(prefix[0], [...prefix.slice(1), command], { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', error => { clearTimeout(timer); resolve({ code: 127, stdout, stderr: String(error.message) }) })
    child.on('close', code => { clearTimeout(timer); resolve({ code: code ?? 1, stdout, stderr }) })
    child.stdin.on('error', () => undefined)
    if (file) pipeline(createReadStream(file), createGzip(), child.stdin).catch(() => child.kill('SIGKILL'))
    else child.stdin.end(input)
  })
}

const parseState = out => {
  if (out.code !== 0) return null
  try { const value = JSON.parse(out.stdout); return isObject(value) ? value : null } catch { return null }
}

/* ── the round ──────────────────────────────────────────────────────── */

export async function runRound({ root, env = process.env, deps = {} }) {
  const config = coordinatorConfig(env)
  const now = deps.now ?? Date.now
  const call = deps.gate ?? gateCall
  const accept = deps.accept ?? runAcceptance
  const log = []
  const errors = []
  const report = JSON.parse(await fs.readFile(path.join(root, 'state/report.json'), 'utf8'))
  const store = await readStore(root)
  const [preview, production] = await Promise.all([parseState(await call(config.preview, 'cpa-state')), parseState(await call(config.production, 'cpa-state'))])
  if (!preview) errors.push('preview gate did not answer cpa-state')
  if (!production) errors.push('production gate did not answer cpa-state')
  const actions = planRound({ report, store, preview, production, now: now() })
  let uploaded = null
  let previewReport = report
  // the next build goes to preview only after the accepted one really reached production (its record lives on preview
  // until the next trial is accepted, so a failed delivery is retried next round)
  let promotionFailed = false
  for (const action of actions) {
    if (action.kind === 'accept') {
      const result = await accept({ ...config.accept, expectVersion: action.version })
      const record = { version: 1, kind: 'cpa-acceptance', phase: action.phase, candidate: { version: action.version, sha256: action.sha256 },
        ranAt: result.ranAt, ok: result.ok, checks: result.checks, summary: result.summary }
      await fs.appendFile(path.join(root, 'state/acceptance.jsonl'), `${JSON.stringify(record)}\n`)
      const sent = await call(config.preview, 'cpa-accept', { input: JSON.stringify(record) })
      if (sent.code !== 0) errors.push(`cpa-accept failed: ${sent.stdout.trim() || sent.stderr.trim()}`.slice(0, 200))
      log.push(`acceptance ${action.phase} ${action.version}: ${result.ok ? 'passed' : `failed (${result.summary})`}`)
    } else if (action.kind === 'promote') {
      const local = store.get(action.version)
      const record = parseState(await call(config.preview, 'cpa-promotion'))
      const problem = !local ? `${action.version} is no longer in the local store`
        : record?.kind !== 'cpa-promotion' || record.candidate?.version !== action.version || record.candidate?.sha256 !== action.sha256 ? `preview's promotion record is not for ${action.version}`
          : local.sha256 !== action.sha256 || await sha256File(local.binary).catch(() => null) !== action.sha256 ? `local ${action.version} does not match the sha256 preview accepted`
            : null
      if (problem) { errors.push(`promote: ${problem}`); promotionFailed = true; continue }
      const steps = [['cpa-upload', { file: local.binary }], [`cpa-stage ${action.version}`, {}], ['cpa-promote', { input: JSON.stringify(record) }]]
      let failed = null
      for (const [command, options] of steps) {
        const out = await call(config.production, command, options)
        if (out.code !== 0) { failed = `${command.split(' ')[0]}: ${(out.stdout.trim() || out.stderr.trim()).slice(0, 160)}`; break }
      }
      if (failed) {
        errors.push(`promote ${action.version} to production failed at ${failed}`)
        promotionFailed = true
      } else {
        log.push(`promoted ${action.version} to production`)
        if (production) production.promotion = { candidate: { version: action.version, sha256: action.sha256 } }
      }
    } else if (action.kind === 'upload-preview') {
      if (promotionFailed) { log.push(`${action.version} waits: the accepted candidate has not reached production yet`); continue }
      const local = store.get(action.version)
      const steps = [['cpa-upload', { file: local.binary }], [`cpa-stage ${action.version}`, {}]]
      let failed = null
      for (const [command, options] of steps) {
        const out = await call(config.preview, command, options)
        if (out.code !== 0) { failed = `${command.split(' ')[0]}: ${(out.stdout.trim() || out.stderr.trim()).slice(0, 160)}`; break }
      }
      if (failed) {
        errors.push(`upload ${action.version} to preview failed at ${failed}`)
        previewReport = { ...report, status: 'upload-failed', reasons: [{ code: 'upload-failed', text: `上传到预发布失败（${failed}）` }] }
      } else {
        uploaded = action.version
        log.push(`uploaded ${action.version} to preview`)
      }
    }
  }
  const stage = previewStage({ preview, production, uploaded, now: now() })
  for (const [name, target, host, body] of [['preview', config.preview, preview, previewReport], ['production', config.production, production, report]]) {
    const sent = await call(target, 'cpa-report', { input: JSON.stringify(hostReport(body, host, stage)) })
    if (sent.code !== 0) errors.push(`report to ${name} failed`)
  }

  /* RTK */
  const [rtkPreview, rtkProduction] = await Promise.all([parseState(await call(config.preview, 'rtk-state')), parseState(await call(config.production, 'rtk-state'))])
  const forward = rtkForward({ preview: rtkPreview, production: rtkProduction })
  if (forward) {
    const sent = await call(config.production, 'rtk-promote', { input: JSON.stringify(forward) })
    if (sent.code !== 0) errors.push(`rtk-promote ${forward.candidate.version} failed`)
    else log.push(`rtk ${forward.candidate.version} promoted to production`)
  }

  const inFlight = [preview?.trial?.version, preview?.staged?.version, production?.staged?.version].filter(Boolean)
  await pruneStore(root, KEEP_CANDIDATES, inFlight)
  return { actions, log, errors, stage }
}

async function main() {
  const at = process.argv.indexOf('--root')
  if (process.argv[2] !== 'round' || at < 0 || !process.argv[at + 1]) throw new Error('Use: cpa-coordinator.mjs round --root <pipeline root>')
  const result = await runRound({ root: path.resolve(process.argv[at + 1]) })
  for (const line of result.log) console.log(line)
  for (const line of result.errors) console.error(line)
  if (result.errors.length) process.exitCode = 1
}

if (process.argv[1] && realpathSync(path.resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}
