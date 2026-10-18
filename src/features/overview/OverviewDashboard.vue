<script setup lang="ts">
import { computed, ref, useTemplateRef, watch } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import { TxButton } from '@talex-touch/tuffex/button'
import { ChartPalette, TxChartLegendItem, TxTimeseriesChart } from '@talex-touch/tuffex/charts'
import type { TimeseriesData, TimeseriesMarker } from '@talex-touch/tuffex/charts'
import { TxDataTable } from '@talex-touch/tuffex/data-table'
import type { DataTableColumn } from '@talex-touch/tuffex/data-table'
import { TxDotIndicator } from '@talex-touch/tuffex/dot-indicator'
import { TxFlatRadio, TxFlatRadioItem } from '@talex-touch/tuffex/flat-radio'
import { TxProgressBar } from '@talex-touch/tuffex/progress-bar'
import { TxSparkChart } from '@talex-touch/tuffex/spark-chart'
import { TxStatCard } from '@talex-touch/tuffex/stat-card'
import { TxStatusBadge } from '@talex-touch/tuffex/status-badge'
import { TxTextMorph } from '@talex-touch/tuffex/text-morph'
import ProviderMark from '../../ui/data/ProviderMark.vue'
import CountdownPie from '../../ui/viz/CountdownPie.vue'
import { useElementWidth } from '../../ui/composables/useElementWidth'
import { useNow } from '../../ui/composables/useNow'
import { clockParts, fmtAgo, fmtCompact, fmtDuration, fmtInt, fmtNum, fmtPct, fmtSpend, fmtTime, NONE } from '../../ui/fmt'
import type { LaneJob } from '../../ui/types'
import { maskEmail, useMask } from '../../lib/privacy'
import type { PulseData } from '../../types'
import DashPanel from './DashPanel.vue'
import {
  CHECK_COLOR, CHECK_WORD, countSpark, gatewayTrend, historySpark, hhmm, layoutOf, ledgerInsight, ratioStatus, runTally,
  SEVERITY_TONE, SEVERITY_WORD, stampOf, STATUS_TONE, within, type DashLayout, type PanelSource,
} from './dashboardModel'
import { tightWindow, type AttentionResult, type BurnRow, type ChannelHealthRow, type CheckRow, type Inspection, type LedgerCell, type PressureRow } from './model'
import type { OverviewPayload, ScopeRange } from './types'

/**
 * 概览 · 简约皮肤: the official Tuffex Dashboard template (Tuff Pulse) bound to the console's own sources — header
 * with the range switch, gateway stat cards, the request / error / P95 timeseries beside the attention rail, the
 * 24h ledger with 7-day comparisons, then channel / Key / account / sync tables with row sparks and status badges.
 * OverviewPage owns every source and the model; this component only lays the same facts out on Tuffex components.
 */
const props = defineProps<{
  /** effective scope: `live` when the user picked it or the server has no /api/overview */
  range: ScopeRange
  rangesAvailable: boolean
  /** the latest /api/overview payload (any range; channel / Key buckets do not depend on it) */
  overview: OverviewPayload | null
  pulse: PulseData | null
  gateway: PanelSource
  enabledKeys: number | null
  kernel: string | null
  /** the local demo kernel (a `-fake` build) is running: its numbers are seeded mock data */
  demo: boolean
  attention: AttentionResult
  attentionSource: PanelSource
  attentionEmpty: string
  inspection: Inspection
  checks: CheckRow[]
  ledger: LedgerCell[]
  ledgerSource: PanelSource
  ledgerAsOf: string | null
  health: ChannelHealthRow[]
  healthState: 'ready' | 'pending' | 'missing'
  burn: BurnRow[]
  keysSource: PanelSource
  pressure: PressureRow[]
  accountsSource: PanelSource
  lanes: LaneJob[]
  policy: string | null
  syncSource: PanelSource
  refreshing: boolean
}>()
const emit = defineEmits<{ 'update:range': [ScopeRange]; refresh: [] }>()

const router = useRouter()
const now = useNow()
const { on: masked } = useMask()
const root = useTemplateRef<HTMLElement>('root')
const width = useElementWidth(root)
const layout = computed(() => layoutOf(width.value))
/** ≥1280: the tables pair up two per row, so each one takes the column-width column set */
const paired = computed(() => width.value >= 1280)
const tableLayout = computed<DashLayout>(() => (paired.value ? 'column' : layout.value))
const live = computed(() => props.range === 'live')

/* ── header ───────────────────────────────────────────────────────────────────────────────────── */

const RANGES: Array<{ value: ScopeRange; label: string }> = [
  { value: 'live', label: '实时' },
  { value: '1h', label: '1h' },
  { value: '6h', label: '6h' },
  { value: '24h', label: '24h' },
]
const severityBadges = computed(() => {
  const c = props.attention.counts
  return [
    c.bad ? { key: 'bad', status: SEVERITY_TONE.bad, text: `${c.bad} 告警` } : null,
    c.warn ? { key: 'warn', status: SEVERITY_TONE.warn, text: `${c.warn} 注意` } : null,
    c.note ? { key: 'note', status: SEVERITY_TONE.note, text: `${c.note} 提示` } : null,
  ].filter((b): b is NonNullable<typeof b> => b !== null)
})
const allClear = computed(() => props.inspection.state === 'complete' && !severityBadges.value.length)
const kernelLink = computed(() => props.kernel ? { text: props.kernel, hot: props.kernel.endsWith('离线') } : null)

/* ── gateway stat cards ───────────────────────────────────────────────────────────────────────── */

const windowWord = computed(() => (live.value ? '近 5 分钟' : `近 ${props.range}`))
const kpis = computed(() => {
  const p = props.pulse
  const g = props.overview?.gateway ?? null
  const gw = live.value ? null : g
  const peak = gw?.peak
  const latency = gw
    ? [gw.p50Ms !== null ? `P50 ${fmtDuration(gw.p50Ms)}` : null, gw.ttftP50Ms !== null ? `首字 ${fmtDuration(gw.ttftP50Ms)}` : null].filter(Boolean).join(' · ')
    : ''
  return [
    {
      key: 'rpm', label: '请求/分', icon: 'i-carbon-activity',
      value: p?.rpm == null ? NONE : fmtNum(p.rpm, 1),
      // always the pulse's 5-minute rate (the statusline's figure); the peak sits inside the selected range
      meta: peak ? `近 5 分钟 · 峰值 ${fmtNum(peak.rpm, 1)} @${hhmm(peak.at)}` : '近 5 分钟',
    },
    {
      key: 'ok', label: '成功率', icon: 'i-carbon-checkmark-outline',
      value: fmtPct(gw ? gw.successRate : p?.successRate, 2),
      meta: gw ? `${windowWord.value} · 错误 ${fmtInt(gw.errors)} / ${fmtInt(gw.requests)}` : windowWord.value,
    },
    {
      key: 'lat', label: '延迟 P95', icon: 'i-carbon-time',
      value: fmtDuration(gw ? gw.p95Ms : p?.p95Ms),
      meta: latency ? `${windowWord.value} · ${latency}` : windowWord.value,
    },
    {
      // 实时 still counts 活跃 Key over the 1h payload: say so, since it differs from the 5-minute window
      key: 'keys', label: '活跃 Key', icon: 'i-carbon-password',
      value: g ? fmtInt(g.activeKeys) : NONE,
      meta: [g ? (live.value ? '近 1h' : windowWord.value) : '重启后可用', props.enabledKeys !== null ? `已启用 ${props.enabledKeys}` : null].filter(Boolean).join(' · '),
    },
  ]
})

/* ── trend chart ──────────────────────────────────────────────────────────────────────────────── */

type Metric = 'flow' | 'latency'
const metric = ref<Metric>('flow')
const zoom = ref<[number, number] | null>(null)
const hiddenSeries = ref<string[]>([])
const SERIES = { rpm: '请求/分', err: '错误/分', p95: 'P95 延迟' } as const
const COLOR = { rpm: ChartPalette.categoricalVar(0), err: 'var(--tx-color-danger)', p95: ChartPalette.categoricalVar(2) } as const

const trend = computed(() => gatewayTrend(live.value, props.overview, props.pulse))
watch(() => props.range, () => {
  zoom.value = null
  if (live.value) metric.value = 'flow'
})
watch(metric, () => {
  zoom.value = null
  hiddenSeries.value = []
})

const chartData = computed<TimeseriesData[]>(() => {
  const t = trend.value
  if (!t) return []
  if (metric.value === 'latency') return [{ name: SERIES.p95, color: COLOR.p95, data: within(t.p95, zoom.value) }]
  return [
    { name: SERIES.rpm, color: COLOR.rpm, data: within(t.requests, zoom.value) },
    { name: SERIES.err, color: COLOR.err, data: within(t.errors, zoom.value) },
  ]
})
/** legend figures follow the visible (brushed) span: mean rate for traffic, the worst bucket for latency */
const legend = computed(() => chartData.value.map((s) => {
  const values = s.data.map(([, v]) => v)
  const value = !values.length ? NONE
    : metric.value === 'latency' ? `最高 ${fmtDuration(Math.max(...values))}`
    : `平均 ${fmtNum(values.reduce((a, b) => a + b, 0) / values.length, 1)}`
  return { name: s.name, color: s.color ?? COLOR.rpm, value }
}))
const markers = computed<TimeseriesMarker[]>(() => {
  const peak = trend.value?.peak
  const points = chartData.value[0]?.data ?? []
  const first = points[0]?.[0]
  const last = points.at(-1)?.[0]
  // the chart folds marker stamps into its x domain: one outside the visible span would stretch the axis
  if (!peak || metric.value !== 'flow' || first === undefined || last === undefined || peak.at < first || peak.at > last) return []
  return [{ timestamp: peak.at, label: '峰值', description: `${fmtNum(peak.rpm, 1)} 请求/分 @${hhmm(peak.at)}` }]
})
const incomplete = computed(() => {
  const after = trend.value?.incompleteAfter
  return after != null ? { after } : undefined
})
const chartHeight = computed(() => (layout.value === 'wide' ? 260 : layout.value === 'column' ? 220 : 180))
const bucketWord = computed(() => {
  const t = trend.value
  if (!t || t.live) return '近 90 秒 · 每秒折算为每分钟'
  return t.bucketMs >= 3_600_000 ? '每小时一个点 · 折算为每分钟' : '每分钟一个点'
})
const zoomLabel = computed(() => {
  const span = zoom.value
  const bucket = trend.value?.bucketMs ?? 60_000
  return span ? `${stampOf(span[0], bucket)} – ${stampOf(span[1], bucket)}` : ''
})
const chartDescription = computed(() =>
  metric.value === 'latency'
    ? `网关${windowWord.value}每个时段成功请求的 P95 延迟`
    : `网关${windowWord.value}每分钟请求与错误；最后一个未结束的时段画成虚线`)

function onZoom(from: number, to: number) {
  const inside = (trend.value?.requests ?? []).filter(([t]) => t >= from && t <= to)
  // a sliver with fewer than two samples would leave the chart nothing to draw
  if (inside.length < 2) return
  zoom.value = [inside[0][0], inside[inside.length - 1][0]]
}
function toggleSeries(name: string) {
  hiddenSeries.value = hiddenSeries.value.includes(name) ? hiddenSeries.value.filter((n) => n !== name) : [...hiddenSeries.value, name]
}
function tickFormat(ts: number) {
  if (!live.value) return hhmm(ts)
  const p = clockParts(ts)
  return p ? `${p.minute}:${p.second}` : NONE
}
const valueFormat = (v: number) => (metric.value === 'latency' ? fmtDuration(v) : fmtNum(v, 1))
const axisFormat = (v: number) => (metric.value === 'latency' ? fmtDuration(v) : v < 10 ? fmtNum(v, 1) : fmtCompact(v))
const stampFormat = (ts: number) => stampOf(ts, trend.value?.bucketMs ?? 60_000)
/** the chart draws its own skeleton while loading; the panel handles error / forbidden */
const gatewayPanelState = computed(() => (props.gateway.state === 'loading' ? 'ready' : props.gateway.state))

/* ── attention rail ───────────────────────────────────────────────────────────────────────────── */

const ATT_MAX = 6
const showAllAttention = ref(false)
/** subjects that are account emails follow the privacy mask, as EmailIdentity does on the Telemetry list */
const shownAttention = computed(() =>
  (showAllAttention.value ? props.attention.items : props.attention.items.slice(0, ATT_MAX))
    .map((it) => ({ ...it, shownSubject: it.email && masked.value ? maskEmail(it.subject) : it.subject })))
/** fewer than 4 open items: up to 3 rows recovered in the last 24h fill the rail, as the Telemetry list does */
const recovered = computed(() => (props.attention.items.length < 4 ? props.attention.recovered.slice(0, 3) : []))

/* ── 近 24 小时 ledger ─────────────────────────────────────────────────────────────────────────── */

const ledgerCards = computed(() => {
  const end = props.ledgerSource.at
  return props.ledger.map((cell) => ({
    cell,
    insight: ledgerInsight(cell.delta),
    spark: end ? historySpark(cell.key, cell.label, cell.history, end) : [],
  }))
})
const ledgerSub = computed(() => `对比前 7 日日均 · 全部渠道${props.ledgerAsOf ? ` · 截至 ${props.ledgerAsOf}` : ''}`)

/* ── channels ─────────────────────────────────────────────────────────────────────────────────── */

const channelLimit = computed(() => (layout.value === 'narrow' ? 5 : 8))
const channelRows = computed(() => {
  const c = props.overview?.channels
  return props.health.slice(0, channelLimit.value).map((row) => ({
    ...row,
    spark: c ? countSpark(row.key, '请求', row.ticks, c.from, c.bucketMs, row.hot ? COLOR.err : COLOR.rpm) : [],
    badBuckets: row.bad.filter(Boolean).length,
  }))
})
type ChannelRow = (typeof channelRows.value)[number]
const channelsHidden = computed(() => Math.max(0, props.health.length - channelRows.value.length))
const channelsState = computed(() => {
  if (props.health.length) return 'ready' as const
  return props.healthState === 'pending' ? ('loading' as const) : ('empty' as const)
})
const channelsEmpty = computed(() => (props.healthState === 'missing' ? '渠道健康重启后可用' : '没有渠道'))
const channelColumns = computed<DataTableColumn<ChannelRow>[]>(() => {
  if (tableLayout.value === 'narrow') {
    return [
      { key: 'name', title: '渠道' },
      { key: 'err', title: '错误', width: 64, align: 'right' },
      { key: 'trend', title: '近 3h', width: 96 },
    ]
  }
  return [
    { key: 'name', title: '渠道' },
    { key: 'state', title: '状态', width: 92 },
    { key: 'requests', title: '请求', width: 72, align: 'right' },
    { key: 'err', title: '错误率', width: 72, align: 'right' },
    ...(tableLayout.value === 'wide' ? [{ key: 'p95', title: 'P95', width: 76, align: 'right' } as DataTableColumn<ChannelRow>] : []),
    { key: 'trend', title: '近 3h', width: tableLayout.value === 'wide' ? 168 : 120 },
  ]
})

/* ── Keys ─────────────────────────────────────────────────────────────────────────────────────── */

const keyLimit = computed(() => (layout.value === 'narrow' ? 5 : 8))
const keyRows = computed(() => {
  const k = props.overview?.keys
  return props.burn.slice(0, keyLimit.value).map((row) => {
    const requests = k ? countSpark(`${row.id}:req`, '请求', row.hours, k.from, k.bucketMs, COLOR.rpm) : []
    return {
      ...row,
      // the error line only rides along a Key that had traffic
      spark: k && requests.length ? [...requests, ...countSpark(`${row.id}:err`, '错误', row.hourErrors, k.from, k.bucketMs, COLOR.err)] : requests,
      tight: tightWindow(row),
      stateText: row.live ? `${row.stateLabel} · 刚调用` : row.stateLabel,
    }
  })
})
type KeyRow = (typeof keyRows.value)[number]
const keyRest = computed(() => props.burn.slice(keyLimit.value))
const keyRestWords = computed(() => {
  const rest = keyRest.value
  const today = rest.reduce((s, r) => s + r.today.spent, 0)
  const week = rest.reduce((s, r) => s + r.week.spent, 0)
  return `其余 ${rest.length} 个 · 今日 ${fmtSpend(today)} · 本周 ${fmtSpend(week)}`
})
const hoursAvailable = computed(() => props.overview !== null)
const keyColumns = computed<DataTableColumn<KeyRow>[]>(() => {
  const h24 = hoursAvailable.value ? [{ key: 'h24', title: '24h', width: tableLayout.value === 'wide' ? 140 : 104 } as DataTableColumn<KeyRow>] : []
  if (tableLayout.value === 'narrow') return [{ key: 'key', title: 'Key' }, ...(h24.length ? h24 : [{ key: 'quota', title: '额度', width: 112 } as DataTableColumn<KeyRow>])]
  return [
    { key: 'key', title: 'Key' },
    { key: 'state', title: '状态', width: 100 },
    { key: 'today', title: '今日', width: 80, align: 'right' },
    ...(tableLayout.value === 'wide' ? [{ key: 'week', title: '本周', width: 84, align: 'right' } as DataTableColumn<KeyRow>] : []),
    { key: 'quota', title: '额度', width: 132 },
    ...h24,
    ...(tableLayout.value === 'wide' ? [{ key: 'last', title: '最近调用', width: 88, align: 'right' } as DataTableColumn<KeyRow>] : []),
  ]
})

/* ── accounts ─────────────────────────────────────────────────────────────────────────────────── */

const accountLimit = computed(() => (layout.value === 'narrow' ? 5 : 8))
const accountRows = computed(() => props.pressure.slice(0, accountLimit.value).map((row) => ({
  ...row,
  shownEmail: masked.value ? maskEmail(row.email) : row.email,
  planLine: [row.provider, row.plan, row.credits ? `重置 ${row.credits} 次` : ''].filter(Boolean).join(' · '),
})))
type AccountRow = (typeof accountRows.value)[number]
const accountColumns = computed<DataTableColumn<AccountRow>[]>(() => [
  { key: 'account', title: '账号' },
  ...(tableLayout.value === 'narrow' ? [] : [{ key: 'window', title: '最紧窗口', width: 156 } as DataTableColumn<AccountRow>]),
  { key: 'state', title: '状态', width: 112, align: 'right' },
])

/* ── sync ─────────────────────────────────────────────────────────────────────────────────────── */

/** runs are counted back 24h from when the jobs were read, not from the ticking clock */
const syncRows = computed(() => {
  const at = props.syncSource.at ?? Date.now()
  return props.lanes.map((job) => ({ job, tally: runTally(job, at) }))
})
type SyncRow = (typeof syncRows.value)[number]
const syncColumns = computed<DataTableColumn<SyncRow>[]>(() => [
  { key: 'job', title: '任务' },
  { key: 'state', title: '状态', width: 96 },
  { key: 'runs', title: '近 24h 运行', width: tableLayout.value === 'narrow' ? 104 : 148 },
  ...(tableLayout.value === 'narrow' ? [] : [{ key: 'last', title: '最近', width: 112, align: 'right' } as DataTableColumn<SyncRow>]),
  ...(tableLayout.value === 'wide' ? [{ key: 'next', title: '下次', width: 96, align: 'right' } as DataTableColumn<SyncRow>] : []),
])
</script>

<template>
  <div ref="root" class="ovd">
    <header class="ovd__header">
      <div class="ovd__brand">
        <span class="ovd__mark" aria-hidden="true"><span class="i-carbon-dashboard" /></span>
        <div class="ovd__titles">
          <span class="ovd__title-row">
            <h1 class="ovd__title">概览</h1>
            <TxStatusBadge v-for="b in severityBadges" :key="b.key" size="sm" :status="b.status" :text="b.text" />
            <TxStatusBadge v-if="allClear" size="sm" status="success" text="全部正常" />
            <TxStatusBadge v-if="demo" size="sm" status="info" icon="i-carbon-data-base" text="本地演示 · mock 数据" />
          </span>
          <span class="ovd__subtitle">
            <span :class="{ 'is-hot': inspection.state === 'failed' }">{{ inspection.state === 'complete' ? (allClear ? '没有需要处理的事项' : '巡检完成') : inspection.words }}</span>
            <template v-if="gateway.at"> · 更新于 {{ fmtTime(gateway.at) }}</template>
            <template v-if="kernelLink"> · <RouterLink to="/settings#gateway" class="ovd-link" :class="{ 'is-hot': kernelLink.hot }">{{ kernelLink.text }}</RouterLink></template>
          </span>
        </div>
      </div>
      <div class="ovd__controls">
        <TxFlatRadio :model-value="range" size="lg" aria-label="网关时间范围" @update:model-value="emit('update:range', $event as ScopeRange)">
          <TxFlatRadioItem v-for="r in RANGES" :key="r.value" :value="r.value" :label="r.label" :disabled="r.value !== 'live' && !rangesAvailable" />
        </TxFlatRadio>
        <TxButton variant="secondary" :loading="refreshing" aria-label="刷新概览的全部数据" @click="emit('refresh')">
          <span class="i-carbon-renew" aria-hidden="true" />刷新
        </TxButton>
      </div>
    </header>

    <section class="ovd__kpis" aria-label="网关指标">
      <TxStatCard
        v-for="k in kpis"
        :key="k.key"
        :class="`ovd-kpi ovd-kpi--${k.key}`"
        :value="k.value"
        :label="k.label"
        :icon-class="k.icon"
        :meta="k.meta"
      >
        <template #value><TxTextMorph :text="k.value" locale="zh-CN" /></template>
      </TxStatCard>
    </section>

    <div class="ovd__main">
      <DashPanel
        title="网关流量"
        :sub="`${windowWord} · ${bucketWord}`"
        class="ovd__trend"
        :state="gatewayPanelState"
        :error="gateway.error"
        :stale-at="gateway.at"
        :rows="6"
        @retry="gateway.retry"
      >
        <template #actions>
          <TxFlatRadio :model-value="metric" size="sm" aria-label="图表指标" @update:model-value="metric = $event as Metric">
            <TxFlatRadioItem value="flow" label="流量" />
            <TxFlatRadioItem value="latency" label="延迟" :disabled="live" />
          </TxFlatRadio>
        </template>
        <div class="ovd-trend__legend">
          <TxChartLegendItem
            v-for="item in legend"
            :key="item.name"
            variant="small"
            :name="item.name"
            :color="item.color"
            :value="item.value"
            :inactive="hiddenSeries.includes(item.name)"
            :aria-pressed="!hiddenSeries.includes(item.name)"
            @click="toggleSeries(item.name)"
          />
          <TxButton v-if="zoom" size="sm" variant="ghost" class="ovd-trend__zoom" :aria-label="`显示完整范围（当前 ${zoomLabel}）`" @click="zoom = null">
            <span class="i-carbon-zoom-reset" aria-hidden="true" />{{ zoomLabel }}
          </TxButton>
          <span v-else-if="!live" class="ovd-trend__hint"><span class="i-carbon-cursor-1" aria-hidden="true" />拖选放大</span>
        </div>
        <p v-if="metric === 'latency' && trend && !trend.p95.length && gateway.state !== 'loading'" class="ovd-trend__note">{{ windowWord }}没有带耗时的成功请求</p>
        <TxTimeseriesChart
          v-else
          v-model:hidden-series="hiddenSeries"
          :data="chartData"
          :markers="markers"
          :incomplete="incomplete"
          :height="chartHeight"
          :loading="gateway.state === 'loading' || !trend"
          :x-axis-tick-count="layout === 'narrow' ? 4 : 6"
          :x-axis-tick-format="tickFormat"
          :y-axis-tick-format="axisFormat"
          :tooltip-value-format="valueFormat"
          :timestamp-format="stampFormat"
          :aria-description="chartDescription"
          @time-range-change="onZoom"
        />
      </DashPanel>

      <DashPanel
        title="需要处理"
        :sub="attention.items.length ? `${attention.items.length} 项 · 按严重程度` : null"
        class="ovd__rail"
        :state="attentionSource.state"
        :error="attentionSource.error"
        :rows="5"
        :cols="['56px', '1fr', '48px']"
        @retry="attentionSource.retry"
      >
        <ol v-if="shownAttention.length" class="ovd-attn">
          <li v-for="it in shownAttention" :key="it.id" class="ovd-attn__row">
            <TxStatusBadge size="sm" :status="SEVERITY_TONE[it.severity]" :text="`${SEVERITY_WORD[it.severity]} · ${it.kind}`" />
            <span class="ovd-attn__main">
              <span class="ovd-attn__subj">{{ it.shownSubject }}</span>
              <span class="ovd-attn__why">{{ it.reason }}<template v-if="it.metric"> · <b class="ovd-num">{{ it.metric }}</b></template></span>
            </span>
            <RouterLink v-if="it.action?.to" :to="it.action.to" class="ovd-link ovd-attn__act">{{ it.action.label }} →</RouterLink>
          </li>
        </ol>
        <p v-else class="ovd-attn__empty">{{ attentionEmpty }}</p>
        <TxButton v-if="attention.items.length > ATT_MAX" size="sm" variant="ghost" :aria-expanded="showAllAttention" @click="showAllAttention = !showAllAttention">
          {{ showAllAttention ? '收起' : `展开全部 ${attention.items.length} 项` }}
        </TxButton>

        <template v-if="recovered.length">
          <h3 class="ovd-rail__h">最近 24h 已恢复</h3>
          <ul class="ovd-rail__list">
            <li v-for="it in recovered" :key="it.id" class="ovd-rec">
              <TxDotIndicator color="var(--tx-color-success)" :size="7" :label="`${it.kind} · ${it.subject}`" />
              <span class="ovd-rec__why">{{ it.reason }}</span>
            </li>
          </ul>
        </template>

        <h3 class="ovd-rail__h">巡检</h3>
        <ul class="ovd-rail__list">
          <li v-for="c in checks" :key="c.key">
            <RouterLink :to="c.to" class="ovd-check">
              <TxDotIndicator :color="CHECK_COLOR[c.mark]" :size="7" :aria-label="CHECK_WORD[c.mark]" />
              <span class="ovd-check__kind">{{ c.kind }}</span>
              <span class="ovd-check__text">{{ c.text }}</span>
            </RouterLink>
          </li>
        </ul>
      </DashPanel>
    </div>

    <DashPanel
      title="近 24 小时"
      :sub="ledgerSub"
      :state="ledgerSource.state"
      :error="ledgerSource.error"
      :stale-at="ledgerSource.at"
      :rows="2"
      :cols="['1fr', '1fr', '1fr']"
      @retry="ledgerSource.retry"
    >
      <template #actions><RouterLink to="/usage?days=1" class="ovd-link">用量 →</RouterLink></template>
      <div class="ovd-ledger">
        <TxStatCard
          v-for="c in ledgerCards"
          :key="c.cell.key"
          class="ovd-ledger__card"
          :value="c.cell.value"
          :label="c.cell.label"
          :insight="c.insight"
        >
          <template #value><TxTextMorph :text="c.cell.value" locale="zh-CN" /></template>
          <template v-if="c.cell.sub || c.spark.length" #meta>
            <span class="ovd-ledger__meta">
              <span v-if="c.cell.sub">{{ c.cell.sub }}</span>
              <span v-if="c.spark.length" class="ovd-spark ovd-spark--ledger">
                <TxSparkChart :series="c.spark" :padding="{ top: 4, right: 4, bottom: 4, left: 2 }" :line-width="1.5" :interactive="false" :aria-label="`${c.cell.label} 近 7 个滚动 24 小时`" />
              </span>
            </span>
          </template>
        </TxStatCard>
      </div>
    </DashPanel>

    <div class="ovd__pair">
      <DashPanel
        title="渠道健康"
        :sub="`近 3 小时 · 每 5 分钟 · 共 ${fmtInt(health.length)} 个`"
        flush
        :state="channelsState"
        :empty-text="channelsEmpty"
        :rows="5"
        @retry="gateway.retry"
      >
        <template #actions><RouterLink to="/channels" class="ovd-link">渠道 →</RouterLink></template>
        <TxDataTable :columns="channelColumns" :data="channelRows" row-key="key" table-layout="fixed" scroll-x :empty-text="channelsEmpty">
          <template #cell-name="{ row }">
            <span class="ovd-cell">
              <RouterLink :to="(row as ChannelRow).to" class="ovd-cell__primary ovd-link--plain">{{ (row as ChannelRow).name }}</RouterLink>
              <TxStatusBadge v-if="tableLayout === 'narrow'" size="sm" :status="STATUS_TONE[(row as ChannelRow).state]" :text="(row as ChannelRow).stateLabel" />
            </span>
          </template>
          <template #cell-state="{ row }">
            <TxStatusBadge size="sm" :status="STATUS_TONE[(row as ChannelRow).state]" :text="(row as ChannelRow).stateLabel" />
          </template>
          <template #cell-requests="{ row }"><span class="ovd-num">{{ fmtInt((row as ChannelRow).requests) }}</span></template>
          <template #cell-err="{ row }">
            <span class="ovd-num" :class="{ 'is-hot': (row as ChannelRow).hot }">{{ fmtPct((row as ChannelRow).errRate) }}</span>
          </template>
          <template #cell-p95="{ row }"><span class="ovd-num">{{ fmtDuration((row as ChannelRow).p95Ms) }}</span></template>
          <template #cell-trend="{ row }">
            <span v-if="(row as ChannelRow).spark.length" class="ovd-spark">
              <TxSparkChart
                :series="(row as ChannelRow).spark"
                :padding="{ top: 4, right: 4, bottom: 4, left: 2 }"
                :line-width="1.5"
                :baseline="false"
                :interactive="false"
                :aria-label="`${(row as ChannelRow).name} 近 3 小时每 5 分钟：${fmtInt((row as ChannelRow).requests)} 次请求，${fmtInt((row as ChannelRow).errors)} 次错误，${(row as ChannelRow).badBuckets} 段失败率 ≥20%`"
              />
            </span>
            <span v-else class="ovd-dim">空闲</span>
          </template>
        </TxDataTable>
        <template v-if="channelsHidden" #footer>
          <RouterLink to="/channels" class="ovd-link">其余 {{ channelsHidden }} 个渠道 →</RouterLink>
        </template>
      </DashPanel>

      <DashPanel
        title="Key 用量"
        sub="按额度压力 · 本周花费"
        flush
        :state="keysSource.state"
        :error="keysSource.error"
        :stale-at="keysSource.at"
        :rows="6"
        empty-text="还没有 Key"
        empty-action="新建 Key"
        @retry="keysSource.retry"
        @empty-action="router.push('/keys?new=1')"
      >
        <template #actions><RouterLink to="/keys" class="ovd-link">全部 {{ fmtInt(burn.length) }} 个 →</RouterLink></template>
        <TxDataTable
          :columns="keyColumns"
          :data="keyRows"
          row-key="id"
          table-layout="fixed"
          scroll-x
          interactive-rows
          hover
          @row-click="({ row }: { row: KeyRow }) => router.push(`/keys?q=${encodeURIComponent(row.name)}`)"
        >
          <template #cell-key="{ row }">
            <span class="ovd-cell">
              <span class="ovd-cell__line">
                <span class="ovd-cell__primary">{{ (row as KeyRow).name }}</span>
                <span class="ovd-cell__mono">{{ (row as KeyRow).tail }}</span>
              </span>
              <span v-if="tableLayout === 'narrow'" class="ovd-cell__line">
                <TxStatusBadge size="sm" :status="STATUS_TONE[(row as KeyRow).state]" :text="(row as KeyRow).stateText" />
                <span class="ovd-cell__sub">今日 {{ fmtSpend((row as KeyRow).today.spent) }} · 本周 {{ fmtSpend((row as KeyRow).week.spent) }}<template v-if="(row as KeyRow).tight"> · {{ (row as KeyRow).tight!.label }}额度 {{ fmtPct((row as KeyRow).tight!.ratio, 0) }}</template><template v-else> · 不限额</template></span>
              </span>
            </span>
          </template>
          <template #cell-state="{ row }">
            <TxStatusBadge size="sm" :status="STATUS_TONE[(row as KeyRow).state]" :text="(row as KeyRow).stateText" />
          </template>
          <template #cell-today="{ row }"><span class="ovd-num" :class="{ 'ovd-dim': !(row as KeyRow).today.spent }">{{ fmtSpend((row as KeyRow).today.spent) }}</span></template>
          <template #cell-week="{ row }"><span class="ovd-num" :class="{ 'ovd-dim': !(row as KeyRow).week.spent }">{{ fmtSpend((row as KeyRow).week.spent) }}</span></template>
          <template #cell-quota="{ row }">
            <span v-if="(row as KeyRow).tight" class="ovd-meter">
              <TxProgressBar
                :percentage="Math.min(100, (row as KeyRow).tight!.ratio * 100)"
                :status="ratioStatus((row as KeyRow).tight!.ratio)"
                height="6px"
                :aria-label="`${(row as KeyRow).name} ${(row as KeyRow).tight!.label}额度已用 ${fmtPct((row as KeyRow).tight!.ratio, 0)}`"
              />
              <span class="ovd-num">{{ (row as KeyRow).tight!.label }} {{ fmtPct((row as KeyRow).tight!.ratio, 0) }}</span>
            </span>
            <span v-else class="ovd-dim">不限</span>
          </template>
          <template #cell-h24="{ row }">
            <span v-if="(row as KeyRow).spark.length" class="ovd-spark">
              <TxSparkChart
                :series="(row as KeyRow).spark"
                :padding="{ top: 4, right: 4, bottom: 4, left: 2 }"
                :line-width="1.5"
                :baseline="false"
                :interactive="false"
                :aria-label="`${(row as KeyRow).name} 近 24 小时每小时请求，共 ${fmtInt((row as KeyRow).requests24h)} 次`"
              />
            </span>
            <span v-else class="ovd-dim">无调用</span>
          </template>
          <template #cell-last="{ row }"><span class="ovd-dim">{{ (row as KeyRow).lastUsedAt ? fmtAgo((row as KeyRow).lastUsedAt, now) : '从未' }}</span></template>
        </TxDataTable>
        <template v-if="keyRest.length" #footer>
          <span class="ovd-num">{{ keyRestWords }}</span>
        </template>
      </DashPanel>
    </div>

    <div class="ovd__pair">
      <DashPanel
        title="账号额度压力"
        sub="每个账号最紧的窗口"
        flush
        :state="accountsSource.state"
        :error="accountsSource.error"
        :stale-at="accountsSource.at"
        :rows="5"
        empty-text="没有接入账号"
        empty-action="添加账号"
        @retry="accountsSource.retry"
        @empty-action="router.push('/accounts?add=1')"
      >
        <template #actions><RouterLink to="/accounts" class="ovd-link">{{ fmtInt(pressure.length) }} 个账号 →</RouterLink></template>
        <TxDataTable :columns="accountColumns" :data="accountRows" row-key="id" table-layout="fixed" scroll-x>
          <template #cell-account="{ row }">
            <span class="ovd-who">
              <ProviderMark :provider="(row as AccountRow).provider" :size="18" :label="(row as AccountRow).provider" />
              <span class="ovd-cell">
                <span class="ovd-cell__primary" :class="{ 'is-struck': (row as AccountRow).state === 'bad' && (row as AccountRow).stateLabel === '失效' }">{{ (row as AccountRow).shownEmail }}</span>
                <span class="ovd-cell__sub">{{ (row as AccountRow).planLine }}</span>
                <span v-if="tableLayout === 'narrow' && (row as AccountRow).window" class="ovd-meter">
                  <TxProgressBar :percentage="Math.min(100, (row as AccountRow).window!.ratio * 100)" :status="ratioStatus((row as AccountRow).window!.ratio)" height="6px" :aria-label="`${(row as AccountRow).window!.label} 已用 ${fmtPct((row as AccountRow).window!.ratio, 0)}`" />
                  <span class="ovd-num">{{ (row as AccountRow).window!.short }} {{ fmtPct((row as AccountRow).window!.ratio, 0) }}</span>
                </span>
              </span>
            </span>
          </template>
          <template #cell-window="{ row }">
            <span v-if="(row as AccountRow).window" class="ovd-meter">
              <TxProgressBar :percentage="Math.min(100, (row as AccountRow).window!.ratio * 100)" :status="ratioStatus((row as AccountRow).window!.ratio)" height="6px" :aria-label="`${(row as AccountRow).window!.label} 已用 ${fmtPct((row as AccountRow).window!.ratio, 0)}`" />
              <span class="ovd-num">{{ (row as AccountRow).window!.short }} {{ fmtPct((row as AccountRow).window!.ratio, 0) }}</span>
            </span>
            <span v-else class="ovd-dim">{{ (row as AccountRow).error ? '额度读取失败' : '无窗口' }}</span>
          </template>
          <template #cell-state="{ row }">
            <span class="ovd-cell ovd-cell--end">
              <CountdownPie v-if="(row as AccountRow).coolUntil" :until="(row as AccountRow).coolUntil" />
              <TxStatusBadge v-else size="sm" :status="STATUS_TONE[(row as AccountRow).state]" :text="(row as AccountRow).stateLabel" />
              <span v-if="(row as AccountRow).state === 'run' && (row as AccountRow).window?.resetsAt" class="ovd-cell__sub">↻ {{ fmtTime((row as AccountRow).window!.resetsAt) }}</span>
            </span>
          </template>
        </TxDataTable>
        <template v-if="pressure.length > accountRows.length" #footer>
          <RouterLink to="/accounts" class="ovd-link">其余 {{ pressure.length - accountRows.length }} 个账号 →</RouterLink>
        </template>
      </DashPanel>

      <DashPanel
        title="后台同步"
        :sub="policy"
        flush
        :state="syncSource.state"
        :error="syncSource.error"
        :stale-at="syncSource.at"
        :rows="6"
        empty-text="没有同步任务"
        @retry="syncSource.retry"
      >
        <template #actions><RouterLink to="/settings#sync" class="ovd-link">同步中心 →</RouterLink></template>
        <TxDataTable :columns="syncColumns" :data="syncRows" :row-key="(row: SyncRow) => row.job.id" table-layout="fixed" scroll-x>
          <template #cell-job="{ row }">
            <span class="ovd-cell">
              <span class="ovd-cell__primary">{{ (row as SyncRow).job.label }}</span>
              <span class="ovd-cell__sub">{{ (row as SyncRow).job.every }}<template v-if="(row as SyncRow).job.calls24h != null"> · {{ fmtInt((row as SyncRow).job.calls24h) }} 次调用/24h</template></span>
              <span v-if="(row as SyncRow).job.summary" class="ovd-cell__sub">{{ (row as SyncRow).job.summary }}</span>
            </span>
          </template>
          <template #cell-state="{ row }">
            <TxStatusBadge size="sm" :status="STATUS_TONE[(row as SyncRow).job.state ?? 'idle']" :text="(row as SyncRow).job.stateLabel ?? NONE" />
          </template>
          <template #cell-runs="{ row }">
            <span v-if="(row as SyncRow).tally.total" class="ovd-meter ovd-meter--stack">
              <TxProgressBar :segments="(row as SyncRow).tally.segments" :segments-total="(row as SyncRow).tally.total" height="6px" :aria-label="`${(row as SyncRow).job.label} 近 24 小时：${(row as SyncRow).tally.words}`" />
              <span class="ovd-num" :class="{ 'is-hot': (row as SyncRow).tally.failed }">{{ (row as SyncRow).tally.total }} 次<template v-if="(row as SyncRow).tally.failed"> · 失败 {{ (row as SyncRow).tally.failed }}</template></span>
            </span>
            <span v-else class="ovd-dim">无运行</span>
          </template>
          <template #cell-last="{ row }"><span class="ovd-dim">{{ (row as SyncRow).job.lastAt ? fmtAgo((row as SyncRow).job.lastAt, now) : '从未' }}</span></template>
          <template #cell-next="{ row }">
            <span class="ovd-dim">
              <template v-if="(row as SyncRow).job.backoffUntil">退避至 {{ fmtTime((row as SyncRow).job.backoffUntil) }}</template>
              <template v-else-if="(row as SyncRow).job.nextAt">{{ fmtTime((row as SyncRow).job.nextAt) }}</template>
              <template v-else>{{ NONE }}</template>
            </span>
          </template>
        </TxDataTable>
      </DashPanel>
    </div>
  </div>
</template>

<style>
@scope (html[data-skin="minimal"]) {
  /* Tuff Pulse: panels are the objects, the shell canvas is the ground; one container drives every breakpoint. */
  .ovd {
    container: ovd / inline-size;
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 16px;
    min-width: 0;
    color: var(--tx-text-color-primary);
    font-size: 13px;
  }

  /* header */
  .ovd__header {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 12px 16px;
  }
  .ovd__brand { display: flex; flex: 1 1 320px; align-items: center; gap: 12px; min-width: 0; }
  .ovd__mark {
    display: inline-flex;
    flex: none;
    align-items: center;
    justify-content: center;
    width: 40px;
    height: 40px;
    border-radius: 12px;
    background: var(--tx-color-primary-light-9);
    color: var(--tx-color-primary);
    font-size: 18px;
  }
  .ovd__titles { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
  .ovd__title-row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; }
  .ovd__title { font-size: 20px; font-weight: 600; line-height: 1.3; }
  .ovd__subtitle { color: var(--tx-text-color-secondary); font-size: 12px; overflow-wrap: anywhere; }
  .ovd__controls { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 10px; }
  .ovd__controls .tx-button { gap: 6px; }

  /* stat cards */
  .ovd__kpis { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 16px; }
  .ovd-kpi--rpm .tx-stat-card__icon { color: var(--tx-color-primary); }
  .ovd-kpi--ok .tx-stat-card__icon { color: var(--tx-color-success); }
  .ovd-kpi--lat .tx-stat-card__icon { color: var(--tx-color-warning); }
  .ovd-kpi--keys .tx-stat-card__icon { color: var(--tx-chart-categorical-4, var(--tx-color-primary)); }

  /* panels */
  .ovd-panel {
    display: flex;
    flex-direction: column;
    min-width: 0;
    overflow: hidden;
    border-radius: 16px;
    background: var(--tx-bg-color);
    box-shadow: 0 0 0 1px var(--tx-border-color-lighter);
  }
  .ovd-panel__head { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: 8px 12px; padding: 16px 20px 12px; }
  .ovd-panel__titles { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .ovd-panel__title { font-size: 14px; font-weight: 600; line-height: 1.4; }
  .ovd-panel__sub { color: var(--tx-text-color-secondary); font-size: 12px; overflow-wrap: anywhere; }
  .ovd-panel__actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
  .ovd-panel__body, .ovd-panel__state { display: flex; flex-direction: column; gap: 12px; min-width: 0; padding: 0 20px 16px; }
  .ovd-panel.is-flush .ovd-panel__body { padding: 0; }
  .ovd-panel__foot { padding: 10px 20px 14px; border-top: 1px solid var(--tx-border-color-extra-light); color: var(--tx-text-color-secondary); font-size: 12px; }
  .ovd-panel.is-flush .tx-data-table { border-radius: 0; }

  /* chart + attention rail */
  .ovd__main { display: grid; grid-template-columns: minmax(0, 1fr); gap: 16px; align-items: start; }
  .ovd-trend__legend { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 20px; color: var(--tx-text-color-regular); }
  .ovd-trend__legend .tx-chart-legend-item { cursor: pointer; }
  .ovd-trend__legend .tx-chart-legend-item:focus-visible { border-radius: 4px; outline: 2px solid var(--tx-color-primary); outline-offset: 3px; }
  .ovd-trend__hint, .ovd-trend__zoom { margin-left: auto; }
  .ovd-trend__hint { display: inline-flex; align-items: center; gap: 4px; color: var(--tx-text-color-placeholder); font-size: 12px; }
  .ovd-trend__zoom { gap: 6px; font-variant-numeric: tabular-nums; }
  .ovd-trend__note { padding: 24px 0; color: var(--tx-text-color-secondary); }

  .ovd-attn { display: flex; flex-direction: column; margin: 0; padding: 0; list-style: none; }
  .ovd-attn__row {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: start;
    gap: 4px 10px;
    padding: 10px 0;
  }
  .ovd-attn__row + .ovd-attn__row { border-top: 1px solid var(--tx-border-color-extra-light); }
  .ovd-attn__main { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .ovd-attn__subj { font-weight: 500; overflow-wrap: anywhere; }
  .ovd-attn__why { color: var(--tx-text-color-secondary); font-size: 12px; overflow-wrap: anywhere; }
  .ovd-attn__act { white-space: nowrap; font-size: 12px; }
  .ovd-attn__empty { color: var(--tx-text-color-secondary); }
  .ovd-rail__h { margin-top: 4px; color: var(--tx-text-color-secondary); font-size: 12px; font-weight: 600; }
  .ovd-rail__list { display: flex; flex-direction: column; gap: 2px; margin: 0; padding: 0; list-style: none; }
  .ovd-rec { display: flex; flex-wrap: wrap; align-items: center; gap: 2px 8px; padding: 4px 0; font-size: 12px; }
  .ovd-rec__why { color: var(--tx-text-color-secondary); }
  .ovd-check {
    display: grid;
    grid-template-columns: 12px 36px minmax(0, 1fr);
    align-items: center;
    gap: 8px;
    min-height: 32px;
    border-radius: 6px;
    color: var(--tx-text-color-regular);
    font-size: 12px;
    text-decoration: none;
  }
  .ovd-check:hover .ovd-check__text { color: var(--tx-text-color-primary); text-decoration: underline; text-underline-offset: 3px; }
  .ovd-check:focus-visible { outline: 2px solid var(--tx-color-primary); outline-offset: 2px; }
  .ovd-check__kind { color: var(--tx-text-color-secondary); white-space: nowrap; }
  .ovd-check__text { min-width: 0; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }

  /* 24h ledger */
  .ovd-ledger { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
  .ovd-ledger__meta { display: flex; flex-direction: column; gap: 6px; min-width: 0; overflow-wrap: anywhere; }

  /* tables */
  .ovd__pair { display: grid; grid-template-columns: minmax(0, 1fr); gap: 16px; align-items: start; }
  .ovd-cell { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
  .ovd-cell--end { align-items: flex-end; }
  .ovd-cell__line { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; min-width: 0; }
  .ovd-cell__primary { min-width: 0; overflow: hidden; color: var(--tx-text-color-primary); font-weight: 500; text-overflow: ellipsis; white-space: nowrap; }
  .ovd-cell__primary.is-struck { text-decoration: line-through; }
  .ovd-cell__mono { color: var(--tx-text-color-placeholder); font-family: var(--tx-font-mono, ui-monospace, monospace); font-size: 11px; }
  .ovd-cell__sub { color: var(--tx-text-color-secondary); font-size: 12px; white-space: normal; overflow-wrap: anywhere; }
  .ovd-who { display: flex; align-items: center; gap: 10px; min-width: 0; }
  .ovd-meter { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .ovd-meter .tx-progress-bar { flex: 1; min-width: 40px; }
  .ovd-meter--stack { flex-direction: column; align-items: stretch; gap: 4px; }
  .ovd-meter--stack .tx-progress-bar { flex: none; }
  /* a fixed box, so rows keep their height before and after the sparks draw */
  .ovd-spark { display: block; width: 100%; height: 28px; }
  .ovd-spark--ledger { height: 32px; }

  /* text atoms */
  .ovd-num { font-variant-numeric: tabular-nums; white-space: nowrap; }
  .ovd-dim { color: var(--tx-text-color-secondary); font-size: 12px; }
  .ovd .is-hot { color: var(--tx-color-danger); }
  .ovd-link { color: var(--tx-color-primary); font-size: 12px; text-decoration: none; white-space: nowrap; }
  .ovd-link:hover { text-decoration: underline; text-underline-offset: 3px; }
  .ovd-link:focus-visible, .ovd-link--plain:focus-visible { border-radius: 4px; outline: 2px solid var(--tx-color-primary); outline-offset: 2px; }
  .ovd-link--plain { color: inherit; text-decoration: none; }
  .ovd-link--plain:hover { text-decoration: underline; text-underline-offset: 3px; }

  @container ovd (min-width: 960px) {
    .ovd__main { grid-template-columns: minmax(0, 1fr) 360px; }
  }
  @container ovd (min-width: 1280px) {
    .ovd-ledger { grid-template-columns: repeat(6, minmax(0, 1fr)); }
    .ovd__pair { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  }
  @container ovd (max-width: 639.98px) {
    .ovd__main, .ovd__pair { gap: 12px; }
    .ovd__mark { display: none; }
    .ovd__controls { width: 100%; }
    .ovd__kpis, .ovd-ledger { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
    .ovd-panel__head { padding: 14px 14px 10px; }
    .ovd-panel__body, .ovd-panel__state { padding: 0 14px 14px; }
    .ovd-panel__foot { padding: 10px 14px 12px; }
    .ovd-trend__hint { display: none; }
    .ovd-attn__row { grid-template-columns: minmax(0, 1fr) auto; }
    .ovd-attn__main { grid-column: 1 / -1; grid-row: 2; }
  }
  @media (pointer: coarse) {
    .ovd-check { min-height: 44px; }
  }
}
</style>
