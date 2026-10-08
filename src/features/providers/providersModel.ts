/**
 * 供应商页的纯规则：一套状态筛选同时管「API 渠道」与「订阅账号池」。
 * No Vue, no fetch: unit-tested in server/providersPageModel.test.ts. Account rows themselves are filtered by
 * `matches` in ../accounts/model.ts; this file only says which `show` value a page status stands for.
 */

/* ── one status filter for both sections ── */

export type ProviderSection = 'all' | 'channels' | 'accounts'

/**
 * 正常 = 渠道启用且健康 / 账号运行；冷却 = 账号冷却（渠道没有）；需处理 = 渠道降级·异常·残留 / 账号失效·异常；
 * 停用 = 渠道停用 / 账号暂停。hot / reset 只对账号有意义，只在单看订阅账号时提供。
 */
export type ProviderStatus = 'all' | 'run' | 'cool' | 'issue' | 'off' | 'hot' | 'reset'

const STATUSES: readonly ProviderStatus[] = ['all', 'run', 'cool', 'issue', 'off', 'hot', 'reset']
const ACCOUNT_ONLY: ReadonlySet<ProviderStatus> = new Set(['hot', 'reset'])

const LABELS: Record<ProviderStatus, string> = {
  all: '全部',
  run: '正常',
  cool: '冷却',
  issue: '需处理',
  off: '停用',
  hot: '窗口 ≥90%',
  reset: '可用重置',
}

/** what the old pages wrote: /channels `?status=enabled|warn|degraded|disabled|off`, /accounts `?show=pause|bad|warn…` */
const LEGACY: Record<string, ProviderStatus> = {
  enabled: 'run',
  warn: 'issue',
  degraded: 'issue',
  bad: 'issue',
  disabled: 'off',
  pause: 'off',
}

const first = (value: unknown): string => String((Array.isArray(value) ? value[0] : value) ?? '').trim().toLowerCase()

/** `?status=` as the page applies it; an old `?show=` (redirected /accounts links) still lands; anything unknown is 全部. */
export function parseStatus(status: unknown, show?: unknown): ProviderStatus {
  for (const raw of [first(status), first(show)]) {
    if (!raw) continue
    if ((STATUSES as readonly string[]).includes(raw)) return raw as ProviderStatus
    if (LEGACY[raw]) return LEGACY[raw]
  }
  return 'all'
}

/** An account-only filter does not survive a section that shows channels. */
export function statusForSection(status: ProviderStatus, section: ProviderSection): ProviderStatus {
  return ACCOUNT_ONLY.has(status) && section !== 'accounts' ? 'all' : status
}

/** channelModel's ChannelHealthClass bucket */
export type ChannelBucket = 'run' | 'warn' | 'off'

export function channelInStatus(bucket: ChannelBucket, status: ProviderStatus): boolean {
  switch (status) {
    case 'all': return true
    case 'run': return bucket === 'run'
    case 'issue': return bucket === 'warn'
    case 'off': return bucket === 'off'
    default: return false
  }
}

/** The `show` value the accounts pool filters by (../accounts/model.ts `matches`). */
export function accountShow(status: ProviderStatus): string {
  if (status === 'off') return 'pause'
  return status
}

/** Case-insensitive substring over the fields a row is searched by. */
export function matchesQuery(fields: ReadonlyArray<string | null | undefined>, q: string): boolean {
  const needle = q.trim().toLowerCase()
  if (!needle) return true
  return fields.some((field) => String(field ?? '').toLowerCase().includes(needle))
}

/** The fields of ../accounts/model.ts `countBy` this page reads. */
export type AccountCountsLike = { all: number; run: number; cool: number; pause: number; bad: number; warn: number; hot: number; reset: number }

export type StatusCounts = Record<ProviderStatus, number>

/** Per-status counts over what the section shows; `accounts` null = the pool has not reported (or is not filterable). */
export function statusCounts(buckets: readonly ChannelBucket[], accounts: AccountCountsLike | null, section: ProviderSection): StatusCounts {
  const counts: StatusCounts = { all: 0, run: 0, cool: 0, issue: 0, off: 0, hot: 0, reset: 0 }
  if (section !== 'accounts') {
    for (const bucket of buckets) {
      counts.all += 1
      if (bucket === 'run') counts.run += 1
      else if (bucket === 'warn') counts.issue += 1
      else counts.off += 1
    }
  }
  if (section !== 'channels' && accounts) {
    counts.all += accounts.all
    counts.run += accounts.run
    counts.cool += accounts.cool
    counts.issue += accounts.bad + accounts.warn
    counts.off += accounts.pause
    counts.hot += accounts.hot
    counts.reset += accounts.reset
  }
  return counts
}

export type StatusItem = { value: ProviderStatus; label: string; count: number }

/** The chips: 全部 and the one in use always; any other only when something is in it (a chip that can only empty the list is noise). */
export function statusItems(counts: StatusCounts, section: ProviderSection, current: ProviderStatus): StatusItem[] {
  return STATUSES
    .filter((value) => section === 'accounts' || !ACCOUNT_ONLY.has(value))
    .filter((value) => value === 'all' || value === current || counts[value] > 0)
    .map((value) => ({ value, label: LABELS[value], count: counts[value] }))
}
