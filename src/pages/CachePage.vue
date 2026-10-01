<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted, watch } from 'vue'
import { TxCard } from '@talex-touch/tuffex/card'
import { TxDataTable } from '@talex-touch/tuffex/data-table'
import { TxTag } from '@talex-touch/tuffex/tag'
import { TxButton } from '@talex-touch/tuffex/button'
import { TxStatusBadge } from '@talex-touch/tuffex/status-badge'
import { TxEmptyState } from '@talex-touch/tuffex/empty-state'
import { TxSelect, TxSelectItem } from '@talex-touch/tuffex/select'
import PageHeader from '../components/PageHeader.vue'
import ErrorPanel from '../components/ErrorPanel.vue'
import LoadingBlock from '../components/LoadingBlock.vue'
import { CLIENT_LABELS } from '../clientLabels'
import { channelLabel } from '../channelLabels'
import { api } from '../api'
import { useQueryState } from '../lib/listState'
import { useResource } from '../lib/resource'
import { fmtClock, fmtCompact, fmtLatency, fmtPercent, fmtUsd } from '../lib/format'
import type { ApiKeyItem, CacheTrendData, CacheTrendProvider, LiveUsageEvent } from '../types'

/** 模型/客户端/渠道/时间范围全部进 URL：刷新与分享链接保持同一视图（红队 D13）。 */
const scope = useQueryState({ hours: '24', model: '', client: '', keyId: '', provider: '' })
const hours = computed(() => {
  const value = Number(scope.state.hours)
  return [1, 6, 24, 72, 168].includes(value) ? value : 24
})

type BootstrapPayload = { keys?: ApiKeyItem[] }
const keysRes = useResource(() => api.bootstrap<BootstrapPayload>(), [])

const trendRes = useResource(
  () =>
    api.cacheTrend<CacheTrendData>(
      hours.value,
      scope.state.model,
      scope.state.client,
      scope.state.keyId,
      scope.state.provider,
    ),
  [() => scope.state.hours, () => scope.state.model, () => scope.state.client, () => scope.state.keyId, () => scope.state.provider],
)

const error = computed(() => trendRes.error.value ?? keysRes.error.value)
const reloadAll = () => Promise.all([trendRes.reload(), keysRes.reload()])

const internalTrend = computed(() => trendRes.data.value)
const internalModels = computed(() => internalTrend.value?.models ?? [])
const internalClients = computed(() => internalTrend.value?.clients ?? [])
const internalProviders = computed(() => internalTrend.value?.providers ?? [])

const liveEvents = ref<LiveUsageEvent[]>([])
const sseConnected = ref(false)
let eventSource: EventSource | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null

/** 统一格式化：实现都在 src/lib/format.ts（红队 D16：同一数字不再有两个单位）。 */
const tokens = fmtCompact
const money = (value: number | null | undefined) => (value === null || value === undefined ? 'n/a' : fmtUsd(value))
const percent = (value: number | null | undefined) => (value === null || value === undefined ? 'n/a' : fmtPercent(value))
const clock = (iso: string) => fmtClock(iso)

const hitToneColor = (rate: number | null) => {
  if (rate === null) return '#475569'
  if (rate >= 0.9) return '#065f46'
  if (rate >= 0.7) return '#78350f'
  return '#991b1b'
}

function setupSSE() {
  if (eventSource) {
    eventSource.close()
    eventSource = null
  }
  liveEvents.value = []
  const url = api.cacheLiveUrl(60, scope.state.model, scope.state.client, scope.state.keyId, scope.state.provider)
  eventSource = new EventSource(url)
  eventSource.addEventListener('open', () => {
    sseConnected.value = true
  })
  eventSource.addEventListener('history', (e) => {
    try {
      const rows = JSON.parse((e as MessageEvent).data) as LiveUsageEvent[]
      sseConnected.value = true
      liveEvents.value = rows.slice(-200).reverse()
    } catch {
      /* 单条事件解析失败不影响整体流 */
    }
  })
  eventSource.addEventListener('usage', (e) => {
    try {
      const rows = JSON.parse((e as MessageEvent).data) as LiveUsageEvent[]
      liveEvents.value = [...rows.reverse(), ...liveEvents.value].slice(0, 200)
    } catch {
      /* 同上 */
    }
  })
  // 断线不再无限静默：状态可见（「重连中」徽章）并自动重连一次（红队未验证项 8）。
  eventSource.addEventListener('error', () => {
    sseConnected.value = false
    if (eventSource) {
      eventSource.close()
      eventSource = null
    }
    if (reconnectTimer) clearTimeout(reconnectTimer)
    reconnectTimer = setTimeout(() => setupSSE(), 5000)
  })
}

watch(
  [() => scope.state.hours, () => scope.state.model, () => scope.state.client, () => scope.state.keyId, () => scope.state.provider],
  () => setupSSE(),
)

onMounted(() => {
  setupSSE()
})

onUnmounted(() => {
  if (eventSource) {
    eventSource.close()
    eventSource = null
  }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
})

const points = computed(() => internalTrend.value?.points ?? [])

const totalHitRate = computed(() => {
  if (!points.value.length) return null
  const cacheRead = points.value.reduce((s, p) => s + p.cacheReadTokens, 0)
  const denominator = points.value.reduce((s, p) => s + p.cacheReadTokens + p.freshInputTokens + (p.cacheWriteTokens || 0), 0)
  return denominator > 0 ? cacheRead / denominator : null
})

const totalCost = computed(() => points.value.reduce((s, p) => s + (p.costUsd ?? 0), 0))
const totalRequests = computed(() => points.value.reduce((s, p) => s + p.requests, 0))
const liveCost = computed(() => liveEvents.value.reduce((s, e) => s + (e.costUsd ?? 0), 0))

// SVG 趋势图坐标生成
const svgPoints = computed(() => {
  if (!points.value.length) return ''
  const w = 800
  const h = 180
  const pts = points.value
  const step = w / Math.max(1, pts.length - 1)
  return pts.map((p, idx) => {
    const x = idx * step
    const y = h - (p.hitRate !== null ? p.hitRate : 0) * h * 0.9 - 10
    return `${x},${y}`
  }).join(' ')
})

const liveColumns = [
  { key: 'time', title: '时间', width: 90 },
  { key: 'model', title: '模型', width: 180 },
  { key: 'key', title: 'Key', width: 120 },
  { key: 'client', title: '客户端', width: 120 },
  { key: 'input', title: '输入', width: 90, align: 'right' as const },
  { key: 'output', title: '输出', width: 90, align: 'right' as const },
  { key: 'cacheRead', title: '缓存读', width: 90, align: 'right' as const },
  { key: 'cacheWrite', title: '缓存写', width: 90, align: 'right' as const },
  { key: 'hitRate', title: '命中率', width: 90, align: 'center' as const },
  { key: 'cost', title: '花费', width: 90, align: 'right' as const },
  { key: 'latency', title: '耗时', width: 80, align: 'right' as const },
]
</script>

<template>
  <div class="page-stack cache-page">
    <PageHeader
      title="缓存命中率分析"
      description="监控各时间段的提示词缓存命中率趋势，以及每一条在线请求的实际命中与花费明细；筛选条件写在地址栏里。"
    >
      <template #actions>
        <TxSelect :model-value="scope.state.model" placeholder="选择模型" class="w-160px" @update:model-value="v => (scope.state.model = String(v))">
          <TxSelectItem value="" label="全部模型" />
          <TxSelectItem v-for="m in internalModels" :key="m" :value="m" :label="m" />
        </TxSelect>
        <TxSelect :model-value="scope.state.client" placeholder="选择客户端" class="w-140px" @update:model-value="v => (scope.state.client = String(v))">
          <TxSelectItem value="" label="全部客户端" />
          <TxSelectItem v-for="c in internalClients" :key="c.type" :value="c.type" :label="`${c.label} (${tokens(c.requests)})`" />
        </TxSelect>
        <TxSelect :model-value="scope.state.provider" placeholder="选择渠道" class="w-130px" @update:model-value="v => (scope.state.provider = String(v))">
          <TxSelectItem value="" label="全部渠道" />
          <TxSelectItem v-for="p in internalProviders" :key="p.id" :value="p.id" :label="`${channelLabel(p.id)} (${tokens(p.requests)})`" />
        </TxSelect>
        <TxSelect :model-value="scope.state.hours" placeholder="时间范围" class="w-130px" @update:model-value="v => (scope.state.hours = String(v))">
          <TxSelectItem value="1" label="最近 1 小时" />
          <TxSelectItem value="6" label="最近 6 小时" />
          <TxSelectItem value="24" label="最近 24 小时" />
          <TxSelectItem value="72" label="最近 3 天" />
          <TxSelectItem value="168" label="最近 7 天" />
        </TxSelect>
        <TxButton variant="secondary" :loading="trendRes.loading.value" @click="reloadAll">
          刷新
        </TxButton>
      </template>
    </PageHeader>

    <!-- 失败：可读原因 + 重试；首次加载：骨架；其余：保留旧数据继续渲染 -->
    <ErrorPanel v-if="error && !internalTrend" :error="error" :retry="reloadAll" />
    <LoadingBlock v-else-if="!internalTrend" :lines="7" label="正在读取缓存命中率" />

    <template v-else>
    <!-- R2：有旧数据时刷新失败不再顶掉内容，只在顶部给非阻断横幅（有意偏离 TUF 的阻断式错误态） -->
    <ErrorPanel v-if="error" inline :error="error" :retry="reloadAll"
      stale-hint="下方仍是最近一次成功读取的缓存命中率，可以继续查看。" />

    <!-- 顶部汇总指标卡 -->
    <div class="metric-row">
      <TxCard class="stat-box">
        <span class="stat-label">区间总命中率</span>
        <strong class="stat-value mono" :style="{ color: hitToneColor(totalHitRate) }">{{ percent(totalHitRate) }}</strong>
        <small class="stat-sub">{{ fmtCompact(totalRequests) }} 次请求</small>
      </TxCard>
      <TxCard class="stat-box">
        <span class="stat-label">区间总成本</span>
        <strong class="stat-value mono">{{ money(totalCost) }}</strong>
        <small class="stat-sub">最近 {{ hours }} 小时</small>
      </TxCard>
      <TxCard class="stat-box">
        <span class="stat-label">实时流花费</span>
        <strong class="stat-value mono">{{ money(liveCost) }}</strong>
        <small class="stat-sub">当前流水 {{ liveEvents.length }} 条</small>
      </TxCard>
    </div>

    <!-- 命中率趋势折线图 -->
    <TxCard :padding="16">
      <template #header>
        <div class="card-head">
          <strong>命中率趋势</strong>
          <span class="count">{{ internalTrend?.bucketSeconds ? `${internalTrend.bucketSeconds / 60} 分钟/档` : '趋势时序' }}</span>
        </div>
      </template>

        <div class="chart-container">
        <svg v-if="points.length > 1" viewBox="0 0 800 200" class="trend-svg" preserveAspectRatio="none" role="img" aria-label="缓存命中率趋势">
          <defs>
            <linearGradient id="trendGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="#10b981" stop-opacity="0.35" />
              <stop offset="100%" stop-color="#10b981" stop-opacity="0.02" />
            </linearGradient>
          </defs>
          <!-- 面积渐变填充 -->
          <polygon :points="`0,200 ${svgPoints} 800,200`" fill="url(#trendGrad)" />
          <!-- 折线 -->
          <polyline :points="svgPoints" fill="none" stroke="#10b981" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        <div v-else class="text-muted text-center py-8">
          当前区间请求不够，画不出折线；把时间范围调长一些。
        </div>
      </div>
    </TxCard>

    <!-- 实时请求流 -->
    <TxCard :padding="16">
      <template #header>
        <div class="card-head">
          <div class="flex items-center gap-2">
            <strong>实时请求流</strong>
            <TxStatusBadge :status="sseConnected ? 'success' : 'warning'" :text="sseConnected ? '实时已连接' : '重连中'" size="sm" />
          </div>
          <span class="count">最新 200 条请求实时刷新</span>
        </div>
      </template>

      <!--
        R10-C：这里原来没有 `scroll-x`，Tuffex 的 `.tx-data-table` 默认 `overflow:hidden`，
        于是 390/768 宽时右半张表（输出/缓存读/缓存写/命中率/花费/耗时）被**静默裁掉**
        （实测 390(mobile)：scrollWidth 732 vs clientWidth 354，溢出的 378px 既无滚动条也无省略号）。
        按 `layout.css` 既有的 `--table-min` + `.is-scroll-x` 做法改成可横向滚动，
        低于 760px 时保列宽并让容器滚动，而不是压缩/裁切列。

        ⚠️ 这条性质**依赖表格仍是 `table-layout: auto`**（`--table-min` 落在 `min-width` 上，
        是不封顶的下界）：红队注入实验证实**加列时表格会长到 992px 并仍然可滚**（760 不是天花板）。
        若将来有人给这张表加 `table-layout: fixed`、或把 `--table-min` 改成 `width`，
        就会重新变成静默裁列 —— 改之前请重跑 `scripts/qa-viewports.mjs`。
      -->
      <TxDataTable
        :columns="liveColumns"
        :data="liveEvents"
        row-key="requestId"
        striped
        bordered
        scroll-x
        :style="{ '--table-min': '760px' }"
        class="live-table"
      >
        <template #cell-time="{ row }">
          <span class="mono text-xs text-muted">{{ clock(row.timestamp) }}</span>
        </template>
        <template #cell-model="{ row }">
          <strong class="mono text-xs" :title="row.model">{{ row.model }}</strong>
        </template>
        <template #cell-key="{ row }">
          <span class="text-xs" :title="row.keyName || row.source">{{ row.keyName || row.source || '—' }}</span>
        </template>
        <template #cell-client="{ row }">
          <span class="text-xs text-muted">{{ CLIENT_LABELS[row.clientType || 'unknown'] || '未知' }}</span>
        </template>
        <template #cell-input="{ row }">
          <span class="mono text-xs">{{ tokens(row.inputTokens || 0) }}</span>
        </template>
        <template #cell-output="{ row }">
          <span class="mono text-xs">{{ tokens(row.outputTokens || 0) }}</span>
        </template>
        <template #cell-cacheRead="{ row }">
          <span class="mono text-xs">{{ tokens(row.cacheReadTokens || 0) }}</span>
        </template>
        <template #cell-cacheWrite="{ row }">
          <span class="mono text-xs">{{ tokens(row.cacheWriteTokens || 0) }}</span>
        </template>
        <template #cell-hitRate="{ row }">
          <TxTag
            :label="percent(row.hitRate)"
            :color="hitToneColor(row.hitRate)"
            size="sm"
            variant="soft"
            class="mono"
          />
        </template>
        <template #cell-cost="{ row }">
          <span class="mono text-xs font-semibold">{{ money(row.costUsd) }}</span>
        </template>
        <template #cell-latency="{ row }">
          <span class="mono text-xs">{{ fmtLatency(row.latencyMs) }}</span>
        </template>
        <template #empty>
          <TxEmptyState
            title="等待请求接入…"
            description="当客户端发送 API 调用时，事件会自动出现在这里；若长时间没有数据，请检查上游渠道是否在接流量。"
            size="small"
          />
        </template>
      </TxDataTable>
    </TxCard>
    </template>
  </div>
</template>

<style scoped>
.cache-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
  width: 100%;
}
.page-head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  justify-content: space-between;
  gap: 16px;
}
.page-head__text h1 {
  margin: 0;
  font-size: 24px;
  font-weight: 700;
  color: var(--tx-text-color-primary, #151b45);
}
.page-head__text p {
  margin: 4px 0 0;
  color: var(--tx-text-color-secondary, #535b85);
  font-size: 13.5px;
}
.eyebrow {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.05em;
  color: var(--tx-color-primary, #3346c8);
  margin-bottom: 2px;
}
.page-head__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}
.w-160px { width: 160px; }
.w-140px { width: 140px; }
.w-130px { width: 130px; }
.metric-row {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 12px;
}
.stat-box {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.stat-label {
  font-size: 12px;
  color: var(--tx-text-color-secondary, #535b85);
}
.stat-value {
  font-size: 24px;
  font-weight: 700;
}
.stat-sub {
  font-size: 11.5px;
  color: var(--tx-text-color-secondary, #535b85);
}
.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
}
.card-head .count {
  font-size: 12px;
  color: var(--tx-text-color-secondary, #535b85);
}
.chart-container {
  height: 200px;
  width: 100%;
  position: relative;
}
.trend-svg {
  width: 100%;
  height: 100%;
}
.live-table {
  width: 100%;
}
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}
.text-xs { font-size: 11.5px; }
.text-muted { color: var(--tx-text-color-secondary, #535b85); }
.font-semibold { font-weight: 600; }
</style>
