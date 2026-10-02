import { clockParts, fmtInt, fmtUsd, NONE } from '../../../ui/fmt'
import type { Instant } from '../../../ui/types'
import type { UsageLedger, UsageWindow } from './types'

/**
 * Money on the usage tabs (DESIGN §6.0 data truth): never `$0.00` / `n/a` as a headline.
 * - all unpriced → `—` (the sub-line says 未定价)
 * - priced part is exactly 0 and nothing is unpriced → `免费`
 * - partly unpriced or estimated → `≈ $…`
 */
export function costText(
  costUsd: number | null | undefined,
  options: { estimated?: boolean; partial?: boolean; /** false = the label carries the ≈ */ mark?: boolean } = {},
): string {
  if (costUsd === null || costUsd === undefined || !Number.isFinite(costUsd)) return NONE
  if (costUsd === 0) return options.partial ? NONE : '免费'
  const approx = options.mark !== false && Boolean(options.estimated || options.partial)
  return fmtUsd(costUsd, { approx, digits: Math.abs(costUsd) >= 1000 ? 0 : undefined })
}

/** `未定价 2 个模型 · 312 次不计` / `按标价估算` / '' */
export function costNote(ledger: Pick<UsageLedger, 'hasPartialCost' | 'unpricedModels' | 'unpricedRequests' | 'costEstimated'>): string {
  if (ledger.hasPartialCost) return `未定价 ${ledger.unpricedModels.length} 个模型 · ${fmtInt(ledger.unpricedRequests)} 次不计`
  if (ledger.costEstimated) return '含按标价估算'
  return ''
}

/** error_category → plain words. Raw codes only ever appear as a mono suffix next to these. */
export const CATEGORY_LABEL: Record<string, string> = {
  rate_limited: '上游限流',
  quota_exhausted: '上游额度用尽',
  upstream_5xx: '上游故障',
  upstream_eof: '上游断开',
  auth_failed: '鉴权失败',
  client_cancelled: '客户端取消',
  context_too_large: '上下文过长',
  wrong_endpoint: '入口不对',
  other: '其他',
}
export const categoryLabel = (category: string) => CATEGORY_LABEL[category] ?? category

const pad = (value: string) => value
/** `09/25 08:00` in the console time zone */
export function shortStamp(value: Instant): string {
  const p = clockParts(value)
  return p ? `${pad(p.month)}/${pad(p.day)} ${p.hour}:${p.minute}` : NONE
}

/** `09/25 08:00 → 10/02 07:48` — the exact window every number on the tab covers. */
export function windowSpan(window: UsageWindow | null | undefined): string {
  if (!window) return ''
  return `${shortStamp(window.from)} → ${shortStamp(window.to)}`
}

/** relative change; null when there is no baseline (never a fake ▲∞) */
export function relDelta(current: number | null | undefined, previous: number | null | undefined): number | null {
  if (current === null || current === undefined || previous === null || previous === undefined) return null
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous === 0) return null
  return (current - previous) / previous
}

/** difference in percentage points as a ratio (0.0021 → ▲ 0.21pp) */
export function ppDelta(current: number | null | undefined, previous: number | null | undefined): number | null {
  if (current === null || current === undefined || previous === null || previous === undefined) return null
  return current - previous
}

/**
 * The console service has not been restarted onto the workspace handlers yet: the old handler answered (no
 * `view: 'workspace'` marker, see ./api.ts) or a new path is still 404. Rendered as "待重启生效", never as an
 * empty page or a server fault.
 */
export function isPendingRestart(error: unknown): boolean {
  const e = error as { code?: unknown; status?: unknown } | null
  return e?.code === 'usage_workspace_unavailable' || e?.status === 404
}
