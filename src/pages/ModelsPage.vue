<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { TxCard } from '@talex-touch/tuffex/card'
import { TxDataTable } from '@talex-touch/tuffex/data-table'
import { TxTag } from '@talex-touch/tuffex/tag'
import { TxButton } from '@talex-touch/tuffex/button'
import { TxSearchInput } from '@talex-touch/tuffex/search-input'
import { TxFilterChips } from '@talex-touch/tuffex/filter-chips'
import { TxAlert } from '@talex-touch/tuffex/alert'
import { TxSelect, TxSelectItem } from '@talex-touch/tuffex/select'
import { TxPagination } from '@talex-touch/tuffex/pagination'
import PageHeader from '../components/PageHeader.vue'
import ErrorPanel from '../components/ErrorPanel.vue'
import LoadingBlock from '../components/LoadingBlock.vue'
import EmptyState from '../components/EmptyState.vue'
import { api } from '../api'
import { confirm } from '../lib/confirm'
import { debounce, paginate, useQueryState } from '../lib/listState'
import { useResource } from '../lib/resource'
import { fmtCompact, fmtInt, fmtUsd } from '../lib/format'
import type { ApiKeyItem, ModelCost, ModelEntry, ModelIndexData, ModelSource, UsageBreakdownData } from '../types'

/** 服务端 model-index 会带上 thinking（effort 档位），但 client types 里还没声明，这里就地补一层。 */
type ModelEntryRuntime = ModelEntry & { thinking?: { levels?: string[]; min?: number } }

const PAGE_SIZES = [25, 50, 100]
const SORTS = [
  { value: 'name', label: '按名称' },
  { value: 'input', label: '按输入单价' },
  { value: 'output', label: '按输出单价' },
  { value: 'usage', label: '按用量' },
  { value: 'sources', label: '按渠道数' },
]

/**
 * D12：527 行裸渲染 → 分页 + 搜索 + 排序 + 筛选，全部写进 URL。
 * 深链示例：`/models?q=claude&kind=oauth&filter=contested&sort=usage&dir=desc&size=50&page=2&days=30`
 * （`src/lib/listState.ts` 的 useQueryState：默认值不写进 URL，分享链接/刷新/后退都保持同一视图）
 */
const scope = useQueryState({
  q: '',
  filter: 'all',
  channel: '',
  kind: 'all',
  sort: 'name',
  dir: 'asc',
  size: '25',
  page: '1',
  days: '7',
  keyId: '',
})

const days = computed(() => {
  const value = Number(scope.state.days)
  return [1, 7, 30, 90].includes(value) ? value : 7
})
const pageSize = computed(() => {
  const value = Number(scope.state.size)
  return PAGE_SIZES.includes(value) ? value : 25
})
const filter = computed(() => scope.state.filter)
const sortKey = computed(() => (SORTS.some((item) => item.value === scope.state.sort) ? scope.state.sort : 'name'))
const dir = computed<'asc' | 'desc'>(() => (scope.state.dir === 'desc' ? 'desc' : 'asc'))

// 搜索框用本地 draft，300ms 后才写 URL（避免每击键都改地址栏）。
const searchInput = ref(scope.state.q)
const applySearch = debounce(() => scope.patch({ q: searchInput.value.trim(), page: '1' }), 300)
watch(searchInput, () => applySearch())
watch(
  () => scope.state.q,
  (value) => {
    if (value !== searchInput.value.trim()) searchInput.value = value
  },
)

type BootstrapPayload = { keys?: ApiKeyItem[] }
const indexRes = useResource(() => api.modelIndex<ModelIndexData>(true), [])
const usageRes = useResource(
  () => api.usageBreakdown<UsageBreakdownData>(days.value, scope.state.keyId),
  [() => scope.state.days, () => scope.state.keyId],
)
const keysRes = useResource(() => api.bootstrap<BootstrapPayload>(), [])

const models = computed<ModelEntryRuntime[]>(() => indexRes.data.value?.models ?? [])
const channels = computed(() => indexRes.data.value?.channels ?? [])
const keys = computed(() => keysRes.data.value?.keys ?? [])
/** 汇总卡与表格同源：usage 失败不该把模型目录一起顶掉（R2）。 */
const usage = computed(() => usageRes.data.value)
const error = computed(() => indexRes.error.value ?? usageRes.error.value)
const reloadAll = () => Promise.all([indexRes.reload(), usageRes.reload(), keysRes.reload()])
const showSkeleton = computed(() => !models.value.length && !error.value)

const busyToken = ref('')
const syncing = ref(false)
/** 持久提示：同步与单渠道开关的结果都落在这里（原来 emit('notify') 全仓无人监听 + catch{} 吞错）。 */
const notice = ref<{ type: 'success' | 'warning' | 'error'; message: string } | null>(null)

const kindLabel: Record<string, string> = { compat: '兼容渠道', oauth: '账号池' }
const publicModelId = (model: string) => (model.includes('/') ? model.slice(model.lastIndexOf('/') + 1) : model)

const usageByModel = computed(() => {
  const result = new Map<string, ModelCost>()
  for (const row of usage.value?.models || []) {
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

const contestedCount = computed(() => models.value.filter((m) => m.contested).length)
const channelOptions = computed(() =>
  channels.value
    .map((channel) => ({ value: channel.name, label: channel.name }))
    .sort((a, b) => a.label.localeCompare(b.label)),
)

const filterChips = computed(() => [
  { value: 'all', label: `全部 (${models.value.length})` },
  { value: 'enabled', label: `在用 (${models.value.filter((m) => m.enabledSources > 0).length})` },
  { value: 'contested', label: `多渠道 (${contestedCount.value})` },
  { value: 'off', label: `已停用 (${models.value.filter((m) => m.enabledSources === 0).length})` },
])

const filteredModels = computed(() => {
  const needle = scope.state.q.trim().toLowerCase()
  return models.value.filter((model) => {
    if (filter.value === 'enabled' && model.enabledSources === 0) return false
    if (filter.value === 'contested' && !model.contested) return false
    if (filter.value === 'off' && model.enabledSources > 0) return false
    if (scope.state.channel && !model.sources.some((source) => source.channel === scope.state.channel)) return false
    if (scope.state.kind !== 'all' && !model.sources.some((source) => source.kind === scope.state.kind)) return false
    if (!needle) return true
    const haystack = [model.id, publicModelId(model.id), ...model.sources.map((s) => s.channel)].join(' ').toLowerCase()
    return haystack.includes(needle)
  })
})

/** 排序：未定价的模型永远排在最后（无论升序降序），免得「最便宜」被一堆未定价占满。 */
const sortedModels = computed(() => {
  const direction = dir.value === 'desc' ? -1 : 1
  const number = (value: number | null | undefined) => (typeof value === 'number' && Number.isFinite(value) ? value : null)
  const nullable = (a: number | null, b: number | null) => {
    if (a === null && b === null) return 0
    if (a === null) return 1
    if (b === null) return -1
    return (a - b) * direction
  }
  const list = [...filteredModels.value]
  list.sort((a, b) => {
    switch (sortKey.value) {
      case 'input':
        return nullable(number(a.pricing?.input), number(b.pricing?.input)) || a.id.localeCompare(b.id)
      case 'output':
        return nullable(number(a.pricing?.output), number(b.pricing?.output)) || a.id.localeCompare(b.id)
      case 'usage':
        return nullable(
          usageByModel.value.get(a.id)?.totalTokens ?? 0,
          usageByModel.value.get(b.id)?.totalTokens ?? 0,
        ) || a.id.localeCompare(b.id)
      case 'sources':
        return (a.sources.length - b.sources.length) * direction || a.id.localeCompare(b.id)
      default:
        return a.id.localeCompare(b.id) * direction
    }
  })
  return list
})

const paged = computed(() => paginate(sortedModels.value, Number(scope.state.page), pageSize.value))
watch(
  () => paged.value.page,
  (page) => {
    if (String(page) !== scope.state.page) scope.state.page = String(page)
  },
)
const hasFilter = computed(() =>
  Boolean(scope.state.q.trim()) ||
  scope.state.filter !== 'all' ||
  Boolean(scope.state.channel) ||
  scope.state.kind !== 'all',
)

function clearFilters() {
  scope.patch({ q: '', filter: 'all', channel: '', kind: 'all', page: '1' })
  searchInput.value = ''
}

function setDays(value: string | number) {
  scope.patch({ days: String(value), page: '1' })
}

function setKey(value: string | number) {
  scope.patch({ keyId: String(value), page: '1' })
}

function toggleDir() {
  scope.state.dir = dir.value === 'asc' ? 'desc' : 'asc'
}

const priceFmt = (value: number | null | undefined) => (value === null || value === undefined ? '—' : `$${value.toLocaleString('en-US', { maximumFractionDigits: 4 })}`)
const moneyFmt = (value: number | null) => (value === null ? '未定价' : fmtUsd(value))

const columns = [
  { key: 'model', title: '模型名称', width: 260 },
  { key: 'sources', title: '服务渠道映射', width: 300 },
  { key: 'pricing', title: '每 1M Token 定价', width: 260 },
  { key: 'usage', title: '用量与花费', width: 200, align: 'right' as const },
]

async function toggleSource(model: ModelEntry, source: ModelSource) {
  const token = `${model.id}@${source.channel}`
  busyToken.value = token
  try {
    await api.setModelSourceEnabled(model.id, source.channel, source.kind, !source.enabled)
    notice.value = { type: 'success', message: `${model.id} 在「${source.channel}」已${source.enabled ? '停用' : '启用'}。` }
    await indexRes.reload()
  } catch (err) {
    notice.value = {
      type: 'error',
      message: `${model.id} 在「${source.channel}」切换失败：${err instanceof Error ? err.message : '未知错误'}。`,
    }
  } finally {
    busyToken.value = ''
  }
}

/** 真正的同步动作（重试按钮直接复用它，不再弹一次确认）。 */
async function performSync() {
  syncing.value = true
  notice.value = null
  try {
    const res = await api.syncUpstreamModels()
    notice.value = {
      type: 'success',
      message: `同步成功：新增 ${res.result.addedModels.length} 个模型，现共 ${res.result.totalModels} 个。`,
    }
    await Promise.all([indexRes.reload(), usageRes.reload()])
  } catch (err) {
    notice.value = {
      type: 'error',
      message: `同步失败：${err instanceof Error ? err.message : '未知错误'}。上游目录未被修改，可稍后重试。`,
    }
  } finally {
    syncing.value = false
  }
}

/**
 * N1：「动态同步最新模型」是全局写操作（重写模型目录，会影响正在路由的请求），
 * 先 `await confirm({danger:true})`；结果用持久提示，不再走无人监听的 `emit('notify')`。
 */
async function handleSyncUpstream() {
  const ok = await confirm({
    title: '同步上游最新模型',
    body: '这会向上游网关拉取最新模型列表并重写本地模型目录：可能新增、更新或下线模型与渠道映射，进而影响正在路由的请求。',
    confirmText: '开始同步',
    danger: true,
  })
  if (!ok) return
  await performSync()
}
</script>

<template>
  <div class="page-stack models-page">
    <PageHeader
      title="模型总览"
      description="实时渠道状态、每百万 token 单价与用量花费；搜索、筛选、排序与页码都写在地址栏里，方便直接分享某个模型的定位链接。"
    >
      <template #actions>
        <TxSearchInput
          v-model="searchInput"
          placeholder="搜索模型名 / 别名 / 渠道"
          class="search-input"
          aria-label="搜索模型"
        />
        <TxSelect :model-value="scope.state.channel" placeholder="全部渠道" class="w-180px" @update:model-value="v => scope.patch({ channel: String(v), page: '1' })">
          <TxSelectItem value="" label="全部渠道" />
          <TxSelectItem v-for="c in channelOptions" :key="c.value" :value="c.value" :label="c.label" />
        </TxSelect>
        <TxSelect :model-value="scope.state.kind" placeholder="全部协议" class="w-140px" @update:model-value="v => scope.patch({ kind: String(v), page: '1' })">
          <TxSelectItem value="all" label="全部协议" />
          <TxSelectItem value="compat" label="兼容渠道" />
          <TxSelectItem value="oauth" label="账号池" />
        </TxSelect>
        <TxSelect :model-value="scope.state.keyId" placeholder="选择 API Key" class="w-180px" @update:model-value="setKey">
          <TxSelectItem value="" label="全部 API Key" />
          <TxSelectItem v-for="k in keys" :key="k.id" :value="k.id" :label="k.name" />
        </TxSelect>
        <TxSelect :model-value="scope.state.days" placeholder="时间跨度" class="w-130px" @update:model-value="setDays">
          <TxSelectItem value="1" label="最近 24 小时" />
          <TxSelectItem value="7" label="最近 7 天" />
          <TxSelectItem value="30" label="最近 30 天" />
          <TxSelectItem value="90" label="最近 90 天" />
        </TxSelect>
        <TxButton variant="primary" :loading="syncing" @click="handleSyncUpstream">
          动态同步最新模型
        </TxButton>
        <TxButton variant="secondary" :loading="indexRes.loading.value || usageRes.loading.value" @click="reloadAll">
          刷新
        </TxButton>
      </template>
    </PageHeader>

    <!-- N1：同步 / 开关渠道的持久结果提示（closable，不会 7 秒后消失） -->
    <TxAlert v-if="notice" :type="notice.type" :closable="true" @close="notice = null">
      <div class="notice-body">
        <span>{{ notice.message }}</span>
        <TxButton v-if="notice.type === 'error' && notice.message.startsWith('同步失败')" variant="secondary" size="sm" @click="performSync">
          重试同步
        </TxButton>
      </div>
    </TxAlert>

    <!-- R2：失败但没有旧数据 → 阻断式错误面；有旧数据 → 顶部非阻断横幅，数据留在原地 -->
    <ErrorPanel v-if="error && !models.length" :error="error" :retry="reloadAll" />
    <LoadingBlock v-else-if="showSkeleton" :lines="8" label="正在读取模型目录" />

    <template v-else>
      <ErrorPanel
        v-if="error"
        inline
        :error="error"
        :retry="reloadAll"
        stale-hint="下方仍是最近一次成功读取的模型目录，可以继续查看。"
      />

      <!-- 顶部汇总指标卡 -->
      <div class="metric-row">
        <TxCard class="stat-box">
          <span class="stat-label">总花费</span>
          <strong class="stat-value">{{ moneyFmt(usage?.totals?.totalCostUsd ?? 0) }}</strong>
          <small class="stat-sub">{{ fmtCompact(usage?.totals?.totalTokens || 0) }} tokens</small>
        </TxCard>
        <TxCard class="stat-box">
          <span class="stat-label">输入花费</span>
          <strong class="stat-value">{{ moneyFmt(usage?.totals?.inputCostUsd ?? 0) }}</strong>
          <small class="stat-sub">{{ fmtInt(usage?.totals?.requests || 0) }} 次请求</small>
        </TxCard>
        <TxCard class="stat-box">
          <span class="stat-label">输出花费</span>
          <strong class="stat-value">{{ moneyFmt(usage?.totals?.outputCostUsd ?? 0) }}</strong>
          <small class="stat-sub">近 {{ days }} 天统计</small>
        </TxCard>
        <TxCard class="stat-box">
          <span class="stat-label">缓存节省</span>
          <strong class="stat-value">{{ moneyFmt(usage?.totals?.cacheCostUsd ?? 0) }}</strong>
          <small class="stat-sub">读写缓存命中支持</small>
        </TxCard>
      </div>

      <TxAlert v-if="contestedCount > 0" type="warning" title="存在多渠道提供模型" :closable="false">
        有 {{ contestedCount }} 个模型名同时由多个渠道提供。请求会在启用渠道间自动轮询/路由；只选择特定渠道的 Key 不会发生跨渠道溢出。
      </TxAlert>

      <!-- 筛选工具栏 -->
      <TxCard :padding="14">
        <div class="table-toolbar">
          <TxFilterChips
            :model-value="filter"
            :items="filterChips"
            aria-label="按模型状态过滤"
            @update:model-value="v => scope.patch({ filter: String(v), page: '1' })"
          />
          <div class="toolbar-end">
            <span class="muted text-12">排序</span>
            <TxSelect :model-value="sortKey" :options="SORTS" class="w-140px" aria-label="排序字段" @update:model-value="v => scope.patch({ sort: String(v), page: '1' })" />
            <TxButton variant="secondary" size="sm" :aria-label="dir === 'asc' ? '当前升序，切换为降序' : '当前降序，切换为升序'" @click="toggleDir">
              {{ dir === 'asc' ? '升序 ↑' : '降序 ↓' }}
            </TxButton>
            <TxSelect
              :model-value="scope.state.size"
              :options="PAGE_SIZES.map(n => ({ value: String(n), label: `每页 ${n} 条` }))"
              class="w-140px"
              aria-label="每页条数"
              @update:model-value="v => scope.patch({ size: String(v), page: '1' })"
            />
            <TxButton v-if="hasFilter" variant="ghost" size="sm" @click="clearFilters">清除筛选</TxButton>
          </div>
        </div>

        <p class="muted text-12 table-count">
          共 {{ sortedModels.length }} 个模型<template v-if="hasFilter">（已筛选，原 {{ models.length }} 个）</template>，第 {{ paged.page }} / {{ paged.totalPages }} 页
        </p>

        <!-- 模型数据表格 -->
        <TxDataTable
          :columns="columns"
          :data="paged.rows"
          row-key="id"
          striped
          bordered
          scroll-x
          :style="{ '--table-min': '1060px' }"
          :loading="indexRes.loading.value"
          aria-label="模型目录"
          class="models-table"
        >
          <template #cell-model="{ row }: { row: ModelEntryRuntime }">
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

          <template #cell-sources="{ row }: { row: ModelEntryRuntime }">
            <div class="channel-chips">
              <button
                v-for="s in row.sources"
                :key="`${s.channel}:${s.kind}`"
                type="button"
                class="channel-chip-btn"
                :class="{ active: s.enabled, disabled: !s.channelEnabled && !s.enabled }"
                :disabled="busyToken === `${row.id}@${s.channel}` || (!s.channelEnabled && !s.enabled)"
                :aria-label="`${s.enabled ? '停用' : '启用'} ${row.id} 在渠道 ${s.channel} 的映射`"
                :title="`${kindLabel[s.kind] || s.kind}${s.channelEnabled ? '' : ' (渠道不可用)'}`"
                @click="toggleSource(row, s)"
              >
                <span class="chip-dot" :class="{ 'chip-dot--active': s.enabled }" />
                <span>{{ s.channel }}</span>
                <em v-if="s.upstreams > 1" class="chip-mult">×{{ s.upstreams }}</em>
              </button>
            </div>
          </template>

          <template #cell-pricing="{ row }: { row: ModelEntryRuntime }">
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

          <template #cell-usage="{ row }: { row: ModelEntryRuntime }">
            <div v-if="usageByModel.get(row.id)" class="usage-cell">
              <div class="usage-cost mono">{{ moneyFmt(usageByModel.get(row.id)?.totalCostUsd ?? null) }}</div>
              <div class="usage-sub text-muted">
                {{ fmtCompact(usageByModel.get(row.id)?.totalTokens || 0) }} tokens · {{ usageByModel.get(row.id)?.requests }} 次
              </div>
            </div>
            <span v-else class="text-muted">近 {{ days }} 天无用量</span>
          </template>

          <template #empty>
            <EmptyState
              :variant="hasFilter ? 'search-empty' : 'no-data'"
              :title="hasFilter ? '没有匹配的模型' : '模型目录为空'"
              :description="hasFilter ? '换个关键词，或清除筛选后查看全部模型。' : '点右上角「动态同步最新模型」从上游拉取一次目录。'"
              :action-label="hasFilter ? '清除筛选' : undefined"
              size="small"
              @action="clearFilters"
            />
          </template>
        </TxDataTable>

        <div v-if="paged.totalPages > 1" class="models-pager">
          <TxPagination
            :current-page="paged.page"
            :page-size="paged.pageSize"
            :total="paged.total"
            show-info
            aria-label="模型目录分页"
            @update:current-page="scope.state.page = String($event)"
          />
        </div>
      </TxCard>
    </template>
  </div>
</template>

<style scoped>
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

.notice-body {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
}
.table-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}
.toolbar-end {
  margin-left: auto;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.table-count {
  margin: 10px 0 6px;
}
.models-pager {
  display: flex;
  justify-content: flex-end;
  margin-top: 12px;
}
.search-input {
  width: min(260px, 60vw);
}
.w-140px {
  width: min(140px, 42vw);
}
.w-180px {
  width: min(180px, 46vw);
}
.w-130px {
  width: min(130px, 40vw);
}
</style>