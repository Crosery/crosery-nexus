<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue'
import { useRoute } from 'vue-router'
import { TxButton } from '@talex-touch/tuffex/button'
import PageHead from '../../ui/shell/PageHead.vue'
import Plate from '../../ui/data/Plate.vue'
import Segmented from '../../ui/form/Segmented.vue'
import Heatmap from '../../ui/viz/Heatmap.vue'
import HeatYears from '../../ui/viz/HeatYears.vue'
import RankList from '../../ui/viz/RankList.vue'
import { dayBounds, heatSummary, type HeatMetric, type HeatSeries, type HeatYear } from '../../ui/viz/heatModel'
import { useLive } from '../../ui/composables/useLive'
import { useBreakpoint } from '../../ui/composables/useBreakpoint'
import { fmtCompact, fmtInt, fmtPct, fmtTime, fmtUsd, NONE } from '../../ui/fmt'
import { useQueryState } from '../../lib/listState'
import { errorMessage } from '../../lib/errors'
import { isReducedMotion } from '../../lib/motion'
import { api } from '../../api'
import FailureCauses from './FailureCauses.vue'
import MeRequestTable from './MeRequestTable.vue'
import type { MeUsageX } from './meModel'
import type { MeRequestItem } from '../../types'
import type { DataState, RankRow } from '../../ui/types'

/**
 * /me/usage (DESIGN §6.10): this key only. A year of days as a contribution graph (day card on click, a dragged
 * span opens its own requests), spend by model, failures by cause in plain words, and its own requests
 * (newest first, `更多` pages back). No Key / 渠道 / 客户端 filters exist here. Totals cover every request
 * the key made, so they agree with the request list and the quota ledger.
 */
const RANGES = [
  { value: '7', label: '7 天' },
  { value: '30', label: '30 天' },
  { value: '90', label: '90 天' },
]
const METRICS = [
  { value: 'tokens', label: 'Token' },
  { value: 'requests', label: '请求' },
  { value: 'cost', label: '花费' },
]
const STATUS_ITEMS = [
  { value: 'all', label: '全部' },
  { value: 'error', label: '失败' },
]
const route = useRoute()
const scope = useQueryState({ days: '7', status: 'all', metric: 'tokens', before: '', after: '' })
const days = computed<7 | 30 | 90>(() => (scope.state.days === '30' ? 30 : scope.state.days === '90' ? 90 : 7))

const range = useLive<MeUsageX>((signal) => api.me.usage(days.value, signal) as Promise<MeUsageX>, {
  intervalMs: 60_000,
  isEmpty: (data) => data.totals.requests === 0,
})
/** heatmap: a year of this key's days (the last 53 weeks, or a calendar year), independent of the range above */
const heatYear = ref<HeatYear>('recent')
const heat = useLive<HeatSeries>((signal) => api.me.usageDaily(heatYear.value, signal), { intervalMs: 5 * 60_000 })
watch(heatYear, () => void heat.refresh())
watch(days, () => void range.refresh())
/** the window the server actually answered for (capped by USAGE_RETENTION_DAYS), not the one asked for */
const shownDays = computed(() => range.data.value?.days ?? days.value)

/* ── head ── */
const totals = computed(() => range.data.value?.totals)
const anyPriced = computed(() => (range.data.value?.models ?? []).some((m) => m.costUsd !== null))
const costText = computed(() => {
  const t = totals.value
  if (!t) return NONE
  return t.costUsd === null ? '未定价' : fmtUsd(t.costUsd, { approx: t.unpricedRequests > 0 })
})
const headStatus = computed(() => {
  const t = totals.value
  if (!t) return ''
  // calendar window (today + the N−1 days before it), not the admin pages' rolling 近 N 天: say so
  if (t.requests === 0) return `近 ${shownDays.value} 个自然日没有调用`
  const parts = [`近 ${shownDays.value} 个自然日`, `${fmtInt(t.requests)} 次`, `${fmtCompact(t.tokens)} token`, costText.value]
  if (t.costUsd !== null && t.unpricedRequests) parts.push(`未定价 ${fmtInt(t.unpricedRequests)} 次不计`)
  // failures are not repeated here: the 失败 plate's meta carries the count and rate
  return parts.join(' · ')
})

/* ── heatmap ── */
const metric = computed<HeatMetric>(() => (scope.state.metric === 'requests' || scope.state.metric === 'cost' ? scope.state.metric : 'tokens'))
const series = computed(() => heat.data.value ?? null)
const heatApprox = computed(() => Boolean(series.value && series.value.totals.unpricedRequests > 0 && series.value.totals.costUsd !== null))
const heatTitle = computed(() => heatSummary(series.value, metric.value, heatYear.value, { compact: fmtCompact, int: fmtInt, usd: (v: number) => fmtUsd(v, { approx: heatApprox.value }) }))
const heatState = computed(() => (heat.state.value === 'empty' ? 'ready' : heat.state.value))
/** a day / span as the request-list range [start, end) on the series' calendar */
function requestsLink(from: string, to: string) {
  const offset = series.value?.range.offsetMinutes
  if (offset === undefined) return null
  const start = dayBounds(from, offset).start
  const end = dayBounds(to, offset).end
  return { path: '/me/usage', query: { ...route.query, before: new Date(end).toISOString(), after: new Date(start).toISOString(), status: undefined }, hash: '#requests' }
}
const dayLink = (day: string) => requestsLink(day, day)

/* ── by model: 14 rows (8 on a phone) until `全部 N 个` ── */
const { isMobile } = useBreakpoint()
const modelLimit = computed(() => (isMobile.value ? 8 : 14))
const showAllModels = ref(false)
const modelRows = computed<RankRow[]>(() =>
  [...(range.data.value?.models ?? [])]
    .sort((a, b) => (anyPriced.value ? (b.costUsd ?? -1) - (a.costUsd ?? -1) : 0) || b.tokens - a.tokens)
    .map((m) => ({
      key: m.model,
      name: m.model,
      value: anyPriced.value ? m.costUsd : m.tokens,
      err: m.requests ? m.errors / m.requests : null,
      sub: `${fmtInt(m.requests)} 次 · ${fmtCompact(m.tokens)} token`,
    })),
)
const modelFormat = (value: number | null) => (value === null ? (anyPriced.value ? '未定价' : NONE) : anyPriced.value ? fmtUsd(value) : fmtCompact(value))

/* ── 03 failures ── */
const failures = computed(() => range.data.value?.failures)
const failureFallback = computed<RankRow[]>(() =>
  (range.data.value?.models ?? []).filter((m) => m.errors > 0).sort((a, b) => b.errors - a.errors).map((m) => ({ key: m.model, name: m.model, value: m.errors })),
)
const failState = computed<DataState>(() => {
  const s = range.state.value
  if (s !== 'ready' && s !== 'stale') return s
  return (totals.value?.errors ?? 0) === 0 ? 'empty' : s
})
function showFailures() {
  scope.state.status = 'error'
  scope.state.before = ''
  scope.state.after = ''
  document.getElementById('requests')?.scrollIntoView({ behavior: isReducedMotion() ? 'auto' : 'smooth', block: 'start' })
}

/* ── 04 own requests: newest first, `更多` appends older pages ── */
const items = shallowRef<MeRequestItem[]>([])
const nextBefore = ref<string | null>(null)
const reqState = ref<DataState>('loading')
const reqError = shallowRef<unknown>(null)
const loadingMore = ref(false)
let seq = 0

async function loadRequests(append = false) {
  const mine = ++seq
  if (append) loadingMore.value = true
  else if (!items.value.length) reqState.value = 'loading'
  try {
    const before = append ? nextBefore.value : scope.state.before || null
    const after = scope.state.after || null
    const page = await api.me.requests({ limit: 50, before, after, status: scope.state.status === 'error' ? 'error' : 'all' })
    if (mine !== seq) return
    // the server stops at `after`; a server without it (not yet restarted) would page on into the day before
    const floor = after ? Date.parse(after) : NaN
    const kept = Number.isFinite(floor) ? page.items.filter((item) => Date.parse(item.timestamp) >= floor) : page.items
    items.value = append ? [...items.value, ...kept] : kept
    nextBefore.value = kept.length < page.items.length ? null : page.nextBefore
    reqError.value = null
    reqState.value = items.value.length ? 'ready' : 'empty'
  } catch (error) {
    if (mine !== seq) return
    reqError.value = error
    reqState.value = items.value.length ? 'stale' : 'error'
  } finally {
    if (mine === seq) loadingMore.value = false
  }
}
watch(() => [scope.state.status, scope.state.before, scope.state.after], () => {
  items.value = []
  nextBefore.value = null
  void loadRequests()
}, { immediate: true })
const reqEmpty = computed(() => {
  if (scope.state.status === 'error') return scope.state.after ? '这一天没有失败的请求' : '没有失败的请求'
  return scope.state.after ? '这一天没有请求' : scope.state.before ? '这之前没有请求' : '还没有请求记录'
})
/** `2026-10-01 当日` when the list is one day (its server day if the heat grid has it), else `<time> 之前` */
const cursorDay = computed(() => {
  const after = scope.state.after ? Date.parse(scope.state.after) : NaN
  if (!Number.isFinite(after)) return null
  const offset = series.value?.range.offsetMinutes
  if (offset !== undefined) {
    const before = scope.state.before ? Date.parse(scope.state.before) : NaN
    const day = new Date(after + offset * 60_000).toISOString().slice(0, 10)
    const bounds = dayBounds(day, offset)
    if (bounds.start === after) {
      if (!Number.isFinite(before) || before === bounds.end) return `${day} 当日`
      const last = new Date(before - 1 + offset * 60_000).toISOString().slice(0, 10)
      if (dayBounds(last, offset).end === before) return `${day} → ${last}`
    }
  }
  return `${fmtTime(after)} 起`
})
function backToLatest() {
  scope.state.before = ''
  scope.state.after = ''
}
</script>

<template>
  <div class="ui-page me-usage">
    <PageHead title="用量" plain :status="headStatus">
      <template #actions>
        <Segmented v-model="scope.state.days" :items="RANGES" label="时间范围" />
      </template>
    </PageHead>

    <div class="me-usage__grid">
      <div class="me-usage__col me-usage__l">
        <Plate :title="heatTitle" class="me-usage__p1" :state="heatState" :error="heat.error.value" :rows="7" :stale-at="heat.lastAt.value" @retry="heat.refresh">
          <template #actions>
            <HeatYears v-if="series" v-model="heatYear" :years="series.years" />
            <Segmented v-model="scope.state.metric" :items="METRICS" label="热力图指标" />
          </template>
          <Heatmap :series="series" :metric="metric" :approx="heatApprox" :day-link="dayLink" :span-link="requestsLink" span-link-text="查看这段请求 →" />
        </Plate>

        <Plate title="失败" class="me-usage__p3" :state="failState" :error="range.error.value" :rows="4" :stale-at="range.lastAt.value" :empty-text="`近 ${shownDays} 个自然日没有失败`" @retry="range.refresh">
          <template #meta><span v-if="totals?.errors">{{ fmtInt(totals.errors) }} 次 · {{ fmtPct(totals.requests ? totals.errors / totals.requests : null) }}</span></template>
          <FailureCauses v-if="failures" :failures="failures" :total="totals?.requests ?? 0" selectable @select="showFailures" />
          <RankList v-else :rows="failureFallback" :format="(v) => `${fmtInt(v)} 次`" :limit="6" :show-share="false" />
        </Plate>
      </div>

      <div class="me-usage__col me-usage__r">
        <Plate :title="anyPriced ? '按模型 · 花费' : '按模型 · Token'" class="me-usage__p2" :state="range.state.value" :error="range.error.value" :rows="8" :stale-at="range.lastAt.value" :empty-text="`近 ${shownDays} 个自然日没有调用`" @retry="range.refresh">
          <RankList :rows="modelRows" :format="modelFormat" :limit="showAllModels ? modelRows.length : modelLimit" />
          <button v-if="modelRows.length > modelLimit" type="button" class="ui-link me-usage__toggle" :aria-expanded="showAllModels" @click="showAllModels = !showAllModels">
            {{ showAllModels ? '收起' : `全部 ${modelRows.length} 个 →` }}
          </button>
        </Plate>
      </div>

      <Plate id="requests" title="我的请求" class="me-usage__p4" flush :state="reqState" :error="reqError" :rows="8" :empty-text="reqEmpty" @retry="loadRequests()">
        <template #meta>
          <span v-if="cursorDay" class="me-usage__cursor">
            <span class="num">{{ cursorDay }}</span>
            <button type="button" class="ui-link" @click="backToLatest">回到最新</button>
          </span>
          <span v-else-if="scope.state.before" class="me-usage__cursor">
            <span class="num">{{ fmtTime(scope.state.before) }}</span> 之前
            <button type="button" class="ui-link" @click="backToLatest">回到最新</button>
          </span>
        </template>
        <template #actions>
          <Segmented v-model="scope.state.status" :items="STATUS_ITEMS" label="请求状态" />
        </template>
        <MeRequestTable :items="items" full />
        <div v-if="nextBefore || reqState === 'stale'" class="me-usage__more">
          <TxButton v-if="nextBefore" variant="secondary" size="sm" :loading="loadingMore" :disabled="loadingMore" @click="loadRequests(true)">{{ loadingMore ? '读取中…' : '更早的 50 条' }}</TxButton>
          <span class="num dim">已显示 {{ fmtInt(items.length) }} 条</span>
          <span v-if="reqState === 'stale'" class="dim2">◇ {{ errorMessage(reqError) || '读取失败' }}</span>
        </div>
      </Plate>
    </div>
  </div>
</template>

<style>
.me-usage__grid { display: grid; grid-template-columns: repeat(12, minmax(0, 1fr)); gap: 26px var(--gutter); align-items: start; }
.me-usage__col { display: flex; flex-direction: column; gap: 26px; min-width: 0; }
.me-usage__l { grid-column: span 7; }
.me-usage__r { grid-column: span 5; }
.me-usage__p4 { grid-column: 1 / -1; scroll-margin-top: 64px; }
.me-usage__toggle { margin-top: 8px; }
.me-usage__cursor { display: inline-flex; align-items: baseline; gap: 6px; color: var(--ink-2); }
.me-usage__more { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px; padding: 10px 0 12px; }
.me-usage .dim { color: var(--ink-3); font-size: var(--fs-xs); }
.me-usage .dim2 { color: var(--ink-2); font-size: var(--fs-xs); }
@media (max-width: 1179px) {
  .me-usage__l { display: contents; }
  .me-usage__p1 { grid-column: 1 / -1; order: 1; }
  .me-usage__r { grid-column: span 7; order: 2; }
  .me-usage__p3 { grid-column: span 5; order: 3; }
  .me-usage__p4 { order: 4; }
}
@media (max-width: 959px) {
  .me-usage__grid { grid-template-columns: minmax(0, 1fr); gap: 22px; }
  .me-usage__r { display: contents; }
  .me-usage__p2 { order: 2; }
  .me-usage__p3 { grid-column: 1 / -1; }
}
</style>
