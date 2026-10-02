<script setup lang="ts">
import { computed } from 'vue'
import { clockParts, fmtCompact, fmtDate, fmtInt, fmtUsd, NONE } from '../../ui/fmt'

/**
 * Seven-day ledger strip (DESIGN §6.10 02): `五 六 日 一 二 三 今`, one bar per local day on a shared scale,
 * past days ink-4, today ink, today's projection to 24:00 as a pale solid cap (it is not real yet). Values sit
 * above the bars in mono; the busiest day is not highlighted in orange (orange means "act").
 * Local kit gap: there is no ledger-strip component in src/ui (Readout's 70×30 history has no day labels).
 */
type Day = { day: string; value: number | null; requests: number }
const props = withDefaults(
  defineProps<{
    days: Day[]
    /** what `value` is: spend (USD) or tokens when nothing is priced */
    metric?: 'usd' | 'tokens'
    /** today's projected total at 24:00 (same unit as value) */
    projected?: number | null
    approx?: boolean
  }>(),
  { metric: 'usd', projected: null, approx: false },
)

const WD = ['日', '一', '二', '三', '四', '五', '六']
const fmt = (v: number | null) => (v === null ? NONE : props.metric === 'usd' ? fmtUsd(v, { approx: props.approx }) : fmtCompact(v))
const short = (v: number | null) => {
  if (v === null) return NONE
  if (props.metric === 'tokens') return fmtCompact(v)
  if (v === 0) return '$0'
  if (v < 1) return `$${v.toFixed(2)}`
  return v < 100 ? `$${v.toFixed(1)}` : `$${fmtCompact(Math.round(v))}`
}

const cols = computed(() => {
  const list = props.days.slice(-7)
  const last = list.length - 1
  const peakValue = Math.max(1e-9, ...list.map((d) => d.value ?? 0), last >= 0 ? props.projected ?? 0 : 0)
  return list.map((d, i) => {
    const today = i === last
    const p = clockParts(`${d.day}T12:00:00+08:00`)
    const value = d.value ?? 0
    const proj = today && props.projected != null && props.projected > value ? props.projected : null
    return {
      key: d.day,
      today,
      label: today ? '今' : p ? WD[p.weekday] : '',
      value: d.value,
      h: Math.max(value > 0 ? 2 : 1, (value / peakValue) * 100),
      projH: proj === null ? 0 : ((proj - value) / peakValue) * 100,
      title: `${fmtDate(`${d.day}T12:00:00+08:00`)} · ${fmt(d.value)} · ${fmtInt(d.requests)} 次${proj !== null ? ` · 按当前速度 ≈ ${fmt(proj)}` : ''}`,
      empty: d.requests === 0,
    }
  })
})
const total = computed(() => {
  const list = props.days.slice(-7)
  if (list.every((d) => d.value === null)) return null
  return list.reduce((sum, d) => sum + (d.value ?? 0), 0)
})
</script>

<template>
  <figure class="me-week" :aria-label="`近 7 个自然日${metric === 'usd' ? '花费' : 'Token'} ${fmt(total)}`">
    <figcaption class="me-week__cap">
      <span>近 7 个自然日</span>
      <span class="num me-week__total">{{ fmt(total) }}</span>
    </figcaption>
    <ol class="me-week__cols">
      <li v-for="(c, i) in cols" :key="c.key" class="me-week__col" :class="{ 'is-today': c.today, 'is-empty': c.empty }" :title="c.title" :style="{ '--i': i }">
        <span class="me-week__v num">{{ c.empty ? '' : short(c.value) }}</span>
        <span class="me-week__bar" aria-hidden="true">
          <i v-if="c.projH > 0" class="me-week__proj" :style="{ height: `${c.projH}%`, bottom: `${c.h}%` }" />
          <i class="me-week__fill" :style="{ height: `${c.h}%` }" />
        </span>
        <span class="me-week__d">{{ c.label }}</span>
        <span class="sr-only">{{ c.title }}</span>
      </li>
    </ol>
  </figure>
</template>

<style>
.me-week { margin: 0; min-width: 0; }
.me-week__cap { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; margin-bottom: 6px; font-size: var(--fs-xs); color: var(--ink-3); }
.me-week__total { color: var(--ink-2); font-size: var(--fs-sm); }
.me-week__cols { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 6px; }
.me-week__col { display: grid; grid-template-rows: 14px 44px 16px; justify-items: center; align-items: end; min-width: 0; }
.me-week__v { font-size: 10.5px; line-height: 14px; color: var(--ink-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
.me-week__col.is-today .me-week__v { color: var(--ink); }
.me-week__bar { position: relative; width: 100%; height: 44px; border-bottom: 1px solid var(--rule-2); }
.me-week__fill, .me-week__proj { position: absolute; left: 18%; right: 18%; bottom: 0; display: block; }
.me-week__fill { background: var(--ink-4); transform-origin: bottom; animation: me-week-grow var(--dur-5) var(--ease-settle) both; animation-delay: calc(var(--i) * 40ms + 200ms); }
.me-week__col.is-today .me-week__fill { background: var(--ink); }
.me-week__col.is-empty .me-week__fill { background: var(--rule-2); }
.me-week__proj { background: var(--k5); }
.me-week__d { font-size: var(--fs-xs); line-height: 16px; color: var(--ink-3); }
.me-week__col.is-today .me-week__d { color: var(--ink); font-weight: 600; }
@keyframes me-week-grow { from { transform: scaleY(0); } }
</style>
