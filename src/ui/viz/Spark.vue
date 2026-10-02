<script setup lang="ts">
import { computed } from 'vue'
import { areaPath, extentOf, linePath, points } from './model'
import './viz.css'

/**
 * Sparkline / trace (DESIGN.md §5.2 viz/Spark, motion recipe 5): path with pathLength=1 drawn on over
 * 900ms settle, the area fades in 300ms later, the end dot pops at the finish. Null samples are gaps.
 * Inline SVG instead of TxSparkChart: same encoding, no chart stylesheet in the route chunk.
 */
const props = withDefaults(
  defineProps<{
    values: Array<number | null | undefined>
    w?: number
    h?: number
    area?: boolean
    end?: boolean
    /** dotted baseline at y = 0 */
    base?: boolean
    /** status colour: failures / over limit only */
    hot?: boolean
    /** stretch to the container width (no end dot: it would distort) */
    fluid?: boolean
    /** include 0 in the y extent (default); false zooms on the range */
    zero?: boolean
    /** draw-on delay in ms (match the row's print-in) */
    delay?: number
    /** accessible summary; without it the chart is decorative */
    label?: string
  }>(),
  { w: 72, h: 18, area: false, end: true, base: false, hot: false, fluid: false, zero: true, delay: 200, label: undefined },
)

const box = computed(() => {
  const extent = extentOf(props.values, props.zero)
  if (!props.zero) {
    const pad = (extent.max - extent.min) * 0.15
    extent.min -= pad
  }
  return { w: props.w, h: props.h, pad: 1, extent }
})
const line = computed(() => linePath(props.values, box.value))
const fill = computed(() => (props.area ? areaPath(props.values, box.value) : ''))
const last = computed(() => {
  const pts = points(props.values, box.value)
  for (let i = pts.length - 1; i >= 0; i -= 1) if (pts[i]) return pts[i]
  return null
})
</script>

<template>
  <svg
    class="ui-viz ui-spark"
    :class="{ hot }"
    :width="fluid ? '100%' : w"
    :height="h"
    :viewBox="`0 0 ${w} ${h}`"
    :preserveAspectRatio="fluid ? 'none' : undefined"
    :style="{ '--d': `${delay}ms` }"
    :role="label ? 'img' : undefined"
    :aria-label="label"
    :aria-hidden="label ? undefined : 'true'"
  >
    <line v-if="base" class="base" x1="0" :x2="w" :y1="h - 0.5" :y2="h - 0.5" />
    <path v-if="area && fill" class="ar ui-area" :d="fill" />
    <path v-if="line" class="ln ui-draw" pathLength="1" :d="line" />
    <circle v-if="end && !fluid && last" class="end ui-end" :cx="last[0]" :cy="last[1]" r="1.8" />
  </svg>
</template>
