<script setup lang="ts">
import { computed } from 'vue'
import { TxSkeleton, useDeferredLoading } from '@talex-touch/tuffex/skeleton'
import { TxEmptyState } from '@talex-touch/tuffex/empty-state'
import { TxErrorState } from '@talex-touch/tuffex/error-state'
import { TxPermissionState } from '@talex-touch/tuffex/permission-state'
import { TxButton } from '@talex-touch/tuffex/button'
import { toast } from '@talex-touch/tuffex/utils'
import { describeError } from '../../lib/errors'
import type { DataState } from '../composables/useLive'

/**
 * DESIGN.md §5.1 non-ready states, rendered one row tall and left-aligned — no illustrations, no spinners —
 * on tuffex: TxSkeleton bars, TxEmptyState / TxErrorState / TxPermissionState with `:icon="null"`, plain
 * surface and our own Chinese title (styles/tx/empty-state.css flattens them into one line).
 * loading: paper-3 bars at the real column widths (deferred 200ms, held ≥400ms).
 * empty:   "— 没有冷却中的账号" + at most one text action.
 * error:   "◆ 读取失败 · 502 · 服务器出错了  重试" + the trace in mono (click to copy).
 * forbidden: "⊘ 无权限查看 · 此视图仅管理员可见".
 * ready / stale render nothing (the owner shows its data).
 */
const props = withDefaults(
  defineProps<{
    state: DataState
    /** skeleton rows; use the real or last known row count */
    rows?: number
    /** skeleton column widths (CSS lengths or fr), e.g. ['32px', '1fr', '88px'] */
    cols?: string[]
    rowHeight?: number
    emptyText?: string
    actionLabel?: string
    error?: unknown
    title?: string
    forbiddenText?: string
    /** render the loading skeleton immediately (no 200ms defer), e.g. inside an already-delayed parent */
    eager?: boolean
  }>(),
  {
    rows: 3,
    cols: () => ['1fr', '22%', '14%'],
    rowHeight: 34,
    emptyText: '没有数据',
    actionLabel: undefined,
    error: undefined,
    title: '读取失败',
    forbiddenText: '无权限查看 · 此视图仅管理员可见',
    eager: false,
  },
)

const emit = defineEmits<{ (e: 'retry'): void; (e: 'action'): void }>()

const loading = computed(() => props.state === 'loading')
const deferred = useDeferredLoading(loading, { delay: 200, minDuration: 400 })
const showSkeleton = computed(() => (props.eager ? loading.value : deferred.value))
const view = computed(() => describeError(props.error))
const grid = computed(() => props.cols.join(' '))
const reason = computed(() => {
  const v = view.value
  return [v.status ? String(v.status) : null, v.title].filter(Boolean).join(' · ')
})

async function copyTrace() {
  try {
    await navigator.clipboard.writeText(view.value.trace)
    toast({ title: '已复制', duration: 1600 })
  } catch {
    /* clipboard denied: the trace stays visible */
  }
}
</script>

<template>
  <div v-if="state === 'loading'" class="ui-sb ui-sb--loading" role="status" aria-live="polite" aria-label="正在加载">
    <div v-if="showSkeleton" class="ui-sb__skel">
      <div v-for="r in rows" :key="r" class="ui-sb__row" :style="{ gridTemplateColumns: grid, height: `${rowHeight}px` }">
        <TxSkeleton v-for="(c, ci) in cols" :key="ci" :width="ci === 0 ? `${62 + ((r * 17) % 30)}%` : '70%'" :height="8" :radius="1" />
      </div>
    </div>
    <div v-else :style="{ height: `${rows * rowHeight}px` }" />
  </div>

  <TxEmptyState v-else-if="state === 'empty'" class="ui-sb ui-sb--line" variant="custom" :icon="null" layout="horizontal" align="start" size="small" surface="plain" title="" description="">
    <template #title><span class="ui-sb__mark" aria-hidden="true">—</span><span class="ui-sb__txt">{{ emptyText }}</span></template>
    <template v-if="actionLabel || $slots['empty-extra']" #actions>
      <button v-if="actionLabel" type="button" class="ui-link" @click="emit('action')">{{ actionLabel }}</button>
      <slot name="empty-extra" />
    </template>
  </TxEmptyState>

  <TxErrorState v-else-if="state === 'error'" class="ui-sb ui-sb--error" role="alert" :icon="null" layout="horizontal" align="start" size="small" surface="plain" title="" description="">
    <template #title><span class="ui-sb__mark sig" aria-hidden="true">◆</span><span class="sig">{{ title }}</span><span class="ui-sb__reason">{{ reason }}</span></template>
    <template #description><button type="button" class="ui-sb__trace mono" title="点击复制" @click="copyTrace">{{ view.trace }}</button></template>
    <template #actions><TxButton size="sm" @click="emit('retry')">重试</TxButton></template>
  </TxErrorState>

  <TxPermissionState v-else-if="state === 'forbidden'" class="ui-sb ui-sb--line" :icon="null" layout="horizontal" align="start" size="small" surface="plain" title="" description="">
    <template #title><span class="ui-sb__mark" aria-hidden="true">⊘</span><span class="ui-sb__txt dim2">{{ forbiddenText }}</span></template>
  </TxPermissionState>
</template>

<style>
html:root .ui-sb { min-width: 0; font-size: var(--fs-sm); }
html:root .ui-sb--line { min-height: var(--row-dense); color: var(--ink-3); }
html:root .ui-sb .tx-empty-state__title { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px; min-width: 0; }
.ui-sb__mark { font-family: var(--font-mono); width: 12px; flex: none; text-align: center; }
/* long copy wraps beside its mark instead of dropping the whole sentence under a lone — (390px) */
.ui-sb__txt { flex: 0 1 auto; min-width: 0; }
html:root .ui-sb--error { padding: 6px 0; }
/* error: `◆ 读取失败 · 502 · 原因  [重试]` on one line, the trace under it */
html:root .ui-sb--error .tx-empty-state__description { order: 3; flex-basis: 100%; }
.ui-sb__reason { color: var(--ink-2); min-width: 0; overflow-wrap: anywhere; }
.ui-sb__trace { all: unset; cursor: copy; margin-left: 22px; font-size: var(--fs-xs); color: var(--ink-3); overflow-wrap: anywhere; }
.ui-sb__trace:hover { color: var(--ink-2); }
.ui-sb__trace:focus-visible { outline: 2px solid var(--signal); outline-offset: 2px; }
.ui-sb__skel { display: flex; flex-direction: column; }
.ui-sb__row { display: grid; gap: 16px; align-items: center; }
</style>
