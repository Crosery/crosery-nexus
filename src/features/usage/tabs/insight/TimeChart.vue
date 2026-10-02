<script setup lang="ts">
import { computed, ref, useTemplateRef } from 'vue'
import RowTable from '../../../../ui/data/RowTable.vue'
import { useElementWidth } from '../../../../ui/composables/useElementWidth'
import { niceAxis, niceTicks } from '../../../../ui/viz/model'
import { clockParts, NONE } from '../../../../ui/fmt'
import type { RowColumn } from '../../../../ui/types'
import { bandX, bucketRange, bucketTick, logPos, logTicks, type ChartPoint, type ChartSeries } from './model'
import '../../../../ui/viz/viz.css'

/**
 * Time-bucket chart for the 缓存 / 性能 tabs (local: the kit TrendChart is single-series, index-spaced and has a
 * one-value readout). One y-axis per plot (DESIGN §2.3): every series here shares the unit — e.g. P50 and P95
 * in ms — and a different measure goes to the volume strip under the plot, which shares x but not y.
 * x is the bucket band (empty buckets are gaps, never 0); hover, ←/→/Home/End move a cursor whose readout is
 * docked in the head row so it never covers data; Esc clears; `⋯ 以表格查看` swaps in a table.
 * Sparse data (few buckets carry a value) is drawn as steps: each value spans its own bucket band, adjacent
 * buckets join with a riser, and nothing is interpolated across time — a lone diagonal between two buckets
 * read as a trend that was not there (sweep1 #4). The head says how many buckets have data.
 */
const props = withDefaults(
  defineProps<{
    points: ChartPoint[]
    series: ChartSeries[]
    bucketMs: number
    /** accessible name */
    label: string
    h?: number
    format: (value: number | null) => string
    scale?: 'linear' | 'log'
    /** fixed top of a linear axis (rates: 1) */
    fixedMax?: number | null
    reference?: { value: number; label: string } | null
    /** values of the first series above this get a signal mark (failure thresholds only) */
    hotAbove?: number | null
    /** volume strip under the plot: label + value format; `hot` part is drawn in signal (failures) */
    strip?: { label: string; hotLabel?: string; format: (value: number | null) => string } | null
    now?: number | null
    area?: boolean
  }>(),
  { h: 150, scale: 'linear', fixedMax: null, reference: null, hotAbove: null, strip: null, now: null, area: true },
)

defineSlots<{ readout?: (props: { point: ChartPoint; index: number; range: string }) => unknown }>()

const host = useTemplateRef<HTMLElement>('host')
const width = useElementWidth(host, 640)
const PAD_L = 46
const PAD_R_MIN = 34
const PAD_T = 8
const AXIS_H = 16
const STRIP_H = 24
const STRIP_GAP = 8

const n = computed(() => props.points.length)
const barMax = computed(() => Math.max(0, ...props.points.map((p) => p.bar ?? 0)))
/* the right gutter fits the strip's peak label (mono micro ≈ 6.2px per char, CJK glyph ≈ 10px) */
const peakText = computed(() => (props.strip ? `峰 ${props.strip.format(barMax.value)}` : ''))
const padR = computed(() => Math.max(PAD_R_MIN, peakText.value ? 6 + 10 + (peakText.value.length - 1) * 6.2 : 0))
const plotW = computed(() => Math.max(60, width.value - PAD_L - padR.value))
const plotH = computed(() => Math.max(40, props.h))
const stripTop = computed(() => PAD_T + plotH.value + AXIS_H + STRIP_GAP)
const totalH = computed(() => PAD_T + plotH.value + AXIS_H + (props.strip ? STRIP_GAP + STRIP_H + 4 : 0))

const allValues = computed(() => {
  const out: number[] = []
  for (const p of props.points) for (const s of props.series) {
    const v = p.v[s.key]
    if (typeof v === 'number' && Number.isFinite(v)) out.push(v)
  }
  return out
})

const yAxis = computed(() => {
  const nums = allValues.value
  if (props.scale === 'log') {
    const pos = nums.filter((v) => v > 0)
    const { ticks, lo, hi } = logTicks(pos.length ? Math.min(...pos) : 100, pos.length ? Math.max(...pos) : 10_000, plotH.value < 110 ? 4 : 6)
    return { ticks, y: (v: number) => { const p = logPos(v, lo, hi); return p === null ? null : plotH.value - p * plotH.value } }
  }
  if (props.fixedMax) {
    const ticks = props.fixedMax === 1 ? [0, 0.25, 0.5, 0.75, 1] : niceTicks(0, props.fixedMax, 4)
    return { ticks, y: (v: number) => plotH.value - (Math.max(0, Math.min(props.fixedMax!, v)) / props.fixedMax!) * plotH.value }
  }
  const extra = props.reference ? [props.reference.value] : []
  const axis = niceAxis(0, Math.max(0, ...nums, ...extra) || 1, 4)
  return { ticks: axis.ticks, y: (v: number) => plotH.value - ((v - axis.min) / (axis.max - axis.min || 1)) * plotH.value }
})

const xOf = (i: number) => bandX(i, n.value, plotW.value)

/** buckets of the first series that carry a value; few of them → step rendering (no interpolation, no area) */
const filled = computed(() => {
  const key = props.series[0]?.key
  if (!key) return 0
  return props.points.reduce((sum, p) => sum + (typeof p.v[key] === 'number' && Number.isFinite(p.v[key]) ? 1 : 0), 0)
})
const sparse = computed(() => filled.value > 0 && n.value > 1 && (filled.value <= 6 || filled.value / n.value < 0.4))

type Drawn = { key: string; tone: string; dashed: boolean; d: string; dots: Array<[number, number]>; end: { x: number; y: number } | null; label: string }
const drawn = computed<Drawn[]>(() =>
  props.series.map((s) => {
    let d = ''
    const dots: Array<[number, number]> = []
    let run: Array<[number, number]> = []
    const half = Math.max(1.5, plotW.value / Math.max(1, n.value) / 2 - 1)
    const flush = () => {
      if (sparse.value && run.length) {
        // steps: across each bucket band, risers between adjacent buckets; a dot marks every bucket centre
        d += run.map((p, i) => `${i ? `V${p[1].toFixed(1)}` : `M${(p[0] - half).toFixed(1)} ${p[1].toFixed(1)}`}H${(p[0] + half).toFixed(1)}`).join('')
        dots.push(...run)
      } else if (run.length === 1) dots.push(run[0])
      else if (run.length > 1) d += run.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join('')
      run = []
    }
    let end: Drawn['end'] = null
    props.points.forEach((p, i) => {
      const v = p.v[s.key]
      const y = typeof v === 'number' && Number.isFinite(v) ? yAxis.value.y(v) : null
      if (y === null) return flush()
      run.push([xOf(i), y])
      end = { x: xOf(i), y }
    })
    flush()
    return { key: s.key, tone: s.tone ?? 'k1', dashed: Boolean(s.dashed), d, dots, end, label: s.label }
  }),
)

/** quiet tonal area under the first series (linear scale only; contiguous runs) */
const areaD = computed(() => {
  if (!props.area || sparse.value || props.scale === 'log' || !props.series.length) return ''
  const key = props.series[0].key
  let d = ''
  let run: Array<[number, number]> = []
  const flush = () => {
    if (run.length > 1) d += `M${run[0][0].toFixed(1)} ${plotH.value}` + run.map((p) => `L${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join('') + `L${run[run.length - 1][0].toFixed(1)} ${plotH.value}Z`
    run = []
  }
  props.points.forEach((p, i) => {
    const v = p.v[key]
    const y = typeof v === 'number' && Number.isFinite(v) ? yAxis.value.y(v) : null
    if (y === null) flush()
    else run.push([xOf(i), y])
  })
  flush()
  return d
})

const hotMarks = computed(() => {
  if (props.hotAbove === null || !props.series.length) return []
  const key = props.series[0].key
  const out: Array<[number, number]> = []
  props.points.forEach((p, i) => {
    const v = p.v[key]
    if (typeof v === 'number' && v > props.hotAbove!) {
      const y = yAxis.value.y(v)
      if (y !== null) out.push([xOf(i), y])
    }
  })
  return out
})

/**
 * x labels sit on wall-clock boundaries: day starts for 6h / daily buckets, every 3rd hour for hourly ones
 * (00:00 reads as the date), thinned evenly to what the width holds.
 */
const xTicks = computed(() => {
  const count = n.value
  if (!count) return []
  const want = Math.max(2, Math.min(10, Math.floor(plotW.value / 84)))
  const hourOf = (t: number) => Number(clockParts(t)?.hour ?? 0)
  const all = props.points.map((_, i) => i)
  let candidates = props.bucketMs >= 86_400_000
    ? all
    : props.bucketMs >= 6 * 3_600_000
      ? all.filter((i) => hourOf(props.points[i].t) === 0)
      : all.filter((i) => hourOf(props.points[i].t) % 3 === 0)
  if (candidates.length < 2) candidates = all
  const step = Math.max(1, Math.ceil(candidates.length / want))
  const last = candidates.length - 1
  return candidates
    .filter((_, k) => (last - k) % step === 0)
    .map((i) => ({ i, x: xOf(i), text: bucketTick(props.points[i].t, props.bucketMs) }))
})

const bars = computed(() => {
  if (!props.strip) return []
  const bw = Math.max(1, plotW.value / Math.max(1, n.value) - (n.value > 60 ? 1 : 2))
  const max = barMax.value || 1
  return props.points.map((p, i) => {
    const v = p.bar ?? 0
    const h = v > 0 ? Math.max(1, (v / max) * STRIP_H) : 0
    const hot = p.hot && v > 0 ? Math.max(1, (p.hot / max) * STRIP_H) : 0
    return { x: xOf(i) - bw / 2, w: bw, h, hot }
  })
})

const nowX = computed(() => {
  if (!props.now || !n.value) return null
  const start = props.points[0].t
  const span = n.value * props.bucketMs
  const f = (props.now - start) / span
  return f > 0 && f <= 1 ? f * plotW.value : null
})

const cursor = ref<number | null>(null)
const cursorPoint = computed(() => (cursor.value === null ? null : props.points[cursor.value] ?? null))
const cursorRange = computed(() => (cursorPoint.value ? bucketRange(cursorPoint.value.t, props.bucketMs, props.now ?? Date.now()) : ''))
const cursorDots = computed(() => {
  if (cursor.value === null || !cursorPoint.value) return []
  return props.series.flatMap((s) => {
    const v = cursorPoint.value!.v[s.key]
    const y = typeof v === 'number' && Number.isFinite(v) ? yAxis.value.y(v) : null
    return y === null ? [] : [{ key: s.key, x: xOf(cursor.value!), y }]
  })
})

function onMove(event: PointerEvent) {
  if (!n.value) return
  const rect = (event.currentTarget as SVGElement).getBoundingClientRect()
  const fx = (event.clientX - rect.left - PAD_L) / plotW.value
  cursor.value = Math.max(0, Math.min(n.value - 1, Math.floor(fx * n.value)))
}
function onKey(event: KeyboardEvent) {
  if (!n.value) return
  if (event.key === 'Escape') {
    cursor.value = null
    return
  }
  const at = cursor.value ?? n.value - 1
  const next = event.key === 'ArrowLeft' ? at - 1 : event.key === 'ArrowRight' ? at + 1 : event.key === 'Home' ? 0 : event.key === 'End' ? n.value - 1 : null
  if (next === null) return
  event.preventDefault()
  cursor.value = Math.max(0, Math.min(n.value - 1, next))
}

const asTable = ref(false)
const fmtV = (v: number | null | undefined) => (typeof v === 'number' && Number.isFinite(v) ? props.format(v) : NONE)

/* 以表格查看: the same buckets as a kit RowTable (row-cards on phones) */
type TableRow = { t: number; point: ChartPoint }
const tableRows = computed<TableRow[]>(() => props.points.map((point) => ({ t: point.t, point })))
const tableColumns = computed<RowColumn<TableRow>[]>(() => {
  const strip = props.strip
  return [
    { key: 't', title: '时间', minWidth: 140, card: 'primary', format: (_v, r) => bucketRange(r.t, props.bucketMs, props.now ?? Date.now()) },
    ...props.series.map((s): RowColumn<TableRow> => ({ key: `s-${s.key}`, title: s.label, width: 96, align: 'right', card: 'line2', cardLabel: s.label, format: (_v, r) => fmtV(r.point.v[s.key]) })),
    ...(strip ? [{ key: 'bar', title: strip.label, width: 88, align: 'right', card: 'line2', cardLabel: strip.label, format: (_v, r) => strip.format(r.point.bar ?? 0) } as RowColumn<TableRow>] : []),
    ...(strip?.hotLabel ? [{ key: 'hot', title: strip.hotLabel, width: 88, align: 'right', card: 'line2', cardLabel: strip.hotLabel, format: (_v, r) => strip.format(r.point.hot ?? 0) } as RowColumn<TableRow>] : []),
  ]
})
</script>

<template>
  <figure class="tc">
    <figcaption class="tc__head">
      <span class="tc__read" aria-live="polite">
        <template v-if="cursorPoint && cursor !== null">
          <slot name="readout" :point="cursorPoint" :index="cursor" :range="cursorRange">
            <b>{{ cursorRange }}</b>
            <span v-for="s in series" :key="s.key"> · {{ s.label }} <b>{{ fmtV(cursorPoint.v[s.key]) }}</b></span>
          </slot>
        </template>
        <template v-else>
          <span v-if="series.length > 1" class="tc__legend">
            <span v-for="s in series" :key="s.key" class="tc__key"><i :class="[`tc__sw--${s.tone ?? 'k1'}`, { 'is-dashed': s.dashed }]" />{{ s.label }}</span>
          </span>
          <span v-if="sparse" class="tc__sparse">{{ filled }} / {{ n }} 个时间段有数据</span>
        </template>
      </span>
      <button type="button" class="ui-link tc__tbl" :aria-pressed="asTable" @click="asTable = !asTable">{{ asTable ? '看图' : '⋯ 以表格查看' }}</button>
    </figcaption>

    <div v-show="!asTable" ref="host" class="tc__plot">
      <svg
        class="ui-viz tc__svg"
        :width="width"
        :height="totalH"
        :viewBox="`0 0 ${width} ${totalH}`"
        role="img"
        :aria-label="`${label}（方向键查看每个时间段）`"
        tabindex="0"
        @pointermove="onMove"
        @pointerleave="cursor = null"
        @keydown="onKey"
        @blur="cursor = null"
      >
        <g :transform="`translate(${PAD_L} ${PAD_T})`">
          <rect v-if="cursor !== null" class="tc__band" :x="xOf(cursor) - plotW / Math.max(1, n) / 2" y="0" :width="plotW / Math.max(1, n)" :height="strip ? stripTop - PAD_T + STRIP_H : plotH" />
          <g v-for="t in yAxis.ticks" :key="t">
            <line class="grid" x1="0" :x2="plotW" :y1="yAxis.y(t) ?? 0" :y2="yAxis.y(t) ?? 0" />
            <text class="axis" x="-8" :y="(yAxis.y(t) ?? 0) + 3" text-anchor="end">{{ format(t) }}</text>
          </g>
          <line class="tc__base" x1="0" :x2="plotW" :y1="plotH" :y2="plotH" />
          <template v-if="reference">
            <line class="limit" x1="0" :x2="plotW" :y1="yAxis.y(reference.value) ?? 0" :y2="yAxis.y(reference.value) ?? 0" />
            <text class="axis" :x="plotW" :y="(yAxis.y(reference.value) ?? 0) - 4" text-anchor="end">{{ reference.label }}</text>
          </template>
          <path v-if="areaD" class="ar ui-area" :d="areaD" />
          <template v-for="s in drawn" :key="s.key">
            <path v-if="s.d" class="ln" :class="[`tc__ln--${s.tone}`, s.dashed ? 'tc__ln--dash ui-area' : 'ui-draw']" :pathLength="s.dashed ? undefined : 1" :d="s.d" />
            <circle v-for="(p, i) in s.dots" :key="i" class="tc__dot" :class="`tc__dot--${s.tone}`" :cx="p[0]" :cy="p[1]" r="2.25" />
            <text v-if="s.end && series.length > 1" class="axis tc__direct" :x="plotW + 6" :y="s.end.y + 3">{{ s.label }}</text>
          </template>
          <g v-for="(p, i) in hotMarks" :key="`h${i}`" class="tc__hot">
            <rect :x="p[0] - 3" :y="p[1] - 3" width="6" height="6" :transform="`rotate(45 ${p[0]} ${p[1]})`" />
          </g>
          <template v-if="cursor !== null">
            <line class="tc__x" :x1="xOf(cursor)" :x2="xOf(cursor)" y1="0" :y2="plotH" />
            <circle v-for="d in cursorDots" :key="d.key" class="tc__cur" :cx="d.x" :cy="d.y" r="3" />
          </template>
          <text v-for="t in xTicks" :key="t.i" class="axis" :x="t.x" :y="plotH + 13" text-anchor="middle">{{ t.text }}</text>
          <!-- now: broken around the tick row so it never strikes through a date -->
          <template v-if="nowX !== null">
            <line class="now" :x1="nowX" :x2="nowX" y1="0" :y2="plotH" />
            <line v-if="strip" class="now" :x1="nowX" :x2="nowX" :y1="stripTop - PAD_T" :y2="stripTop - PAD_T + STRIP_H" />
          </template>

          <g v-if="strip" :transform="`translate(0 ${stripTop - PAD_T})`">
            <line class="tc__base" x1="0" :x2="plotW" :y1="STRIP_H" :y2="STRIP_H" />
            <text class="axis" x="-8" :y="STRIP_H - 6" text-anchor="end">{{ strip.label }}</text>
            <text class="axis" :x="plotW + 6" y="8">{{ peakText }}</text>
            <g v-for="(b, i) in bars" :key="i">
              <rect v-if="b.h" class="tc__bar" :class="{ 'is-cur': cursor === i }" :x="b.x" :y="STRIP_H - b.h" :width="b.w" :height="b.h" />
              <rect v-if="b.hot" class="tc__bar is-hot" :x="b.x" :y="STRIP_H - b.hot" :width="b.w" :height="b.hot" />
            </g>
          </g>
        </g>
      </svg>
    </div>

    <RowTable v-if="asTable" class="tc__table" :columns="tableColumns" :data="tableRows" row-key="t" density="dense" :caption="label" />
  </figure>
</template>

<style scoped>
.tc { margin: 0; min-width: 0; }
.tc__head { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 26px; padding: 4px 0 2px; font-size: var(--fs-xs); color: var(--ink-2); }
.tc__read { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 0; min-width: 0; font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
.tc__read :deep(b) { font-weight: 500; color: var(--ink); }
.tc__legend { display: inline-flex; flex-wrap: wrap; gap: 2px 14px; margin-right: 14px; font-family: var(--font-sans); }
.tc__key { display: inline-flex; align-items: center; gap: 6px; }
.tc__key i { display: inline-block; width: 14px; height: 0; border-top: 1.5px solid var(--k1); }
.tc__key i.tc__sw--k2 { border-top-color: var(--k2); }
.tc__key i.tc__sw--k3 { border-top-color: var(--k3); }
.tc__key i.is-dashed { border-top-style: dashed; }
.tc__sparse { margin-right: 12px; font-family: var(--font-sans); color: var(--ink-3); }
.tc__tbl { flex: none; font-size: var(--fs-xs); }
.tc__plot { min-width: 0; }
.tc__svg { display: block; touch-action: pan-y; }
.tc__svg:focus-visible { outline: 2px solid var(--signal); outline-offset: 2px; }
.tc__base { stroke: var(--rule-2); stroke-width: 1; }
.tc__band { fill: var(--paper-2); }
.ln.tc__ln--k1 { stroke: var(--k1); stroke-width: 1.5; }
.ln.tc__ln--k2 { stroke: var(--k2); stroke-width: 1.25; }
.ln.tc__ln--k3 { stroke: var(--k3); stroke-width: 1.25; }
.ln.tc__ln--dash { stroke-dasharray: 4 3; }
.tc__dot { fill: var(--k1); }
.tc__dot--k2 { fill: var(--k2); }
.tc__dot--k3 { fill: var(--k3); }
.tc__hot rect { fill: var(--signal); }
.tc__x { stroke: var(--ink-2); stroke-width: 1; stroke-dasharray: 2 2; }
.tc__cur { fill: var(--paper); stroke: var(--ink); stroke-width: 1.5; }
.tc__direct { fill: var(--ink-2); }
.tc__bar { fill: var(--ink-4); }
.tc__bar.is-cur { fill: var(--ink-2); }
.tc__bar.is-hot { fill: var(--signal); }
.tc__table { margin-top: 6px; }
</style>
