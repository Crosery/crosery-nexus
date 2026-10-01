<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { TxCard } from '@talex-touch/tuffex/card'
import { TxDataTable } from '@talex-touch/tuffex/data-table'
import { TxButton } from '@talex-touch/tuffex/button'
import { TxSelect, TxSelectItem } from '@talex-touch/tuffex/select'
import { TxAlert } from '@talex-touch/tuffex/alert'
import { TxPagination } from '@talex-touch/tuffex/pagination'
import PageHeader from '../components/PageHeader.vue'
import ErrorPanel from '../components/ErrorPanel.vue'
import LoadingBlock from '../components/LoadingBlock.vue'
import EmptyState from '../components/EmptyState.vue'
import { api } from '../api'
import { paginate, useQueryState } from '../lib/listState'
import { useResource } from '../lib/resource'
import { fmtCompact, fmtPercent, fmtUsd } from '../lib/format'
import type { ApiKeyItem, UsageDailyPoint, UsagePageData } from '../types'

const PAGE_SIZE = 15

/** 统计周期与 Key 筛选进 URL：刷新/分享链接保持同一口径，改筛选立即重取。 */
const scope = useQueryState({ days: '7', keyId: '', page: '1' })
const days = computed(() => {
  const value = Number(scope.state.days)
  return [1, 7, 30, 90].includes(value) ? value : 7
})

const res = useResource(
  () => api.usageOverview<UsagePageData>(days.value, scope.state.keyId),
  [() => scope.state.days, () => scope.state.keyId],
)
const keysRes = useResource(() => api.bootstrap<{ keys: ApiKeyItem[] }>(), [])

const data = computed(() => res.data.value)
const keys = computed(() => keysRes.data.value?.keys ?? [])
const error = computed(() => res.error.value ?? keysRes.error.value)
const showSkeleton = computed(() => !data.value && !error.value)
const reloadAll = () => Promise.all([res.reload(), keysRes.reload()])

const hoveredDay = ref<UsageDailyPoint | null>(null)

/** 统一格式化：实现都在 src/lib/format.ts，页面里只保留短名字，避免再散落一套 toFixed。 */
const tokens = fmtCompact
const cost = (value: number | null | undefined) => (value === null || value === undefined ? 'n/a' : fmtUsd(value))
const percent = (value: number | null | undefined) => (value === null || value === undefined ? 'n/a' : fmtPercent(value, 0))

const dayLabel = (day: string) => {
  const parsed = new Date(`${day}T12:00:00`)
  return Number.isNaN(parsed.getTime()) ? day : `${parsed.getMonth() + 1}月${parsed.getDate()}日`
}

const cards = computed(() => [
  { label: 'Token 总数', value: tokens(data.value?.totalTokens || 0), meta: `${fmtCompact(data.value?.requests || 0)} 次请求` },
  { label: '预计成本', value: cost(data.value?.estimatedCostUsd ?? null), meta: data.value?.hasPartialCost ? '部分模型未定价' : '按模型单价估算' },
  { label: '活跃天数', value: `${data.value?.activeDays || 0} 天`, meta: `共 ${data.value?.days || days.value} 天区间` },
  { label: '缓存占比', value: percent(data.value?.cacheShare ?? null), meta: `${tokens(data.value?.cacheTokens || 0)} 缓存 token` },
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

const keySummaries = computed(() => data.value?.keySummaries ?? [])
const models = computed(() => data.value?.models ?? [])
const pagedKeys = computed(() => paginate(keySummaries.value, Number(scope.state.page), PAGE_SIZE))
const pagedModels = computed(() => paginate(models.value, Number(scope.state.page), PAGE_SIZE))
// 两张表共用 `page`：任意时刻只显示一张，翻页状态对得上当前视图。
const activePaged = computed(() => (scope.state.keyId ? pagedModels.value : pagedKeys.value))
watch(
  () => activePaged.value.page,
  (page) => {
    if (String(page) !== scope.state.page) scope.state.page = String(page)
  },
)

function setDays(val: string | number) {
  scope.patch({ days: String(val), page: '1' })
}

function handleKeyChange(val: string | number) {
  scope.patch({ keyId: String(val), page: '1' })
}
</script>

<template>
  <div class="page-stack usage-page">
    <PageHeader
      title="统计和使用情况"
      description="网关全渠道的 Token 消耗、成本估算与各上游用量分布；统计周期与 Key 筛选写在地址栏里，刷新和分享链接保持同一口径。"
    >
      <template #actions>
        <TxSelect :model-value="scope.state.keyId" placeholder="选择 API Key" class="w-180px" @update:model-value="handleKeyChange">
          <TxSelectItem value="" label="全部 API Key" />
          <TxSelectItem v-for="k in keys" :key="k.id" :value="k.id" :label="k.name" />
        </TxSelect>
        <TxSelect :model-value="scope.state.days" placeholder="选择统计周期" class="w-130px" @update:model-value="setDays">
          <TxSelectItem value="1" label="最近 24 小时" />
          <TxSelectItem value="7" label="最近 7 天" />
          <TxSelectItem value="30" label="最近 30 天" />
          <TxSelectItem value="90" label="最近 90 天" />
        </TxSelect>
        <TxButton variant="secondary" :loading="res.loading.value" @click="reloadAll">
          刷新
        </TxButton>
      </template>
    </PageHeader>

    <!-- 失败：可读原因 + 重试；首次加载：骨架；其余：保留旧数据继续渲染，刷新不闪空 -->
    <ErrorPanel v-if="error" :error="error" :retry="reloadAll" />
    <LoadingBlock v-else-if="showSkeleton" :lines="8" label="正在读取用量统计" />

    <template v-else>
    <!-- 汇总指标卡 -->
    <div class="metric-row">
      <TxCard v-for="c in cards" :key="c.label" class="stat-box">
        <span class="stat-label">{{ c.label }}</span>
        <strong class="stat-value">{{ c.value }}</strong>
        <small class="stat-sub">{{ c.meta }}</small>
      </TxCard>
    </div>

    <TxAlert v-if="data?.hasPartialCost" type="info" :closable="false">
      当前周期内部分模型暂无官方定价，未计入预计成本估算。
    </TxAlert>

    <!-- 每日强度热力图与 Token 分布 -->
    <div class="usage-charts-grid">
      <TxCard :padding="16" class="heatmap-card">
        <template #header>
          <div class="card-head">
            <strong>每日调用强度</strong>
            <span v-if="data?.bestDay" class="count">最高调用: {{ dayLabel(data.bestDay.day) }} ({{ tokens(data.bestDay.totalTokens) }})</span>
          </div>
        </template>
        <div class="heatmap-container">
          <div class="heatmap-grid" @mouseleave="hoveredDay = null">
            <div
              v-for="p in (data?.daily || [])"
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
            <span v-if="data?.reasoningTokens" class="count">{{ tokens(data.reasoningTokens) }} 推理 Token</span>
          </div>
        </template>
        <div class="token-mix-box">
          <div class="mix-progress">
            <span class="mix-bar input-bar" :style="{ width: `${data?.totalTokens ? (data.newInputTokens / data.totalTokens) * 100 : 0}%` }" title="新输入" />
            <span class="mix-bar output-bar" :style="{ width: `${data?.totalTokens ? (data.outputTokens / data.totalTokens) * 100 : 0}%` }" title="输出" />
            <span class="mix-bar cache-bar" :style="{ width: `${data?.totalTokens ? (data.cacheTokens / data.totalTokens) * 100 : 0}%` }" title="缓存读" />
          </div>
          <div class="mix-legend-grid">
            <div class="legend-item"><span class="legend-dot input-dot" />新输入: {{ tokens(data?.newInputTokens || 0) }}</div>
            <div class="legend-item"><span class="legend-dot output-dot" />输出: {{ tokens(data?.outputTokens || 0) }}</div>
            <div class="legend-item"><span class="legend-dot cache-dot" />缓存读: {{ tokens(data?.cacheTokens || 0) }}</div>
            <div class="legend-item"><span class="legend-dot cache-write-dot" />缓存写: {{ tokens(data?.cacheWriteTokens || 0) }}</div>
          </div>
        </div>
      </TxCard>
    </div>

    <!-- 按 API Key 汇总表格 -->
    <TxCard v-if="!scope.state.keyId" :padding="16">
      <template #header>
        <div class="card-head">
          <strong>按 API Key 统计</strong>
          <span class="count">{{ keySummaries.length }} 把 Key</span>
        </div>
      </template>

      <TxDataTable
        :columns="keyColumns"
        :data="pagedKeys.rows"
        row-key="id"
        striped
        bordered
        scroll-x
        :loading="res.loading.value"
      >
        <template #cell-name="{ row }">
          <button type="button" class="key-link-btn" @click="handleKeyChange(row.id)">
            <strong>{{ row.name }}</strong>
          </button>
        </template>
        <template #cell-requests="{ row }">
          <span class="mono">{{ fmtCompact(row.totals.requests) }}</span>
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
          <EmptyState
            title="当前周期没有 API Key 用量"
            description="换个更长的统计周期，或选择具体 Key 查看模型明细。"
            action-label="看最近 30 天"
            size="small"
            @action="setDays(30)"
          />
        </template>
      </TxDataTable>

      <div v-if="pagedKeys.totalPages > 1" class="usage-pager">
        <TxPagination
          :current-page="pagedKeys.page"
          :page-size="pagedKeys.pageSize"
          :total="pagedKeys.total"
          show-info
          aria-label="按 API Key 统计分页"
          @update:current-page="scope.state.page = String($event)"
        />
      </div>
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
        :data="pagedModels.rows"
        row-key="model"
        striped
        bordered
        scroll-x
        :loading="res.loading.value"
      >
        <template #cell-model="{ row }">
          <strong class="mono">{{ row.model }}</strong>
        </template>
        <template #cell-provider="{ row }">
          <span>{{ row.provider }}</span>
        </template>
        <template #cell-requests="{ row }">
          <span class="mono">{{ fmtCompact(row.requests) }}</span>
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
          <EmptyState
            title="该 Key 在当前周期内暂无调用记录"
            description="换一个统计周期，或回到全部 Key 的汇总。"
            action-label="查看全部 Key"
            size="small"
            @action="handleKeyChange('')"
          />
        </template>
      </TxDataTable>

      <div v-if="pagedModels.totalPages > 1" class="usage-pager">
        <TxPagination
          :current-page="pagedModels.page"
          :page-size="pagedModels.pageSize"
          :total="pagedModels.total"
          show-info
          aria-label="模型明细分页"
          @update:current-page="scope.state.page = String($event)"
        />
      </div>
    </TxCard>
    </template>
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
