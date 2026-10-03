import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import type express from 'express'

/**
 * 「网关内核」on the relay: the console's side of scripts/kernel-applier.mjs (CPA serving traffic, Magpie standby).
 *
 * The console only writes the switches (<data>/kernel-autoupdate.json) and queues a rollback
 * (<data>/kernel-requests/rollback-<kernel>.json, picked up by crosery-kernel-request.path). It reads what the applier
 * recorded (<data>/kernels/<kernel>.json). It never touches a binary or restarts anything: the console unit is
 * sandboxed and CPA is not its child. The words the panel shows are built here, once.
 */

export type KernelId = 'cpa' | 'magpie'
export type KernelTone = 'ok' | 'warn' | 'bad' | 'idle'
export type KernelReason = { code: string; text: string }
export type KernelWindow = { start: string; end: string; tz: string }
export type KernelConfig = { version: 1; cpa: { enabled: boolean }; magpie: { enabled: boolean }; window: KernelWindow; updatedAt?: string }

export type KernelView = {
  id: KernelId
  name: string
  role: 'serving' | 'standby'
  roleText: string
  /** what runs (CPA) / what is installed (Magpie standby); null = unknown */
  version: string | null
  online: boolean | null
  /** upstream's latest release as the builder saw it, and a newer line it does not follow on its own */
  upstream: { latest: string | null; line: string | null; heldNewer: string | null; checkedAt: string | null } | null
  /** the builder's last result for the candidate: built and rehearsed, or why it stopped */
  candidate: { label: string; tone: KernelTone; text: string } | null
  enabled: boolean
  state: string
  tone: KernelTone
  line: string
  reasons: KernelReason[]
  last: { text: string; tone: KernelTone; at: string } | null
  rollback: { to: string } | null
  checkedAt: string | null
}

export type KernelsView = {
  available: boolean
  reason: string | null
  scheduler: 'installed' | 'missing' | 'stale'
  window: KernelWindow & { label: string }
  kernels: KernelView[]
}

export type KernelPaths = { config: string; states: string; requests: string; timerUnit: string }

export const DEFAULT_KERNEL_WINDOW: KernelWindow = { start: '05:00', end: '07:00', tz: 'Asia/Shanghai' }
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/
const MAX_FILE_BYTES = 512 * 1024
const STALE_MS = 30 * 60_000
const ZONE_WORD: Record<string, string> = { 'Asia/Shanghai': '北京时间', 'America/New_York': '纽约时间', UTC: 'UTC' }

export function kernelPaths(dataDir: string, timerUnit = '/etc/systemd/system/crosery-kernel-update.timer'): KernelPaths {
  return {
    config: path.join(dataDir, 'kernel-autoupdate.json'),
    states: path.join(dataDir, 'kernels'),
    requests: path.join(dataDir, 'kernel-requests'),
    timerUnit,
  }
}

const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const str = (value: unknown): string | null => (typeof value === 'string' && value ? value : null)
const short = (value: string | null | undefined) => (value && /^[a-f0-9]{40}$/.test(value) ? value.slice(0, 7) : value ?? '')

function readJson(file: string): Record<string, unknown> | null {
  try {
    const stat = fs.lstatSync(file)
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null
    const value = JSON.parse(fs.readFileSync(file, 'utf8'))
    return isObject(value) ? value : null
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

function validZone(tz: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true } catch { return false }
}

export function parseKernelWindow(value: unknown, tz = DEFAULT_KERNEL_WINDOW.tz): KernelWindow | null {
  if (!isObject(value)) return null
  const start = String(value.start ?? '')
  const end = String(value.end ?? '')
  const zone = value.tz === undefined ? tz : String(value.tz)
  return HHMM.test(start) && HHMM.test(end) && start !== end && validZone(zone) ? { start, end, tz: zone } : null
}

/** Same rules as scripts/kernel-applier.mjs normalizeConfig: a missing file or field means ON. */
export function readKernelConfig(file: string): KernelConfig {
  const raw = readJson(file) ?? {}
  return {
    version: 1,
    cpa: { enabled: !isObject(raw.cpa) || raw.cpa.enabled !== false },
    magpie: { enabled: !isObject(raw.magpie) || raw.magpie.enabled !== false },
    window: parseKernelWindow(raw.window) ?? { ...DEFAULT_KERNEL_WINDOW },
    ...(typeof raw.updatedAt === 'string' ? { updatedAt: raw.updatedAt } : {}),
  }
}

export class KernelConfigError extends Error {}

/** Strict PUT body: { cpa?: { enabled }, magpie?: { enabled }, window?: { start, end } } (the time zone stays). */
export function writeKernelConfig(file: string, patch: unknown, now = Date.now()): KernelConfig {
  if (!isObject(patch)) throw new KernelConfigError('请求体必须是对象')
  const unknown = Object.keys(patch).filter(key => !['cpa', 'magpie', 'window'].includes(key))
  if (unknown.length) throw new KernelConfigError(`不认识的字段：${unknown.join(', ')}`)
  const current = readKernelConfig(file)
  const next: KernelConfig = { version: 1, cpa: { ...current.cpa }, magpie: { ...current.magpie }, window: { ...current.window } }
  for (const id of ['cpa', 'magpie'] as const) {
    const value = patch[id]
    if (value === undefined) continue
    if (!isObject(value) || Object.keys(value).some(key => key !== 'enabled') || typeof value.enabled !== 'boolean') {
      throw new KernelConfigError(`${id} 只接受 {"enabled": 布尔值}`)
    }
    next[id].enabled = value.enabled
  }
  if (patch.window !== undefined) {
    if (isObject(patch.window) && patch.window.tz !== undefined) throw new KernelConfigError('时区不能在这里改')
    const window = parseKernelWindow(patch.window, current.window.tz)
    if (!window) throw new KernelConfigError('窗口要写成 {"start":"HH:MM","end":"HH:MM"}，且起止不同')
    next.window = window
  }
  next.updatedAt = new Date(now).toISOString()
  writeAtomic(file, next)
  return next
}

export function windowLabel(window: KernelWindow): string {
  return `${window.start}–${window.end}（${ZONE_WORD[window.tz] ?? window.tz}）`
}

/** `05:12` in the window's time zone today, `10/04 05:12` otherwise. */
export function zonedClock(at: number, now: number, tz: string): string {
  const fmt = (ms: number, options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hourCycle: 'h23', ...options }).format(new Date(ms))
  const hm = fmt(at, { hour: '2-digit', minute: '2-digit' })
  const day = (ms: number) => fmt(ms, { month: '2-digit', day: '2-digit' })
  return day(at) === day(now) ? hm : `${day(at).split('/').reverse().join('/')} ${hm}`
}

function reasons(value: unknown): KernelReason[] {
  if (!Array.isArray(value)) return []
  return value.filter(isObject).slice(0, 20).map(item => ({ code: String(item.code ?? '').slice(0, 40), text: String(item.text ?? '').slice(0, 300) })).filter(item => item.text)
}

const first = (list: KernelReason[]) => (list.length ? `${list[0].text}${list.length > 1 ? `（另有 ${list.length - 1} 项）` : ''}` : '')

function versionMajor(value: string | null): number | null {
  const match = /^v?(\d+)\./.exec(value ?? '')
  return match ? Number(match[1]) : null
}

export type KernelFacts = {
  config: KernelConfig
  scheduler: 'installed' | 'missing'
  cpa: Record<string, unknown> | null
  magpie: Record<string, unknown> | null
  /** the CPA version answering now (x-cpa-version); null = offline / unknown */
  cpaRunning: string | null
}

const BUILDER_WORD: Record<string, string> = {
  'merge-conflict': '合并上游时补丁冲突，等人工解决',
  'build-failed': '构建或 go test 没过',
  'smoke-failed': '冒烟没过',
  'fetch-failed': '拉不到上游',
  'upload-failed': '上传或校验没过',
  held: '构建机停住',
  error: '构建出错',
}

function candidateLine(id: KernelId, builder: Record<string, unknown> | null, staged: Record<string, unknown> | null): KernelView['candidate'] {
  if (!builder) return null
  const status = str(builder.status)
  const list = reasons(builder.reasons)
  const candidate = isObject(builder.candidate) ? builder.candidate : null
  const label = id === 'cpa' ? str(candidate?.version) : short(str(candidate?.revision))
  if (status === 'built' || status === 'up-to-date') {
    const checks = Array.isArray(candidate?.checks) ? candidate.checks.filter(isObject) : []
    const failed = checks.filter(check => check.ok !== true).length
    const word = id === 'cpa' ? `go test${checks.length ? ` · 冒烟 ${checks.length - failed}/${checks.length}` : ''} 通过` : 'Mac 上演练通过'
    return { label: label || '—', tone: failed ? 'warn' : 'ok', text: `${word}${staged ? ' · 已暂存到中转站' : ''}` }
  }
  return { label: label || '—', tone: status === 'held' ? 'warn' : 'bad', text: first(list) || BUILDER_WORD[status ?? ''] || '构建机没给结果' }
}

/** The one line under the switch, from the applier's last decision and last apply. */
function autoLine(id: KernelId, facts: KernelFacts, state: Record<string, unknown>, now: number): Pick<KernelView, 'state' | 'tone' | 'line' | 'reasons' | 'last'> {
  const window = windowLabel(facts.config.window)
  const tz = facts.config.window.tz
  const decision = isObject(state.decision) ? state.decision : {}
  const why = str(decision.why) ?? 'unknown'
  const target = str(decision.version) ?? short(str(decision.revision))
  const lastRaw = isObject(state.lastApply) ? state.lastApply : null
  const lastAt = str(lastRaw?.at)
  const lastTarget = str(lastRaw?.version) ?? short(str(lastRaw?.revision))
  const lastResult = str(lastRaw?.result)
  const lastReasons = reasons(lastRaw?.reasons)
  const at = lastAt ? zonedClock(Date.parse(lastAt), now, tz) : ''
  const LAST: Record<string, [string, KernelTone]> = {
    applied: [id === 'cpa' ? `${at} 替换到 ${lastTarget}` : `${at} 备用内核换成 ${lastTarget}（启动检查通过）`, 'ok'],
    'up-to-date': [`${at} 已是 ${lastTarget}`, 'ok'],
    'rolled-back': [`${at} 替换 ${lastTarget} 后验收没过，已自动回滚`, 'bad'],
    'rollback-failed': [`${at} 替换 ${lastTarget} 失败，回滚也没成功 · 需要人工处理`, 'bad'],
    refused: [`${at} ${lastRaw?.action === 'rollback' ? '回滚' : '替换'}没开始：${first(lastReasons) || '安装脚本拒绝'}`, 'warn'],
    failed: [`${at} ${lastTarget} 启动检查没过，没有换上`, 'bad'],
    'rolled-back-manually': [`${at} 已手动回滚 ${lastTarget}`, 'warn'],
  }
  const last = lastResult && lastAt && LAST[lastResult] ? { text: LAST[lastResult][0], tone: LAST[lastResult][1], at: lastAt } : null
  const out = (state: string, tone: KernelTone, line: string, list: KernelReason[] = []) => ({ state, tone, line, reasons: list, last })
  const enabled = facts.config[id].enabled
  if (!enabled) return out('off', 'idle', id === 'cpa' ? '已关闭 · 构建机照常跟上游构建、演练，这里不替换' : '已关闭 · 不再更新备用内核')
  if (facts.scheduler === 'missing') return out('no-scheduler', 'warn', '中转站没有安装内核更新定时任务 · 开着也不会替换')
  const checkedAt = Date.parse(str(state.checkedAt) ?? '')
  if (!Number.isFinite(checkedAt)) return out('pending', 'idle', '定时任务还没跑过')
  if (now - checkedAt > STALE_MS) return out('stale', 'warn', `定时任务 ${Math.round((now - checkedAt) / 60_000)} 分钟没跑了`)
  const decisionReasons = reasons(decision.reasons)
  switch (why) {
    case 'up-to-date': return out('up-to-date', 'ok', id === 'cpa' ? `已是最新候选 · 新版本先在构建机演练，通过后在 ${window}替换` : '已是最新 · 新版本先在 Mac 上演练，通过后换上')
    case 'no-candidate': return out('up-to-date', 'idle', id === 'cpa' ? '还没有演练通过的候选' : '还没有备用内核 · 等 Mac 发布第一个')
    case 'window': return out('eligible', 'ok', `${target} 演练通过 · 等 ${window}替换`)
    case 'daily': return out('eligible', 'ok', `${target} 演练通过 · 这个时段已经换过一次，明天 ${window}再换`)
    case 'apply': return out('applying', 'ok', `${target} 正在替换`)
    case 'held': return out('held', 'warn', `构建机停住：${first(decisionReasons) || '见候选'}`, decisionReasons)
    case 'major': return out('held', 'warn', `${target} 跨大版本 · 配置格式会迁移，第一次人工升级`, decisionReasons)
    case 'hold-file': return out('held', 'warn', '生产机的补丁锁（auto-update.hold）还在 · 不替换', decisionReasons)
    case 'offline': return out('blocked', 'warn', 'CPA 不在运行 · 不替换')
    case 'backoff': {
      const retry = Date.parse(str(decision.retryAt) ?? '')
      return out('error', 'warn', `上次没替换成（${first(lastReasons) || '安装脚本拒绝'}）${Number.isFinite(retry) ? ` · ${zonedClock(retry, now, tz)} 再试` : ''}`, lastReasons)
    }
    case 'attempted': {
      if (lastResult === 'rolled-back-manually') return out('rolled-back', 'warn', `${lastTarget} 已手动回滚 · 不再自动换上这个版本`)
      if (lastResult === 'applied') return out('applied', 'ok', `${at} 已替换到 ${lastTarget}`)
      return out('rolled-back', 'bad', `${target} 替换失败${lastResult === 'rollback-failed' ? '，回滚也没成功 · 需要人工处理' : lastResult === 'failed' ? '（启动检查没过）' : '，已自动回滚'} · 不再自动重试这个版本`, lastReasons)
    }
    case 'disabled': return out('off', 'idle', '已关闭')
    default: return out('unknown', 'idle', '状态未知')
  }
}

export function buildKernelsView(facts: KernelFacts, now = Date.now()): KernelsView {
  const cpaState = facts.cpa ?? {}
  const magpieState = facts.magpie ?? {}
  const views: KernelView[] = []
  {
    const builder = isObject(cpaState.builder) ? cpaState.builder : null
    const installed = isObject(cpaState.installed) ? str(cpaState.installed.version) : null
    const applied = isObject(cpaState.applied) ? cpaState.applied : null
    const previous = str(applied?.previous)
    const heldNewer = isObject(builder?.heldNewer) ? str(builder.heldNewer.tag) : null
    views.push({
      id: 'cpa', name: 'CPA', role: 'serving', roleText: '接流量',
      version: facts.cpaRunning ?? installed, online: facts.cpaRunning ? true : null,
      upstream: builder ? { latest: str(builder.upstreamLatest), line: str(builder.line), heldNewer, checkedAt: str(builder.checkedAt) } : null,
      candidate: candidateLine('cpa', builder, isObject(cpaState.staged) ? cpaState.staged : null),
      enabled: facts.config.cpa.enabled,
      ...autoLine('cpa', facts, cpaState, now),
      // one click only within a major version: an older major must not start against a config the newer one migrated
      rollback: applied && previous && versionMajor(previous) === versionMajor(str(applied.version)) ? { to: previous } : null,
      checkedAt: str(cpaState.checkedAt),
    })
  }
  {
    const builder = isObject(magpieState.builder) ? magpieState.builder : null
    const installed = isObject(magpieState.installed) ? magpieState.installed : null
    const applied = isObject(magpieState.applied) ? magpieState.applied : null
    const revision = str(installed?.revision)
    views.push({
      id: 'magpie', name: 'Magpie', role: 'standby', roleText: '备用 · 不接流量',
      version: revision ? [short(revision), str(installed?.release)].filter(Boolean).join(' · ') : null, online: null,
      upstream: builder ? { latest: str(builder.upstreamLatest) ?? short(str(builder.upstreamRevision)), line: null, heldNewer: null, checkedAt: str(builder.checkedAt) } : null,
      candidate: candidateLine('magpie', builder, isObject(magpieState.staged) ? magpieState.staged : null),
      enabled: facts.config.magpie.enabled,
      ...autoLine('magpie', facts, magpieState, now),
      rollback: applied && str(applied.previous) ? { to: short(str(applied.previousRevision)) || str(applied.previous)! } : null,
      checkedAt: str(magpieState.checkedAt),
    })
  }
  const ticks = views.map(view => Date.parse(view.checkedAt ?? '')).filter(Number.isFinite)
  const scheduler = facts.scheduler === 'missing' ? 'missing' : ticks.length && now - Math.max(...ticks) > STALE_MS ? 'stale' : 'installed'
  return { available: true, reason: null, scheduler, window: { ...facts.config.window, label: windowLabel(facts.config.window) }, kernels: views }
}

export function readKernelFacts(paths: KernelPaths, cpaRunning: string | null): KernelFacts {
  return {
    config: readKernelConfig(paths.config),
    scheduler: fs.existsSync(paths.timerUnit) ? 'installed' : 'missing',
    cpa: readJson(path.join(paths.states, 'cpa.json')),
    magpie: readJson(path.join(paths.states, 'magpie.json')),
    cpaRunning,
  }
}

/* ── routes ── */

export type KernelRouteDeps = {
  addAudit: (action: string, target: string, detail?: string) => void
  paths: () => KernelPaths
  /** this console manages the relay's kernels (Linux, CPA engine); otherwise the Mac's own Magpie panel applies */
  available: () => boolean
  cpaRunning: () => Promise<string | null>
}

const UNAVAILABLE = '只有中转站（Linux、CPA 网关）有内核更新定时任务；这台机器的内核更新在「自动更新」里'

export function registerKernelRoutes(app: express.Express, deps: KernelRouteDeps): void {
  const view = async (): Promise<KernelsView> => {
    if (!deps.available()) {
      return { available: false, reason: UNAVAILABLE, scheduler: 'missing', window: { ...DEFAULT_KERNEL_WINDOW, label: windowLabel(DEFAULT_KERNEL_WINDOW) }, kernels: [] }
    }
    const running = await deps.cpaRunning().catch(() => null)
    return buildKernelsView(readKernelFacts(deps.paths(), running))
  }

  app.get('/api/kernels', async (_req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.json(await view())
  })

  app.put('/api/kernels', async (req, res) => {
    if (!deps.available()) return res.status(409).json({ error: UNAVAILABLE, code: 'kernels_unavailable' })
    try {
      const next = writeKernelConfig(deps.paths().config, req.body)
      deps.addAudit('kernel_autoupdate_config', 'relay', `cpa=${next.cpa.enabled ? 'on' : 'off'} magpie=${next.magpie.enabled ? 'on' : 'off'} window=${next.window.start}-${next.window.end} ${next.window.tz}`)
      res.json(await view())
    } catch (error) {
      if (error instanceof KernelConfigError) return res.status(400).json({ error: error.message, code: 'invalid_kernel_config' })
      res.status(500).json({ error: error instanceof Error ? error.message : '保存失败' })
    }
  })

  /** { kernel, confirm: true } → queued; the applier runs it within seconds (path unit) and records the outcome. */
  app.post('/api/kernels/rollback', async (req, res) => {
    if (!deps.available()) return res.status(409).json({ error: UNAVAILABLE, code: 'kernels_unavailable' })
    const kernel = req.body?.kernel
    if (kernel !== 'cpa' && kernel !== 'magpie') return res.status(400).json({ error: 'kernel 只能是 cpa / magpie', code: 'invalid_kernel' })
    if (req.body?.confirm !== true) {
      deps.addAudit('kernel_rollback', kernel, 'refused:missing-confirm')
      return res.status(403).json({ error: '回滚需要显式确认（body 需要 {"confirm": true}）', code: 'confirm_required' })
    }
    const current = await view()
    const target = current.kernels.find(item => item.id === kernel)
    if (!target?.rollback) return res.status(409).json({ error: '现在没有可一键回滚的版本', code: 'nothing_to_roll_back' })
    writeAtomic(path.join(deps.paths().requests, `rollback-${kernel}.json`), { confirm: true, at: new Date().toISOString(), to: target.rollback.to })
    deps.addAudit('kernel_rollback', kernel, `queued to=${target.rollback.to}`)
    res.status(202).json({ queued: true, kernel, to: target.rollback.to })
  })
}
