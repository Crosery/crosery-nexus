<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { TxButton } from '@talex-touch/tuffex/button'
import PageHead from '../../ui/shell/PageHead.vue'
import LiveMark from '../../ui/shell/LiveMark.vue'
import Plate from '../../ui/data/Plate.vue'
import RowTable from '../../ui/data/RowTable.vue'
import StatusMark from '../../ui/data/StatusMark.vue'
import Pager from '../../ui/data/Pager.vue'
import TickMeter from '../../ui/viz/TickMeter.vue'
import MicroBars from '../../ui/viz/MicroBars.vue'
import SearchField from '../../ui/form/SearchField.vue'
import Segmented from '../../ui/form/Segmented.vue'
import FilterField from '../../ui/form/FilterField.vue'
import Tip from '../../ui/form/Tip.vue'
import Sheet from '../../ui/feedback/Sheet.vue'
import Icon from '../../ui/Icon.vue'
import { confirmSheet } from '../../ui/feedback/confirmSheet'
import { notify } from '../../ui/feedback/toast'
import { useBreakpoint } from '../../ui/composables/useBreakpoint'
import { useLive } from '../../ui/composables/useLive'
import { useNow } from '../../ui/composables/useNow'
import { fmtAgo, fmtInt, fmtPct, fmtSpend, fmtUsd } from '../../ui/fmt'
import type { RowColumn, SegmentItem } from '../../ui/types'
import { setNavCount } from '../../shell/badges'
import { usePaletteCommands } from '../../shell/palette'
import { paginate, useQueryState } from '../../lib/listState'
import { errorMessage } from '../../lib/errors'
import type { ApiKeyItem } from '../../types'
import { fetchKeysSnapshot, keysApi, type KeysSnapshot } from './keysApi'
import {
  ERROR_ALERT,
  errorRate,
  failingBuckets,
  shortUsd,
  filterCounts,
  FILTER_LABEL,
  groupScope,
  keyStatus,
  keyTail,
  lastUsedMs,
  limited,
  matchesFilter,
  matchesQuery,
  SORT_LABEL,
  sortKeys,
  STATUS_VIEW,
  windowRatio,
  type FilterKey,
  type KeyActivity,
  type KeysActivityPayload,
  type SortKey,
} from './keysModel'
import KeyDetail from './KeyDetail.vue'
import KeyRowMenu from './KeyRowMenu.vue'
import KeyEditorSheet from './KeyEditorSheet.vue'
import KeyQuotaSheet from './KeyQuotaSheet.vue'
import KeyRevealSheet from './KeyRevealSheet.vue'

/**
 * /keys (DESIGN §6.3): which Keys are in use, which are near their limit, which are erroring, and what to do
 * about each. Dense 40px rows (name + masked tail on one line), today / this week spend each with its quota
 * meter, the cumulative cap, 24h bars, 7-day requests + error share, last use, and a row menu. Rows expand into
 * quota · 7 days · recent errors. Phones get row-cards that open the same detail in a bottom sheet.
 * Spend comes from the quota ledger (/api/bootstrap quotaState); request counts from /api/keys/activity,
 * which uses the admin usage reports' "current channels" scope.
 */
const route = useRoute()
const router = useRouter()
const { isMobile, isWide, width } = useBreakpoint()
const PAGE_SIZE = 50

/* one URL state for the whole page (avoids two debounced writers racing on the same query) */
const scope = useQueryState({ q: '', status: 'all', sort: '', page: '1' })

let lastActivity: KeysActivityPayload | null = null
const live = useLive<KeysSnapshot>(async (signal) => {
  const snapshot = await fetchKeysSnapshot(signal, lastActivity)
  if (snapshot.activity) lastActivity = snapshot.activity
  return snapshot
}, { intervalMs: 30_000 })

const keys = computed<ApiKeyItem[]>(() => live.data.value?.boot.keys ?? [])
const groups = computed(() => live.data.value?.boot.groups ?? [])
const activityState = computed(() => live.data.value?.activityState ?? 'loading')
const activityMap = computed(() => new Map<string, KeyActivity>((live.data.value?.activity?.keys ?? []).map((a) => [a.id, a])))
const activityOf = (id: string) => activityMap.value.get(id) ?? null
const activityShown = computed(() => Boolean(live.data.value?.activity))

/* relative times tick on a 30s grid so the table re-renders twice a minute, not every second */
const nowTick = useNow()
const now = computed(() => Math.floor(nowTick.value / 30_000) * 30_000)
const filterNow = computed(() => live.lastAt.value ?? Date.now())

const counts = computed(() => filterCounts(keys.value, filterNow.value))
const filter = computed<FilterKey>({
  get: () => ((Object.keys(FILTER_LABEL) as FilterKey[]).includes(scope.state.status as FilterKey) ? (scope.state.status as FilterKey) : 'all'),
  set: (value) => scope.patch({ status: value, page: '1' }),
})
const sort = computed<SortKey>(() => ((Object.keys(SORT_LABEL) as SortKey[]).includes(scope.state.sort as SortKey) ? (scope.state.sort as SortKey) : 'pressure'))
const sortModel = computed<string>({
  get: () => (sort.value === 'pressure' ? '' : sort.value),
  set: (value) => scope.patch({ sort: value, page: '1' }),
})
const query = computed<string>({
  get: () => scope.state.q,
  set: (value) => scope.patch({ q: value, page: '1' }),
})

const segItems = computed<SegmentItem[]>(() =>
  (Object.keys(FILTER_LABEL) as FilterKey[])
    .filter((f) => f === 'all' || f === 'enabled' || counts.value[f] > 0 || filter.value === f)
    .map((f) => ({ value: f, label: FILTER_LABEL[f], count: counts.value[f] })),
)
const sortOptions: SegmentItem[] = (Object.keys(SORT_LABEL) as SortKey[]).filter((k) => k !== 'pressure').map((k) => ({ value: k, label: SORT_LABEL[k] }))

const visible = computed(() =>
  sortKeys(
    keys.value.filter((k) => matchesFilter(k, filter.value, filterNow.value) && matchesQuery(k, scope.state.q, groups.value)),
    sort.value,
    activityMap.value,
  ),
)
const paged = computed(() => paginate(visible.value, Number(scope.state.page) || 1, PAGE_SIZE))
const pageModel = computed<number>({ get: () => paged.value.page, set: (value) => scope.patch({ page: String(value) }) })
const hasFilter = computed(() => filter.value !== 'all' || Boolean(scope.state.q.trim()))

/* the status counts live on the filter chips (no second copy in the page head) */
watch(() => counts.value.blocked + counts.value.near, (n) => setNavCount('keys', n), { immediate: true })
onBeforeUnmount(() => setNavCount('keys', null))

const tableState = computed(() => live.state.value)
const plateTitle = computed(() => (filter.value === 'all' ? '全部 Key' : FILTER_LABEL[filter.value]))
const emptyText = computed(() => {
  if (!keys.value.length) return '还没有 Key'
  if (filter.value !== 'all') return `没有「${FILTER_LABEL[filter.value]}」的 Key${scope.state.q.trim() ? `匹配「${scope.state.q.trim()}」` : ''}`
  return `没有匹配「${scope.state.q.trim()}」的 Key`
})
const emptyAction = computed(() => (keys.value.length ? '清除筛选' : '+ 新建 Key'))
function onEmptyAction() {
  if (keys.value.length) scope.patch({ q: '', status: 'all', page: '1' })
  else openCreate()
}
const activityMeta = computed(() => {
  if (activityState.value === 'unavailable') return '用量列暂不可用'
  if (activityState.value === 'error') return activityShown.value ? '用量列陈旧' : '用量列读取失败'
  return ''
})

/* ── row cells ── */
/** unknown or nothing spent → — (never a $0 headline); see fmtSpend */
const spend = (row: ApiKeyItem, w: 'daily' | 'weekly') => fmtSpend(row.quotaState?.[w]?.spentUsd ?? null)
const noSpend = (row: ApiKeyItem, w: 'daily' | 'weekly') => !row.quotaState?.[w]?.spentUsd
function limitText(row: ApiKeyItem, w: 'daily' | 'weekly'): string {
  const state = row.quotaState?.[w]
  return state && limited(state) ? `/${shortUsd(state.limitUsd)}` : ''
}
/** cumulative cap: `$1,912 / $3,000`; unlimited stays silent (the ledger does not tally an uncapped total) */
function totalText(row: ApiKeyItem): string {
  const t = row.quotaState?.total
  if (!t || !limited(t)) return ''
  const d = (v: number) => fmtUsd(v, { digits: v >= 1000 ? 0 : 2 })
  return `${d(t.spentUsd)} / ${d(t.limitUsd)}`
}
function lastUsed(row: ApiKeyItem): string {
  const ms = lastUsedMs(row)
  return ms === null ? '从未' : fmtAgo(ms, now.value)
}
/** a ring only for Keys that served a request in the last 2 minutes (and only 6 rings per screen, kit-capped) */
const isLive = (row: ApiKeyItem) => {
  const ms = lastUsedMs(row)
  return ms !== null && now.value - ms < 120_000 && keyStatus(row) === 'run'
}
const rowTone = (row: ApiKeyItem) => {
  const status = keyStatus(row)
  return status === 'blocked' ? 'attn' : status === 'off' ? 'off' : null
}

/* quota columns size to the data: a window nobody limits needs no meter slot, an all-unlimited 累计 no column */
const anyLimit = computed(() => ({
  daily: keys.value.some((k) => limited(k.quotaState?.daily)),
  weekly: keys.value.some((k) => limited(k.quotaState?.weekly)),
  total: keys.value.some((k) => limited(k.quotaState?.total)),
}))
const KEY_MIN = 248
/**
 * Columns drop by priority until the Key column keeps ≥248px: `/上限` suffix → 累计 → 24H → 最近 → hover
 * 调整额度 (still in the ⋯ menu). Everything dropped is in the expanded row, so nothing is lost.
 */
const layout = computed(() => {
  const pageX = width.value >= 1180 ? 32 : 24
  const avail = Math.min(width.value - 2 * pageX, 1680) - 28 - 40 /* plate padding + expand toggle */
  const flags = { lim: true, total: anyLimit.value.total, h24: true, last: true, quotaBtn: true }
  const widthOf = () => {
    const meter = flags.lim ? 228 : 180
    return 84 + (anyLimit.value.daily ? meter : 92) + (anyLimit.value.weekly ? meter : 100)
      + (flags.total ? 132 : 0) + (flags.h24 ? 88 : 0) + 112 + (flags.last ? 76 : 0) + (flags.quotaBtn ? 112 : 44)
  }
  for (const drop of ['lim', 'total', 'quotaBtn', 'h24', 'last'] as const) {
    if (avail - widthOf() >= KEY_MIN) break
    flags[drop] = false
  }
  return { ...flags, meter: flags.lim ? 228 : 180 }
})
const columns = computed<RowColumn<ApiKeyItem>[]>(() => {
  const l = layout.value
  const list: RowColumn<ApiKeyItem>[] = [
    { key: 'status', title: '状态', width: 84 },
    { key: 'key', title: 'Key' },
    { key: 'today', title: '今日', width: anyLimit.value.daily ? l.meter : 92 },
    { key: 'week', title: '本周', width: anyLimit.value.weekly ? l.meter : 100 },
  ]
  if (l.total) list.push({ key: 'total', title: '累计', width: 132, align: 'right' })
  if (l.h24) list.push({ key: 'h24', title: '24H', width: 88 })
  list.push({ key: 'd7', title: '7 天', width: 112, align: 'right' })
  if (l.last) list.push({ key: 'last', title: '最近', width: 76, align: 'right' })
  list.push({ key: 'ops', title: '', width: l.quotaBtn ? 112 : 44, align: 'right' })
  return list
})

/* ── expand (desktop) / detail sheet (phone) ── */
const expanded = ref<Array<string | number>>([])
const detailId = ref<string | null>(null)
const detailOpen = ref(false)
const detailItem = computed(() => keys.value.find((k) => k.id === detailId.value) ?? null)
function onRowClick(row: ApiKeyItem) {
  if (isMobile.value) {
    detailId.value = row.id
    detailOpen.value = true
    return
  }
  expanded.value = expanded.value.includes(row.id) ? expanded.value.filter((id) => id !== row.id) : [...expanded.value, row.id]
}
watch(isMobile, (mobile) => {
  if (!mobile) detailOpen.value = false
})

/* ── sheets ── */
const editorOpen = ref(false)
const editorMode = ref<'create' | 'edit'>('create')
const editorItem = shallowRef<ApiKeyItem | null>(null)
const quotaOpen = ref(false)
const quotaItem = computed(() => keys.value.find((k) => k.id === quotaId.value) ?? null)
const quotaId = ref<string | null>(null)
const reveal = ref({ open: false, name: '', value: '', mode: 'created' as 'created' | 'revealed', note: null as string | null })

function openCreate() {
  editorMode.value = 'create'
  editorItem.value = null
  editorOpen.value = true
}
function openEdit(row: ApiKeyItem) {
  editorMode.value = 'edit'
  editorItem.value = row
  editorOpen.value = true
}
function openQuota(row: ApiKeyItem) {
  quotaId.value = row.id
  quotaOpen.value = true
}

/* ?new=1 (palette 「新建 Key…」, dashboard links) opens the create sheet; closing it drops the flag */
watch(() => route.query.new, (flag) => {
  if (flag === '1' && !editorOpen.value) openCreate()
}, { immediate: true })
watch(editorOpen, (value) => {
  if (!value && route.query.new !== undefined) {
    const { new: _drop, ...rest } = route.query
    void router.replace({ query: rest })
  }
})

function onCreated(result: { name: string; key: string; quotaError: string | null }) {
  reveal.value = { open: true, name: result.name, value: result.key, mode: 'created', note: result.quotaError ? `额度没保存上 · ${result.quotaError} · 在「调整额度」里再设一次` : null }
  notify(`✓ 已创建 ${result.name}`)
  void live.refresh()
}
function onSaved(name: string) {
  notify(`✓ 已保存 ${name}`)
  void live.refresh()
}
function onRevealDone() {
  reveal.value = { open: false, name: '', value: '', mode: 'created', note: null }
}

async function doReveal(row: ApiKeyItem) {
  const ok = await confirmSheet({
    title: `显示 ${row.name} 的完整 Key？`,
    facts: [{ k: 'Key', v: `${row.name}  ${keyTail(row.maskedKey)}` }],
    consequence: '完整 Key 会明文显示在屏幕上 · 确认周围没人',
    confirmText: '显示',
  })
  if (!ok) return
  try {
    const value = await keysApi.reveal(row.id)
    reveal.value = { open: true, name: row.name, value, mode: 'revealed', note: null }
  } catch (error) {
    notify(`◆ 没能取到完整 Key · ${errorMessage(error) || '稍后重试'}`, { tone: 'bad' })
  }
}

async function doResetDaily(row: ApiKeyItem) {
  const d = row.quotaState?.daily
  const ok = await confirmSheet({
    title: `重置 ${row.name} 的今日用量？`,
    facts: [
      { k: 'Key', v: `${row.name}  ${keyTail(row.maskedKey)}` },
      { k: '今日已用', v: `${fmtUsd(d?.spentUsd ?? 0)} → $0.00` },
      ...(d && limited(d) ? [{ k: '日额度', v: fmtUsd(d.limitUsd) }] : []),
    ],
    consequence: '今日已用记为 $0 · 因日额度停用的 Key 会自动恢复 · 不可撤销',
    confirmText: '重置今日',
  })
  if (!ok) return
  try {
    await keysApi.resetQuota(row.id, 'daily')
    notify(`✓ 已重置今日用量 · ${row.name}`)
    void live.refresh()
  } catch (error) {
    notify(`◆ 重置失败 · ${errorMessage(error) || '稍后重试'}`, { tone: 'bad' })
  }
}

async function doToggle(row: ApiKeyItem) {
  if (row.blockedReason) {
    notify('◇ 超额停用的 Key 要先调高额度或重置用量', { tone: 'warn' })
    return
  }
  if (row.enabled) {
    const ok = await confirmSheet({
      title: `停用 ${row.name}？`,
      facts: [
        { k: 'Key', v: `${row.name}  ${keyTail(row.maskedKey)}` },
        { k: '最近调用', v: lastUsed(row) },
      ],
      consequence: '用它的客户端会立刻收到 401 · 随时可以再启用',
      confirmText: '停用',
      danger: true,
    })
    if (!ok) return
  }
  try {
    await keysApi.update(row.id, { enabled: !row.enabled })
    notify(row.enabled ? `✓ 已停用 ${row.name}` : `✓ 已启用 ${row.name}`)
    void live.refresh()
  } catch (error) {
    notify(`◆ ${row.enabled ? '停用' : '启用'}失败 · ${errorMessage(error) || '稍后重试'}`, { tone: 'bad' })
  }
}

async function doDelete(row: ApiKeyItem) {
  const ok = await confirmSheet({
    title: `删除 ${row.name}？`,
    facts: [
      { k: 'Key', v: `${row.name}  ${keyTail(row.maskedKey)}` },
      { k: '最近调用', v: lastUsed(row) },
      { k: '本周花费', v: fmtUsd(row.quotaState?.weekly?.spentUsd ?? null) },
    ],
    consequence: '正在用它的客户端会立刻收到 401 · 不可撤销',
    confirmText: '删除',
    danger: true,
  })
  if (!ok) return
  try {
    await keysApi.remove(row.id)
    notify(`✓ 已删除 ${row.name}`)
    expanded.value = expanded.value.filter((id) => id !== row.id)
    if (detailId.value === row.id) detailOpen.value = false
    void live.refresh()
  } catch (error) {
    notify(`◆ 删除失败 · ${errorMessage(error) || '稍后重试'}`, { tone: 'bad' })
  }
}

type Action = 'edit' | 'quota' | 'reveal' | 'reset-daily' | 'toggle' | 'delete'
function act(row: ApiKeyItem, action: Action) {
  if (action === 'edit') openEdit(row)
  else if (action === 'quota') openQuota(row)
  else if (action === 'reveal') void doReveal(row)
  else if (action === 'reset-daily') void doResetDaily(row)
  else if (action === 'toggle') void doToggle(row)
  else void doDelete(row)
}
/* phone: the detail sheet closes first so the next sheet / confirm owns the screen */
function actFromSheet(row: ApiKeyItem, action: Action) {
  detailOpen.value = false
  window.setTimeout(() => act(row, action), 300)
}

/* ⌘K: find a Key by name or tail */
usePaletteCommands(() =>
  keys.value.map((k) => ({
    id: `find:key:${k.id}`,
    title: `Key · ${k.name}`,
    section: 'FIND' as const,
    keywords: [k.name, keyTail(k.maskedKey), k.note].filter(Boolean),
    hint: keyTail(k.maskedKey),
    run: () => {
      scope.patch({ q: k.name, status: 'all', page: '1' })
      if (isMobile.value) {
        detailId.value = k.id
        detailOpen.value = true
      } else expanded.value = [k.id]
    },
  })),
)

const fmtRate = (a: KeyActivity | null) => {
  const r = errorRate(a)
  return r === null ? '' : fmtPct(r, r < 0.1 && r > 0 ? 1 : 0)
}
const meterAria = (label: string, row: ApiKeyItem) => `${row.name} ${label}`
const failing = (h: { requests: number[]; errors: number[] }) => failingBuckets(h.requests, h.errors)
/** 24h bars only when there was traffic: an all-zero strip is a bare baseline that says nothing */
const h24Busy = (row: ApiKeyItem) => (activityOf(row.id)?.h24.requests ?? []).some((n) => n > 0)

/** phone card line 3: 本周 · 累计 · 7 天 · 最近 — segments never split, a wrap only falls after a `·` */
function cardFacts(row: ApiKeyItem): Array<{ text: string; sig?: boolean }> {
  const out: Array<{ text: string; sig?: boolean }> = []
  const week = row.quotaState?.weekly
  const weekPct = limited(week) && limited(row.quotaState?.daily) ? ` ${fmtPct(windowRatio(week), 0)}` : ''
  if (!noSpend(row, 'weekly') || weekPct) out.push({ text: `本周 ${spend(row, 'weekly')}${weekPct}` })
  if (limited(row.quotaState?.total)) out.push({ text: `累计 ${fmtPct(windowRatio(row.quotaState?.total), 0)}`, sig: Boolean(row.quotaState?.total?.exceeded) })
  const a = activityOf(row.id)
  if (a) {
    out.push({ text: a.d7.requests ? `7 天 ${fmtInt(a.d7.requests)}` : '7 天无调用' })
    const r = errorRate(a)
    if (r !== null && r >= ERROR_ALERT) out.push({ text: `错误 ${fmtRate(a)}`, sig: true })
  }
  out.push({ text: lastUsed(row) })
  return out
}
</script>

<template>
  <div class="ui-page kx">
    <div class="kx-top">
    <PageHead title="Key">
      <template #live>
        <LiveMark :state="live.state.value" :last-at="live.lastAt.value" :interval-ms="30_000" @retry="live.refresh" />
      </template>
      <template #actions>
        <TxButton variant="primary" class="kx-new" @click="openCreate"><Icon name="plus" />{{ isMobile ? '新建' : '新建 Key' }}</TxButton>
      </template>
    </PageHead>

    <div class="kx-bar">
      <SearchField v-model="query" class="kx-bar__search" placeholder="名称 / 尾号 / 渠道 / 备注" label="搜索 Key" />
      <Segmented v-model="filter" class="kx-bar__seg" :items="segItems" label="按状态筛选" />
      <FilterField v-model="sortModel" class="kx-bar__sort" label="排序" :options="sortOptions" :all-label="SORT_LABEL.pressure" :searchable="false" />
    </div>
    </div>

    <Plate
      :title="plateTitle"
      flush
      :state="tableState"
      :error="live.error.value"
      :stale-at="live.lastAt.value"
      :rows="8"
      :cols="['92px', '1fr', '96px', '100px', '88px', '112px', '76px']"
      @retry="live.refresh"
    >
      <template #meta>
        <span class="kx-meta">
          <span v-if="activityMeta" class="kx-meta__warn"><span aria-hidden="true">◇</span> {{ activityMeta }} <button type="button" class="ui-link" @click="live.refresh">重试</button></span>
          <Tip v-if="live.data.value?.boot.degraded" :content="live.data.value?.boot.degradedReason" :disabled="!live.data.value?.boot.degradedReason">
            <span class="kx-meta__warn" tabindex="0"><span aria-hidden="true">◇</span> 渠道沿用上次结果</span>
          </Tip>
          <span v-if="hasFilter" class="kx-meta__n num">{{ fmtInt(visible.length) }} / {{ fmtInt(keys.length) }}</span>
        </span>
      </template>

      <RowTable
        v-model:expanded-keys="expanded"
        :columns="columns"
        :data="paged.rows"
        row-key="id"
        density="list"
        expandable
        :row-tone="rowTone"
        :empty-text="emptyText"
        :empty-action="emptyAction"
        caption="API Key 列表"
        @row-click="onRowClick"
        @empty-action="onEmptyAction"
      >
        <template #cell-status="{ row }">
          <!-- the default (启用) is a bare dot; only states that need attention spell out their word -->
          <StatusMark :state="STATUS_VIEW[keyStatus(row)].mark" :label="STATUS_VIEW[keyStatus(row)].word" :bare="keyStatus(row) === 'run'" :live="isLive(row)" />
        </template>

        <template #cell-key="{ row }">
          <span class="kx-id">
            <span class="kx-id__name" :title="row.name">{{ row.name }}</span>
            <span class="kx-id__tail">{{ keyTail(row.maskedKey) }}</span>
            <span class="kx-id__scope" :class="{ 'is-none': groupScope(row, groups).none }">
              {{ groupScope(row, groups).label }}<template v-if="row.totalConcurrency"> · 并发 {{ row.totalConcurrency }}</template>
            </span>
          </span>
        </template>

        <template #cell-today="{ row }">
          <span class="kx-win">
            <span class="kx-win__amt num" :class="{ 'is-zero': noSpend(row, 'daily') }">{{ spend(row, 'daily') }}</span>
            <template v-if="limited(row.quotaState?.daily)">
              <TickMeter :value="windowRatio(row.quotaState?.daily)" :width="56" :aria-label="meterAria('日额度', row)" />
              <span v-if="layout.lim" class="kx-win__lim num">{{ limitText(row, 'daily') }}</span>
            </template>
          </span>
        </template>

        <template #cell-week="{ row }">
          <span class="kx-win">
            <span class="kx-win__amt num" :class="{ 'is-zero': noSpend(row, 'weekly') }">{{ spend(row, 'weekly') }}</span>
            <template v-if="limited(row.quotaState?.weekly)">
              <TickMeter :value="windowRatio(row.quotaState?.weekly)" :width="56" :aria-label="meterAria('周额度', row)" />
              <span v-if="layout.lim" class="kx-win__lim num">{{ limitText(row, 'weekly') }}</span>
            </template>
          </span>
        </template>

        <template #cell-total="{ row }">
          <span class="num kx-total" :class="{ sig: row.quotaState?.total?.exceeded }">{{ totalText(row) }}</span>
        </template>

        <template #cell-h24="{ row }">
          <MicroBars
            v-if="h24Busy(row)"
            class="kx-bars"
            :buckets="activityOf(row.id)!.h24.requests"
            :errors="failing(activityOf(row.id)!.h24)"
            :w="71"
            :h="16"
            :gap="1"
            :label="`${row.name} 近 24 小时每小时请求`"
          />
          <span v-else class="kx-dim">—</span>
        </template>

        <template #cell-d7="{ row }">
          <span v-if="activityOf(row.id)" class="num kx-d7">
            <span :class="{ 'is-zero': !activityOf(row.id)!.d7.requests }">{{ fmtInt(activityOf(row.id)!.d7.requests) }}</span>
            <template v-if="fmtRate(activityOf(row.id))">
              <span class="kx-d7__sep" aria-hidden="true">·</span>
              <span class="kx-d7__err" :class="{ sig: (errorRate(activityOf(row.id)) ?? 0) >= ERROR_ALERT }" :title="`错误率 ${fmtRate(activityOf(row.id))}`">{{ fmtRate(activityOf(row.id)) }}</span>
            </template>
          </span>
          <span v-else class="kx-dim">—</span>
        </template>

        <template #cell-last="{ row }">
          <span class="num kx-last" :class="{ 'is-none': !row.lastUsedAt }">{{ lastUsed(row) }}</span>
        </template>

        <template #cell-ops="{ row }">
          <span class="kx-ops" @click.stop @keydown.enter.stop @keydown.space.stop>
            <TxButton
              v-if="layout.quotaBtn"
              variant="secondary"
              size="sm"
              class="kx-ops__quota"
              :class="{ 'is-shown': keyStatus(row) === 'blocked' || keyStatus(row) === 'near' }"
              :aria-label="`调整 ${row.name} 的额度`"
              @click="openQuota(row)"
            >调整额度</TxButton>
            <KeyRowMenu
              :name="row.name"
              :enabled="row.enabled"
              :blocked="Boolean(row.blockedReason)"
              :has-daily="limited(row.quotaState?.daily) && (row.quotaState?.daily?.spentUsd ?? 0) > 0"
              @action="act(row, $event)"
            />
          </span>
        </template>

        <template #expanded="{ row }">
          <KeyDetail
            :item="row"
            :activity="activityOf(row.id)"
            :activity-state="activityState"
            :groups="groups"
            :meter-width="isWide ? 150 : 100"
            @quota="openQuota(row)"
          />
        </template>

        <template #card="{ row }">
          <div class="kx-card">
            <div class="kx-card__l1">
              <StatusMark :state="STATUS_VIEW[keyStatus(row)].mark" :label="STATUS_VIEW[keyStatus(row)].word" :bare="keyStatus(row) === 'run'" :live="isLive(row)" />
              <span class="kx-card__name">{{ row.name }}</span>
              <span class="kx-card__tail mono">{{ keyTail(row.maskedKey) }}</span>
              <span v-if="!noSpend(row, 'daily')" class="kx-card__today num"><span class="kx-card__k">今日</span>{{ spend(row, 'daily') }}</span>
            </div>
            <div v-if="limited(row.quotaState?.daily) || limited(row.quotaState?.weekly)" class="kx-card__l2">
              <template v-if="limited(row.quotaState?.daily)">
                <span class="kx-card__k">日</span>
                <TickMeter fluid :value="windowRatio(row.quotaState?.daily)" :aria-label="meterAria('日额度', row)" />
                <span class="kx-card__lim num">{{ limitText(row, 'daily') }}</span>
              </template>
              <template v-else>
                <span class="kx-card__k">周</span>
                <TickMeter fluid :value="windowRatio(row.quotaState?.weekly)" :aria-label="meterAria('周额度', row)" />
                <span class="kx-card__lim num">{{ limitText(row, 'weekly') }}</span>
              </template>
            </div>
            <p class="kx-card__l3 num">
              <template v-for="(seg, i) in cardFacts(row)" :key="i"><span class="kx-card__seg" :class="{ sig: seg.sig }">{{ seg.text }}<template v-if="i < cardFacts(row).length - 1">&nbsp;·</template></span>{{ ' ' }}</template>
            </p>
          </div>
        </template>
      </RowTable>
      <Pager v-if="paged.totalPages > 1" v-model:page="pageModel" class="kx-pager" :total="paged.total" :page-size="PAGE_SIZE" />
    </Plate>

    <Sheet v-model="detailOpen" :title="detailItem?.name ?? 'Key'" side="bottom" height="92vh">
      <template v-if="detailItem">
        <p class="kx-sheet__id">
          <StatusMark :state="STATUS_VIEW[keyStatus(detailItem)].mark" :label="STATUS_VIEW[keyStatus(detailItem)].word" />
          <span class="mono">{{ keyTail(detailItem.maskedKey) }}</span>
          <span class="dim num">最近 {{ lastUsed(detailItem) }}</span>
        </p>
        <div v-if="h24Busy(detailItem)" class="kx-sheet__h24">
          <span class="kx-card__k">24h</span>
          <MicroBars :buckets="activityOf(detailItem.id)!.h24.requests" :errors="failing(activityOf(detailItem.id)!.h24)" :w="143" :h="20" :gap="1" :label="`${detailItem.name} 近 24 小时每小时请求`" />
        </div>
        <KeyDetail :item="detailItem" :activity="activityOf(detailItem.id)" :activity-state="activityState" :groups="groups" compact />
      </template>
      <template v-if="detailItem" #footer>
        <div class="kx-sheet__acts">
          <TxButton variant="secondary" block @click="actFromSheet(detailItem, 'quota')">调整额度</TxButton>
          <TxButton variant="secondary" block @click="actFromSheet(detailItem, 'edit')">编辑</TxButton>
          <TxButton variant="secondary" block @click="actFromSheet(detailItem, 'reveal')">显示完整 Key</TxButton>
          <TxButton v-if="limited(detailItem.quotaState?.daily) && (detailItem.quotaState?.daily?.spentUsd ?? 0) > 0" variant="secondary" block @click="actFromSheet(detailItem, 'reset-daily')">重置今日额度</TxButton>
          <TxButton v-if="detailItem.blockedReason" variant="secondary" block disabled>启用 · 先调额度</TxButton>
          <TxButton v-else :variant="detailItem.enabled ? 'danger' : 'secondary'" block @click="actFromSheet(detailItem, 'toggle')">{{ detailItem.enabled ? '停用' : '启用' }}</TxButton>
          <TxButton variant="danger" block @click="actFromSheet(detailItem, 'delete')">删除</TxButton>
        </div>
      </template>
    </Sheet>

    <KeyEditorSheet
      v-model="editorOpen"
      :mode="editorMode"
      :item="editorItem"
      :groups="groups"
      :keys="keys"
      :gateway-model-access="live.data.value?.boot.gatewayModelAccess ?? 'unknown'"
      @created="onCreated"
      @saved="onSaved"
    />
    <KeyQuotaSheet v-model="quotaOpen" :item="quotaItem" @changed="live.refresh" />
    <KeyRevealSheet v-model="reveal.open" :name="reveal.name" :value="reveal.value" :mode="reveal.mode" :note="reveal.note" @done="onRevealDone" />
  </div>
</template>

<style>
html:root .tx-button.kx-new { flex: none; }

.kx-top { display: grid; gap: 4px; min-width: 0; }
.kx-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; min-width: 0; }
.kx-bar__search { width: 240px; }
.kx-bar__seg { min-width: 0; max-width: 100%; }
.kx-bar__sort { margin-left: auto; }

.kx-meta { display: inline-flex; flex-wrap: wrap; justify-content: flex-end; align-items: center; gap: 2px 12px; font-size: var(--fs-xs); color: var(--ink-3); }
.kx-meta__warn { color: var(--ink-2); }
.kx-meta__n { color: var(--ink-2); }

/* one-line identity: name (ink) · masked tail (ink-3 mono) · scope (ink-3, truncates first) */
.kx-id { display: flex; align-items: baseline; gap: 10px; min-width: 0; }
.kx-id__name { flex: 0 1 auto; max-width: 55%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--font-mono); font-size: var(--fs-base); color: var(--ink); }
.kx-id__tail { flex: none; font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--ink-3); }
.kx-id__scope { flex: 1 1 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--fs-xs); color: var(--ink-3); }
.kx-id__scope.is-none { font-style: normal; }

.kx-win { display: inline-flex; align-items: center; gap: 8px; min-width: 0; }
.kx-win__amt { flex: none; width: 64px; text-align: right; font-size: var(--fs-sm); color: var(--ink); }
.kx-win__lim { font-size: var(--fs-xs); color: var(--ink-3); white-space: nowrap; }
.kx .is-zero { color: var(--ink-3); }
.kx-total { font-size: var(--fs-sm); color: var(--ink); }
.kx-total.is-none, .kx-last.is-none, .kx-dim { color: var(--ink-3); font-size: var(--fs-xs); }
.kx-last { font-size: var(--fs-xs); color: var(--ink-2); }
.kx-bars { display: block; }
.kx-d7 { display: inline-flex; align-items: baseline; justify-content: flex-end; gap: 5px; font-size: var(--fs-sm); color: var(--ink); }
.kx-d7__sep { color: var(--ink-4); }
.kx-d7__err { font-size: var(--fs-xs); color: var(--ink-3); }
.kx-d7__err.sig { color: var(--signal-ink); }

.kx-ops { display: inline-flex; align-items: center; justify-content: flex-end; gap: 4px; }
/* 调整额度 shows on row hover / focus (always on near / blocked rows); html:root beats tx/button.css's transition */
html:root .tx-button.kx-ops__quota { opacity: 0; transition: opacity var(--dur-2) var(--ease-swift), background-color var(--dur-2) var(--ease-swift); }
html:root .tx-button.kx-ops__quota.is-shown,
html:root .tx-data-table__row:hover .tx-button.kx-ops__quota,
html:root .tx-data-table__row:focus-within .tx-button.kx-ops__quota,
html:root .tx-button.kx-ops__quota:focus-visible { opacity: 1; }
@media (hover: none) { html:root .tx-button.kx-ops__quota { opacity: 1; } }

/* expanded band */
.kx .tx-data-table__row--detail > .tx-data-table__cell--detail { padding: 14px 16px 12px; }
.kx .tx-data-table__row.is-expanded > .tx-data-table__cell { background: var(--paper-2); }

/* phone row-card */
.kx-card { display: grid; gap: 6px; min-width: 0; }
.kx-card__l1 { display: flex; align-items: center; gap: 8px; min-width: 0; font-size: var(--fs-row); }
.kx-card__name { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--font-mono); font-weight: 500; color: var(--ink); }
.kx-card__tail { flex: 1 1 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--fs-xs); color: var(--ink-3); }
.kx-card__today { flex: none; display: inline-flex; align-items: baseline; gap: 6px; font-size: var(--fs-row); color: var(--ink); }
.kx-card__k { font-family: var(--font-sans); font-size: var(--fs-xs); color: var(--ink-3); }
.kx-card__l2 { display: flex; align-items: center; gap: 8px; min-width: 0; }
.kx-card__l2 .ui-tm { flex: 1 1 auto; }
.kx-card__lim { flex: none; font-size: var(--fs-xs); color: var(--ink-3); }
.kx-card__l3 { margin: 0; font-size: var(--fs-xs); line-height: 1.6; color: var(--ink-2); }
.kx-card__seg { white-space: nowrap; }

/* phone detail sheet */
.kx-sheet__id { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; margin: 0 0 12px; font-size: var(--fs-sm); color: var(--ink-2); }
.kx-sheet__h24 { display: flex; align-items: center; gap: 10px; margin: 0 0 12px; }
.kx-sheet__acts { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; width: 100%; }
.kx-pager { padding: 10px 0 12px; }

@media (max-width: 599px) {
  /* the ticker carries the clock */
  .kx .ui-livemark { display: none; }
}
@media (max-width: 959px) {
  .kx-bar__search { width: 100%; }
  .kx-bar__seg { flex: 1 1 100%; }
  .kx-bar__sort { margin-left: 0; }
}
</style>
