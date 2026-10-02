<script setup lang="ts">
import { computed } from 'vue'
import RowTable from '../../ui/data/RowTable.vue'
import { copyText } from '../../ui/feedback/toast'
import { fmtClock, fmtCompact, fmtDuration, fmtTime, fmtUsd, NONE } from '../../ui/fmt'
import { requestFailure, statusText } from './meModel'
import type { MeRequestItem } from '../../types'
import type { DataState, RowColumn } from '../../ui/types'

/**
 * This key's own requests (DESIGN §6.10 05 / /me/usage): 34px rows on desktop, two-line cards on phones.
 * A failed row carries the 2px signal edge and its reason in plain words (what happened · whose problem ·
 * what next) with the raw code as a mono suffix. `full` adds 首字 / 缓存读 / 请求 ID (click copies the id).
 */
type Item = MeRequestItem & { totalTokens?: number }
const props = withDefaults(
  defineProps<{
    items: Item[]
    full?: boolean
    state?: DataState
    error?: unknown
    emptyText?: string
    skeletonRows?: number
    caption?: string
  }>(),
  { full: false, state: 'ready', error: undefined, emptyText: '没有请求记录', skeletonRows: 8, caption: '我的请求' },
)
const emit = defineEmits<{ retry: [] }>()

const tokensOf = (row: Item) => (typeof row.totalTokens === 'number' && row.totalTokens > 0 ? row.totalTokens : row.inputTokens + row.outputTokens)
const tokenTitle = (row: Item) => `输入 ${fmtCompact(row.inputTokens)} · 输出 ${fmtCompact(row.outputTokens)} · 缓存读 ${fmtCompact(row.cacheReadTokens)}${row.cacheWriteTokens ? ` · 缓存写 ${fmtCompact(row.cacheWriteTokens)}` : ''}`
const cost = (row: Item) => (row.costUsd === null ? NONE : fmtUsd(row.costUsd, { digits: row.costUsd > 0 && row.costUsd < 0.01 ? 4 : undefined }))
const shortId = (id: string | null) => (id ? (id.length > 10 ? `${id.slice(0, 8)}…` : id) : NONE)

const columns = computed<RowColumn<Item>[]>(() => {
  const base: RowColumn<Item>[] = [
    props.full
      ? { key: 'timestamp', title: '时间', width: 128, nowrap: true, format: (v) => fmtClock(v as string) }
      : { key: 'timestamp', title: '时间', width: 96, nowrap: true, format: (v) => fmtTime(v as string) },
    { key: 'model', title: '模型', minWidth: 200 },
    { key: 'status', title: '状态', width: 76, nowrap: true },
    { key: 'tokens', title: 'Token', width: 84, align: 'right', nowrap: true },
  ]
  if (props.full) {
    base.push(
      { key: 'cacheReadTokens', title: '缓存读', width: 84, align: 'right', nowrap: true, format: (v) => ((v as number) > 0 ? fmtCompact(v as number) : NONE) },
      { key: 'ttftMs', title: '首字', width: 76, align: 'right', nowrap: true, format: (v) => fmtDuration(v as number | null) },
    )
  }
  base.push(
    { key: 'latencyMs', title: '耗时', width: 76, align: 'right', nowrap: true, format: (v) => fmtDuration(v as number | null) },
    { key: 'costUsd', title: '花费', width: 84, align: 'right', nowrap: true },
  )
  if (props.full) base.push({ key: 'requestId', title: '请求 ID', width: 108, nowrap: true })
  return base
})
const rowTone = (row: Item) => (row.success ? null : 'attn')
</script>

<template>
  <RowTable
    class="me-req"
    :columns="columns"
    :data="items"
    row-key="id"
    density="dense"
    :row-tone="rowTone"
    :state="state"
    :error="error"
    :empty-text="emptyText"
    :skeleton-rows="skeletonRows"
    :caption="caption"
    @retry="emit('retry')"
  >
    <template #cell-model="{ row }">
      <span class="me-req__model">
        <span class="me-req__id num" :title="row.model">{{ row.model }}</span>
        <span v-if="!row.success" class="me-req__why">
          {{ requestFailure(row).title }}<template v-if="requestFailure(row).next"> · {{ requestFailure(row).next }}</template>
        </span>
      </span>
    </template>
    <template #cell-status="{ row }">
      <span class="num" :class="row.success ? 'me-req__ok' : 'me-req__bad'">{{ statusText(row) }}</span>
    </template>
    <template #cell-tokens="{ row }">
      <span class="num" :title="tokenTitle(row)">{{ fmtCompact(tokensOf(row)) }}</span>
    </template>
    <template #cell-costUsd="{ row }">
      <span class="num">{{ cost(row) }}</span>
    </template>
    <template #cell-requestId="{ row }">
      <button v-if="row.requestId" type="button" class="me-req__rid num" :title="`复制请求 ID ${row.requestId}`" :aria-label="`复制请求 ID ${row.requestId}`" @click.stop="copyText(row.requestId, '请求 ID')">{{ shortId(row.requestId) }}</button>
      <span v-else class="dim">{{ NONE }}</span>
    </template>

    <template #card="{ row }">
      <div class="ui-rcard__l1">
        <span class="ui-rcard__primary"><span class="me-req__id num">{{ row.model }}</span></span>
        <span class="ui-rcard__meta"><span :class="row.success ? 'me-req__ok' : 'me-req__bad'">{{ statusText(row) }}</span></span>
      </div>
      <div class="ui-rcard__ln num">
        <span class="ui-rcard__seg">{{ fmtClock(row.timestamp) }}</span>
        <span class="ui-rcard__seg">{{ fmtCompact(tokensOf(row)) }} tok</span>
        <span class="ui-rcard__seg">{{ fmtDuration(row.latencyMs) }}</span>
        <span class="ui-rcard__seg">{{ cost(row) }}</span>
      </div>
      <div v-if="!row.success" class="me-req__whyline">
        {{ requestFailure(row).title }}<template v-if="requestFailure(row).next"> · {{ requestFailure(row).next }}</template>
        <span class="me-req__code num">{{ requestFailure(row).code }}</span>
      </div>
    </template>
  </RowTable>
</template>

<style>
.me-req__model { display: flex; flex-direction: column; min-width: 0; line-height: 1.3; }
.me-req__id { display: block; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ink); }
.me-req__why { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--fs-xs); color: var(--ink-2); }
.me-req__ok { color: var(--ink-2); }
.me-req__bad { color: var(--signal-ink); }
.me-req__rid { all: unset; cursor: pointer; color: var(--ink-2); font-family: var(--font-mono); font-size: var(--fs-sm); }
.me-req__rid:hover { color: var(--ink); text-decoration: underline; text-underline-offset: 3px; }
.me-req__rid:focus-visible { outline: 2px solid var(--signal); outline-offset: 2px; }
.me-req__whyline { font-size: var(--fs-xs); color: var(--ink-2); overflow-wrap: anywhere; }
.me-req__code { margin-left: 8px; color: var(--ink-3); white-space: nowrap; }
.me-req .dim { color: var(--ink-3); }
</style>
