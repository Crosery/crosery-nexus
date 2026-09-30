<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted, watch } from 'vue'
import { TxCard } from '@talex-touch/tuffex/card'
import { TxDataTable } from '@talex-touch/tuffex/data-table'
import { TxTag } from '@talex-touch/tuffex/tag'
import { TxButton } from '@talex-touch/tuffex/button'
import { TxStatusBadge } from '@talex-touch/tuffex/status-badge'
import { TxEmptyState } from '@talex-touch/tuffex/empty-state'
import { TxSelect, TxSelectItem } from '@talex-touch/tuffex/select'
import { CLIENT_LABELS } from '../clientLabels'
import { channelLabel } from '../channelLabels'
import { api } from '../api'
import type { ApiKeyItem, CacheTrendData, CacheTrendProvider, LiveUsageEvent } from '../types'

const props = withDefaults(defineProps<{
  trend?: CacheTrendData | null
  hours?: number
  model?: string
  models?: string[]
  client?: string
  clients?: Array<{ type: string; label: string; requests: number }>
  keys?: ApiKeyItem[]
  keyId?: string
  providers?: CacheTrendProvider[]
  provider?: string
}>(), {
  trend: null,
  hours: 24,
  model: '',
  models: () => [],
  client: '',
  clients: () => [],
  keys: () => [],
  keyId: '',
  providers: () => [],
  provider: '',
})

const internalTrend = ref<CacheTrendData | null>(props.trend)
const internalHours = ref(props.hours)
const internalModel = ref(props.model)
const internalModels = ref<string[]>(props.models)
const internalClient = ref(props.client)
const internalClients = ref(props.clients)
const internalKeyId = ref(props.keyId)
const internalKeys = ref(props.keys)
const internalProvider = ref(props.provider)
const internalProviders = ref(props.providers)
const loading = ref(false)

const liveEvents = ref<LiveUsageEvent[]>([])
const sseConnected = ref(false)
let eventSource: EventSource | null = null

const tokens = (value: number) => {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return value.toLocaleString('zh-CN')
}

const money = (value: number | null) => {
  if (value === null) return 'n/a'
  if (value === 0) return '$0'
  if (value < 0.01) return `$${value.toFixed(5)}`
  if (value < 1) return `$${value.toFixed(4)}`
  return `$${value.toFixed(2)}`
}

const percent = (value: number | null) => (value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`)

const hitToneColor = (rate: number | null) => {
  if (rate === null) return '#8a90b0'
  if (rate >= 0.9) return '#10b981'
  if (rate >= 0.7) return '#f59e0b'
  return '#ef4444'
}

const clock = (iso: string) => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime())
    ? iso
    : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
}

async function loadTrend() {
  loading.value = true
  try {
    const res = await api.cacheTrend<CacheTrendData>(
      internalHours.value,
      internalModel.value,
      internalClient.value,
      internalKeyId.value,
      internalProvider.value,
    )
    internalTrend.value = res
    if (res.models?.length) internalModels.value = res.models
    if (res.clients?.length) internalClients.value = res.clients
    if (res.providers?.length) internalProviders.value = res.providers
  } catch {
    // ignore
  } finally {
    loading.value = false
  }
}

function setupSSE() {
  if (eventSource) {
    eventSource.close()
    eventSource = null
  }
  liveEvents.value = []
  const url = api.cacheLiveUrl(60, internalModel.value, internalClient.value, internalKeyId.value, internalProvider.value)
  eventSource = new EventSource(url)
  eventSource.addEventListener('open', () => { sseConnected.value = true })
  eventSource.addEventListener('history', (e) => {
    try {
      const rows = JSON.parse((e as MessageEvent).data) as LiveUsageEvent[]
      sseConnected.value = true
      liveEvents.value = rows.slice(-200).reverse()
    } catch {}
  })
  eventSource.addEventListener('usage', (e) => {
    try {
      const rows = JSON.parse((e as MessageEvent).data) as LiveUsageEvent[]
      liveEvents.value = [...rows.reverse(), ...liveEvents.value].slice(0, 200)
    } catch {}
  })
  eventSource.addEventListener('error', () => { sseConnected.value = false })
}

watch([internalModel, internalClient, internalKeyId, internalProvider], () => {
  loadTrend()
  setupSSE()
})

onMounted(() => {
  loadTrend()
  setupSSE()
})

onUnmounted(() => {
  if (eventSource) {
    eventSource.close()
    eventSource = null
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
    <section class="page-head">
      <div class="page-head__text">
        <p class="eyebrow">CACHE PERFORMANCE</p>
        <h1>缓存命中率分析</h1>
        <p>监控各时间段的提示词缓存命中率趋势，以及每一条在线请求的实际命中与花费明细。</p>
      </div>
      <div class="page-head__actions">
        <TxSelect v-model="internalModel" placeholder="选择模型" class="w-160px">
          <TxSelectItem value="" label="全部模型" />
          <TxSelectItem v-for="m in internalModels" :key="m" :value="m" :label="m" />
        </TxSelect>
        <TxSelect v-model="internalClient" placeholder="选择客户端" class="w-140px">
          <TxSelectItem value="" label="全部客户端" />
          <TxSelectItem v-for="c in internalClients" :key="c.type" :value="c.type" :label="`${c.label} (${tokens(c.requests)})`" />
        </TxSelect>
        <TxSelect v-model="internalProvider" placeholder="选择渠道" class="w-130px">
          <TxSelectItem value="" label="全部渠道" />
          <TxSelectItem v-for="p in internalProviders" :key="p.id" :value="p.id" :label="`${channelLabel(p.id)} (${tokens(p.requests)})`" />
        </TxSelect>
        <TxSelect :model-value="String(internalHours)" placeholder="时间范围" class="w-130px" @update:model-value="v => { internalHours = Number(v); loadTrend() }">
          <TxSelectItem value="1" label="最近 1 小时" />
          <TxSelectItem value="6" label="最近 6 小时" />
          <TxSelectItem value="24" label="最近 24 小时" />
          <TxSelectItem value="72" label="最近 3 天" />
          <TxSelectItem value="168" label="最近 7 天" />
        </TxSelect>
        <TxButton variant="secondary" :loading="loading" @click="loadTrend">
          刷新
        </TxButton>
      </div>
    </section>

    <!-- 顶部汇总指标卡 -->
    <div class="metric-row">
      <TxCard class="stat-box">
        <span class="stat-label">区间总命中率</span>
        <strong class="stat-value mono" :style="{ color: hitToneColor(totalHitRate) }">{{ percent(totalHitRate) }}</strong>
        <small class="stat-sub">{{ totalRequests.toLocaleString('zh-CN') }} 次请求</small>
      </TxCard>
      <TxCard class="stat-box">
        <span class="stat-label">区间总成本</span>
        <strong class="stat-value mono">{{ money(totalCost) }}</strong>
        <small class="stat-sub">最近 {{ internalHours }} 小时</small>
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
        <svg v-if="points.length > 1" viewBox="0 0 800 200" class="trend-svg" preserveAspectRatio="none">
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
          {{ loading ? '正在加载命中率数据...' : '当前区间暂无足够请求绘制折线' }}
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

      <TxDataTable
        :columns="liveColumns"
        :data="liveEvents"
        row-key="requestId"
        striped
        bordered
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
          <span class="mono text-xs">{{ (row.latencyMs / 1000).toFixed(1) }}s</span>
        </template>
        <template #empty>
          <TxEmptyState
            title="等待请求接入..."
            description="当客户端发送 API 调用时，事件将自动实时显示在上方表格中。"
            size="small"
          />
        </template>
      </TxDataTable>
    </TxCard>
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
  color: var(--tx-text-color-placeholder, #8a90b0);
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
.text-muted { color: var(--tx-text-color-placeholder, #8a90b0); }
.font-semibold { font-weight: 600; }
</style>
