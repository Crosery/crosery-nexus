<script setup lang="ts">
import { computed, watch } from 'vue'
import { TxButton } from '@talex-touch/tuffex/button'
import Icon from '../../../ui/Icon.vue'
import Plate from '../../../ui/data/Plate.vue'
import RowTable from '../../../ui/data/RowTable.vue'
import Pager from '../../../ui/data/Pager.vue'
import Segmented from '../../../ui/form/Segmented.vue'
import RequestDetailSheet from '../../../ui/feedback/RequestDetailSheet.vue'
import { useLive } from '../../../ui/composables/useLive'
import { useBreakpoint } from '../../../ui/composables/useBreakpoint'
import { fmtClock, fmtCompact, fmtDuration, fmtInt, fmtPct, fmtUsd, NONE } from '../../../ui/fmt'
import { useQueryState } from '../../../lib/listState'
import { clientLabel } from '../../../clientLabels'
import type { RowColumn } from '../../../ui/types'
import type { AnalyticsData } from '../../../types'
import { USAGE_FILTER_DEFAULTS, usageFilterFrom, windowLabel } from '../filters'
import { api, type RequestsQuery } from '../shared/api'
import { categoryLabel, windowSpan } from '../shared/format'
import UsageState from '../shared/UsageState.vue'
import type { UsageRequestRow, UsageRequestsData } from '../shared/types'

/**
 * 用量 · 请求 (DESIGN §6.7): the error strip (failure categories of the same window, click to filter), then the
 * request ledger — server-paged from `/api/analytics?view=workspace` under the shared filter, so its total is
 * the same number the 总览 ledger and the dashboard show. `day` (from the heatmap readout) narrows the window to
 * one Shanghai day; `request` deep-links the detail sheet.
 */
const PAGE_SIZE = 50
const scope = useQueryState({ ...USAGE_FILTER_DEFAULTS, status: '', category: '', day: '', page: '1', request: '' })
const filter = computed(() => usageFilterFrom(scope.state))
const query = computed<RequestsQuery>(() => ({
  status: scope.state.status === 'ok' || scope.state.status === 'error' ? scope.state.status : '',
  category: scope.state.category,
  day: /^\d{4}-\d{2}-\d{2}$/.test(scope.state.day) ? scope.state.day : '',
  page: Math.max(1, Math.floor(Number(scope.state.page)) || 1),
  pageSize: PAGE_SIZE,
}))

const live = useLive(
  (signal) => api.analytics<AnalyticsData>(filter.value, query.value, signal) as Promise<UsageRequestsData>,
  { intervalMs: 30_000, isEmpty: (data) => data.summary.requests === 0 },
)
const narrowing = [() => scope.state.days, () => scope.state.keyId, () => scope.state.model, () => scope.state.provider, () => scope.state.client, () => scope.state.currentOnly, () => scope.state.status, () => scope.state.category, () => scope.state.day]
// Any narrowing change starts again at page 1; the page itself refetches too.
watch(narrowing, () => {
  if (scope.state.page !== '1') scope.patch({ page: '1' })
  else void live.refresh()
})
watch(() => scope.state.page, () => void live.refresh())

const data = computed(() => live.data.value ?? null)
const state = computed(() => live.state.value)
const busy = computed(() => live.loading.value && data.value !== null)
const rows = computed<UsageRequestRow[]>(() => data.value?.requests ?? [])
const failures = computed(() => data.value?.errorCategories ?? [])
const summary = computed(() => data.value?.summary ?? null)
const windowText = computed(() => (query.value.day ? `${query.value.day.slice(5).replace('-', '/')} 全天` : windowLabel(filter.value.days)))

/* ── table ───────────────────────────────────────────────────────────────────────────────────── */
const { width } = useBreakpoint()
const wide = computed(() => width.value >= 1180)
const ok = (row: UsageRequestRow) => Boolean(row.success)
// a request that never produced tokens (most failures) shows — rather than a column of `0 → 0` / `$0.000`
const noTokens = (row: UsageRequestRow) => !(row.promptTokens ?? row.inputTokens ?? 0) && !(row.outputTokens ?? 0)
const tokensText = (row: UsageRequestRow) =>
  noTokens(row) ? NONE : `${fmtCompact(row.promptTokens ?? row.inputTokens ?? 0)} → ${fmtCompact(row.outputTokens ?? 0)}`
const costCell = (row: UsageRequestRow) => {
  if (row.costUsd === null || row.costUsd === undefined || (row.costUsd === 0 && noTokens(row))) return NONE
  return fmtUsd(row.costUsd, { approx: row.costEstimated, digits: row.costUsd > 0 && row.costUsd < 0.01 ? 4 : 3 })
}
const columns = computed<RowColumn<UsageRequestRow>[]>(() => [
  { key: 'timestampMs', title: '时间', width: 120, format: (_v, row) => fmtClock(row.timestampMs), card: 'line2' },
  // below 1180 the table distributes spare width over every minWidth column; Key and 客户端 then get a fixed width so
  // the spare goes to 模型, the column people read (sweep1 #3: `nemotron-3.5-lightnin…` beside a half-empty Key)
  { key: 'keyName', title: 'Key', ...(wide.value ? { minWidth: 90 } : { width: 104 }), format: (v) => (v ? String(v) : NONE), card: 'line3' },
  { key: 'model', title: '模型', minWidth: 160, card: 'primary' },
  { key: 'clientType', title: '客户端', ...(wide.value ? { minWidth: 90 } : { width: 92 }), format: (v) => clientLabel(String(v || 'unknown')), card: 'line3' },
  { key: 'statusCode', title: '状态', width: 124, card: 'meta' },
  ...(wide.value ? [{ key: 'ttftMs', title: '首字', width: 68, align: 'right' as const, format: (v: unknown) => (v ? fmtDuration(Number(v)) : NONE) }] : []),
  { key: 'latencyMs', title: '耗时', width: 68, align: 'right', format: (v) => fmtDuration(Number(v)), card: 'line2' },
  { key: 'tokens', title: 'Token 入→出', width: 108, align: 'right', format: (_v, row) => tokensText(row), card: 'line2' },
  { key: 'hitRate', title: '缓存', width: 60, align: 'right', format: (v) => (typeof v === 'number' ? fmtPct(v, 0) : NONE) },
  { key: 'costUsd', title: '花费', width: 84, align: 'right', format: (_v, row) => costCell(row), card: 'line2' },
  // below 1180 the id column gives its room to 模型 (ids stay in the request sheet)
  ...(wide.value ? [{ key: 'requestId', title: '请求 ID', width: 88, format: (v: unknown) => (v ? `${String(v).slice(0, 8)}…` : NONE) }] : []),
])

/* ── detail sheet (?request=) ────────────────────────────────────────────────────────────────── */
const selected = computed(() => {
  const row = rows.value.find((item) => item.requestId === scope.state.request)
  // the sheet formats `timestamp`; hand it a plain ISO instant (the event log keeps nanoseconds + offset)
  return row ? { ...row, timestamp: new Date(row.timestampMs).toISOString() } : null
})
const detailOpen = computed({
  get: () => Boolean(scope.state.request) && selected.value !== null,
  set: (open: boolean) => {
    if (!open) {
      scope.patch({ request: '' })
      scope.flush()
    }
  },
})
function openRow(row: UsageRequestRow) {
  scope.patch({ request: row.requestId })
  scope.flush()
}

/* ── filters ─────────────────────────────────────────────────────────────────────────────────── */
const STATUS_ITEMS = [
  { value: '', label: '全部' },
  { value: 'ok', label: '成功' },
  { value: 'error', label: '失败' },
]
function setStatus(value: string) {
  scope.patch(value === 'error' ? { status: value } : { status: value, category: '' })
}
function toggleCategory(category: string) {
  if (scope.state.category === category) scope.patch({ category: '' })
  else scope.patch({ category, status: 'error' })
}
const clearDay = () => scope.patch({ day: '' })
const emptyText = computed(() => {
  if (query.value.category) return `${windowText.value}没有「${categoryLabel(query.value.category)}」失败`
  if (query.value.status === 'error') return `${windowText.value}没有失败请求`
  return `${windowText.value}没有请求`
})
const tableEmpty = computed(() => (data.value && data.value.total === 0 ? emptyText.value : '没有数据'))
</script>

<template>
  <div class="ui-grid ureq" :class="{ 'is-busy': busy }" :aria-busy="busy || undefined">
    <UsageState
      v-if="state === 'error' || state === 'forbidden' || state === 'empty'"
      class="c-12"
      :state="state"
      :error="live.error.value"
      :empty-text="`${windowText}没有请求`"
      :action-label="query.day ? '看整个窗口' : filter.days < 90 ? '看近 90 天' : undefined"
      @retry="live.refresh"
      @action="query.day ? clearDay() : scope.patch({ days: '90' })"
    />

    <template v-else>
      <section class="c-12 ureq-errs" aria-label="失败构成">
        <span class="ureq-errs__k">失败</span>
        <template v-if="failures.length">
          <TxButton
            v-for="f in failures"
            :key="f.category"
            variant="ghost"
            size="sm"
            class="ureq-err"
            :class="{ 'is-on': scope.state.category === f.category }"
            :aria-pressed="scope.state.category === f.category"
            @click="toggleCategory(f.category)"
          >
            <span class="ureq-err__code num">{{ f.codes.map((c) => c.code).join('/') || '—' }}</span>
            <span>{{ categoryLabel(f.category) }}</span>
            <span class="ureq-err__n num">×{{ fmtInt(f.count) }}</span>
            <span class="ureq-err__o">{{ f.owner }}</span>
          </TxButton>
        </template>
        <span v-else-if="data" class="ureq-errs__none">{{ windowText }}没有失败</span>
        <span v-else class="ureq-errs__none">读取中…</span>
      </section>

      <Plate title="请求流水" class="c-12 ureq-plate" :state="state === 'stale' ? 'stale' : 'ready'" :stale-at="live.lastAt.value" @retry="live.refresh">
        <template #meta>
          <span v-if="summary" class="num">{{ fmtInt(summary.requests) }} 次 · 失败 {{ fmtInt(summary.errors) }}<template v-if="summary.requests"> · {{ fmtPct(summary.errorRate, 2) }}</template></span>
          <span v-if="data" class="ureq-span num">{{ windowSpan(data.window) }}</span>
        </template>
        <div class="ureq-tools">
          <Segmented :items="STATUS_ITEMS" label="状态" :model-value="scope.state.status" @update:model-value="setStatus(String($event ?? ''))" />
          <TxButton v-if="query.day" variant="secondary" size="sm" class="ureq-chip" @click="clearDay">
            <span>{{ query.day.slice(5).replace('-', '/') }} 全天</span><Icon name="x" :size="12" /><span class="sr-only">清除日期</span>
          </TxButton>
          <TxButton v-if="query.category" variant="secondary" size="sm" class="ureq-chip" @click="toggleCategory(query.category)">
            <span>{{ categoryLabel(query.category) }}</span><Icon name="x" :size="12" /><span class="sr-only">清除失败类别</span>
          </TxButton>
          <span v-if="data && data.total !== summary?.requests" class="ureq-tools__n dim">筛选后 {{ fmtInt(data.total) }} 条</span>
        </div>
        <RowTable
          :columns="columns"
          :data="rows"
          row-key="requestId"
          density="dense"
          :state="data ? 'ready' : 'loading'"
          :skeleton-rows="10"
          :row-tone="(row) => (ok(row) ? null : 'attn')"
          :empty-text="tableEmpty"
          caption="请求流水"
          @row-click="openRow"
        >
          <template #cell-statusCode="{ row }">
            <span class="ureq-st" :class="{ 'is-bad': !ok(row) }">
              <span aria-hidden="true">{{ ok(row) ? '✓' : '◆' }}</span>
              <span class="num">{{ row.statusCode ?? NONE }}</span>
              <span v-if="!ok(row) && row.errorCategory" class="ureq-st__c">{{ categoryLabel(row.errorCategory) }}</span>
            </span>
          </template>
          <template #cell-model="{ row }"><span class="ureq-model">{{ row.model }}</span></template>
          <template #cell-requestId="{ row }"><span class="num dim">{{ row.requestId ? `${row.requestId.slice(0, 8)}…` : NONE }}</span></template>
        </RowTable>
        <Pager
          v-if="data"
          :total="data.total"
          :page-size="data.query.pageSize"
          :page="query.page"
          @update:page="(p: number) => { scope.patch({ page: String(p) }); scope.flush() }"
        />
      </Plate>
    </template>

    <RequestDetailSheet v-model="detailOpen" :request="selected" :category-label="categoryLabel" />
  </div>
</template>

<style>
.ureq { transition: opacity var(--dur-2) linear; }
.ureq.is-busy { opacity: .62; }
html[data-motion="reduce"] .ureq { transition: none; }

/* failure categories: quiet text buttons (hover / pressed = a fill), no box around each, no rules around the strip */
.ureq-errs { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 6px; min-width: 0; }
.ureq-errs__k { margin-right: 2px; font-size: var(--fs-xs); color: var(--ink-3); }
.ureq-errs__none { font-size: var(--fs-sm); color: var(--ink-3); }
html:root .tx-button.ureq-err { max-width: 100%; color: var(--ink); font-size: var(--fs-sm); font-weight: 400; }
html:root .tx-button.ureq-err .tx-button__inner { gap: 6px; align-items: baseline; }
html:root .tx-button.ureq-err.is-on { background: var(--paper-3); }
.ureq-err__code { font-size: var(--fs-xs); color: var(--ink-2); }
.ureq-err__n { font-size: var(--fs-xs); color: var(--ink); }
.ureq-err__o { font-size: var(--fs-xs); color: var(--ink-3); }

.ureq-span { color: var(--ink-3); }
.ureq-tools { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 10px; padding: 4px 0 8px; min-width: 0; }
.ureq-tools__n { margin-left: auto; font-size: var(--fs-xs); }
html:root .tx-button.ureq-chip .tx-button__inner { gap: 6px; }
.ureq-st { display: inline-flex; align-items: baseline; gap: 5px; font-family: var(--font-mono); font-size: var(--fs-sm); color: var(--ink-2); white-space: nowrap; }
.ureq-st.is-bad { color: var(--signal-ink); }
.ureq-st__c { font-family: var(--font-sans); font-size: var(--fs-xs); color: var(--ink-2); }
.ureq-model { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ureq-plate .tx-data-table__row { cursor: pointer; }

@media (max-width: 959px) {
  .ureq-span { display: none; }
  .ureq-err__o { display: none; }
}
</style>
