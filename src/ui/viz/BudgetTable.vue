<script setup lang="ts">
import { computed } from 'vue'
import { fmtInt } from '../fmt'
import StatusMark from '../data/StatusMark.vue'
import TickMeter from './TickMeter.vue'
import type { BudgetSource } from '../types'

/**
 * Request budget (DESIGN.md §5.2 viz/BudgetTable, settings §02): per upstream source `used / limit` with a
 * tick meter, the minimum interval and state. The source nearest its limit gets the attn edge once it is
 * past `attnFrom` (default: the meter redline), so a calm budget carries no orange.
 */
const props = withDefaults(
  defineProps<{
    sources: BudgetSource[]
    attnFrom?: number
    format?: (value: number | null) => string
    emptyText?: string
  }>(),
  { attnFrom: 0.9, format: fmtInt, emptyText: '— 没有受限的上游' },
)

const rows = computed(() => {
  const list = props.sources.map((s) => ({ s, ratio: s.used != null && s.limit ? s.used / s.limit : null }))
  let top = -1
  let best = -1
  list.forEach((x, i) => {
    if (x.ratio !== null && x.ratio > best) {
      best = x.ratio
      top = i
    }
  })
  return list.map((x, i) => ({ ...x, attn: i === top && best >= props.attnFrom }))
})
</script>

<template>
  <div v-if="rows.length" class="ui-budget" role="table" aria-label="请求预算">
    <div class="ui-budget__head" role="row">
      <span role="columnheader">来源</span><span role="columnheader">用量</span><span role="columnheader" class="num">已用 / 上限</span>
      <span role="columnheader">最小间隔</span><span role="columnheader">状态</span>
    </div>
    <div v-for="(r, i) in rows" :key="r.s.key ?? r.s.name" class="ui-budget__row" :class="{ 'is-attn': r.attn }" role="row" data-row :style="{ '--r': i }">
      <span role="cell" class="ellip">{{ r.s.name }}<span v-if="r.s.note" class="ui-budget__note"> · {{ r.s.note }}</span></span>
      <span role="cell"><TickMeter :value="r.ratio" :width="96" :unlimited="r.s.limit == null" :show-pct="false" :aria-label="`${r.s.name} 预算`" /></span>
      <span role="cell" class="num">{{ format(r.s.used) }}<span class="dim"> / {{ r.s.limit == null ? '不限' : format(r.s.limit) }}</span></span>
      <span role="cell" class="num dim">{{ r.s.minInterval ?? '—' }}</span>
      <span role="cell"><StatusMark v-if="r.s.state" :state="r.s.state" :label="r.s.stateLabel" /></span>
    </div>
  </div>
  <p v-else class="ui-budget__empty">{{ emptyText }}</p>
</template>

<style>
.ui-budget { display: grid; font-size: var(--fs-sm); }
.ui-budget__head, .ui-budget__row { display: grid; grid-template-columns: minmax(0, 1.4fr) 112px minmax(84px, .8fr) 84px 96px; align-items: center; gap: 0 12px; padding: 0 6px; }
.ui-budget__head { height: var(--row-head); border-bottom: 1px solid var(--rule-2); font-size: var(--fs-xs); font-weight: 500; color: var(--ink-3); }
.ui-budget__row { min-height: var(--row-dense); border-bottom: 1px solid var(--rule); }
.ui-budget__row.is-attn { box-shadow: inset 2px 0 0 var(--signal); }
.ui-budget__note { color: var(--ink-3); }
.ui-budget__empty { margin: 0; padding: 8px 0; font-size: var(--fs-sm); color: var(--ink-3); }
@media (max-width: 599px) {
  .ui-budget__head { display: none; }
  .ui-budget__row { grid-template-columns: minmax(0, 1fr) auto; row-gap: 4px; padding: 8px 6px; }
  .ui-budget__row > :nth-child(2) { grid-column: 1; }
  .ui-budget__row > :nth-child(4) { display: none; }
}
</style>
