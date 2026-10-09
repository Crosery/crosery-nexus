<script setup lang="ts">
import { computed } from 'vue'
import TickMeter from '../../ui/viz/TickMeter.vue'
import { fmtReset, HOT_RATIO, type WindowView } from './model'

/**
 * One quota window inline: `5H ▮▮▮▮▮▯▯ 88% ↻ 15:10`. The meter always draws USED (one redline language
 * everywhere); 已用 | 剩余 only switches the figure.
 */
const props = withDefaults(defineProps<{ win: WindowView; mode: 'used' | 'left'; width?: number; now: number; full?: boolean }>(), {
  width: 56,
  full: false,
})
const hot = computed(() => props.win.used >= HOT_RATIO)
const figure = computed(() => {
  const pct = Math.round(props.win.used * 100)
  return props.mode === 'left' ? `剩 ${Math.max(0, 100 - pct)}%` : `${pct}%`
})
const reset = computed(() => (props.win.resetsAt ? fmtReset(props.win.resetsAt, props.now) : ''))
</script>

<template>
  <span class="acc-q" :class="{ 'is-hot': hot }">
    <TickMeter :value="win.used" :label="win.short" :width="width" :show-pct="false" :aria-label="win.label" />
    <b class="acc-q__pct num">{{ figure }}</b>
    <span v-if="reset" class="acc-q__rst num" :title="`${win.label} 重置时间`">↻ {{ reset }}</span>
    <span v-if="full" class="acc-q__lbl">{{ win.label }}</span>
  </span>
</template>

<style>
.acc-q { display: inline-flex; align-items: center; gap: 5px; min-width: 0; white-space: nowrap; font-size: var(--fs-xs); }
.acc-q .ui-tm__k { min-width: 4ch; }
.acc-q > .ui-tm, .acc-q__pct { flex: none; }
.acc-q__pct { min-width: 3.6ch; text-align: right; font-weight: 400; color: var(--ink); }
.acc-q.is-hot .acc-q__pct { color: var(--signal-ink); }
.acc-q__rst { color: var(--ink-3); overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.acc-q__lbl { color: var(--ink-3); overflow: hidden; text-overflow: ellipsis; min-width: 0; font-family: var(--font-sans); }
</style>
