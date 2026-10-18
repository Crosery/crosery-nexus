/**
 * 概览 · 简约皮肤 (Tuff Pulse dashboard) adapters: pure mapping from the page model (model.ts + the endpoint
 * payloads) to the Tuffex data components' inputs — timeseries tuples, spark series, stat-card insights, status
 * tones. Nothing here invents a figure: every value is read off the same sources the Telemetry plates draw.
 */
import type { ProgressBarProps } from '@talex-touch/tuffex/progress-bar'
import type { SparkSeries } from '@talex-touch/tuffex/spark-chart'
import type { StatCardInsight } from '@talex-touch/tuffex/stat-card'
import type { StatusTone } from '@talex-touch/tuffex/status-badge'
import { clockParts, NONE } from '../../ui/fmt'
import type { DataState, LaneJob, LaneRun, ReadoutDelta, Severity, StatusKind } from '../../ui/types'
import type { PulseData } from '../../types'
import type { CheckRow } from './model'
import type { OverviewPayload } from './types'

const DAY = 86_400_000

/** One panel's source: its §5.1 state, the failure behind it and the refresh that retries it. */
export type PanelSource = { state: DataState; error?: unknown; at?: number | null; retry: () => void }

/** Mirrors the template's stage breakpoints (TemplateDashboardDemo `layoutOf`); 0 = not measured yet. */
export type DashLayout = 'narrow' | 'column' | 'wide'
export function layoutOf(width: number): DashLayout {
  if (!width) return 'column'
  return width < 640 ? 'narrow' : width < 960 ? 'column' : 'wide'
}

export const STATUS_TONE: Record<StatusKind, StatusTone> = {
  run: 'success', busy: 'info', pause: 'muted', idle: 'muted', off: 'muted', cool: 'info', warn: 'warning', bad: 'danger', stale: 'warning',
}
export const SEVERITY_TONE: Record<Severity, StatusTone> = { bad: 'danger', warn: 'warning', note: 'info', ok: 'success' }
export const SEVERITY_WORD: Record<Severity, string> = { bad: '告警', warn: '注意', note: '提示', ok: '已恢复' }

/** 巡检 marks as dot colours: open to-dos warm, all-clear green, unread neutral. */
export const CHECK_COLOR: Record<CheckRow['mark'], string> = {
  '✓': 'var(--tx-color-success)',
  '○': 'var(--tx-color-info)',
  '◇': 'var(--tx-color-warning)',
  '◆': 'var(--tx-color-danger)',
  '—': 'var(--tx-text-color-placeholder)',
}
export const CHECK_WORD: Record<CheckRow['mark'], string> = { '✓': '正常', '○': '提示', '◇': '注意', '◆': '告警', '—': '未读取' }

/** `14:32` (Asia/Shanghai, the console's clock). */
export function hhmm(at: number | string | null | undefined): string {
  const p = clockParts(at)
  return p ? `${p.hour}:${p.minute}` : NONE
}

/** Tooltip stamp: `14:32:08` for per-second samples, `09/30 14:00` for hourly buckets, else `14:32`. */
export function stampOf(ts: number, bucketMs: number): string {
  const p = clockParts(ts)
  if (!p) return NONE
  if (bucketMs < 60_000) return `${p.hour}:${p.minute}:${p.second}`
  if (bucketMs >= 3_600_000) return `${p.month}/${p.day} ${p.hour}:${p.minute}`
  return `${p.hour}:${p.minute}`
}

/* ── gateway trend ────────────────────────────────────────────────────────────────────────────── */

export type TrendPoint = [number, number]
export type GatewayTrend = {
  live: boolean
  bucketMs: number
  /** requests per minute, per bucket */
  requests: TrendPoint[]
  /** failed requests per minute, per bucket (same scale as requests) */
  errors: TrendPoint[]
  /** per-bucket P95 of successful requests (ms); buckets without latency samples are left out, never drawn as 0 */
  p95: TrendPoint[]
  /** the last bucket is still filling: dash the segment after this timestamp */
  incompleteAfter: number | null
  peak: { at: number; rpm: number } | null
}

/**
 * 实时 = /api/pulse (per-second samples, folded to per-minute rates); 1h · 6h · 24h = /api/overview buckets
 * (bucket i starts at `from + i × bucketMs`). The same series the Telemetry scope draws.
 */
export function gatewayTrend(live: boolean, overview: OverviewPayload | null, pulse: PulseData | null): GatewayTrend | null {
  if (live) {
    if (!pulse) return null
    return {
      live: true,
      bucketMs: 1000,
      requests: pulse.samples.map((s) => [s.t, s.rps * 60]),
      errors: pulse.samples.map((s) => [s.t, s.err * 60]),
      p95: [],
      incompleteAfter: null,
      peak: null,
    }
  }
  if (!overview) return null
  const { from, to, bucketMs } = overview
  const perMin = bucketMs / 60_000
  const series = overview.gateway.series
  const at = (i: number) => from + i * bucketMs
  const n = series.requests.length
  const p95: TrendPoint[] = []
  series.p95Ms.forEach((ms, i) => {
    if (typeof ms === 'number' && Number.isFinite(ms)) p95.push([at(i), ms])
  })
  return {
    live: false,
    bucketMs,
    requests: series.requests.map((v, i) => [at(i), v / perMin]),
    errors: series.errors.map((v, i) => [at(i), v / perMin]),
    p95,
    incompleteAfter: n >= 2 && to < at(n - 1) + bucketMs ? at(n - 2) : null,
    peak: overview.gateway.peak,
  }
}

/** Points inside a brushed span; the whole series when no span is set. */
export function within(points: TrendPoint[], span: [number, number] | null): TrendPoint[] {
  return span ? points.filter(([t]) => t >= span[0] && t <= span[1]) : points
}

/* ── 近 24 小时 ledger ─────────────────────────────────────────────────────────────────────────── */

/**
 * A ledger delta (model.ts `ReadoutDelta`: a ratio for `pct`, a ratio difference for `pp`) as a stat-card insight.
 * TxStatCard derives its figure from two endpoints, so the ratio rides on a base of 100 (`pct`) or as a
 * difference in percentage points (`pp`) — the same number the Telemetry readout prints. Neutral (info) unless the
 * change is bad and past its threshold, exactly like the readout's signal rule.
 */
export function ledgerInsight(delta: ReadoutDelta | null | undefined): StatCardInsight | undefined {
  const value = delta?.value
  if (!delta || typeof value !== 'number' || !Number.isFinite(value)) return undefined
  const bad = Boolean(delta.bad) && value !== 0 && Math.abs(value) >= (delta.threshold ?? 0)
  const iconClass = value >= 0 ? 'i-carbon-arrow-up-right' : 'i-carbon-arrow-down-right'
  const color = bad ? 'danger' : 'info'
  if (delta.unit === 'pp') return { from: 0, to: value * 100, type: 'delta', precision: 2, suffix: 'pp', color, iconClass }
  return { from: 100, to: 100 * (1 + value), type: 'percent', precision: 1, color, iconClass }
}

/** The ledger's seven rolling 24h windows (oldest first, last = the current one) as one spark series. */
export function historySpark(id: string, label: string, history: Array<number | null> | null | undefined, endAt: number): SparkSeries[] {
  if (!history?.length) return []
  const n = history.length
  const data = history
    .map((value, i) => ({ time: Math.round((endAt - (n - 1 - i) * DAY) / 1000), value }))
    .filter((p): p is { time: number; value: number } => typeof p.value === 'number' && Number.isFinite(p.value))
  return data.length >= 2 ? [{ id, label, data, color: 'var(--tx-color-primary)' }] : []
}

/* ── row sparks ───────────────────────────────────────────────────────────────────────────────── */

/** Bucketed counts (oldest first, bucket i at `from + i × bucketMs`) as a spark line; empty when it never moved. */
export function countSpark(id: string, label: string, counts: number[] | null | undefined, from: number, bucketMs: number, color?: string): SparkSeries[] {
  if (!counts?.length || !counts.some((n) => n > 0)) return []
  return [{ id, label, color, data: counts.map((value, i) => ({ time: Math.round((from + i * bucketMs) / 1000), value })) }]
}

/* ── sync runs ────────────────────────────────────────────────────────────────────────────────── */

type ProgressSegments = NonNullable<ProgressBarProps['segments']>

const RUN_VIEW: Array<{ result: LaneRun['result']; label: string; color: string }> = [
  { result: 'ok', label: '成功', color: 'var(--tx-color-success)' },
  { result: 'partial', label: '部分', color: 'var(--tx-color-warning)' },
  { result: 'error', label: '失败', color: 'var(--tx-color-danger)' },
  { result: 'skipped', label: '跳过', color: 'var(--tx-text-color-placeholder)' },
  { result: 'running', label: '运行中', color: 'var(--tx-color-primary)' },
]

/** A job's runs in the last 24h, split by result, for one segmented bar. */
export function runTally(job: LaneJob, now: number): { segments: ProgressSegments; total: number; failed: number; words: string } {
  const since = now - DAY
  const runs = job.runs.filter((r) => {
    const at = typeof r.at === 'number' ? r.at : Date.parse(r.at)
    return Number.isFinite(at) && at >= since
  })
  const segments: ProgressSegments = []
  const words: string[] = []
  for (const view of RUN_VIEW) {
    const count = runs.filter((r) => r.result === view.result).length
    if (!count) continue
    segments.push({ value: count, color: view.color, label: `${view.label} ${count}` })
    words.push(`${view.label} ${count}`)
  }
  return { segments, total: runs.length, failed: runs.filter((r) => r.result === 'error').length, words: words.join(' · ') }
}

/** Quota pressure as a bar status: full or over = error, ≥90% = warning (the attention list's thresholds). */
export function ratioStatus(ratio: number): 'error' | 'warning' | '' {
  return ratio >= 1 ? 'error' : ratio >= 0.9 ? 'warning' : ''
}
