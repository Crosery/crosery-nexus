<script setup lang="ts">
import { computed, ref, onMounted } from 'vue'
import { TxCard } from '@talex-touch/tuffex/card'
import { TxDataTable } from '@talex-touch/tuffex/data-table'
import { TxTag } from '@talex-touch/tuffex/tag'
import { TxButton } from '@talex-touch/tuffex/button'
import { TxSearchInput } from '@talex-touch/tuffex/search-input'
import { TxFilterChips } from '@talex-touch/tuffex/filter-chips'
import { TxAlert } from '@talex-touch/tuffex/alert'
import { TxEmptyState } from '@talex-touch/tuffex/empty-state'
import { TxSelect, TxSelectItem } from '@talex-touch/tuffex/select'
import { api } from '../api'
import type { ApiKeyItem, ModelCost, ModelEntry, ModelIndexData, ModelPricing, ModelSource, UsageBreakdownData } from '../types'

const props = withDefaults(defineProps<{
  data?: ModelIndexData | null
  usage?: UsageBreakdownData | null
  keys?: ApiKeyItem[]
  days?: number
  keyId?: string
  loading?: boolean
}>(), {
  data: null,
  usage: null,
  keys: () => [],
  days: 7,
  keyId: '',
  loading: false,
})

const emit = defineEmits<{
  (e: 'update:days', days: number): void
  (e: 'update:keyId', keyId: string): void
  (e: 'refresh'): void
  (e: 'notify', message: string): void
}>()

const internalData = ref<ModelIndexData | null>(props.data)
const internalUsage = ref<UsageBreakdownData | null>(props.usage)
const internalKeys = ref<ApiKeyItem[]>(props.keys)
const internalDays = ref(props.days)
const internalKeyId = ref(props.keyId)
const internalLoading = ref(props.loading)

const query = ref('')
const filter = ref<'all' | 'contested' | 'off'>('all')
const busyToken = ref('')
const syncing = ref(false)

const kindLabel: Record<string, string> = { compat: '兼容渠道', oauth: '账号池' }

const compactNum = (value: number) => new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 }).format(value || 0)
const moneyFmt = (value: number | null) => value === null ? '未定价' : value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`
const priceFmt = (value: number | null | undefined) => value === null || value === undefined ? '—' : `$${value.toLocaleString('en-US', { maximumFractionDigits: 4 })}`
const publicModelId = (model: string) => model.includes('/') ? model.slice(model.lastIndexOf('/') + 1) : model

async function loadData() {
  internalLoading.value = true
  try {
    const [indexRes, usageRes, bootstrapRes] = await Promise.all([
      api.modelIndex<ModelIndexData>(true),
      api.usageBreakdown<UsageBreakdownData>(internalDays.value, internalKeyId.value),
      api.bootstrap().catch(() => null),
    ])
    internalData.value = indexRes
    internalUsage.value = usageRes
    if (bootstrapRes?.keys) internalKeys.value = bootstrapRes.keys
  } catch {
    emit('notify', '读取模型总览数据失败')
  } finally {
    internalLoading.value = false
  }
}

onMounted(() => {
  if (!props.data) loadData()
})

const currentModels = computed(() => props.data?.models || internalData.value?.models || [])
const currentUsage = computed(() => props.usage || internalUsage.value)
const currentLoading = computed(() => props.loading || internalLoading.value)

const usageByModel = computed(() => {
  const result = new Map<string, ModelCost>()
  for (const row of currentUsage.value?.models || []) {
    const id = publicModelId(row.model)
    const current = result.get(id)
    if (!current) {
      result.set(id, { ...row, model: id })
      continue
    }
    result.set(id, {
      model: id,
      pricing: current.pricing || row.pricing,
      requests: current.requests + row.requests,
      newInputTokens: current.newInputTokens + row.newInputTokens,
      outputTokens: current.outputTokens + row.outputTokens,
      cacheTokens: current.cacheTokens + row.cacheTokens,
      cacheWriteTokens: current.cacheWriteTokens + row.cacheWriteTokens,
      reasoningTokens: current.reasoningTokens + row.reasoningTokens,
      totalTokens: current.totalTokens + row.totalTokens,
      inputCostUsd: current.inputCostUsd === null || row.inputCostUsd === null ? null : current.inputCostUsd + row.inputCostUsd,
      outputCostUsd: current.outputCostUsd === null || row.outputCostUsd === null ? null : current.outputCostUsd + row.outputCostUsd,
      cacheCostUsd: current.cacheCostUsd === null || row.cacheCostUsd === null ? null : current.cacheCostUsd + row.cacheCostUsd,
      cacheWriteCostUsd: current.cacheWriteCostUsd === null || row.cacheWriteCostUsd === null ? null : current.cacheWriteCostUsd + row.cacheWriteCostUsd,
      totalCostUsd: current.totalCostUsd === null || row.totalCostUsd === null ? null : current.totalCostUsd + row.totalCostUsd,
      priced: current.priced && row.priced,
    })
  }
  return result
})

const contestedCount = computed(() => currentModels.value.filter(m => m.contested).length)

const filterChips = computed(() => [
  { value: 'all', label: `全部 (${currentModels.value.length})` },
  { value: 'contested', label: `多渠道 (${contestedCount.value})` },
  { value: 'off', label: '已停用' },
])

const filteredModels = computed(() => {
  return currentModels.value.filter(model => {
    if (filter.value === 'contested' && !model.contested) return false
    if (filter.value === 'off' && model.enabledSources > 0) return false
    if (!query.value.trim()) return true
    const haystack = `${model.id} ${model.sources.map(s => s.channel).join(' ')}`.toLowerCase()
    return haystack.includes(query.value.trim().toLowerCase())
  })
})

const columns = [
  { key: 'model', title: '模型名称', width: 240 },
  { key: 'sources', title: '服务渠道映射', minWidth: 260 },
  { key: 'pricing', title: '每 1M Token 定价', width: 260 },
  { key: 'usage', title: '用量与花费', width: 220, align: 'right' as const },
]

async function toggleSource(model: ModelEntry, source: ModelSource) {
  const token = `${model.id}@${source.channel}`
  busyToken.value = token
  try {
    await api.setModelSourceEnabled(model.id, source.channel, source.kind, !source.enabled)
    emit('refresh')
    await loadData()
    emit('notify', `${model.id} 在「${source.channel}」已${source.enabled ? '停用' : '启用'}`)
  } catch (e) {
    emit('notify', e instanceof Error ? e.message : '操作失败')
  } finally {
    busyToken.value = ''
  }
}

async function handleSyncUpstream() {
  syncing.value = true
  try {
    const res = await api.syncUpstreamModels()
    emit('notify', `同步成功：新增 ${res.result.addedModels.length} 个模型，现共 ${res.result.totalModels} 个`)
    emit('refresh')
    await loadData()
  } catch {
    emit('notify', '同步上游最新模型失败，请检查网络或网关连接')
  } finally {
    syncing.value = false
  }
}

function handleDaysChange(val: string | number) {
  const d = Number(val)
  internalDays.value = d
  emit('update:days', d)
  loadData()
}

function handleKeyChange(val: string | number) {
  const k = String(val)
  internalKeyId.value = k
  emit('update:keyId', k)
  loadData()
}
</script>

<template>
  <div class="page-stack models-page">
    <section class="page-head">
      <div class="page-head__text">
        <p class="eyebrow">MODELS</p>
        <h1>模型总览</h1>
        <p>查看实时渠道状态、每百万 token 单价，以及输入、输出、缓存的实际用量与花费。随上游提供商动态更新。</p>
      </div>
      <div class="page-head__actions">
        <TxSelect :model-value="internalKeyId" placeholder="选择 API Key" class="w-180px" @update:model-value="handleKeyChange">
          <TxSelectItem value="" label="全部 API Key" />
          <TxSelectItem v-for="k in (props.keys.length ? props.keys : internalKeys)" :key="k.id" :value="k.id" :label="k.name" />
        </TxSelect>
        <TxSelect :model-value="String(internalDays)" placeholder="选择时间跨度" class="w-130px" @update:model-value="handleDaysChange">
          <TxSelectItem value="1" label="最近 24 小时" />
          <TxSelectItem value="7" label="最近 7 天" />
          <TxSelectItem value="30" label="最近 30 天" />
          <TxSelectItem value="90" label="最近 90 天" />
        </TxSelect>
        <TxButton variant="primary" :loading="syncing" @click="handleSyncUpstream">
          动态同步最新模型
        </TxButton>
        <TxButton variant="secondary" :loading="currentLoading" @click="() => { emit('refresh'); loadData() }">
          刷新
        </TxButton>
      </div>
    </section>

    <!-- 顶部汇总指标卡 -->
    <div class="metric-row">
      <TxCard class="stat-box">
        <span class="stat-label">总花费</span>
        <strong class="stat-value">{{ moneyFmt(currentUsage?.totals?.totalCostUsd ?? 0) }}</strong>
        <small class="stat-sub">{{ compactNum(currentUsage?.totals?.totalTokens || 0) }} tokens</small>
      </TxCard>
      <TxCard class="stat-box">
        <span class="stat-label">输入花费</span>
        <strong class="stat-value">{{ moneyFmt(currentUsage?.totals?.inputCostUsd ?? 0) }}</strong>
        <small class="stat-sub">{{ (currentUsage?.totals?.requests || 0).toLocaleString('zh-CN') }} 次请求</small>
      </TxCard>
      <TxCard class="stat-box">
        <span class="stat-label">输出花费</span>
        <strong class="stat-value">{{ moneyFmt(currentUsage?.totals?.outputCostUsd ?? 0) }}</strong>
        <small class="stat-sub">近 {{ internalDays }} 天统计</small>
      </TxCard>
      <TxCard class="stat-box">
        <span class="stat-label">缓存节省</span>
        <strong class="stat-value">{{ moneyFmt(currentUsage?.totals?.cacheCostUsd ?? 0) }}</strong>
        <small class="stat-sub">读写缓存命中支持</small>
      </TxCard>
    </div>

    <TxAlert v-if="contestedCount > 0" type="warning" title="存在多渠道提供模型" :closable="false">
      有 {{ contestedCount }} 个模型名同时由多个渠道提供。请求会在启用渠道间自动轮询/路由；只选择特定渠道的 Key 不会发生跨渠道溢出。
    </TxAlert>

    <!-- 筛选工具栏 -->
    <TxCard :padding="14">
      <div class="table-toolbar">
        <TxSearchInput v-model="query" placeholder="搜索模型名称或渠道标识..." class="search-input" />
        <TxFilterChips :model-value="filter" :items="filterChips" @update:model-value="v => filter = (v as any)" />
      </div>

      <!-- 模型数据表格 -->
      <TxDataTable
        :columns="columns"
        :data="filteredModels"
        row-key="id"
        striped
        bordered
        :loading="currentLoading"
        class="models-table"
      >
        <template #cell-model="{ row }: { row: ModelEntry }">
          <div class="model-cell">
            <div class="model-title-line">
              <strong class="model-id mono">{{ row.id }}</strong>
              <TxTag v-if="row.contested" label="多渠道" size="sm" variant="soft" color="#d49a29" />
            </div>
            <div class="model-meta">
              <span class="source-count">{{ row.enabledSources }}/{{ row.sources.length }} 渠道启用</span>
              <div v-if="row.thinking?.levels?.length" class="thinking-levels">
                <TxTag v-for="lvl in row.thinking.levels" :key="lvl" :label="lvl" size="sm" variant="outline" color="#3346c8" />
              </div>
            </div>
          </div>
        </template>

        <template #cell-sources="{ row }: { row: ModelEntry }">
          <div class="channel-chips">
            <button
              v-for="s in row.sources"
              :key="`${s.channel}:${s.kind}`"
              type="button"
              class="channel-chip-btn"
              :class="{ active: s.enabled, disabled: !s.channelEnabled && !s.enabled }"
              :disabled="busyToken === `${row.id}@${s.channel}` || (!s.channelEnabled && !s.enabled)"
              :title="`${kindLabel[s.kind] || s.kind}${s.channelEnabled ? '' : ' (渠道不可用)'}`"
              @click="toggleSource(row, s)"
            >
              <span class="chip-dot" :class="{ 'chip-dot--active': s.enabled }" />
              <span>{{ s.channel }}</span>
              <em v-if="s.upstreams > 1" class="chip-mult">×{{ s.upstreams }}</em>
            </button>
          </div>
        </template>

        <template #cell-pricing="{ row }: { row: ModelEntry }">
          <div v-if="row.pricing" class="pricing-cell">
            <div class="pricing-main">
              <span>输入: <strong>{{ priceFmt(row.pricing.input) }}</strong></span>
              <span>输出: <strong>{{ priceFmt(row.pricing.output) }}</strong></span>
            </div>
            <div class="pricing-sub">
              <span>读缓存: {{ priceFmt(row.pricing.cacheRead) }}</span>
              <span v-if="row.pricing.cacheWrite !== undefined">写缓存: {{ priceFmt(row.pricing.cacheWrite) }}</span>
            </div>
          </div>
          <span v-else class="text-muted">单价未收录</span>
        </template>

        <template #cell-usage="{ row }: { row: ModelEntry }">
          <div v-if="usageByModel.get(row.id)" class="usage-cell">
            <div class="usage-cost mono">{{ moneyFmt(usageByModel.get(row.id)?.totalCostUsd ?? null) }}</div>
            <div class="usage-sub text-muted">
              {{ compactNum(usageByModel.get(row.id)?.totalTokens || 0) }} tokens · {{ usageByModel.get(row.id)?.requests }} 次
            </div>
          </div>
          <span v-else class="text-muted">近 {{ internalDays }} 天无用量</span>
        </template>

        <template #empty>
          <TxEmptyState
            title="未找到匹配的模型"
            description="请尝试调整搜索关键字或筛选条件"
            size="small"
          />
        </template>
      </TxDataTable>
    </TxCard>
  </div>
</template>

<style scoped>
.models-page {
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
.table-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}
.search-input {
  width: 320px;
  max-width: 100%;
}
.models-table {
  width: 100%;
}
.model-cell {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.model-title-line {
  display: flex;
  align-items: center;
  gap: 8px;
}
.model-id {
  font-size: 13.5px;
  color: var(--tx-text-color-primary, #151b45);
}
.model-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11.5px;
  color: var(--tx-text-color-secondary, #535b85);
}
.thinking-levels {
  display: flex;
  gap: 4px;
}
.channel-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.channel-chip-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 9px;
  border-radius: 999px;
  font-size: 11px;
  border: 1px solid var(--tx-border-color, #d5daec);
  background: var(--tx-bg-color, #ffffff);
  color: var(--tx-text-color-secondary, #535b85);
  cursor: pointer;
  transition: all 0.15s ease;
}
.channel-chip-btn:hover:not(:disabled) {
  border-color: var(--tx-color-primary, #3346c8);
  color: var(--tx-color-primary, #3346c8);
}
.channel-chip-btn.active {
  border-color: #10b981;
  background: rgba(16, 185, 129, 0.08);
  color: #065f46;
  font-weight: 600;
}
.channel-chip-btn.disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.chip-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--tx-border-color, #d5daec);
}
.chip-dot--active {
  background: #10b981;
}
.chip-mult {
  font-style: normal;
  opacity: 0.7;
}
.pricing-cell {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 11.5px;
}
.pricing-main {
  display: flex;
  gap: 8px;
  color: var(--tx-text-color-primary, #151b45);
}
.pricing-sub {
  display: flex;
  gap: 8px;
  color: var(--tx-text-color-secondary, #535b85);
  font-size: 11px;
}
.usage-cell {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.usage-cost {
  font-size: 13.5px;
  font-weight: 600;
  color: var(--tx-text-color-primary, #151b45);
}
.usage-sub {
  font-size: 11px;
}
.text-muted {
  color: var(--tx-text-color-placeholder, #8a90b0);
  font-size: 12px;
}
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}
</style>
