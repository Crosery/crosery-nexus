<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { TxCollapse, TxCollapseItem } from '@talex-touch/tuffex/collapse'
import { TxTag } from '@talex-touch/tuffex/tag'
import Plate from '../../../ui/data/Plate.vue'
import RowTable from '../../../ui/data/RowTable.vue'
import StatusMark from '../../../ui/data/StatusMark.vue'
import Readout from '../../../ui/viz/Readout.vue'
import ShareBar from '../../../ui/viz/ShareBar.vue'
import TickMeter from '../../../ui/viz/TickMeter.vue'
import { useLive } from '../../../ui/composables/useLive'
import { useBreakpoint } from '../../../ui/composables/useBreakpoint'
import { useNow } from '../../../ui/composables/useNow'
import { fmtClock, fmtCompact, fmtDuration, fmtInt, fmtPct, fmtTime, fmtUsd, NONE, splitUnit } from '../../../ui/fmt'
import type { DataState, RowColumn, ShareSegment } from '../../../ui/types'
import { CLIENT_LABELS } from '../../../clientLabels'
import TimeChart from './insight/TimeChart.vue'
import { insightApi, isNotDeployed } from './insight/api'
import {
  bucketLabel, hasNarrowing, hitBasisWords, mergeLive, savingsWords, scopeFromQuery, scopeQuery, windowLabel,
  type CacheStat, type CacheSummary, type ChartPoint, type LiveEvent,
} from './insight/model'
import './insight/insight.css'

/**
 * 用量 · 缓存 (DESIGN §6.0, §6.7): 支持缓存的模型命中率多少、扣掉写入成本省了多少、哪些模型 / 客户端没吃到缓存，
 * 以及一条不受时间筛选的实时流（上下文长度 + 超缓存上限标记）。Filters come from the shared usage URL keys.
 * Hit rate never counts models that cannot cache; they are listed as 不支持缓存 · 不计入 instead of a red 0%.
 */
const route = useRoute()
const router = useRouter()
const { isMobile, isWide, isCompact } = useBreakpoint()
const scope = computed(() => scopeFromQuery(route.query))
const now = useNow()

/* ── summary (polled) ── */
let parked = false
const live = useLive<CacheSummary>((signal) => insightApi.cacheSummary(scope.value, signal), {
  intervalMs: 30_000,
  isEmpty: (d) => d.totals.requests === 0 && d.excluded.requests === 0,
  enabled: () => !parked,
})
const notDeployed = computed(() => live.data.value === undefined && isNotDeployed(live.error.value))
watch(notDeployed, (value) => (parked = value))

const summary = computed(() => live.data.value)
const state = computed<DataState>(() => (notDeployed.value ? 'empty' : live.state.value))
const solo = computed(() => state.value === 'empty' || state.value === 'error' || state.value === 'forbidden')
const win = computed(() => windowLabel(summary.value?.days ?? scope.value.days))
const emptyText = computed(() =>
  notDeployed.value ? '服务端还没有这个接口 · 控制台服务重启后可用' : `${win.value}没有请求${hasNarrowing(scope.value) ? ' · 当前筛选下' : ''}`,
)
const emptyAction = computed(() => (!notDeployed.value && scope.value.days < 30 ? '看近 30 天' : undefined))
const widen = () => void router.replace({ query: { ...route.query, days: '30' } })
const plateProps = computed(() => ({
  state: state.value,
  error: live.error.value,
  staleAt: live.lastAt.value,
  emptyText: emptyText.value,
  emptyAction: emptyAction.value,
}))
const asOf = computed(() => (summary.value ? `${win.value} · 截至 ${fmtTime(summary.value.to)}` : win.value))
const totals = computed(() => summary.value?.totals)
/** headline money: never $0.00 / n/a (DESIGN §6.0 rule 3) */
const money = computed(() => (totals.value ? savingsWords(totals.value.savings, (v) => fmtUsd(v)) : null))
const hit = computed(() => splitUnit(fmtPct(totals.value?.hitRate ?? null)))
const shareOf = (part: number, whole: number) => (whole > 0 ? fmtPct(part / whole) : NONE)
const usd = (v: number | null | undefined, approx = false) => (v === null || v === undefined ? NONE : fmtUsd(v, { approx }))
/** table cells: the column head carries the ≈, cells stay plain */
const savingsCell = (row: CacheStat) => {
  if (row.savingsUsd === null) return row.unpricedRequests > 0 ? '未定价' : NONE
  if (row.savingsUsd === 0) return row.cacheReadTokens + row.cacheWriteTokens === 0 ? '无命中' : '$0'
  return fmtUsd(row.savingsUsd)
}

/* ── 02 trend ── */
const trendPoints = computed<ChartPoint[]>(() => (summary.value?.trend ?? []).map((p) => ({ t: p.t, v: { hit: p.hitRate }, bar: p.requests })))
const trendByT = computed(() => new Map((summary.value?.trend ?? []).map((p) => [p.t, p])))
const fmtRate = (v: number | null) => fmtPct(v, 0)
const fmtCount = (v: number | null) => fmtInt(v)
const summaryTo = computed(() => (summary.value ? Date.parse(summary.value.to) : Date.now()))

/* ── 03 prompt mix ── */
const mixSegments = computed<ShareSegment[]>(() => {
  const t = totals.value
  if (!t) return []
  return [
    { key: 'fresh', label: '新输入', value: t.freshInputTokens, tone: 'k1' },
    { key: 'read', label: '缓存读', value: t.cacheReadTokens, tone: 'k5' },
    { key: 'write', label: '缓存写', value: t.cacheWriteTokens, tone: 'k3' },
  ]
})

/* ── 04 / 05 tables ── */
type ModelRow = CacheSummary['byModel'][number]
type ClientRow = CacheSummary['byClient'][number]
const MODEL_LIMIT = 10
const showAllModels = ref(false)
const modelRows = computed(() => {
  const rows = summary.value?.byModel ?? []
  return showAllModels.value ? rows : rows.slice(0, MODEL_LIMIT)
})
const modelColumns = computed<RowColumn<ModelRow>[]>(() => {
  const cols: RowColumn<ModelRow>[] = [
    { key: 'label', title: '模型', card: 'primary' },
    { key: 'hit', title: '命中率', width: 128, align: 'right', card: 'meta' },
    { key: 'requests', title: '请求', width: 64, align: 'right', card: 'line2', cardLabel: '请求', format: (_v, r) => fmtInt(r.requests) },
    { key: 'read', title: '缓存读', width: 76, align: 'right', card: 'line2', cardLabel: '读', format: (_v, r) => fmtCompact(r.cacheReadTokens) },
  ]
  if (!isMobile.value) cols.push({ key: 'write', title: '缓存写', width: 72, align: 'right', format: (_v, r) => fmtCompact(r.cacheWriteTokens) })
  cols.push({ key: 'savings', title: '净节省 ≈', width: 84, align: 'right', card: 'line2', cardLabel: '省', format: (_v, r) => savingsCell(r) })
  cols.push({ key: 'over', title: '超上限', width: 60, align: 'right', card: 'line3' })
  return cols
})
const clientColumns: RowColumn<ClientRow>[] = [
  { key: 'label', title: '客户端', card: 'primary' },
  { key: 'hit', title: '命中率', width: 128, align: 'right', card: 'meta' },
  { key: 'requests', title: '请求', width: 64, align: 'right', card: 'line2', cardLabel: '请求', format: (_v, r) => fmtInt(r.requests) },
  { key: 'read', title: '缓存读', width: 76, align: 'right', card: 'line2', cardLabel: '读', format: (_v, r) => fmtCompact(r.cacheReadTokens) },
  { key: 'savings', title: '净节省 ≈', width: 84, align: 'right', card: 'line2', cardLabel: '省', format: (_v, r) => savingsCell(r) },
]

/* ── 06 live stream (SSE, never filtered by time) ── */
const LIVE_LIMIT = 50
const events = shallowRef<LiveEvent[]>([])
const streamState = ref<'connecting' | 'live' | 'down'>('connecting')
const retryAt = ref(0)
const lastEventAt = ref<number | null>(null)
let source: EventSource | null = null
let retryTimer: ReturnType<typeof setTimeout> | null = null
let failures = 0
let disposed = false

const parse = (data: string): LiveEvent[] => {
  try {
    const rows = JSON.parse(data) as unknown
    return Array.isArray(rows) ? (rows as LiveEvent[]) : []
  } catch {
    return []
  }
}
function closeStream() {
  source?.close()
  source = null
  if (retryTimer) clearTimeout(retryTimer)
  retryTimer = null
}
function openStream(reset = false) {
  closeStream()
  if (disposed || (typeof document !== 'undefined' && document.hidden)) return
  if (reset) events.value = []
  streamState.value = 'connecting'
  const es = new EventSource(insightApi.cacheLiveUrl(scope.value, LIVE_LIMIT))
  source = es
  es.addEventListener('open', () => {
    if (source === es) streamState.value = 'live'
  })
  es.addEventListener('history', (e) => {
    if (source !== es) return
    events.value = mergeLive([], parse((e as MessageEvent).data), LIVE_LIMIT)
    streamState.value = 'live'
    failures = 0
  })
  es.addEventListener('usage', (e) => {
    if (source !== es) return
    events.value = mergeLive(events.value, parse((e as MessageEvent).data), LIVE_LIMIT)
    lastEventAt.value = Date.now()
    streamState.value = 'live'
  })
  // network drop, server 503 (connection cap) or a server-sent `event: error`: back off 5s → 10s → … ≤ 60s
  es.addEventListener('error', () => {
    if (source !== es) return
    closeStream()
    failures += 1
    const wait = Math.min(60_000, 5_000 * 2 ** Math.min(failures - 1, 4))
    streamState.value = 'down'
    retryAt.value = Date.now() + wait
    retryTimer = setTimeout(() => openStream(), wait)
  })
}
function onVisibility() {
  if (document.hidden) closeStream()
  else openStream()
}
onMounted(() => {
  openStream(true)
  document.addEventListener('visibilitychange', onVisibility)
})
onBeforeUnmount(() => {
  disposed = true
  closeStream()
  document.removeEventListener('visibilitychange', onVisibility)
})
watch(() => scopeQuery(scope.value), (next, prev) => {
  parked = false
  void live.refresh()
  // the stream follows Key / 模型 / 客户端 / 渠道, never the time window
  const streamKey = (q: string) => q.replace(/(^|&)days=[^&]*/, '')
  if (streamKey(next) !== streamKey(prev ?? '')) {
    failures = 0
    openStream(true)
  }
})
const retryIn = computed(() => {
  const s = Math.max(0, Math.ceil((retryAt.value - now.value) / 1000))
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
})
const reconnectNow = () => {
  failures = 0
  openStream()
}

const ceilingK = computed(() => fmtCompact(summary.value?.ceiling ?? 663_000))
const liveCost = (e: LiveEvent) => (e.costUsd === null || e.costUsd === undefined ? NONE : e.costUsd === 0 ? '免费' : fmtUsd(e.costUsd, { digits: e.costUsd < 0.01 ? 4 : 3 }))
const liveColumns = computed<RowColumn<LiveEvent>[]>(() => {
  const wide = isWide.value
  const cols: RowColumn<LiveEvent>[] = [
    { key: 'time', title: '时间', width: 108, card: 'line2', format: (_v, r) => fmtClock(r.timestamp) },
    { key: 'model', title: '模型', card: 'primary' },
    { key: 'key', title: 'Key', width: wide ? 120 : 104, card: 'line3', format: (_v, r) => r.keyName || '未关联' },
    { key: 'client', title: '客户端', width: wide ? 108 : 96, card: 'line3', format: (_v, r) => CLIENT_LABELS[r.clientType] ?? r.clientType ?? NONE },
    { key: 'ctx', title: '上下文', width: 128, align: 'right', card: 'line2', cardLabel: '上下文' },
  ]
  if (wide) cols.push({ key: 'fresh', title: '新输入', width: 72, align: 'right', format: (_v, r) => fmtCompact(r.freshInputTokens) })
  cols.push({ key: 'read', title: '缓存读', width: 76, align: 'right', card: 'line2', cardLabel: '读', format: (_v, r) => fmtCompact(r.cacheReadTokens) })
  if (wide) cols.push({ key: 'write', title: '缓存写', width: 72, align: 'right', format: (_v, r) => fmtCompact(r.cacheWriteTokens) })
  cols.push({ key: 'hit', title: '命中', width: 116, align: 'right', card: 'meta' })
  cols.push({ key: 'cost', title: '花费', width: 76, align: 'right', card: 'line2', cardLabel: '花费', format: (_v, r) => liveCost(r) })
  if (wide) cols.push({ key: 'latency', title: '耗时', width: 64, align: 'right', format: (_v, r) => fmtDuration(r.latencyMs) })
  return cols
})
/** models the summary counted out (不支持缓存): their live rows read 不支持, not a 0% */
const uncacheable = computed(() => new Set((summary.value?.excluded.items ?? []).map((m) => m.model)))
const noCache = (row: LiveEvent) => uncacheable.value.has(row.model) && !row.cacheReadTokens && !row.cacheWriteTokens
const liveRowKey = (row: LiveEvent, index: number) => row.requestId || `${row.timestamp}-${index}`
/** phones list the newest dozen; the rest one tap away */
const LIVE_PHONE_LIMIT = 12
const showAllLive = ref(false)
const liveRows = computed(() => (isMobile.value && !showAllLive.value ? events.value.slice(0, LIVE_PHONE_LIMIT) : events.value))
const liveTone = (row: LiveEvent) => (row.overCeiling ? 'attn' : null)
const overInStream = computed(() => events.value.filter((e) => e.overCeiling).length)
const followed = computed(() => {
  const s = scope.value
  const on = [s.keyId && 'Key', s.model && '模型', s.client && '客户端', s.provider && '渠道'].filter(Boolean)
  return on.length ? `跟随 ${on.join(' · ')} 筛选` : ''
})
const liveState = computed<DataState>(() => (streamState.value === 'connecting' && !events.value.length ? 'loading' : !events.value.length ? 'empty' : 'ready'))
const chartH = computed(() => (isCompact.value ? 120 : isMobile.value ? 140 : 168))
</script>

<template>
  <div class="ui-grid uxi">
    <Plate title="汇总" class="c-12" v-bind="plateProps" :rows="2" @retry="live.refresh" @empty-action="widen">
      <template #meta><span>{{ asOf }}</span><span v-if="summary" class="uxi-basis">{{ summary.basis }}</span></template>
      <div v-if="summary && totals && money" class="uxi-ledger is-5">
        <Readout label="命中率" :value="hit.value" :unit="hit.unit" :state="state">
          <template #sub><span>{{ hitBasisWords(summary) }}</span></template>
        </Readout>
        <Readout :label="money.approx ? '净节省 ≈' : '净节省'" :value="money.value" :roll="money.value !== '免费'" :state="state">
          <template #sub><span>{{ money.sub }}</span></template>
        </Readout>
        <Readout label="缓存读" :value="fmtCompact(totals.cacheReadTokens)" :state="state">
          <template #sub><span>占提示 <b>{{ shareOf(totals.cacheReadTokens, totals.promptTokens) }}</b> · {{ fmtInt(totals.requests) }} 次</span></template>
        </Readout>
        <Readout label="缓存写" :value="fmtCompact(totals.cacheWriteTokens)" :state="state">
          <template #sub><span>占提示 <b>{{ shareOf(totals.cacheWriteTokens, totals.promptTokens) }}</b> · 按写入价</span></template>
        </Readout>
        <Readout label="超缓存上限" :value="fmtInt(totals.overCeilingRequests)" :state="state">
          <template #sub>
            <span :class="{ sig: totals.overCeilingRequests > 0 }">{{ totals.overCeilingRequests > 0 ? '◆ ' : '' }}提示 &gt; {{ ceilingK }} · 写不进缓存</span>
          </template>
        </Readout>
      </div>
      <template v-if="summary && summary.excluded.models > 0" #footer>
        <TxCollapse class="uxi-excl">
          <TxCollapseItem name="excluded">
            <template #title>
              <span>不支持缓存 · <b class="num">{{ summary.excluded.models }}</b> 个模型 · <b class="num">{{ fmtInt(summary.excluded.requests) }}</b> 次 · 不计入命中率</span>
            </template>
            <ul class="uxi-excl__list">
              <li v-for="m in summary.excluded.items" :key="m.model">
                <TxTag size="sm" variant="plain" class="uxi-excl__tag"><span :title="m.model">{{ m.model }}</span><b>{{ fmtInt(m.requests) }}</b></TxTag>
              </li>
            </ul>
            <p class="uxi-excl__rule">判定：{{ summary.capability.rule }}</p>
          </TxCollapseItem>
        </TxCollapse>
      </template>
    </Plate>

    <Plate v-if="!solo" title="命中率趋势" class="c-8" v-bind="plateProps" :rows="5" @retry="live.refresh" @empty-action="widen">
      <template #meta><span v-if="summary">{{ bucketLabel(summary.bucketMs) }}</span></template>
      <TimeChart
        v-if="summary"
        :points="trendPoints"
        :series="[{ key: 'hit', label: '命中率', tone: 'k1' }]"
        :bucket-ms="summary.bucketMs"
        :label="`${win}缓存命中率`"
        :format="fmtRate"
        :fixed-max="1"
        :h="chartH"
        :now="summaryTo"
        :strip="{ label: '请求', format: fmtCount }"
      >
        <template #readout="{ point, range }">
          <b>{{ range }}</b>
          <span> · 命中 <b>{{ fmtPct(point.v.hit) }}</b></span>
          <span> · 请求 <b>{{ fmtInt(point.bar) }}</b></span>
          <template v-if="trendByT.get(point.t)?.requests">
            <span> · 读 <b>{{ fmtCompact(trendByT.get(point.t)?.cacheReadTokens) }}</b></span>
            <span> · 写 <b>{{ fmtCompact(trendByT.get(point.t)?.cacheWriteTokens) }}</b></span>
            <span v-if="trendByT.get(point.t)?.savingsUsd !== null"> · 省 <b>{{ usd(trendByT.get(point.t)?.savingsUsd, true) }}</b></span>
          </template>
        </template>
      </TimeChart>
    </Plate>

    <Plate v-if="!solo" title="提示构成" class="c-4 stretch" v-bind="plateProps" :rows="5" @retry="live.refresh" @empty-action="widen">
      <template #meta><span v-if="totals">{{ fmtCompact(totals.promptTokens) }} token</span></template>
      <template v-if="totals">
        <ShareBar :segments="mixSegments" :legend="false" :height="12" label="提示 token 构成" />
        <div class="uxi-mix">
          <div class="uxi-mix__row"><i class="ui-k1" /><span>新输入<span class="note">按输入价</span></span><span class="v">{{ fmtCompact(totals.freshInputTokens) }}</span><span class="s">{{ shareOf(totals.freshInputTokens, totals.promptTokens) }}</span></div>
          <div class="uxi-mix__row"><i class="ui-k5" /><span>缓存读<span class="note">按缓存价</span></span><span class="v">{{ fmtCompact(totals.cacheReadTokens) }}</span><span class="s">{{ shareOf(totals.cacheReadTokens, totals.promptTokens) }}</span></div>
          <div class="uxi-mix__row"><i class="ui-k3" /><span>缓存写<span class="note">按写入价</span></span><span class="v">{{ fmtCompact(totals.cacheWriteTokens) }}</span><span class="s">{{ shareOf(totals.cacheWriteTokens, totals.promptTokens) }}</span></div>
        </div>
        <div v-if="totals.savings.pricedRequests > 0 && !totals.savings.free" class="uxi-money">
          <div class="uxi-money__row"><span>读省下</span><span class="v">{{ totals.cacheReadTokens > 0 ? `+${usd(totals.savings.readUsd)}` : '无缓存读' }}</span></div>
          <div class="uxi-money__row"><span>写入溢价</span><span class="v">{{ totals.cacheWriteTokens > 0 ? `−${usd(totals.savings.writeUsd)}` : '无缓存写' }}</span></div>
          <div class="uxi-money__row"><span>净节省</span><span class="v">{{ usd(totals.savings.netUsd, true) }}</span></div>
        </div>
        <p class="uxi-money__note">{{ money?.sub }}<template v-if="totals.savings.pricedRequests > 0"> · 按当时价格估算</template></p>
      </template>
    </Plate>

    <Plate v-if="!solo" title="按模型" class="c-7 md-c-12" v-bind="plateProps" :rows="5" flush @retry="live.refresh" @empty-action="widen">
      <template #meta><span v-if="summary">{{ summary.byModel.length }} 个支持缓存 · 按提示量</span></template>
      <RowTable v-if="summary" :columns="modelColumns" :data="modelRows" row-key="id" density="dense" caption="按模型的缓存命中" empty-text="没有支持缓存的模型">
        <template #cell-label="{ row }"><span class="ellip mono" :title="row.label">{{ row.label }}</span></template>
        <template #cell-hit="{ row }">
          <span class="uxi-hit">
            <span aria-hidden="true"><TickMeter :value="row.hitRate" :width="48" :show-pct="false" :redline="2" no-redline /></span>
            <span class="uxi-hit__v" :class="{ 'is-none': row.hitRate === null }">{{ fmtPct(row.hitRate) }}</span>
          </span>
        </template>
        <template #cell-over="{ row }">
          <span v-if="row.overCeilingRequests > 0" class="num sig">◆ {{ isMobile ? '超上限 ' : '' }}{{ fmtInt(row.overCeilingRequests) }}</span>
          <span v-else-if="!isMobile" class="num dim">0</span>
          <span v-else class="uxi-blank" />
        </template>
      </RowTable>
      <template v-if="(summary?.byModel.length ?? 0) > MODEL_LIMIT" #footer>
        <span>{{ showAllModels ? `全部 ${summary?.byModel.length} 个` : `其余 ${(summary?.byModel.length ?? 0) - MODEL_LIMIT} 个模型` }}</span>
        <button type="button" class="ui-link" :aria-expanded="showAllModels" @click="showAllModels = !showAllModels">{{ showAllModels ? '收起' : '展开' }}</button>
      </template>
    </Plate>

    <Plate v-if="!solo" title="按客户端" class="c-5 md-c-12" v-bind="plateProps" :rows="4" flush @retry="live.refresh" @empty-action="widen">
      <template #meta><span v-if="summary">{{ summary.byClient.length }} 个客户端</span></template>
      <RowTable v-if="summary" :columns="clientColumns" :data="summary.byClient" row-key="id" density="dense" caption="按客户端的缓存命中" empty-text="没有客户端数据">
        <template #cell-label="{ row }"><span class="ellip" :title="row.id">{{ row.label }}</span></template>
        <template #cell-hit="{ row }">
          <span class="uxi-hit">
            <span aria-hidden="true"><TickMeter :value="row.hitRate" :width="48" :show-pct="false" :redline="2" no-redline /></span>
            <span class="uxi-hit__v" :class="{ 'is-none': row.hitRate === null }">{{ fmtPct(row.hitRate) }}</span>
          </span>
        </template>
      </RowTable>
    </Plate>

    <Plate title="实时流" class="c-12" :state="liveState" :rows="6" :empty-text="streamState === 'down' ? '实时流断开 · 稍后自动重连' : '还没有请求进来'" flush>
      <template #meta>
        <span class="uxi-live-meta">
          <template v-if="streamState === 'live'"><StatusMark state="run" label="实时 · 已连接" live /></template>
          <template v-else-if="streamState === 'down'">
            <StatusMark state="warn" label="已断开" />
            <span class="num">重连 {{ retryIn }}</span>
            <button type="button" class="ui-link" @click="reconnectNow">现在重连</button>
          </template>
          <template v-else><StatusMark state="busy" label="连接中" /></template>
          <span>· 不受时间筛选</span>
        </span>
        <span v-if="followed">{{ followed }}</span>
        <span>最近 {{ events.length }} 条<template v-if="overInStream"> · <span class="sig">◆ 超上限 {{ overInStream }}</span></template></span>
      </template>
      <RowTable :columns="liveColumns" :data="liveRows" :row-key="liveRowKey" :row-tone="liveTone" density="dense" caption="实时请求流（最近 50 条）">
        <template #cell-model="{ row }"><span class="ellip mono" :title="row.model">{{ row.model }}</span></template>
        <template #cell-ctx="{ row }">
          <span class="uxi-ctx" :class="{ 'is-over': row.overCeiling }" :title="`提示 ${fmtInt(row.promptTokens)} token · 缓存上限 ${ceilingK}`">
            <span v-if="row.overCeiling" class="uxi-ctx__tag">◆ 超上限</span>
            <span class="num">{{ fmtCompact(row.promptTokens) }}</span>
          </span>
        </template>
        <template #cell-hit="{ row }">
          <span v-if="noCache(row)" class="uxi-hit"><span class="uxi-hit__v is-none" title="此模型不支持缓存，不计入命中率">不支持</span></span>
          <span v-else class="uxi-hit">
            <span aria-hidden="true"><TickMeter :value="row.hitRate" :width="40" :show-pct="false" :redline="2" no-redline /></span>
            <span class="uxi-hit__v" :class="{ 'is-none': row.hitRate === null || row.hitRate === 0 }">{{ fmtPct(row.hitRate) }}</span>
          </span>
        </template>
      </RowTable>
      <template v-if="isMobile && events.length > LIVE_PHONE_LIMIT" #footer>
        <span>{{ showAllLive ? `全部 ${events.length} 条` : `其余 ${events.length - LIVE_PHONE_LIMIT} 条` }}</span>
        <button type="button" class="ui-link" :aria-expanded="showAllLive" @click="showAllLive = !showAllLive">{{ showAllLive ? '收起' : '展开' }}</button>
      </template>
    </Plate>
  </div>
</template>
