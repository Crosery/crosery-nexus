/**
 * 概览 page model (DESIGN §6.2): pure mapping from the console's existing endpoints to the dashboard's rows,
 * so the rules are unit-tested (server/overviewModel.test.ts) instead of living in the template.
 *
 * Sources and their populations — kept apart on purpose (DESIGN §6.0 "words mean one thing"):
 * - attention / Key burn: Key quota ledger (`/api/bootstrap` quotaState), accounts (`/api/monitor`),
 *   channels (`/api/channels`), sync jobs (`/api/sync/status`), kernel (`/api/version`).
 * - 近 24 小时 ledger: the usage endpoints (`/api/dashboard`, `/api/usage-overview`, `/api/cache-summary`,
 *   `/api/charts`) with `days=1` — the same numbers the 用量 workspace shows for its 24h range (the cache hit
 *   rate counts cache-capable models only, as the 缓存 tab does; `/api/cache-trend` is the labelled fallback).
 * - gateway / channel health / 24h micro-bars: every logged request (`/api/pulse`, `/api/overview`).
 */
import { fmtCompact, fmtDuration, fmtInt, fmtNum, fmtPct, fmtTime, fmtUsd, NONE } from '../../ui/fmt.js'
import type { AttentionItem, LaneJob, ReadoutDelta, Severity, StatusKind } from '../../ui/types'
import type {
  ApiKeyItem,
  CacheTrendData,
  ChannelItem,
  ChartsData,
  DashboardData,
  QuotaWindowState,
  SyncJob,
  SyncPolicy,
  UsageOverviewData,
  VersionsData,
} from '../../types'
import type { MonitorAccount, OverviewChannelRow } from './types'
import { keyStatus, STATUS_VIEW } from '../keys/keysModel.js'

const HOUR = 3_600_000
const DAY = 24 * HOUR

/* ── shared helpers ───────────────────────────────────────────────────────────────────────────── */

const WINDOW_WORD = { daily: '日', weekly: '周', total: '总' } as const
type KeyWindow = keyof typeof WINDOW_WORD

/** `sk-api-••••••••bf2ee` → `…bf2ee` (the tail is all a person needs to tell keys apart). */
export function keyTail(masked: string): string {
  const tail = masked.split(/[•*]+/).pop() ?? ''
  return tail && tail !== masked ? `…${tail}` : masked
}

/** 1,800,000 → `每 30M`; null → `按需` (request-driven jobs). */
export function fmtEvery(ms: number | null | undefined): string {
  if (!ms || ms <= 0) return '按需'
  if (ms < 60_000) return `每 ${Math.round(ms / 1000)}S`
  if (ms < HOUR) return `每 ${Math.round(ms / 60_000)}M`
  if (ms < DAY) return `每 ${Math.round(ms / HOUR)}H`
  return `每 ${Math.round(ms / DAY)}D`
}

/** 60,000 → `1m`; 21,600,000 → `6h` (policy words). */
export function fmtSpan(ms: number | null | undefined): string {
  if (!ms || ms <= 0) return NONE
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  if (ms < HOUR) return `${Math.round(ms / 60_000)}m`
  if (ms < DAY) return `${Math.round((ms / HOUR) * 10) / 10}h`
  return `${Math.round((ms / DAY) * 10) / 10}d`
}

const toMs = (value: string | number | null | undefined): number | null => {
  if (value === null || value === undefined || value === '') return null
  const ms = typeof value === 'number' ? value : Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

/** Plain words for the most common gateway status codes (raw code stays as the mono suffix). */
export function statusWord(code: number): string {
  if (code === 429) return '限流'
  if (code === 401 || code === 403) return '鉴权'
  if (code === 400 || code === 413 || code === 422) return '请求错误'
  if (code === 404) return '不存在'
  if (code >= 500) return '上游错误'
  if (code === 0) return '连接失败'
  return '失败'
}

/* ── sync jobs ────────────────────────────────────────────────────────────────────────────────── */

export type JobChip = 'ok' | 'running' | 'backoff' | 'failed' | 'idle' | 'off'

/** Same reading of a C3 job as the statusline squares, plus `off` for jobs disabled by config. */
export function jobChip(job: Pick<SyncJob, 'state' | 'lastResult'>): JobChip {
  if (job.state === 'running') return 'running'
  if (job.state === 'backoff') return 'backoff'
  if (job.state === 'error' || job.lastResult === 'error') return 'failed'
  if (job.state === 'disabled') return 'off'
  if (job.state === 'unknown' || job.lastResult === null) return 'idle'
  return 'ok'
}

const CHIP_MARK: Record<JobChip, { state: StatusKind; label: string }> = {
  ok: { state: 'run', label: '正常' },
  running: { state: 'busy', label: '同步中' },
  backoff: { state: 'warn', label: '退避' },
  failed: { state: 'bad', label: '失败' },
  idle: { state: 'idle', label: '空闲' },
  off: { state: 'off', label: '停用' },
}

export function laneJobs(jobs: SyncJob[]): LaneJob[] {
  return jobs.map((job) => {
    const chip = jobChip(job)
    const mark = CHIP_MARK[chip]
    return {
      id: job.id,
      label: job.label,
      every: job.kind === 'external' && !job.intervalMs ? '外部' : fmtEvery(job.intervalMs),
      runs: job.history.map((run) => ({ at: run.at, durationMs: run.durationMs, result: run.result })),
      nextAt: chip === 'off' ? null : job.nextRunAt,
      backoffUntil: job.backoffUntil,
      calls24h: job.requests24h,
      state: mark.state,
      stateLabel: chip === 'backoff' && job.backoffLevel > 0 ? `退避 ×${2 ** job.backoffLevel}` : mark.label,
      summary: job.summary,
      lastAt: job.lastFinishedAt ?? job.lastRunAt,
    }
  })
}

export function policyWords(policy: SyncPolicy | null | undefined): string | null {
  if (!policy) return null
  return [
    `全局上游并发 ${policy.globalUpstreamConcurrency}`,
    `单源间隔 ≥${fmtSpan(policy.minIntervalPerHostMs)}`,
    `失败退避 ×${policy.backoff.factor} ≤${fmtSpan(policy.backoff.maxMs)}`,
  ].join(' · ')
}

/* ── accounts ─────────────────────────────────────────────────────────────────────────────────── */

const WINDOW_SHORT: Array<[number, string]> = [
  [5 * HOUR, '5H'],
  [DAY, '1D'],
  [7 * DAY, '7D'],
  [30 * DAY, '30D'],
]

/** `5H` / `7D` from the window length; label words as a fallback (`7 天 Opus` → `7D·OPUS`). */
export function windowShort(win: { windowSeconds: number | null; label: string; id: string }): string {
  if (win.windowSeconds) {
    const ms = win.windowSeconds * 1000
    const hit = WINDOW_SHORT.find(([len]) => Math.abs(len - ms) <= len * 0.05)
    if (hit) return hit[1]
  }
  const label = `${win.label} ${win.id}`.toLowerCase()
  if (/5\s*小时|five|session|5h/.test(label)) return '5H'
  if (/opus/.test(label)) return '7D·O'
  if (/sonnet/.test(label)) return '7D·S'
  if (/7\s*天|seven|week|7d/.test(label)) return '7D'
  if (/月|month/.test(label)) return '月'
  return win.label.slice(0, 4).toUpperCase()
}

export type PressureRow = {
  id: string
  provider: string
  email: string
  plan: string
  /** tightest window; null when the account reports no windows */
  window: { short: string; label: string; ratio: number; resetsAt: string | null } | null
  state: StatusKind
  stateLabel: string
  /** cooling until (self-healing; shown as an ink pie, never orange) */
  coolUntil: string | null
  credits: number | null
  error: string | null
  disabled: boolean
}

function accountId(a: MonitorAccount, i: number): string {
  return String(a.auth_index ?? a.name ?? a.email ?? i)
}

function accountEmail(a: MonitorAccount): string {
  return String(a.email || a.account || a.name || '未命名账号')
}

function authFailed(a: MonitorAccount): boolean {
  return a.status === 'error' && /401|403|unauthori|invalid_grant|expired|revoked|forbidden/i.test(String(a.status_message ?? ''))
}

export function pressureRows(accounts: MonitorAccount[], now: number): PressureRow[] {
  const rows = accounts.map((a, i): PressureRow => {
    const windows = a.normalizedQuota?.windows ?? []
    const tight = windows.reduce<(typeof windows)[number] | null>((m, w) => (!m || w.usedPercent > m.usedPercent ? w : m), null)
    const coolMs = a.unavailable ? toMs(a.next_retry_after ?? null) : null
    const cooling = coolMs !== null && coolMs > now
    const error = a.normalizedQuota?.error || a.quota?.error || null
    const ratio = tight ? tight.usedPercent / 100 : null
    let state: StatusKind = 'run'
    let stateLabel = '运行'
    if (a.disabled) [state, stateLabel] = ['pause', '暂停']
    else if (authFailed(a)) [state, stateLabel] = ['bad', '失效']
    else if (ratio !== null && ratio >= 1) [state, stateLabel] = ['bad', '已用尽']
    else if (cooling) [state, stateLabel] = ['cool', '冷却']
    else if (error) [state, stateLabel] = ['stale', '读取失败']
    else if (ratio !== null && ratio >= 0.9) [state, stateLabel] = ['warn', '接近上限']
    return {
      id: accountId(a, i),
      provider: String(a.type || a.provider || 'oauth'),
      email: accountEmail(a),
      plan: a.normalizedQuota?.tier || a.normalizedQuota?.plan || '',
      window: tight ? { short: windowShort(tight), label: tight.label, ratio: tight.usedPercent / 100, resetsAt: tight.resetsAt } : null,
      state,
      stateLabel,
      coolUntil: cooling ? new Date(coolMs!).toISOString() : null,
      credits: a.normalizedQuota?.resetCredits ? a.normalizedQuota.resetCredits.available : null,
      error: error ? String(error) : null,
      disabled: Boolean(a.disabled),
    }
  })
  const rank = (r: PressureRow) => (r.disabled ? -2 : r.window ? r.window.ratio : r.coolUntil ? 0.5 : -1)
  return rows.sort((a, b) => rank(b) - rank(a) || a.email.localeCompare(b.email))
}

/* ── Keys ─────────────────────────────────────────────────────────────────────────────────────── */

export type BurnWindow = { spent: number; limit: number | null; ratio: number | null; resetsAt: string | null }

export type BurnRow = {
  id: string
  name: string
  tail: string
  enabled: boolean
  today: BurnWindow
  week: BurnWindow
  total: BurnWindow
  /** max(day, week, total) ratio among limited windows; null = no limits */
  pressure: number | null
  exceeded: boolean
  state: StatusKind
  stateLabel: string
  /** last call within 2 min (the Keys page's live ring) */
  live: boolean
  /** 24 hourly request counts (oldest first) from /api/overview; null when that endpoint is unavailable */
  hours: number[] | null
  hourErrors: number[] | null
  requests24h: number | null
  lastUsedAt: string | null
}

const windowOf = (w: QuotaWindowState): BurnWindow => ({
  spent: Number(w.spentUsd) || 0,
  limit: w.limitUsd > 0 ? w.limitUsd : null,
  ratio: w.limitUsd > 0 && typeof w.ratio === 'number' ? w.ratio : null,
  resetsAt: w.resetsAt,
})

const LIVE_MS = 120_000

export function burnRows(keys: ApiKeyItem[], hours: Map<string, { requests: number[]; errors: number[]; total: number }> | null | undefined, now: number): BurnRow[] {
  return keys
    .map((k): BurnRow => {
      const qs = k.quotaState
      const ratios = (['daily', 'weekly', 'total'] as const).map((w) => windowOf(qs[w]).ratio).filter((r): r is number => r !== null)
      const pressure = ratios.length ? Math.max(...ratios) : null
      // an over-quota Key is auto-stopped: enabled=false with blockedReason set (server/quota.ts restores it)
      const exceeded = Boolean(k.blockedReason || (k.enabled && qs.exceeded))
      const h = hours?.get(k.id) ?? null
      const lastUsed = k.lastUsedAt ? Date.parse(k.lastUsedAt) : Number.NaN
      // same word as the Keys page for the same Key (启用 · 接近上限 · 超额停用 · 停用); activity is the 24h bars
      const status = keyStatus(k)
      const state: StatusKind = STATUS_VIEW[status].mark
      const stateLabel = STATUS_VIEW[status].word
      const live = status === 'run' && Number.isFinite(lastUsed) && now - lastUsed < LIVE_MS
      return {
        id: k.id,
        name: k.name,
        tail: keyTail(k.maskedKey),
        enabled: k.enabled,
        today: windowOf(qs.daily),
        week: windowOf(qs.weekly),
        total: windowOf(qs.total),
        pressure,
        exceeded,
        state,
        stateLabel,
        live,
        hours: hours ? (h?.requests ?? Array(24).fill(0)) : null,
        hourErrors: hours ? (h?.errors ?? Array(24).fill(0)) : null,
        requests24h: hours ? (h?.total ?? 0) : null,
        lastUsedAt: k.lastUsedAt ?? null,
      }
    })
    .sort((a, b) =>
      Number(b.exceeded) - Number(a.exceeded)
      || (b.pressure ?? -1) - (a.pressure ?? -1)
      || b.today.spent - a.today.spent
      || b.week.spent - a.week.spent
      || (b.requests24h ?? 0) - (a.requests24h ?? 0)
      || Number(b.enabled) - Number(a.enabled)
      || a.name.localeCompare(b.name))
}

/** The one quota meter of a burn row: the tightest limited window of 日 / 周 / 总 (the same max as `pressure`). */
export function tightWindow(row: Pick<BurnRow, 'today' | 'week' | 'total'>): { label: string; ratio: number } | null {
  const windows: Array<{ label: string; ratio: number | null }> = [
    { label: WINDOW_WORD.daily, ratio: row.today.ratio },
    { label: WINDOW_WORD.weekly, ratio: row.week.ratio },
    { label: WINDOW_WORD.total, ratio: row.total?.ratio ?? null },
  ]
  const list = windows.filter((w): w is { label: string; ratio: number } => w.ratio !== null)
  return list.length ? list.reduce((a, b) => (b.ratio > a.ratio ? b : a)) : null
}

/* ── channel health ───────────────────────────────────────────────────────────────────────────── */

export type ChannelHealthRow = {
  key: string
  name: string
  /** OAuth providers (codex / claude / antigravity) live on /accounts, compat channels on /channels */
  to: string
  state: StatusKind
  stateLabel: string
  requests: number
  errors: number
  errRate: number | null
  p95Ms: number | null
  ticks: number[]
  bad: boolean[]
  hot: boolean
}

const OAUTH_PROVIDERS = new Set(['codex', 'claude', 'antigravity', 'gemini', 'gemini-cli', 'qwen', 'iflow', 'kimi'])
export const CHANNEL_ERR_WARN = 0.2
export const CHANNEL_ERR_BAD = 0.5

function channelState(requests: number, errors: number): { state: StatusKind; label: string; hot: boolean } {
  const rate = requests ? errors / requests : 0
  if (requests >= 5 && rate >= CHANNEL_ERR_BAD) return { state: 'bad', label: '失败多', hot: true }
  if (requests >= 10 && rate >= CHANNEL_ERR_WARN) return { state: 'warn', label: '注意', hot: true }
  return requests ? { state: 'run', label: '正常', hot: false } : { state: 'idle', label: '空闲', hot: false }
}

/** Channels with traffic first (busiest first), then enabled idle channels, then disabled ones. */
export function channelHealth(rows: OverviewChannelRow[] | null, channels: ChannelItem[] | null, ticksLen = 36): ChannelHealthRow[] {
  const byName = new Map((rows ?? []).map((r) => [r.name, r]))
  const out: ChannelHealthRow[] = []
  const seen = new Set<string>()
  const idle = Array(ticksLen).fill(0)
  for (const r of rows ?? []) {
    const channel = channels?.find((c) => c.name.toLowerCase() === r.name)
    const s = channelState(r.requests, r.errors)
    const off = channel && !channel.enabled
    // a channel removed since: its traffic stays (history), named by its id, linked to its usage
    const gone = r.removed === true && !channel
    out.push({
      key: r.provider,
      name: channel?.name ?? r.name,
      to: gone ? `/usage?provider=${encodeURIComponent(r.name)}` : OAUTH_PROVIDERS.has(r.name) ? '/accounts' : `/channels?q=${encodeURIComponent(channel?.name ?? r.name)}`,
      state: gone || off ? 'off' : s.state,
      stateLabel: gone ? '已移除' : off ? '停用' : s.label,
      requests: r.requests,
      errors: r.errors,
      errRate: r.requests ? r.errors / r.requests : null,
      p95Ms: r.p95Ms,
      ticks: r.ticks,
      bad: r.ticks.map((n, i) => n > 0 && r.bad[i] / n >= CHANNEL_ERR_WARN),
      hot: s.hot && !off && !gone,
    })
    seen.add(r.name)
  }
  const rest = (channels ?? []).filter((c) => !seen.has(c.name.toLowerCase()) && !byName.has(c.name.toLowerCase()))
  rest.sort((a, b) => Number(b.enabled) - Number(a.enabled) || Number(a.stale) - Number(b.stale) || a.name.localeCompare(b.name))
  for (const c of rest) {
    out.push({
      key: `ch:${c.name}`,
      name: c.name,
      to: `/channels?q=${encodeURIComponent(c.name)}`,
      state: c.stale ? 'warn' : c.enabled ? 'idle' : 'off',
      stateLabel: c.stale ? '残留' : c.enabled ? '空闲' : '停用',
      requests: 0,
      errors: 0,
      errRate: null,
      p95Ms: null,
      ticks: idle,
      bad: idle.map(() => false),
      hot: false,
    })
  }
  return out
}

/* ── attention ────────────────────────────────────────────────────────────────────────────────── */

export type AttentionInput = {
  now: number
  keys?: ApiKeyItem[] | null
  accounts?: MonitorAccount[] | null
  channels?: ChannelItem[] | null
  health?: ChannelHealthRow[] | null
  jobs?: SyncJob[] | null
  versions?: VersionsData | null
}

export type AttentionDomain = 'gateway' | 'key' | 'acct' | 'chan' | 'sync' | 'kern'

/** what a person reads in the kind column: the item `kind` codes (KEY · ACCT …) stay stable for tests and filters */
export const DOMAIN_WORD: Record<AttentionDomain, string> = { gateway: '网关', key: 'Key', acct: '账号', chan: '渠道', sync: '同步', kern: '内核' }
const KIND_WORD: Record<string, string> = { GW: '网关', KEY: 'Key', ACCT: '账号', CHAN: '渠道', SYNC: '同步', KERN: '内核' }
export const kindWord = (kind: string): string => KIND_WORD[kind] ?? kind

export type AttentionResult = {
  items: Array<AttentionItem & { domain: AttentionDomain }>
  recovered: AttentionItem[]
  counts: Record<Exclude<Severity, 'ok'>, number>
}

const RANK: Record<Severity, number> = { bad: 0, warn: 1, note: 2, ok: 3 }

function keyItems(keys: ApiKeyItem[]): AttentionResult['items'] {
  const out: AttentionResult['items'] = []
  for (const k of keys) {
    // manually stopped Keys are not to-dos; quota-stopped ones are (enabled=false + blockedReason)
    if (!k.enabled && !k.blockedReason) continue
    const qs = k.quotaState
    const to = `/keys?q=${encodeURIComponent(k.name)}`
    if (qs.exceeded || k.blockedReason) {
      const w = (qs.exceededWindow ?? 'daily') as KeyWindow
      const win = qs[w]
      out.push({
        id: `key:${k.id}`, domain: 'key', severity: 'bad', kind: 'KEY', subject: k.name,
        reason: `${WINDOW_WORD[w]}额度超出 · 已自动停用`,
        metric: win.limitUsd > 0 ? `${fmtUsd(win.spentUsd)} / ${fmtUsd(win.limitUsd)}` : undefined,
        action: { label: '调整额度', to },
      })
      continue
    }
    let worst: { w: KeyWindow; ratio: number } | null = null
    for (const w of ['daily', 'weekly', 'total'] as const) {
      const win = qs[w]
      if (win.limitUsd > 0 && typeof win.ratio === 'number' && win.ratio >= 0.9 && (!worst || win.ratio > worst.ratio)) worst = { w, ratio: win.ratio }
    }
    if (worst) {
      const resets = qs[worst.w].resetsAt
      out.push({
        id: `key:${k.id}`, domain: 'key', severity: 'warn', kind: 'KEY', subject: k.name,
        reason: `${WINDOW_WORD[worst.w]}额度已用 ${fmtPct(worst.ratio, 0)} · ${resets ? `${fmtTime(resets)} 重置` : '不会自动重置'}`,
        metric: fmtPct(worst.ratio, 0),
        action: { label: '调整额度', to },
      })
    }
  }
  return out
}

function accountItems(accounts: MonitorAccount[], now: number): AttentionResult['items'] {
  const out: AttentionResult['items'] = []
  const rows = pressureRows(accounts, now)
  const byProvider = new Map<string, PressureRow[]>()
  for (const r of rows) {
    if (r.disabled) continue
    byProvider.set(r.provider, [...(byProvider.get(r.provider) ?? []), r])
  }
  for (const r of rows) {
    if (r.disabled) continue
    const to = `/accounts?q=${encodeURIComponent(r.email)}`
    const base = { domain: 'acct' as const, kind: 'ACCT', subject: r.email, email: true }
    if (r.state === 'bad' && r.stateLabel === '失效') {
      out.push({ ...base, id: `acct:${r.id}`, severity: 'bad', reason: `${r.provider} 授权失效 · 不再接流量`, action: { label: '重新授权', to } })
    } else if (r.state === 'bad' && r.window) {
      out.push({
        ...base, id: `acct:${r.id}`, severity: 'bad',
        reason: `${r.window.short} 额度用尽 · ${r.window.resetsAt ? `${fmtTime(r.window.resetsAt, now)} 重置` : '等待重置'}`,
        metric: fmtPct(r.window.ratio, 0),
        action: { label: r.credits ? '去重置' : '查看', to },
      })
    } else if (r.state === 'warn' && r.window) {
      out.push({
        ...base, id: `acct:${r.id}`, severity: 'warn',
        reason: `${r.window.short} 窗口 ${fmtPct(r.window.ratio, 0)} · ${r.window.resetsAt ? `${fmtTime(r.window.resetsAt, now)} 重置` : '等待重置'}`,
        metric: fmtPct(r.window.ratio, 0),
        action: { label: '查看', to },
      })
    } else if (r.state === 'stale' && r.error) {
      out.push({ ...base, id: `acct:${r.id}`, severity: 'note', reason: `额度读取失败 · ${r.error.slice(0, 40)}`, action: { label: '查看', to } })
    }
  }
  // a cooldown is self-healing; it needs a person only when it leaves a provider with no routable account
  for (const [provider, list] of byProvider) {
    const routable = list.filter((r) => r.state === 'run' || r.state === 'warn' || r.state === 'stale')
    const cooling = list.filter((r) => r.state === 'cool')
    if (!routable.length && cooling.length) {
      const soonest = cooling.map((r) => r.coolUntil!).sort()[0]
      out.push({
        id: `acct-pool:${provider}`, domain: 'acct', severity: 'warn', kind: 'ACCT', subject: `${provider} 账号池`,
        reason: `${list.length} 个账号都不可用 · 最早 ${fmtTime(soonest, now)} 恢复`,
        metric: `冷却 ${cooling.length}`,
        action: { label: '查看', to: '/accounts' },
      })
    }
  }
  return out
}

function channelItems(channels: ChannelItem[], health: ChannelHealthRow[]): AttentionResult['items'] {
  const out: AttentionResult['items'] = []
  for (const h of health) {
    if (!h.hot || h.errRate === null) continue
    out.push({
      id: `chan:${h.key}`, domain: 'chan', severity: h.state === 'bad' ? 'bad' : 'warn', kind: 'CHAN', subject: h.name,
      reason: `近 3h 错误率 · ${fmtInt(h.errors)}/${fmtInt(h.requests)}`,
      metric: fmtPct(h.errRate),
      action: { label: '看请求', to: `/usage/requests?days=1&provider=${encodeURIComponent(h.name)}` },
    })
  }
  for (const c of channels) {
    if (c.stale) {
      out.push({ id: `chan-stale:${c.name}`, domain: 'chan', severity: 'warn', kind: 'CHAN', subject: c.name, reason: '网关里已删除 · 本地仍记为启用', action: { label: '查看', to: `/channels?q=${encodeURIComponent(c.name)}` } })
    } else if (c.enabled && c.keyCount === 0) {
      out.push({ id: `chan-key:${c.name}`, domain: 'chan', severity: 'warn', kind: 'CHAN', subject: c.name, reason: '没有上游 Key · 请求会失败', action: { label: '查看', to: `/channels?q=${encodeURIComponent(c.name)}` } })
    }
  }
  const off = channels.filter((c) => !c.enabled && !c.stale)
  if (off.length) {
    out.push({
      id: 'chan-off', domain: 'chan', severity: 'note', kind: 'CHAN',
      subject: off.length === 1 ? off[0].name : `${off.length} 个渠道已停用`,
      reason: off.length === 1 ? '已停用 · 不接流量' : `${off.slice(0, 3).map((c) => c.name).join(' · ')}${off.length > 3 ? ' …' : ''} · 不接流量`,
      action: { label: '查看', to: '/channels?status=off' },
    })
  }
  return out
}

function syncItems(jobs: SyncJob[], now: number): { items: AttentionResult['items']; recovered: AttentionItem[] } {
  const items: AttentionResult['items'] = []
  const recovered: AttentionItem[] = []
  for (const job of jobs) {
    const chip = jobChip(job)
    if (chip === 'backoff') {
      items.push({
        id: `sync:${job.id}`, domain: 'sync', severity: 'warn', kind: 'SYNC', subject: job.label,
        reason: [job.backoffUntil ? `退避至 ${fmtTime(job.backoffUntil, now)}` : '退避中', job.lastError].filter(Boolean).join(' · '),
        metric: job.backoffLevel > 0 ? `×${2 ** job.backoffLevel}` : undefined,
        action: { label: '同步中心', to: '/settings#sync' },
      })
    } else if (chip === 'failed') {
      items.push({
        id: `sync:${job.id}`, domain: 'sync', severity: 'bad', kind: 'SYNC', subject: job.label,
        reason: `上次失败${job.lastError ? ` · ${job.lastError}` : ''}`,
        metric: job.lastRunAt ? fmtTime(job.lastRunAt, now) : undefined,
        action: { label: '同步中心', to: '/settings#sync' },
      })
    } else if (chip === 'ok') {
      const failedAt = [...job.history].reverse().find((run) => run.result === 'error' && (toMs(run.at) ?? 0) >= now - DAY)
      if (failedAt) recovered.push({ id: `sync-rec:${job.id}`, severity: 'ok', kind: 'SYNC', subject: job.label, reason: `${fmtTime(failedAt.at, now)} 失败 · 之后已恢复` })
    }
  }
  return { items, recovered }
}

function kernelItems(versions: VersionsData): AttentionResult['items'] {
  const cpa = versions.cpa
  if (!cpa) return []
  const engine = cpa.engine === 'magpie' ? 'magpie' : 'cpa'
  if (cpa.version === 'offline') {
    return [{ id: 'kern:offline', domain: 'kern', severity: 'bad', kind: 'KERN', subject: `${engine} 内核`, reason: '网关内核离线 · 请求无法转发', action: { label: '查看', to: '/settings#magpie' } }]
  }
  const up = cpa.upstream
  if (up?.status === 'review_required') {
    const c = up.changes
    // same count and word as /settings 内核与版本 (routes + login agents)
    const n = (c?.addedRoutes.length ?? 0) + (c?.removedRoutes.length ?? 0) + (c?.changedRoutes.length ?? 0)
      + (c?.addedLoginAgents?.length ?? 0) + (c?.removedLoginAgents?.length ?? 0)
    return [{
      // the subject names upstream's release, not the running build (that is cpa.commit) — say so
      id: 'kern:review', domain: 'kern', severity: 'note', kind: 'KERN', subject: `${engine} 上游 ${up.latestRelease ?? up.candidateRevision?.slice(0, 7) ?? ''}`.trim(),
      reason: `内核上游有候选 · 契约变化 ${n} 项`, metric: '待评审', action: { label: '看差异', to: '/settings#magpie' },
    }]
  }
  if (up?.status === 'error' || up?.status === 'baseline_mismatch') {
    return [{ id: 'kern:check', domain: 'kern', severity: 'warn', kind: 'KERN', subject: `${engine} 上游检查`, reason: up.status === 'error' ? '上游检查失败' : '基线不一致 · 需人工核对', action: { label: '查看', to: '/settings#magpie' } }]
  }
  return []
}

export function attention(input: AttentionInput): AttentionResult {
  const items: AttentionResult['items'] = []
  let recovered: AttentionItem[] = []
  if (input.keys) items.push(...keyItems(input.keys))
  if (input.accounts) items.push(...accountItems(input.accounts, input.now))
  if (input.channels) items.push(...channelItems(input.channels, input.health ?? []))
  if (input.jobs) {
    const s = syncItems(input.jobs, input.now)
    items.push(...s.items)
    recovered = s.recovered
  }
  if (input.versions) items.push(...kernelItems(input.versions))
  items.sort((a, b) => RANK[a.severity] - RANK[b.severity])
  const counts = { bad: 0, warn: 0, note: 0 }
  for (const it of items) if (it.severity !== 'ok') counts[it.severity] += 1
  return { items, recovered, counts }
}

/** `◆ 2 告警 · ◇ 3 注意 · ○ 2 提示`, or null when all clear. */
export function severityWords(counts: AttentionResult['counts']): Array<{ mark: string; text: string; hot: boolean }> {
  const out = []
  if (counts.bad) out.push({ mark: '◆', text: `${counts.bad} 告警`, hot: true })
  if (counts.warn) out.push({ mark: '◇', text: `${counts.warn} 注意`, hot: true })
  if (counts.note) out.push({ mark: '○', text: `${counts.note} 提示`, hot: false })
  return out
}

/* ── 巡检 completeness: 全部正常 needs every required source ─────────────────────────────────────── */

export type InspectionSource = { label: string; state: string }
export type Inspection = { state: 'loading' | 'complete' | 'partial' | 'failed'; words: string }

/**
 * An empty attention list only means 全部正常 when every source it is built from was read. A source still loading,
 * failed (`error` / `forbidden`) or stale (last refresh failed) is named instead, so a failed /api/monitor never
 * reads as "no account problems".
 */
export function inspection(sources: InspectionSource[]): Inspection {
  const failedState = (state: string) => state === 'error' || state === 'forbidden'
  if (sources.length && sources.every((s) => failedState(s.state))) return { state: 'failed', words: '巡检失败 · 数据都没读到' }
  const by = (pick: (state: string) => boolean) => sources.filter((s) => pick(s.state)).map((s) => s.label)
  const loading = by((state) => state === 'loading')
  const failed = by(failedState)
  const stale = by((state) => state === 'stale')
  const parts = [
    loading.length ? `${loading.join('、')}读取中` : '',
    failed.length ? `${failed.join('、')}未读到` : '',
    stale.length ? `${stale.join('、')}数据陈旧` : '',
  ].filter(Boolean)
  if (!parts.length) return { state: 'complete', words: '全部正常' }
  if (loading.length && !failed.length && !stale.length) return { state: 'loading', words: `巡检中… · ${parts.join(' · ')}` }
  return { state: 'partial', words: `巡检不完整 · ${parts.join(' · ')}` }
}

/* ── 近 24 小时 ledger ─────────────────────────────────────────────────────────────────────────── */

export type LedgerCell = {
  key: string
  label: string
  value: string
  delta: ReadoutDelta | null
  history: Array<number | null> | null
  sub: string | null
}

type Window = { requests: number; tokens: number; errors: number }

/**
 * Eight rolling 24h windows from `/api/dashboard?days=8` hour buckets, newest first. Window 0 uses the same
 * `hour_ms >= now − 24h` cut as `days=1`, so it equals the 24h figures on the 用量 pages.
 */
export function rollingWindows(trend: DashboardData['trend'], now: number, count = 8): Window[] {
  const out: Window[] = Array.from({ length: count }, () => ({ requests: 0, tokens: 0, errors: 0 }))
  for (const b of trend) {
    const ms = Date.parse(`${b.bucket}:00:00Z`)
    if (!Number.isFinite(ms) || ms > now) continue
    const k = Math.floor((now - ms) / DAY)
    // hour_ms ≥ now − (k+1)·24h ⇔ floor((now − hour_ms) / 24h) ≤ k
    if (k < 0 || k >= count) continue
    out[k].requests += Number(b.requests) || 0
    out[k].tokens += Number(b.tokens) || 0
    out[k].errors += Number(b.errors) || 0
  }
  return out
}

const pctChange = (cur: number | null, base: number | null): number | null =>
  cur === null || base === null || base <= 0 ? null : cur / base - 1

export type LedgerInput = {
  now: number
  d1?: DashboardData | null
  d8?: DashboardData | null
  u1?: UsageOverviewData | null
  u8?: UsageOverviewData | null
  cache?: CacheTrendData | null
  /** `/api/cache-summary?days=1` (cache-capable models only); null when the route is not served yet */
  cacheSummary?: CacheSummaryLike | null
  charts?: ChartsData | null
}

/** The fields of `/api/cache-summary` the ledger reads (CONTRACTS · Change usage-b). */
export type CacheSummaryLike = {
  totals: { hitRate: number | null; cacheReadTokens: number; cacheWriteTokens: number }
  excluded?: { models: number; requests: number } | null
}

export function ledger(input: LedgerInput): LedgerCell[] {
  const { d1, d8, u1, u8, cache, cacheSummary, charts } = input
  const now = toMs(d8?.generatedAt ?? null) ?? input.now
  const wins = d8 ? rollingWindows(d8.trend, now) : null
  const prior = wins ? wins.slice(1) : null
  const priorSum = prior?.reduce((a, w) => ({ requests: a.requests + w.requests, tokens: a.tokens + w.tokens, errors: a.errors + w.errors }), { requests: 0, tokens: 0, errors: 0 })
  const history = (pick: (w: Window) => number | null) => (wins ? [...wins].reverse().slice(-7).map(pick) : null)

  const req = d1 ? d1.summary.requests : null
  const tok = d1 ? d1.summary.tokens : null
  const reqMean = priorSum ? priorSum.requests / 7 : null
  const tokMean = priorSum ? priorSum.tokens / 7 : null

  const success = d1 && d1.summary.requests > 0 ? 1 - d1.summary.errorRate : null
  const priorSuccess = priorSum && priorSum.requests > 0 ? 1 - priorSum.errors / priorSum.requests : null
  const topCode = charts?.statusCodes?.[0]
  const failures = d1 ? Math.round(d1.summary.errorRate * d1.summary.requests) : null

  // cost: u1 is the 24h window; the 7 prior days are u8 − u1 (both current channels, same estimate rules)
  const cost = u1 ? u1.estimatedCostUsd : null
  const unpriced = u1?.unpricedModels?.length ?? 0
  const costBase = u1 && u8 && u1.estimatedCostUsd !== null && u8.estimatedCostUsd !== null ? (u8.estimatedCostUsd - u1.estimatedCostUsd) / 7 : null
  let costValue = NONE
  let costSub: string | null = null
  if (u1) {
    if (!u1.requests) costSub = '近 24h 无请求'
    else if (cost === null) costSub = '未定价'
    else {
      costValue = fmtUsd(cost, { approx: u1.hasPartialCost })
      if (unpriced) costSub = `未定价 ${unpriced} 个模型 · 不计入`
    }
  }

  // latency: d1 avg; the prior mean is backed out of the 8-day weighted average
  const lat = d1 && d1.summary.requests > 0 ? d1.summary.avgLatency : null
  const latBase = d1 && d8 && d8.summary.requests - d1.summary.requests > 0
    ? (d8.summary.avgLatency * d8.summary.requests - d1.summary.avgLatency * d1.summary.requests) / (d8.summary.requests - d1.summary.requests)
    : null

  // cache hit: the 缓存 tab's own figure (cache-capable models only). Before that route is served, the raw
  // /api/cache-trend reading also counts models that cannot cache, so it is labelled as that population.
  let hit: number | null = null
  let cacheSub: string | null = null
  if (cacheSummary) {
    const t = cacheSummary.totals
    hit = typeof t.hitRate === 'number' ? t.hitRate : null
    const excluded = cacheSummary.excluded?.models ?? 0
    cacheSub = hit === null
      ? '近 24h 无可缓存请求'
      : `读 ${fmtCompact(t.cacheReadTokens)} · 写 ${fmtCompact(t.cacheWriteTokens)} token${excluded ? ` · 不含 ${fmtInt(excluded)} 个不缓存的模型` : ''}`
  } else if (cache) {
    const points = cache.points ?? []
    const read = points.reduce((s, p) => s + p.cacheReadTokens, 0)
    const denom = points.reduce((s, p) => s + p.cacheReadTokens + p.freshInputTokens + (p.cacheWriteTokens || 0), 0)
    hit = denom > 0 ? read / denom : null
    cacheSub = hit === null ? '近 24h 无可缓存请求' : '含不支持缓存的模型 · 与缓存页口径不同'
  }

  return [
    {
      key: 'requests', label: '请求', value: fmtInt(req),
      delta: req !== null && reqMean ? { value: pctChange(req, reqMean), unit: 'pct' } : null,
      history: history((w) => w.requests),
      sub: req === 0 ? '近 24h 无请求' : null,
    },
    {
      key: 'tokens', label: 'Token', value: fmtCompact(tok),
      delta: tok !== null && tokMean ? { value: pctChange(tok, tokMean), unit: 'pct' } : null,
      history: history((w) => w.tokens),
      sub: null,
    },
    {
      key: 'cost', label: '花费', value: costValue,
      delta: cost !== null && costBase ? { value: pctChange(cost, costBase), unit: 'pct' } : null,
      history: null,
      sub: costSub,
    },
    {
      key: 'success', label: '成功率', value: success === null ? NONE : fmtPct(success, 2),
      delta: success !== null && priorSuccess !== null
        ? { value: success - priorSuccess, unit: 'pp', bad: success < priorSuccess, threshold: 0.02 }
        : null,
      history: history((w) => (w.requests ? 1 - w.errors / w.requests : null)),
      sub: failures && topCode ? `失败 ${fmtInt(failures)} · 主因 ${topCode.code} ${statusWord(topCode.code)} ×${fmtInt(topCode.count)}` : failures ? `失败 ${fmtInt(failures)}` : null,
    },
    {
      key: 'latency', label: '平均耗时', value: fmtDuration(lat),
      delta: lat !== null && latBase ? { value: pctChange(lat, latBase), unit: 'pct', bad: lat > latBase, threshold: 0.2 } : null,
      history: null,
      sub: null,
    },
    {
      key: 'cache', label: '缓存命中', value: hit === null ? NONE : fmtPct(hit),
      delta: null,
      history: null,
      sub: cacheSub,
    },
  ]
}

/* ── 巡检: one line per domain, so an all-clear plate still says what was checked ─────────────────── */

export type CheckRow = { key: AttentionDomain; kind: string; mark: '✓' | '○' | '◇' | '◆' | '—'; hot: boolean; text: string; to: string }

export type ChecksInput = {
  attention: AttentionResult
  gateway?: { requests: number; successRate: number | null; window: string } | null
  pulse?: { rpm: number | null; successRate: number | null } | null
  keys?: ApiKeyItem[] | null
  accounts?: PressureRow[] | null
  channels?: ChannelItem[] | null
  health?: ChannelHealthRow[] | null
  jobs?: SyncJob[] | null
  versions?: VersionsData | null
}

function worst(items: AttentionResult['items'], domain: AttentionDomain): CheckRow['mark'] {
  const list = items.filter((it) => it.domain === domain)
  if (list.some((it) => it.severity === 'bad')) return '◆'
  if (list.some((it) => it.severity === 'warn')) return '◇'
  if (list.some((it) => it.severity === 'note')) return '○'
  return '✓'
}

export function checks(input: ChecksInput): CheckRow[] {
  const items = input.attention.items
  const row = (key: AttentionDomain, text: string, to: string, mark?: CheckRow['mark']): CheckRow => {
    const m = mark ?? worst(items, key)
    return { key, kind: DOMAIN_WORD[key], mark: m, hot: m === '◆' || m === '◇', text, to }
  }
  const out: CheckRow[] = []

  const gw = input.gateway
  const pulse = input.pulse
  if (gw || pulse) {
    const parts: string[] = []
    if (pulse) parts.push(pulse.rpm ? `近 5 分钟 ${fmtNum(pulse.rpm, 1)} rpm · 成功 ${fmtPct(pulse.successRate, 1)}` : '近 5 分钟无请求')
    if (gw) parts.push(gw.requests ? `${gw.window} ${fmtInt(gw.requests)} 次 · 成功 ${fmtPct(gw.successRate, 1)}` : `${gw.window}无请求`)
    const low = (n: number, rate: number | null) => n >= 20 && rate !== null && rate < 0.9
    const bad = (gw && low(gw.requests, gw.successRate)) || (pulse && low((pulse.rpm ?? 0) * 5, pulse.successRate))
    out.push(row('gateway', parts.join(' · '), '/usage/requests?days=1', bad ? '◇' : '✓'))
  } else out.push(row('gateway', '读取失败或读取中', '/usage', '—'))

  if (input.keys) {
    const enabled = input.keys.filter((k) => k.enabled).length
    const limited = input.keys.filter((k) => k.quota.dailyUsd > 0 || k.quota.weeklyUsd > 0 || k.quota.totalUsd > 0).length
    const over = input.keys.filter((k) => k.blockedReason || (k.enabled && k.quotaState.exceeded)).length
    out.push(row('key', `${enabled} 启用 · ${limited} 设了额度 · 超额 ${over}`, '/keys'))
  } else out.push(row('key', '读取失败或读取中', '/keys', '—'))

  if (input.accounts) {
    const list = input.accounts.filter((a) => !a.disabled)
    const cool = list.filter((a) => a.state === 'cool').length
    const out_ = list.filter((a) => a.state === 'bad').length
    out.push(row('acct', list.length ? `${list.length} 个接入 · 冷却 ${cool} · 用尽或失效 ${out_}` : '没有接入账号 · OAuth 额度为 0', '/accounts', list.length ? undefined : '○'))
  } else out.push(row('acct', '读取失败或读取中', '/accounts', '—'))

  if (input.channels) {
    const on = input.channels.filter((c) => c.enabled).length
    const off = input.channels.length - on
    const traffic = (input.health ?? []).reduce((a, h) => ({ n: a.n + h.requests, e: a.e + h.errors }), { n: 0, e: 0 })
    const tail = traffic.n ? `近 3h 错误 ${fmtPct(traffic.e / traffic.n)}` : '近 3h 无请求'
    out.push(row('chan', `${on} 启用 · ${off} 停用 · ${tail}`, '/channels'))
  } else out.push(row('chan', '读取失败或读取中', '/channels', '—'))

  if (input.jobs) {
    const chips = input.jobs.map(jobChip)
    const n = (c: JobChip) => chips.filter((x) => x === c).length
    const words = [`${input.jobs.length} 个任务`, `正常 ${n('ok') + n('running') + n('idle')}`]
    if (n('backoff')) words.push(`退避 ${n('backoff')}`)
    if (n('failed')) words.push(`失败 ${n('failed')}`)
    if (n('off')) words.push(`停用 ${n('off')}`)
    out.push(row('sync', words.join(' · '), '/settings#sync'))
  } else out.push(row('sync', '读取失败或读取中', '/settings#sync', '—'))

  const cpa = input.versions?.cpa
  if (cpa) {
    const engine = cpa.engine === 'magpie' ? 'magpie' : 'cpa'
    const ref = cpa.commit && cpa.commit !== 'unknown' ? cpa.commit.slice(0, 7) : cpa.version
    const up = cpa.upstream
    const tail = cpa.version === 'offline' ? '离线'
      : up?.status === 'review_required' ? `上游 ${up.latestRelease ?? '候选'} 待评审`
      : up?.status === 'unchanged' ? '上游无变化'
      : up?.checkedAt ? `上游检查 ${fmtTime(up.checkedAt)}` : '上游未检查'
    out.push(row('kern', `${engine} ${ref} · ${tail}`, '/settings#magpie'))
  } else out.push(row('kern', '读取中', '/settings#magpie', '—'))

  return out
}

