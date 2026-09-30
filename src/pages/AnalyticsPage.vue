<script setup lang="ts">
import { computed, ref, onMounted } from 'vue'
import { TxCard } from '@talex-touch/tuffex/card'
import { TxDataTable } from '@talex-touch/tuffex/data-table'
import { TxTag } from '@talex-touch/tuffex/tag'
import { TxButton } from '@talex-touch/tuffex/button'
import { TxStatusBadge } from '@talex-touch/tuffex/status-badge'
import { TxEmptyState } from '@talex-touch/tuffex/empty-state'
import { TxSelect, TxSelectItem } from '@talex-touch/tuffex/select'
import RequestDetail from '../components/RequestDetail.vue'
import { CLIENT_LABELS } from '../clientLabels'
import { compact, ms } from '../chartTheme'
import { api } from '../api'
import type { AnalyticsData, ApiKeyItem, RequestDetailItem } from '../types'

const props = withDefaults(defineProps<{
  analytics?: AnalyticsData | null
  keys?: ApiKeyItem[]
  days?: number
  keyId?: string
}>(), {
  analytics: null,
  keys: () => [],
  days: 7,
  keyId: '',
})

const emit = defineEmits<{
  (e: 'update:days', days: number): void
  (e: 'update:keyId', keyId: string): void
}>()

const internalAnalytics = ref<AnalyticsData | null>(props.analytics)
const internalKeys = ref<ApiKeyItem[]>(props.keys)
const internalDays = ref(props.days)
const internalKeyId = ref(props.keyId)
const loading = ref(false)

const selectedRequest = ref<RequestDetailItem | null>(null)
const detailOpen = ref(false)

async function loadAnalytics() {
  loading.value = true
  try {
    const res = await api.usageBreakdown<AnalyticsData>(internalDays.value, internalKeyId.value)
    internalAnalytics.value = res
  } catch {
    // ignore
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  if (!props.analytics) loadAnalytics()
})

const currentData = computed(() => props.analytics || internalAnalytics.value)
const summary = computed(() => currentData.value?.summary)
const keyUsage = computed(() => currentData.value?.keyUsage ?? [])
const clients = computed(() => currentData.value?.clients ?? [])
const requests = computed(() => currentData.value?.requests ?? [])

const metrics = computed(() => [
  { label: '请求量', value: compact(summary.value?.requests || 0), desc: '总调用次数' },
  { label: 'Token 消耗', value: compact(summary.value?.tokens || 0), desc: '输入 + 输出 tokens' },
  {
    label: '错误率',
    value: `${((summary.value?.errorRate || 0) * 100).toFixed(1)}%`,
    desc: (summary.value?.errorRate || 0) > 0.05 ? '存在异常拦截' : '健康稳定',
    alert: (summary.value?.errorRate || 0) > 0.05,
  },
  { label: '平均响应时间', value: ms(summary.value?.avgLatency || 0), desc: '端到端延迟' },
])

const columns = [
  { key: 'time', title: '时间', width: 140 },
  { key: 'model', title: '模型', width: 180 },
  { key: 'client', title: '客户端', width: 140 },
  { key: 'status', title: '状态', width: 90 },
  { key: 'latency', title: '耗时', width: 100, align: 'right' as const },
  { key: 'tokens', title: 'Tokens', width: 110, align: 'right' as const },
  { key: 'requestId', title: '请求 ID', minWidth: 160 },
]

function openDetail(req: RequestDetailItem) {
  selectedRequest.value = req
  detailOpen.value = true
}

function handleDaysChange(val: string | number) {
  const d = Number(val)
  internalDays.value = d
  emit('update:days', d)
  loadAnalytics()
}

function handleKeyChange(val: string | number) {
  const k = String(val)
  internalKeyId.value = k
  emit('update:keyId', k)
  loadAnalytics()
}

function formatReqTime(iso?: string) {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
}
</script>

<template>
  <div class="page-stack analytics-page">
    <section class="page-head">
      <div class="page-head__text">
        <p class="eyebrow">OBSERVABILITY</p>
        <h1>使用统计与请求明细</h1>
        <p>按 API Key、渠道和模型分析调用量、Token、延迟与错误趋势，点击列表可下钻查看单次请求参数。</p>
      </div>
      <div class="page-head__actions">
        <TxSelect :model-value="internalKeyId" placeholder="选择 API Key" class="w-180px" @update:model-value="handleKeyChange">
          <TxSelectItem value="" label="全部 API Key" />
          <TxSelectItem v-for="k in (props.keys.length ? props.keys : internalKeys)" :key="k.id" :value="k.id" :label="k.name" />
        </TxSelect>
        <TxSelect :model-value="String(internalDays)" placeholder="选择统计周期" class="w-130px" @update:model-value="handleDaysChange">
          <TxSelectItem value="1" label="最近 24 小时" />
          <TxSelectItem value="7" label="最近 7 天" />
          <TxSelectItem value="30" label="最近 30 天" />
          <TxSelectItem value="90" label="最近 90 天" />
        </TxSelect>
        <TxButton variant="secondary" :loading="loading" @click="loadAnalytics">
          刷新
        </TxButton>
      </div>
    </section>

    <!-- 汇总指标卡 -->
    <div class="metric-row">
      <TxCard v-for="m in metrics" :key="m.label" class="stat-box" :class="{ 'stat-box--alert': m.alert }">
        <span class="stat-label">{{ m.label }}</span>
        <strong class="stat-value">{{ m.value }}</strong>
        <small class="stat-sub">{{ m.desc }}</small>
      </TxCard>
    </div>

    <!-- 中间排行与分布卡片 -->
    <div class="ranking-grid">
      <TxCard :padding="16" class="rank-card">
        <template #header>
          <div class="card-head">
            <strong>API Key 使用排行</strong>
            <span class="count">{{ keyUsage.length }} 个 Key</span>
          </div>
        </template>
        <div class="rank-list scroll-area">
          <div v-if="!keyUsage.length" class="text-muted text-center py-4">无 Key 使用数据</div>
          <div v-for="(k, idx) in keyUsage" :key="k.id" class="rank-item">
            <span class="rank-idx mono">{{ String(idx + 1).padStart(2, '0') }}</span>
            <span class="rank-name" :title="k.name">{{ k.name }}</span>
            <div class="rank-bar-wrap">
              <span class="rank-bar-fill" :style="{ width: `${Math.max(2, Math.min(100, (k.requests / Math.max(1, keyUsage[0]?.requests || 1)) * 100))}%` }" />
            </div>
            <span class="rank-count mono">{{ compact(k.requests) }} 次</span>
            <span class="rank-err mono" :class="{ bad: k.errorRate > 0.1 }">{{ (k.errorRate * 100).toFixed(1) }}%</span>
          </div>
        </div>
      </TxCard>

      <TxCard :padding="16" class="rank-card">
        <template #header>
          <div class="card-head">
            <strong>调用客户端分布</strong>
            <span class="count">{{ clients.length }} 类</span>
          </div>
        </template>
        <div class="rank-list scroll-area">
          <div v-if="!clients.length" class="text-muted text-center py-4">无客户端调用记录</div>
          <div v-for="(c, idx) in clients" :key="c.type" class="rank-item">
            <span class="rank-idx mono">{{ String(idx + 1).padStart(2, '0') }}</span>
            <span class="rank-name" :title="c.label">{{ c.label }}</span>
            <div class="rank-bar-wrap">
              <span class="rank-bar-fill" :style="{ width: `${Math.max(2, Math.min(100, (c.requests / Math.max(1, clients[0]?.requests || 1)) * 100))}%` }" />
            </div>
            <span class="rank-count mono">{{ compact(c.requests) }} 次</span>
            <span class="rank-err mono" :class="{ bad: c.errorRate > 0.1 }">{{ (c.errorRate * 100).toFixed(1) }}%</span>
          </div>
        </div>
      </TxCard>
    </div>

    <!-- 请求明细数据表格 -->
    <TxCard :padding="16" class="requests-card">
      <template #header>
        <div class="card-head">
          <strong>请求明细流水</strong>
          <span class="count">共 {{ requests.length }} 条记录（点击查看详细参数）</span>
        </div>
      </template>

      <TxDataTable
        :columns="columns"
        :data="requests"
        row-key="requestId"
        striped
        bordered
        :loading="loading"
        class="requests-table"
      >
        <template #cell-time="{ row }: { row: RequestDetailItem }">
          <span class="mono text-muted text-xs">{{ formatReqTime(row.timestamp) }}</span>
        </template>

        <template #cell-model="{ row }: { row: RequestDetailItem }">
          <span class="model-tag-text mono" :title="row.model">{{ row.model }}</span>
        </template>

        <template #cell-client="{ row }: { row: RequestDetailItem }">
          <span class="client-label" :title="row.userAgent || '未上报'">{{ CLIENT_LABELS[row.clientType || 'unknown'] || '未知' }}</span>
        </template>

        <template #cell-status="{ row }: { row: RequestDetailItem }">
          <TxStatusBadge :status="row.success ? 'success' : 'danger'" :text="row.success ? String(row.statusCode ?? '200') : `失败 ${row.statusCode ?? ''}`" size="sm" />
        </template>

        <template #cell-latency="{ row }: { row: RequestDetailItem }">
          <span class="mono">{{ ms(row.latencyMs) }}</span>
        </template>

        <template #cell-tokens="{ row }: { row: RequestDetailItem }">
          <span class="mono">{{ compact(row.totalTokens ?? 0) }}</span>
        </template>

        <template #cell-requestId="{ row }: { row: RequestDetailItem }">
          <button type="button" class="request-id-btn mono" @click="openDetail(row)">
            {{ row.requestId.slice(0, 20) }}...
          </button>
        </template>

        <template #empty>
          <TxEmptyState
            title="暂无调用请求记录"
            description="当客户端发起调用时，请求明细流水将实时呈现在此处。"
            size="small"
          />
        </template>
      </TxDataTable>
    </TxCard>

    <RequestDetail v-model="detailOpen" :request="selectedRequest" @close="detailOpen = false" />
  </div>
</template>

<style scoped>
.analytics-page {
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
.w-180px {
  width: 180px;
}
.w-130px {
  width: 130px;
}
.metric-row {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 12px;
}
.stat-box {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.stat-box--alert {
  border-color: #ef4444 !important;
}
.stat-label {
  font-size: 12px;
  color: var(--tx-text-color-secondary, #535b85);
}
.stat-value {
  font-size: 22px;
  font-weight: 700;
  color: var(--tx-text-color-primary, #151b45);
}
.stat-sub {
  font-size: 11.5px;
  color: var(--tx-text-color-placeholder, #8a90b0);
}
.ranking-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(360px, 1fr));
  gap: 16px;
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
.rank-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 240px;
}
.rank-item {
  display: grid;
  grid-template-columns: 28px 1fr 100px 70px 50px;
  align-items: center;
  gap: 10px;
  font-size: 12px;
}
.rank-idx {
  color: var(--tx-text-color-placeholder, #8a90b0);
}
.rank-name {
  color: var(--tx-text-color-primary, #151b45);
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rank-bar-wrap {
  height: 6px;
  background: var(--tx-fill-color, #eceff8);
  border-radius: 999px;
  overflow: hidden;
}
.rank-bar-fill {
  display: block;
  height: 100%;
  background: var(--tx-color-primary, #3346c8);
  border-radius: 999px;
  transition: width 0.3s ease;
}
.rank-count {
  text-align: right;
  color: var(--tx-text-color-secondary, #535b85);
}
.rank-err {
  text-align: right;
  color: #10b981;
}
.rank-err.bad {
  color: #ef4444;
  font-weight: 600;
}
.requests-card {
  width: 100%;
}
.requests-table {
  width: 100%;
}
.model-tag-text {
  font-weight: 600;
  color: var(--tx-text-color-primary, #151b45);
}
.client-label {
  color: var(--tx-text-color-secondary, #535b85);
  font-size: 12px;
}
.request-id-btn {
  background: transparent;
  border: 0;
  padding: 0;
  color: var(--tx-color-primary, #3346c8);
  cursor: pointer;
  text-decoration: underline;
  text-align: left;
}
.text-muted {
  color: var(--tx-text-color-placeholder, #8a90b0);
}
.text-xs {
  font-size: 11.5px;
}
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}
</style>
