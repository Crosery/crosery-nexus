<script setup lang="ts">
import { computed, ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { TxCard } from '@talex-touch/tuffex/card'
import { TxStatCard } from '@talex-touch/tuffex/stat-card'
import { TxButton } from '@talex-touch/tuffex/button'
import { TxTag } from '@talex-touch/tuffex/tag'
import { TxSelect } from '@talex-touch/tuffex/select'
import { TxAlert } from '@talex-touch/tuffex/alert'
import { api } from '../../../api'
import { gatewayStatusCopy, type DashboardState, type GatewayState } from '../../../gatewayStatus'
import type { ApiKeyItem, DashboardData } from '../../../types'

const props = withDefaults(
  defineProps<{
    analytics?: DashboardData | null
    keys?: ApiKeyItem[]
    keyId?: string
    gatewayState?: GatewayState
    gatewayEngine?: 'cpa' | 'magpie'
    dashboardState?: DashboardState
  }>(),
  {
    analytics: null,
    keys: () => [],
    keyId: '',
    gatewayState: 'online',
    gatewayEngine: 'magpie',
    dashboardState: 'ready',
  },
)

const emit = defineEmits<{
  (e: 'update:keyId', id: string): void
  (e: 'open-keys'): void
}>()

const router = useRouter()

// Local data fallback if not provided by parent
const internalAnalytics = ref<DashboardData | null>(null)
const internalKeys = ref<ApiKeyItem[]>([])
const loading = ref(false)

const effectiveAnalytics = computed(() => props.analytics ?? internalAnalytics.value)
const effectiveKeys = computed(() => (props.keys && props.keys.length > 0 ? props.keys : internalKeys.value))

const compact = (value: number) =>
  new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 }).format(value || 0)

const summary = computed(() => effectiveAnalytics.value?.summary)
const activeKeysCount = computed(() => effectiveKeys.value.filter((k) => k.enabled).length)

const selectedKey = computed(() => effectiveKeys.value.find((k) => k.id === props.keyId))
const scopeText = computed(() => (selectedKey.value ? `仅 ${selectedKey.value.name}` : '全部 API Key'))

const gatewayCopy = computed(() => gatewayStatusCopy(props.gatewayState, props.gatewayEngine))

const keyOptions = computed(() => [
  { value: '', label: '全部 API Key' },
  ...effectiveKeys.value.map((k) => ({ value: k.id, label: k.name })),
])

function onKeySelect(val: string | number) {
  emit('update:keyId', String(val))
}

function handleOpenKeys() {
  emit('open-keys')
  router.push('/keys')
}

// Hover state on SVG chart
const hoveredPoint = ref<{ x: number; y: number; bucket: string; requests: number } | null>(null)

// Compute SVG path for trend data
const trendData = computed(() => effectiveAnalytics.value?.trend || [])
const chartDimensions = { width: 680, height: 220, padding: 36 }

const chartPath = computed(() => {
  const data = trendData.value
  if (!data.length) return { area: '', line: '', points: [] }

  const maxVal = Math.max(...data.map((d) => d.requests), 1)
  const w = chartDimensions.width - chartDimensions.padding * 2
  const h = chartDimensions.height - chartDimensions.padding * 2

  const points = data.map((d, i) => {
    const x = chartDimensions.padding + (i / Math.max(data.length - 1, 1)) * w
    const y = chartDimensions.height - chartDimensions.padding - (d.requests / maxVal) * h
    return { x, y, bucket: d.bucket, requests: d.requests }
  })

  const lineD = points.map((p, idx) => `${idx === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ')
  const areaD = `${lineD} L ${points[points.length - 1].x.toFixed(1)} ${(chartDimensions.height - chartDimensions.padding).toFixed(1)} L ${points[0].x.toFixed(1)} ${(chartDimensions.height - chartDimensions.padding).toFixed(1)} Z`

  return { area: areaD, line: lineD, points }
})

onMounted(async () => {
  if (!props.analytics && !props.keys?.length) {
    loading.value = true
    try {
      const [boot, dash] = await Promise.allSettled([
        api.bootstrap<{ keys: ApiKeyItem[] }>(),
        api.dashboard<DashboardData>(7, props.keyId),
      ])
      if (boot.status === 'fulfilled' && boot.value?.keys) {
        internalKeys.value = boot.value.keys
      }
      if (dash.status === 'fulfilled' && dash.value) {
        internalAnalytics.value = dash.value
      }
    } finally {
      loading.value = false
    }
  }
})
</script>

<template>
  <div class="page">
    <!-- 头部横幅与状态 -->
    <header class="page-head">
      <div class="page-head__text">
        <div class="eyebrow-tag">CONTROL CENTER</div>
        <h2 class="page-head__title">运行概览</h2>
        <p>全景掌握网关请求吞吐、Token 消耗、活跃密钥及底层推理内核状态。</p>
      </div>
      <div class="page-head__actions">
        <div class="key-selector-wrap">
          <TxSelect
            :model-value="keyId"
            :options="keyOptions"
            placeholder="按 API Key 筛选"
            class="key-select"
            @update:model-value="onKeySelect"
          />
        </div>
        <div class="gateway-status-pill" :class="`gateway-${gatewayState}`">
          <span class="status-dot" />
          <div class="status-texts">
            <strong>{{ gatewayCopy.title }}</strong>
            <small>{{ gatewayCopy.detail }}</small>
          </div>
        </div>
      </div>
    </header>

    <!-- 告警提示 -->
    <TxAlert
      v-if="dashboardState === 'unavailable'"
      variant="warning"
      title="网关数据提示"
      description="控制台暂时无法直接读取实时网关用量，当前显示最后一次成功缓存结果。"
    />
    <TxAlert
      v-else-if="(summary?.errorRate || 0) > 0.1"
      variant="danger"
      title="高错误率预警"
      :description="`当前错误率为 ${((summary?.errorRate || 0) * 100).toFixed(1)}%，建议前往账号监控或请求明细页排查。`"
    />

    <!-- 四项核心指标卡片 -->
    <section class="grid-stats">
      <TxStatCard
        label="请求总量"
        :value="summary ? compact(summary.requests) : '—'"
        :meta="summary ? scopeText : '正在同步...'"
        icon-class="i-carbon-activity text-teal-600"
      />
      <TxStatCard
        label="Token 消耗"
        :value="summary ? compact(summary.tokens) : '—'"
        :meta="summary ? '输入与输出全部汇总' : '正在计算...'"
        icon-class="i-carbon-meter-alt text-blue-600"
      />
      <TxStatCard
        label="活跃 API Key"
        :value="effectiveKeys.length ? `${activeKeysCount} / ${effectiveKeys.length}` : '—'"
        meta="已启用有效密钥占比"
        icon-class="i-carbon-password text-indigo-600"
        clickable
        @click="handleOpenKeys"
      />
      <TxStatCard
        label="平均响应延迟"
        :value="summary?.avgLatency ? `${Math.round(summary.avgLatency)} ms` : '—'"
        meta="端到端网络与推理时延"
        icon-class="i-carbon-time text-amber-600"
      />
    </section>

    <!-- 图表与快捷监控面板 -->
    <section class="split">
      <!-- 请求趋势图 -->
      <TxCard class="chart-card">
        <template #header>
          <div class="card-head">
            <div>
              <h2 class="section-title">请求趋势</h2>
              <span class="card-sub">按时间序列聚合流量分布</span>
            </div>
            <div class="card-head__actions">
              <TxTag
                size="sm"
                variant="soft"
                :color="dashboardState === 'ready' ? 'var(--tx-color-success)' : 'var(--tx-color-warning)'"
                :label="dashboardState === 'ready' ? (effectiveAnalytics?.source === 'data-plane' ? '高速快照' : '实时同步') : '加载中'"
              />
            </div>
          </div>
        </template>

        <div class="chart-container">
          <svg
            v-if="chartPath.points.length"
            viewBox="0 0 680 220"
            class="trend-svg"
            preserveAspectRatio="none"
          >
            <defs>
              <linearGradient id="trendGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stop-color="var(--tx-color-primary)" stop-opacity="0.32" />
                <stop offset="100%" stop-color="var(--tx-color-primary)" stop-opacity="0.01" />
              </linearGradient>
            </defs>

            <!-- 网格参考线 -->
            <line x1="36" y1="184" x2="644" y2="184" stroke="var(--tx-border-color-lighter)" stroke-width="1" />
            <line x1="36" y1="110" x2="644" y2="110" stroke="var(--tx-border-color-extra-light)" stroke-width="1" stroke-dasharray="3 3" />
            <line x1="36" y1="36" x2="644" y2="36" stroke="var(--tx-border-color-extra-light)" stroke-width="1" stroke-dasharray="3 3" />

            <!-- 面积填充与折线 -->
            <path :d="chartPath.area" fill="url(#trendGradient)" />
            <path :d="chartPath.line" fill="none" stroke="var(--tx-color-primary)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" />

            <!-- 交互触控点 -->
            <g v-for="(p, idx) in chartPath.points" :key="idx">
              <circle
                :cx="p.x"
                :cy="p.y"
                r="4"
                fill="var(--tx-bg-color)"
                stroke="var(--tx-color-primary)"
                stroke-width="2"
                class="chart-dot"
                @mouseenter="hoveredPoint = p"
                @mouseleave="hoveredPoint = null"
              />
            </g>
          </svg>

          <div v-else class="chart-empty">
            <span class="muted">暂无时序数据</span>
          </div>

          <!-- 浮动 Tooltip -->
          <div
            v-if="hoveredPoint"
            class="chart-tooltip"
            :style="{ left: `${hoveredPoint.x}px`, top: `${hoveredPoint.y - 48}px` }"
          >
            <strong>{{ hoveredPoint.requests }} 次请求</strong>
            <small>{{ hoveredPoint.bucket }}</small>
          </div>
        </div>
      </TxCard>

      <!-- 密钥健康与快捷操作 -->
      <TxCard class="keys-health-card">
        <template #header>
          <div class="card-head">
            <div>
              <h2 class="section-title">活跃密钥状态</h2>
              <span class="card-sub">最近调用的前 5 把 API Key</span>
            </div>
            <TxButton variant="secondary" size="sm" @click="handleOpenKeys">查看全部</TxButton>
          </div>
        </template>

        <div class="key-list-box">
          <div
            v-for="key in effectiveKeys.slice(0, 5)"
            :key="key.id"
            class="key-row-item"
            @click="handleOpenKeys"
          >
            <span class="key-indicator" :class="{ active: key.enabled }" />
            <div class="key-meta">
              <div class="key-name-line">
                <strong>{{ key.name }}</strong>
                <span class="mono muted">{{ key.maskedKey }}</span>
              </div>
              <small class="key-time">
                {{ key.lastUsedAt ? `最近调用: ${new Date(key.lastUsedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}` : '从未使用' }}
              </small>
            </div>
            <TxTag
              size="sm"
              :variant="key.enabled ? 'soft' : 'outline'"
              :color="key.enabled ? 'var(--tx-color-success)' : 'var(--tx-color-danger)'"
              :label="key.enabled ? '正常' : '已停用'"
            />
          </div>

          <div v-if="!effectiveKeys.length" class="empty-list">
            <span class="muted">暂无 API Key，请先创建</span>
          </div>
        </div>

        <div class="quick-actions-bar">
          <TxButton variant="primary" size="sm" block @click="handleOpenKeys">
            管理所有 API Key
          </TxButton>
        </div>
      </TxCard>
    </section>
  </div>
</template>

<style scoped>
.eyebrow-tag {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  color: var(--tx-color-primary);
  margin-bottom: 4px;
}

.key-selector-wrap {
  width: 180px;
}

.gateway-status-pill {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 14px;
  background: var(--tx-bg-color);
  border: 1px solid var(--tx-border-color);
  border-radius: var(--tx-border-radius-base);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
}

.gateway-online .status-dot {
  background: var(--tx-color-success);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--tx-color-success) 20%, transparent);
}
.gateway-unavailable .status-dot {
  background: var(--tx-color-danger);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--tx-color-danger) 20%, transparent);
}
.gateway-checking .status-dot {
  background: var(--tx-color-warning);
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.status-texts {
  display: flex;
  flex-direction: column;
}

.status-texts strong {
  font-size: 12.5px;
  line-height: 1.2;
}

.status-texts small {
  font-size: 11px;
  color: var(--tx-text-color-secondary);
}

.chart-card {
  position: relative;
}

.chart-container {
  position: relative;
  width: 100%;
  height: 220px;
  overflow: hidden;
}

.trend-svg {
  width: 100%;
  height: 100%;
}

.chart-dot {
  cursor: pointer;
  transition: transform 0.15s ease;
}

.chart-dot:hover {
  transform: scale(1.4);
}

.chart-tooltip {
  position: absolute;
  pointer-events: none;
  background: var(--tx-text-color-primary);
  color: #ffffff;
  padding: 4px 8px;
  border-radius: 6px;
  font-size: 11.5px;
  display: flex;
  flex-direction: column;
  transform: translate(-50%, -100%);
  white-space: nowrap;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  z-index: 10;
}

.chart-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
}

.card-sub {
  font-size: 12px;
  color: var(--tx-text-color-secondary);
}

.key-list-box {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 4px;
}

.key-row-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 10px;
  border-radius: var(--tx-border-radius-base);
  background: var(--tx-fill-color-light);
  cursor: pointer;
  transition: background 0.15s ease;
}

.key-row-item:hover {
  background: var(--tx-fill-color);
}

.key-indicator {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--tx-border-color);
}
.key-indicator.active {
  background: var(--tx-color-success);
}

.key-meta {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.key-name-line {
  display: flex;
  align-items: center;
  gap: 6px;
}

.key-name-line strong {
  font-size: 13px;
  color: var(--tx-text-color-primary);
}

.key-time {
  font-size: 11px;
  color: var(--tx-text-color-secondary);
}

.quick-actions-bar {
  margin-top: 14px;
  padding-top: 10px;
  border-top: 1px solid var(--tx-border-color-lighter);
}
</style>
