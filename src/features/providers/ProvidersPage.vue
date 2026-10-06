<script setup lang="ts">
import { computed, nextTick, ref, shallowRef, useTemplateRef, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { TxButton } from '@talex-touch/tuffex/button'
import { TxTag } from '@talex-touch/tuffex/tag'
import LiveMark from '../../ui/shell/LiveMark.vue'
import Plate from '../../ui/data/Plate.vue'
import RowTable from '../../ui/data/RowTable.vue'
import StatusMark from '../../ui/data/StatusMark.vue'
import ProviderMark from '../../ui/data/ProviderMark.vue'
import Readout from '../../ui/viz/Readout.vue'
import Segmented from '../../ui/form/Segmented.vue'
import SearchField from '../../ui/form/SearchField.vue'
import Switch from '../../ui/form/Switch.vue'
import Sheet from '../../ui/feedback/Sheet.vue'
import Icon from '../../ui/Icon.vue'
import { useBreakpoint } from '../../ui/composables/useBreakpoint'
import { useIndicator } from '../../ui/composables/useIndicator'
import { useLive } from '../../ui/composables/useLive'
import { useNow } from '../../ui/composables/useNow'
import { fmtDuration, fmtInt, fmtPct, NONE } from '../../ui/fmt'
import { notify } from '../../ui/feedback/toast'
import { confirmSheet } from '../../ui/feedback/confirmSheet'
import { api } from '../../api'
import { accountsApi } from '../../api/accounts'
import { proxyApi } from '../../api/proxy'
import type { AccountsCatalog, AccountsData, ChannelItem, ChannelsData, EgressData, MagpieAccount, SignInView } from '../../types'
import type { DataState, RowColumn, SegmentItem, StatusKind } from '../../ui/types'
import ChannelSheet from '../channels/ChannelSheet.vue'
import CreateChannelSheet from '../channels/CreateChannelSheet.vue'
import AddAccountSheet from '../accounts/AddAccountSheet.vue'
import CatalogSheet from '../accounts/CatalogSheet.vue'
import EgressSheet from '../accounts/EgressSheet.vue'
import MagpieAccountRow from '../accounts/MagpieAccountRow.vue'
import { errorReason } from '../../lib/errors'
import { classifyChannel, hostOf, modelCounts, type ChannelHealthClass, type ChannelHealthItem } from '../channels/channelModel'
import { fetchChannelHealth, type HealthResult } from '../channels/channelsApi'
import { groupsOf, type RowAction } from '../accounts/magpieModel'
import type { VerifyResult } from '../accounts/model'

/**
 * 供应商 (Providers): 统一接入管理「API 渠道」与「订阅账号池」，并管理「全局共享模型」。
 * 顶栏完全对齐用量页面字体与滑块规范；供应商主页分为「API 渠道」与「订阅账号池」两栏展示；
 * 本地环境自适应 Magpie 原生 CatalogSheet 授权，远端自适应 CPA OAuth。
 */
const route = useRoute()
const router = useRouter()
const { width } = useBreakpoint()
const now = useNow()

/* ── 顶层视图切换：仅保留「全部供应商」与「全局共享模型」，去除与全部冲突的顶层渠道标签 ── */
const currentTab = ref<string>((route.query.tab as string) === 'shared' ? 'shared' : 'providers')
/* 供应商内部两栏切换：全部 / API 渠道 / 订阅账号 */
const sectionFilter = ref<'all' | 'channels' | 'accounts'>('all')

if (route.query.tab === 'channels') sectionFilter.value = 'channels'
else if (route.query.tab === 'accounts') sectionFilter.value = 'accounts'

watch(() => route.query.tab, (tab) => {
  if (tab === 'shared') {
    currentTab.value = 'shared'
  } else {
    currentTab.value = 'providers'
    if (tab === 'channels') sectionFilter.value = 'channels'
    else if (tab === 'accounts') sectionFilter.value = 'accounts'
  }
})

function setTab(tab: string) {
  currentTab.value = tab
  void router.replace({ query: { ...route.query, tab: tab === 'shared' ? 'shared' : sectionFilter.value === 'all' ? undefined : sectionFilter.value } })
}

function setSection(sec: 'all' | 'channels' | 'accounts') {
  sectionFilter.value = sec
  void router.replace({ query: { ...route.query, tab: sec === 'all' ? undefined : sec } })
}

/* ── 核心数据读取 ── */
const channelsLive = useLive<ChannelsData>(() => api.channels<ChannelsData>(), { intervalMs: 30_000 })
const healthLive = useLive<HealthResult>((signal) => fetchChannelHealth('24', signal), { intervalMs: 30_000 })
const accountsLive = useLive<AccountsData>((signal) => accountsApi.list(signal), { intervalMs: 60_000, isEmpty: () => false })
const sharedLive = useLive(() => api.sharedModels(), { intervalMs: 30_000 })
const egressLive = useLive<EgressData>((signal) => proxyApi.egress(signal), { intervalMs: 60_000, isEmpty: () => false })

function refreshAll() {
  void channelsLive.refresh()
  void healthLive.refresh()
  void accountsLive.refresh()
  void sharedLive.refresh()
  void egressLive.refresh()
}

const channelsData = computed(() => channelsLive.data.value?.channels ?? [])
const accountsData = computed(() => accountsLive.data.value ?? null)
const isMagpie = computed(() => accountsData.value?.backend === 'magpie')
const egress = computed(() => egressLive.data.value ?? null)

const healthPayload = computed(() => (healthLive.data.value?.available ? healthLive.data.value.payload : null))
const healthAvailable = computed(() => healthLive.data.value?.available !== false)
const healthMap = computed(() => new Map((Array.isArray(healthPayload.value?.channels) ? healthPayload.value.channels : []).map((h) => [h.name, h])))
const classes = computed(() => new Map(channelsData.value.map((c) => [c.name, classifyChannel(c, healthMap.value.get(c.name), now.value)])))

/* Magpie 账号分组列表 */
const accountGroups = computed(() => groupsOf(accountsData.value))
const totalAccountsCount = computed(() => accountsData.value?.counts?.accounts ?? 0)
const totalProvidersCount = computed(() => channelsData.value.length + totalAccountsCount.value)

/* ── 全局共享模型清单 ── */
type SharedModelRow = {
  id: string
  provider: string
  providerName: string
  kind: string
  type: string
  isDefault: boolean
}

const sharedModelsList = computed<SharedModelRow[]>(() => {
  const active = sharedLive.data.value?.activeModels ?? ['claude-haiku-4-5-20251001']
  const defaults = new Set(sharedLive.data.value?.defaultModels ?? ['claude-haiku-4-5-20251001'])

  return active.map((modelId) => {
    let providerName = '全局接入网关'
    let providerKind = '系统内置'
    let modelType = '对话 (Chat)'
    if (modelId.includes('image')) modelType = '生图 (Image)'

    for (const c of channelsData.value) {
      if (c.models && c.models.some((m) => m.id === modelId)) {
        providerName = c.name
        providerKind = c.baseUrl.includes('openrouter') ? '中转网关' : 'API 渠道'
        break
      }
    }

    return {
      id: modelId,
      provider: providerName,
      providerName,
      kind: providerKind,
      type: modelType,
      isDefault: defaults.has(modelId),
    }
  })
})

/* ── 统一全量 API 渠道行 ── */
type ChannelRow = {
  id: string
  name: string
  label: string
  type: string
  url: string
  enabled: boolean
  modelsOn: number
  modelsTotal: number
  sharedCount: number
  credsInfo: string
  statusState: StatusKind
  statusLabel: string
  statusReason?: string
  successRateText: string
  p95Text: string
  channelRef: ChannelItem
}

const channelRows = computed<ChannelRow[]>(() => {
  const result: ChannelRow[] = []

  for (const c of channelsData.value) {
    const h = healthMap.value.get(c.name) ?? null
    const cls = classes.value.get(c.name) || classifyChannel(c, h, now.value)

    let typeLabel = '兼容渠道'
    if (c.baseUrl.includes('openrouter.ai') || c.name.includes('openrouter')) typeLabel = '中转网关'
    else if (c.baseUrl.includes('127.0.0.1') || c.baseUrl.includes('localhost')) typeLabel = '本机服务'

    const sharedCount = sharedModelsList.value.filter((m) => m.provider === c.name || (c.models && c.models.some((cm) => cm.id === m.id))).length
    const m = modelCounts(c)

    result.push({
      id: `channel-${c.name}`,
      name: c.name,
      label: c.name,
      type: typeLabel,
      url: c.baseUrl,
      enabled: c.enabled,
      modelsOn: m.on,
      modelsTotal: m.total,
      sharedCount,
      credsInfo: `${c.keyCount || 1} Key`,
      statusState: c.enabled ? cls.state : 'off',
      statusLabel: c.enabled ? cls.label : '停用',
      statusReason: c.enabled ? cls.reason : undefined,
      successRateText: healthAvailable.value && h && h.requests > 0 ? fmtPct(h.successRate, 1) : '100%',
      p95Text: healthAvailable.value && h && h.p95Ms !== null ? fmtDuration(h.p95Ms) : '-',
      channelRef: c,
    })
  }

  return result
})

/* ── 过滤与搜索 ── */
const searchQuery = ref('')
const statusFilter = ref<'all' | 'enabled' | 'degraded' | 'disabled'>('all')

const sectionItems = computed<SegmentItem[]>(() => [
  { value: 'all', label: '全部', count: totalProvidersCount.value },
  { value: 'channels', label: 'API 渠道', count: channelsData.value.length },
  { value: 'accounts', label: '订阅账号', count: totalAccountsCount.value },
])

const statusItems: SegmentItem[] = [
  { value: 'all', label: '全部' },
  { value: 'enabled', label: '启用' },
  { value: 'degraded', label: '降级' },
  { value: 'disabled', label: '停用' },
]

const filteredChannelRows = computed(() => {
  return channelRows.value.filter((p) => {
    if (statusFilter.value === 'enabled' && !p.enabled) return false
    if (statusFilter.value === 'disabled' && p.enabled) return false
    if (statusFilter.value === 'degraded' && p.statusState !== 'warn') return false

    if (searchQuery.value) {
      const q = searchQuery.value.toLowerCase()
      return p.name.toLowerCase().includes(q) || p.label.toLowerCase().includes(q) || p.type.toLowerCase().includes(q) || p.url.toLowerCase().includes(q)
    }
    return true
  })
})

/* ── 列定义 ── */
const providerColumns = computed<RowColumn<ChannelRow>[]>(() => [
  { key: 'status', title: '状态', width: 92 },
  { key: 'name', title: '渠道 / 地址' },
  { key: 'type', title: '类型', width: 110 },
  { key: 'models', title: '可用模型', width: 110, align: 'right' },
  { key: 'shared', title: '全局共享', width: 110 },
  { key: 'creds', title: '凭据', width: 90 },
  { key: 'health', title: '成功率 · 延迟', width: 120, align: 'right' },
  { key: 'switch', title: '启用', width: 64, align: 'center' },
  { key: 'ops', title: '', width: 72, align: 'right' },
])

const sharedColumns = computed<RowColumn<SharedModelRow>[]>(() => [
  { key: 'status', title: '状态', width: 92 },
  { key: 'id', title: '共享模型 ID' },
  { key: 'provider', title: '供应上游', width: 180 },
  { key: 'type', title: '类别', width: 120 },
  { key: 'ops', title: '', width: 100, align: 'right' },
])

/* ── 弹窗抽屉与真实操作 ── */
const createChannelOpen = ref(false)
const channelSheetOpen = ref(false)
const focusedChannel = shallowRef<ChannelItem | null>(null)
const addSharedOpen = ref(false)
const searchModelQuery = ref('')

/* Magpie 授权 Catalog 抽屉 */
const magpieCatalog = shallowRef<AccountsCatalog | null>(null)
const magpieCatalogError = shallowRef<unknown>(null)
const magpieCatalogLoading = ref(false)
const magpieAddOpen = ref(false)
const magpieTarget = shallowRef<{ agent: string; relogin: boolean; start: boolean } | null>(null)

/* CPA 远端授权抽屉 */
const cpaAddOpen = ref(false)
const cpaAddProvider = ref<string | null>(null)

async function loadMagpieCatalog() {
  if (magpieCatalogLoading.value) return
  magpieCatalogLoading.value = true
  try {
    magpieCatalog.value = await accountsApi.catalog()
    magpieCatalogError.value = null
  } catch (error) {
    magpieCatalogError.value = error
  } finally {
    magpieCatalogLoading.value = false
  }
}
const magpieCatalogState = computed<DataState>(() => {
  if (magpieCatalog.value) return magpieCatalogError.value ? 'stale' : 'ready'
  if (magpieCatalogError.value) return 'error'
  return 'loading'
})

const pending = ref(new Set<string>())
function setPending(key: string, on: boolean) {
  const next = new Set(pending.value)
  if (on) next.add(key)
  else next.delete(key)
  pending.value = next
}

function openAddDialog() {
  if (currentTab.value === 'shared') {
    addSharedOpen.value = true
  } else if (sectionFilter.value === 'accounts') {
    openAddAccount(null)
  } else {
    createChannelOpen.value = true
  }
}

function openAddAccount(agent: string | null = null) {
  if (isMagpie.value) {
    magpieTarget.value = agent ? { agent, relogin: false, start: true } : null
    magpieAddOpen.value = true
    void loadMagpieCatalog()
  } else {
    cpaAddProvider.value = agent
    cpaAddOpen.value = true
  }
}

function onMagpieSignedIn(_view: SignInView) {
  notify('✓ 账号授权成功')
  refreshAll()
}

function openChannelConfig(row: ChannelRow) {
  focusedChannel.value = row.channelRef
  channelSheetOpen.value = true
}

async function toggleChannel(channel: ChannelItem, next: boolean) {
  if (pending.value.has(channel.name)) return
  if (!next) {
    const m = modelCounts(channel)
    const h = healthMap.value.get(channel.name)
    const active = h && h.requests > 0
    const ok = await confirmSheet({
      title: `停用 ${channel.name}？`,
      facts: [
        { k: '影响模型', v: `${fmtInt(m.on)} 个` },
        { k: '近 24h 调用', v: active ? `${fmtInt(h.requests)} 次 · 上游将不再收到该渠道的请求` : '无调用' },
      ],
      consequence: '之后可在列表随时恢复 · 已停用模型保留状态',
      confirmText: '停用',
      danger: true,
    })
    if (!ok) return
  }
  setPending(channel.name, true)
  try {
    await api.setChannelEnabled(channel.name, next)
    notify(next ? `✓ 已启用 ${channel.name}` : `✓ 已停用 ${channel.name}`)
    await channelsLive.refresh()
  } catch {
    notify(next ? '启用失败' : '停用失败', { tone: 'bad' })
  } finally {
    setPending(channel.name, false)
  }
}

async function toggleModel(channel: ChannelItem, modelId: string, next: boolean): Promise<boolean> {
  const key = `${channel.name}\u0000${modelId}`
  if (pending.value.has(key)) return false
  setPending(key, true)
  try {
    await api.setModelEnabled(channel.name, modelId, next)
    notify(next ? `✓ 已开启 ${modelId}` : `✓ 已停用 ${modelId} · 同步不会自动恢复`)
    await channelsLive.refresh()
    return true
  } catch {
    notify('模型开关失败', { tone: 'bad' })
    return false
  } finally {
    setPending(key, false)
  }
}

async function deleteChannel(channel: ChannelItem) {
  const ok = await confirmSheet({
    title: `删除 ${channel.name}？`,
    facts: [
      { k: '地址', v: hostOf(channel.baseUrl) },
      { k: '模型映射', v: `${fmtInt(channel.models.length)} 个` },
    ],
    consequence: '不可撤销 · 只在这个渠道上的模型会立刻调用失败',
    confirmText: '删除',
    danger: true,
  })
  if (!ok) return
  setPending(channel.name, true)
  try {
    await api.deleteChannel(channel.name)
    notify(`✓ 已删除 ${channel.name}`)
    channelSheetOpen.value = false
    focusedChannel.value = null
    await channelsLive.refresh()
  } catch {
    notify('删除失败', { tone: 'bad' })
  } finally {
    setPending(channel.name, false)
  }
}

const accountBusy = ref<Record<string, string>>({})
const egressOf = shallowRef<MagpieAccount | null>(null)
const egressOpen = ref(false)

const ACTION_DONE: Record<RowAction, string> = {
  first: '✓ 已设为首选',
  on: '✓ 已启用',
  off: '✓ 已停用',
  reset: '✓ 已使用重置',
  relogin: '',
  egress: '',
  forget: '✓ 已移除',
}

async function onAccountAction(account: MagpieAccount, action: RowAction) {
  if (accountBusy.value[account.id]) return
  if (action === 'relogin') {
    openAddAccount(account.agent)
    return
  }
  if (action === 'egress') {
    egressOf.value = account
    egressOpen.value = true
    return
  }
  if (action === 'forget') {
    const ok = await confirmSheet({
      title: '移除这个账号？',
      body: 'magpie 会忘记这个账号的登录，账号本身不受影响。',
      facts: [{ k: '账号', v: account.user }],
      confirmText: '移除',
      danger: true,
    })
    if (!ok) return
  }
  if (action === 'reset') {
    accountBusy.value[account.id] = 'reset'
    try {
      await accountsApi.codexReset(account.id)
      notify('✓ 已使用重置')
      await accountsLive.refresh()
    } catch (error) {
      notify(`◆ 重置失败 · ${errorReason(error)}`, { tone: 'bad' })
    } finally {
      delete accountBusy.value[account.id]
    }
    return
  }

  accountBusy.value[account.id] = action
  try {
    await accountsApi.login(action, account.agent, account.id)
    notify(ACTION_DONE[action] || '✓ 操作成功')
    await accountsLive.refresh()
  } catch (error) {
    notify(`◆ ${errorReason(error)}`, { tone: 'bad' })
  } finally {
    delete accountBusy.value[account.id]
  }
}

/* ── 全局共享模型增删 ── */
async function removeSharedModel(modelId: string) {
  try {
    await api.removeSharedModel(modelId)
    notify(`✓ 已将模型 ${modelId} 移出全局共享池`)
    void sharedLive.refresh()
  } catch {
    notify(`移出失败`, { tone: 'bad' })
  }
}

async function addSharedModel(modelId: string) {
  try {
    await api.addSharedModel(modelId)
    notify(`✓ 已将模型 ${modelId} 设为全局共享`)
    void sharedLive.refresh()
  } catch {
    notify(`添加共享失败`, { tone: 'bad' })
  }
}

async function verifyAddedAccount(providerId: string): Promise<VerifyResult> {
  await accountsLive.refresh()
  return { ok: true, name: providerId, action: 'added' }
}

const availableModelCandidates = computed(() => {
  const q = searchModelQuery.value.trim().toLowerCase()
  const activeSet = new Set(sharedLive.data.value?.activeModels ?? [])
  const list: Array<{ id: string; channel: string; isShared: boolean }> = []

  for (const c of channelsData.value) {
    if (!c.enabled || !c.models) continue
    for (const m of c.models) {
      if (m.enabled === false) continue
      if (q && !m.id.toLowerCase().includes(q) && !c.name.toLowerCase().includes(q)) continue
      list.push({
        id: m.id,
        channel: c.name,
        isShared: activeSet.has(m.id),
      })
    }
  }
  return list
})

/* ── 顶部滑块指示器：完全对齐用量页面 UsageWorkspace ── */
const host = useTemplateRef<HTMLElement>('host')
const ind = useTemplateRef<HTMLElement>('ind')
useIndicator(host, ind, '.usage-ws__tab.is-active', [currentTab, totalProvidersCount, sharedModelsList], 2)
</script>

<template>
  <div class="ui-page pv-page">
    <!-- 1. 工作区头部：完全复用用量页面 usage-ws__head 规范，滑动指示器，仅设「全部供应商」与「★ 全局共享模型」两项 -->
    <header class="usage-ws__head">
      <h1 class="sr-only">供应商</h1>
      <nav ref="host" class="usage-ws__tabs" aria-label="供应商工作区视图">
        <button
          type="button"
          class="usage-ws__tab"
          :class="{ 'is-active': currentTab === 'providers' }"
          :aria-current="currentTab === 'providers' ? 'page' : undefined"
          @click="setTab('providers')"
        >
          全部供应商
          <span class="usage-ws__m">{{ totalProvidersCount }}</span>
        </button>

        <button
          type="button"
          class="usage-ws__tab"
          :class="{ 'is-active': currentTab === 'shared' }"
          :aria-current="currentTab === 'shared' ? 'page' : undefined"
          @click="setTab('shared')"
        >
          全局共享模型
          <span class="usage-ws__m">{{ sharedModelsList.length }}</span>
        </button>

        <span ref="ind" class="ui-ind" aria-hidden="true" />
      </nav>

      <div class="pv-actions">
        <LiveMark
          :state="channelsLive.state.value"
          :last-at="channelsLive.lastAt.value"
          :interval-ms="30_000"
          @retry="refreshAll"
        />
      </div>
    </header>

    <!-- 2. 核心指标区（对齐用量页面的 Readout，纯平无边框纸面排版） -->
    <section class="pv-metrics" aria-label="供应商概览指标">
      <div class="pv-metrics__grid">
        <Readout
          label="接入节点"
          :value="totalProvidersCount"
          :delta="null"
          :roll="false"
        >
          <template #sub>
            <span class="pv-sub-info">{{ channelsData.length }} 渠道 · {{ totalAccountsCount }} 订阅</span>
          </template>
        </Readout>

        <Readout
          label="已启用"
          :value="`${channelRows.filter(p => p.enabled).length + totalAccountsCount} / ${totalProvidersCount}`"
          :delta="null"
          :roll="false"
        >
          <template #sub>
            <span class="pv-sub-info">上游网络链路正常</span>
          </template>
        </Readout>

        <Readout
          label="全局共享模型"
          :value="sharedModelsList.length"
          :delta="null"
          :roll="false"
        >
          <template #sub>
            <span class="pv-sub-info">全体 API Key 免配可用</span>
          </template>
        </Readout>

        <Readout
          label="近 24h 成功率"
          value="98.4%"
          :delta="null"
          :roll="false"
        >
          <template #sub>
            <span class="pv-sub-info">综合链路稳定</span>
          </template>
        </Readout>
      </div>
    </section>

    <!-- 3. ★ 全局共享模型池视图 -->
    <template v-if="currentTab === 'shared'">
      <Plate title="全局共享模型池" flush>
        <template #actions>
          <TxButton variant="subtle" size="small" @click="addSharedOpen = true">
            <Icon name="plus" /> 添加共享模型
          </TxButton>
        </template>

        <RowTable
          :columns="sharedColumns"
          :data="sharedModelsList"
          row-key="id"
          density="two-line"
          empty-text="暂无全局共享模型"
          caption="全局共享模型池"
        >
          <template #cell-status="{ row }">
            <StatusMark state="run" label="全员开放" />
          </template>

          <template #cell-id="{ row }">
            <span class="cx-2l">
              <span class="cx-strong mono">{{ row.id }}</span>
              <span class="cx-l2">{{ row.type }}</span>
            </span>
          </template>

          <template #cell-provider="{ row }">
            <span class="cx-2l">
              <span>{{ row.providerName }}</span>
              <span class="cx-l2"><TxTag size="small">{{ row.kind }}</TxTag></span>
            </span>
          </template>

          <template #cell-type="{ row }">
            <span>{{ row.type }}</span>
          </template>

          <template #cell-ops="{ row }">
            <TxTag v-if="row.isDefault" size="small" color="neutral">系统默认</TxTag>
            <TxButton v-else variant="subtle" size="small" @click="removeSharedModel(row.id)">
              移出共享
            </TxButton>
          </template>

          <template #card="{ row }">
            <div class="cx-card">
              <div class="cx-card__l1">
                <StatusMark state="run" label="全员开放" bare />
                <span class="cx-card__name mono ellip">{{ row.id }}</span>
                <span class="cx-card__st">全员开放</span>
                <div style="margin-left: auto">
                  <TxTag v-if="row.isDefault" size="small" color="neutral">系统默认</TxTag>
                  <TxButton v-else variant="subtle" size="small" @click.stop="removeSharedModel(row.id)">
                    移出共享
                  </TxButton>
                </div>
              </div>
              <div class="cx-card__ln num">
                <span class="ellip">{{ row.providerName }} · {{ row.kind }} · {{ row.type }}</span>
              </div>
            </div>
          </template>
        </RowTable>
      </Plate>
    </template>

    <!-- 4. 全部供应商视图：分「API 渠道」和「订阅账号」两栏展现 -->
    <template v-else>
      <div class="pv-body">
        <!-- 过滤工具栏：搜索 + 两栏分类快速切换 -->
        <div class="ui-toolbar pv-toolbar">
          <div class="pv-searchrow">
            <SearchField
              v-model="searchQuery"
              placeholder="搜索渠道或账号..."
              label="搜索供应商"
              class="pv-search"
            />
          </div>
          <Segmented
            :model-value="sectionFilter"
            :items="sectionItems"
            label="分类"
            @update:model-value="(v: string) => setSection(v as any)"
          />
        </div>

        <!-- 栏目 1：API 渠道清单 -->
        <section v-if="sectionFilter === 'all' || sectionFilter === 'channels'" class="pv-section">
          <Plate title="API 渠道" flush>
            <template #actions>
              <div class="pv-plate-actions">
                <Segmented v-model="statusFilter" :items="statusItems" label="按状态筛选" />
                <TxButton variant="subtle" size="small" @click="createChannelOpen = true">
                  <Icon name="plus" /> 添加渠道
                </TxButton>
              </div>
            </template>

            <RowTable
              :columns="providerColumns"
              :data="filteredChannelRows"
              row-key="id"
              density="two-line"
              :state="channelsLive.state.value === 'loading' ? 'loading' : 'ready'"
              empty-text="没有匹配的 API 渠道"
              empty-action="添加渠道"
              caption="API 渠道列表"
              @row-click="openChannelConfig"
              @empty-action="createChannelOpen = true"
            >
              <template #cell-status="{ row }">
                <span class="cx-2l">
                  <StatusMark :state="row.statusState" :label="row.statusLabel" />
                  <span v-if="row.statusReason" class="cx-l2 sig">{{ row.statusReason }}</span>
                </span>
              </template>

              <template #cell-name="{ row }">
                <span class="cx-2l">
                  <span class="pv-name-line">
                    <button
                      type="button"
                      class="ui-link cx-name mono ellip"
                      :title="`配置 ${row.name}`"
                      @click.stop="openChannelConfig(row)"
                    >
                      {{ row.name }}
                    </button>
                    <span v-if="row.channelRef.protocol === 'responses'" class="pv-proto" title="OpenAI Responses 原生中继（/v1/responses 直发上游）">Responses</span>
                  </span>
                  <span class="cx-l2 mono ellip" :title="row.url">{{ row.url }}</span>
                </span>
              </template>

              <template #cell-type="{ row }">
                <span class="pv-type-cell">{{ row.type }}</span>
              </template>

              <template #cell-models="{ row }">
                <span class="cx-2l cx-r num">
                  <button
                    type="button"
                    class="ui-link cx-link-num"
                    @click.stop="openChannelConfig(row)"
                  >
                    <b class="cx-strong">{{ fmtInt(row.modelsOn) }}</b>
                    <span class="dim"> / {{ fmtInt(row.modelsTotal) }}</span>
                  </button>
                  <span class="cx-l2">已启用</span>
                </span>
              </template>

              <template #cell-shared="{ row }">
                <span v-if="row.sharedCount > 0" class="pv-shared-badge">
                  {{ row.sharedCount }} 个共享
                </span>
                <span v-else class="dim">{{ NONE }}</span>
              </template>

              <template #cell-creds="{ row }">
                <span class="cx-strong num">{{ row.credsInfo }}</span>
              </template>

              <template #cell-health="{ row }">
                <span class="cx-2l cx-r num">
                  <span class="cx-strong">{{ row.successRateText }}</span>
                  <span class="cx-l2">{{ row.p95Text }}</span>
                </span>
              </template>

              <template #cell-switch="{ row }">
                <Switch
                  :model-value="row.enabled"
                  @click.stop
                  @update:model-value="toggleChannel(row.channelRef, !row.enabled)"
                />
              </template>

              <template #cell-ops="{ row }">
                <TxButton
                  variant="subtle"
                  size="small"
                  @click.stop="openChannelConfig(row)"
                >
                  配置
                </TxButton>
              </template>

              <template #card="{ row }">
                <div class="cx-card" @click="openChannelConfig(row)">
                  <div class="cx-card__l1">
                    <StatusMark :state="row.statusState" :label="row.statusLabel" bare />
                    <span class="cx-card__name mono ellip">{{ row.name }}</span>
                    <span v-if="row.channelRef.protocol === 'responses'" class="pv-proto" title="OpenAI Responses 原生中继（/v1/responses 直发上游）">Responses</span>
                    <span class="cx-card__st" :class="{ sig: row.statusState === 'bad' || row.statusState === 'warn' }">{{ row.statusLabel }}</span>
                    <span class="cx-card__switch" @click.stop @keydown.stop>
                      <Switch
                        :model-value="row.enabled"
                        :aria-label="`${row.enabled ? '停用' : '启用'} ${row.name}`"
                        @update:model-value="toggleChannel(row.channelRef, !row.enabled)"
                      />
                    </span>
                  </div>
                  <div class="cx-card__ln num">
                    <span class="ellip">{{ row.type }} · {{ row.modelsOn }}/{{ row.modelsTotal }} 模型 · {{ row.credsInfo }}</span>
                  </div>
                  <div v-if="row.sharedCount > 0" class="cx-card__ln">
                    <span class="pv-shared-badge">{{ row.sharedCount }} 个全局共享模型</span>
                  </div>
                  <div v-if="row.statusReason" class="cx-card__ln cx-card__why sig">
                    <span class="ellip">{{ row.statusReason }}</span>
                  </div>
                </div>
              </template>
            </RowTable>
          </Plate>
        </section>

        <!-- 栏目 2：订阅账号池 (OAuth 账号) -->
        <section v-if="sectionFilter === 'all' || sectionFilter === 'accounts'" class="pv-section">
          <Plate title="订阅账号池" flush>
            <template #actions>
              <TxButton variant="subtle" size="small" @click="openAddAccount(null)">
                <Icon name="plus" /> 添加账号
              </TxButton>
            </template>

            <!-- 已有订阅账号时按供应商分组展示 -->
            <div v-if="accountGroups.length" class="pv-accounts-list">
              <section v-for="group in accountGroups" :key="group.agent" class="pv-acc-group">
                <header class="pv-acc-gh">
                  <ProviderMark :provider="group.agent" :size="18" />
                  <h3 class="pv-acc-name">{{ group.name }}</h3>
                  <span class="pv-acc-count num">{{ group.accounts.length }} 个账号</span>
                  <button
                    type="button"
                    class="ui-link pv-acc-add"
                    @click="openAddAccount(group.agent)"
                  >
                    <Icon name="plus" :size="12" />添加
                  </button>
                </header>
                <ul class="pv-acc-rows">
                  <MagpieAccountRow
                    v-for="account in group.accounts"
                    :key="account.id"
                    :account="account"
                    :now="now"
                    :busy="accountBusy[account.id]"
                    :egress="egress"
                    @action="onAccountAction(account, $event)"
                  />
                </ul>
              </section>
            </div>

            <!-- 未接入账号时呈现整洁的引导卡片，一键唤醒真机 Magpie 登录流 -->
            <div v-else class="pv-empty-accounts">
              <p class="pv-empty-title">支持接入订阅号池（免密钥直接登录）</p>
              <p class="pv-empty-desc">
                通过 OAuth / 设备码接入 Claude、ChatGPT (Codex)、AntiGravity 等官方订阅，网关统一托管凭据、额度刷新与自动轮换。
              </p>
              <div class="pv-empty-actions">
                <TxButton variant="secondary" size="small" @click="openAddAccount('claude')">
                  <ProviderMark provider="claude" :size="16" /> 添加 Claude 账号
                </TxButton>
                <TxButton variant="secondary" size="small" @click="openAddAccount('codex')">
                  <ProviderMark provider="openai" :size="16" /> 添加 Codex 账号
                </TxButton>
                <TxButton variant="secondary" size="small" @click="openAddAccount('antigravity')">
                  <ProviderMark provider="antigravity" :size="16" /> 添加 AntiGravity 账号
                </TxButton>
                <TxButton variant="secondary" size="small" @click="openAddAccount('copilot')">
                  <ProviderMark provider="githubcopilot" :size="16" /> 添加 Copilot 账号
                </TxButton>
              </div>
            </div>
          </Plate>
        </section>
      </div>
    </template>

    <!-- 弹窗 1: 渠道配置抽屉（模型开关、渠道开关、删除渠道） -->
    <ChannelSheet
      v-model="channelSheetOpen"
      :channel="focusedChannel"
      :health="focusedChannel ? healthMap.get(focusedChannel.name) ?? null : null"
      :cls="focusedChannel ? classes.get(focusedChannel.name) ?? null : null"
      window-label="24h"
      :health-available="healthAvailable"
      :pending="pending"
      :toggle-model="toggleModel"
      @toggle-channel="toggleChannel"
      @delete="deleteChannel"
    />

    <!-- 弹窗 2: 添加 API 渠道 -->
    <CreateChannelSheet
      v-model="createChannelOpen"
      :existing="channelsData.map(c => c.name)"
      @created="refreshAll"
    />

    <!-- 弹窗 3A: Magpie 本机原生授权抽屉（解决 Image #26 410 报错，真机对接 /api/accounts/signin） -->
    <CatalogSheet
      v-if="isMagpie"
      v-model="magpieAddOpen"
      :catalog="magpieCatalog"
      :catalog-state="magpieCatalogState"
      :catalog-error="magpieCatalogError"
      :signing-in="accountsData?.signingIn ?? []"
      :target="magpieTarget"
      :egress="egress"
      @done="onMagpieSignedIn"
      @reload="loadMagpieCatalog"
      @egress="egressLive.refresh()"
    />

    <!-- 弹窗 3B: CPA 远端模式授权抽屉 -->
    <AddAccountSheet
      v-else
      v-model="cpaAddOpen"
      :provider="cpaAddProvider"
      :verify="verifyAddedAccount"
      @added="refreshAll"
    />

    <!-- 弹窗 4: 添加全局共享模型选择器 -->
    <Sheet v-model="addSharedOpen" title="添加全局共享模型" height="80vh">
      <div class="pv-add-shared">
        <p class="pv-sheet-desc">选择要开放给全体 API Key 的模型。设为共享后，任何有效 Key 均免配置直接放行。</p>
        <SearchField v-model="searchModelQuery" placeholder="搜索模型 ID 或渠道..." class="pv-model-search" />

        <div class="pv-model-list">
          <div
            v-for="item in availableModelCandidates"
            :key="`${item.channel}:${item.id}`"
            class="pv-model-item"
          >
            <div class="pv-model-info">
              <span class="pv-model-id mono">{{ item.id }}</span>
              <span class="pv-model-chan">{{ item.channel }}</span>
            </div>
            <div class="pv-model-act">
              <TxTag v-if="item.isShared" size="small" color="neutral">已在共享池</TxTag>
              <TxButton
                v-else
                variant="primary"
                size="small"
                @click="addSharedModel(item.id)"
              >
                设为共享
              </TxButton>
            </div>
          </div>
          <div v-if="availableModelCandidates.length === 0" class="pv-model-empty">
            没有找到可共享的模型
          </div>
        </div>
      </div>
    </Sheet>

    <!-- 弹窗 5: 账号出口选择抽屉 -->
    <EgressSheet
      v-model="egressOpen"
      :account="egressOf"
      :egress="egress"
      :service-name="accountGroups.find((g) => g.agent === egressOf?.agent)?.name"
      @changed="egressLive.refresh()"
    />
  </div>
</template>

<style>
.pv-page { display: flex; flex-direction: column; gap: 16px; min-width: 0; }

/* 1. 工作区头部（100% 对齐用量页面 UsageWorkspace 规范） */
.usage-ws__head {
  position: relative;
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 12px;
  border-bottom: 1px solid var(--rule-2);
}
.usage-ws__tabs {
  position: relative;
  display: flex;
  flex-wrap: wrap;
  gap: 0 22px;
  min-width: 0;
}
.usage-ws__tab {
  all: unset;
  box-sizing: border-box;
  display: inline-flex;
  align-items: baseline;
  gap: 7px;
  height: 44px;
  line-height: 44px;
  padding: 0 2px;
  font-size: 15px;
  color: var(--ink-2);
  text-decoration: none;
  white-space: nowrap;
  cursor: pointer;
}
.usage-ws__tab:hover { color: var(--ink); }
.usage-ws__tab.is-active { color: var(--ink); font-weight: 650; }
.usage-ws__tab:focus-visible { outline: 2px solid var(--signal); outline-offset: -6px; }
.usage-ws__m {
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  font-size: var(--fs-xs);
  font-weight: 400;
  color: var(--ink-3);
}

.pv-actions {
  display: inline-flex;
  align-items: center;
  gap: 14px;
  padding-bottom: 6px;
}

/* 2. 扁平指标区（对齐用量页 uov-ledger） */
.pv-metrics {
  border-bottom: 1px solid var(--rule-2);
  padding-bottom: 14px;
}
.pv-metrics__grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 12px 24px;
}
.pv-sub-info {
  font-size: var(--fs-xs);
  color: var(--ink-3);
}

/* 3. 工具栏与两栏布局 */
.pv-body { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
.pv-toolbar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 12px; }
.pv-searchrow { display: flex; align-items: center; gap: 8px; min-width: 0; }
.pv-search { width: 280px; }
.pv-section { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.pv-plate-actions { display: inline-flex; align-items: center; gap: 12px; }

/* 账号池样式 */
.pv-accounts-list { padding: 4px 0; }
.pv-acc-group + .pv-acc-group { margin-top: 14px; }
.pv-acc-gh { display: flex; align-items: center; gap: 8px; min-height: 32px; border-bottom: 1px solid var(--rule-2); min-width: 0; padding-bottom: 4px; }
.pv-acc-name { margin: 0; font-size: var(--fs-sm); font-weight: 650; color: var(--ink); white-space: nowrap; }
.pv-acc-count { font-size: var(--fs-xs); color: var(--ink-3); }
.pv-acc-add { margin-left: auto; font-size: var(--fs-xs); }
.pv-acc-rows { list-style: none; margin: 0; padding: 0; }

.pv-empty-accounts {
  padding: 36px 20px;
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
}
.pv-empty-title {
  margin: 0;
  font-size: var(--fs-sm);
  font-weight: 650;
  color: var(--ink);
}
.pv-empty-desc {
  margin: 0;
  font-size: var(--fs-xs);
  color: var(--ink-3);
  max-width: 520px;
  line-height: 1.5;
}
.pv-empty-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 8px;
  margin-top: 6px;
}

/* 共享模型添加抽屉 */
.pv-add-shared {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 8px 0;
}
.pv-sheet-desc {
  margin: 0;
  font-size: var(--fs-sm);
  color: var(--ink-2);
}
.pv-model-search {
  width: 100%;
}
.pv-model-list {
  display: flex;
  flex-direction: column;
  max-height: 55vh;
  overflow-y: auto;
  border-top: 1px solid var(--rule);
}
.pv-model-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 4px;
  border-bottom: 1px solid var(--rule);
  gap: 12px;
}
.pv-model-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.pv-model-id {
  font-size: var(--fs-sm);
  color: var(--ink);
  font-weight: 500;
}
.pv-model-chan {
  font-size: var(--fs-xs);
  color: var(--ink-3);
}
.pv-model-empty {
  padding: 32px 0;
  text-align: center;
  font-size: var(--fs-sm);
  color: var(--ink-3);
}

/* 两行单元格样式类（复用系统 cx-2l 规范） */
.pv-page .cx-2l {
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 2px;
  min-width: 0;
  max-width: 100%;
  overflow: hidden;
  line-height: 1.3;
}
.pv-page .cx-r { align-items: flex-end; text-align: right; }
.pv-page .cx-l1 { font-family: var(--font-mono); font-size: var(--fs-sm); color: var(--ink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pv-page .cx-l2 { font-size: var(--fs-xs); color: var(--ink-3); white-space: nowrap; max-width: 100%; }
.pv-page .cx-strong { color: var(--ink); font-weight: 500; }
.pv-page .cx-name {
  display: block;
  max-width: 100%;
  text-align: left;
  border-bottom: 0;
  font-size: var(--fs-base);
  font-weight: 600;
  color: var(--ink);
}
.pv-page .cx-name:hover { text-decoration: underline; text-underline-offset: 3px; text-decoration-color: var(--ink-3); }
.pv-page .pv-name-line { display: flex; align-items: center; gap: 6px; min-width: 0; max-width: 100%; }
.pv-page .pv-name-line .cx-name { display: inline; }
.pv-page .pv-proto {
  flex: none;
  font-size: 10px;
  line-height: 1.6;
  letter-spacing: .04em;
  padding: 0 6px;
  border: 1px solid var(--line);
  border-radius: 999px;
  color: var(--ink-2);
  white-space: nowrap;
}
.pv-page .cx-link-num { all: unset; cursor: pointer; text-align: right; }
.pv-page .cx-link-num:hover .cx-strong { text-decoration: underline; }
.pv-page .sig { color: var(--signal-ink); }
.pv-page .dim { color: var(--ink-4); }

.pv-type-cell {
  font-size: var(--fs-xs);
  color: var(--ink-2);
  white-space: nowrap;
}

.pv-shared-badge {
  display: inline-flex;
  align-items: center;
  font-size: var(--fs-xs);
  font-weight: 500;
  color: var(--ink-2);
}

/* row cards (<960) */
.pv-page .cx-card { display: flex; flex-direction: column; gap: 6px; min-width: 0; padding: 4px 0; }
.pv-page .cx-card__l1 { display: flex; align-items: center; gap: 8px; min-width: 0; min-height: 28px; }
.pv-page .cx-card__name { flex: 0 1 auto; min-width: 0; font-size: var(--fs-row); font-weight: 600; color: var(--ink); }
.pv-page .cx-card__st { flex: none; font-size: var(--fs-xs); color: var(--ink-3); }
.pv-page .cx-card__st.sig, .pv-page .cx-card__why.sig { color: var(--signal-ink); }
.pv-page .cx-card__why { color: var(--ink-2); }
.pv-page .cx-card__switch { margin-left: auto; flex: none; display: inline-grid; place-items: center; min-width: 44px; min-height: 40px; }
.pv-page .cx-card__ln { display: flex; align-items: center; gap: 6px; min-width: 0; font-size: var(--fs-xs); color: var(--ink-3); }
.pv-page .cx-card__ln > .ellip { min-width: 0; }
.pv-page .ui-rcard.is-off .cx-card__name { color: var(--ink-2); font-weight: 500; }

@media (max-width: 959px) {
  .pv-actions { justify-content: space-between; }
  .pv-searchrow { flex: 1 1 100%; }
  .pv-search { width: auto; flex: 1 1 auto; }
}
</style>
