<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
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
import { TxPagination } from '@talex-touch/tuffex/pagination'
import { toast } from '@talex-touch/tuffex/utils'
import PageHeader from '../components/PageHeader.vue'
import ErrorPanel from '../components/ErrorPanel.vue'
import LoadingBlock from '../components/LoadingBlock.vue'
import EmptyState from '../components/EmptyState.vue'
import { api } from '../api'
import { confirm } from '../lib/confirm'
import { focusInModal } from '../lib/focus'
import { CONCURRENCY_LIMITS, fieldError, rules as fieldRules, validateAll, type FieldRules } from '../lib/validation'
import { debounce, paginate, useQueryState } from '../lib/listState'
import { useResource } from '../lib/resource'
import { fmtClock, fmtUsd } from '../lib/format'
import type { ApiKeyItem, GatewayModelAccess, Group } from '../types'

const PAGE_SIZE = 20

/**
 * 搜索词、状态筛选、页码写进 URL（TUF `pages/Applications.vue:31-33,44-48` 的形状）：
 * 刷新不丢筛选、链接可分享、后退回到上一视图。输入框用本地 draft，300ms 后才写 URL。
 */
const scope = useQueryState({ q: '', status: 'all', page: '1' })
const statusFilter = computed(() => scope.state.status)
const searchInput = ref(scope.state.q)
const applySearch = debounce(() => scope.patch({ q: searchInput.value.trim(), page: '1' }), 300)
watch(searchInput, () => applySearch())
watch(
  () => scope.state.q,
  (value) => {
    if (value !== searchInput.value.trim()) searchInput.value = value
  },
)

type BootstrapPayload = {
  keys?: ApiKeyItem[]
  groups?: Group[]
  quotaTimeZone?: string
  degraded?: boolean
  degradedReason?: string
  gatewayModelAccess?: GatewayModelAccess
}

/**
 * 一次读取 API Key、分组与运行环境标记。失败时保留持久 `error`（红队 D2：原来只有一条 7 秒后消失的 toast，
 * 页面随后和「本来就没有 Key」无法区分），由 ErrorPanel 给出原因与重试。
 */
const res = useResource(() => api.bootstrap<BootstrapPayload>(), [])
const keys = computed(() => res.data.value?.keys ?? [])
const groups = computed(() => res.data.value?.groups ?? [])
/** 服务端时区来自接口本身，不再用写死的 `'UTC'` 冒充事实（红队 D14）。 */
const quotaTimeZone = computed(() => res.data.value?.quotaTimeZone || 'Asia/Shanghai')
const gatewayModelAccess = computed<GatewayModelAccess>(() => res.data.value?.gatewayModelAccess ?? 'available')
const degradedReason = computed(() =>
  res.data.value?.degraded ? res.data.value?.degradedReason || '控制面部分数据读取失败，页面沿用上次成功结果。' : '',
)
const reloadData = () => res.reload()

/**
 * D25 字段级校验：失焦即校验、错误落在字段旁、提交时定位到首个出错字段。
 * 规则与文案（写「怎么改」）集中在 `src/lib/validation.ts` 的纯函数里；本页只负责触发与渲染。
 */
const editorRules: FieldRules = {
  name: [
    fieldRules.required('请填写显示名称（1–40 个字符），它会显示在 API Key 列表里'),
    fieldRules.maxLength(40, '显示名称最多 40 个字符，请缩短后再保存'),
    fieldRules.custom('已有同名 API Key，请换一个名称（或先改掉那一个已有的）', (value) =>
      !keys.value.some((key) => key.name === value.trim() && key.id !== editingItem.value?.id),
    ),
  ],
  note: [fieldRules.maxLength(100, '备注最多 100 个字符，请精简后再保存')],
  groups: [fieldRules.required('至少选择一个渠道分组，否则这个 API Key 无法调用任何模型')],
  totalConcurrency: [
    fieldRules.integerInRange(
      CONCURRENCY_LIMITS.min,
      CONCURRENCY_LIMITS.max,
      `请填写最大总并发数（${CONCURRENCY_LIMITS.min}–${CONCURRENCY_LIMITS.max} 的整数，与服务端一致）；不想限速请打开「不限速」开关`,
      { allowEmpty: false },
    ),
  ],
}
const editorFieldErrors = reactive<Record<string, string>>({})
/** 只有被提交或失焦过的字段才显示错误，避免一打开弹窗就满屏红。 */
const editorTouched = reactive<Record<string, boolean>>({})

/**
 * R6-A：底部汇总从字段错误**派生**，而不是提交时写一次。
 * 原来只在提交时算一次，字段改好了汇总还挂着「还有 1 处需要修改」，直到下次提交成功才消失。
 */
const editorSummary = computed(() => {
  const count = Object.keys(editorFieldErrors).length
  if (count) return `还有 ${count} 处需要修改，已定位到第一个字段。`
  return editorError.value
})

function validateEditorField(name: string) {
  editorTouched[name] = true
  const message = fieldError(editorRules, editorForm, name)
  if (message) editorFieldErrors[name] = message
  else delete editorFieldErrors[name]
  return !message
}

function focusFirstInvalidField(firstInvalid: string | null) {
  if (!firstInvalid) return
  const container = document.querySelector<HTMLElement>(`.tx-modal__overlay [data-field="${firstInvalid}"]`)
  const control = container?.querySelector<HTMLElement>('input, textarea, select, button')
  control?.focus()
  container?.scrollIntoView({ block: 'center', behavior: 'smooth' })
}

// Modal States
const showEditorModal = ref(false)
const editingItem = ref<ApiKeyItem | null>(null)
const editorSaving = ref(false)
const editorError = ref('')
/** 弹窗打开后把焦点放进第一个输入框（红队 D9：原来焦点停在遮罩上）。 */
const nameFieldRef = ref<{ focus?: () => void } | null>(null)

// Quota Modal
const showQuotaModal = ref(false)
const quotaTarget = ref<ApiKeyItem | null>(null)
const quotaSaving = ref(false)
const quotaError = ref('')
const quotaUnlimited = ref(false)
const quotaValues = reactive({ total: '', daily: '', weekly: '' })
const quotaFieldRef = ref<{ focus?: () => void } | null>(null)

// Reveal Modal
const showRevealModal = ref(false)
const newlyCreatedKey = ref('')
const revealCopying = ref(false)

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

async function focusField(target: typeof nameFieldRef) {
  // 遮罩的自动 focus 排在挂载后的 nextTick，必须排在它之后（见 src/lib/focus.ts）。
  await focusInModal(target.value, '.tx-modal__overlay input')
}

// Filter Chips
const filterOptions = computed(() => [
  { value: 'all', label: `全部 API Key (${keys.value.length})` },
  { value: 'enabled', label: `已启用 (${keys.value.filter((k) => k.enabled && !k.blockedReason).length})` },
  { value: 'disabled', label: `已停用 (${keys.value.filter((k) => !k.enabled).length})` },
  { value: 'blocked', label: `超额停用 (${keys.value.filter((k) => Boolean(k.blockedReason)).length})` },
])

// Filtered data
const filteredKeys = computed(() => {
  return keys.value.filter((key) => {
    // Status filter
    if (statusFilter.value === 'enabled' && (!key.enabled || key.blockedReason)) return false
    if (statusFilter.value === 'disabled' && key.enabled) return false
    if (statusFilter.value === 'blocked' && !key.blockedReason) return false

    // Search query
    const q = scope.state.q.trim().toLowerCase()
    if (q) {
      const match =
        key.name.toLowerCase().includes(q) ||
        key.maskedKey.toLowerCase().includes(q) ||
        (key.note && key.note.toLowerCase().includes(q))
      if (!match) return false
    }
    return true
  })
})

const paged = computed(() => paginate(filteredKeys.value, Number(scope.state.page), PAGE_SIZE))
// 数据变少时页码夹回范围内，避免停在空白页。
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

// Columns：单列只给 width，主列靠整表 --table-min 撑宽（红队 D4：多列 minWidth + 固定 width 混用，
// 在 table-layout:fixed 下会把 minWidth 列压成 0，窄屏文字重叠）。
const columns: DataTableColumn<ApiKeyItem>[] = [
  { key: 'name', title: '名称与标识', width: 260 },
  { key: 'groups', title: '授权渠道分组', width: 220 },
  { key: 'concurrency', title: '并发控制', width: 120 },
  { key: 'quota', title: '额度消费进度', width: 220 },
  { key: 'lastUsedAt', title: '最近调用', width: 150 },
  { key: 'status', title: '状态', width: 110 },
  { key: 'actions', title: '操作', width: 200, align: 'right' },
]

// Actions
async function copyKey(key: ApiKeyItem) {
  try {
    const { token } = await api.createRevealToken(key.id)
    const { key: fullKey } = await api.revealKey(key.id, token)
    await navigator.clipboard.writeText(fullKey)
    toast({ title: '复制成功', description: `“${key.name}”的完整 API Key 已复制到剪贴板`, variant: 'success' })
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
    toast({ title: key.enabled ? '已停用' : '已启用', description: `API Key “${key.name}”状态已更新`, variant: 'success' })
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
  editorForm.groups = groups.value.map((g) => g.id)
  editorForm.unlimited = false
  editorForm.totalConcurrency = 4
  editorForm.groupConcurrency = Object.fromEntries(groups.value.map((g) => [g.id, 2]))
  editorError.value = ''
  showEditorModal.value = true
  void focusField(nameFieldRef)
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
  resetEditorFieldErrors()
  showEditorModal.value = true
  void focusField(nameFieldRef)
}

function resetEditorFieldErrors() {
  for (const key of Object.keys(editorFieldErrors)) delete editorFieldErrors[key]
  for (const key of Object.keys(editorTouched)) delete editorTouched[key]
}

function toggleGroupSelection(groupId: string) {
  const set = new Set(editorForm.groups)
  if (set.has(groupId)) set.delete(groupId)
  else set.add(groupId)
  editorForm.groups = [...set]
}

async function saveKeyEditor() {
  // 提交时整表校验：字段旁就地标红，底部给汇总，并把焦点送到第一个出错字段
  const outcome = validateAll(editorRules, editorForm as unknown as Record<string, unknown>)
  for (const key of Object.keys(editorRules)) editorTouched[key] = true
  for (const key of Object.keys(editorFieldErrors)) delete editorFieldErrors[key]
  Object.assign(editorFieldErrors, outcome.errors)
  if (!outcome.valid) {
    editorError.value = ''
    focusFirstInvalidField(outcome.firstInvalid)
    return
  }
  editorError.value = ''

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

/** 删除走全局 confirm()（红队 D5/D8）：不再把确认框叠在编辑弹窗之上，也不再从编辑弹窗里发起。 */
async function deleteKey(key: ApiKeyItem) {
  const ok = await confirm({
    title: '删除 API Key',
    body: `“${key.name}”将被彻底删除，使用它的客户端会立即收到 401 认证失败，且无法恢复。`,
    confirmText: '删除 API Key',
    danger: true,
  })
  if (!ok) return
  try {
    await api.deleteKey(key.id)
    toast({ title: '删除成功', description: `API Key “${key.name}”已彻底移除`, variant: 'success' })
    if (editingItem.value?.id === key.id) showEditorModal.value = false
    await reloadData()
  } catch (err) {
    toast({ title: '删除失败', description: err instanceof Error ? err.message : String(err), variant: 'danger' })
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
  for (const key of Object.keys(quotaFieldErrors)) delete quotaFieldErrors[key]
  showQuotaModal.value = true
  void focusField(quotaFieldRef)
}

const quotaRules: FieldRules = {
  daily: [fieldRules.numberInRange(0, 1_000_000, '单日额度请填 0–1000000 之间的数字；留空表示不限制')],
  weekly: [fieldRules.numberInRange(0, 1_000_000, '每周额度请填 0–1000000 之间的数字；留空表示不限制')],
  total: [fieldRules.numberInRange(0, 1_000_000, '历史累计额度请填 0–1000000 之间的数字；留空表示不限制')],
}
const quotaFieldErrors = reactive<Record<string, string>>({})

/** 同上：额度弹窗的汇总也从字段错误派生。 */
const quotaSummary = computed(() => {
  const count = Object.keys(quotaFieldErrors).length
  if (count) return `还有 ${count} 处需要修改，已定位到第一个字段。`
  return quotaError.value
})

function validateQuotaField(name: string) {
  const message = quotaUnlimited.value ? null : fieldError(quotaRules, quotaValues, name)
  if (message) quotaFieldErrors[name] = message
  else delete quotaFieldErrors[name]
  return !message
}

async function saveQuota() {
  if (!quotaTarget.value) return
  // 无额度限制时三个数值框不参与校验（它们本来就隐藏/不生效）
  const outcome = quotaUnlimited.value
    ? { valid: true, errors: {} as Record<string, string>, firstInvalid: null }
    : validateAll(quotaRules, quotaValues as unknown as Record<string, unknown>)
  for (const key of Object.keys(quotaFieldErrors)) delete quotaFieldErrors[key]
  Object.assign(quotaFieldErrors, outcome.errors)
  if (!outcome.valid) {
    quotaError.value = ''
    focusFirstInvalidField(outcome.firstInvalid)
    return
  }
  quotaSaving.value = true
  quotaError.value = ''
  try {
    await api.updateQuota(quotaTarget.value.id, {
      totalUsd: quotaUnlimited.value ? 0 : Number(quotaValues.total) || 0,
      dailyUsd: quotaUnlimited.value ? 0 : Number(quotaValues.daily) || 0,
      weeklyUsd: quotaUnlimited.value ? 0 : Number(quotaValues.weekly) || 0,
    })
    toast({ title: '额度已更新', description: `“${quotaTarget.value.name}”的额度规则已生效`, variant: 'success' })
    showQuotaModal.value = false
    await reloadData()
  } catch (err) {
    quotaError.value = err instanceof Error ? err.message : String(err)
  } finally {
    quotaSaving.value = false
  }
}

const RESET_LABEL = { daily: '今日', weekly: '本周', total: '总计' } as const

/** 三种重置都是不可逆写操作，统一先 await confirm()（红队 D5：原来三键单击即执行，含累计总额）。 */
async function handleResetQuota(window: 'total' | 'daily' | 'weekly') {
  const target = quotaTarget.value
  if (!target) return
  const spent = target.quotaState[window].spentUsd
  const ok = await confirm({
    title: `重置${RESET_LABEL[window]}用量`,
    body:
      window === 'total'
        ? `“${target.name}”的累计已用额度（${fmtUsd(spent)}）将归零。这是 API Key 因超额停用后唯一的恢复手段，且不可撤销。`
        : `“${target.name}”的${RESET_LABEL[window]}已用额度（${fmtUsd(spent)}）将归零，操作不可撤销。`,
    confirmText: `重置${RESET_LABEL[window]}`,
    danger: true,
  })
  if (!ok) return
  try {
    await api.resetQuota(target.id, window)
    toast({ title: '重置完成', description: `已重置 ${window} 额度消耗记录`, variant: 'success' })
    await reloadData()
    target.quotaState[window].spentUsd = 0
  } catch (err) {
    toast({ title: '重置失败', description: err instanceof Error ? err.message : String(err), variant: 'danger' })
  }
}

/** 一次性 API Key 的复制：失败时留在弹窗里给出原因，不让「唯一出口」把用户困住（红队 D23）。 */
async function copyNewKey() {
  revealCopying.value = true
  try {
    await navigator.clipboard.writeText(newlyCreatedKey.value)
    toast({ title: '已复制', variant: 'success' })
    showRevealModal.value = false
  } catch (err) {
    toast({
      title: '复制失败',
      description: `请手动选中上面的 API Key 复制后关闭。${err instanceof Error ? err.message : ''}`.trim(),
      variant: 'danger',
    })
  } finally {
    revealCopying.value = false
  }
}
</script>

<template>
  <div class="page">
    <!-- 头部横幅 -->
    <PageHeader
      title="API Key 管理"
      description="创建与管理用户访问 API Key，支持细粒度的渠道分组白名单、并发保护与周期消费额度。"
    >
      <template #meta>
        <p class="muted text-12">额度按服务器时区（{{ quotaTimeZone }}）的 00:00 滚动刷新。</p>
      </template>
      <template #actions>
        <TxButton variant="primary" icon="i-carbon-add" @click="openCreateModal">
          创建 API Key
        </TxButton>
      </template>
    </PageHeader>

    <!-- 网关限制提示 -->
    <TxAlert
      v-if="gatewayModelAccess === 'unavailable'"
      type="warning"
      title="网关白名单提示"
      message="当前网关暂不支持 Key 级模型直通白名单。下方配置的分组将用于并发与计费隔离。"
    />
    <TxAlert v-if="degradedReason" type="warning" title="控制面降级" :message="degradedReason" />

    <!-- 失败：可读原因 + 重试；首次加载：骨架；其余：保留旧数据继续渲染，刷新不闪空 -->
    <ErrorPanel v-if="res.error.value && !res.data.value" :error="res.error.value" :retry="reloadData" />
    <LoadingBlock v-else-if="!res.data.value" :lines="7" label="正在读取 API Key 列表" />

    <template v-else>
    <!-- R2：有旧数据时刷新失败不再顶掉内容，只在顶部给非阻断横幅（有意偏离 TUF 的阻断式错误态） -->
    <ErrorPanel v-if="res.error.value" inline :error="res.error.value" :retry="reloadData"
      stale-hint="下方仍是最近一次成功读取的 API Key 列表，可以继续查看。" />

    <!-- 工具条与筛选 -->
    <div class="keys-toolbar">
      <div class="search-input-wrap">
        <TxInput
          v-model="searchInput"
          placeholder="搜索名称、备注或 API Key 前缀..."
          clearable
          prefix-icon="i-carbon-search"
          aria-label="搜索 API Key"
        />
      </div>
      <TxFilterChips
        :model-value="statusFilter"
        :items="filterOptions"
        aria-label="按 API Key 状态过滤"
        @update:model-value="scope.patch({ status: String($event), page: '1' })"
      />
      <TxButton v-if="hasFilter" variant="ghost" size="sm" @click="clearFilters">清除筛选</TxButton>
      <span class="keys-count muted text-12">
        共 {{ paged.total }} 个 API Key<template v-if="hasFilter">（已筛选，原 {{ keys.length }} 把）</template>
      </span>
    </div>

    <!-- 数据表格卡片 -->
    <TxCard :padding="0" class="keys-table-card">
      <TxDataTable
        :columns="columns"
        :data="paged.rows"
        row-key="id"
        scroll-x
        :style="{ '--table-min': '1120px' }"
        :loading="res.loading.value"
        aria-label="API Key 列表"
      >
        <!-- 名称列：真按钮（可聚焦、可键盘触发），点击进入编辑，不再是无人监听的死点击 -->
        <template #cell-name="{ row }: { row: ApiKeyItem }">
          <button
            type="button"
            class="cell-key-name"
            :aria-label="`编辑 API Key ${row.name}`"
            @click="openEditModal(row)"
          >
            <span class="key-avatar-icon i-carbon-password" aria-hidden="true" />
            <span class="name-desc-stack">
              <strong>{{ row.name }}</strong>
              <span class="mono muted">{{ row.maskedKey }}</span>
              <small v-if="row.note" class="key-note-text" :title="row.note">{{ row.note }}</small>
            </span>
          </button>
        </template>

        <!-- 渠道分组列 -->
        <template #cell-groups="{ row }: { row: ApiKeyItem }">
          <div class="groups-tag-list">
            <span v-if="row.groups.length === groups.length && groups.length > 0">
              <TxTag size="sm" variant="soft" color="var(--tx-color-primary)" label="全部渠道" />
            </span>
            <template v-else-if="row.groups.length">
              <TxTag
                v-for="gId in row.groups.slice(0, 3)"
                :key="gId"
                size="sm"
                variant="outline"
                :label="groups.find((g) => g.id === gId)?.name || gId"
                :color="groups.find((g) => g.id === gId)?.color || 'var(--tx-text-color-secondary)'"
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
            <TxTag size="sm" variant="soft" color="var(--tx-color-success)" label="不限额度" />
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
              </span>            </div>
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

        <!-- 最近调用：固定 Asia/Shanghai，不再跟着浏览器时区跑（红队 D14） -->
        <template #cell-lastUsedAt="{ row }: { row: ApiKeyItem }">
          <span class="muted text-12">
            {{ row.lastUsedAt ? fmtClock(row.lastUsedAt) : '从未使用' }}
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

        <!-- 操作按钮列：图标按钮一律带 aria-label（红队 D11），删除走全局 confirm()（红队 D5/D8） -->
        <template #cell-actions="{ row }: { row: ApiKeyItem }">
          <div class="table-actions-row">
            <TxButton
              size="sm"
              variant="secondary"
              :title="`复制 ${row.name} 的完整 API Key`"
              :aria-label="`复制 ${row.name} 的完整 API Key`"
              icon="i-carbon-copy"
              @click="copyKey(row)"
            />
            <TxButton
              size="sm"
              variant="secondary"
              :title="`配置 ${row.name} 的额度上限`"
              :aria-label="`配置 ${row.name} 的额度上限`"
              icon="i-carbon-meter-alt"
              @click="openQuotaModal(row)"
            />
            <TxButton
              size="sm"
              variant="secondary"
              :title="`编辑 ${row.name}`"
              :aria-label="`编辑 ${row.name}`"
              icon="i-carbon-settings"
              @click="openEditModal(row)"
            />
            <TxButton
              size="sm"
              :variant="row.enabled ? 'secondary' : 'primary'"
              :title="row.enabled ? `临时停用 ${row.name}` : `恢复启用 ${row.name}`"
              :aria-label="row.enabled ? `临时停用 ${row.name}` : `恢复启用 ${row.name}`"
              :icon="row.enabled ? 'i-carbon-pause-outline' : 'i-carbon-play-outline'"
              @click="toggleKeyStatus(row)"
            />
            <TxButton
              size="sm"
              variant="danger"
              :title="`删除 ${row.name}`"
              :aria-label="`删除 ${row.name}`"
              icon="i-carbon-trash-can"
              @click="deleteKey(row)"
            />
          </div>
        </template>

        <template #empty>
          <EmptyState
            :variant="hasFilter ? 'search-empty' : 'empty'"
            :title="hasFilter ? '没有匹配的 API Key' : '还没有 API Key'"
            :description="
              hasFilter
                ? '换个关键词或把状态筛选调回「全部 API Key」。'
                : '创建一个 API Key 后，客户端就可以用它访问网关。'
            "
            :action-label="hasFilter ? '清除筛选' : '创建 API Key'"
            size="small"
            @action="hasFilter ? clearFilters() : openCreateModal()"
          />
        </template>
      </TxDataTable>

      <div v-if="paged.totalPages > 1" class="keys-pager">
        <TxPagination
          :current-page="paged.page"
          :page-size="paged.pageSize"
          :total="paged.total"
          show-info
          aria-label="API Key 列表分页"
          @update:current-page="scope.state.page = String($event)"
        />
      </div>
    </TxCard>
    </template>

    <!-- Key 编辑/新建弹窗 (TxModal) -->
    <TxModal
      v-model="showEditorModal"
      :title="editingItem ? '编辑 API Key' : '创建新 API Key'"
      width="min(94vw, 680px)"
    >
      <TxForm label-position="top" class="editor-form-body">
        <TxFormItem label="显示名称" prop="name" required data-field="name">
          <TxInput
            ref="nameFieldRef"
            v-model="editorForm.name"
            placeholder="例如：开发测试环境、自动化助理"
            aria-label="显示名称"
            :aria-invalid="editorFieldErrors.name ? 'true' : undefined"
            @blur="validateEditorField('name')"
          />
          <p v-if="editorFieldErrors.name" class="field-error" role="alert">{{ editorFieldErrors.name }}</p>
        </TxFormItem>

        <TxFormItem label="备注用途" prop="note" data-field="note">
          <TxTextarea
            v-model="editorForm.note"
            placeholder="记录使用者、调用部门或场景"
            :rows="2"
            aria-label="备注用途"
            :aria-invalid="editorFieldErrors.note ? 'true' : undefined"
            @blur="validateEditorField('note')"
          />
          <p v-if="editorFieldErrors.note" class="field-error" role="alert">{{ editorFieldErrors.note }}</p>
        </TxFormItem>

        <TxFormItem v-if="editingItem" label="API Key 开关">
          <TxSwitch v-model="editorForm.enabled" label="启用此 API Key（停用后客户端请求立即返回 401）" />
        </TxFormItem>

        <TxFormItem label="授权渠道分组" prop="groups" required data-field="groups">
          <div class="groups-picker" @click="validateEditorField('groups')">
            <button
              v-for="group in groups"
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
          <small class="field-hint">选择允许此 API Key 使用的上游模型渠道分组。</small>
          <p v-if="editorFieldErrors.groups" class="field-error" role="alert">{{ editorFieldErrors.groups }}</p>
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
            <TxFormItem label="最大总并发数" prop="totalConcurrency" data-field="totalConcurrency">
              <TxInput
                v-model="editorForm.totalConcurrency"
                type="number"
                placeholder="4"
                aria-label="最大总并发数"
                :aria-invalid="editorFieldErrors.totalConcurrency ? 'true' : undefined"
                style="max-width: 140px"
                @blur="validateEditorField('totalConcurrency')"
              />
              <p v-if="editorFieldErrors.totalConcurrency" class="field-error" role="alert">
                {{ editorFieldErrors.totalConcurrency }}
              </p>
            </TxFormItem>
          </div>
        </div>

        <TxAlert v-if="editorSummary" type="error" :message="editorSummary" />
      </TxForm>

      <template #footer>
        <div class="modal-footer-actions">
          <TxButton variant="secondary" @click="showEditorModal = false">取消</TxButton>
          <TxButton variant="primary" :loading="editorSaving" @click="saveKeyEditor">
            {{ editingItem ? '保存修改' : '立即创建' }}
          </TxButton>
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
          <div class="quota-limit-item" data-field="daily">
            <div class="item-head">
              <div>
                <strong>单日额度 ($)</strong>
                <small class="muted">每日服务器本地 00:00 自动刷新</small>
              </div>
              <TxInput
                ref="quotaFieldRef"
                v-model="quotaValues.daily"
                type="number"
                placeholder="留空不限"
                aria-label="单日额度（美元）"
                :aria-invalid="quotaFieldErrors.daily ? 'true' : undefined"
                style="max-width: 130px"
                @blur="validateQuotaField('daily')"
              />
              <p v-if="quotaFieldErrors.daily" class="field-error" role="alert">{{ quotaFieldErrors.daily }}</p>
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
          <div class="quota-limit-item" data-field="weekly">
            <div class="item-head">
              <div>
                <strong>每周额度 ($)</strong>
                <small class="muted">每周一服务器本地 00:00 自动刷新</small>
              </div>
              <TxInput
                v-model="quotaValues.weekly"
                type="number"
                placeholder="留空不限"
                aria-label="每周额度（美元）"
                :aria-invalid="quotaFieldErrors.weekly ? 'true' : undefined"
                style="max-width: 130px"
                @blur="validateQuotaField('weekly')"
              />
              <p v-if="quotaFieldErrors.weekly" class="field-error" role="alert">{{ quotaFieldErrors.weekly }}</p>
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
          <div class="quota-limit-item" data-field="total">
            <div class="item-head">
              <div>
                <strong>历史累计总额度 ($)</strong>
                <small class="muted">达到后 API Key 停用，仅可手动重置</small>
              </div>
              <TxInput
                v-model="quotaValues.total"
                type="number"
                placeholder="留空不限"
                aria-label="历史累计总额度（美元）"
                :aria-invalid="quotaFieldErrors.total ? 'true' : undefined"
                style="max-width: 130px"
                @blur="validateQuotaField('total')"
              />
              <p v-if="quotaFieldErrors.total" class="field-error" role="alert">{{ quotaFieldErrors.total }}</p>
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

        <TxAlert v-if="quotaSummary" type="error" :message="quotaSummary" />
      </div>

      <template #footer>
        <div class="modal-footer-actions">
          <TxButton variant="secondary" @click="showQuotaModal = false">取消</TxButton>
          <TxButton variant="primary" :loading="quotaSaving" @click="saveQuota">保存额度设置</TxButton>
        </div>
      </template>
    </TxModal>

    <!-- 新建 API Key 成功查看弹窗 -->
    <TxModal v-model="showRevealModal" title="API Key 创建成功" width="500px">
      <div class="reveal-content">
        <TxAlert
          type="warning"
          title="请妥善保管"
          message="完整的 API Key 仅在此处展示一次，窗口关闭后将无法再次直接查看明文！"
        />
        <div class="reveal-box">
          <code class="mono">{{ newlyCreatedKey }}</code>
        </div>
      </div>
      <template #footer>
        <div class="modal-footer-actions">
          <TxButton variant="secondary" @click="showRevealModal = false">我已手动保存</TxButton>
          <TxButton
            variant="primary"
            icon="i-carbon-copy"
            :loading="revealCopying"
            @click="copyNewKey"
          >
            复制 API Key 并关闭
          </TxButton>
        </div>
      </template>
    </TxModal>
  </div>
</template>

.field-error {
  margin: 6px 0 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--tx-color-danger);
}
<style scoped>
.keys-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  margin-bottom: 4px;
}

.keys-count {
  margin-left: auto;
}

.keys-table-card {
  min-width: 0;
  overflow: hidden;
}

.keys-pager {
  display: flex;
  justify-content: flex-end;
  padding: 12px 16px;
}

.search-input-wrap {
  width: min(280px, 60vw);
}

/* 主标识是真正的按钮：可见焦点环、键盘可触发、触屏有足够点击面 */
.cell-key-name {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  width: 100%;
  padding: 0;
  border: 0;
  background: transparent;
  font: inherit;
  color: inherit;
  text-align: left;
  cursor: pointer;
}

.cell-key-name:hover strong {
  color: var(--tx-color-primary);
  text-decoration: underline;
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
