<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { TxCard } from '@talex-touch/tuffex/card'
import { TxDataTable } from '@talex-touch/tuffex/data-table'
import type { DataTableColumn } from '@talex-touch/tuffex/data-table'
import { TxFilterChips } from '@talex-touch/tuffex/filter-chips'
import { TxTag } from '@talex-touch/tuffex/tag'
import { TxButton } from '@talex-touch/tuffex/button'
import { TxModal } from '@talex-touch/tuffex/modal'
import { TxForm, TxFormItem } from '@talex-touch/tuffex/form'
import { TxInput } from '@talex-touch/tuffex/input'
import { TxSwitch } from '@talex-touch/tuffex/switch'
import { TxAlert } from '@talex-touch/tuffex/alert'
import { TxPagination } from '@talex-touch/tuffex/pagination'
import { toast } from '@talex-touch/tuffex/utils'
import PageHeader from '../components/PageHeader.vue'
import ErrorPanel from '../components/ErrorPanel.vue'
import LoadingBlock from '../components/LoadingBlock.vue'
import EmptyState from '../components/EmptyState.vue'
import { api } from '../api'
import { confirm } from '../lib/confirm'
import { focusInModal } from '../lib/focus'
import { debounce, paginate, useQueryState } from '../lib/listState'
import { useResource } from '../lib/resource'
import type { ChannelItem, ChannelsData, DiscoveredModel } from '../types'

const router = useRouter()
const PAGE_SIZE = 20

/** 搜索、状态筛选、页码进 URL（红队 D13）。 */
const scope = useQueryState({ q: '', status: 'all', page: '1' })
const filterTab = computed(() => scope.state.status)
const searchInput = ref(scope.state.q)
const applySearch = debounce(() => scope.patch({ q: searchInput.value.trim(), page: '1' }), 300)
watch(searchInput, () => applySearch())
watch(
  () => scope.state.q,
  (value) => {
    if (value !== searchInput.value.trim()) searchInput.value = value
  },
)

/**
 * 渠道列表读取：失败保留持久 error → ErrorPanel + 重试（红队 D2：原来只有会消失的 toast，
 * 页面随后看起来像「一个渠道都没有」）。
 */
const res = useResource(() => api.channels<ChannelsData>(true), [])
const channels = computed(() => res.data.value?.channels ?? [])
const reloadChannels = () => res.reload()

// Modal States
const showCreateModal = ref(false)
const createLoading = ref(false)
const createError = ref('')
const discovering = ref(false)
const discoveredModels = ref<DiscoveredModel[]>([])
const selectedModelIds = ref<Set<string>>(new Set())
const baseUrlFieldRef = ref<{ focus?: () => void } | null>(null)

// Channel Form
const createForm = reactive({
  name: '',
  protocol: 'openai' as 'openai' | 'claude',
  baseUrl: '',
  apiKey: '',
})

// Channel Detail / Models Modal
const showModelsModal = ref(false)
const inspectingChannel = ref<ChannelItem | null>(null)

// Columns：只给 width，整表靠 --table-min 撑宽（红队 D4：minWidth + 固定 width 混用会在窄屏压成 0）
const columns: DataTableColumn<ChannelItem>[] = [
  { key: 'name', title: '渠道名称', width: 180 },
  { key: 'baseUrl', title: '服务端点 (Base URL)', width: 320 },
  { key: 'models', title: '模型列表', width: 320 },
  { key: 'enabled', title: '渠道开关', width: 130 },
  { key: 'actions', title: '操作', width: 140, align: 'right' },
]

// Filtered channels
const filteredChannels = computed(() => {
  const q = scope.state.q.trim().toLowerCase()
  return channels.value.filter((channel) => {
    if (filterTab.value === 'enabled' && !channel.enabled) return false
    if (filterTab.value === 'disabled' && channel.enabled) return false
    if (q && !channel.name.toLowerCase().includes(q) && !channel.baseUrl.toLowerCase().includes(q)) return false
    return true
  })
})

const paged = computed(() => paginate(filteredChannels.value, Number(scope.state.page), PAGE_SIZE))
watch(
  () => paged.value.page,
  (page) => {
    if (String(page) !== scope.state.page) scope.state.page = String(page)
  },
)
const hasFilter = computed(() => Boolean(scope.state.q.trim()) || scope.state.status !== 'all')

function clearFilters() {
  scope.patch({ q: '', status: 'all', page: '1' })
  searchInput.value = ''
}

const filterOptions = computed(() => [
  { value: 'all', label: `全部渠道 (${channels.value.length})` },
  { value: 'enabled', label: `已启用 (${channels.value.filter((c) => c.enabled).length})` },
  { value: 'disabled', label: `已停用 (${channels.value.filter((c) => !c.enabled).length})` },
])

/** 停用渠道会立刻影响线上流量，先确认；启用不需要（红队 D27）。 */
async function handleToggleChannel(channel: ChannelItem) {
  if (channel.enabled) {
    const ok = await confirm({
      title: `停用渠道 ${channel.name}`,
      body: '停用后该渠道不再接流量，正在使用它的调用会立即失败，直到你重新启用。',
      confirmText: '停用渠道',
      danger: true,
    })
    if (!ok) return
  }
  try {
    await api.setChannelEnabled(channel.name, !channel.enabled)
    toast({
      title: channel.enabled ? '渠道已停用' : '渠道已启用',
      description: `“${channel.name}”状态已更新`,
      variant: 'success',
    })
    await reloadChannels()
  } catch (err) {
    toast({ title: '操作失败', description: err instanceof Error ? err.message : String(err), variant: 'danger' })
  }
}

async function handleToggleModel(channelName: string, modelId: string, currentEnabled: boolean) {
  try {
    await api.setModelEnabled(channelName, modelId, !currentEnabled)
    toast({
      title: currentEnabled ? '模型已禁用' : '模型已启用',
      description: `${modelId} 在渠道 ${channelName} 已更新`,
      variant: 'success',
    })
    await reloadChannels()
    if (inspectingChannel.value && inspectingChannel.value.name === channelName) {
      const target = inspectingChannel.value.models.find((m) => m.id === modelId)
      if (target) target.enabled = !currentEnabled
    }
  } catch (err) {
    toast({ title: '操作失败', description: err instanceof Error ? err.message : String(err), variant: 'danger' })
  }
}

function openInspectModels(channel: ChannelItem) {
  inspectingChannel.value = channel
  showModelsModal.value = true
}

/** 删除渠道走全局 confirm()：单一确认框、不再各页手写一份。 */
async function deleteChannel(channel: ChannelItem) {
  const ok = await confirm({
    title: `删除渠道 ${channel.name}`,
    body: `该渠道下的 ${channel.models.length} 个模型映射会从目录中移除，使用这些模型的调用会失败，且无法恢复。`,
    confirmText: '删除渠道',
    danger: true,
  })
  if (!ok) return
  try {
    await api.deleteChannel(channel.name)
    toast({ title: '删除成功', description: `渠道“${channel.name}”已删除`, variant: 'success' })
    await reloadChannels()
  } catch (err) {
    toast({ title: '删除失败', description: err instanceof Error ? err.message : String(err), variant: 'danger' })
  }
}

/** 批量剪枝 = 批量删除，必须先说清删除范围再执行（红队 D6）。 */
async function handlePruneStale() {
  const stale = channels.value.filter((channel) => channel.stale)
  const ok = await confirm({
    title: '清理失效残留渠道',
    body: stale.length
      ? `将删除 ${stale.length} 个已失效渠道：${stale.map((c) => c.name).join('、')}。删除后无法恢复。`
      : '将请求删除所有已失效的残留渠道（来源已不存在）。删除后无法恢复。',
    confirmText: '开始清理',
    danger: true,
  })
  if (!ok) return
  try {
    const res2 = await api.pruneStaleChannels()
    if (res2.removed?.length) {
      toast({ title: '清理完成', description: `已清理 ${res2.removed.length} 个失效残留渠道`, variant: 'success' })
      await reloadChannels()
    } else {
      toast({ title: '无需清理', description: '当前无失效残留渠道', variant: 'info' })
    }
  } catch (err) {
    toast({ title: '清理失败', description: err instanceof Error ? err.message : String(err), variant: 'danger' })
  }
}

function openCreateDialog() {
  createForm.name = ''
  createForm.protocol = 'openai'
  createForm.baseUrl = ''
  createForm.apiKey = ''
  discoveredModels.value = []
  selectedModelIds.value = new Set()
  createError.value = ''
  showCreateModal.value = true
  void focusInModal(baseUrlFieldRef.value, '.tx-modal__overlay input')
}

async function discoverModels() {
  if (!createForm.baseUrl.trim()) {
    createError.value = '请先填写 Base URL'
    return
  }
  discovering.value = true
  createError.value = ''
  try {
    const res = await api.discoverChannelModels({
      protocol: createForm.protocol,
      baseUrl: createForm.baseUrl.trim(),
      apiKey: createForm.apiKey.trim(),
    })
    discoveredModels.value = res.models || []
    selectedModelIds.value = new Set(res.models.map((m) => m.id))
    if (!createForm.name && res.endpoint) {
      createForm.name = res.endpoint.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24)
    }
    toast({ title: '探测成功', description: `成功发现 ${res.models.length} 个可用模型`, variant: 'success' })
  } catch (err) {
    createError.value = err instanceof Error ? err.message : '探测模型列表失败，请检查地址或凭证'
  } finally {
    discovering.value = false
  }
}

function toggleSelectModel(id: string) {
  if (selectedModelIds.value.has(id)) selectedModelIds.value.delete(id)
  else selectedModelIds.value.add(id)
}

async function submitCreateChannel() {
  if (!createForm.name.trim()) {
    createError.value = '请输入渠道名称'
    return
  }
  if (!createForm.baseUrl.trim()) {
    createError.value = '请输入 Base URL'
    return
  }
  if (!selectedModelIds.value.size) {
    createError.value = '请至少选择一个模型'
    return
  }

  createLoading.value = true
  createError.value = ''

  const modelsPayload = discoveredModels.value
    .filter((m) => selectedModelIds.value.has(m.id))
    .map((m) => ({ id: m.id, alias: m.alias || m.id }))

  try {
    await api.createChannel({
      name: createForm.name.trim(),
      protocol: createForm.protocol,
      baseUrl: createForm.baseUrl.trim(),
      apiKey: createForm.apiKey.trim(),
      models: modelsPayload,
    })
    toast({ title: '渠道创建成功', description: `渠道“${createForm.name}”已上线`, variant: 'success' })
    showCreateModal.value = false
    await reloadChannels()
  } catch (err) {
    createError.value = err instanceof Error ? err.message : String(err)
  } finally {
    createLoading.value = false
  }
}

</script>

<template>
  <div class="page">
    <!-- 头部横幅 -->
    <PageHeader
      title="渠道与服务网关"
      description="配置上游兼容渠道、直连供应商与模型路由；搜索、筛选与页码写在地址栏里。"
    >
      <template #actions>
        <TxButton variant="secondary" icon="i-carbon-clean" @click="handlePruneStale">
          清理失效残留
        </TxButton>
        <TxButton variant="secondary" icon="i-carbon-user-identification" @click="router.push('/oauth')">
          OAuth 登录池
        </TxButton>
        <TxButton variant="primary" icon="i-carbon-add" @click="openCreateDialog">
          添加渠道
        </TxButton>
      </template>
    </PageHeader>

    <!-- 失败：可读原因 + 重试；首次加载：骨架；其余：保留旧数据继续渲染，刷新不闪空 -->
    <ErrorPanel v-if="res.error.value" :error="res.error.value" :retry="reloadChannels" />
    <LoadingBlock v-else-if="!res.data.value" :lines="6" label="正在读取渠道列表" />

    <template v-else>
    <!-- 过滤器与概览 -->
    <div class="channels-toolbar">
      <TxFilterChips
        :model-value="filterTab"
        :items="filterOptions"
        aria-label="按渠道状态过滤"
        @update:model-value="scope.patch({ status: String($event), page: '1' })"
      />
      <div class="channels-search">
        <TxInput
          v-model="searchInput"
          placeholder="搜索渠道名或 Base URL"
          clearable
          prefix-icon="i-carbon-search"
          aria-label="搜索渠道"
        />
      </div>
      <TxButton v-if="hasFilter" variant="ghost" size="sm" @click="clearFilters">清除筛选</TxButton>
      <span class="muted text-12">
        共 {{ channels.length }} 个渠道，提供 {{ channels.reduce((acc, c) => acc + c.models.length, 0) }} 个模型映射
      </span>
    </div>

    <!-- 渠道表格 -->
    <TxCard :padding="0" class="channels-table-card">
      <TxDataTable
        :columns="columns"
        :data="paged.rows"
        row-key="name"
        scroll-x
        :style="{ '--table-min': '1080px' }"
        :loading="res.loading.value"
        aria-label="渠道列表"
      >
        <!-- 渠道名 -->
        <template #cell-name="{ row }: { row: ChannelItem }">
          <div class="channel-name-cell">
            <span class="channel-indicator" :class="{ active: row.enabled }" aria-hidden="true" />
            <div class="channel-name-text">
              <strong>{{ row.name }}</strong>
              <small v-if="row.stale" class="text-amber-600">已失效残留</small>
            </div>
          </div>
        </template>

        <!-- Base URL -->
        <template #cell-baseUrl="{ row }: { row: ChannelItem }">
          <div class="base-url-cell" :title="row.baseUrl">
            <code class="mono text-12">{{ row.baseUrl }}</code>
          </div>
        </template>

        <!-- 模型列表：真按钮，键盘可达（原来是不可聚焦的 div 点击） -->
        <template #cell-models="{ row }: { row: ChannelItem }">
          <button
            type="button"
            class="channel-models-preview"
            :aria-label="`查看并开关 ${row.name} 的 ${row.models.length} 个模型`"
            @click="openInspectModels(row)"
          >
            <template v-if="row.models.length">
              <TxTag
                v-for="model in row.models.slice(0, 3)"
                :key="model.id"
                size="sm"
                :variant="model.enabled ? 'soft' : 'outline'"
                :color="model.enabled ? 'var(--tx-color-primary)' : 'var(--tx-text-color-disabled)'"
                :label="model.id"
              />
              <TxTag v-if="row.models.length > 3" size="sm" variant="plain" :label="`+${row.models.length - 3}`" />
            </template>
            <span v-else class="muted text-12">未映射模型</span>
          </button>
        </template>

        <!-- 渠道开关 -->
        <template #cell-enabled="{ row }: { row: ChannelItem }">
          <TxSwitch
            :model-value="row.enabled"
            :aria-label="`${row.enabled ? '停用' : '启用'}渠道 ${row.name}`"
            @update:model-value="() => handleToggleChannel(row)"
          />
        </template>

        <!-- 操作栏：图标按钮带 aria-label（红队 D11） -->
        <template #cell-actions="{ row }: { row: ChannelItem }">
          <div class="table-actions-row">
            <TxButton
              size="sm"
              variant="secondary"
              icon="i-carbon-list"
              :title="`查看与开关 ${row.name} 的模型`"
              :aria-label="`查看与开关 ${row.name} 的模型`"
              @click="openInspectModels(row)"
            />
            <TxButton
              size="sm"
              variant="danger"
              icon="i-carbon-trash-can"
              :title="`删除渠道 ${row.name}`"
              :aria-label="`删除渠道 ${row.name}`"
              @click="deleteChannel(row)"
            />
          </div>
        </template>

        <template #empty>
          <EmptyState
            :variant="hasFilter ? 'search-empty' : 'empty'"
            :title="hasFilter ? '没有匹配的渠道' : '还没有配置渠道'"
            :description="
              hasFilter
                ? '换个关键词，或把状态筛选调回「全部渠道」。'
                : '添加一个上游渠道后，模型才能被调用。'
            "
            :action-label="hasFilter ? '清除筛选' : '添加渠道'"
            size="small"
            @action="hasFilter ? clearFilters() : openCreateDialog()"
          />
        </template>
      </TxDataTable>

      <div v-if="paged.totalPages > 1" class="channels-pager">
        <TxPagination
          :current-page="paged.page"
          :page-size="paged.pageSize"
          :total="paged.total"
          show-info
          aria-label="渠道列表分页"
          @update:current-page="scope.state.page = String($event)"
        />
      </div>
    </TxCard>
    </template>

    <!-- 添加渠道弹窗 -->
    <TxModal v-model="showCreateModal" title="添加新渠道" width="min(94vw, 680px)">
      <TxForm label-position="top" class="create-channel-form">
        <TxFormItem label="上游协议类型" required>
          <div class="protocol-radio-group">
            <label class="protocol-radio-item" :class="{ active: createForm.protocol === 'openai' }">
              <input v-model="createForm.protocol" type="radio" value="openai" />
              <strong>OpenAI / 兼容协议</strong>
              <small class="muted">适用于 standard /v1/chat/completions 服务端点</small>
            </label>
            <label class="protocol-radio-item" :class="{ active: createForm.protocol === 'claude' }">
              <input v-model="createForm.protocol" type="radio" value="claude" />
              <strong>Anthropic Claude 协议</strong>
              <small class="muted">适用于 /v1/messages 原生协议服务端点</small>
            </label>
          </div>
        </TxFormItem>

        <TxFormItem label="Base URL" required>
          <div class="input-with-button">
            <TxInput
              ref="baseUrlFieldRef"
              v-model="createForm.baseUrl"
              placeholder="https://api.example.com/v1"
              aria-label="Base URL"
            />
            <TxButton
              variant="secondary"
              icon="i-carbon-radar"
              :loading="discovering"
              @click="discoverModels"
            >
              探测模型
            </TxButton>
          </div>
        </TxFormItem>

        <TxFormItem label="API Key 访问密钥">
          <TxInput v-model="createForm.apiKey" type="password" placeholder="sk-..." />
        </TxFormItem>

        <TxFormItem label="渠道标识名称" required>
          <TxInput v-model="createForm.name" placeholder="例如：openrouter-hk、custom-groq" />
        </TxFormItem>

        <!-- 探测到的模型列表选择 -->
        <TxFormItem v-if="discoveredModels.length" label="选择接入的模型">
          <div class="discovered-models-box">
            <div
              v-for="m in discoveredModels"
              :key="m.id"
              class="discovered-model-item"
              :class="{ selected: selectedModelIds.has(m.id) }"
              @click="toggleSelectModel(m.id)"
            >
              <span class="checkbox-indicator" :class="{ checked: selectedModelIds.has(m.id) }" />
              <div class="model-id-alias">
                <strong>{{ m.id }}</strong>
                <small v-if="m.alias && m.alias !== m.id" class="muted mono">别名: {{ m.alias }}</small>
              </div>
            </div>
          </div>
          <small class="field-hint">已选中 {{ selectedModelIds.size }} / {{ discoveredModels.length }} 个模型</small>
        </TxFormItem>

        <TxAlert v-if="createError" variant="danger" :description="createError" />
      </TxForm>

      <template #footer>
        <div class="modal-footer-actions">
          <TxButton variant="secondary" @click="showCreateModal = false">取消</TxButton>
          <TxButton variant="primary" :loading="createLoading" @click="submitCreateChannel">
            确认并添加
          </TxButton>
        </div>
      </template>
    </TxModal>

    <!-- 渠道模型明细管理弹窗 -->
    <TxModal
      v-model="showModelsModal"
      :title="`渠道模型列表 - ${inspectingChannel?.name || ''}`"
      width="min(94vw, 640px)"
    >
      <div v-if="inspectingChannel" class="channel-inspect-body">
        <p class="muted text-12">该渠道下共注册 {{ inspectingChannel.models.length }} 个模型映射，可独立切换单个模型的在线状态。</p>
        <div class="inspect-models-list">
          <div
            v-for="model in inspectingChannel.models"
            :key="model.id"
            class="inspect-model-row"
          >
            <div class="model-info">
              <strong>{{ model.id }}</strong>
              <small class="muted">映射权重: {{ model.upstreams || 1 }}</small>
            </div>
            <TxSwitch
              :model-value="model.enabled"
              @update:model-value="() => handleToggleModel(inspectingChannel!.name, model.id, model.enabled)"
            />
          </div>
        </div>
      </div>
      <template #footer>
        <TxButton variant="primary" block @click="showModelsModal = false">完成</TxButton>
      </template>
    </TxModal>
  </div>
</template>

<style scoped>
.channels-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  margin-bottom: 4px;
}

.channels-search {
  width: min(260px, 60vw);
}

.channels-table-card {
  min-width: 0;
  overflow: hidden;
}

.channels-pager {
  display: flex;
  justify-content: flex-end;
  padding: 12px 16px;
}

.channel-name-cell {
  display: flex;
  align-items: center;
  gap: 8px;
}

.channel-indicator {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--tx-border-color);
}
.channel-indicator.active {
  background: var(--tx-color-success);
}

.channel-name-text {
  display: flex;
  flex-direction: column;
}

.channel-name-text strong {
  font-size: 13.5px;
}

/* 模型列表入口是真正的按钮：键盘可达、有可见焦点环 */
.channel-models-preview {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  width: 100%;
  padding: 2px 0;
  border: 0;
  background: transparent;
  font: inherit;
  color: inherit;
  text-align: left;
  cursor: pointer;
}
.channel-models-preview:hover {
  text-decoration: underline;
}

.table-actions-row {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
}

.create-channel-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.protocol-radio-group {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 10px;
}

.protocol-radio-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 12px;
  border: 1px solid var(--tx-border-color);
  border-radius: var(--tx-border-radius-base);
  background: var(--tx-fill-color-light);
  cursor: pointer;
  transition: all 0.15s ease;
}

.protocol-radio-item.active {
  border-color: var(--tx-color-primary);
  background: color-mix(in srgb, var(--tx-color-primary) 6%, var(--tx-bg-color));
}

.input-with-button {
  display: flex;
  gap: 8px;
}

.input-with-button :deep(.tuff-input-wrap) {
  flex: 1;
}

.discovered-models-box {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 8px;
  max-height: 240px;
  overflow-y: auto;
  padding: 6px;
  background: var(--tx-fill-color-lighter);
  border: 1px solid var(--tx-border-color);
  border-radius: var(--tx-border-radius-base);
}

.discovered-model-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 6px;
  background: var(--tx-bg-color);
  border: 1px solid var(--tx-border-color-lighter);
  cursor: pointer;
  transition: all 0.15s ease;
}

.discovered-model-item.selected {
  border-color: var(--tx-color-primary);
  background: color-mix(in srgb, var(--tx-color-primary) 6%, var(--tx-bg-color));
}

.checkbox-indicator {
  width: 14px;
  height: 14px;
  border: 1px solid var(--tx-border-color);
  border-radius: 3px;
  flex-shrink: 0;
}
.checkbox-indicator.checked {
  background: var(--tx-color-primary);
  border-color: var(--tx-color-primary);
}

.model-id-alias {
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.model-id-alias strong {
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.channel-inspect-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.inspect-models-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 380px;
  overflow-y: auto;
}

.inspect-model-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  border: 1px solid var(--tx-border-color);
  border-radius: var(--tx-border-radius-base);
  background: var(--tx-fill-color-light);
}

.model-info {
  display: flex;
  flex-direction: column;
}

.modal-footer-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  width: 100%;
}
</style>
