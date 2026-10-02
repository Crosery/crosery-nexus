<script setup lang="ts">
import { computed } from 'vue'

/**
 * Micro-bars (DESIGN.md §5.2 viz/MicroBars): one bar per bucket (48 × 30 min by default), ink-3 bars,
 * buckets with errors in signal; empty buckets keep a 1px rule-2 floor so the time axis stays legible.
 */
const props = withDefaults(
  defineProps<{
    buckets: Array<number | null | undefined>
    /** error count per bucket; any > 0 paints that bucket signal */
    errors?: Array<number | null | undefined> | null
    w?: number
    h?: number
    /** bucket gap in px */
    gap?: number
    label?: string
  }>(),
  { errors: null, w: 96, h: 30, gap: 1, label: undefined },
)

const bars = computed(() => {
  const n = props.buckets.length
  if (!n) return []
  const max = Math.max(1e-9, ...props.buckets.map((v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)))
  const bw = Math.max(0.5, (props.w - props.gap * (n - 1)) / n)
  return props.buckets.map((v, i) => {
    const value = typeof v === 'number' && Number.isFinite(v) ? v : 0
    const h = value > 0 ? Math.max(1.5, (value / max) * props.h) : 1
    return { x: i * (bw + props.gap), w: bw, y: props.h - h, h, bad: (props.errors?.[i] ?? 0) > 0, none: value <= 0 }
  })
})
</script>

<template>
  <svg
    class="ui-mbars"
    :width="w"
    :height="h"
    :viewBox="`0 0 ${w} ${h}`"
    :role="label ? 'img' : undefined"
    :aria-label="label"
    :aria-hidden="label ? undefined : 'true'"
  >
    <line class="ui-mbars__base" x1="0" :x2="w" :y1="h - 0.5" :y2="h - 0.5" />
    <template v-for="(b, i) in bars" :key="i">
      <rect v-if="!b.none" :x="b.x" :y="b.y" :width="b.w" :height="b.h" :class="{ 'is-bad': b.bad }" />
    </template>
  </svg>
</template>

<style>
.ui-mbars { display: block; flex: none; }
.ui-mbars rect { fill: var(--ink-3); }
.ui-mbars__base { stroke: var(--rule); stroke-width: 1; }
.ui-mbars rect.is-bad { fill: var(--signal); }
</style>
