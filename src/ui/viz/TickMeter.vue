<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, useTemplateRef, watch } from 'vue'
import { TxProgressBar } from '@talex-touch/tuffex/progress-bar'
import { isReducedMotion } from '../../lib/motion'
import { fmtTime } from '../fmt'
import { meterModel, snapMeterWidth } from './model'
import type { Instant } from '../types'

/**
 * Quota meter (DESIGN.md §5.2 viz/TickMeter): a solid 6px TxProgressBar (glow/flow off, styles/tx/progress-bar.css)
 * on a paper-3 track — ink, the whole bar turns signal once it crosses the redline — plus a 1px signal redline
 * tick at the threshold. The decorative 2px-on/2px-off tick mask is gone (calm-down); the name and props stay.
 * Our wrapper carries role="meter" (a quota is a meter, not a progress bar); the TxProgressBar is aria-hidden.
 */
const props = withDefaults(
  defineProps<{
    /** used ratio; may exceed 1 (bar stays full, label shows the real %); null = no data */
    value: number | null | undefined
    /** px, snapped to a multiple of 4 (no moiré at DPR 1); ignored when fluid */
    width?: number
    redline?: number
    /** no limit: dashed outline + 不限 */
    unlimited?: boolean
    /** micro window label in front, e.g. 5H / 7D */
    label?: string
    showPct?: boolean
    /** window reset instant → `↻ 15:10` */
    reset?: Instant
    /** fill the parent's width (still snapped to 4px) */
    fluid?: boolean
    /** hide the redline (compact contexts that already show the threshold) */
    noRedline?: boolean
    /** accessible name, e.g. "5 小时窗口" */
    ariaLabel?: string
  }>(),
  { width: 84, redline: 0.9, unlimited: false, label: undefined, showPct: true, reset: undefined, fluid: false, noRedline: false, ariaLabel: undefined },
)

const bar = useTemplateRef<HTMLElement>('bar')
const measured = ref(0)
const w = computed(() => snapMeterWidth(props.fluid && measured.value ? measured.value : props.width))
const m = computed(() => meterModel(props.unlimited ? null : props.value, w.value, props.redline))
const pctText = computed(() => (props.unlimited ? '不限' : m.value.pct === null ? '—' : `${Math.round(m.value.pct)}%`))
const resetText = computed(() => (props.reset ? fmtTime(props.reset) : ''))
const valueText = computed(() => {
  const name = props.ariaLabel ?? props.label ?? '用量'
  return props.unlimited ? `${name} 不限` : m.value.pct === null ? `${name} 无数据` : `${name} 已用 ${Math.round(m.value.pct)}%`
})

/* grow from 0 on first paint (TxProgressBar animates its width); instant under reduce / capture */
const armed = ref(isReducedMotion())
const fill = computed(() => (props.unlimited || m.value.pct === null ? 0 : armed.value ? Math.min(100, m.value.pct) : 0))
let raf = 0
let ro: ResizeObserver | null = null
onMounted(() => {
  if (!armed.value) raf = requestAnimationFrame(() => (raf = requestAnimationFrame(() => (armed.value = true))))
  if (props.fluid && bar.value?.parentElement && typeof ResizeObserver !== 'undefined') {
    const host = bar.value.parentElement
    ro = new ResizeObserver(() => (measured.value = host.clientWidth))
    ro.observe(host)
  }
})
watch(() => props.fluid, (fluid) => { if (!fluid) measured.value = 0 })
onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
  ro?.disconnect()
})
</script>

<template>
  <span class="ui-tm" :class="{ 'is-fluid': fluid, 'is-over': m.over && !unlimited }">
    <span v-if="label" class="ui-tm__k" aria-hidden="true">{{ label }}</span>
    <span class="ui-tm__track" :class="{ 'no-red': noRedline || unlimited }" :style="{ '--w': `${w}px`, '--red': redline }">
      <span
        ref="bar"
        class="ui-tm__bar"
        :class="{ 'is-unl': unlimited }"
        role="meter"
        aria-valuemin="0"
        aria-valuemax="100"
        :aria-valuenow="m.pct === null ? undefined : Math.round(Math.min(100, m.pct))"
        :aria-valuetext="valueText"
        :aria-label="ariaLabel ?? label"
      >
        <TxProgressBar v-if="!unlimited" :percentage="fill" height="6px" :color="m.over ? 'var(--signal)' : 'var(--ink)'" aria-hidden="true" />
      </span>
    </span>
    <span v-if="showPct" class="ui-tm__pct">{{ pctText }}</span>
    <span v-if="resetText" class="ui-tm__rst">↻ {{ resetText }}</span>
  </span>
</template>

<style>
.ui-tm { display: inline-flex; align-items: center; gap: 6px; min-width: 0; white-space: nowrap; font-family: var(--font-mono); font-size: var(--fs-xs); font-variant-numeric: tabular-nums; color: var(--ink-2); }
.ui-tm.is-fluid { display: flex; width: 100%; }
.ui-tm.is-fluid .ui-tm__track { flex: 1; min-width: 8px; }
.ui-tm__k { font-size: var(--fs-micro); letter-spacing: .08em; color: var(--ink-3); }
.ui-tm__track { position: relative; display: inline-flex; align-items: center; }
.ui-tm__bar { position: relative; display: inline-block; flex: none; width: var(--w); height: 6px; vertical-align: middle; }
html:root .ui-tm__bar .tx-progress-bar-wrapper { display: block; width: 100%; }
html:root .ui-tm__bar .tx-progress-bar { transition: width var(--dur-4) var(--ease-settle); }
/* redline: a 1px tick at the threshold, just taller than the bar */
.ui-tm__track::after {
  content: ""; position: absolute; left: calc(var(--w, 84px) * var(--red, .9) - 1px); top: -2px; bottom: -2px; width: 1px;
  background: var(--signal); opacity: .5; pointer-events: none;
}
.ui-tm__track.no-red::after { display: none; }
.ui-tm__bar.is-unl { outline: 1px dashed var(--rule-2); outline-offset: -1px; }
.ui-tm__pct { min-width: 4ch; text-align: right; color: var(--ink); }
.ui-tm.is-over .ui-tm__pct { color: var(--signal-ink); }
.ui-tm__rst { color: var(--ink-3); }
</style>
