/**
 * Shared kit types. Kept in a .ts module because `tsc -b` cannot read named exports from .vue files
 * (the repo has no vue-tsc): import types from here, components from their .vue path.
 */
export type { DataState } from './composables/useLive'
export type { Instant } from './composables/useNow'

/** Readout delta line (ink-3; signal-ink only when `bad` and |value| ≥ threshold). */
export type ReadoutDelta = {
  /** relative change as a ratio for 'pct', percentage points as a ratio for 'pp', raw for 'abs' */
  value: number | null | undefined
  unit?: 'pct' | 'pp' | 'abs'
  /** this direction of change is bad (e.g. failure rate up) */
  bad?: boolean
  /** |value| at or above which a bad change turns signal-ink (default 0) */
  threshold?: number
  /** comparison text after the arrow, e.g. "vs 前 30 日" */
  label?: string
}

export type StatusKind = 'run' | 'busy' | 'pause' | 'idle' | 'off' | 'cool' | 'warn' | 'bad' | 'stale'

export type Severity = 'bad' | 'warn' | 'note' | 'ok'

export type RowTone = 'attn' | 'cool' | 'off' | null | undefined

/** TxDataTable column + how the column appears in the mobile row-card. */
export type CardRole = 'primary' | 'meta' | 'line2' | 'line3' | 'actions' | 'hidden'

export type RowColumn<T = Record<string, unknown>> = {
  key: string
  title: string
  dataIndex?: string
  width?: string | number
  minWidth?: string | number
  align?: 'left' | 'center' | 'right'
  sortable?: boolean
  sorter?: (a: T, b: T) => number
  format?: (value: unknown, row: T, index: number) => string
  nowrap?: boolean
  headerClass?: string
  cellClass?: string
  /** mobile card placement; columns without `card` are hidden in cards */
  card?: CardRole
  /** label shown before the value on card line 2/3 (e.g. '周'); defaults to nothing */
  cardLabel?: string
}

export type SortState = { key: string; order: 'asc' | 'desc' | null }

export type SegmentItem = { value: string | number; label: string; count?: number | null; disabled?: boolean }

/** FilterBar field: URL key, micro label, options; '' (全部) unless `default` says otherwise. */
export type FilterBarField = { key: string; label: string; options: SegmentItem[]; default?: string; allLabel?: string | null }

export type ShareSegment = {
  key: string
  label: string
  value: number
  /** texture slot k1…k6 or 'rest'; defaults by position */
  tone?: 'k1' | 'k2' | 'k3' | 'k4' | 'k5' | 'k6' | 'rest' | 'hot'
}

export type AttentionItem = {
  id: string | number
  severity: Severity
  /** micro kind tag: KEY · ACCT · CHAN · SYNC · KERN */
  kind: string
  subject: string
  /** render subject as an email identity (mask-aware) */
  email?: boolean
  reason: string
  metric?: string
  action?: { label: string; to?: string }
  at?: string | null
}

export type LaneRun = { at: string | number; durationMs?: number | null; result: 'ok' | 'partial' | 'error' | 'skipped' | 'running' }

export type LaneJob = {
  id: string
  label: string
  /** "每 30M" */
  every?: string | null
  runs: LaneRun[]
  nextAt?: string | number | null
  backoffUntil?: string | number | null
  calls24h?: number | null
  state?: StatusKind
  stateLabel?: string
  summary?: string | null
  lastAt?: string | number | null
}

export type CommandItem = {
  id: string
  title: string
  section: 'GO' | 'ACT' | 'FIND' | 'VIEW'
  keywords?: string[]
  hint?: string
  disabled?: boolean
  run: () => void
}

export type NavItem = {
  id: string
  label: string
  to: string
  /** mono index shown as a superscript: 01 … 08 */
  idx?: string
  /** attention count superscript (signal-ink), hidden at 0 */
  count?: number
  icon?: string
  /** group key; items with different groups get a rail divider between them */
  group?: string
}

export type RankRow = {
  key?: string | number
  name: string
  value: number | null
  /** share of the total as a ratio; computed from values when omitted */
  share?: number | null
  /** failure rate as a ratio; ≥ errThreshold renders `err 8.2%` in signal-ink */
  err?: number | null
  /** optional second line (ink-3) */
  sub?: string
  to?: string
}

export type RangeRow = { key?: string | number; name: string; p50: number | null; p95: number | null; n?: number | null }

export type BudgetSource = {
  key?: string | number
  name: string
  used: number | null
  limit: number | null
  /** e.g. "≥ 30s" */
  minInterval?: string | null
  state?: StatusKind
  stateLabel?: string
  note?: string | null
}

/** One sample of a single-series trend; `t` is an instant or a pre-formatted x label. */
export type TrendPoint = { t: string | number | Date; v: number | null; label?: string }

/* ── shell ─────────────────────────────────────────────────────────────────────────────────────── */

export type ShellRole = 'admin' | 'key'

/** One square in the statusline / one bar in the mobile sync chip. */
export type SyncChip = {
  id: string
  label: string
  state: 'ok' | 'running' | 'backoff' | 'failed' | 'idle'
  /** e.g. "下次 16:00 · 上次错误 429" (tooltip / title) */
  detail?: string | null
}

/** Live facts the statusline (desktop) and ticker (mobile) print. Every field is optional: absent = not shown. */
export type ShellStatus = {
  gateway?: { rpm: number | null; p95Ms?: number | null; successRate?: number | null; stale?: boolean } | null
  sync?: SyncChip[] | null
  /** pre-composed sync words, e.g. "价格元数据 退避 → 16:00 · 账号额度 同步中 7/20" */
  syncText?: string | null
  /** e.g. "magpie 3fe2ff9" */
  kernel?: string | null
  rtk?: boolean | null
  /** key-user facts; `masked` is the stored tail (`sk-cr…7f3a`), `state` / `stateLabel` the key's status mark */
  key?: {
    name: string
    masked?: string | null
    state?: StatusKind | null
    stateLabel?: string | null
    today?: string | null
    limit?: string | null
    week?: string | null
    models?: number | null
  } | null
}

/** One second of gateway traffic for the header live edge. */
export type TraceSample = { t: number; rps: number | null; err?: number | null }

export type UserMenuItem = { id: string; label: string; to?: string; danger?: boolean; run?: () => void }

export type LoginMode = 'key' | 'admin'
