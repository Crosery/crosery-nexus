<script setup lang="ts">
import { computed } from 'vue'
import { TxFilterChips } from '@talex-touch/tuffex/filter-chips'
import { useSkinPref } from '../../lib/skin'
import type { HeatYear } from './heatModel'

/** GitHub's year list as one row of quiet text links: 最近一年 · 2026 · 2025 … (years with data, within retention). */
const props = defineProps<{ years: number[] }>()
const year = defineModel<HeatYear>({ default: 'recent' })
const { pref: skin } = useSkinPref()
const minimal = computed(() => skin.value === 'minimal')
const items = computed(() => [{ value: 'recent', label: '最近一年' }, ...props.years.map((value) => ({ value, label: String(value) }))])
</script>

<template>
  <TxFilterChips v-if="minimal" v-model="year" :items="items" aria-label="时间范围" role="tablist" />
  <nav v-else class="ui-hyears" aria-label="时间范围">
    <button type="button" :aria-pressed="year === 'recent'" @click="year = 'recent'">最近一年</button>
    <button v-for="y in years" :key="y" type="button" class="num" :aria-pressed="year === y" @click="year = y">{{ y }}</button>
  </nav>
</template>

<style>
.ui-hyears { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 0 2px; }
.ui-hyears button {
  all: unset; box-sizing: border-box; padding: 2px 6px; border-radius: var(--r-1); cursor: pointer;
  font-size: var(--fs-xs); color: var(--ink-3); white-space: nowrap;
}
.ui-hyears button.num { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
.ui-hyears button:hover { color: var(--ink); background: var(--paper-2); }
.ui-hyears button[aria-pressed="true"] { color: var(--ink); font-weight: 600; }
.ui-hyears button:focus-visible { outline: 2px solid var(--signal); outline-offset: 1px; }
@media (pointer: coarse) { .ui-hyears button { padding: 8px 8px; } }
</style>
