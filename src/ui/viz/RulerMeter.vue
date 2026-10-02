<script setup lang="ts">
import { computed } from 'vue'
import { fmtCompact, fmtInt, fmtUsd, NONE } from '../fmt'
import TickMeter from './TickMeter.vue'

/**
 * Quota ruler (DESIGN.md §5.2 viz/RulerMeter, §6.10): `日 $38.20 / $50.00  76%`, a full-width tick meter,
 * then `剩 $11.80 · 今天 24:00 重置`. Desktop adds a 0/25/50/75/100 scale (five ticks, no minor ticks); `compact`
 * (mobile / 44px rows) keeps only the redline. `pace` is the pre-composed warning sentence (signal-ink).
 */
type Unit = 'usd' | 'tokens' | 'count'
const props = withDefaults(
  defineProps<{
    label: string
    used: number | null | undefined
    /** null / undefined = unlimited */
    limit: number | null | undefined
    unit?: Unit
    format?: (value: number) => string
    /** pre-formatted reset phrase, e.g. "今天 24:00 重置" */
    reset?: string
    /** e.g. "按本周速度，周日 18:00 前会用尽"; rendered with ▲ in signal-ink */
    pace?: string | null
    compact?: boolean
    redline?: number
  }>(),
  { unit: 'usd', format: undefined, reset: undefined, pace: null, compact: false, redline: 0.9 },
)

const fmt = (value: number) => (props.format ? props.format(value) : props.unit === 'usd' ? fmtUsd(value) : props.unit === 'tokens' ? fmtCompact(value) : fmtInt(value))
const unlimited = computed(() => props.limit === null || props.limit === undefined)
const ratio = computed(() => (unlimited.value || props.used == null || !props.limit ? null : props.used / props.limit))
const pct = computed(() => (ratio.value === null ? (unlimited.value ? '不限' : NONE) : `${Math.round(ratio.value * 100)}%`))
const over = computed(() => ratio.value !== null && ratio.value >= props.redline)
const remaining = computed(() => {
  if (unlimited.value || props.used == null || props.limit == null) return ''
  const left = props.limit - props.used
  return left >= 0 ? `剩 ${fmt(left)}` : `超出 ${fmt(-left)}`
})
const SCALE = [0, 25, 50, 75, 100]
</script>

<template>
  <div class="ui-ruler" :class="{ 'is-compact': compact, 'is-over': over }">
    <div class="ui-ruler__head">
      <span class="ui-ruler__label">{{ label }}</span>
      <span class="ui-ruler__val num">
        {{ used == null ? NONE : fmt(used) }}<span v-if="!unlimited" class="ui-ruler__lim"> / {{ fmt(limit as number) }}</span>
      </span>
      <span class="ui-ruler__pct num" :class="{ 'is-unl': unlimited }">{{ pct }}</span>
    </div>
    <TickMeter :value="ratio" fluid :unlimited="unlimited" :show-pct="false" :redline="redline" :aria-label="`${label}额度`" />
    <!-- no scale under an unlimited meter: there is nothing to measure against -->
    <div v-if="!compact && !unlimited" class="ui-ruler__scale" aria-hidden="true">
      <span v-for="s in SCALE" :key="s" :style="{ left: `${s}%` }">{{ s }}</span>
    </div>
    <div v-if="remaining || reset" class="ui-ruler__foot">
      <span>{{ remaining }}</span><template v-if="remaining && reset"> · </template><span>{{ reset }}</span>
    </div>
    <div v-if="pace" class="ui-ruler__pace">▲ {{ pace }}</div>
  </div>
</template>

<style>
.ui-ruler { display: grid; gap: 5px; min-width: 0; }
.ui-ruler__head { display: flex; align-items: baseline; gap: 10px; min-width: 0; }
.ui-ruler__label { font-size: var(--fs-base); font-weight: 600; color: var(--ink); flex: none; }
.ui-ruler__val { font-size: var(--fs-base); color: var(--ink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.ui-ruler__lim { color: var(--ink-3); }
.ui-ruler__pct { margin-left: auto; font-size: var(--fs-base); color: var(--ink); }
.ui-ruler.is-over .ui-ruler__pct { color: var(--signal-ink); }
.ui-ruler__pct.is-unl { color: var(--ink-3); font-size: var(--fs-sm); }
/* five majors every 25% */
.ui-ruler__scale {
  position: relative; height: 14px; margin-top: -1px;
  background: repeating-linear-gradient(90deg, var(--rule-2) 0 1px, transparent 1px calc((100% - 1px) / 4)) 0 0 / 100% 4px no-repeat;
}
.ui-ruler__scale span { position: absolute; top: 4px; transform: translateX(-50%); font-family: var(--font-mono); font-size: 9.5px; color: var(--ink-3); line-height: 10px; }
.ui-ruler__scale span:first-child { transform: none; }
.ui-ruler__scale span:last-child { transform: translateX(-100%); }
.ui-ruler__foot { font-size: var(--fs-xs); color: var(--ink-3); }
.ui-ruler__pace { font-size: var(--fs-xs); color: var(--signal-ink); }
.ui-ruler.is-compact { gap: 4px; }
</style>
