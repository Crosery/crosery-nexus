import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import type express from 'express'

/**
 * 「自动更新」: the console's side of scripts/magpie-autoupdate.mjs + scripts/rtk-autoupdate.mjs.
 *
 * The console only writes the switches (<runtime>/autoupdate.json) and reads what the scheduled job recorded
 * (autoupdate-magpie.json, autoupdate-rtk.json). It never rehearses, swaps or restarts anything itself: applying a
 * kernel restarts the console, so that runs in launchd's job process (magpie-upstream.mjs scheduled). The one action
 * it runs is a dry run (`auto --dry-run`, `rtk plan`) and a confirmed manual rtk upgrade, as child processes.
 * The words every surface shows (设置、同步中心、cradmin) are built here, once.
 */

export type AutoWindow = { start: string; end: string }
export type AutoConfig = { version: 1; magpie: { enabled: boolean; window: AutoWindow }; rtk: { enabled: boolean }; updatedAt?: string }
export type AutoReason = { code: string; text: string }
export type SchedulerMode = 'auto' | 'check-only' | 'missing' | 'unsupported'
export type AutoTone = 'ok' | 'warn' | 'bad' | 'idle'

export type MagpieAutoView = {
  /** the switch can be used here (a local Magpie kernel) */
  available: boolean
  enabled: boolean
  scheduler: SchedulerMode
  window: AutoWindow
  state: 'cpa' | 'off' | 'no-scheduler' | 'check-only' | 'up-to-date' | 'pending' | 'held' | 'eligible' | 'applied' | 'rolled-back' | 'error' | 'blocked'
  tone: AutoTone
  /** the one line under the switch */
  line: string
  /** short words for the sync-center row (after 「检查 · 自动更新开」) */
  brief: string
  candidate: string | null
  release: string | null
  reasons: AutoReason[]
  applied: { revision: string; release: string | null; at: string } | null
  lastApply: { revision: string; at: string; result: string } | null
  nextWindowAt: string | null
  checkedAt: string | null
}

export type RtkAutoView = {
  available: boolean
  enabled: boolean
  scheduler: SchedulerMode
  state: 'off' | 'no-scheduler' | 'check-only' | 'missing' | 'homebrew' | 'up-to-date' | 'pending' | 'held' | 'upgraded' | 'error' | 'unknown'
  tone: AutoTone
  line: string
  brief: string
  local: string | null
  latest: string | null
  method: string | null
  reasons: AutoReason[]
  lastUpgrade: { from: string | null; to: string; at: string; result: string } | null
  checkedAt: string | null
}

export type AutoupdateView = { magpie: MagpieAutoView; rtk: RtkAutoView }

export type AutoupdatePaths = {
  runtime: string
  config: string
  magpieState: string
  rtkState: string
  lease: string
  status: string
  launchAgentsDir: string
}

export const AUTO_CHECK_LABEL = 'com.crosery.magpie-upstream-check'
export const DEFAULT_WINDOW: AutoWindow = { start: '03:00', end: '06:00' }
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/
const SHA = /^[a-f0-9]{40}$/
const TAG = /^v?\d+\.\d+\.\d+[-.a-zA-Z0-9]*$/
const MAX_FILE_BYTES = 1024 * 1024

export function autoupdatePaths(env: NodeJS.ProcessEnv = process.env): AutoupdatePaths {
  return autoupdatePathsFor(path.resolve(env.MAGPIE_UPSTREAM_RUNTIME || path.join(os.homedir(), '.agents/crosery/magpie-upstream')))
}

export function autoupdatePathsFor(runtime: string, launchAgentsDir = path.join(os.homedir(), 'Library/LaunchAgents')): AutoupdatePaths {
  return {
    runtime,
    config: path.join(runtime, 'autoupdate.json'),
    magpieState: path.join(runtime, 'autoupdate-magpie.json'),
    rtkState: path.join(runtime, 'autoupdate-rtk.json'),
    lease: path.join(runtime, 'signin-active.json'),
    status: path.join(runtime, 'status.json'),
    launchAgentsDir,
  }
}

/**
 * Sync-center row words: 「检查 · 自动更新开 · 7547dfb 停在待复核」. `plain` is what the row said before auto-update
 * existed (待复核 / 无变化 / 可升级 …); it stays when auto-update is off or not in effect, so nothing is hidden.
 */
export function autoRowWords(view: MagpieAutoView | RtkAutoView, plain: string): string {
  const noun = 'candidate' in view ? '更新' : '升级'
  if (view.state === 'cpa') return `检查 · ${view.brief}`
  if (view.state === 'off') return ['检查', `自动${noun}关`, plain].filter(Boolean).join(' · ')
  if (view.state === 'no-scheduler' || view.state === 'check-only') return ['检查', `自动${noun}未生效`, plain].filter(Boolean).join(' · ')
  return `检查 · 自动${noun}开 · ${view.brief}`
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    const stat = fs.lstatSync(file)
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null
    const value = JSON.parse(fs.readFileSync(file, 'utf8'))
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
  } catch {
    return null
  }
}

function writeAtomic(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  try { fs.renameSync(temporary, file) } finally { fs.rmSync(temporary, { force: true }) }
}

const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const str = (value: unknown): string | null => (typeof value === 'string' && value ? value : null)
const sha = (value: unknown): string | null => (typeof value === 'string' && SHA.test(value) ? value : null)
const tag = (value: unknown): string | null => (typeof value === 'string' && TAG.test(value) ? value : null)
const when = (value: unknown): number | null => { const at = typeof value === 'string' ? Date.parse(value) : NaN; return Number.isFinite(at) ? at : null }
const short = (revision: string | null) => (revision ? revision.slice(0, 7) : '')

export function parseWindow(value: unknown): AutoWindow | null {
  if (!isObject(value)) return null
  const start = String(value.start ?? '')
  const end = String(value.end ?? '')
  return HHMM.test(start) && HHMM.test(end) && start !== end ? { start, end } : null
}

/** Same rules as scripts/magpie-autoupdate-policy.mjs normalizeConfig: a missing file or field means ON. */
export function readAutoConfig(file: string): AutoConfig {
  const raw = readJson(file) ?? {}
  const magpie = isObject(raw.magpie) ? raw.magpie : {}
  const rtk = isObject(raw.rtk) ? raw.rtk : {}
  return {
    version: 1,
    magpie: { enabled: magpie.enabled !== false, window: parseWindow(magpie.window) ?? { ...DEFAULT_WINDOW } },
    rtk: { enabled: rtk.enabled !== false },
    ...(typeof raw.updatedAt === 'string' ? { updatedAt: raw.updatedAt } : {}),
  }
}

export type AutoConfigPatch = { magpie?: { enabled?: unknown; window?: unknown }; rtk?: { enabled?: unknown } }

export class AutoConfigError extends Error {
  constructor(message: string) { super(message) }
}

/** Validates a PUT body strictly (unknown keys, non-booleans and bad windows are 400s) and writes atomically. */
export function writeAutoConfig(file: string, patch: unknown, now = Date.now()): AutoConfig {
  if (!isObject(patch)) throw new AutoConfigError('请求体必须是对象')
  const unknown = Object.keys(patch).filter(key => key !== 'magpie' && key !== 'rtk')
  if (unknown.length) throw new AutoConfigError(`不认识的字段：${unknown.join(', ')}`)
  const current = readAutoConfig(file)
  const next: AutoConfig = { version: 1, magpie: { ...current.magpie }, rtk: { ...current.rtk } }
  if (patch.magpie !== undefined) {
    if (!isObject(patch.magpie) || Object.keys(patch.magpie).some(key => key !== 'enabled' && key !== 'window')) throw new AutoConfigError('magpie 只接受 enabled / window')
    if (patch.magpie.enabled !== undefined) {
      if (typeof patch.magpie.enabled !== 'boolean') throw new AutoConfigError('magpie.enabled 必须是布尔值')
      next.magpie.enabled = patch.magpie.enabled
    }
    if (patch.magpie.window !== undefined) {
      const window = parseWindow(patch.magpie.window)
      if (!window) throw new AutoConfigError('窗口要写成 {"start":"HH:MM","end":"HH:MM"}，且起止不同')
      next.magpie.window = window
    }
  }
  if (patch.rtk !== undefined) {
    if (!isObject(patch.rtk) || Object.keys(patch.rtk).some(key => key !== 'enabled') || typeof patch.rtk.enabled !== 'boolean') throw new AutoConfigError('rtk 只接受 {"enabled": 布尔值}')
    next.rtk.enabled = patch.rtk.enabled
  }
  next.updatedAt = new Date(now).toISOString()
  writeAtomic(file, next)
  return next
}

/** What the installed LaunchAgent runs: `scheduled` (check + auto-update), only `check`, or nothing. Read-only. */
export function readScheduler(directory: string, platform: NodeJS.Platform = process.platform): SchedulerMode {
  if (platform !== 'darwin') return 'unsupported'
  try {
    const xml = fs.readFileSync(path.join(directory, `${AUTO_CHECK_LABEL}.plist`), 'utf8')
    return /<string>scheduled<\/string>/.test(xml) ? 'auto' : 'check-only'
  } catch {
    return 'missing'
  }
}

/** Kernel start of the next quiet window (local time of this host). */
export function nextWindowStart(now: number, window: AutoWindow): number {
  const [h, m] = window.start.split(':').map(Number)
  const next = new Date(now)
  next.setSeconds(0, 0)
  next.setHours(h, m)
  if (next.getTime() <= now) next.setDate(next.getDate() + 1)
  return next.getTime()
}

/** `02:14` today, `10/02 02:14` otherwise (this host's time zone, the one the window is in). */
export function clock(at: number, now: number): string {
  const d = new Date(at)
  const n = new Date(now)
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return d.toDateString() === n.toDateString() ? hm : `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} ${hm}`
}

function reasons(value: unknown): AutoReason[] {
  if (!Array.isArray(value)) return []
  return value.filter(isObject).slice(0, 20).map(item => ({ code: String(item.code ?? '').slice(0, 40), text: String(item.text ?? '').slice(0, 300) })).filter(item => item.text)
}

const firstReason = (list: AutoReason[]) => (list.length ? `${list[0].text}${list.length > 1 ? `（另有 ${list.length - 1} 项）` : ''}` : '')

function compareVersions(left: string, right: string): number {
  const parts = (value: string) => value.replace(/^v/i, '').split(/[.+-]/).slice(0, 3).map(part => Number.parseInt(part, 10) || 0)
  const [a, b] = [parts(left), parts(right)]
  for (let i = 0; i < 3; i += 1) { const d = (a[i] ?? 0) - (b[i] ?? 0); if (d) return d }
  return 0
}

export type AutoupdateFacts = {
  config: AutoConfig
  scheduler: SchedulerMode
  /** GATEWAY_ENGINE=magpie with the local control plane: there is a kernel on this host to update */
  magpieLocal: boolean
  magpieState: Record<string, unknown> | null
  rtkState: Record<string, unknown> | null
  upstream: Record<string, unknown> | null
  /** the kernel revision answering now; null = offline / unknown */
  running: string | null
  rtkLocal: string | null
}

function schedulerGate(scheduler: SchedulerMode, noun: '更新' | '升级'): { state: 'no-scheduler' | 'check-only'; line: string; brief: string } | null {
  if (scheduler === 'auto') return null
  if (scheduler === 'check-only') return { state: 'check-only', line: `定时任务还是只检查的旧版本 · 重装后才会自动${noun}`, brief: `自动${noun}未生效` }
  return { state: 'no-scheduler', line: scheduler === 'unsupported' ? `这台机器没有 launchd 定时任务 · 开着也不会自动${noun}` : `没有安装定时任务 · 开着也不会自动${noun}`, brief: `自动${noun}未生效` }
}

export function buildMagpieAuto(facts: AutoupdateFacts, now: number): MagpieAutoView {
  const window = facts.config.magpie.window
  const label = `${window.start}–${window.end}`
  const s = facts.magpieState ?? {}
  const up = facts.upstream ?? {}
  const candidate = sha(up.candidateRevision)
  const pendingUpstream = up.status === 'review_required' || (up.status === 'error' && Boolean(candidate))
  const appliedRaw = isObject(s.applied) ? s.applied : null
  const applied = appliedRaw && sha(appliedRaw.revision) && str(appliedRaw.at)
    ? { revision: appliedRaw.revision as string, release: tag(appliedRaw.release), at: appliedRaw.at as string } : null
  const lastRaw = isObject(s.lastApply) ? s.lastApply : null
  const lastApply = lastRaw && sha(lastRaw.revision) && str(lastRaw.at) && str(lastRaw.result)
    ? { revision: lastRaw.revision as string, at: lastRaw.at as string, result: lastRaw.result as string } : null
  const base = {
    available: facts.magpieLocal, enabled: facts.config.magpie.enabled, scheduler: facts.scheduler, window,
    candidate, release: tag(up.latestRelease), applied, lastApply,
    nextWindowAt: new Date(nextWindowStart(now, window)).toISOString(), checkedAt: str(s.checkedAt),
  }
  const view = (state: MagpieAutoView['state'], tone: AutoTone, line: string, brief: string, list: AutoReason[] = []): MagpieAutoView =>
    ({ ...base, state, tone, line, brief, reasons: list })
  const rev = short(candidate)
  if (!facts.magpieLocal) return view('cpa', 'idle', '仅本机 Magpie 网关 · 这里的网关是 CPA，没有内核可更新', '仅本机 Magpie 网关')
  if (!facts.config.magpie.enabled) return view('off', 'idle', '已关闭 · 只检查上游，不演练、不替换', '自动更新关')
  const gate = schedulerGate(facts.scheduler, '更新')
  if (gate) return view(gate.state, 'warn', gate.line, gate.brief)
  const stateReasons = reasons(s.reasons)
  const ruled = sha(s.candidate) === candidate
  // the newest event wins: an apply of the current candidate, then its verdict, then the plain state
  if (lastApply && lastApply.revision === candidate && lastApply.result === 'rolled-back-manually') {
    return view('rolled-back', 'warn', `${clock(Date.parse(lastApply.at), now)} 已手动回滚 ${rev} · 不再自动替换这个版本`, `${rev} 已手动回滚`)
  }
  if (lastApply && lastApply.revision === candidate && lastApply.result !== 'applied') {
    const rolled = lastApply.result === 'rolled-back'
    return view('rolled-back', 'bad', rolled
      ? `${clock(Date.parse(lastApply.at), now)} 替换 ${rev} 失败已回滚：${firstReason(stateReasons) || '健康检查没通过'} · 不再自动重试这个版本`
      : `${clock(Date.parse(lastApply.at), now)} 替换 ${rev} 失败，${lastApply.result === 'rollback-failed' ? '回滚也没通过 · 需要人工处理' : `停住：${firstReason(stateReasons)}`}`,
    `${rev} 替换失败`, stateReasons)
  }
  if (applied && (!pendingUpstream || candidate === applied.revision) && (facts.running === null || facts.running === applied.revision)) {
    return view('applied', 'ok', `上次 ${clock(Date.parse(applied.at), now)} 自动替换到 ${short(applied.revision)}${applied.release ? ` · ${applied.release}` : ''} · 下次窗口 ${label}`,
      `已更新到 ${short(applied.revision)}`)
  }
  if (!pendingUpstream || !candidate || candidate === facts.running) return view('up-to-date', 'ok', `没有新候选 · 有了先演练，兼容才在 ${label} 替换`, '无变化')
  if (ruled && s.why === 'held') return view('held', 'warn', `停在待复核：${firstReason(stateReasons)}`, `${rev} 停在待复核`, stateReasons)
  if (ruled && (s.why === 'error' || s.why === 'backoff')) {
    const retry = when(s.nextAttemptAt)
    return view('error', 'warn', `演练没跑完：${firstReason(stateReasons) || '出错'}${retry ? ` · ${clock(retry, now)} 重试` : ''}`, `${rev} 演练出错`, stateReasons)
  }
  if (ruled && (s.why === 'window' || s.why === 'signin' || s.result === 'eligible')) {
    return view('eligible', 'ok', `${rev} 演练通过 · ${s.why === 'signin' ? '等登录结束再替换' : `等 ${label} 窗口替换`}`, `${rev} 等 ${label}`)
  }
  if (ruled && (s.why === 'kernel-offline' || s.why === 'running-unknown')) {
    return view('blocked', 'warn', s.why === 'kernel-offline' ? '内核离线 · 不替换' : '运行中的内核不是基线也不是上次自动更新的版本 · 不动它', `${rev} 未替换`)
  }
  return view('pending', 'idle', `候选 ${rev} 等下一轮定时任务演练`, `${rev} 待演练`)
}

export function buildRtkAuto(facts: AutoupdateFacts, now: number): RtkAutoView {
  const s = facts.rtkState ?? {}
  const latest = tag(facts.upstream?.rtkRelease) ?? tag(s.latest)
  const local = facts.rtkLocal ?? str(s.local)
  const lastRaw = isObject(s.lastUpgrade) ? s.lastUpgrade : null
  const lastUpgrade = lastRaw && str(lastRaw.to) && str(lastRaw.at) && str(lastRaw.result)
    ? { from: str(lastRaw.from), to: lastRaw.to as string, at: lastRaw.at as string, result: lastRaw.result as string } : null
  const list = reasons(s.reasons)
  const base = { available: true, enabled: facts.config.rtk.enabled, scheduler: facts.scheduler, local, latest, method: str(s.method), lastUpgrade, checkedAt: str(s.checkedAt) }
  const view = (state: RtkAutoView['state'], tone: AutoTone, line: string, brief: string, r: AutoReason[] = []): RtkAutoView => ({ ...base, state, tone, line, brief, reasons: r })
  const newer = Boolean(latest && local && compareVersions(latest, local) > 0)
  if (!facts.config.rtk.enabled) return view('off', 'idle', '已关闭 · 只检查新版本，不下载、不替换', '自动升级关')
  if (!local && s.why === 'missing') return view('missing', 'idle', '本机没有安装 rtk', '本机未安装')
  if (s.method === 'homebrew') return view('homebrew', 'idle', 'Homebrew 安装的 rtk · 自动升级走 brew upgrade rtk', 'brew 管理')
  const gate = schedulerGate(facts.scheduler, '升级')
  if (gate) return view(gate.state, 'warn', gate.line, gate.brief)
  if (lastUpgrade && lastUpgrade.result === 'upgraded' && local && compareVersions(local, lastUpgrade.to) === 0 && !newer) {
    return view('upgraded', 'ok', `上次 ${clock(Date.parse(lastUpgrade.at), now)} 自动升级到 ${lastUpgrade.to}`, `已升级到 ${lastUpgrade.to}`)
  }
  if (!newer) return view('up-to-date', 'ok', latest ? `已是最新 ${latest}` : '还没取到 rtk 最新版本', latest ? '无变化' : '未取到最新版本')
  const ruled = tag(s.latest) === latest
  if (ruled && s.why === 'breaking') return view('held', 'warn', `停在待复核：${firstReason(list)}`, `${latest} 停在待复核 · 本机 ${local}`, list)
  if (ruled && s.why === 'verify-failed') return view('error', 'bad', `${latest} 没通过校验，不再自动重试：${firstReason(list)}`, `${latest} 校验未过`, list)
  if (ruled && (s.why === 'rolled-back' || lastUpgrade?.result === 'rolled-back' || lastUpgrade?.result === 'rollback-failed')) {
    return view('error', 'bad', `升级到 ${latest} 后自检没过${lastUpgrade?.result === 'rollback-failed' ? '，回滚也没通过 · 需要人工处理' : '，已回滚'}`, `${latest} 已回滚`, list)
  }
  if (ruled && (s.why === 'error' || s.why === 'rate-limited' || s.why === 'unwritable' || s.why === 'no-release')) {
    const retry = Math.max(when(s.nextAttemptAt) ?? 0, when(s.retryNotBefore) ?? 0)
    return view('error', 'warn', `${firstReason(list) || '没升级成功'}${retry > now ? ` · ${clock(retry, now)} 再试` : ''}`, `${latest} 未升级`, list)
  }
  return view('pending', 'idle', `可升级 ${latest} · 本机 ${local} · 下一轮定时任务升级`, `可升级 ${latest} · 本机 ${local}`)
}

export function buildAutoupdateView(facts: AutoupdateFacts, now = Date.now()): AutoupdateView {
  return { magpie: buildMagpieAuto(facts, now), rtk: buildRtkAuto(facts, now) }
}

/** Facts from this host's files only (no network, no child process); `running` / `rtkLocal` come from the caller. */
export function readAutoupdateFacts(paths: AutoupdatePaths, extra: { magpieLocal: boolean; running: string | null; rtkLocal: string | null; platform?: NodeJS.Platform }): AutoupdateFacts {
  return {
    config: readAutoConfig(paths.config),
    scheduler: readScheduler(paths.launchAgentsDir, extra.platform),
    magpieLocal: extra.magpieLocal,
    magpieState: readJson(paths.magpieState),
    rtkState: readJson(paths.rtkState),
    upstream: readJson(paths.status),
    running: extra.running,
    rtkLocal: extra.rtkLocal,
  }
}

/** The kernel revision the scheduled job last applied, for the version model (an auto-applied kernel is not a baseline mismatch). */
export function readAutoAppliedRevision(paths: AutoupdatePaths = autoupdatePaths()): string | null {
  const state = readJson(paths.magpieState)
  return isObject(state?.applied) ? sha(state.applied.revision) : null
}

/* ── sign-in lease: the scheduled job never restarts the kernel while one is live ── */

export function writeSigninLease(file: string, live: Array<{ deadline: number }>, now = Date.now()): void {
  try {
    if (!live.length) { fs.rmSync(file, { force: true }); return }
    const until = Math.max(...live.map(item => item.deadline)) + 60_000
    writeAtomic(file, { live: live.length, until: new Date(Math.max(until, now)).toISOString(), pid: process.pid, at: new Date(now).toISOString() })
  } catch {
    // the lease only delays an auto-apply; failing to write it must not fail a sign-in
  }
}

/* ── routes ── */

export type AutoupdateRouteDeps = {
  addAudit: (action: string, target: string, detail?: string) => void
  repoRoot: string
  magpieLocal: () => boolean
  running: () => Promise<string | null>
  rtkLocal: () => Promise<string | null>
  paths?: () => AutoupdatePaths
  /** runs `node <script> <args>`; injectable for tests */
  runScript?: (script: string, args: string[], timeoutMs: number) => Promise<{ code: number; stdout: string; stderr: string }>
}

const defaultRunScript = (script: string, args: string[], timeoutMs: number) => new Promise<{ code: number; stdout: string; stderr: string }>(resolve => {
  execFile(process.execPath, [script, ...args], { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
    const code = error && typeof (error as { code?: unknown }).code === 'number' ? Number((error as { code: number }).code) : error ? 1 : 0
    resolve({ code, stdout: String(stdout || ''), stderr: String(stderr || '') })
  })
})

function parseLastJson(stdout: string): Record<string, unknown> | null {
  const text = stdout.trim()
  if (!text) return null
  try { return JSON.parse(text) as Record<string, unknown> } catch { /* multi-line pretty JSON is the whole output; fall through */ }
  return null
}

export function registerAutoupdateRoutes(app: express.Express, deps: AutoupdateRouteDeps): void {
  const paths = deps.paths ?? (() => autoupdatePaths())
  const runScript = deps.runScript ?? defaultRunScript
  const view = async () => {
    const [running, rtkLocal] = await Promise.all([deps.running().catch(() => null), deps.rtkLocal().catch(() => null)])
    return buildAutoupdateView(readAutoupdateFacts(paths(), { magpieLocal: deps.magpieLocal(), running, rtkLocal }))
  }

  app.get('/api/autoupdate', async (_req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.json(await view())
  })

  app.put('/api/autoupdate', async (req, res) => {
    try {
      const next = writeAutoConfig(paths().config, req.body)
      deps.addAudit('autoupdate_config', 'local', `magpie=${next.magpie.enabled ? 'on' : 'off'} window=${next.magpie.window.start}-${next.magpie.window.end} rtk=${next.rtk.enabled ? 'on' : 'off'}`)
      res.json(await view())
    } catch (error) {
      if (error instanceof AutoConfigError) return res.status(400).json({ error: error.message, code: 'invalid_autoupdate' })
      res.status(500).json({ error: error instanceof Error ? error.message : '保存失败' })
    }
  })

  /**
   * { target: 'magpie', dryRun: true }           → what the scheduled job would do now (read-only)
   * { target: 'rtk', dryRun: true }              → resolve + download + verify into a temp dir; nothing replaced
   * { target: 'rtk', dryRun: false, confirm: true } → upgrade rtk now (backup, atomic swap, verify, roll back)
   * A real magpie run is refused: applying restarts this process, so only the launchd job may do it.
   */
  app.post('/api/autoupdate/run', async (req, res) => {
    const target = req.body?.target
    const dryRun = req.body?.dryRun !== false
    if (target !== 'magpie' && target !== 'rtk') return res.status(400).json({ error: 'target 只能是 magpie / rtk', code: 'invalid_target' })
    if (target === 'magpie' && !dryRun) {
      return res.status(409).json({ error: '内核的自动更新只在 launchd 定时任务里执行（替换会重启控制台本身）；这里只能 dryRun', code: 'scheduled_only' })
    }
    if (target === 'rtk' && !dryRun && req.body?.confirm !== true) {
      deps.addAudit('autoupdate_run', 'rtk', 'refused:missing-confirm')
      return res.status(403).json({ error: '升级 rtk 需要显式确认（body 需要 {"confirm": true}）', code: 'confirm_required' })
    }
    const script = path.join(deps.repoRoot, target === 'magpie' ? 'scripts/magpie-autoupdate.mjs' : 'scripts/rtk-autoupdate.mjs')
    const args = target === 'magpie' ? ['auto', '--dry-run'] : dryRun ? ['plan'] : ['upgrade', '--confirm', ...(req.body?.acceptBreaking === true ? ['--accept-breaking'] : [])]
    const result = await runScript(script, args, target === 'magpie' ? 30_000 : 180_000)
    const parsed = parseLastJson(result.stdout)
    if (!dryRun || target === 'rtk') {
      deps.addAudit('autoupdate_run', target, `${dryRun ? 'dry-run' : 'upgrade'} exit=${result.code}${parsed?.why ? ` why=${String(parsed.why)}` : ''}`)
    }
    if (!parsed) return res.status(502).json({ error: result.stderr.trim().slice(0, 300) || `脚本以退出码 ${result.code} 结束`, code: 'script_failed' })
    if (!dryRun) {
      // a real upgrade is 2xx only when rtk is now at the latest; held / failed / rolled back keep the structured result
      const why = String(parsed.why ?? '')
      if (why === 'upgraded' || why === 'up-to-date') return res.json({ target, dryRun, result: parsed })
      const first = Array.isArray(parsed.reasons) && isObject(parsed.reasons[0]) ? str(parsed.reasons[0].text) : null
      const held = why === 'breaking'
      return res.status(held ? 409 : 502).json({ target, dryRun, result: parsed, code: held ? 'upgrade_held' : 'upgrade_failed', error: first ?? `没有升级（${why || `退出码 ${result.code}`}）` })
    }
    res.status(result.code === 0 ? 200 : 502).json({ target, dryRun, result: parsed })
  })
}
