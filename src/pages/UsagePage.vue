<script setup lang="ts">
import { computed, ref, onMounted } from 'vue'
import { TxCard } from '@talex-touch/tuffex/card'
import { TxDataTable } from '@talex-touch/tuffex/data-table'
import { TxButton } from '@talex-touch/tuffex/button'
import { TxEmptyState } from '@talex-touch/tuffex/empty-state'
import { TxSelect, TxSelectItem } from '@talex-touch/tuffex/select'
import { TxAlert } from '@talex-touch/tuffex/alert'
import { api } from '../api'
import type { ApiKeyItem, UsageDailyPoint, UsagePageData } from '../types'

const props = withDefaults(defineProps<{
  data?: UsagePageData | null
  keys?: ApiKeyItem[]
  days?: number
  keyId?: string
}>(), {
  data: null,
  keys: () => [],
  days: 7,
  keyId: '',
})

const emit = defineEmits<{
  (e: 'update:days', days: number): void
  (e: 'update:keyId', keyId: string): void
}>()

const internalData = ref<UsagePageData | null>(props.data)
const internalKeys = ref<ApiKeyItem[]>(props.keys)
const internalDays = ref(props.days)
const internalKeyId = ref(props.keyId)
const loading = ref(false)

const hoveredDay = ref<UsageDailyPoint | null>(null)

const tokens = (value: number) => {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return value.toLocaleString('zh-CN')
}

const cost = (value: number | null) => (value === null ? 'n/a' : value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`)
const percent = (value: number | null) => (value === null ? 'n/a' : `${Math.round(value * 100)}%`)

const dayLabel = (day: string) => {
  const parsed = new Date(`${day}T12:00:00`)
  return Number.isNaN(parsed.getTime()) ? day : `${parsed.getMonth() + 1}月${parsed.getDate()}日`
}

async function loadUsage() {
  loading.value = true
  try {
    const [usageRes, bootstrapRes] = await Promise.all([
      api.usageOverview<UsagePageData>(internalDays.value, internalKeyId.value),
      api.bootstrap().catch(() => null),
    ])
    internalData.value = usageRes
    if (bootstrapRes?.keys) internalKeys.value = bootstrapRes.keys
  } catch {
    // ignore
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  if (!props.data) loadUsage()
})

const currentData = computed(() => props.data || internalData.value)

const cards = computed(() => [
  { label: 'Token 总数', value: tokens(currentData.value?.totalTokens || 0), meta: `${(currentData.value?.requests || 0).toLocaleString('zh-CN')} 次请求` },
  { label: '预计成本', value: cost(currentData.value?.estimatedCostUsd ?? null), meta: currentData.value?.hasPartialCost ? '部分模型未定价' : '按模型单价估算' },
  { label: '活跃天数', value: `${currentData.value?.activeDays || 0} 天`, meta: `共 ${currentData.value?.days || internalDays.value} 天区间` },
  { label: '缓存占比', value: percent(currentData.value?.cacheShare ?? null), meta: `${tokens(currentData.value?.cacheTokens || 0)} 缓存 token` },
])

const keyColumns = [
  { key: 'name', title: 'API Key', width: 220 },
  { key: 'requests', title: '请求次数', width: 120, align: 'right' as const },
  { key: 'input', title: '新输入', width: 130, align: 'right' as const },
  { key: 'output', title: '输出', width: 130, align: 'right' as const },
  { key: 'cache', title: '缓存', width: 130, align: 'right' as const },
  { key: 'cost', title: '总花费', width: 130, align: 'right' as const },
]

const modelColumns = [
  { key: 'model', title: '模型名称', width: 240 },
  { key: 'provider', title: '提供渠道', width: 140 },
  { key: 'requests', title: '请求次数', width: 120, align: 'right' as const },
  { key: 'input', title: '新输入', width: 130, align: 'right' as const },
  { key: 'cache', title: '缓存', width: 130, align: 'right' as const },
  { key: 'cost', title: '估算成本', width: 130, align: 'right' as const },
]

function handleDaysChange(val: string | number) {
  const d = Number(val)
  internalDays.value = d
  emit('update:days', d)
  loadUsage()
}

function handleKeyChange(val: string | number) {
  const k = String(val)
  internalKeyId.value = k
  emit('update:keyId', k)
  loadUsage()
}
</script>

<template>
  <div class="page-stack usage-page">
    <section class="page-head">
      <div class="page-head__text">
        <p class="eyebrow">STATS &amp; USAGE</p>
        <h1>统计和使用情况</h1>
        <p>网关全渠道的 Token 消耗、成本估算与各上游用量分布，全维度量化成本与活跃度。</p>
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
        <TxButton variant="secondary" :loading="loading" @click="loadUsage">
          刷新
        </TxButton>
      </div>
    </section>

    <!-- 汇总指标卡 -->
    <div class="metric-row">
      <TxCard v-for="c in cards" :key="c.label" class="stat-box">
        <span class="stat-label">{{ c.label }}</span>
        <strong class="stat-value">{{ c.value }}</strong>
        <small class="stat-sub">{{ c.meta }}</small>
      </TxCard>
    </div>

    <TxAlert v-if="currentData?.hasPartialCost" type="info" :closable="false">
      当前周期内部分模型暂无官方定价，未计入预计成本估算。
    </TxAlert>

    <!-- 每日强度热力图与 Token 分布 -->
    <div class="usage-charts-grid">
      <TxCard :padding="16" class="heatmap-card">
        <template #header>
          <div class="card-head">
            <strong>每日调用强度</strong>
            <span v-if="currentData?.bestDay" class="count">最高调用: {{ dayLabel(currentData.bestDay.day) }} ({{ tokens(currentData.bestDay.totalTokens) }})</span>
          </div>
        </template>
        <div class="heatmap-container">
          <div class="heatmap-grid" @mouseleave="hoveredDay = null">
            <div
              v-for="p in (currentData?.daily || [])"
              :key="p.day"
              class="heat-dot"
              :class="[`level-${p.intensity}`, { active: hoveredDay?.day === p.day }]"
              :title="`${p.day}: ${p.totalTokens.toLocaleString('zh-CN')} tokens (${p.requests} 次)`"
              @mouseenter="hoveredDay = p"
            />
          </div>
          <div v-if="hoveredDay" class="day-tooltip">
            <strong>{{ dayLabel(hoveredDay.day) }}</strong>
            <span>调用 {{ hoveredDay.requests }} 次 · Token: {{ tokens(hoveredDay.totalTokens) }} · 花费: {{ cost(hoveredDay.estimatedCostUsd) }}</span>
          </div>
        </div>
      </TxCard>

      <TxCard :padding="16" class="mix-card">
        <template #header>
          <div class="card-head">
            <strong>Token 构成分布</strong>
            <span v-if="currentData?.reasoningTokens" class="count">{{ tokens(currentData.reasoningTokens) }} 推理 Token</span>
          </div>
        </template>
        <div class="token-mix-box">
          <div class="mix-progress">
            <span class="mix-bar input-bar" :style="{ width: `${currentData?.totalTokens ? (currentData.newInputTokens / currentData.totalTokens) * 100 : 0}%` }" title="新输入" />
            <span class="mix-bar output-bar" :style="{ width: `${currentData?.totalTokens ? (currentData.outputTokens / currentData.totalTokens) * 100 : 0}%` }" title="输出" />
            <span class="mix-bar cache-bar" :style="{ width: `${currentData?.totalTokens ? (currentData.cacheTokens / currentData.totalTokens) * 100 : 0}%` }" title="缓存读" />
          </div>
          <div class="mix-legend-grid">
            <div class="legend-item"><span class="legend-dot input-dot" />新输入: {{ tokens(currentData?.newInputTokens || 0) }}</div>
            <div class="legend-item"><span class="legend-dot output-dot" />输出: {{ tokens(currentData?.outputTokens || 0) }}</div>
            <div class="legend-item"><span class="legend-dot cache-dot" />缓存读: {{ tokens(currentData?.cacheTokens || 0) }}</div>
            <div class="legend-item"><span class="legend-dot cache-write-dot" />缓存写: {{ tokens(currentData?.cacheWriteTokens || 0) }}</div>
          </div>
        </div>
      </TxCard>
    </div>

    <!-- 按 API Key 汇总表格 -->
    <TxCard v-if="!internalKeyId" :padding="16">
      <template #header>
        <div class="card-head">
          <strong>按 API Key 统计</strong>
          <span class="count">{{ currentData?.keySummaries?.length || 0 }} 把 Key</span>
        </div>
      </template>

      <TxDataTable
        :columns="keyColumns"
        :data="currentData?.keySummaries || []"
        row-key="id"
        striped
        bordered
        :loading="loading"
      >
        <template #cell-name="{ row }">
          <button type="button" class="key-link-btn" @click="handleKeyChange(row.id)">
            <strong>{{ row.name }}</strong>
          </button>
        </template>
        <template #cell-requests="{ row }">
          <span class="mono">{{ row.totals.requests.toLocaleString('zh-CN') }}</span>
        </template>
        <template #cell-input="{ row }">
          <span class="mono">{{ tokens(row.totals.newInputTokens) }}</span>
        </template>
        <template #cell-output="{ row }">
          <span class="mono">{{ tokens(row.totals.outputTokens) }}</span>
        </template>
        <template #cell-cache="{ row }">
          <span class="mono">{{ tokens(row.totals.cacheTokens) }}</span>
        </template>
        <template #cell-cost="{ row }">
          <span class="mono font-semibold">{{ cost(row.totals.totalCostUsd) }}</span>
        </template>
        <template #empty>
          <TxEmptyState title="当前周期没有 API Key 用量" description="请选择更长的统计周期或切换筛选条件" size="small" />
        </template>
      </TxDataTable>
    </TxCard>

    <!-- 选中单 Key 时的模型明细表格 -->
    <TxCard v-else :padding="16">
      <template #header>
        <div class="card-head">
          <strong>当前 Key 的模型明细</strong>
          <TxButton size="sm" variant="ghost" @click="handleKeyChange('')">查看全部 Key</TxButton>
        </div>
      </template>

      <TxDataTable
        :columns="modelColumns"
        :data="currentData?.models || []"
        row-key="model"
        striped
        bordered
        :loading="loading"
      >
        <template #cell-model="{ row }">
          <strong class="mono">{{ row.model }}</strong>
        </template>
        <template #cell-provider="{ row }">
          <span>{{ row.provider }}</span>
        </template>
        <template #cell-requests="{ row }">
          <span class="mono">{{ row.requests.toLocaleString('zh-CN') }}</span>
        </template>
        <template #cell-input="{ row }">
          <span class="mono">{{ tokens(row.newInputTokens) }}</span>
        </template>
        <template #cell-cache="{ row }">
          <span class="mono">{{ tokens(row.cacheTokens) }}</span>
        </template>
        <template #cell-cost="{ row }">
          <span class="mono font-semibold">{{ cost(row.costUsd ?? null) }}</span>
        </template>
        <template #empty>
          <TxEmptyState title="该 Key 在当前周期内暂无调用记录" size="small" />
        </template>
      </TxDataTable>
    </TxCard>
  </div>
</template>

<style scoped>
.usage-page {
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
.usage-charts-grid {
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
.heatmap-container {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.heatmap-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(14px, 1fr));
  gap: 4px;
}
.heat-dot {
  aspect-ratio: 1;
  border-radius: 3px;
  border: 1px solid var(--tx-border-color, #d5daec);
  background: var(--tx-fill-color, #eceff8);
  cursor: pointer;
  transition: transform 0.1s ease;
}
.heat-dot:hover, .heat-dot.active {
  transform: scale(1.2);
  border-color: var(--tx-color-primary, #3346c8);
}
.heat-dot.level-0 { background: #f3f4f6; }
.heat-dot.level-1 { background: #dbeafe; }
.heat-dot.level-2 { background: #93c5fd; }
.heat-dot.level-3 { background: #3b82f6; }
.heat-dot.level-4 { background: #1d4ed8; }
.day-tooltip {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 12px;
  padding: 6px 10px;
  background: var(--tx-fill-color, #eceff8);
  border-radius: 6px;
}
.token-mix-box {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.mix-progress {
  display: flex;
  height: 12px;
  border-radius: 999px;
  overflow: hidden;
  background: var(--tx-fill-color, #eceff8);
  border: 1px solid var(--tx-border-color, #d5daec);
}
.mix-bar {
  display: block;
  height: 100%;
}
.input-bar { background: #3346c8; }
.output-bar { background: #10b981; }
.cache-bar { background: #f59e0b; }
.mix-legend-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 8px;
  font-size: 12px;
}
.legend-item {
  display: flex;
  align-items: center;
  gap: 6px;
}
.legend-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}
.input-dot { background: #3346c8; }
.output-dot { background: #10b981; }
.cache-dot { background: #f59e0b; }
.cache-write-dot { background: #8b5cf6; }
.key-link-btn {
  background: transparent;
  border: 0;
  padding: 0;
  color: var(--tx-color-primary, #3346c8);
  cursor: pointer;
  text-decoration: underline;
  text-align: left;
}
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}
.font-semibold {
  font-weight: 600;
}
</style>
