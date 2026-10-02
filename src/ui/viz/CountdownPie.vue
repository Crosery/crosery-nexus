<script setup lang="ts">
import { computed, watch } from 'vue'
import { useCountdown } from '../composables/useNow'
import type { Instant } from '../types'

/**
 * Cooldown pie (DESIGN.md §5.2 viz/CountdownPie, motion recipe 15): ink-2 conic pie draining to empty plus
 * `冷却 23:41`, driven by the shared 1 s ticker. Cooldown is self-healing, so it is never orange.
 */
const props = withDefaults(
  defineProps<{
    until: Instant
    /** full cooldown length in ms (pie = msLeft / total); without it the pie stays full until done */
    total?: number | null
    label?: string
    /** pie only */
    bare?: boolean
  }>(),
  { total: null, label: '冷却', bare: false },
)
const emit = defineEmits<{ done: [] }>()

const cd = useCountdown(() => props.until, () => props.total)
const deg = computed(() => `${Math.round(cd.ratio.value * 360)}deg`)
const text = cd.label
watch(cd.done, (done) => {
  if (done) emit('done')
})
</script>

<template>
  <span class="ui-cdp" :aria-label="`${label} 剩余 ${text}`" role="timer">
    <i class="ui-cdp__pie" :style="{ '--pie': deg }" aria-hidden="true" />
    <span v-if="!bare" class="ui-cdp__t" aria-hidden="true">{{ label }} <b class="num">{{ text }}</b></span>
  </span>
</template>

<style>
.ui-cdp { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; font-size: var(--fs-sm); color: var(--ink-2); }
.ui-cdp__pie { width: 9px; height: 9px; flex: none; border-radius: 50%; border: 1.25px solid var(--ink-2);
  background: conic-gradient(var(--ink-2) 0 var(--pie), transparent var(--pie) 360deg); }
.ui-cdp__t b { font-weight: 400; font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
</style>
