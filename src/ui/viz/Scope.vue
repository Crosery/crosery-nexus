<script setup lang="ts">
import { computed, ref, useTemplateRef } from 'vue'
import { fmtDuration, fmtInt } from '../fmt'
import { useElementWidth } from '../composables/useElementWidth'
import { areaPath, extentOf, linePath, niceAxis } from './model'
import './viz.css'

/**
 * Gateway scope (DESIGN.md §5.2 viz/Scope, §6.2): requests/min trace with a tonal area on a light grid,
 * a rug of signal error ticks along the bottom, the now-line at the right edge, and — instead of a second
 * axis — a separate 32px P95 strip underneath. Hover or arrow keys put a cursor on both; the readout is
 * docked in the head row so it never covers the trace.
 */
const props = withDefaults(
  defineProps<{
    rpm: Array<number | null | undefined>
    /** p95 latency in ms per sample */
    p95?: Array<number | null | undefined> | null
    /** errors per sample */
    err?: Array<number | null | undefined> | null
    /** label of the oldest sample, e.g. "−60m" */
    fromLabel?: string
    /** step label for the readout, e.g. "m" → "−12m" */
    unit?: string
    h?: number
    stale?: boolean
    label?: string
  }>(),
  { p95: null, err: null, fromLabel: '−60m', unit: 'm', h: 150, stale: false, label: '网关每分钟请求、错误与 P95 延迟' },
)

const host = useTemplateRef<HTMLElement>('host')
const width = useElementWidth(host, 640)
const TOP = 6
const RUG = 14
const STRIP = 32
const traceH = computed(() => props.h - RUG - TOP)
const n = computed(() => props.rpm.length)
const axis = computed(() => niceAxis(0, extentOf(props.rpm).max, 4))
const box = computed(() => ({ w: width.value, h: traceH.value, pad: 0, extent: { min: 0, max: axis.value.max } }))
const trace = computed(() => linePath(props.rpm, box.value))
const area = computed(() => areaPath(props.rpm, box.value))
const xAt = (i: number) => (n.value <= 1 ? width.value : (i / (n.value - 1)) * width.value)
const errs = computed(() =>
  (props.err ?? []).map((e, i) => ({ i, e: e ?? 0 })).filter((x) => x.e > 0).map(({ i, e }) => ({ x: xAt(i) - 1.5, h: Math.min(RUG - 2, 3 + e * 1.5) })),
)
const latBox = computed(() => ({ w: width.value, h: STRIP - 6, pad: 2, extent: extentOf(props.p95 ?? [], true) }))
const lat = computed(() => (props.p95 ? linePath(props.p95, latBox.value) : ''))
const lastLat = computed(() => {
  const list = props.p95 ?? []
  for (let i = list.length - 1; i >= 0; i -= 1) if (typeof list[i] === 'number') return list[i] as number
  return null
})

const cursor = ref<number | null>(null)
function onMove(event: PointerEvent) {
  const rect = (event.currentTarget as Element).getBoundingClientRect()
  if (!n.value) return
  cursor.value = Math.max(0, Math.min(n.value - 1, Math.round(((event.clientX - rect.left) / rect.width) * (n.value - 1))))
}
function onKey(event: KeyboardEvent) {
  if (!n.value) return
  const at = cursor.value ?? n.value - 1
  const map: Record<string, number> = { ArrowLeft: at - 1, ArrowRight: at + 1, Home: 0, End: n.value - 1 }
  if (event.key === 'Escape') cursor.value = null
  else if (event.key in map) {
    event.preventDefault()
    cursor.value = Math.max(0, Math.min(n.value - 1, map[event.key]))
  }
}
const readout = computed(() => {
  if (cursor.value === null) return null
  const i = cursor.value
  const ago = n.value - 1 - i
  return {
    at: ago === 0 ? '现在' : `−${ago}${props.unit}`,
    rpm: fmtInt(props.rpm[i] ?? null),
    p95: props.p95 ? fmtDuration(props.p95[i] ?? null) : null,
    err: props.err ? fmtInt(props.err[i] ?? 0) : null,
  }
})
</script>

<template>
  <figure class="ui-scope" :class="{ 'is-stale': stale }">
    <figcaption class="ui-scope__head">
      <span class="ui-scope__key"><i class="k-rpm" />rpm <i class="k-err" />错误</span>
      <span class="ui-scope__read" aria-live="polite">
        <template v-if="readout"><b>{{ readout.at }}</b> {{ readout.rpm }} rpm<template v-if="readout.p95"> · p95 {{ readout.p95 }}</template><template v-if="readout.err !== null"> · err {{ readout.err }}</template></template>
      </span>
    </figcaption>
    <div ref="host" class="ui-scope__plot" tabindex="0" role="img" :aria-label="label" @pointermove="onMove" @pointerleave="cursor = null" @keydown="onKey" @blur="cursor = null">
      <svg class="ui-viz" :width="width" :height="h" :viewBox="`0 0 ${width} ${h}`" aria-hidden="true">
        <g :transform="`translate(0 ${TOP})`">
          <line v-for="k in 3" :key="`v${k}`" class="grid" :x1="(width * k) / 4" :x2="(width * k) / 4" y1="0" :y2="traceH" />
          <line class="grid" x1="0" :x2="width" :y1="traceH / 2" :y2="traceH / 2" />
          <line class="ui-scope__base" x1="0" :x2="width" :y1="traceH - 0.5" :y2="traceH - 0.5" />
          <path v-if="area" class="ar ui-area" :d="area" style="--d: 120ms" />
          <path v-if="trace" class="ln ui-scope__trace" :class="{ 'ui-draw': !stale }" :pathLength="stale ? undefined : 1" :d="trace" style="--d: 120ms" />
          <text class="axis" :x="4" y="11">{{ fmtInt(axis.max) }}</text>
        </g>
        <line class="ui-scope__rug" x1="0" :x2="width" :y1="h - 1.5" :y2="h - 1.5" />
        <rect v-for="(e, i) in errs" :key="i" class="ui-scope__er" :x="e.x" :y="h - 2 - e.h" width="3" :height="e.h" />
        <line class="now" :x1="width - 0.5" :x2="width - 0.5" :y1="TOP" :y2="h" />
        <line v-if="cursor !== null" class="ui-scope__x" :x1="xAt(cursor)" :x2="xAt(cursor)" :y1="TOP" :y2="h" />
      </svg>
      <svg v-if="p95" class="ui-viz ui-scope__strip" :width="width" :height="STRIP" :viewBox="`0 0 ${width} ${STRIP}`" aria-hidden="true">
        <line class="grid" x1="0" :x2="width" y1="0.5" y2="0.5" />
        <g transform="translate(0 4)"><path v-if="lat" class="ln dim ui-draw" pathLength="1" :d="lat" style="--d: 260ms" /></g>
        <text class="axis" x="4" y="13">P95</text>
        <text class="axis" :x="width - 4" y="13" text-anchor="end">{{ fmtDuration(lastLat) }}</text>
        <line v-if="cursor !== null" class="ui-scope__x" :x1="xAt(cursor)" :x2="xAt(cursor)" y1="0" :y2="STRIP" />
      </svg>
    </div>
    <div class="ui-scope__x-axis" aria-hidden="true"><span>{{ fromLabel }}</span><span>现在</span></div>
  </figure>
</template>

<style>
.ui-scope { margin: 0; min-width: 0; }
.ui-scope__head { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 20px; font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--ink-3); }
.ui-scope__key i { display: inline-block; width: 12px; height: 0; margin: 0 5px 0 0; vertical-align: middle; }
.ui-scope__key i + * { margin-right: 10px; }
.ui-scope__key .k-rpm { border-top: 1.5px solid var(--ink); }
.ui-scope__key .k-err { width: 3px; height: 8px; background: var(--signal); margin-left: 10px; }
.ui-scope__read { color: var(--ink-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ui-scope__read b { color: var(--ink); font-weight: 500; }
.ui-scope__plot { display: grid; gap: 4px; min-width: 0; outline-offset: 2px; }
.ui-scope__base { stroke: var(--rule-2); stroke-width: 1; }
.ui-scope .grid { stroke-dasharray: 1 3; }
.ui-scope__trace { stroke-width: 1.6; }
.ui-scope__rug { stroke: var(--rule-2); stroke-width: 1; }
.ui-scope__er { fill: var(--signal); }
.ui-scope__x { stroke: var(--ink-2); stroke-width: 1; stroke-dasharray: 2 2; }
.ui-scope.is-stale .ui-scope__trace { stroke: var(--ink-3); stroke-dasharray: 3 3; }
.ui-scope__x-axis { display: flex; justify-content: space-between; margin-top: 4px; font-family: var(--font-mono); font-size: 10px; color: var(--ink-3); }
</style>
