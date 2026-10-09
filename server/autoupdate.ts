import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import type express from 'express'

/**
 * 「自动更新」: the console's side of scripts/rtk-autoupdate.mjs.
 *
 * The console only writes the switch (<RTK_STATE_DIR>/autoupdate.json) and reads what the scheduled job recorded
 * (autoupdate-rtk.json). The one action it runs is a dry run (`rtk plan`) and a confirmed manual rtk upgrade, as child
 * processes. The words every surface shows (cradmin) are built here, once.
 */

export type AutoConfig = { version: 1; rtk: { enabled: boolean }; updatedAt?: string }
export type AutoReason = { code: string; text: string }
export type SchedulerMode = 'auto' | 'missing' | 'unsupported'
export type AutoTone = 'ok' | 'warn' | 'bad' | 'idle'

export type RtkAutoView = {
  available: boolean
  enabled: boolean
  scheduler: SchedulerMode
  state: 'off' | 'no-scheduler' | 'missing' | 'homebrew' | 'up-to-date' | 'pending' | 'held' | 'upgraded' | 'error' | 'unknown'
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

export type AutoupdateView = { rtk: RtkAutoView }

export type AutoupdatePaths = {
  runtime: string
  config: string
  rtkState: string
  /** the systemd timer that runs the job (deploy/systemd/crosery-rtk-autoupdate.timer) */
  timerUnit: string
}

const TAG = /^v?\d+\.\d+\.\d+[-.a-zA-Z0-9]*$/
const MAX_FILE_BYTES = 1024 * 1024

/** Same rule as scripts/rtk-autoupdate.mjs rtkRuntime: RTK_STATE_DIR, else ~/.agents/crosery/rtk. */
export function rtkStateDir(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  return path.resolve(env.RTK_STATE_DIR || path.join(home, '.agents/crosery/rtk'))
}

export function autoupdatePaths(env: NodeJS.ProcessEnv = process.env): AutoupdatePaths {
  return autoupdatePathsFor(rtkStateDir(env))
}

export function autoupdatePathsFor(runtime: string, timerUnit = '/etc/systemd/system/crosery-rtk-autoupdate.timer'): AutoupdatePaths {
  return {
    runtime,
    config: path.join(runtime, 'autoupdate.json'),
    rtkState: path.join(runtime, 'autoupdate-rtk.json'),
    timerUnit,
  }
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
const tag = (value: unknown): string | null => (typeof value === 'string' && TAG.test(value) ? value : null)
const when = (value: unknown): number | null => { const at = typeof value === 'string' ? Date.parse(value) : NaN; return Number.isFinite(at) ? at : null }

/** Same rule as scripts/rtk-autoupdate.mjs: a missing file or field means ON. */
export function readAutoConfig(file: string): AutoConfig {
  const raw = readJson(file) ?? {}
  const rtk = isObject(raw.rtk) ? raw.rtk : {}
  return {
    version: 1,
    rtk: { enabled: rtk.enabled !== false },
    ...(typeof raw.updatedAt === 'string' ? { updatedAt: raw.updatedAt } : {}),
  }
}

export type AutoConfigPatch = { rtk?: { enabled?: unknown } }

export class AutoConfigError extends Error {
  constructor(message: string) { super(message) }
}

/** Validates a PUT body strictly (unknown keys and non-booleans are 400s) and writes atomically. */
export function writeAutoConfig(file: string, patch: unknown, now = Date.now()): AutoConfig {
  if (!isObject(patch)) throw new AutoConfigError('请求体必须是对象')
  const unknown = Object.keys(patch).filter(key => key !== 'rtk')
  if (unknown.length) throw new AutoConfigError(`不认识的字段：${unknown.join(', ')}`)
  const next: AutoConfig = { version: 1, rtk: { ...readAutoConfig(file).rtk } }
  if (patch.rtk !== undefined) {
    if (!isObject(patch.rtk) || Object.keys(patch.rtk).some(key => key !== 'enabled') || typeof patch.rtk.enabled !== 'boolean') throw new AutoConfigError('rtk 只接受 {"enabled": 布尔值}')
    next.rtk.enabled = patch.rtk.enabled
  }
  next.updatedAt = new Date(now).toISOString()
  writeAtomic(file, next)
  return next
}

/** Whether the systemd timer that runs the job is installed (Linux only). Read-only. */
export function readScheduler(timerUnit: string, platform: NodeJS.Platform = process.platform): SchedulerMode {
  if (platform !== 'linux') return 'unsupported'
  return fs.existsSync(timerUnit) ? 'auto' : 'missing'
}

/** `02:14` today, `10/02 02:14` otherwise (this host's time zone). */
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
  rtkState: Record<string, unknown> | null
  rtkLocal: string | null
}

function schedulerGate(scheduler: SchedulerMode): { state: 'no-scheduler'; line: string; brief: string } | null {
  if (scheduler === 'auto') return null
  return { state: 'no-scheduler', line: scheduler === 'unsupported' ? '这台机器没有定时任务 · 开着也不会自动升级' : '没有安装定时任务 · 开着也不会自动升级', brief: '自动升级未生效' }
}

export function buildRtkAuto(facts: AutoupdateFacts, now: number): RtkAutoView {
  const s = facts.rtkState ?? {}
  const latest = tag(s.latest)
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
  const gate = schedulerGate(facts.scheduler)
  if (gate) return view(gate.state, 'warn', gate.line, gate.brief)
  if (lastUpgrade && lastUpgrade.result === 'upgraded' && local && compareVersions(local, lastUpgrade.to) === 0 && !newer) {
    return view('upgraded', 'ok', `上次 ${clock(Date.parse(lastUpgrade.at), now)} 自动升级到 ${lastUpgrade.to}`, `已升级到 ${lastUpgrade.to}`)
  }
  if (!newer) return view('up-to-date', 'ok', latest ? `已是最新 ${latest}` : '还没取到 rtk 最新版本', latest ? '无变化' : '未取到最新版本')
  if (s.why === 'breaking') return view('held', 'warn', `停在待复核：${firstReason(list)}`, `${latest} 停在待复核 · 本机 ${local}`, list)
  if (s.why === 'verify-failed') return view('error', 'bad', `${latest} 没通过校验，不再自动重试：${firstReason(list)}`, `${latest} 校验未过`, list)
  if (s.why === 'rolled-back' || lastUpgrade?.result === 'rolled-back' || lastUpgrade?.result === 'rollback-failed') {
    return view('error', 'bad', `升级到 ${latest} 后自检没过${lastUpgrade?.result === 'rollback-failed' ? '，回滚也没通过 · 需要人工处理' : '，已回滚'}`, `${latest} 已回滚`, list)
  }
  if (s.why === 'error' || s.why === 'rate-limited' || s.why === 'unwritable' || s.why === 'no-release') {
    const retry = Math.max(when(s.nextAttemptAt) ?? 0, when(s.retryNotBefore) ?? 0)
    return view('error', 'warn', `${firstReason(list) || '没升级成功'}${retry > now ? ` · ${clock(retry, now)} 再试` : ''}`, `${latest} 未升级`, list)
  }
  return view('pending', 'idle', `可升级 ${latest} · 本机 ${local} · 下一轮定时任务升级`, `可升级 ${latest} · 本机 ${local}`)
}

export function buildAutoupdateView(facts: AutoupdateFacts, now = Date.now()): AutoupdateView {
  return { rtk: buildRtkAuto(facts, now) }
}

/** Facts from this host's files only (no network, no child process); `rtkLocal` comes from the caller. */
export function readAutoupdateFacts(paths: AutoupdatePaths, extra: { rtkLocal: string | null; platform?: NodeJS.Platform }): AutoupdateFacts {
  return {
    config: readAutoConfig(paths.config),
    scheduler: readScheduler(paths.timerUnit, extra.platform),
    rtkState: readJson(paths.rtkState),
    rtkLocal: extra.rtkLocal,
  }
}

/* ── routes ── */

export type AutoupdateRouteDeps = {
  addAudit: (action: string, target: string, detail?: string) => void
  repoRoot: string
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
    const rtkLocal = await deps.rtkLocal().catch(() => null)
    return buildAutoupdateView(readAutoupdateFacts(paths(), { rtkLocal }))
  }

  app.get('/api/autoupdate', async (_req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.json(await view())
  })

  app.put('/api/autoupdate', async (req, res) => {
    try {
      const next = writeAutoConfig(paths().config, req.body)
      deps.addAudit('autoupdate_config', 'local', `rtk=${next.rtk.enabled ? 'on' : 'off'}`)
      res.json(await view())
    } catch (error) {
      if (error instanceof AutoConfigError) return res.status(400).json({ error: error.message, code: 'invalid_autoupdate' })
      res.status(500).json({ error: error instanceof Error ? error.message : '保存失败' })
    }
  })

  /**
   * { target: 'rtk', dryRun: true }              → resolve + download + verify into a temp dir; nothing replaced
   * { target: 'rtk', dryRun: false, confirm: true } → upgrade rtk now (backup, atomic swap, verify, roll back)
   */
  app.post('/api/autoupdate/run', async (req, res) => {
    const target = req.body?.target
    const dryRun = req.body?.dryRun !== false
    if (target !== 'rtk') return res.status(400).json({ error: 'target 只能是 rtk', code: 'invalid_target' })
    if (!dryRun && req.body?.confirm !== true) {
      deps.addAudit('autoupdate_run', 'rtk', 'refused:missing-confirm')
      return res.status(403).json({ error: '升级 rtk 需要显式确认（body 需要 {"confirm": true}）', code: 'confirm_required' })
    }
    const script = path.join(deps.repoRoot, 'scripts/rtk-autoupdate.mjs')
    const args = dryRun ? ['plan'] : ['upgrade', '--confirm', ...(req.body?.acceptBreaking === true ? ['--accept-breaking'] : [])]
    const result = await runScript(script, args, 180_000)
    const parsed = parseLastJson(result.stdout)
    deps.addAudit('autoupdate_run', target, `${dryRun ? 'dry-run' : 'upgrade'} exit=${result.code}${parsed?.why ? ` why=${String(parsed.why)}` : ''}`)
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
