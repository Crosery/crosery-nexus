<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { TxCard } from '@talex-touch/tuffex/card'
import { TxStatCard } from '@talex-touch/tuffex/stat-card'
import { TxButton } from '@talex-touch/tuffex/button'
import { TxTag } from '@talex-touch/tuffex/tag'
import { TxSelect } from '@talex-touch/tuffex/select'
import { TxAlert } from '@talex-touch/tuffex/alert'
import PageHeader from '../components/PageHeader.vue'
import ErrorPanel from '../components/ErrorPanel.vue'
import LoadingBlock from '../components/LoadingBlock.vue'
import EmptyState from '../components/EmptyState.vue'
import { api } from '../api'
import { gatewayStatusCopy, type DashboardState, type GatewayState } from '../gatewayStatus'
import { useQueryState } from '../lib/listState'
import { useResource } from '../lib/resource'
import { fmtCompact, fmtDate, fmtLatency, fmtPercent } from '../lib/format'
import type { ApiKeyItem, DashboardData } from '../types'

const router = useRouter()

/**
 * 筛选进 URL（对照参考实现 pages/github/Repos.vue 的深链列表）：
 * 刷新、收藏、分享链接都回到同一视图；改筛选立即重取，不再「选了 Key 没反应」。
 */
const scope = useQueryState({ days: '7', keyId: '' })
const days = computed(() => {
  const value = Number(scope.state.days)
  return [1, 7, 30, 90].includes(value) ? value : 7
})

const dayOptions = [
  { value: '1', label: '最近 24 小时' },
  { value: '7', label: '最近 7 天' },
  { value: '30', label: '最近 30 天' },
  { value: '90', label: '最近 90 天' },
]

/** 概览与 API Key 各自一个读取状态：都带重试，刷新时保留旧数据（useResource 成功前不碰 data）。 */
const dashRes = useResource(
  () => api.dashboard<DashboardData>(days.value, scope.state.keyId),
  [() => scope.state.days, () => scope.state.keyId],
)
const keysRes = useResource(() => api.bootstrap<{ keys: ApiKeyItem[] }>(), [])

const analytics = computed(() => dashRes.data.value)
const keys = computed(() => keysRes.data.value?.keys ?? [])
const error = computed(() => dashRes.error.value ?? keysRes.error.value)
const showSkeleton = computed(() => !analytics.value && !error.value)
const reloadAll = () => Promise.all([dashRes.reload(), keysRes.reload()])

const summary = computed(() => analytics.value?.summary)
const activeKeysCount = computed(() => keys.value.filter((k) => k.enabled).length)

const selectedKey = computed(() => keys.value.find((k) => k.id === scope.state.keyId))
const scopeText = computed(() => (selectedKey.value ? `仅 ${selectedKey.value.name}` : '全部 API Key'))

/** 网关状态由这次读取本身决定，不再写死成「在线」。 */
const gatewayState = computed<GatewayState>(() => (dashRes.error.value ? 'unavailable' : dashRes.loading.value ? 'checking' : 'online'))
const dashboardState = computed<DashboardState>(() => (showSkeleton.value ? 'loading' : analytics.value?.stale ? 'unavailable' : 'ready'))
const gatewayCopy = computed(() => gatewayStatusCopy(gatewayState.value, 'magpie'))

const keyOptions = computed(() => [
  { value: '', label: '全部 API Key' },
  ...keys.value.map((k) => ({ value: k.id, label: k.name })),
])

function handleOpenKeys() {
  router.push('/keys')
}

// 真实用户投票是这条改进闭环里唯一没人跑过的一环（实验台建好后只有自测与红队投过票）。
// 在运行概览的快捷区放一个入口：不打断、不弹窗，点进去 30 秒可投一票。
function handleOpenAbLab() {
  router.push('/ab')
}

// Hover state on SVG chart
const hoveredPoint = ref<{ x: number; y: number; bucket: string; requests: number } | null>(null)

// Compute SVG path for trend data
const trendData = computed(() => analytics.value?.trend || [])
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

</script>

<template>
  <div class="page">
    <PageHeader
      title="运行概览"
      description="全景掌握网关请求吞吐、Token 消耗、活跃 API Key 及底层推理内核状态。筛选条件写在地址栏里，刷新和分享链接都会保持同一视图。"
    >
      <template #actions>
        <TxSelect
          :model-value="scope.state.keyId"
          :options="keyOptions"
          placeholder="按 API Key 筛选"
          class="key-select"
          @update:model-value="scope.state.keyId = String($event)"
        />
        <TxSelect
          :model-value="scope.state.days"
          :options="dayOptions"
          placeholder="统计周期"
          class="days-select"
          @update:model-value="scope.state.days = String($event)"
        />
        <TxButton variant="secondary" :loading="dashRes.loading.value" @click="reloadAll">
          刷新
        </TxButton>
        <div class="gateway-status-pill" :class="`gateway-${gatewayState}`">
          <span class="status-dot" />
          <div class="status-texts">
            <strong>{{ gatewayCopy.title }}</strong>
            <small>{{ gatewayCopy.detail }}</small>
          </div>
        </div>
      </template>
    </PageHeader>

    <!-- 失败给可读原因 + 重试；首次加载给骨架；其余情况保留旧数据继续渲染（不闪空） -->
    <ErrorPanel v-if="error && !analytics" :error="error" :retry="reloadAll" />
    <LoadingBlock v-else-if="showSkeleton" :lines="6" label="正在读取运行概览" />

    <template v-else>
    <!-- R2：有旧数据时刷新失败不再顶掉内容，只在顶部给非阻断横幅（有意偏离 TUF 的阻断式错误态） -->
    <ErrorPanel v-if="error" inline :error="error" :retry="reloadAll"
      stale-hint="下方仍是最近一次成功读取的运行概览，可以继续查看。" />

    <!-- 告警提示 -->
    <TxAlert
      v-if="dashboardState === 'unavailable'"
      type="warning"
      title="网关数据提示"
      message="控制台暂时无法直接读取实时网关用量，当前显示最后一次成功缓存结果。"
    />
    <TxAlert
      v-else-if="(summary?.errorRate || 0) > 0.1"
      type="error"
      title="高错误率预警"
      :message="`当前错误率为 ${fmtPercent(summary?.errorRate)}，建议前往账号监控或请求明细页排查。`"
    />

    <!-- 四项核心指标卡片 -->
    <section class="grid-stats">
      <TxStatCard
        label="请求总量"
        :value="summary ? fmtCompact(summary.requests) : '—'"
        :meta="summary ? scopeText : '正在同步...'"
        icon-class="i-carbon-activity text-teal-600"
      />
      <TxStatCard
        label="Token 消耗"
        :value="summary ? fmtCompact(summary.tokens) : '—'"
        :meta="summary ? '输入与输出全部汇总' : '正在计算...'"
        icon-class="i-carbon-meter-alt text-blue-600"
      />
      <TxStatCard
        label="活跃 API Key"
        :value="keys.length ? `${activeKeysCount} / ${keys.length}` : '—'"
        meta="已启用有效 API Key 占比"
        icon-class="i-carbon-password text-indigo-600"
        clickable
        @click="handleOpenKeys"
      />
      <TxStatCard
        label="平均响应延迟"
        :value="summary?.avgLatency ? fmtLatency(summary.avgLatency) : '—'"
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
                :label="dashboardState === 'ready' ? (analytics?.source === 'data-plane' ? '高速快照' : '实时同步') : '加载中'"
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

      <!-- API Key 健康与快捷操作 -->
      <TxCard class="keys-health-card">
        <template #header>
          <div class="card-head">
            <div>
              <h2 class="section-title">活跃 API Key 状态</h2>
              <span class="card-sub">最近调用的前 5 把 API Key</span>
            </div>
            <TxButton variant="secondary" size="sm" @click="handleOpenKeys">查看全部</TxButton>
          </div>
        </template>

        <div class="key-list-box">
          <div
            v-for="key in keys.slice(0, 5)"
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
                {{ key.lastUsedAt ? `最近调用: ${fmtDate(key.lastUsedAt)}` : '从未使用' }}
              </small>
            </div>
            <TxTag
              size="sm"
              :variant="key.enabled ? 'soft' : 'outline'"
              :color="key.enabled ? 'var(--tx-color-success)' : 'var(--tx-color-danger)'"
              :label="key.enabled ? '正常' : '已停用'"
            />
          </div>

          <!-- 空态给下一步动作，而不是只留一句「暂无数据」 -->
          <EmptyState
            v-if="!keys.length"
            title="还没有 API Key"
            description="创建一个 API Key 后，这里会显示最近调用情况和用量。"
            action-label="去创建 API Key"
            to="/keys"
            size="small"
          />
        </div>

        <div class="quick-actions-bar">
          <TxButton variant="primary" size="sm" block @click="handleOpenKeys">
            管理所有 API Key
          </TxButton>
          <TxButton variant="ghost" size="sm" block @click="handleOpenAbLab">
            对比新旧界面（A/B 实验台）
          </TxButton>
        </div>
      </TxCard>
    </section>
    </template>
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

/* 窄屏下两个下拉与状态胶囊换行排列，不撑破视口 */
.key-select,
.days-select {
  width: min(180px, 46vw);
}
.gateway-status-pill {
  min-width: 0;
  flex-wrap: wrap;
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
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 14px;
  padding-top: 10px;
  border-top: 1px solid var(--tx-border-color-lighter);
}
</style>
