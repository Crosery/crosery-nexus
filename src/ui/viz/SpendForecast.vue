<script setup lang="ts">
import { computed, useTemplateRef } from 'vue'
import { fmtUsd } from '../fmt'
import { useElementWidth } from '../composables/useElementWidth'
import './viz.css'

/**
 * Today's spend forecast (DESIGN.md §5.2 viz/SpendForecast, /me §02): cumulative spend line up to now,
 * a tonal projection to 24:00, the dashed daily-limit line, a signal crosshair at now, and the hourly
 * bars underneath on the same x. The sentence under it turns signal-ink when the projection beats the limit.
 */
const props = withDefaults(
  defineProps<{
    /** spend per hour of the day (index 0 = 00:00–01:00); hours after now are ignored */
    hourly: Array<number | null | undefined>
    /** daily limit; null = none */
    limit?: number | null
    /** hours elapsed today, e.g. 14.5 at 14:30 (Asia/Shanghai) */
    now: number
    /** projected total at 24:00 */
    projected?: number | null
    h?: number
    format?: (value: number) => string
  }>(),
  { limit: null, projected: null, h: 120, format: (v: number) => fmtUsd(v) },
)

const host = useTemplateRef<HTMLElement>('host')
const width = useElementWidth(host, 320)
const BARS_H = 22
const GAP = 6
const lineH = computed(() => props.h - BARS_H - GAP)
const nowH = computed(() => Math.max(0, Math.min(24, props.now)))
const x = (hour: number) => (hour / 24) * width.value

const cumulative = computed(() => {
  const out: Array<[number, number]> = [[0, 0]]
  let sum = 0
  const full = Math.floor(nowH.value)
  for (let i = 0; i < full; i += 1) {
    sum += props.hourly[i] ?? 0
    out.push([i + 1, sum])
  }
  if (nowH.value > full) {
    sum += (props.hourly[full] ?? 0)
    out.push([nowH.value, sum])
  }
  return { points: out, total: sum }
})
const yMax = computed(() => Math.max(1e-9, cumulative.value.total, props.projected ?? 0, props.limit ?? 0) * 1.08)
const y = (v: number) => lineH.value - (v / yMax.value) * (lineH.value - 2)
const path = computed(() => cumulative.value.points.map(([hh, v], i) => `${i ? 'L' : 'M'}${x(hh).toFixed(1)} ${y(v).toFixed(1)}`).join(''))
const proj = computed(() => {
  if (props.projected == null || nowH.value >= 24) return null
  const x0 = x(nowH.value)
  const y0 = y(cumulative.value.total)
  const x1 = width.value
  const y1 = y(props.projected)
  return { line: `M${x0.toFixed(1)} ${y0.toFixed(1)}L${x1.toFixed(1)} ${y1.toFixed(1)}`, area: `M${x0.toFixed(1)} ${lineH.value}L${x0.toFixed(1)} ${y0.toFixed(1)}L${x1.toFixed(1)} ${y1.toFixed(1)}L${x1.toFixed(1)} ${lineH.value}Z` }
})
const bars = computed(() => {
  const max = Math.max(1e-9, ...props.hourly.slice(0, Math.ceil(nowH.value)).map((v) => v ?? 0))
  const bw = width.value / 24
  return Array.from({ length: 24 }, (_, i) => {
    const v = i < nowH.value ? props.hourly[i] ?? 0 : null
    const hh = v === null ? 0 : v > 0 ? Math.max(1.5, (v / max) * BARS_H) : 1
    return { x: i * bw + 0.5, w: Math.max(1, bw - 1.5), h: hh, future: v === null }
  })
})
const over = computed(() => props.limit != null && props.projected != null && props.projected > props.limit)
const summary = computed(() => {
  const parts = [`今日已花 ${props.format(cumulative.value.total)}`]
  if (props.projected != null) parts.push(`按当前速度约 ${props.format(props.projected)}`)
  if (props.limit != null) parts.push(`日额度 ${props.format(props.limit)}`)
  return parts.join('，')
})
</script>

<template>
  <figure class="ui-forecast">
    <div ref="host" class="ui-forecast__plot">
      <svg class="ui-viz" :width="width" :height="h" :viewBox="`0 0 ${width} ${h}`" role="img" :aria-label="summary">
        <line class="base" x1="0" :x2="width" :y1="lineH - 0.5" :y2="lineH - 0.5" />
        <template v-if="limit != null">
          <line class="limit" x1="0" :x2="width" :y1="y(limit)" :y2="y(limit)" />
          <text class="axis" x="2" :y="y(limit) - 4">日额度 {{ format(limit) }}</text>
        </template>
        <path v-if="proj" class="ar ui-area" :d="proj.area" />
        <path v-if="proj" class="proj" :d="proj.line" />
        <path class="ln ui-draw" pathLength="1" :d="path" />
        <line class="now" :x1="x(nowH)" :x2="x(nowH)" y1="0" :y2="h" />
        <g :transform="`translate(0 ${lineH + GAP})`" class="ui-forecast__bars">
          <rect v-for="(b, i) in bars" :key="i" :x="b.x" :y="BARS_H - b.h" :width="b.w" :height="b.h" :class="{ 'is-future': b.future }" />
        </g>
      </svg>
    </div>
    <figcaption v-if="projected != null" class="ui-forecast__cap" :class="{ 'is-over': over }">
      按当前速度 ≈ {{ format(projected) }}<template v-if="over"> · <slot name="over">将超过日额度</slot></template>
    </figcaption>
  </figure>
</template>

<style>
.ui-forecast { margin: 0; min-width: 0; }
.ui-forecast__plot { min-width: 0; }
.ui-forecast__bars rect { fill: var(--ink-4); }
.ui-forecast__bars rect.is-future { fill: var(--rule); }
.ui-forecast__cap { margin-top: 6px; font-size: var(--fs-xs); color: var(--ink-2); }
.ui-forecast__cap.is-over { color: var(--signal-ink); }
</style>
