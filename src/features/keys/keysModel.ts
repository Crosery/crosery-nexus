/**
 * /keys page model (DESIGN §6.3): pure functions only, so the status words, filters, sort order and quota form
 * rules are unit-tested (`server/keysView.test.ts`) and the page and its sheets read one definition.
 */
import type { ApiKeyItem, Group, QuotaWindowState } from '../../types'
import type { StatusKind } from '../../ui/types'

/* ── /api/keys/activity (server/keysView.ts, CONTRACTS "Change (keys)") ──────────────────────────────── */

export type KeyActivity = {
  id: string
  h24: { requests: number[]; errors: number[] }
  d7: {
    requests: number
    errors: number
    tokens: number
    daily: Array<{ requests: number; errors: number }>
    topModels: Array<{ model: string; requests: number; tokens: number }>
    errorKinds: Array<{ status: number | null; category: string | null; count: number }>
  }
  recentErrors: Array<{ at: string; model: string; status: number | null; category: string | null }>
}

export type KeysActivityPayload = {
  /** `all` (default): every request of the Key, removed channels included; `current_channels` = opt-in filter */
  scope: 'all' | 'current_channels'
  hours: number
  hourStart: string
  days: number
  since: string
  keys: KeyActivity[]
  generatedAt: string
}

/** ready = numbers are real; unavailable = the endpoint is not deployed yet (404 before a restart); error = it failed */
export type ActivityState = 'loading' | 'ready' | 'unavailable' | 'error'

/* ── identity ─────────────────────────────────────────────────────────────────────────────────────── */

/** `sk-api-••••••••bf2ee` → `sk-api-…bf2ee` (the stored mask, shortened; never more of the key). */
export function keyTail(masked: string): string {
  return String(masked || '').replace(/[•●*]{2,}/g, '…')
}

export type Scope = { label: string; all: boolean; none: boolean }

/** Authorised channel groups in words: `全部渠道`, `openrouter · claude`, `无渠道`. */
export function groupScope(key: Pick<ApiKeyItem, 'groups'>, groups: Group[]): Scope {
  const ids = key.groups ?? []
  if (!ids.length) return { label: '无渠道', all: false, none: true }
  if (groups.length > 0 && groups.every((g) => ids.includes(g.id))) return { label: '全部渠道', all: true, none: false }
  const names = ids.map((id) => groups.find((g) => g.id === id)?.name ?? id)
  return { label: names.join(' · '), all: false, none: false }
}

/* ── quota windows ────────────────────────────────────────────────────────────────────────────────── */

export type WindowKey = 'daily' | 'weekly' | 'total'
export const WINDOW_LABEL: Record<WindowKey, string> = { daily: '日', weekly: '周', total: '累计' }
export const WINDOW_NOUN: Record<WindowKey, string> = { daily: '今日', weekly: '本周', total: '累计' }

export const limited = (w: Pick<QuotaWindowState, 'limitUsd'> | undefined | null): boolean => Boolean(w && w.limitUsd > 0)

/** used / limit for a limited window, else null (no limit has no percentage). */
export function windowRatio(w: QuotaWindowState | undefined | null): number | null {
  if (!w || !limited(w)) return null
  if (typeof w.ratio === 'number' && Number.isFinite(w.ratio)) return w.ratio
  return w.spentUsd / w.limitUsd
}

/** Quota pressure = the fullest limited window (day, week or total); null when every window is unlimited. */
export function pressure(key: ApiKeyItem): number | null {
  let max: number | null = null
  for (const w of [key.quotaState?.daily, key.quotaState?.weekly, key.quotaState?.total]) {
    const r = windowRatio(w)
    if (r !== null && (max === null || r > max)) max = r
  }
  return max
}

/** 90% is the meter redline: past it the Key is 接近上限 (one definition for the mark, the filter and the count). */
export const NEAR_LIMIT = 0.9

/* ── status: shape + word ─────────────────────────────────────────────────────────────────────────── */

export type KeyStatus = 'run' | 'near' | 'blocked' | 'off'

export function keyStatus(key: ApiKeyItem): KeyStatus {
  if (key.blockedReason) return 'blocked'
  if (!key.enabled) return 'off'
  const p = pressure(key)
  if (p !== null && p >= NEAR_LIMIT) return 'near'
  return 'run'
}

export const STATUS_VIEW: Record<KeyStatus, { mark: StatusKind; word: string }> = {
  run: { mark: 'run', word: '启用' },
  near: { mark: 'warn', word: '接近上限' },
  blocked: { mark: 'bad', word: '超额停用' },
  off: { mark: 'off', word: '停用' },
}

/** quota window rollover, short: `↻ 00:00` when it is within a day, else `↻ 周一 00:00` (Asia/Shanghai) */
export function resetLabel(at: string | null | undefined, now: number, parts: (v: string | number) => { hour: string; minute: string; weekday: number } | null): string {
  if (!at) return ''
  const ms = Date.parse(at)
  const p = parts(at)
  if (!Number.isFinite(ms) || !p) return ''
  const hm = `${p.hour}:${p.minute}`
  return ms - now <= DAY_MS ? `↻ ${hm}` : `↻ 周${'日一二三四五六'[p.weekday]} ${hm}`
}

/** money beside a cap: cents only under $1,000 and only when there are cents (`$46.12 / $50`, `$1,912 / $3,000`) */
export function capMoney(value: number, fmt: (v: number, o: { digits: number }) => string): string {
  return fmt(value, { digits: value >= 1000 || Number.isInteger(value) ? 0 : 2 })
}

/* ── recency ──────────────────────────────────────────────────────────────────────────────────────── */

export const DAY_MS = 86_400_000

/** last-used instant in epoch ms; the DB keeps raw offsets (`…-04:00`), so parse, never compare strings */
export function lastUsedMs(key: Pick<ApiKeyItem, 'lastUsedAt'>): number | null {
  const ms = key.lastUsedAt ? Date.parse(key.lastUsedAt) : Number.NaN
  return Number.isFinite(ms) ? ms : null
}

export function idleFor7d(key: Pick<ApiKeyItem, 'lastUsedAt'>, now: number): boolean {
  const last = lastUsedMs(key)
  return last === null || now - last > 7 * DAY_MS
}

/* ── filter + search + sort ───────────────────────────────────────────────────────────────────────── */

export type FilterKey = 'all' | 'enabled' | 'near' | 'blocked' | 'off' | 'idle'
export const FILTER_LABEL: Record<FilterKey, string> = {
  all: '全部',
  enabled: '启用',
  near: '接近上限',
  blocked: '超额停用',
  off: '停用',
  idle: '7 天未用',
}

export function matchesFilter(key: ApiKeyItem, filter: FilterKey, now: number): boolean {
  const status = keyStatus(key)
  switch (filter) {
    case 'enabled': return status === 'run' || status === 'near'
    case 'near': return status === 'near'
    case 'blocked': return status === 'blocked'
    case 'off': return status === 'off'
    case 'idle': return idleFor7d(key, now)
    default: return true
  }
}

export function filterCounts(keys: ApiKeyItem[], now: number): Record<FilterKey, number> {
  const out = { all: 0, enabled: 0, near: 0, blocked: 0, off: 0, idle: 0 } as Record<FilterKey, number>
  for (const key of keys) for (const f of Object.keys(out) as FilterKey[]) if (matchesFilter(key, f, now)) out[f] += 1
  return out
}

/** Search over name, masked tail, note and authorised group names (case-insensitive). */
export function matchesQuery(key: ApiKeyItem, query: string, groups: Group[]): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  const hay = [key.name, key.maskedKey, keyTail(key.maskedKey), key.note, ...key.groups, ...key.groups.map((id) => groups.find((g) => g.id === id)?.name ?? '')]
  return hay.some((part) => String(part || '').toLowerCase().includes(q))
}

export type SortKey = 'pressure' | 'today' | 'week' | 'recent' | 'requests' | 'name'
export const SORT_LABEL: Record<SortKey, string> = {
  pressure: '额度压力',
  today: '今日花费',
  week: '本周花费',
  recent: '最近调用',
  requests: '7 天请求',
  name: '名称',
}

const desc = (a: number | null, b: number | null): number => {
  if (a === b) return 0
  if (a === null) return 1 // unknown is never "largest" nor "smallest": always last
  if (b === null) return -1
  return b - a
}

/**
 * Default order = quota pressure (fullest limited window first), blocked Keys first among equals, then today's
 * spend, then name. Unlimited Keys (no pressure) follow, by today's spend.
 */
export function sortKeys(keys: ApiKeyItem[], sort: SortKey, activity: Map<string, KeyActivity> | null): ApiKeyItem[] {
  const byName = (a: ApiKeyItem, b: ApiKeyItem) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true })
  const today = (k: ApiKeyItem) => k.quotaState?.daily?.spentUsd ?? null
  const week = (k: ApiKeyItem) => k.quotaState?.weekly?.spentUsd ?? null
  const cmp: Record<SortKey, (a: ApiKeyItem, b: ApiKeyItem) => number> = {
    pressure: (a, b) =>
      desc(pressure(a), pressure(b))
      || Number(Boolean(b.blockedReason)) - Number(Boolean(a.blockedReason))
      || desc(today(a), today(b))
      || desc(week(a), week(b))
      || byName(a, b),
    today: (a, b) => desc(today(a), today(b)) || byName(a, b),
    week: (a, b) => desc(week(a), week(b)) || byName(a, b),
    recent: (a, b) => desc(lastUsedMs(a), lastUsedMs(b)) || byName(a, b),
    requests: (a, b) => desc(activity?.get(a.id)?.d7.requests ?? null, activity?.get(b.id)?.d7.requests ?? null) || byName(a, b),
    name: byName,
  }
  return [...keys].sort(cmp[sort] ?? cmp.pressure)
}

/* ── errors in plain words ────────────────────────────────────────────────────────────────────────── */

const CATEGORY_WORDS: Record<string, string> = {
  rate_limited: '上游限流',
  auth_failed: '鉴权失败',
  quota_exhausted: '上游额度用尽',
  context_too_large: '上下文超长',
  client_cancelled: '客户端取消',
  upstream_eof: '上游断流',
  upstream_5xx: '上游故障',
  wrong_endpoint: '接口不匹配',
  other: '其他错误',
}

export function errorWords(category: string | null | undefined, status: number | null | undefined): string {
  const word = category ? CATEGORY_WORDS[category] ?? category : status && status >= 500 ? '上游故障' : '失败'
  return status ? `${status} ${word}` : word
}

/** error share of requests; null without requests (never a fake 0%) */
export function errorRate(a: KeyActivity | undefined | null): number | null {
  if (!a || a.d7.requests <= 0) return null
  return a.d7.errors / a.d7.requests
}

/** past this share the 7-day error rate turns signal-ink */
export const ERROR_ALERT = 0.05
/** a bucket is drawn as failing (signal) only when at least this share of it failed — a stray error is not a red bar */
export const FAILING_BUCKET = 0.25

/** error counts → the per-bucket "failing" input of MicroBars (0 = draw in ink) */
export function failingBuckets(requests: number[], errors: number[], share = FAILING_BUCKET): number[] {
  return requests.map((n, i) => (n > 0 && (errors[i] ?? 0) / n >= share ? errors[i] : 0))
}

/** short money for limits beside a meter: `$50`, `$600`, `$1k`, `$1.5k`, `$12k` */
export function shortUsd(value: number): string {
  if (!Number.isFinite(value)) return '—'
  if (value >= 1000) {
    const k = value / 1000
    return `$${Number.isInteger(k) || k >= 100 ? Math.round(k) : k.toFixed(1).replace(/\.0$/, '')}k`
  }
  return `$${Number.isInteger(value) ? value : value.toFixed(2)}`
}

/* ── quota form ───────────────────────────────────────────────────────────────────────────────────── */

export type QuotaDraft = Record<WindowKey, string>
export const QUOTA_MAX = 1_000_000

/** amount string → USD; '' = no limit (0). null = not a valid amount. */
export function parseAmount(raw: string): number | null {
  const text = String(raw ?? '').trim()
  if (text === '') return 0
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return null
  const value = Number(text)
  return value >= 0 && value <= QUOTA_MAX ? value : null
}

export type QuotaValues = { dailyUsd: number; weeklyUsd: number; totalUsd: number }

/** a stored amount the person left as it was prefilled: the server accepts any finite decimals, so keep it exact */
function storedAmount(raw: string, original: string | undefined): number | null {
  const text = String(raw ?? '').trim()
  if (original === undefined || text === '' || text !== original.trim()) return null
  const value = Number(text)
  return Number.isFinite(value) && value >= 0 && value <= QUOTA_MAX ? value : null
}

/**
 * Client mirror of `server/quota.ts validateQuota`: same ranges, same cross-window order (日 ≤ 周 ≤ 累计).
 * `original` = the prefilled draft (quotaDraftOf): a window left untouched keeps its stored precision instead of
 * failing the 2-decimal rule meant for typed amounts.
 */
export function validateQuotaDraft(draft: QuotaDraft, original?: QuotaDraft): { values: QuotaValues | null; errors: Partial<Record<WindowKey, string>> } {
  const errors: Partial<Record<WindowKey, string>> = {}
  const parsed = {} as Record<WindowKey, number>
  for (const w of ['daily', 'weekly', 'total'] as WindowKey[]) {
    const value = storedAmount(draft[w], original?.[w]) ?? parseAmount(draft[w])
    if (value === null) errors[w] = `填 0–1,000,000 的金额，最多两位小数 · 留空 = 不限`
    else parsed[w] = value
  }
  if (!Object.keys(errors).length) {
    if (parsed.total > 0 && parsed.weekly > parsed.total) errors.weekly = '周额度不能超过累计额度'
    if (parsed.total > 0 && parsed.daily > parsed.total) errors.daily = '日额度不能超过累计额度'
    if (parsed.weekly > 0 && parsed.daily > parsed.weekly) errors.daily = '日额度不能超过周额度'
  }
  if (Object.keys(errors).length) return { values: null, errors }
  return { values: { dailyUsd: parsed.daily, weeklyUsd: parsed.weekly, totalUsd: parsed.total }, errors }
}

export function quotaDraftOf(key: ApiKeyItem | null): QuotaDraft {
  const amount = (v: number | undefined) => (v && v > 0 ? String(v) : '')
  return { daily: amount(key?.quota?.dailyUsd), weekly: amount(key?.quota?.weeklyUsd), total: amount(key?.quota?.totalUsd) }
}

/**
 * 新建 Key + 写额度。额度取提交那一刻校验过的快照（不是请求返回后再读一遍还能编辑的表单），所以
 * 创建在途时清空或改动额度框不会让一把已启用的 Key 悄悄变成不限额；额度写失败如实带回。
 */
export async function createKeyWithQuota<T extends { key: string; item: { id: string } }, P>(
  deps: { create: (payload: P) => Promise<T>; quota: (id: string, values: QuotaValues) => Promise<unknown> },
  payload: P,
  quota: QuotaValues | null,
  describe: (error: unknown) => string,
): Promise<{ created: T; quotaError: string | null }> {
  const created = await deps.create(payload)
  let quotaError: string | null = null
  if (quota && (quota.dailyUsd || quota.weeklyUsd || quota.totalUsd)) {
    try {
      await deps.quota(created.item.id, quota)
    } catch (error) {
      quotaError = describe(error) || '额度保存失败'
    }
  }
  return { created, quotaError }
}

/* ── editor (create / edit) ───────────────────────────────────────────────────────────────────────── */

export type EditorDraft = {
  name: string
  note: string
  groups: string[]
  unlimited: boolean
  totalConcurrency: string
  groupConcurrency: Record<string, string>
}

export const NAME_MAX = 40
export const NOTE_MAX = 100
export const CONCURRENCY_MAX = 500

/**
 * Mirrors `server/policy.ts validatePolicy` + the route parsing: name 1–40 and unique, ≥1 group, total
 * concurrency 1–500 (0 = 不限 via the switch), each authorised group 1..total when limited.
 */
export function validateEditor(draft: EditorDraft, others: Array<Pick<ApiKeyItem, 'name'>>): Partial<Record<string, string>> {
  const errors: Partial<Record<string, string>> = {}
  const name = draft.name.trim()
  if (!name) errors.name = '填一个名称，1–40 字'
  else if (name.length > NAME_MAX) errors.name = '名称最多 40 字'
  else if (others.some((k) => k.name === name)) errors.name = '已有同名 Key · 换一个'
  if (draft.note.trim().length > NOTE_MAX) errors.note = '备注最多 100 字'
  if (!draft.groups.length) errors.groups = '至少选一个渠道 · 否则这把 Key 调不了任何模型'
  if (!draft.unlimited) {
    const total = draft.totalConcurrency.trim()
    const totalN = /^\d+$/.test(total) ? Number(total) : Number.NaN
    if (!(totalN >= 1 && totalN <= CONCURRENCY_MAX)) errors.totalConcurrency = '填 1–500 的整数 · 不想限就打开「不限」'
    else {
      for (const id of draft.groups) {
        const raw = String(draft.groupConcurrency[id] ?? '').trim()
        const n = /^\d+$/.test(raw) ? Number(raw) : Number.NaN
        if (!(n >= 1 && n <= totalN)) {
          errors[`group:${id}`] = `1–${totalN}`
          errors.groupConcurrency = `每个渠道填 1–${totalN} 的整数`
        }
      }
    }
  }
  return errors
}

export function editorPayload(draft: EditorDraft) {
  const total = draft.unlimited ? 0 : Number(draft.totalConcurrency)
  return {
    name: draft.name.trim(),
    note: draft.note.trim(),
    groups: [...draft.groups],
    totalConcurrency: total,
    groupConcurrency: draft.unlimited ? {} : Object.fromEntries(draft.groups.map((id) => [id, Number(draft.groupConcurrency[id])])),
  }
}

/** default per-group cap when a group is added under a total limit: min(2, total) like the old create form */
export function defaultGroupCap(total: string): string {
  const n = Number(total)
  return Number.isInteger(n) && n >= 1 ? String(Math.min(2, n)) : '1'
}
