<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import { fmtCompact, fmtPct } from '../fmt'
import NativeVizTable from './NativeVizTable.vue'
import { useSkinPref } from '../../lib/skin'
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
const { pref: skin } = useSkinPref()
const minimal = computed(() => skin.value === 'minimal')
const nativeRows = computed(() => items.value.map((item) => ({ name: item.row.name, value: props.format(item.row.value), share: item.share === null ? '—' : fmtPct(item.share), error: item.row.err == null ? '—' : fmtPct(item.row.err) })))
</script>

<template>
  <ol v-if="items.length" class="ui-rank" :class="{ 'has-err': items.some((it) => it.hot), 'is-minimal': minimal }">
    <li v-for="it in items" :key="it.row.key ?? it.row.name" data-row :style="{ '--r': it.i }">
      <span class="ui-rank__n">
        <RouterLink v-if="it.row.to" :to="it.row.to" class="ui-link ellip">{{ it.row.name }}</RouterLink>
        <button v-else-if="selectable && it.row.selectable !== false" type="button" class="ui-rank__btn ellip" :title="`按 ${it.row.name} 筛选`" @click="emit('select', it.row, it.i)">{{ it.row.name }}</button>
        <span v-else class="ellip">{{ it.row.name }}</span>
        <span v-if="it.row.sub" class="ui-rank__sub ellip">{{ it.row.sub }}</span>
      </span>
      <span class="ui-rank__bar" aria-hidden="true"><b :style="{ transform: `scaleX(${it.bar})` }" /></span>
      <span class="ui-rank__v num">{{ format(it.row.value) }}</span>
      <span v-if="showShare" class="ui-rank__s num">{{ it.share === null ? '—' : fmtPct(it.share) }}</span>
      <template v-if="items.some((it) => it.hot)">
        <span v-if="it.hot" class="ui-rank__err num">err {{ fmtPct(it.row.err) }}</span>
        <span v-else class="ui-rank__err-empty" aria-hidden="true" />
      </template>
    </li>
  </ol>
  <p v-else class="ui-rank__empty">{{ emptyText }}</p>
</template>

<style scoped>
.ui-rank {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: 100%;
}
.ui-rank li {
  display: grid;
  grid-template-columns: minmax(0, 1.2fr) minmax(50px, 1fr) 56px 42px;
  align-items: center;
  gap: 12px;
  min-height: 28px;
  font-size: 13px;
}
.ui-rank.has-err li {
  grid-template-columns: minmax(0, 1.2fr) minmax(50px, 1fr) 56px 42px 64px;
}
.ui-rank__err-empty {
  display: block;
  width: 64px;
}
.ui-rank__n {
  display: flex;
  align-items: center;
  min-width: 0;
  overflow: hidden;
}
.ui-rank__btn {
  background: transparent !important;
  border: none !important;
  box-shadow: none !important;
  padding: 0 !important;
  margin: 0 !important;
  font: inherit;
  cursor: pointer;
  color: inherit;
  text-align: left;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 100%;
}
.ui-rank__btn:hover {
  color: var(--tx-color-primary, #409eff);
  text-decoration: underline;
  text-underline-offset: 3px;
}
.ui-rank__sub {
  font-size: 11px;
  color: var(--tx-text-color-placeholder, #94a3b8);
  margin-left: 6px;
  flex: none;
}
.ui-rank__err {
  text-align: right;
  color: var(--tx-color-danger, #ef4444);
  font-size: 11px;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.ui-rank__bar {
  height: 6px;
  background: var(--tx-fill-color, rgba(255, 255, 255, 0.08));
  border-radius: 99px;
  overflow: hidden;
  min-width: 40px;
}
.ui-rank__bar b {
  display: block;
  height: 100%;
  background: var(--tx-color-primary, #409eff);
  border-radius: 99px;
  transform-origin: left;
  transition: transform 0.3s cubic-bezier(0.16, 1, 0.3, 1);
}
.ui-rank__v {
  text-align: right;
  font-weight: 600;
  color: var(--tx-text-color-primary, #f1f5f9);
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.ui-rank__s {
  text-align: right;
  min-width: 4.5ch;
  color: var(--tx-text-color-secondary, #94a3b8);
  font-size: 12px;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.ui-rank__empty {
  margin: 0;
  padding: 12px 0;
  font-size: 13px;
  color: var(--tx-text-color-secondary, #94a3b8);
  text-align: center;
}
</style>
