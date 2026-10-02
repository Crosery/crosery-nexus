<script setup lang="ts">
import { computed, useTemplateRef } from 'vue'
import { useElementWidth } from '../composables/useElementWidth'
import { fmtCompact, fmtPct } from '../fmt'
import type { ShareSegment } from '../types'
import './viz.css'

/**
 * Share bar (DESIGN.md §5.2 viz/ShareBar, §2.3): one 100% bar split into segments with 2px paper gaps.
 * Identity is a solid tonal step (k1–k6) + 2px gaps + label, at most 6 named segments plus 其余; the legend is
 * shown by default; direct labels above the bar (up to 4 wide segments) default to on only when there is no
 * legend, so the same numbers are never printed twice. A direct label that
 * does not fit its segment drops to the percentage alone, then to nothing — never a clipped `新输入 …`.
 */
const props = withDefaults(
  defineProps<{
    segments: ShareSegment[]
    format?: (value: number) => string
    legend?: boolean
    /** label wide segments directly above the bar (≤4); default: only when the legend is off */
    direct?: boolean
    height?: number
    /** accessible name of the whole bar */
    label?: string
  }>(),
  { format: fmtCompact, legend: true, direct: undefined, height: 10, label: undefined },
)

const TONES = ['k1', 'k2', 'k3', 'k4', 'k5', 'k6'] as const
const showDirect = computed(() => props.direct ?? !props.legend)
const host = useTemplateRef<HTMLElement>('host')
const barW = useElementWidth(host, 0)
/** rough text width at --fs-xs: CJK ≈ 12px, Latin / digits ≈ 7px, plus the gap */
const textW = (text: string) => [...text].reduce((w, ch) => w + (/[\u2E80-\u9FFF\uFF00-\uFFEF]/.test(ch) ? 12 : 7), 4)

const rows = computed(() => {
  const clean = props.segments.filter((s) => Number.isFinite(s.value) && s.value > 0)
  const named = clean.filter((s) => s.tone !== 'rest').slice(0, 6)
  const restValue = clean.filter((s) => s.tone === 'rest' || !named.includes(s)).reduce((a, s) => a + s.value, 0)
  const list = named.map((s, i) => ({ key: s.key, label: s.label, value: s.value, tone: s.tone ?? TONES[i] }))
  if (restValue > 0) list.push({ key: '__rest', label: '其余', value: restValue, tone: 'rest' })
  const total = list.reduce((a, s) => a + s.value, 0)
  let directCount = 0
  let left = 0
  return {
    total,
    items: list.map((s) => {
      const share = total > 0 ? s.value / total : 0
      const pct = fmtPct(share, 0)
      const room = barW.value > 0 ? share * barW.value : Number.POSITIVE_INFINITY
      const fits = textW(`${s.label} ${pct}`) <= room
      const direct = showDirect.value && share >= 0.14 && directCount < 4 && textW(pct) <= room
      const item = { ...s, share, left, pct, direct, name: fits ? s.label : '' }
      if (item.direct) directCount += 1
      left += share
      return item
    }),
  }
})
const summary = computed(() => {
  const shares = rows.value.items.map((s) => `${s.label} ${fmtPct(s.share)}`).join('，')
  return props.label ? `${props.label}：${shares}` : shares
})
</script>

<template>
  <div ref="host" class="ui-share">
    <div v-if="showDirect && rows.items.some((s) => s.direct)" class="ui-share__direct" aria-hidden="true">
      <span v-for="s in rows.items.filter((x) => x.direct)" :key="s.key" :style="{ left: `${s.left * 100}%`, maxWidth: `${s.share * 100}%` }">
        <template v-if="s.name">{{ s.name }} </template><b>{{ s.pct }}</b>
      </span>
    </div>
    <div class="ui-share__bar" role="img" :aria-label="summary" :style="{ height: `${height}px` }">
      <i v-for="s in rows.items" :key="s.key" :class="`ui-${s.tone === 'rest' ? 'krest' : s.tone === 'hot' ? 'khot' : s.tone}`" :style="{ flexGrow: s.value }" />
    </div>
    <ul v-if="legend" class="ui-legend">
      <li v-for="s in rows.items" :key="s.key">
        <i :class="`ui-${s.tone === 'rest' ? 'krest' : s.tone === 'hot' ? 'khot' : s.tone}`" aria-hidden="true" />
        <span class="ellip">{{ s.label }}</span> <b>{{ format(s.value) }}</b> <span class="dim">{{ fmtPct(s.share) }}</span>
      </li>
    </ul>
  </div>
</template>

<style>
.ui-share { min-width: 0; }
.ui-share__direct { position: relative; height: 16px; margin-bottom: 3px; }
.ui-share__direct span { position: absolute; bottom: 0; padding-left: 1px; font-size: var(--fs-xs); color: var(--ink-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ui-share__direct b { font-weight: 400; font-family: var(--font-mono); color: var(--ink); }
.ui-share__bar { display: flex; gap: 2px; width: 100%; min-width: 0; }
.ui-share__bar i { flex: 1 1 0; min-width: 2px; border-radius: 1px; }
</style>
