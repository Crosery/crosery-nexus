<script setup lang="ts">
import { computed, ref, reactive, onMounted } from 'vue'
import { TxCard } from '@talex-touch/tuffex/card'
import { TxDataTable } from '@talex-touch/tuffex/data-table'
import type { DataTableColumn } from '@talex-touch/tuffex/data-table'
import { TxFilterChips } from '@talex-touch/tuffex/filter-chips'
import { TxTag } from '@talex-touch/tuffex/tag'
import { TxButton } from '@talex-touch/tuffex/button'
import { TxModal } from '@talex-touch/tuffex/modal'
import { TxForm, TxFormItem } from '@talex-touch/tuffex/form'
import { TxInput } from '@talex-touch/tuffex/input'
import { TxTextarea } from '@talex-touch/tuffex/textarea'
import { TxSwitch } from '@talex-touch/tuffex/switch'
import { TxAlert } from '@talex-touch/tuffex/alert'
import { toast } from '@talex-touch/tuffex/utils'
import { api } from '../../../api'
import type { ApiKeyItem, GatewayModelAccess, Group, QuotaWindowState } from '../../../types'

const props = withDefaults(
  defineProps<{
    keys?: ApiKeyItem[]
    groups?: Group[]
    quotaTimeZone?: string
    gatewayModelAccess?: GatewayModelAccess
  }>(),
  {
    keys: () => [],
    groups: () => [],
    quotaTimeZone: 'UTC',
    gatewayModelAccess: 'available',
  },
)

const emit = defineEmits<{
  (e: 'refresh'): void
  (e: 'select-key', key: ApiKeyItem): void
  (e: 'notify', msg: string): void
}>()

// State
const internalKeys = ref<ApiKeyItem[]>([])
const internalGroups = ref<Group[]>([])
const searchQuery = ref('')
const statusFilter = ref<'all' | 'enabled' | 'disabled' | 'blocked'>('all')
const loading = ref(false)

const effectiveKeys = computed(() => (props.keys?.length ? props.keys : internalKeys.value))
const effectiveGroups = computed(() => (props.groups?.length ? props.groups : internalGroups.value))

// Modal States
const showEditorModal = ref(false)
const editingItem = ref<ApiKeyItem | null>(null)
const editorSaving = ref(false)
const editorError = ref('')

// Quota Modal
const showQuotaModal = ref(false)
const quotaTarget = ref<ApiKeyItem | null>(null)
const quotaSaving = ref(false)
const quotaError = ref('')
const quotaUnlimited = ref(false)
const quotaValues = reactive({ total: '', daily: '', weekly: '' })

// Reveal Modal
const showRevealModal = ref(false)
const newlyCreatedKey = ref('')

// Delete confirm
const showDeleteConfirm = ref(false)
const deleting = ref(false)

// Editor Form
const editorForm = reactive({
  name: '',
  note: '',
  enabled: true,
  groups: [] as string[],
  unlimited: false,
  totalConcurrency: 4,
  groupConcurrency: {} as Record<string, number>,
})

// Filter Chips
const filterOptions = computed(() => [
  { value: 'all', label: `全部密钥 (${effectiveKeys.value.length})` },
  { value: 'enabled', label: `已启用 (${effectiveKeys.value.filter((k) => k.enabled && !k.blockedReason).length})` },
  { value: 'disabled', label: `已停用 (${effectiveKeys.value.filter((k) => !k.enabled).length})` },
  { value: 'blocked', label: `超额停用 (${effectiveKeys.value.filter((k) => Boolean(k.blockedReason)).length})` },
])

// Filtered data
const filteredKeys = computed(() => {
  return effectiveKeys.value.filter((key) => {
    // Status filter
    if (statusFilter.value === 'enabled' && (!key.enabled || key.blockedReason)) return false
    if (statusFilter.value === 'disabled' && key.enabled) return false
    if (statusFilter.value === 'blocked' && !key.blockedReason) return false

    // Search query
    if (searchQuery.value.trim()) {
      const q = searchQuery.value.trim().toLowerCase()
      const match =
        key.name.toLowerCase().includes(q) ||
        key.maskedKey.toLowerCase().includes(q) ||
        (key.note && key.note.toLowerCase().includes(q))
      if (!match) return false
    }
    return true
  })
})

// Columns
const columns: DataTableColumn<ApiKeyItem>[] = [
  { key: 'name', title: '名称与标识', minWidth: 200 },
  { key: 'groups', title: '授权渠道分组', minWidth: 220 },
  { key: 'concurrency', title: '并发控制', width: 120 },
  { key: 'quota', title: '额度消费进度', minWidth: 220 },
  { key: 'lastUsedAt', title: '最近调用', width: 140 },
  { key: 'status', title: '状态', width: 100 },
  { key: 'actions', title: '操作', width: 160, align: 'right' },
]

// Quota Helper
function formatResets(resetsAt: string | null) {
  if (!resetsAt) return '手动重置'
  return new Date(resetsAt).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

// Actions
async function reloadData() {
  loading.value = true
  try {
    const data = await api.bootstrap<{ keys: ApiKeyItem[]; groups: Group[] }>()
    if (data?.keys) internalKeys.value = data.keys
    if (data?.groups) internalGroups.value = data.groups
    emit('refresh')
  } catch (err) {
    toast({ title: '加载密钥失败', description: err instanceof Error ? err.message : String(err), variant: 'danger' })
  } finally {
    loading.value = false
  }
}

async function copyKey(key: ApiKeyItem) {
  try {
    const { token } = await api.createRevealToken(key.id)
    const { key: fullKey } = await api.revealKey(key.id, token)
    await navigator.clipboard.writeText(fullKey)
    toast({ title: '复制成功', description: `“${key.name}”的完整密钥已复制到剪贴板`, variant: 'success' })
  } catch (err) {
    toast({ title: '复制失败', description: err instanceof Error ? err.message : String(err), variant: 'danger' })
  }
}

async function toggleKeyStatus(key: ApiKeyItem) {
  if (key.blockedReason) {
    toast({ title: '无法启用', description: '该 Key 因额度超限停用，请先调整额度或重置', variant: 'warning' })
    return
  }
  try {
    await api.updateKey(key.id, { enabled: !key.enabled })
    toast({ title: key.enabled ? '已停用' : '已启用', description: `密钥“${key.name}”状态已更新`, variant: 'success' })
    await reloadData()
  } catch (err) {
    toast({ title: '操作失败', description: err instanceof Error ? err.message : String(err), variant: 'danger' })
  }
}

function openCreateModal() {
  editingItem.value = null
  editorForm.name = ''
  editorForm.note = ''
  editorForm.enabled = true
  editorForm.groups = effectiveGroups.value.map((g) => g.id)
  editorForm.unlimited = false
  editorForm.totalConcurrency = 4
  editorForm.groupConcurrency = Object.fromEntries(effectiveGroups.value.map((g) => [g.id, 2]))
  editorError.value = ''
  showEditorModal.value = true
}

function openEditModal(key: ApiKeyItem) {
  editingItem.value = key
  editorForm.name = key.name
  editorForm.note = key.note || ''
  editorForm.enabled = key.enabled
  editorForm.groups = [...key.groups]
  editorForm.unlimited = key.totalConcurrency === 0
  editorForm.totalConcurrency = key.totalConcurrency || 4
  editorForm.groupConcurrency = { ...(key.groupConcurrency || {}) }
  editorError.value = ''
  showEditorModal.value = true
}

function toggleGroupSelection(groupId: string) {
  const set = new Set(editorForm.groups)
  if (set.has(groupId)) set.delete(groupId)
  else set.add(groupId)
  editorForm.groups = [...set]
}

async function saveKeyEditor() {
  if (!editorForm.name.trim()) {
    editorError.value = '请输入密钥显示名称'
    return
  }
  if (!editorForm.groups.length) {
    editorError.value = '请至少选择一个渠道分组'
    return
  }

  editorSaving.value = true
  editorError.value = ''

  const payload = {
    name: editorForm.name.trim(),
    note: editorForm.note.trim(),
    enabled: editorForm.enabled,
    groups: editorForm.groups,
    totalConcurrency: editorForm.unlimited ? 0 : editorForm.totalConcurrency,
    groupConcurrency: editorForm.unlimited ? {} : editorForm.groupConcurrency,
  }

  try {
    if (editingItem.value) {
      await api.updateKey(editingItem.value.id, payload)
      toast({ title: '更新成功', description: `“${editorForm.name}”配置已保存`, variant: 'success' })
      showEditorModal.value = false
    } else {
      const res = await api.createKey<{ key: string }>(payload)
      showEditorModal.value = false
      newlyCreatedKey.value = res.key
      showRevealModal.value = true
      toast({ title: '创建成功', description: `“${editorForm.name}”已创建`, variant: 'success' })
    }
    await reloadData()
  } catch (err) {
    editorError.value = err instanceof Error ? err.message : String(err)
  } finally {
    editorSaving.value = false
  }
}

async function confirmDeleteKey() {
  if (!editingItem.value) return
  deleting.value = true
  try {
    await api.deleteKey(editingItem.value.id)
    toast({ title: '删除成功', description: `密钥“${editingItem.value.name}”已彻底移除`, variant: 'success' })
    showDeleteConfirm.value = false
    showEditorModal.value = false
    await reloadData()
  } catch (err) {
    toast({ title: '删除失败', description: err instanceof Error ? err.message : String(err), variant: 'danger' })
  } finally {
    deleting.value = false
  }
}

// Quota
function openQuotaModal(key: ApiKeyItem) {
  quotaTarget.value = key
  quotaUnlimited.value = key.quotaState.unlimited
  quotaValues.total = key.quota.totalUsd ? String(key.quota.totalUsd) : ''
  quotaValues.daily = key.quota.dailyUsd ? String(key.quota.dailyUsd) : ''
  quotaValues.weekly = key.quota.weeklyUsd ? String(key.quota.weeklyUsd) : ''
  quotaError.value = ''
  showQuotaModal.value = true
}

async function saveQuota() {
  if (!quotaTarget.value) return
  quotaSaving.value = true
  quotaError.value = ''
  try {
    await api.updateQuota(quotaTarget.value.id, {
      totalUsd: quotaUnlimited.value ? 0 : Number(quotaValues.total) || 0,
      dailyUsd: quotaUnlimited.value ? 0 : Number(quotaValues.daily) || 0,
      weeklyUsd: quotaUnlimited.value ? 0 : Number(quotaValues.weekly) || 0,
    })
    toast({ title: '额度已更新', description: `“${quotaTarget.value.name}”的限额规则已生效`, variant: 'success' })
    showQuotaModal.value = false
    await reloadData()
  } catch (err) {
    quotaError.value = err instanceof Error ? err.message : String(err)
  } finally {
    quotaSaving.value = false
  }
}

async function handleResetQuota(window: 'total' | 'daily' | 'weekly') {
  if (!quotaTarget.value) return
  try {
    await api.resetQuota(quotaTarget.value.id, window)
    toast({ title: '重置完成', description: `已重置 ${window} 额度消耗记录`, variant: 'success' })
    await reloadData()
    // Update local preview
    if (quotaTarget.value) {
      quotaTarget.value.quotaState[window].spentUsd = 0
    }
  } catch (err) {
    toast({ title: '重置失败', description: err instanceof Error ? err.message : String(err), variant: 'danger' })
  }
}

onMounted(() => {
  if (!props.keys?.length) {
    void reloadData()
  }
})
</script>

<template>
  <div class="page">
    <!-- 头部横幅 -->
    <header class="page-head">
      <div class="page-head__text">
        <div class="eyebrow-tag">ACCESS CONTROL</div>
        <h1>API Key 管理</h1>
        <p>
          创建与管理用户访问密钥，支持细粒度的渠道分组白名单、并发保护与周期消费额度。
          <span v-if="quotaTimeZone" class="muted">（服务器时区：{{ quotaTimeZone }}）</span>
        </p>
      </div>
      <div class="page-head__actions">
        <TxButton variant="primary" icon="i-carbon-add" @click="openCreateModal">
          创建 API Key
        </TxButton>
      </div>
    </header>

    <!-- 网关限制提示 -->
    <TxAlert
      v-if="gatewayModelAccess === 'unavailable'"
      variant="warning"
      title="网关白名单提示"
      description="当前网关暂不支持 Key 级模型直通白名单。下方配置的分组将用于并发与计费隔离，模型调用通过中转站准入层统一受控。"
    />

    <!-- 工具条与筛选 -->
    <div class="keys-toolbar">
      <div class="search-input-wrap">
        <TxInput
          v-model="searchQuery"
          placeholder="搜索名称、备注或密钥前缀..."
          clearable
          prefix-icon="i-carbon-search"
        />
      </div>
      <TxFilterChips
        v-model="statusFilter"
        :items="filterOptions"
        aria-label="按密钥状态过滤"
      />
    </div>

    <!-- 数据表格卡片 -->
    <TxCard :padding="0">
      <TxDataTable
        :columns="columns"
        :data="filteredKeys"
        row-key="id"
        table-layout="fixed"
        scroll-x
        :loading="loading"
        empty-text="暂无匹配的 API Key"
      >
        <!-- 名称列 -->
        <template #cell-name="{ row }: { row: ApiKeyItem }">
          <div class="cell-key-name" @click="emit('select-key', row)">
            <span class="key-avatar-icon i-carbon-password" />
            <div class="name-desc-stack">
              <strong>{{ row.name }}</strong>
              <span class="mono muted">{{ row.maskedKey }}</span>
              <small v-if="row.note" class="key-note-text">{{ row.note }}</small>
            </div>
          </div>
        </template>

        <!-- 渠道分组列 -->
        <template #cell-groups="{ row }: { row: ApiKeyItem }">
          <div class="groups-tag-list">
            <span v-if="row.groups.length === effectiveGroups.length && effectiveGroups.length > 0">
              <TxTag size="sm" variant="soft" color="var(--tx-color-primary)" label="全部渠道" />
            </span>
            <template v-else-if="row.groups.length">
              <TxTag
                v-for="gId in row.groups.slice(0, 3)"
                :key="gId"
                size="sm"
                variant="outline"
                :label="effectiveGroups.find((g) => g.id === gId)?.name || gId"
                :color="effectiveGroups.find((g) => g.id === gId)?.color || 'var(--tx-text-color-secondary)'"
              />
              <TxTag v-if="row.groups.length > 3" size="sm" variant="plain" :label="`+${row.groups.length - 3}`" />
            </template>
            <span v-else class="muted text-12">未指定分组</span>
          </div>
        </template>

        <!-- 并发列 -->
        <template #cell-concurrency="{ row }: { row: ApiKeyItem }">
          <div class="concurrency-cell">
            <TxTag
              v-if="row.totalConcurrency === 0"
              size="sm"
              variant="soft"
              color="var(--tx-color-success)"
              label="不限速"
            />
            <span v-else class="mono">
              <strong>{{ row.totalConcurrency }}</strong>
              <small class="muted"> 并发</small>
            </span>
          </div>
        </template>

        <!-- 额度列 -->
        <template #cell-quota="{ row }: { row: ApiKeyItem }">
          <div v-if="row.quotaState.unlimited" class="unlimited-quota">
            <TxTag size="sm" variant="soft" color="var(--tx-color-success)" label="不限额" />
          </div>
          <div v-else class="quota-bars-stack">
            <!-- 日额度 -->
            <div v-if="row.quotaState.daily.limitUsd > 0" class="quota-bar-row">
              <span class="quota-lbl">日:</span>
              <div class="quota-progress-track">
                <div
                  class="quota-progress-fill"
                  :class="{ exceeded: row.quotaState.daily.exceeded }"
                  :style="{ width: `${Math.min(100, ((row.quotaState.daily.ratio || 0) * 100))}%` }"
                />
              </div>
              <span class="mono text-11">
                ${{ row.quotaState.daily.spentUsd.toFixed(1) }}/${{ row.quotaState.daily.limitUsd }}
              </span>
            </div>
            <!-- 总额度 -->
            <div v-if="row.quotaState.total.limitUsd > 0" class="quota-bar-row">
              <span class="quota-lbl">总:</span>
              <div class="quota-progress-track">
                <div
                  class="quota-progress-fill"
                  :class="{ exceeded: row.quotaState.total.exceeded }"
                  :style="{ width: `${Math.min(100, ((row.quotaState.total.ratio || 0) * 100))}%` }"
                />
              </div>
              <span class="mono text-11">
                ${{ row.quotaState.total.spentUsd.toFixed(1) }}/${{ row.quotaState.total.limitUsd }}
              </span>
            </div>
          </div>
        </template>

        <!-- 最近调用 -->
        <template #cell-lastUsedAt="{ row }: { row: ApiKeyItem }">
          <span class="muted text-12">
            {{
              row.lastUsedAt
                ? new Date(row.lastUsedAt).toLocaleString('zh-CN', {
                    month: '2-digit',
                    day: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit',
                  })
                : '从未使用'
            }}
          </span>
        </template>

        <!-- 状态列 -->
        <template #cell-status="{ row }: { row: ApiKeyItem }">
          <TxTag
            size="sm"
            :variant="row.enabled && !row.blockedReason ? 'soft' : 'outline'"
            :color="
              row.blockedReason
                ? 'var(--tx-color-danger)'
                : row.enabled
                ? 'var(--tx-color-success)'
                : 'var(--tx-text-color-disabled)'
            "
            :label="row.blockedReason ? '超额停用' : row.enabled ? '正常' : '已停用'"
          />
        </template>

        <!-- 操作按钮列 -->
        <template #cell-actions="{ row }: { row: ApiKeyItem }">
          <div class="table-actions-row">
            <TxButton
              size="sm"
              variant="secondary"
              title="复制完整 API Key"
              icon="i-carbon-copy"
              @click="copyKey(row)"
            />
            <TxButton
              size="sm"
              variant="secondary"
              title="配置额度上限"
              icon="i-carbon-meter-alt"
              @click="openQuotaModal(row)"
            />
            <TxButton
              size="sm"
              variant="secondary"
              title="编辑 Key 与渠道授权"
              icon="i-carbon-settings"
              @click="openEditModal(row)"
            />
            <TxButton
              size="sm"
              :variant="row.enabled ? 'secondary' : 'primary'"
              :title="row.enabled ? '临时停用密钥' : '恢复启用密钥'"
              :icon="row.enabled ? 'i-carbon-pause-outline' : 'i-carbon-play-outline'"
              @click="toggleKeyStatus(row)"
            />
          </div>
        </template>
      </TxDataTable>
    </TxCard>

    <!-- Key 编辑/新建弹窗 (TxModal) -->
    <TxModal
      v-model="showEditorModal"
      :title="editingItem ? '编辑 API Key' : '创建新 API Key'"
      width="min(94vw, 680px)"
    >
      <TxForm label-position="top" class="editor-form-body">
        <TxFormItem label="显示名称" required>
          <TxInput v-model="editorForm.name" placeholder="例如：开发测试环境、自动化助理" />
        </TxFormItem>

        <TxFormItem label="备注用途">
          <TxTextarea v-model="editorForm.note" placeholder="记录使用者、调用部门或场景" :rows="2" />
        </TxFormItem>

        <TxFormItem v-if="editingItem" label="密钥开关">
          <TxSwitch v-model="editorForm.enabled" label="启用此密钥（停用后客户端请求立即返回 401）" />
        </TxFormItem>

        <TxFormItem label="授权渠道分组" required>
          <div class="groups-picker">
            <button
              v-for="group in effectiveGroups"
              :key="group.id"
              type="button"
              class="group-select-btn"
              :class="{ selected: editorForm.groups.includes(group.id) }"
              @click="toggleGroupSelection(group.id)"
            >
              <span class="group-dot" :style="{ background: group.color }" />
              <strong>{{ group.name }}</strong>
              <span v-if="editorForm.groups.includes(group.id)" class="i-carbon-checkmark text-14" />
            </button>
          </div>
          <small class="field-hint">选择允许此密钥使用的上游模型渠道组。</small>
        </TxFormItem>

        <div class="concurrency-settings">
          <div class="concurrency-head">
            <div>
              <strong>总并发限制策略</strong>
              <p class="muted text-12">限制该 Key 同时处理的请求数量以保护后端服务。</p>
            </div>
            <TxSwitch v-model="editorForm.unlimited" label="不限速" />
          </div>

          <div v-if="!editorForm.unlimited" class="concurrency-inputs">
            <TxFormItem label="最大总并发数">
              <TxInput
                v-model="editorForm.totalConcurrency"
                type="number"
                placeholder="4"
                style="max-width: 140px"
              />
            </TxFormItem>
          </div>
        </div>

        <TxAlert v-if="editorError" variant="danger" :description="editorError" />
      </TxForm>

      <template #footer>
        <div class="modal-footer-between">
          <TxButton
            v-if="editingItem"
            variant="danger"
            icon="i-carbon-trash-can"
            @click="showDeleteConfirm = true"
          >
            删除密钥
          </TxButton>
          <span v-else />
          <div class="modal-footer-actions">
            <TxButton variant="secondary" @click="showEditorModal = false">取消</TxButton>
            <TxButton variant="primary" :loading="editorSaving" @click="saveKeyEditor">
              {{ editingItem ? '保存修改' : '立即创建' }}
            </TxButton>
          </div>
        </div>
      </template>
    </TxModal>

    <!-- 额度配置弹窗 (TxModal) -->
    <TxModal
      v-model="showQuotaModal"
      :title="`额度限制 - ${quotaTarget?.name || ''}`"
      width="min(94vw, 560px)"
    >
      <div v-if="quotaTarget" class="quota-modal-body">
        <div class="unlimited-quota-toggle">
          <div>
            <strong>无额度限制</strong>
            <p class="muted text-12">关闭额度上限控制，该 Key 不会因花费被自动停用。</p>
          </div>
          <TxSwitch v-model="quotaUnlimited" />
        </div>

        <div v-if="!quotaUnlimited" class="quota-limits-inputs">
          <!-- 日额度 -->
          <div class="quota-limit-item">
            <div class="item-head">
              <div>
                <strong>单日额度 ($)</strong>
                <small class="muted">每日服务器本地 00:00 自动刷新</small>
              </div>
              <TxInput
                v-model="quotaValues.daily"
                type="number"
                placeholder="留空不限"
                style="max-width: 130px"
              />
            </div>
            <div class="item-foot">
              <span>已用: ${{ quotaTarget.quotaState.daily.spentUsd.toFixed(2) }}</span>
              <TxButton
                size="sm"
                variant="secondary"
                icon="i-carbon-reset"
                @click="handleResetQuota('daily')"
              >
                重置今日用量
              </TxButton>
            </div>
          </div>

          <!-- 周额度 -->
          <div class="quota-limit-item">
            <div class="item-head">
              <div>
                <strong>每周额度 ($)</strong>
                <small class="muted">每周一服务器本地 00:00 自动刷新</small>
              </div>
              <TxInput
                v-model="quotaValues.weekly"
                type="number"
                placeholder="留空不限"
                style="max-width: 130px"
              />
            </div>
            <div class="item-foot">
              <span>已用: ${{ quotaTarget.quotaState.weekly.spentUsd.toFixed(2) }}</span>
              <TxButton
                size="sm"
                variant="secondary"
                icon="i-carbon-reset"
                @click="handleResetQuota('weekly')"
              >
                重置本周用量
              </TxButton>
            </div>
          </div>

          <!-- 总额度 -->
          <div class="quota-limit-item">
            <div class="item-head">
              <div>
                <strong>历史累计总额度 ($)</strong>
                <small class="muted">达到后密钥停用，仅可手动重置</small>
              </div>
              <TxInput
                v-model="quotaValues.total"
                type="number"
                placeholder="留空不限"
                style="max-width: 130px"
              />
            </div>
            <div class="item-foot">
              <span>已用: ${{ quotaTarget.quotaState.total.spentUsd.toFixed(2) }}</span>
              <TxButton
                size="sm"
                variant="secondary"
                icon="i-carbon-reset"
                @click="handleResetQuota('total')"
              >
                重置总计用量
              </TxButton>
            </div>
          </div>
        </div>

        <TxAlert v-if="quotaError" variant="danger" :description="quotaError" />
      </div>

      <template #footer>
        <div class="modal-footer-actions">
          <TxButton variant="secondary" @click="showQuotaModal = false">取消</TxButton>
          <TxButton variant="primary" :loading="quotaSaving" @click="saveQuota">保存额度设置</TxButton>
        </div>
      </template>
    </TxModal>

    <!-- 新建密钥成功查看弹窗 -->
    <TxModal v-model="showRevealModal" title="密钥创建成功" width="500px">
      <div class="reveal-content">
        <TxAlert
          variant="warning"
          title="请妥善保管"
          description="完整的 API Key 仅在此处展示一次，窗口关闭后将无法再次直接查看明文！"
        />
        <div class="reveal-box">
          <code class="mono">{{ newlyCreatedKey }}</code>
        </div>
      </div>
      <template #footer>
        <TxButton
          variant="primary"
          block
          icon="i-carbon-copy"
          @click="
            async () => {
              await navigator.clipboard.writeText(newlyCreatedKey)
              toast({ title: '已复制', variant: 'success' })
              showRevealModal = false
            }
          "
        >
          复制密钥并关闭
        </TxButton>
      </template>
    </TxModal>

    <!-- 删除确认弹窗 -->
    <TxModal v-model="showDeleteConfirm" title="删除密钥确认" width="440px">
      <p>
        确定要彻底删除密钥 <strong>{{ editingItem?.name }}</strong> 吗？
        此操作不可撤销，使用该密钥的客户端将立即收到 401 认证失败。
      </p>
      <template #footer>
        <div class="modal-footer-actions">
          <TxButton variant="secondary" @click="showDeleteConfirm = false">取消</TxButton>
          <TxButton variant="danger" :loading="deleting" @click="confirmDeleteKey">确认删除</TxButton>
        </div>
      </template>
    </TxModal>
  </div>
</template>

<style scoped>
.keys-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 4px;
}

.search-input-wrap {
  width: 280px;
}

.cell-key-name {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  cursor: pointer;
}

.key-avatar-icon {
  font-size: 18px;
  color: var(--tx-color-primary);
  margin-top: 2px;
}

.name-desc-stack {
  display: flex;
  flex-direction: column;
}

.name-desc-stack strong {
  font-size: 13.5px;
  color: var(--tx-text-color-primary);
}

.key-note-text {
  font-size: 11px;
  color: var(--tx-text-color-secondary);
}

.groups-tag-list {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.concurrency-cell {
  font-size: 13px;
}

.quota-bars-stack {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.quota-bar-row {
  display: flex;
  align-items: center;
  gap: 6px;
}

.quota-lbl {
  font-size: 11px;
  color: var(--tx-text-color-secondary);
  width: 14px;
}

.quota-progress-track {
  flex: 1;
  height: 5px;
  background: var(--tx-fill-color);
  border-radius: 3px;
  overflow: hidden;
}

.quota-progress-fill {
  height: 100%;
  background: var(--tx-color-primary);
  border-radius: 3px;
  transition: width 0.2s ease;
}

.quota-progress-fill.exceeded {
  background: var(--tx-color-danger);
}

.table-actions-row {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
}

.groups-picker {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(130px, 1fr));
  gap: 8px;
  margin-top: 4px;
}

.group-select-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border-radius: var(--tx-border-radius-base);
  border: 1px solid var(--tx-border-color);
  background: var(--tx-bg-color);
  cursor: pointer;
  transition: all 0.15s ease;
}

.group-select-btn.selected {
  border-color: var(--tx-color-primary);
  background: color-mix(in srgb, var(--tx-color-primary) 8%, var(--tx-bg-color));
}

.group-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.concurrency-settings {
  padding: 12px;
  background: var(--tx-fill-color-light);
  border-radius: var(--tx-border-radius-base);
  margin-top: 10px;
}

.concurrency-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.modal-footer-between {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
}

.modal-footer-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.quota-modal-body {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.unlimited-quota-toggle {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px;
  background: var(--tx-fill-color-light);
  border-radius: var(--tx-border-radius-base);
}

.quota-limits-inputs {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.quota-limit-item {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px;
  border: 1px solid var(--tx-border-color);
  border-radius: var(--tx-border-radius-base);
}

.item-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.item-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 12px;
  color: var(--tx-text-color-secondary);
}

.reveal-content {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.reveal-box {
  padding: 12px;
  background: var(--tx-fill-color-lighter);
  border: 1px solid var(--tx-border-color);
  border-radius: var(--tx-border-radius-base);
  word-break: break-all;
}
</style>
