<script setup lang="ts">
import { computed } from 'vue'
import { fmtDuration, fmtInt } from '../fmt'
import { niceTicks } from './model'
import type { RangeRow } from '../types'

/**
 * Latency range bars (DESIGN.md §5.2 viz/RangeBars, §6.7 性能): one row per upstream / model, a dot at p50
 * and a bar from p50 to p95 on one shared ms axis, with the figures and sample count at the right.
 */
const props = withDefaults(
  defineProps<{
    rows: RangeRow[]
    format?: (ms: number | null) => string
    emptyText?: string
  }>(),
  { format: fmtDuration, emptyText: '— 没有延迟数据' },
)

const max = computed(() => Math.max(1, ...props.rows.map((r) => r.p95 ?? r.p50 ?? 0)))
const ticks = computed(() => niceTicks(0, max.value, 4))
const axisMax = computed(() => Math.max(max.value, ticks.value[ticks.value.length - 1] ?? max.value))
const pos = (v: number | null) => (v === null ? null : Math.max(0, Math.min(100, (v / axisMax.value) * 100)))
</script>

<template>
  <div v-if="rows.length" class="ui-range">
    <div v-for="(r, i) in rows" :key="r.key ?? r.name" class="ui-range__row" data-row :style="{ '--r': i }">
      <span class="ui-range__n ellip" :title="r.name">{{ r.name }}</span>
      <span class="ui-range__track" role="img" :aria-label="`${r.name} p50 ${format(r.p50)}，p95 ${format(r.p95)}`">
        <b v-if="pos(r.p50) !== null && pos(r.p95) !== null" :style="{ left: `${pos(r.p50)}%`, width: `${Math.max(0, (pos(r.p95) ?? 0) - (pos(r.p50) ?? 0))}%` }" />
        <i v-if="pos(r.p50) !== null" :style="{ left: `${pos(r.p50)}%` }" />
      </span>
      <span class="ui-range__v num">{{ format(r.p50) }} <span class="dim">/ {{ format(r.p95) }}</span></span>
      <span class="ui-range__c num">{{ r.n == null ? '' : `n ${fmtInt(r.n)}` }}</span>
    </div>
    <div class="ui-range__axis" aria-hidden="true">
      <span />
      <span class="ui-range__ticks">
        <span v-for="t in ticks" :key="t" :style="{ left: `${(t / axisMax) * 100}%` }">{{ format(t) }}</span>
      </span>
    </div>
  </div>
  <p v-else class="ui-range__empty">{{ emptyText }}</p>
</template>

<style>
.ui-range { display: grid; }
.ui-range__row, .ui-range__axis { display: grid; grid-template-columns: minmax(80px, 28%) minmax(0, 1fr) 128px 64px; align-items: center; gap: 0 12px; }
.ui-range__row { min-height: 34px; border-bottom: 1px solid var(--rule); font-size: var(--fs-sm); }
.ui-range__track { position: relative; height: 12px;
  background: repeating-linear-gradient(90deg, var(--rule) 0 1px, transparent 1px 25%) 0 50% / 100% 1px no-repeat; }
.ui-range__track b { position: absolute; top: 4.5px; height: 3px; background: var(--ink-3); }
.ui-range__track i { position: absolute; top: 3px; width: 6px; height: 6px; margin-left: -3px; border-radius: 50%; background: var(--ink); }
.ui-range__v { text-align: right; white-space: nowrap; }
.ui-range__c { text-align: right; color: var(--ink-3); font-size: var(--fs-xs); }
.ui-range__axis { height: 20px; }
.ui-range__axis > span:first-child { grid-column: 1; }
.ui-range__ticks { position: relative; grid-column: 2; height: 100%; }
.ui-range__ticks span { position: absolute; top: 4px; transform: translateX(-50%); font-family: var(--font-mono); font-size: 10px; color: var(--ink-3); white-space: nowrap; }
.ui-range__ticks span:first-child { transform: none; }
.ui-range__empty { margin: 0; padding: 8px 0; font-size: var(--fs-sm); color: var(--ink-3); }
@media (max-width: 599px) {
  .ui-range__row, .ui-range__axis { grid-template-columns: minmax(0, 1fr) auto; }
  .ui-range__track, .ui-range__ticks { grid-column: 1 / -1; grid-row: 2; margin-bottom: 6px; }
  .ui-range__c { display: none; }
}
</style>
