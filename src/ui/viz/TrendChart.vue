<script setup lang="ts">
import { computed, ref, useTemplateRef } from 'vue'
import { fmtCompact, fmtTime } from '../fmt'
import { useElementWidth } from '../composables/useElementWidth'
import { areaPath, linePath, niceAxis, points as plotPoints } from './model'
import type { TrendPoint } from '../types'
import './viz.css'

/**
 * Single-series trend with axes (DESIGN.md §2.3: one series in k1, one y-axis per plot; a second measure gets
 * its own TrendChart, never a second axis). Hover / arrow keys move a cursor whose readout is docked in the
 * head row, so it never covers data. `⋯ 以表格查看` swaps the plot for a table.
 */
const props = withDefaults(
  defineProps<{
    points: TrendPoint[]
    /** accessible name, e.g. "近 30 天缓存命中率" */
    label: string
    h?: number
    format?: (value: number | null) => string
    /** x label for a point (default: time of day / date for instants) */
    xFormat?: (point: TrendPoint) => string
    area?: boolean
    /** status colour (error-rate trends) */
    hot?: boolean
    zero?: boolean
    /** dashed reference line, e.g. { value: 50, label: '日额度' } */
    reference?: { value: number; label: string } | null
    /** draw-on delay */
    delay?: number
  }>(),
  { h: 160, format: fmtCompact, xFormat: undefined, area: true, hot: false, zero: true, reference: null, delay: 200 },
)

const host = useTemplateRef<HTMLElement>('host')
const width = useElementWidth(host, 600)
const PAD_L = 44
const PAD_B = 18
const PAD_T = 6
const plotW = computed(() => Math.max(40, width.value - PAD_L - 4))
const plotH = computed(() => Math.max(24, props.h - PAD_B - PAD_T))
const values = computed(() => props.points.map((p) => p.v))
const axis = computed(() => {
  const nums = values.value.filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
  if (props.reference) nums.push(props.reference.value)
  const lo = props.zero ? Math.min(0, ...nums) : Math.min(...nums)
  return niceAxis(nums.length ? lo : 0, nums.length ? Math.max(...nums) : 1, 4)
})
const box = computed(() => ({ w: plotW.value, h: plotH.value, pad: 0, extent: { min: axis.value.min, max: axis.value.max } }))
const y = (v: number) => plotH.value - ((v - axis.value.min) / (axis.value.max - axis.value.min || 1)) * plotH.value
const line = computed(() => linePath(values.value, box.value))
const fill = computed(() => (props.area ? areaPath(values.value, box.value) : ''))
const pts = computed(() => plotPoints(values.value, box.value))
const xLabel = (p: TrendPoint) => p.label ?? (props.xFormat ? props.xFormat(p) : typeof p.t === 'string' && !/^\d{4}-/.test(p.t) ? p.t : fmtTime(p.t))
const xTicks = computed(() => {
  const n = props.points.length
  if (!n) return []
  const count = Math.max(2, Math.min(6, Math.floor(plotW.value / 110)))
  const idx = new Set<number>()
  for (let k = 0; k < count; k += 1) idx.add(Math.round((k / (count - 1)) * (n - 1)))
  return [...idx].map((i) => ({ i, x: n <= 1 ? plotW.value : (i / (n - 1)) * plotW.value, text: xLabel(props.points[i]) }))
})

const cursor = ref<number | null>(null)
const cursorPoint = computed(() => (cursor.value === null ? null : props.points[cursor.value] ?? null))
const cursorXY = computed(() => (cursor.value === null ? null : pts.value[cursor.value] ?? null))
function onMove(event: PointerEvent) {
  const svg = event.currentTarget as SVGElement
  const rect = svg.getBoundingClientRect()
  const fx = (event.clientX - rect.left - PAD_L) / plotW.value
  const n = props.points.length
  if (!n) return
  cursor.value = Math.max(0, Math.min(n - 1, Math.round(fx * (n - 1))))
}
function onKey(event: KeyboardEvent) {
  const n = props.points.length
  if (!n) return
  const at = cursor.value ?? n - 1
  const next = event.key === 'ArrowLeft' ? at - 1 : event.key === 'ArrowRight' ? at + 1 : event.key === 'Home' ? 0 : event.key === 'End' ? n - 1 : null
  if (event.key === 'Escape') {
    cursor.value = null
    return
  }
  if (next === null) return
  event.preventDefault()
  cursor.value = Math.max(0, Math.min(n - 1, next))
}

const asTable = ref(false)
</script>

<template>
  <figure class="ui-trend" :class="{ hot }">
    <figcaption class="ui-trend__head">
      <span class="ui-trend__read" aria-live="polite">
        <template v-if="cursorPoint">
          <b>{{ xLabel(cursorPoint) }}</b> {{ format(cursorPoint.v) }}
        </template>
      </span>
      <button type="button" class="ui-link ui-trend__tbl" :aria-pressed="asTable" @click="asTable = !asTable">
        {{ asTable ? '看图' : '⋯ 以表格查看' }}
      </button>
    </figcaption>
    <div v-show="!asTable" ref="host" class="ui-trend__plot">
      <svg
        class="ui-viz"
        :class="{ hot }"
        :width="width"
        :height="h"
        :viewBox="`0 0 ${width} ${h}`"
        role="img"
        :aria-label="label"
        tabindex="0"
        :style="{ '--d': `${delay}ms` }"
        @pointermove="onMove"
        @pointerleave="cursor = null"
        @keydown="onKey"
        @blur="cursor = null"
      >
        <g :transform="`translate(${PAD_L} ${PAD_T})`">
          <g v-for="t in axis.ticks" :key="t">
            <line class="grid" x1="0" :x2="plotW" :y1="y(t)" :y2="y(t)" />
            <text class="axis" :x="-8" :y="y(t) + 3" text-anchor="end">{{ format(t) }}</text>
          </g>
          <line v-if="reference" class="limit" x1="0" :x2="plotW" :y1="y(reference.value)" :y2="y(reference.value)" />
          <text v-if="reference" class="axis" :x="plotW" :y="y(reference.value) - 4" text-anchor="end">{{ reference.label }} {{ format(reference.value) }}</text>
          <path v-if="fill" class="ar ui-area" :d="fill" />
          <path v-if="line" class="ln ui-draw" pathLength="1" :d="line" />
          <line v-if="cursorXY" class="ui-trend__x" :x1="cursorXY[0]" :x2="cursorXY[0]" y1="0" :y2="plotH" />
          <circle v-if="cursorXY" class="end" :cx="cursorXY[0]" :cy="cursorXY[1]" r="2.5" />
          <text v-for="t in xTicks" :key="t.i" class="axis" :x="t.x" :y="plotH + 14" :text-anchor="t.i === 0 ? 'start' : t.i === points.length - 1 ? 'end' : 'middle'">{{ t.text }}</text>
        </g>
      </svg>
    </div>
    <table v-if="asTable" class="ui-viz-table">
      <caption class="sr-only">{{ label }}</caption>
      <thead><tr><th scope="col">时间</th><th scope="col" class="num">值</th></tr></thead>
      <tbody>
        <tr v-for="(p, i) in points" :key="i"><td>{{ xLabel(p) }}</td><td class="num">{{ format(p.v) }}</td></tr>
      </tbody>
    </table>
  </figure>
</template>

<style>
.ui-trend { margin: 0; min-width: 0; }
.ui-trend__head { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 20px; font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--ink-2); }
.ui-trend__read b { font-weight: 500; color: var(--ink); }
.ui-trend__tbl { font-family: var(--font-sans); font-size: var(--fs-xs); }
.ui-trend__plot { min-width: 0; }
.ui-trend__plot svg { outline-offset: 2px; }
.ui-trend__x { stroke: var(--ink-2); stroke-width: 1; stroke-dasharray: 2 2; }
</style>
