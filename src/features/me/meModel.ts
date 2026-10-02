import { clockParts, dayKey, fmtCompact, fmtNum, NONE } from '../../ui/fmt.js'
import type { MeConnect, MeModel, MeModels, MeOverview, MeQuotaWindow, MeRequestItem, MeUsage } from '../../types.js'

/**
 * Pure helpers for the key-user pages (DESIGN §6.10): plain-word failures, quota pace, reset phrases,
 * model vendors and per-million prices. No Vue, no fetch — unit-tested in server/meFeatureModel.test.ts.
 */

/* ── additive C2 fields (server/meRoutes.ts, CONTRACTS "Change (me)"); absent on an un-restarted server ── */
export type MeFailure = { status: number | null; category: string | null; count: number }
export type MeWindowX = MeQuotaWindow & { startsAt?: string | null }
export type MeOverviewX = Omit<MeOverview, 'quota' | 'today'> & {
  quota: { timeZone: string; daily: MeWindowX; weekly: MeWindowX; total: MeWindowX }
  today: MeOverview['today'] & { failures?: MeFailure[]; avgLatencyMs?: number | null }
}
export type MeUsageX = MeUsage & { failures?: MeFailure[]; from?: string }
/** `configured: false` = PUBLIC_GATEWAY_BASE_URL is unset and `baseUrl` is the server's own loopback address */
export type MeConnectX = MeConnect & { configured?: boolean }

const HOUR = 3_600_000
const DAY = 24 * HOUR
const WEEKDAY = ['日', '一', '二', '三', '四', '五', '六']

/* ── failures in plain words ───────────────────────────────────────────────────────────────────────── */

/** Whose problem: 上游 (not yours, retry), 你的请求 (change the call), 本 Key (quota), 未知. */
export type FailureWhose = 'upstream' | 'client' | 'key' | 'unknown'
export type FailureWords = { title: string; whose: FailureWhose; next: string; code: string }

/**
 * What happened · whose problem · what next (DESIGN §6.0 copy tone). The raw code is returned separately so
 * the page can set it as a mono suffix (`429 rate_limited`). Categories come from server/usageDetails.ts.
 */
export function explainFailure(status: number | null | undefined, category: string | null | undefined): FailureWords {
  const s = typeof status === 'number' && status > 0 ? status : null
  const c = (category || '').trim()
  const code = [s, c && c !== 'other' ? c : ''].filter(Boolean).join(' ') || '未知'
  const out = (title: string, whose: FailureWhose, next: string): FailureWords => ({ title, whose, next, code })
  if (c === 'quota_exceeded') return out('本 Key 额度已用完', 'key', '额度重置后自动恢复')
  if (c === 'context_too_large') return out('输入超出模型上下文', 'client', '缩短输入或换长上下文模型')
  if (c === 'client_cancelled' || s === 499) return out('客户端中途断开', 'client', '多为主动中断或客户端超时')
  if (c === 'upstream_eof') return out('上游连接中断', 'upstream', '不是你的问题 · 重试即可')
  if (c === 'rate_limited' || s === 429) return out('上游限流', 'upstream', '不是你的问题 · 稍后重试')
  if (c === 'quota_exhausted' || s === 402) return out('上游账号额度不足', 'upstream', '不是你的问题 · 稍后重试')
  if (c === 'auth_failed' || s === 401 || s === 403) return out('上游账号鉴权失败', 'upstream', '不是你的问题 · 稍后重试')
  if (c === 'wrong_endpoint') return out('模型不支持这个接口', 'client', '换用模型对应的接口')
  if (c === 'upstream_5xx' || (s !== null && s >= 500)) return out('上游服务出错', 'upstream', '不是你的问题 · 稍后重试')
  if (s === 404) return out('模型或接口不存在', 'client', '核对模型 id 与路径')
  if (s === 413) return out('请求体过大', 'client', '缩短输入或拆分请求')
  if (s === 400 || s === 422) return out('请求被上游拒绝', 'client', '检查参数与模型名')
  return out('其他错误', 'unknown', '')
}

export const requestFailure = (item: Pick<MeRequestItem, 'status' | 'errorCategory'>) => explainFailure(item.status, item.errorCategory)

/** `✓ 200` / `◆ 429` — shape + code, colour is never the only cue. */
export const statusText = (item: Pick<MeRequestItem, 'success' | 'status'>) =>
  item.success ? `✓ ${item.status ?? ''}`.trim() : `◆ ${item.status ?? '失败'}`

/** `429 ×2 · 400 ×1` for the 今日 cell. */
export function failureBrief(failures: MeFailure[] | undefined, max = 3): string {
  if (!failures?.length) return ''
  const byStatus = new Map<string, number>()
  for (const f of failures) {
    const k = f.status === null ? (f.category ?? '其他') : String(f.status)
    byStatus.set(k, (byStatus.get(k) ?? 0) + f.count)
  }
  return [...byStatus].sort((a, b) => b[1] - a[1]).slice(0, max).map(([k, n]) => `${k} ×${n}`).join(' · ')
}

/* ── time phrases ──────────────────────────────────────────────────────────────────────────────────── */

const ms = (value: string | number | null | undefined) => (value === null || value === undefined ? null : typeof value === 'number' ? value : Date.parse(value))

/** `2d 16h` · `16h 32m` · `32m` · `<1m`. */
export function fmtLeft(msLeft: number): string {
  if (!Number.isFinite(msLeft) || msLeft <= 0) return '<1m'
  const m = Math.floor(msLeft / 60_000)
  const d = Math.floor(m / 1440)
  const h = Math.floor((m % 1440) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m % 60}m`
  return m > 0 ? `${m}m` : '<1m'
}

/**
 * `今天 24:00 重置 · 16h 32m 后` / `周一 00:00 重置 · 2d 16h 后` / `10/05 00:00 重置 · …` (Asia/Shanghai).
 * A reset at the next local midnight reads 今天 24:00 — that is when people think the day ends.
 */
export function resetPhrase(resetsAt: string | null | undefined, now: number): string {
  const at = ms(resetsAt)
  if (at === null || !Number.isFinite(at)) return '不自动重置'
  const p = clockParts(at)
  if (!p) return '不自动重置'
  const left = at - now
  const hm = `${p.hour}:${p.minute}`
  let when: string
  if (hm === '00:00' && dayKey(at - 1) === dayKey(now)) when = '今天 24:00'
  else if (left < 7 * DAY) when = `周${WEEKDAY[p.weekday]} ${hm}`
  else when = `${p.month}/${p.day} ${hm}`
  return left > 0 ? `${when} 重置 · ${fmtLeft(left)} 后` : `${when} 重置`
}

/** `今天 18:20` / `周日 18:00` / `10/18` — when a pace runs out. */
export function whenPhrase(at: number, now: number): string {
  const p = clockParts(at)
  if (!p) return NONE
  const hm = `${p.hour}:${p.minute}`
  if (dayKey(at) === dayKey(now)) return `今天 ${hm}`
  if (at - now < 6 * DAY) return `周${WEEKDAY[p.weekday]} ${hm}`
  return `${p.month}/${p.day}`
}

/* ── quota pace ────────────────────────────────────────────────────────────────────────────────────── */

/**
 * When the window runs out at its own average speed since `startsAt`; null when there is no limit, no spend,
 * too little history (< 30 min), it is already exceeded, or it would last past the reset.
 */
export function exhaustAt(window: { limitUsd: number | null; spentUsd: number; resetsAt: string | null; exceeded?: boolean }, startsAt: number | null, now: number): number | null {
  const limit = window.limitUsd
  if (!limit || limit <= 0 || window.exceeded || window.spentUsd <= 0 || window.spentUsd >= limit) return null
  if (startsAt === null || !Number.isFinite(startsAt)) return null
  const elapsed = now - startsAt
  if (elapsed < 30 * 60_000) return null
  const rate = window.spentUsd / elapsed
  const at = now + (limit - window.spentUsd) / rate
  const reset = ms(window.resetsAt)
  if (reset !== null && Number.isFinite(reset) && at >= reset) return null
  return at
}

/** Window start: the server's `startsAt` (manual resets included), else the natural start before the reset. */
export function windowStart(window: MeWindowX, kind: 'daily' | 'weekly'): number | null {
  const explicit = ms(window.startsAt ?? null)
  if (explicit !== null && Number.isFinite(explicit)) return explicit
  const reset = ms(window.resetsAt)
  if (reset === null || !Number.isFinite(reset)) return null
  return reset - (kind === 'daily' ? DAY : 7 * DAY)
}

export type QuotaKind = 'daily' | 'weekly' | 'total'
export type QuotaRowView = {
  kind: QuotaKind
  label: string
  window: MeWindowX
  unlimited: boolean
  reset: string
  pace: string | null
}

/**
 * The three quota rows with their reset phrase and pace sentence. `weekAvgPerMs` (spend per ms over the
 * last 7 days) drives the 累计 pace, which only speaks up when the total would run out within 14 days.
 */
export function quotaRows(quota: MeOverviewX['quota'], now: number, weekAvgPerMs: number | null): QuotaRowView[] {
  const daily = quota.daily
  const dailyReset = daily.resetsAt ? Date.parse(daily.resetsAt) : NaN
  const dailyLeft = daily.limitUsd === null ? Infinity : daily.exceeded ? 0 : Math.max(0, daily.limitUsd - daily.spentUsd)
  /** a wider window cannot run out before 24:00 when today's own limit stops spending first */
  const capped = (window: MeWindowX, at: number) => at < dailyReset && dailyLeft < window.limitUsd! - window.spentUsd
  const row = (kind: QuotaKind, label: string, window: MeWindowX): QuotaRowView => {
    const unlimited = window.limitUsd === null
    let pace: string | null = null
    if (!unlimited && kind !== 'total') {
      const at = exhaustAt(window, windowStart(window, kind), now)
      if (at !== null && !(kind !== 'daily' && capped(window, at))) pace = `按${kind === 'daily' ? '今天' : '本周'}的速度，${whenPhrase(at, now)} 前会用尽`
    } else if (!unlimited && weekAvgPerMs && weekAvgPerMs > 0 && window.limitUsd! > window.spentUsd) {
      const at = now + (window.limitUsd! - window.spentUsd) / weekAvgPerMs
      if (at - now < 14 * DAY && !capped(window, at)) pace = `按近 7 天的速度，${whenPhrase(at, now)} 前后用尽`
    }
    return { kind, label, window, unlimited, reset: kind === 'total' ? '不自动重置' : resetPhrase(window.resetsAt, now), pace }
  }
  return [row('daily', '日', quota.daily), row('weekly', '周', quota.weekly), row('total', '累计', quota.total)]
}

/** Linear projection of today's spend to 24:00 once at least an hour has passed. */
export function projectToday(costUsd: number | null, hoursElapsed: number): number | null {
  if (costUsd === null || hoursElapsed < 1) return null
  return (costUsd / hoursElapsed) * 24
}

/* ── models ────────────────────────────────────────────────────────────────────────────────────────── */

export type Vendor = { id: string; label: string; logo: string }
const VENDORS: Array<[RegExp, Vendor]> = [
  [/^(claude|anthropic)/, { id: 'anthropic', label: 'Anthropic', logo: 'anthropic' }],
  [/^(gpt|o\d|chatgpt|codex|openai|dall-e|whisper|tts|text-embedding|computer-use)/, { id: 'openai', label: 'OpenAI', logo: 'openai' }],
  [/^(gemini|gemma|lyria|imagen|veo|google|learnlm)/, { id: 'google', label: 'Google', logo: 'gemini' }],
  [/^(qwen|qwq|qvq|tongyi)/, { id: 'qwen', label: 'Qwen', logo: 'qwen' }],
  [/^(deepseek)/, { id: 'deepseek', label: 'DeepSeek', logo: 'deepseek' }],
  [/^(glm|chatglm|zhipu|cogview)/, { id: 'zhipu', label: '智谱 GLM', logo: 'zhipu' }],
  [/^(kimi|moonshot)/, { id: 'moonshot', label: 'Kimi', logo: 'kimi' }],
  [/^(grok|xai)/, { id: 'xai', label: 'xAI', logo: 'xai' }],
  [/^(minimax|abab)/, { id: 'minimax', label: 'MiniMax', logo: 'minimax' }],
  [/^(mistral|ministral|codestral|devstral|mixtral|voxtral|magistral|pixtral)/, { id: 'mistral', label: 'Mistral', logo: 'MI' }],
  [/^(llama|meta-llama)/, { id: 'meta', label: 'Meta Llama', logo: 'Llama' }],
  [/^(nemotron|nvidia)/, { id: 'nvidia', label: 'NVIDIA', logo: 'NV' }],
  [/^(command|cohere|north|aya)/, { id: 'cohere', label: 'Cohere', logo: 'CO' }],
]
const OTHER: Vendor = { id: 'other', label: '其他', logo: '' }

/**
 * Model maker from the id. `vendor/model` prefixes are honoured; a leading distributor tag such as
 * `qcn-glm-5.3` or `cline-deepseek-v4.1-flash` is skipped once. Unknown families fall into 其他.
 */
export function vendorOf(id: string): Vendor {
  const raw = id.toLowerCase()
  const bare = raw.includes('/') ? raw.slice(raw.lastIndexOf('/') + 1) : raw
  const prefix = raw.includes('/') ? raw.slice(0, raw.indexOf('/')) : ''
  const tail = bare.includes('-') ? bare.slice(bare.indexOf('-') + 1) : ''
  for (const candidate of [prefix, bare, tail]) {
    if (!candidate) continue
    for (const [pattern, vendor] of VENDORS) if (pattern.test(candidate)) return vendor
  }
  return OTHER
}

/** $/M token: `$3` · `$0.30` · `$0.075` · `免费`; unknown `—` (never `$0`). */
export function fmtPerM(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return NONE
  if (value === 0) return '免费'
  if (value >= 10) return `$${fmtNum(value, 2)}`
  if (value >= 0.1) return `$${value.toFixed(2)}`
  return `$${fmtNum(value, 4)}`
}

/** Context window: binary sizes read 128K / 1M, decimal ones 200K / 400K. */
export function fmtCtx(value: number | null | undefined): string {
  if (!value || value <= 0) return NONE
  const binary = value % 1024 === 0
  const k = binary ? value / 1024 : value / 1000
  if (k >= 1000) {
    const m = binary ? value / 1_048_576 : value / 1_000_000
    return `${fmtNum(m, 1)}M`
  }
  return k >= 1 ? `${fmtNum(k, 0)}K` : String(value)
}

/** `$3 / $15` (input / output per M); `—` when unpriced. */
export function priceText(model: Pick<MeModel, 'pricing'>): string {
  const p = model.pricing
  if (!p) return NONE
  if (p.inputPerM === 0 && p.outputPerM === 0) return '免费'
  return `${fmtPerM(p.inputPerM)} / ${fmtPerM(p.outputPerM)}`
}

export const usedText = (used: MeModel['used7d']) =>
  used && used.requests > 0 ? `${fmtCompact(used.requests)} 次 · ${fmtCompact(used.tokens)} tok` : NONE

/** How many models this key may call; null when unknown (gateway unreadable) — never a fake 0. Blocked keys really have 0. */
export function callableCount(data: Pick<MeModels, 'models' | 'reason'> | undefined | null): number | null {
  if (!data || data.reason === 'gateway_unavailable') return null
  return data.models.length
}

/** /me/models filter badges; all null (no badge) when the callable list is unknown, so an unreadable gateway never shows `0`. */
export function modelFilterCounts(data: Pick<MeModels, 'models' | 'reason'> | undefined | null): Record<'all' | 'used' | 'priced' | 'reasoning', number | null> {
  if (callableCount(data) === null) return { all: null, used: null, priced: null, reasoning: null }
  const list = data!.models
  return {
    all: list.length,
    used: list.filter((m) => (m.used7d?.requests ?? 0) > 0).length,
    priced: list.filter((m) => m.pricing !== null).length,
    reasoning: list.filter((m) => m.reasoning === true).length,
  }
}

/**
 * The example model for a client snippet: this key's most-used match; never used → a priced, plain
 * (`family-<version>`, no `:free` / batch / image) one with the highest version number. null when the key cannot
 * call any model of that family — the page then hides that client instead of printing an id that would fail.
 */
export function pickExample(models: readonly MeModel[], pattern: RegExp, plain: RegExp): { id: string; used: boolean } | null {
  const matches = [...models].sort(byUse).filter((m) => pattern.test(m.id))
  if (!matches.length) return null
  const used = matches.find((m) => (m.used7d?.requests ?? 0) > 0)
  if (used) return { id: used.id, used: true }
  const narrow = (list: MeModel[], keep: (m: MeModel) => boolean) => (list.some(keep) ? list.filter(keep) : list)
  const pool = narrow(
    narrow(matches, (m) => plain.test(m.id) && !/:|batch|image|audio|realtime|search/i.test(m.id)),
    (m) => Boolean(m.pricing),
  )
  return { id: [...pool].sort((a, b) => b.id.localeCompare(a.id, 'en', { numeric: true }))[0].id, used: false }
}

/**
 * One usage day's [start, end) in epoch ms, on the server's calendar. `/api/me/usage` buckets days at the
 * server's local midnight and gives each day its own `startsAt` / `endsAt` (a DST day is 23 or 25 hours).
 * A server without them (not restarted yet): derive from the window start `from` (UTC) — the offset between
 * `daily[0].day` and `from` is the server's, right except across a DST change.
 */
type DayBoundsSource = { from?: string; daily?: ReadonlyArray<{ day: string; startsAt?: string | null; endsAt?: string | null }> }
export function usageDayBounds(day: string, usage: DayBoundsSource | null | undefined): { start: number; end: number } | null {
  const point = usage?.daily?.find((d) => d.day === day)
  const exact = { start: point?.startsAt ? Date.parse(point.startsAt) : NaN, end: point?.endsAt ? Date.parse(point.endsAt) : NaN }
  if (Number.isFinite(exact.start) && Number.isFinite(exact.end) && exact.end > exact.start) return exact
  const first = usage?.daily?.[0]?.day
  const from = usage?.from ? Date.parse(usage.from) : NaN
  const dayStart = (d: string) => Date.parse(`${d}T00:00:00Z`)
  if (!first || !Number.isFinite(from) || !Number.isFinite(dayStart(day)) || !Number.isFinite(dayStart(first))) return null
  const offset = dayStart(first) - from
  const start = dayStart(day) - offset
  return { start, end: start + DAY }
}

/** Sort for model lists: most used this week first, then id. */
export function byUse(a: MeModel, b: MeModel): number {
  return (b.used7d?.tokens ?? 0) - (a.used7d?.tokens ?? 0) || (b.used7d?.requests ?? 0) - (a.used7d?.requests ?? 0) || a.id.localeCompare(b.id)
}
