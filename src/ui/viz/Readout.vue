<script setup lang="ts">
import { computed } from 'vue'
import { fmtDelta, NONE } from '../fmt'
import RollNumber from './RollNumber.vue'
import type { DataState, ReadoutDelta } from '../types'

/**
 * Metric readout (DESIGN.md §5.2 viz/Readout — "Metric"): the Chinese label (`en` is accepted, not rendered),
 * a 26px tabular value that rolls, an optional unit, a delta line and a 70×30 seven-day history (6 days ink-4,
 * today ink, projected today as a quiet tonal block behind it, dashed 7-day mean). No tile chrome: it sits on the plate's paper.
 * Delta is ink-3; it turns signal-ink only when the change is bad AND past its threshold.
 */
const props = withDefaults(
  defineProps<{
    label: string
    en?: string
    value: string | number | null | undefined
    format?: (value: string | number) => string
    unit?: string
    delta?: ReadoutDelta | null
    /** last 7 days, oldest first; the last entry is today (so far) */
    history?: Array<number | null> | null
    /** projected total for today (a quiet tonal block behind today's bar) */
    projected?: number | null
    size?: 'sm' | 'md' | 'hero'
    roll?: boolean
    live?: boolean
    state?: DataState
  }>(),
  {
    en: undefined, format: undefined, unit: undefined, delta: null, history: null, projected: null,
    size: 'md', roll: true, live: false, state: 'ready',
  },
)

const display = computed(() => {
  if (props.value === null || props.value === undefined || props.value === '') return NONE
  return props.format ? props.format(props.value) : String(props.value)
})
const deltaText = computed(() => (props.delta ? fmtDelta(props.delta.value, props.delta.unit ?? 'pct') : ''))
const deltaBad = computed(() => {
  const d = props.delta
  if (!d || !d.bad || d.value === null || d.value === undefined) return false
  return Math.abs(d.value) >= (d.threshold ?? 0) && d.value !== 0
})

/* history bars: 70×30, 7 slots of 8px with 2px gaps; projected outline + dashed mean */
const H = 30
const bars = computed(() => {
  const values = (props.history ?? []).slice(-7)
  if (!values.length) return null
  const nums = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
  const proj = typeof props.projected === 'number' && Number.isFinite(props.projected) ? props.projected : null
  const max = Math.max(1e-9, ...nums, proj ?? 0)
  const mean = nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null
  const offset = 7 - values.length
  const y = (v: number) => H - Math.max(1, (v / max) * (H - 2))
  return {
    items: values.map((v, i) => ({
      x: (offset + i) * 10,
      y: v == null ? H - 1 : y(v),
      h: v == null ? 1 : H - y(v),
      today: i === values.length - 1,
      none: v == null,
    })),
    proj: proj !== null ? { x: 60, y: y(proj), h: H - y(proj) } : null,
    meanY: mean !== null ? y(mean) : null,
  }
})
</script>

<template>
  <div class="ui-ro" :class="[`ui-ro--${size}`, { 'is-stale': state === 'stale' }]">
    <div class="ui-ro__k">
      <span>{{ label }}</span>
      <slot name="label-extra" />
    </div>
    <div class="ui-ro__row">
      <span v-if="state === 'loading'" class="ui-ro__skel ui-skel" aria-hidden="true"><i /></span>
      <span v-else class="ui-ro__v">
        <RollNumber v-if="roll" :value="display" :live="live" /><template v-else>{{ display }}</template><span v-if="unit && display !== NONE" class="ui-ro__u">{{ unit }}</span>
      </span>
      <svg v-if="bars && state !== 'loading'" class="ui-ro__hist" width="70" height="30" viewBox="0 0 70 30" aria-hidden="true">
        <rect v-if="bars.proj" class="ui-ro__proj" :x="bars.proj.x" :y="bars.proj.y" width="8" :height="bars.proj.h" />
        <rect v-for="(b, i) in bars.items" :key="i" :x="b.x" :y="b.y" width="8" :height="b.h" :class="{ 'is-today': b.today, 'is-none': b.none }" />
        <line v-if="bars.meanY !== null" class="ui-ro__mean" x1="0" x2="70" :y1="bars.meanY" :y2="bars.meanY" />
      </svg>
    </div>
    <div v-if="delta || $slots.sub" class="ui-ro__d">
      <span v-if="delta" :class="{ 'is-bad': deltaBad }">{{ deltaText }}</span><span v-if="delta?.label" class="ui-ro__dl"> {{ delta.label }}</span>
      <slot name="sub" />
    </div>
  </div>
</template>

<style>
.ui-ro { display: grid; gap: 4px; min-width: 0; }
.ui-ro__k { display: flex; align-items: baseline; gap: 6px; min-width: 0; font-size: var(--fs-xs); color: var(--ink-2); white-space: nowrap; }
.ui-ro__row { display: flex; align-items: flex-end; justify-content: space-between; gap: 10px; min-width: 0; }
.ui-ro__v { font-family: var(--font-mono); font-variant-numeric: tabular-nums; font-size: var(--fs-xl); font-weight: 500; line-height: 1.05; letter-spacing: -.01em; color: var(--ink); white-space: nowrap; min-width: 0; }
.ui-ro--sm .ui-ro__v { font-size: var(--fs-md); }
.ui-ro--hero .ui-ro__v { font-size: var(--fs-3xl); letter-spacing: -.02em; }
.ui-ro__u { margin-left: 3px; font-size: .5em; color: var(--ink-3); letter-spacing: 0; }
.ui-ro.is-stale .ui-ro__v { color: var(--ink-2); }
.ui-ro__skel { width: 96px; height: 26px; display: block; }
.ui-ro__skel i { height: 18px; margin-top: 4px; }
.ui-ro__hist { flex: none; overflow: visible; }
.ui-ro__hist rect { fill: var(--ink-4); }
.ui-ro__hist rect.is-today { fill: var(--ink); }
.ui-ro__hist rect.is-none { fill: var(--rule-2); }
.ui-ro__hist rect.ui-ro__proj { fill: var(--paper-3); }
.ui-ro__mean { stroke: var(--ink-2); stroke-width: 1; stroke-dasharray: 2 2; }
.ui-ro__d { font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--ink-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ui-ro__d .is-bad { color: var(--signal-ink); }
.ui-ro__dl { font-family: var(--font-sans); }
</style>
