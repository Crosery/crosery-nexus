<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import Plate from '../../../ui/data/Plate.vue'
import Readout from '../../../ui/viz/Readout.vue'
import RankList from '../../../ui/viz/RankList.vue'
import Segmented from '../../../ui/form/Segmented.vue'
import { useLive } from '../../../ui/composables/useLive'
import { useBreakpoint } from '../../../ui/composables/useBreakpoint'
import { fmtDuration, fmtInt, fmtPct, fmtTime, splitUnit } from '../../../ui/fmt'
import type { DataState, RankRow } from '../../../ui/types'
import TimeChart from './insight/TimeChart.vue'
import LatencyRows from './insight/LatencyRows.vue'
import { insightApi, isNotDeployed } from './insight/api'
import { categoryLabel } from '../shared/format'
import {
  bucketLabel, ERROR_RATE_ATTN, hasNarrowing, scopeFromQuery, scopeQuery, spreadText, SUCCESS_ATTN, windowLabel,
  type ChartPoint, type PerformanceReport,
} from './insight/model'
import './insight/insight.css'

/**
 * 用量 · 性能 (DESIGN §6.7): 哪个上游 / 模型慢（首字与耗时的 P50 / P95）、失败率怎么变、失败是谁的问题。
 * Filters are the shared usage filters in the URL (../filters.ts keys); this tab only reads them.
 * One poll loop (30s; the server caches 20s). Latency is over successful requests only — the basis line says so.
 */
const route = useRoute()
const router = useRouter()
const { isMobile, isCompact } = useBreakpoint()
const scope = computed(() => scopeFromQuery(route.query))

/** set once the server answered 404 (route not deployed yet): the timer stops instead of polling a 404 */
let parked = false
const live = useLive<PerformanceReport>((signal) => insightApi.performance(scope.value, signal), {
  intervalMs: 30_000,
  isEmpty: (d) => d.totals.requests === 0,
  enabled: () => !parked,
})
const notDeployed = computed(() => live.data.value === undefined && isNotDeployed(live.error.value))
watch(notDeployed, (value) => (parked = value))
watch(() => scopeQuery(scope.value), () => {
  parked = false
  void live.refresh()
})

const report = computed(() => live.data.value)
const state = computed<DataState>(() => (notDeployed.value ? 'empty' : live.state.value))
/** with nothing to draw, one plate carries the line (empty / error / forbidden), not seven copies of it */
const solo = computed(() => state.value === 'empty' || state.value === 'error' || state.value === 'forbidden')
const win = computed(() => windowLabel(report.value?.days ?? scope.value.days))
const emptyText = computed(() =>
  notDeployed.value ? '服务端还没有这个接口 · 控制台服务重启后可用' : `${win.value}没有请求${hasNarrowing(scope.value) ? ' · 当前筛选下' : ''}`,
)
const emptyAction = computed(() => (!notDeployed.value && scope.value.days < 30 ? '看近 30 天' : undefined))
function widen() {
  void router.replace({ query: { ...route.query, days: '30' } })
}
const plateProps = computed(() => ({
  state: state.value,
  error: live.error.value,
  staleAt: live.lastAt.value,
  emptyText: emptyText.value,
  emptyAction: emptyAction.value,
}))
const asOf = computed(() => (report.value ? `${win.value} · 截至 ${fmtTime(report.value.to)}` : win.value))

/* 01 汇总 */
const totals = computed(() => report.value?.totals)
const success = computed(() => splitUnit(fmtPct(totals.value?.successRate ?? null, 2)))
const topError = computed(() => report.value?.errors[0] ?? null)
const successAttn = computed(() => totals.value?.successRate !== null && totals.value?.successRate !== undefined && totals.value.successRate < SUCCESS_ATTN)

/* 02 延迟趋势 */
const metric = ref<'latency' | 'ttft'>('latency')
const METRICS = [
  { value: 'latency', label: '耗时' },
  { value: 'ttft', label: '首字' },
]
const latencySeries = computed(() => [
  { key: 'p95', label: 'P95', tone: 'k1' as const },
  { key: 'p50', label: 'P50', tone: 'k3' as const, dashed: true },
])
const latencyPoints = computed<ChartPoint[]>(() =>
  (report.value?.trend ?? []).map((p) => {
    const s = metric.value === 'latency' ? p.latency : p.ttft
    return { t: p.t, v: { p50: s?.p50 ?? null, p95: s?.p95 ?? null }, bar: p.requests, hot: p.errors }
  }),
)
const fmtMs = (v: number | null) => fmtDuration(v)
const fmtCount = (v: number | null) => fmtInt(v)

/* 04 失败率趋势 */
const errorPoints = computed<ChartPoint[]>(() =>
  (report.value?.trend ?? []).map((p) => ({ t: p.t, v: { rate: p.errorRate }, bar: p.requests, hot: p.errors })),
)
const fmtRateAxis = (v: number | null) => fmtPct(v, 0)
const peakErrorBucket = computed(() => {
  let best: { t: number; rate: number; errors: number } | null = null
  for (const p of report.value?.trend ?? []) if (p.errorRate !== null && p.errors > 0 && (!best || p.errorRate > best.rate)) best = { t: p.t, rate: p.errorRate, errors: p.errors }
  return best
})

/* 03 失败构成 */
const errorRows = computed<RankRow[]>(() =>
  (report.value?.errors ?? []).map((e) => ({
    key: e.category,
    name: categoryLabel(e.category),
    sub: [e.owner, ...e.codes.slice(0, 3).map((c) => `${c.code || '无状态码'} ×${fmtInt(c.count)}`)].join(' · '),
    value: e.count,
    share: e.share,
  })),
)

/* 05 最慢的上游 */
const slowest = computed<RankRow[]>(() =>
  (report.value?.byChannel ?? [])
    .filter((c) => c.latency?.p95 != null)
    .sort((a, b) => (b.latency?.p95 ?? 0) - (a.latency?.p95 ?? 0))
    // only P50 beside the P95 value: 首字 and n are in 按渠道 right below (no duplicated meta line)
    .map((c) => ({
      key: c.id,
      name: c.removed ? `${c.label} · 已移除` : c.label,
      value: c.latency?.p95 ?? null,
      sub: `P50 ${fmtDuration(c.latency?.p50)}`,
    })),
)

/* 07 按模型 */
const MODEL_LIMIT = 12
const showAllModels = ref(false)
const models = computed(() => report.value?.byModel ?? [])
const visibleModels = computed(() => (showAllModels.value ? models.value : models.value.slice(0, MODEL_LIMIT)))
const chartH = computed(() => (isCompact.value ? 120 : isMobile.value ? 140 : 168))
const now = computed(() => (report.value ? Date.parse(report.value.to) : Date.now()))
</script>

<template>
  <div class="ui-grid uxi">
    <Plate title="汇总" class="c-12" v-bind="plateProps" :rows="2" @retry="live.refresh" @empty-action="widen">
      <template #meta><span>{{ asOf }}</span><span v-if="report" class="uxi-basis">{{ report.basis }}</span></template>
      <div v-if="report && totals" class="uxi-ledger is-4">
        <Readout label="请求" :value="fmtInt(totals.requests)" :state="state">
          <template #sub><span>失败 <b class="num" :class="{ sig: totals.errors > 0 && successAttn }">{{ fmtInt(totals.errors) }}</b></span></template>
        </Readout>
        <Readout label="成功率" :value="success.value" :unit="success.unit" :state="state">
          <template #sub>
            <span v-if="topError" :class="{ sig: successAttn }">{{ successAttn ? '◆ ' : '' }}主因 {{ categoryLabel(topError.category) }} {{ fmtInt(topError.count) }}</span>
            <span v-else>没有失败</span>
          </template>
        </Readout>
        <Readout label="耗时 P50 / P95" :value="spreadText(totals.latency)" :size="isCompact ? 'sm' : 'md'" :roll="false" :state="state">
          <template #sub><span>成功请求 · n {{ fmtInt(totals.latency?.n) }}</span></template>
        </Readout>
        <Readout label="首字 P50 / P95" :value="spreadText(totals.ttft)" :size="isCompact ? 'sm' : 'md'" :roll="false" :state="state">
          <template #sub><span>流式请求 · n {{ fmtInt(totals.ttft?.n) }}</span></template>
        </Readout>
      </div>
    </Plate>

    <Plate v-if="!solo" title="延迟趋势" class="c-8" v-bind="plateProps" :rows="5" @retry="live.refresh" @empty-action="widen">
      <template #meta><span v-if="report">{{ bucketLabel(report.bucketMs) }} · 对数刻度</span></template>
      <template #actions><Segmented v-model="metric" :items="METRICS" label="延迟口径" /></template>
      <TimeChart
        v-if="report"
        :points="latencyPoints"
        :series="latencySeries"
        :bucket-ms="report.bucketMs"
        :label="`${win}${metric === 'latency' ? '耗时' : '首字'} P50 与 P95`"
        :format="fmtMs"
        scale="log"
        :h="chartH"
        :now="now"
        :strip="{ label: '请求', hotLabel: '失败', format: fmtCount }"
      >
        <template #readout="{ point, range }">
          <b>{{ range }}</b>
          <span> · P50 <b>{{ fmtDuration(point.v.p50) }}</b></span>
          <span> · P95 <b>{{ fmtDuration(point.v.p95) }}</b></span>
          <span> · 请求 <b>{{ fmtInt(point.bar) }}</b></span>
          <span v-if="point.hot"> · 失败 <b class="sig">{{ fmtInt(point.hot) }}</b></span>
        </template>
      </TimeChart>
    </Plate>

    <Plate v-if="!solo" title="失败构成" class="c-4 stretch" v-bind="plateProps" :rows="5" @retry="live.refresh" @empty-action="widen">
      <template #meta><span v-if="report">{{ fmtInt(report.totals.errors) }} 次 · 谁的问题</span></template>
      <RankList :rows="errorRows" :format="fmtCount" :limit="8" :empty-text="`— ${win}没有失败`" />
    </Plate>

    <Plate v-if="!solo" title="失败率趋势" class="c-8" v-bind="plateProps" :rows="4" @retry="live.refresh" @empty-action="widen">
      <template #meta>
        <span v-if="peakErrorBucket">最高 <b class="num">{{ fmtPct(peakErrorBucket.rate) }}</b> @ {{ fmtTime(peakErrorBucket.t) }}</span>
        <span v-if="peakErrorBucket && peakErrorBucket.rate > ERROR_RATE_ATTN" class="sig">◆ 高于 {{ fmtPct(ERROR_RATE_ATTN, 0) }}</span>
      </template>
      <TimeChart
        v-if="report"
        :points="errorPoints"
        :series="[{ key: 'rate', label: '失败率', tone: 'k1' }]"
        :bucket-ms="report.bucketMs"
        :label="`${win}失败率`"
        :format="fmtRateAxis"
        :h="isCompact ? 96 : 120"
        :now="now"
        :reference="{ value: ERROR_RATE_ATTN, label: `${fmtPct(ERROR_RATE_ATTN, 0)} 注意线` }"
        :hot-above="ERROR_RATE_ATTN"
        :strip="{ label: '请求', hotLabel: '失败', format: fmtCount }"
      >
        <template #readout="{ point, range }">
          <b>{{ range }}</b>
          <span> · 失败率 <b :class="{ sig: (point.v.rate ?? 0) > ERROR_RATE_ATTN }">{{ fmtPct(point.v.rate) }}</b></span>
          <span> · 失败 <b>{{ fmtInt(point.hot ?? 0) }}</b> / {{ fmtInt(point.bar) }}</span>
        </template>
      </TimeChart>
    </Plate>

    <Plate v-if="!solo" title="最慢的上游" class="c-4 stretch" v-bind="plateProps" :rows="4" @retry="live.refresh" @empty-action="widen">
      <template #meta><span>按耗时 P95</span></template>
      <RankList :rows="slowest" :format="fmtMs" :show-share="false" :limit="6" :empty-text="`— ${win}没有成功请求`" />
    </Plate>

    <Plate v-if="!solo" title="按渠道" class="c-12" v-bind="plateProps" :rows="3" @retry="live.refresh" @empty-action="widen">
      <template #meta><span v-if="report">{{ report.byChannel.length }} 个渠道 · 成功率低于 {{ fmtPct(SUCCESS_ATTN, 0) }} 标出</span></template>
      <LatencyRows v-if="report" :rows="report.byChannel" name-label="渠道" />
    </Plate>

    <Plate v-if="!solo" title="按模型" class="c-12" v-bind="plateProps" :rows="6" @retry="live.refresh" @empty-action="widen">
      <template #meta><span v-if="report">{{ models.length }} 个模型 · 按请求数</span></template>
      <LatencyRows v-if="report" :rows="visibleModels" name-label="模型" />
      <template v-if="models.length > MODEL_LIMIT" #footer>
        <span>{{ showAllModels ? `全部 ${models.length} 个` : `其余 ${models.length - MODEL_LIMIT} 个模型` }}</span>
        <button type="button" class="ui-link" :aria-expanded="showAllModels" @click="showAllModels = !showAllModels">{{ showAllModels ? '收起' : '展开' }}</button>
      </template>
    </Plate>
  </div>
</template>
