<script setup lang="ts">
import { computed } from 'vue'
import { TxPagination } from '@talex-touch/tuffex/pagination'
import { fmtInt } from '../fmt'

/**
 * Pager: TxPagination (‹ 1 2 3 … 48 ›, Chinese labels) plus `共 4,812 条`. v-model:page is 1-based; hidden when
 * everything fits on one page. 28px buttons on fine pointers, 40px on touch (styles/tx/pagination.css).
 */
const props = withDefaults(defineProps<{ total: number; pageSize?: number }>(), { pageSize: 50 })
const page = defineModel<number>('page', { default: 1 })
const pages = computed(() => Math.max(1, Math.ceil(props.total / props.pageSize)))
function go(next: number) {
  page.value = Math.max(1, Math.min(pages.value, next))
}
</script>

<template>
  <div v-if="pages > 1" class="ui-pager">
    <span class="ui-pager__t num" aria-live="polite">第 {{ page }} / {{ pages }} 页 · 共 {{ fmtInt(total) }} 条</span>
    <TxPagination
      :current-page="page"
      :page-size="pageSize"
      :total="total"
      aria-label="分页"
      first-label="第一页"
      prev-label="上一页"
      next-label="下一页"
      last-label="最后一页"
      @update:current-page="go"
    />
  </div>
</template>

<style>
.ui-pager { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 4px 12px; padding-top: 10px; font-size: var(--fs-xs); color: var(--ink-3); }
html:root .ui-pager .tx-pagination__list, html:root .ui-pager .tx-pagination ul { display: flex; align-items: center; gap: 2px; margin: 0; padding: 0; list-style: none; }
@media (max-width: 599px) { .ui-pager { justify-content: space-between; } }
</style>
