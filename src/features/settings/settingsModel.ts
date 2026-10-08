/**
 * Pure mapping for /settings (DESIGN.md §6.8): sync jobs (C3) → row words and marks, the policy strip, the RTK
 * global switch (C4) → words and the confirm facts, the kernel update panel → step state.
 * Structural input types and `.js` specifiers keep it importable by `server/settingsModel.test.ts`.
 */
import { fmtCompact, fmtInt, fmtPct, fmtTime } from '../../ui/fmt.js'

export type JobResult = 'ok' | 'partial' | 'error' | 'skipped'
export type MarkKind = 'run' | 'busy' | 'pause' | 'idle' | 'off' | 'cool' | 'warn' | 'bad' | 'stale'

/** The C3 job fields the settings page reads. */
export type SyncJobLike = {
  id: string
  label: string
  kind: 'in-process' | 'external'
  intervalMs: number | null
  lastRunAt: string | null
  nextRunAt: string | null
  state: string
  lastResult: JobResult | null
  lastError: string | null
  summary: string | null
  backoffUntil: string | null
  backoffLevel: number
  requests24h: number | null
  history: Array<{ at: string; result: JobResult; durationMs: number | null }>
  canRunNow: boolean
  runCooldownUntil: string | null
}

export type SyncPolicyLike = {
  globalUpstreamConcurrency: number
  minIntervalPerHostMs: number
  backoff: { factor: number; baseMs?: number; maxMs: number }
  jitterPct: number
}

const toMs = (value: string | number | null | undefined): number | null => {
  if (value === null || value === undefined || value === '') return null
  const ms = typeof value === 'number' ? value : Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

/** Interval words: 5s · 1m · 30m · 1h30m · 6h · 1d. */
export function fmtSpan(ms: number | null | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '—'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  if (m < 24 * 60) {
    const h = Math.floor(m / 60)
    const rest = m % 60
    return rest ? `${h}h${rest}m` : `${h}h`
  }
  const d = Math.round(m / (24 * 60) * 10) / 10
  return `${d}d`
}

/** Where each job reads from, in mono. Unknown ids show nothing rather than a guess. */
export const JOB_SOURCE: Record<string, string> = {
  'model-discovery': '渠道 /models 探测',
  pricing: '网关价格 · 共享目录双源',
  'price-watch': '网关 · models.dev · OpenRouter',
  'cpa-catalog': 'CPA 官方目录 ∪ 补充目录',
  'account-quota': '订阅账号额度 · 页面刷新时',
  'data-plane': 'outbox → 数据面',
  'catalog-sync': 'launchd · crosery-models-sync',
  'kernel-upstream': 'launchd · magpie 上游检查',
  'rtk-version': 'launchd · rtk releases',
}

export type JobMark = { state: MarkKind; label: string; severity: 'bad' | 'warn' | 'busy' | null }

/** Shape + word (DESIGN §2.2). Backoff and a degraded result are ◇, a failure ◆, cooldown is never orange. */
export function jobMark(job: Pick<SyncJobLike, 'state' | 'lastResult'>): JobMark {
  if (job.state === 'disabled') return { state: 'off', label: '停用', severity: null }
  if (job.state === 'running') return { state: 'busy', label: '同步中', severity: 'busy' }
  if (job.state === 'backoff') return { state: 'warn', label: '退避', severity: 'warn' }
  if (job.state === 'error' || job.lastResult === 'error') return { state: 'bad', label: '失败', severity: 'bad' }
  if (job.lastResult === 'partial') return { state: 'warn', label: '部分成功', severity: 'warn' }
  if (job.state === 'unknown') return { state: 'stale', label: '未知', severity: null }
  if (job.lastResult === 'skipped') return { state: 'idle', label: '跳过', severity: null }
  if (job.lastResult === null) return { state: 'idle', label: '未运行', severity: null }
  return { state: 'run', label: '正常', severity: null }
}

const RESULT_WORD: Record<JobResult, string> = { ok: '成功', partial: '部分成功', error: '失败', skipped: '跳过' }

export type JobAction =
  | { kind: 'run'; label: string; backoff: boolean }
  | { kind: 'cooldown'; label: string; until: number }
  | { kind: 'running'; label: string }
  | { kind: 'none'; label: string }

/** how long a 202 keeps the button locked when the status never shows the run (then it comes back) */
export const ACCEPTED_HOLD_MS = 60_000

/**
 * The one button per row: 立即同步 · 冷却 mm:ss (disabled) · 运行中 (disabled) · nothing for read-only jobs.
 * `acceptedAt` = when this page's 立即同步 got its 202: until the status shows that run (running, a cooldown, or a
 * newer lastRunAt) the button stays `已提交`, so a second click does not just collect a 409 / 429.
 */
export function jobAction(job: SyncJobLike, now: number, acceptedAt: number | null = null): JobAction {
  if (job.state === 'running') return { kind: 'running', label: '运行中' }
  const cooling = toMs(job.runCooldownUntil)
  if (cooling !== null && cooling > now) return { kind: 'cooldown', label: '冷却', until: cooling }
  if (acceptedAt !== null && now - acceptedAt < ACCEPTED_HOLD_MS && (toMs(job.lastRunAt) ?? -Infinity) < acceptedAt) {
    return { kind: 'running', label: '已提交' }
  }
  if (job.canRunNow) return { kind: 'run', label: '立即同步', backoff: job.state === 'backoff' }
  if (job.kind === 'external') return { kind: 'none', label: '外部 · 只读' }
  if (job.state === 'disabled') return { kind: 'none', label: '未启用' }
  return { kind: 'none', label: '自有循环' }
}

export type JobRow = {
  id: string
  label: string
  source: string
  every: string
  jitter: string | null
  lastAt: string | null
  lastWords: string
  next: { at: number | null; prefix: string; word: string; overdue: boolean }
  mark: JobMark
  error: { text: string; hot: boolean; parts: Array<{ text: string; email: boolean }> } | null
  calls: string
  callsTitle: string
}

export function jobRow(job: SyncJobLike, policy: SyncPolicyLike | null, now: number): JobRow {
  const mark = jobMark(job)
  const scheduled = job.kind === 'in-process' && typeof job.intervalMs === 'number' && job.intervalMs >= 60_000
  const every = job.intervalMs === null ? '按需' : `每 ${fmtSpan(job.intervalMs)}`
  const jitter = scheduled && policy ? `±${fmtInt(policy.jitterPct)}%` : null

  const lastAt = toMs(job.lastRunAt)
  const resultWord = job.lastResult && job.lastResult !== 'ok' ? RESULT_WORD[job.lastResult] : ''
  const lastWords = [resultWord, job.summary ?? ''].filter(Boolean).join(' · ')

  let next: JobRow['next']
  const backoffUntil = toMs(job.backoffUntil)
  const nextAt = toMs(job.nextRunAt)
  if (job.state === 'disabled') next = { at: null, prefix: '', word: '已停用', overdue: false }
  else if (job.state === 'backoff' && backoffUntil !== null && backoffUntil > now) next = { at: backoffUntil, prefix: '退避至', word: '', overdue: false }
  else if (job.state === 'running') next = { at: null, prefix: '', word: '进行中', overdue: false }
  else if (nextAt !== null) {
    // external jobs report lastRunAt + interval: a launchd job that missed its slot shows as overdue, not "in -3m"
    const grace = Math.max(5 * 60_000, (job.intervalMs ?? 0) * 0.1)
    next = { at: nextAt, prefix: '', word: '', overdue: now - nextAt > grace }
  } else next = { at: null, prefix: '', word: job.intervalMs === null ? '按需' : '—', overdue: false }

  const hot = job.lastResult === 'error' || job.lastResult === 'partial' || job.state === 'backoff' || job.state === 'error'
  const error = job.lastError ? { text: job.lastError, hot, parts: splitEmails(job.lastError) } : null

  const calls = job.requests24h === null ? '未计数' : `${fmtInt(job.requests24h)} 次`
  const callsTitle = job.requests24h === null ? '外部任务的上游请求不经控制台，这里不计数' : '近 24 小时这个任务发出的上游请求'

  return {
    id: job.id,
    label: job.label,
    source: JOB_SOURCE[job.id] ?? '',
    every,
    jitter,
    lastAt: lastAt === null ? null : fmtTime(lastAt, now),
    lastWords,
    next,
    mark,
    error,
    calls,
    callsTitle,
  }
}

/** Split free text so emails can render through the privacy mask (`<Pii>`); everything else stays plain. */
export function splitEmails(text: string): Array<{ text: string; email: boolean }> {
  const out: Array<{ text: string; email: boolean }> = []
  const pattern = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
  let last = 0
  for (const match of text.matchAll(pattern)) {
    const at = match.index ?? 0
    if (at > last) out.push({ text: text.slice(last, at), email: false })
    out.push({ text: match[0], email: true })
    last = at + match[0].length
  }
  if (last < text.length) out.push({ text: text.slice(last), email: false })
  return out
}

export type SyncTally = { total: number; bad: number; warn: number; busy: number; calls24h: number | null; counted: number }

export function syncTally(jobs: SyncJobLike[]): SyncTally {
  let bad = 0
  let warn = 0
  let busy = 0
  let calls = 0
  let counted = 0
  for (const job of jobs) {
    const severity = jobMark(job).severity
    if (severity === 'bad') bad += 1
    else if (severity === 'warn') warn += 1
    else if (severity === 'busy') busy += 1
    if (typeof job.requests24h === 'number') {
      calls += job.requests24h
      counted += 1
    }
  }
  return { total: jobs.length, bad, warn, busy, calls24h: counted ? calls : null, counted }
}

export type PolicyFigure = { k: string; v: string; sub?: string; title: string }

/** Policy strip: every figure comes from the server's policy object; nothing is hard-coded here. */
export function policyFigures(policy: SyncPolicyLike, tally: SyncTally): PolicyFigure[] {
  const figures: PolicyFigure[] = [
    { k: '账号额度并发', v: fmtInt(policy.globalUpstreamConcurrency), title: '账号额度扇出时同时请求上游的上限' },
    { k: '单源最小间隔', v: fmtSpan(policy.minIntervalPerHostMs), title: '同一个上游主机两次探测之间至少隔这么久' },
    {
      k: '失败退避',
      v: `×${fmtInt(policy.backoff.factor)}`,
      sub: `${policy.backoff.baseMs ? `${fmtSpan(policy.backoff.baseMs)} 起 · ` : ''}≤ ${fmtSpan(policy.backoff.maxMs)}`,
      title: '连续失败时等待时间按倍数增加，到上限为止',
    },
    { k: '随机抖动', v: `±${fmtInt(policy.jitterPct)}%`, title: '定时任务的间隔随机浮动，避免整点齐发' },
  ]
  if (tally.calls24h !== null) {
    figures.push({ k: '近 24h 上游请求', v: fmtInt(tally.calls24h), sub: `${tally.counted} 个任务计数`, title: '控制台发出的上游请求；外部任务不计' })
  }
  return figures
}

/** Plate-head words: only the counts that need a look; `全部正常` otherwise. */
export function syncHeadline(tally: SyncTally): string {
  const parts: string[] = []
  if (tally.busy) parts.push(`${tally.busy} 运行`)
  if (tally.bad) parts.push(`${tally.bad} 失败`)
  if (tally.warn) parts.push(`${tally.warn} 注意`)
  return parts.length ? parts.join(' · ') : '全部正常'
}

/* ── lane geometry ─────────────────────────────────────────────────────────────────────────────── */

export type LanePulse = { x: number; w: number; result: JobResult; at: number; durationMs: number | null }

/** Map runs into a lane of `width` px over [from, to]; width = duration (min 2px), runs outside dropped. */
export function lanePulses(history: SyncJobLike['history'], from: number, to: number, width: number): LanePulse[] {
  if (!(to > from) || !(width > 0)) return []
  const span = to - from
  const out: LanePulse[] = []
  for (const run of history) {
    const at = toMs(run.at)
    if (at === null) continue
    const end = at + (run.durationMs ?? 0)
    if (end < from || at > to) continue
    const start = Math.max(at, from)
    const x = ((start - from) / span) * width
    const w = Math.max(2, (((Math.min(end, to) - start) / span) * width))
    out.push({ x: Math.min(x, width - 2), w, result: run.result, at, durationMs: run.durationMs })
  }
  return out
}

export function laneX(at: number | null, from: number, to: number, width: number): number | null {
  if (at === null || !(to > from) || at < from || at > to) return null
  return ((at - from) / (to - from)) * width
}

/* ── RTK global switch (C4) ────────────────────────────────────────────────────────────────────── */

export type RtkGlobalLike = {
  on: boolean | null
  plane: 'kernel' | 'relay' | 'local' | null
  agents: { supported: number; on: number }
  savings: { pct: number | null; tokens: number | null } | null
  writable: boolean
  reason: string | null
  /** C4 additive: the manual install command, only with reason `rtk_binary_missing` */
  installHint?: string | null
}

export const PLANE_WORD: Record<string, string> = { kernel: '内核', relay: '中转站', local: '本机' }

export const RTK_REASON_WORD: Record<string, string> = {
  no_supported_agents: '这个平面没有可切换的客户端',
  write_disabled: '写入已关闭 · RTK_WRITE_MODE=off',
  rtk_binary_missing: '找不到 rtk 程序',
  kernel_write_disabled: '内核平面写入未开启',
  remote_write_disabled: '中转站平面写入未开启',
}

export type RtkWords = {
  state: 'on' | 'off' | 'mixed' | 'unknown'
  word: string
  coverage: string
  plane: string
  savings: string | null
  savingsPct: string | null
  blocked: string | null
  /** the command a person runs to install rtk (the console never installs it on this machine) */
  install: string | null
}

export function rtkWords(g: RtkGlobalLike): RtkWords {
  const { supported, on } = g.agents
  const state = g.on === true ? 'on' : g.on === false ? 'off' : supported > 0 && on > 0 ? 'mixed' : 'unknown'
  const word = state === 'on' ? '已开启' : state === 'off' ? '已关闭' : state === 'mixed' ? '部分开启' : '未知'
  const plane = g.plane ? PLANE_WORD[g.plane] ?? g.plane : '—'
  const tokens = g.savings?.tokens
  const pct = g.savings?.pct
  return {
    state,
    word,
    coverage: `${fmtInt(on)} / ${fmtInt(supported)}`,
    plane,
    savings: typeof tokens === 'number' ? fmtCompact(tokens) : null,
    // server sends a percent (58.2), fmtPct takes a ratio
    savingsPct: typeof pct === 'number' ? fmtPct(pct / 100, 1) : null,
    blocked: g.writable ? null : RTK_REASON_WORD[g.reason ?? ''] ?? (g.reason ? `不可写 · ${g.reason}` : '不可写'),
    install: !g.writable && g.reason === 'rtk_binary_missing' && g.installHint ? g.installHint : null,
  }
}

export type RtkDirection = { target: boolean; label: '全部开启' | '全部关闭' }

/**
 * The switch can only say "on" from a mixed state (TxSwitch emits !modelValue, and mixed reads as off), so a
 * mixed, writable plane offers both directions explicitly; each still goes through the confirm sheet.
 */
export function rtkDirections(words: Pick<RtkWords, 'state'>, writable: boolean): RtkDirection[] {
  if (!writable || words.state !== 'mixed') return []
  return [{ target: true, label: '全部开启' }, { target: false, label: '全部关闭' }]
}

export type RtkBinaryAction = 'install' | 'upgrade'
export const RTK_BINARY_VERB: Record<RtkBinaryAction, string> = { install: '安装', upgrade: '升级' }

/**
 * Toast for 安装 / 升级 rtk (POST /api/rtk/{install,upgrade}). The server never fakes it: a plane without that
 * seam answers 501 with what to do by hand (本机: the manual install command), so that text is the description.
 */
export function rtkBinaryNotice(
  action: RtkBinaryAction,
  outcome: { ok: true } | { status: number | null; reason?: string | null; message: string },
): { title: string; tone: 'ok' | 'note' | 'bad'; description?: string } {
  const verb = RTK_BINARY_VERB[action]
  if ('ok' in outcome) return { title: `✓ rtk 已${verb}`, tone: 'ok' }
  if (outcome.status === 501) return { title: `— 这个平面不由控制台${verb} rtk · 按下面手动执行`, tone: 'note', description: outcome.message || undefined }
  const word = (outcome.reason && RTK_REASON_WORD[outcome.reason]) || outcome.message || '请求失败'
  return { title: `◆ rtk 没有${verb} · ${word}`, tone: 'bad' }
}

export type RtkAgentLike = { id: string; name: string; on: boolean; supported: boolean; installed?: boolean; blocked?: string }

/** Same target rule as the server's setRTKGlobal: supported, not blocked, and installed on the local plane. */
export function rtkTargets(agents: RtkAgentLike[], plane: string | null): RtkAgentLike[] {
  return agents.filter((agent) => agent.supported && !agent.blocked && (plane !== 'local' || agent.installed !== false))
}

export type ConfirmFactLike = { k: string; v: string }

/** Facts for the global switch confirm sheet; `agents` (from /api/rtk/status) names who changes when known. */
export function rtkConfirmFacts(g: RtkGlobalLike, target: boolean, agents: RtkAgentLike[] | null): ConfirmFactLike[] {
  const plane = g.plane ? PLANE_WORD[g.plane] ?? g.plane : '—'
  const facts: ConfirmFactLike[] = [{ k: '平面', v: g.plane === 'local' ? '本机 · 控制台所在机器' : plane }]
  if (agents) {
    const targets = rtkTargets(agents, g.plane)
    const change = targets.filter((agent) => agent.on !== target)
    facts.push({ k: '范围', v: `${targets.length} 个客户端 · 已开 ${targets.filter((agent) => agent.on).length}` })
    facts.push({ k: target ? '将挂载' : '将卸载', v: change.length ? change.map((agent) => agent.name).join('、') : '无 · 已是目标状态' })
  } else {
    const change = target ? g.agents.supported - g.agents.on : g.agents.on
    facts.push({ k: '范围', v: `${g.agents.supported} 个客户端 · 已开 ${g.agents.on}` })
    facts.push({ k: target ? '将挂载' : '将卸载', v: `${Math.max(0, change)} 个` })
  }
  facts.push({ k: '保护', v: '写前备份 · 失败回滚 · 已是目标状态的不动' })
  return facts
}

export type RtkSkippedFile = { agent: string; file: string; reason: string }

export type RtkApplyLike = {
  ok: boolean
  on: boolean | null
  /** C4 additive: agents the post-apply re-read still finds off the target */
  offTarget?: string[]
  /** the re-read fell back to another plane: `on` is null because nothing was verified, not because it is mixed */
  degraded?: string
  results: Array<{ agent: string; ok: boolean; error: string | null; unchanged?: boolean; collateralSkipped?: RtkSkippedFile[] }>
}

/**
 * Toast for the apply result; partial failures are never hidden. Besides per-client errors that covers a
 * re-read that is not the target (one client's rtk CLI rewrote another client's file) and collateral files the
 * server left alone because it did not recognise them: both are warnings that name what to check by hand.
 */
export function rtkApplyNotice(result: RtkApplyLike, target: boolean): { title: string; tone: 'ok' | 'warn' | 'bad'; description?: string } {
  const failed = result.results.filter((item) => !item.ok)
  const changed = result.results.filter((item) => item.ok && !item.unchanged).length
  const unchanged = result.results.filter((item) => item.ok && item.unchanged).length
  const verb = target ? '开启' : '关闭'
  const skipped = result.results.flatMap((item) => item.collateralSkipped ?? [])
  const review = skipped.length ? `未自动还原（请人工确认）：${skipped.map((item) => `${item.file}（${item.agent}）`).join('、')}` : null
  const settled = result.on === target
  if (!failed.length) {
    if (settled && !review) {
      return { title: `✓ RTK 已全部${verb} · 改动 ${changed} · 未变 ${unchanged}`, tone: 'ok', description: '重启客户端后生效' }
    }
    const off = result.offTarget ?? []
    const unverified = result.degraded === 'verify_plane_unavailable'
    const state = result.on === null ? '部分开启' : result.on ? '已开启' : '已关闭'
    return {
      title: settled ? `◇ RTK 已全部${verb} · 有文件需人工确认`
        : unverified ? `◇ RTK ${verb}后没能复核 · 写入 ${changed + unchanged} 个都成功`
          : `◇ RTK ${verb}后复核为${state} · 写入 ${changed + unchanged} 个都成功`,
      tone: 'warn',
      description: [unverified ? '复核时读到的不是写入的平面' : null, off.length ? `未到位 ${off.join('、')}` : null, review].filter(Boolean).join('；') || '刷新后看诊断里的客户端状态',
    }
  }
  const tone = changed + unchanged > 0 ? 'warn' : 'bad'
  return {
    title: `${tone === 'warn' ? '◇' : '◆'} RTK ${verb}未全部完成 · 失败 ${failed.length} · 成功 ${changed + unchanged}`,
    tone,
    description: [failed.map((item) => `${item.agent}：${item.error ?? '未知错误'}`).join('；'), review].filter(Boolean).join('；'),
  }
}

/** Daily saved tokens for the last `days` days ending today (Asia/Shanghai keys); missing days are 0 (no rtk runs). */
export function rtkDailySeries(days: Array<{ date: string; saved: number; input: number }>, todayKey: string, count = 14): { values: number[]; dates: string[]; saved: number; input: number } {
  const byDate = new Map(days.map((day) => [day.date, day]))
  const [y, m, d] = todayKey.split('-').map(Number)
  const values: number[] = []
  const dates: string[] = []
  let saved = 0
  let input = 0
  for (let i = count - 1; i >= 0; i -= 1) {
    const date = new Date(Date.UTC(y, (m ?? 1) - 1, (d ?? 1) - i))
    const key = date.toISOString().slice(0, 10)
    const day = byDate.get(key)
    values.push(day ? day.saved : 0)
    dates.push(key)
    saved += day?.saved ?? 0
    input += day?.input ?? 0
  }
  return { values, dates, saved, input }
}

/* ── kernel update panel ───────────────────────────────────────────────────────────────────────── */

export const UPDATE_RESULT_WORD: Record<string, string> = {
  'up-to-date': '已是最新',
  'update-available': '发现新版本',
  updated: '已更新',
  rehearsed: '演练完成',
  'rolled-back': '已回滚',
  'failed-before-swap': '替换前失败 · 旧版本未动',
}

export const UPSTREAM_WORD: Record<string, string> = {
  not_checked: '尚未检查',
  unchanged: '无变化',
  review_required: '待评审',
  error: '检查失败 · 保留当前版本',
  baseline_mismatch: '运行版本与契约不一致',
}

export type UpstreamChangesLike = {
  addedRoutes: string[]
  removedRoutes: string[]
  changedRoutes: string[]
  addedLoginAgents: string[]
  removedLoginAgents: string[]
}

export function contractDiffCount(changes: UpstreamChangesLike | null | undefined): number {
  if (!changes) return 0
  return changes.addedRoutes.length + changes.removedRoutes.length + changes.changedRoutes.length + changes.addedLoginAgents.length + changes.removedLoginAgents.length
}

/* ── 网关 Magpie (#magpie) ─────────────────────────────────────────────────────────────────────── */

/** `crosery-3fe2ff9` / a 40-hex sha / `3fe2ff9` → `3fe2ff9`, so every place names the build the same way. */
export function shortRev(value: string | null | undefined): string | null {
  if (!value) return null
  const match = /(?:^|crosery-)([a-f0-9]{7,40})$/.exec(value.trim())
  return match ? match[1].slice(0, 7) : value
}

export type GapLike = { state: 'latest' | 'behind' | 'unknown'; label: string }

/** Behind is a to-do for a person, not a fault: a hollow ring (never orange). */
export function gapMark(gap: GapLike): { state: MarkKind; label: string } {
  if (gap.state === 'latest') return { state: 'run', label: gap.label }
  if (gap.state === 'behind') return { state: 'pause', label: gap.label }
  return { state: 'stale', label: '差距未知' }
}

/** The settings index value: 最新 / 落后 / 离线; only an offline kernel needs a person now. */
export function gatewayIndex(g: { current: { running: boolean }; gap: GapLike }): { value: string; hot: boolean } {
  if (!g.current.running) return { value: '◆ 离线', hot: true }
  return { value: g.gap.state === 'latest' ? '最新' : g.gap.state === 'behind' ? '落后' : '未知', hot: false }
}
