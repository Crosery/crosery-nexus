<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import { fmtCompact, fmtPct } from '../fmt'
import type { RankRow } from '../types'

/**
 * Rank list (DESIGN.md §5.2 viz/RankList): name (ellipsis), a 3px bar on a paper-3 track that grows with
 * scaleX, value and share — the order is the rank, so no index column. A failure rate past `errThreshold` adds
 * `err 8.2%` in signal-ink; a list with any such cell reserves that column on every row so the numbers align.
 */
const props = withDefaults(
  defineProps<{
    rows: RankRow[]
    format?: (value: number | null) => string
    limit?: number
    showShare?: boolean
    errThreshold?: number
    /** names become buttons that emit `select` (e.g. filter the page by this model) */
    selectable?: boolean
    /** empty line when no rows */
    emptyText?: string
  }>(),
  { format: fmtCompact, limit: 8, showShare: true, errThreshold: 0.05, selectable: false, emptyText: '— 没有数据' },
)
const emit = defineEmits<{ select: [row: RankRow, index: number] }>()

const items = computed(() => {
  const list = props.rows.slice(0, props.limit)
  const total = props.rows.reduce((a, r) => a + (r.value ?? 0), 0)
  const max = Math.max(1e-9, ...list.map((r) => r.value ?? 0))
  return list.map((r, i) => ({
    row: r,
    i,
    bar: (r.value ?? 0) / max,
    share: r.share ?? (total > 0 ? (r.value ?? 0) / total : null),
    hot: typeof r.err === 'number' && r.err >= props.errThreshold,
  }))
})
</script>

<template>
  <ol v-if="items.length" class="ui-rank" :class="{ 'has-err': items.some((it) => it.hot) }">
    <li v-for="it in items" :key="it.row.key ?? it.row.name" data-row :style="{ '--r': it.i }">
      <span class="ui-rank__n">
        <RouterLink v-if="it.row.to" :to="it.row.to" class="ui-link ellip">{{ it.row.name }}</RouterLink>
        <button v-else-if="selectable" type="button" class="ui-rank__btn ellip" @click="emit('select', it.row, it.i)">{{ it.row.name }}</button>
        <span v-else class="ellip">{{ it.row.name }}</span>
        <span v-if="it.row.sub" class="ui-rank__sub ellip">{{ it.row.sub }}</span>
      </span>
      <span class="ui-rank__bar" aria-hidden="true"><b :style="{ transform: `scaleX(${it.bar})` }" /></span>
      <span class="ui-rank__v num">{{ format(it.row.value) }}</span>
      <span v-if="showShare" class="ui-rank__s num">{{ it.share === null ? '—' : fmtPct(it.share) }}</span>
      <span v-if="it.hot" class="ui-rank__err num">err {{ fmtPct(it.row.err) }}</span>
    </li>
  </ol>
  <p v-else class="ui-rank__empty">{{ emptyText }}</p>
</template>

<style>
.ui-rank { margin: 0; padding: 0; list-style: none; }
.ui-rank li {
  display: grid; grid-template-columns: minmax(0, 1fr) minmax(40px, 22%) auto auto auto; align-items: center; gap: 0 10px;
  min-height: 34px; border-bottom: 1px solid var(--rule); font-size: var(--fs-sm);
}
.ui-rank.has-err li { grid-template-columns: minmax(0, 1fr) minmax(40px, 22%) auto auto 10ch; }
.ui-rank li:has(.ui-rank__sub) { padding: 5px 0; }
.ui-rank__n { display: grid; min-width: 0; }
.ui-rank__btn { all: unset; cursor: pointer; color: var(--ink); }
.ui-rank__btn:hover { text-decoration: underline; text-underline-offset: 3px; }
.ui-rank__sub { font-size: var(--fs-xs); color: var(--ink-3); }
.ui-rank__bar { height: 3px; background: var(--paper-3); overflow: hidden; }
.ui-rank__bar b { display: block; height: 100%; background: var(--ink-2); transform-origin: left; transition: transform var(--dur-4) var(--ease-settle); }
.is-entering .ui-rank__bar b { animation: ui-rank-grow var(--dur-4) var(--ease-settle) backwards; animation-delay: calc(var(--pd, 40ms) + 120ms + min(var(--r, 0), 14) * var(--stagger)); }
@keyframes ui-rank-grow { from { transform: scaleX(0); } }
.ui-rank__v { text-align: right; color: var(--ink); }
.ui-rank__s { text-align: right; min-width: 5ch; color: var(--ink-3); font-size: var(--fs-xs); }
.ui-rank__err { text-align: right; color: var(--signal-ink); font-size: var(--fs-xs); }
.ui-rank__empty { margin: 0; padding: 8px 0; font-size: var(--fs-sm); color: var(--ink-3); }
@media (max-width: 599px) {
  .ui-rank li { grid-template-columns: minmax(0, 1fr) auto auto auto; }
  .ui-rank.has-err li { grid-template-columns: minmax(0, 1fr) auto auto 10ch; }
  .ui-rank__bar { grid-column: 1 / -1; grid-row: 2; margin-bottom: 6px; }
}
</style>
