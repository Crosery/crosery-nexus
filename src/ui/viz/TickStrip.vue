<script setup lang="ts">
import { computed } from 'vue'

/**
 * Tick strip (DESIGN.md §5.2 viz/TickStrip): one 2px tick per slot (36 × 5 min = 3h by default).
 * A slot with traffic is a full ink-3 tick, a failing slot a full signal tick; idle slots draw nothing above one
 * quiet baseline (no row of stubs that carries no information).
 */
const props = withDefaults(
  defineProps<{
    /** per-slot activity (count); null / 0 = idle */
    ticks: Array<number | null | undefined>
    /** per-slot failure flag */
    bad?: Array<boolean | null | undefined> | null
    h?: number
    label?: string
  }>(),
  { bad: null, h: 12, label: undefined },
)

const w = computed(() => props.ticks.length * 4)
const items = computed(() =>
  props.ticks.map((v, i) => {
    const bad = Boolean(props.bad?.[i])
    const on = bad || (typeof v === 'number' && v > 0)
    return { x: i * 4, on, bad }
  }),
)
</script>

<template>
  <svg
    class="ui-ticks"
    :width="w"
    :height="h"
    :viewBox="`0 0 ${w} ${h}`"
    :role="label ? 'img' : undefined"
    :aria-label="label"
    :aria-hidden="label ? undefined : 'true'"
  >
    <line class="ui-ticks__base" x1="0" :x2="w" :y1="h - 0.5" :y2="h - 0.5" />
    <template v-for="(t, i) in items" :key="i">
      <rect v-if="t.on" :x="t.x" y="0" width="2" :height="h" :class="{ 'is-bad': t.bad }" />
    </template>
  </svg>
</template>

<style>
.ui-ticks { display: block; flex: none; }
.ui-ticks rect { fill: var(--ink-3); }
.ui-ticks__base { stroke: var(--rule); stroke-width: 1; }
.ui-ticks rect.is-bad { fill: var(--signal); }
</style>
