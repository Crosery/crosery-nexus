/**
 * Pure mapping for /settings (DESIGN.md §6.8): sync jobs (C3) → row words and marks, the policy strip, lane geometry.
 * Structural input types and `.js` specifiers keep it importable by `server/settingsModel.test.ts`.
 */
import { fmtInt, fmtTime } from '../../ui/fmt.js'

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
  'model-availability': '网关 /v1/chat/completions · 每模型一次最小请求',
  'price-watch': '网关 · models.dev · OpenRouter',
  'cpa-catalog': 'CPA 官方目录 ∪ 补充目录',
  'account-quota': '订阅账号额度 · 页面刷新时',
  'data-plane': 'outbox → 数据面',
  'catalog-sync': 'launchd · crosery-models-sync',
  'rtk-autoupdate': 'systemd · crosery-rtk-autoupdate',
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
