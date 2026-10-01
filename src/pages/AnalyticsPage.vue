<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { TxCard } from '@talex-touch/tuffex/card'
import { TxDataTable } from '@talex-touch/tuffex/data-table'
import { TxButton } from '@talex-touch/tuffex/button'
import { TxStatusBadge } from '@talex-touch/tuffex/status-badge'
import { TxSelect, TxSelectItem } from '@talex-touch/tuffex/select'
import { TxInput } from '@talex-touch/tuffex/input'
import { TxPagination } from '@talex-touch/tuffex/pagination'
import PageHeader from '../components/PageHeader.vue'
import ErrorPanel from '../components/ErrorPanel.vue'
import LoadingBlock from '../components/LoadingBlock.vue'
import EmptyState from '../components/EmptyState.vue'
import RequestDetail from '../components/RequestDetail.vue'
import { CLIENT_LABELS } from '../clientLabels'
import { api } from '../api'
import { debounce, paginate, useQueryState } from '../lib/listState'
import { useResource } from '../lib/resource'
import { fmtClock, fmtCompact, fmtLatency, fmtPercent } from '../lib/format'
import type { AnalyticsData, ApiKeyItem, RequestDetailItem } from '../types'

const PAGE_SIZE = 20

/** 筛选、搜索、分页全部写进 URL：深链、刷新、后退都回到同一视图（对照参考实现 repos 列表的深链做法）。 */
const scope = useQueryState({ days: '7', keyId: '', q: '', page: '1' })
const days = computed(() => {
  const value = Number(scope.state.days)
  return [1, 7, 30, 90].includes(value) ? value : 7
})

const res = useResource(
  // D1：这里必须用 /api/analytics（AnalyticsData 的形状），原实现误调 /api/usage-breakdown，
  // 两者除 days 外零字段重叠，真实错误率被渲染成 0.0%。类型与请求同源，取错接口会直接编译不过。
  () => api.analytics<AnalyticsData>(days.value, scope.state.keyId),
  [() => scope.state.days, () => scope.state.keyId],
)
/** API Key 清单只取一次，用来填充 Key 筛选（原实现里筛选框永远是空的）。 */
const keysRes = useResource(() => api.bootstrap<{ keys: ApiKeyItem[] }>(), [])

const analytics = computed(() => res.data.value)
const keys = computed(() => keysRes.data.value?.keys ?? [])
const error = computed(() => res.error.value ?? keysRes.error.value)
const showSkeleton = computed(() => !analytics.value && !error.value)
const reloadAll = () => Promise.all([res.reload(), keysRes.reload()])

const selectedRequest = ref<RequestDetailItem | null>(null)
const detailOpen = ref(false)

const summary = computed(() => analytics.value?.summary)
const keyUsage = computed(() => analytics.value?.keyUsage ?? [])
const clients = computed(() => analytics.value?.clients ?? [])
const requests = computed(() => analytics.value?.requests ?? [])

const metrics = computed(() => [
  { label: '请求量', value: fmtCompact(summary.value?.requests || 0), desc: '总调用次数' },
  { label: 'Token 消耗', value: fmtCompact(summary.value?.tokens || 0), desc: '输入 + 输出 tokens' },
  {
    label: '错误率',
    value: fmtPercent(summary.value?.errorRate),
    desc: (summary.value?.errorRate || 0) > 0.05 ? '存在异常拦截' : '健康稳定',
    alert: (summary.value?.errorRate || 0) > 0.05,
  },
  { label: '平均响应时间', value: fmtLatency(summary.value?.avgLatency || 0), desc: '端到端延迟' },
])

// 搜索：输入即时反馈，300ms 后才写 URL；改筛选时页码回到第 1 页。
const searchInput = ref(scope.state.q)
const applySearch = debounce(() => scope.patch({ q: searchInput.value.trim(), page: '1' }), 300)
watch(searchInput, () => applySearch())
// 深链 / 后退把 URL 上的关键词回填到输入框。
watch(
  () => scope.state.q,
  (value) => {
    if (value !== searchInput.value.trim()) searchInput.value = value
  },
)

const filtered = computed(() => {
  const needle = scope.state.q.trim().toLowerCase()
  if (!needle) return requests.value
  return requests.value.filter((row) =>
    [row.model, row.requestId, row.clientType, CLIENT_LABELS[row.clientType || 'unknown']]
      .some((field) => String(field ?? '').toLowerCase().includes(needle)),
  )
})
const paged = computed(() => paginate(filtered.value, Number(scope.state.page), PAGE_SIZE))
// 数据变少时把越界页码夹回范围内，避免停在空白页。
watch(
  () => paged.value.page,
  (page) => {
    if (String(page) !== scope.state.page) scope.state.page = String(page)
  },
)
const hasFilter = computed(() => Boolean(scope.state.q.trim()) || Boolean(scope.state.keyId))

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

function setDays(val: string | number) {
  scope.patch({ days: String(val), page: '1' })
}

function setKey(val: string | number) {
  scope.patch({ keyId: String(val), page: '1' })
}

function clearFilters() {
  scope.patch({ q: '', keyId: '', page: '1' })
  searchInput.value = ''
}
</script>

<template>
  <div class="page-stack analytics-page">
    <PageHeader
      title="使用统计与请求明细"
      description="按 API Key、渠道和模型分析调用量、Token、延迟与错误趋势，点击列表可下钻查看单次请求参数；筛选、搜索与页码都写在地址栏里。"
    >
      <template #actions>
        <TxSelect :model-value="scope.state.keyId" placeholder="选择 API Key" class="w-180px" @update:model-value="setKey">
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
    <ErrorPanel v-if="error && !analytics" :error="error" :retry="reloadAll" />
    <LoadingBlock v-else-if="showSkeleton" :lines="8" label="正在读取使用统计" />

    <template v-else>
    <!-- R2：有旧数据时刷新失败不再顶掉内容，只在顶部给非阻断横幅（有意偏离 TUF 的阻断式错误态） -->
    <ErrorPanel v-if="error" inline :error="error" :retry="reloadAll"
      stale-hint="下方仍是最近一次成功读取的请求明细，可以继续查看。" />


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
            <span class="rank-count mono">{{ fmtCompact(k.requests) }} 次</span>
            <span class="rank-err mono" :class="{ bad: k.errorRate > 0.1 }">{{ fmtPercent(k.errorRate) }}</span>
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
            <span class="rank-count mono">{{ fmtCompact(c.requests) }} 次</span>
            <span class="rank-err mono" :class="{ bad: c.errorRate > 0.1 }">{{ fmtPercent(c.errorRate) }}</span>
          </div>
        </div>
      </TxCard>
    </div>

    <!-- 请求明细数据表格 -->
    <TxCard :padding="16" class="requests-card">
      <template #header>
        <div class="card-head">
          <strong>请求明细流水</strong>
          <span class="count">
            共 {{ filtered.length }} 条记录<template v-if="hasFilter">（已筛选，原 {{ requests.length }} 条）</template>
          </span>
          <div class="requests-toolbar">
            <TxInput
              v-model="searchInput"
              type="text"
              clearable
              placeholder="搜索模型 / 请求 ID / 客户端"
              class="requests-search"
              aria-label="搜索请求明细"
            />
            <TxButton v-if="hasFilter" variant="ghost" size="sm" @click="clearFilters">清除筛选</TxButton>
          </div>
        </div>
      </template>

      <TxDataTable
        :columns="columns"
        :data="paged.rows"
        row-key="requestId"
        striped
        bordered
        scroll-x
        :loading="res.loading.value"
        class="requests-table"
      >
        <template #cell-time="{ row }: { row: RequestDetailItem }">
          <span class="mono text-muted text-xs">{{ fmtClock(row.timestamp) }}</span>
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
          <span class="mono">{{ fmtLatency(row.latencyMs) }}</span>
        </template>

        <template #cell-tokens="{ row }: { row: RequestDetailItem }">
          <span class="mono">{{ fmtCompact(row.totalTokens ?? 0) }}</span>
        </template>

        <template #cell-requestId="{ row }: { row: RequestDetailItem }">
          <button type="button" class="request-id-btn mono" @click="openDetail(row)">
            {{ row.requestId.slice(0, 20) }}...
          </button>
        </template>

        <template #empty>
          <EmptyState
            :variant="hasFilter ? 'search-empty' : 'no-data'"
            :title="hasFilter ? '没有匹配的请求' : '暂无调用请求记录'"
            :description="hasFilter ? '换个关键词，或清除筛选后查看全部记录。' : '当客户端发起调用时，请求明细流水将实时呈现在此处。'"
            :action-label="hasFilter ? '清除筛选' : undefined"
            size="small"
            @action="clearFilters"
          />
        </template>
      </TxDataTable>

      <div v-if="paged.totalPages > 1" class="requests-pager">
        <TxPagination
          :current-page="paged.page"
          :page-size="paged.pageSize"
          :total="paged.total"
          show-info
          aria-label="请求明细分页"
          @update:current-page="scope.state.page = String($event)"
        />
      </div>
    </TxCard>

    <RequestDetail v-model="detailOpen" :request="selectedRequest" @close="detailOpen = false" />
    </template>
  </div>
</template>

<style scoped>
.analytics-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
  width: 100%;
  min-width: 0;
}
.requests-toolbar {
  margin-left: auto;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.requests-search {
  width: min(260px, 60vw);
}
.requests-pager {
  display: flex;
  justify-content: flex-end;
  margin-top: 12px;
}
.w-180px {
  width: min(180px, 46vw);
}
.w-130px {
  width: min(130px, 40vw);
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
