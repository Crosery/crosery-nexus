<script setup lang="ts">
/**
 * /models (DESIGN §6.6): what is serving traffic, at what price, and did the catalog sync succeed.
 * Default view = models with an enabled mapping, busiest 7 days first. One row per canonical model (vendor
 * prefixes and catalog twins fold into `+N 别名`). No sync button here: the head shows the last catalog run and
 * links to 设置 · 同步中心. The index is read without `fresh=1`; one 60s loop reads index, usage, evidence, sync.
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import PageHead from '../../ui/shell/PageHead.vue'
import LiveMark from '../../ui/shell/LiveMark.vue'
import Plate from '../../ui/data/Plate.vue'
import RowTable from '../../ui/data/RowTable.vue'
import StatusMark from '../../ui/data/StatusMark.vue'
import ProviderMark from '../../ui/data/ProviderMark.vue'
import Pager from '../../ui/data/Pager.vue'
import Segmented from '../../ui/form/Segmented.vue'
import FilterField from '../../ui/form/FilterField.vue'
import SearchField from '../../ui/form/SearchField.vue'
import Tip from '../../ui/form/Tip.vue'
import { TxButton } from '@talex-touch/tuffex/button'
import { TxCheckbox } from '@talex-touch/tuffex/checkbox'
import { TxTag } from '@talex-touch/tuffex/tag'
import { useLive } from '../../ui/composables/useLive'
import { useBreakpoint } from '../../ui/composables/useBreakpoint'
import { fmtCompact, fmtInt, fmtPct, fmtTime } from '../../ui/fmt'
import { errorReason, errorStatus } from '../../lib/errors'
import { paginate, resettingField, useQueryState } from '../../lib/listState'
import { whenIdle } from '../../lib/resource'
import { ApiError, request } from '../../api/http'
import { api } from '../../api'
import { notify } from '../../ui/feedback/toast'
import { confirmSheet } from '../../ui/feedback/confirmSheet'
import { setNavCount } from '../../shell/badges'
import { isModelKind, kindChips, kindTag, MODEL_KIND_LABEL } from '../../lib/modelKind'
import { usePaletteCommands } from '../../shell/palette'
import ModelSheet from './ModelSheet.vue'
import {
  MODEL_SORT_DIR, MODEL_SORT_KEYS, batchTargets, buildModelRows, catalogSyncFacts, fmtUnitPrice, fmtWindow, legacyModelsQuery,
  rowInView, rowMatches, sortModelRows, viewCounts, type ModelInsights, type ModelRow, type ModelSortKey, type ModelView,
} from './modelRows'
import type { ModelIndexData, SyncStatus, UsageOverviewData } from '../../types'
import type { CommandItem, RowColumn, SegmentItem, SortState } from '../../ui/types'

const PAGE_SIZE = 50
const WINDOW_DAYS = 7
/** 状态列的两个「正常」词（sweep1 #6）：可用有成功证据，启用只说明映射开着；已移除渠道的历史不算证据。 */
const STATUS_LEGEND = [
  `可用：近 ${WINDOW_DAYS} 天在当前渠道至少有一次成功调用`,
  `启用：渠道映射开着，但近 ${WINDOW_DAYS} 天当前渠道没有成功调用（没调用过、只走过已移除的渠道，或只有探测结果）`,
  `注意 / 不可用：近 ${WINDOW_DAYS} 天当前渠道的成功率偏低 / 全部失败`,
]

type Bundle = {
  index: ModelIndexData
  usage: UsageOverviewData | null
  usageFailed: boolean
  insights: ModelInsights | null
  /** the running server predates /api/models/insights (404): stop asking until the page reloads */
  insightsMissing: boolean
  sync: SyncStatus | null
}

let insightsMissing = false
const live = useLive<Bundle>(
  async (signal) => {
    const [index, usage, insights, sync] = await Promise.allSettled([
      request<ModelIndexData>('/api/model-index', { signal }),
      request<UsageOverviewData>(`/api/usage-overview?days=${WINDOW_DAYS}`, { signal }),
      insightsMissing ? Promise.resolve(null) : request<ModelInsights>(`/api/models/insights?days=${WINDOW_DAYS}`, { signal }),
      request<SyncStatus>('/api/sync/status', { signal }),
    ])
    if (index.status === 'rejected') throw index.reason
    if (!Array.isArray(index.value?.models)) throw new ApiError(502, '模型目录返回内容不完整')
    if (insights.status === 'rejected' && errorStatus(insights.reason) === 404) insightsMissing = true
    const usageOk = usage.status === 'fulfilled' && Array.isArray(usage.value?.models)
    const insightsOk = insights.status === 'fulfilled' && Array.isArray(insights.value?.specs)
    return {
      index: { ...index.value, channels: Array.isArray(index.value.channels) ? index.value.channels : [] },
      usage: usageOk ? (usage as PromiseFulfilledResult<UsageOverviewData>).value : null,
      usageFailed: !usageOk,
      insights: insightsOk ? (insights as PromiseFulfilledResult<ModelInsights>).value : null,
      insightsMissing,
      sync: sync.status === 'fulfilled' ? sync.value : null,
    }
  },
  { intervalMs: 60_000, isEmpty: (data) => data.index.models.length === 0 },
)

// an old bookmark (filter= / channel= / sort=usage&dir= / days= / keyId=) lands on its equivalent, not on 在用 with a URL
// that still looks filtered
const route = useRoute()
const router = useRouter()
const legacy = legacyModelsQuery(route.query, PAGE_SIZE)
if (legacy) void router.replace({ query: legacy, hash: route.hash })

const scope = useQueryState({ view: 'inuse', type: '', q: '', vendor: '', sort: 'tokens:desc', page: '1', model: '' })
/* user edits of view / type / search / vendor go back to page 1; a URL restore (Back) keeps the page it carries */
const viewModel = resettingField(scope, 'view', { page: '1' })
const typeModel = resettingField(scope, 'type', { page: '1' })
const qModel = resettingField(scope, 'q', { page: '1' })
const vendorModel = resettingField(scope, 'vendor', { page: '1' })
const { width } = useBreakpoint()

const rows = computed<ModelRow[]>(() => {
  const data = live.data.value
  if (!data) return []
  return buildModelRows({
    models: data.index.models,
    channelNames: data.index.channels.map((channel) => channel.name),
    usage: data.usage,
    insights: data.insights,
  })
})
const insightsReady = computed(() => Boolean(live.data.value?.insights))

/* ── filters: search + vendor + type first, then the view; each control's counts follow the other filters ── */
const view = computed<ModelView>(() => (['inuse', 'attn', 'multi', 'unpriced', 'off', 'all'].includes(scope.state.view) ? scope.state.view as ModelView : 'inuse'))
const kind = computed(() => (isModelKind(scope.state.type) ? scope.state.type : ''))
const searched = computed(() => rows.value.filter((row) => rowMatches(row, scope.state.q) && (!scope.state.vendor || row.vendor === scope.state.vendor)))
const narrowed = computed(() => (kind.value ? searched.value.filter((row) => row.kind === kind.value) : searched.value))
const counts = computed(() => viewCounts(narrowed.value))
/* 类型 chips: the kinds this view has (typing a search or picking a vendor does not reshuffle them), each counted
   under view + vendor + search */
const typeChips = computed(() => kindChips(
  rows.value.filter((row) => rowInView(row, view.value)).map((row) => row.kind),
  live.data.value ? searched.value.filter((row) => rowInView(row, view.value)).map((row) => row.kind) : null,
  kind.value,
))
/* no index yet (loading / error) → no counts: an unread catalog is not "0 models" */
const segments = computed<SegmentItem[]>(() => {
  const c = live.data.value ? counts.value : null
  return [
    { value: 'inuse', label: '在用', count: c?.inuse },
    ...(c?.attn || view.value === 'attn' ? [{ value: 'attn', label: '异常', count: c?.attn }] : []),
    { value: 'multi', label: '多渠道', count: c?.multi },
    { value: 'unpriced', label: '未定价', count: c?.unpriced },
    { value: 'off', label: '已停用', count: c?.off },
    { value: 'all', label: '全部', count: c?.all },
  ]
})
const vendorOptions = computed<SegmentItem[]>(() => {
  const tally = new Map<string, { label: string; n: number }>()
  for (const row of rows.value) {
    if (!rowInView(row, view.value) || !rowMatches(row, scope.state.q) || (kind.value && row.kind !== kind.value)) continue
    const entry = tally.get(row.vendor) ?? { label: row.vendorLabel, n: 0 }
    entry.n += 1
    tally.set(row.vendor, entry)
  }
  return [...tally].sort((a, b) => b[1].n - a[1].n || a[1].label.localeCompare(b[1].label)).map(([value, { label, n }]) => ({ value, label, count: n }))
})

/* ── sort: one URL key `sort=tokens:desc`; header clicks and the 排序 field both write it ── */
const SORT_LABEL: Record<ModelSortKey, string> = { tokens: '7 天 Token', id: '名称', input: '输入价', output: '输出价', context: '上下文', success: '成功率', channels: '渠道数' }
const sortOptions: SegmentItem[] = MODEL_SORT_KEYS.map((key) => ({ value: key, label: SORT_LABEL[key] }))
const sort = computed<{ key: ModelSortKey; dir: 'asc' | 'desc' }>(() => {
  const [key, dir] = scope.state.sort.split(':')
  const valid = (MODEL_SORT_KEYS as string[]).includes(key) ? (key as ModelSortKey) : 'tokens'
  return { key: valid, dir: dir === 'asc' || dir === 'desc' ? dir : MODEL_SORT_DIR[valid] }
})
const sortField = computed({
  get: () => sort.value.key,
  set: (key: string) => scope.patch({ sort: `${key}:${MODEL_SORT_DIR[key as ModelSortKey] ?? 'desc'}`, page: '1' }),
})
const COLUMN_SORT: Record<string, ModelSortKey> = { id: 'id', price: 'input', context: 'context', channels: 'channels', tokens: 'tokens', success: 'success' }
const tableSort = computed<SortState>(() => {
  const column = sort.value.key === 'output' ? 'price' : Object.keys(COLUMN_SORT).find((col) => COLUMN_SORT[col] === sort.value.key) ?? 'tokens'
  return { key: column, order: sort.value.dir }
})
function onSort(next: SortState | null) {
  if (!next || !next.order || !COLUMN_SORT[next.key]) scope.patch({ sort: 'tokens:desc', page: '1' })
  else scope.patch({ sort: `${COLUMN_SORT[next.key]}:${next.order}`, page: '1' })
}

const visible = computed(() => sortModelRows(narrowed.value.filter((row) => rowInView(row, view.value)), sort.value.key, sort.value.dir))
const paged = computed(() => paginate(visible.value, Number(scope.state.page) || 1, PAGE_SIZE))
const page = computed({ get: () => paged.value.page, set: (value: number) => { scope.state.page = String(value) } })
const maxTokens = computed(() => Math.max(0, ...visible.value.map((row) => row.tokens ?? 0)))
/** a share under 5% draws no bar and no track (the number says it), so small rows are not a column of stray ticks */
const share = (row: ModelRow) => (row.tokens && maxTokens.value ? row.tokens / maxTokens.value : 0)
const hasBar = (row: ModelRow) => share(row) >= 0.05

/* ── columns: evidence column only when there is room (≥1180) ── */
const columns = computed<RowColumn<ModelRow>[]>(() => {
  const wide = width.value >= 1180
  return [
    ...(batchMode.value ? [{ key: 'pick', title: '选', width: 44, align: 'center' } as RowColumn<ModelRow>] : []),
    { key: 'status', title: '状态', width: wide ? 96 : 80 },
    { key: 'id', title: '模型', minWidth: 220, sortable: true },
    { key: 'price', title: '输入 / 输出 $/M', width: wide ? 148 : 136, align: 'right', sortable: true },
    { key: 'context', title: '上下文 / 输出', width: wide ? 112 : 104, align: 'right', sortable: true },
    { key: 'reasoning', title: '思考', width: 52, align: 'center' },
    { key: 'channels', title: '渠道', width: 60, align: 'right', sortable: true },
    { key: 'tokens', title: `${WINDOW_DAYS} 天 Token`, width: wide ? 150 : 128, align: 'right', sortable: true },
    { key: 'success', title: '成功率', width: 76, align: 'right', sortable: true },
    ...(wide && insightsReady.value ? [{ key: 'note', title: '证据', width: 196 } as RowColumn<ModelRow>] : []),
  ]
})
const rowTone = (row: ModelRow) => (row.bad ? 'attn' : !row.inUse ? 'off' : null)

const priceText = (row: ModelRow) => {
  const p = row.price
  if (p.kind === 'none') return '未定价'
  const body = p.free ? '免费' : `${fmtUnitPrice(p.input)} / ${fmtUnitPrice(p.output)}`
  return p.kind === 'reference' ? `≈ ${body}` : body
}
const priceTitle = (row: ModelRow) => {
  const p = row.price
  if (p.kind === 'billing') return p.source ? `计费价 · 与 ${p.source} 一致` : '计费价 · 价表'
  if (p.kind === 'reference') return `未定价 · ${p.source} 参考价 · 请求不计花费`
  return '没有任何来源的价格 · 请求不计花费'
}
const specText = (row: ModelRow) => {
  if (!insightsReady.value || !row.spec) return '—'
  const ctx = fmtWindow(row.spec.contextWindow)
  const out = fmtWindow(row.spec.maxOutput)
  return out === '—' ? ctx : `${ctx} / ${out}`
}
const reasoningMark = (row: ModelRow) => (!insightsReady.value || !row.spec || row.spec.reasoning === null ? '—' : row.spec.reasoning ? '✓' : '否')
const successText = (row: ModelRow) => (row.successRate === null ? '—' : fmtPct(row.successRate, row.successRate === 1 ? 0 : 1))

/* ── head: the catalog sync facts are the page's status line (the counts live on the view chips right below);
   no sync button on this page ── */
const discovery = computed(() => catalogSyncFacts(live.data.value?.sync?.jobs.find((job) => job.id === 'model-discovery'), (at) => fmtTime(at)))
const priceSources = computed(() => {
  const status = live.data.value?.index.sourceStatus?.sources
  if (!status) return null
  const list = Object.values(status)
  if (!list.length) return null
  const ok = list.filter((s) => s?.ok !== false).length
  return ok < list.length ? { ok, total: list.length } : null
})
/** a healthy run keeps its summary in the hover title; a failing one shows the reason */
const discoveryDetailShown = computed(() => (discovery.value?.detail && discovery.value.state !== 'run' && discovery.value.state !== 'busy' ? discovery.value.detail : null))
/** the evidence column: a routine `渠道 探测 hh:mm ✓` repeats on almost every 启用 row — it stays in the row title */
const evidenceText = (row: ModelRow) => (row.status === 'run' && row.statusLabel === '启用' ? '' : row.note)

const asOf = computed(() => (live.lastAt.value ? fmtTime(live.lastAt.value) : null))
const plateNotes = computed(() => {
  const data = live.data.value
  const notes: string[] = []
  if (data?.usageFailed) notes.push('用量读取失败')
  if (data && !data.insights) notes.push('成功率与规格暂不可用')
  else if (data?.insights?.usage === null) notes.push('成功率暂不可用')
  return notes
})
const mappingCount = computed(() => rows.value.reduce((sum, row) => sum + row.mappings.length, 0))

/* ── empty copy: say which filter emptied the list and offer the way back ── */
const emptyText = computed(() => {
  if (scope.state.q.trim()) return `没有匹配「${scope.state.q.trim()}」的模型`
  if (kind.value) return `这个范围里没有${MODEL_KIND_LABEL[kind.value]}模型`
  if (view.value === 'inuse') return '没有启用的模型'
  if (view.value === 'attn') return '没有异常的模型'
  if (view.value === 'unpriced') return '在用模型都有计费价'
  if (view.value === 'multi') return '没有多渠道提供的模型'
  if (view.value === 'off') return '没有已停用的模型'
  return '没有模型'
})
const emptyAction = computed(() => (scope.state.q.trim() || scope.state.vendor || kind.value ? '清除筛选' : view.value !== 'all' ? '看全部' : undefined))
function onEmptyAction() {
  if (scope.state.q.trim() || scope.state.vendor || kind.value) scope.patch({ q: '', vendor: '', type: '', page: '1' })
  else scope.patch({ view: 'all', page: '1' })
}

/* ── sheet: `?model=<canonical>` so ⌘K and links can open it ── */
const sheetOpen = computed({
  get: () => Boolean(scope.state.model) && Boolean(selected.value),
  set: (value: boolean) => { if (!value) scope.state.model = '' },
})
const selected = computed(() => (scope.state.model ? rows.value.find((row) => row.key === scope.state.model) ?? null : null))
const lastSelected = ref<ModelRow | null>(null)
watch(selected, (row) => { if (row) lastSelected.value = row })
function openRow(row: ModelRow) {
  scope.state.model = row.key
}
const probes = computed(() => new Map((live.data.value?.insights?.probes ?? []).map((probe) => [probe.channel, probe])))
async function reload() {
  await live.refresh()
  // a background poll that superseded this read is still in flight: the caller's lock holds until it lands
  await whenIdle(live.loading)
}

/* ── batch: switch every mapping of the picked models, one PATCH each, confirmed first, failures listed ── */
const batchMode = ref(false)
const picked = ref(new Set<string>())
const batchRunning = ref(false)
const batchDone = ref(0)
const batchTotal = ref(0)
/** only picked rows the current filter still shows are written: nothing hidden is switched */
const pickedRows = computed(() => visible.value.filter((row) => picked.value.has(row.key)))
watch(() => [scope.state.view, scope.state.type, scope.state.q, scope.state.vendor], () => { if (!batchRunning.value) picked.value = new Set() })
function togglePick(key: string) {
  const next = new Set(picked.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  picked.value = next
}
function pickPage() {
  picked.value = new Set([...picked.value, ...paged.value.rows.map((row) => row.key)])
}
function toggleBatch() {
  if (batchRunning.value) return
  batchMode.value = !batchMode.value
  picked.value = new Set()
}
async function applyBatch(next: boolean) {
  if (batchRunning.value) return
  const chosen = pickedRows.value
  const targets = batchTargets(chosen, next)
  const verb = next ? '启用' : '停用'
  if (!targets.length) {
    notify(`— 选中的模型没有需要${verb}的渠道映射`, { tone: 'note' })
    return
  }
  const sample = targets.slice(0, 3).map((m) => `${m.model}@${m.channel}`).join('、')
  const ok = await confirmSheet({
    title: `批量${verb} ${targets.length} 条渠道映射？`,
    facts: [
      { k: '模型', v: `${fmtInt(chosen.length)} 个` },
      { k: '映射', v: `${fmtInt(targets.length)} 条 · ${sample}${targets.length > 3 ? ' …' : ''}` },
    ],
    consequence: next ? '逐条执行 · 失败的会逐条列出' : '经这些映射的调用会失败 · 逐条执行 · 失败的会逐条列出',
    confirmText: `批量${verb}`,
    danger: !next,
  })
  if (!ok) return
  batchRunning.value = true
  batchDone.value = 0
  batchTotal.value = targets.length
  const failed: string[] = []
  try {
    for (const m of targets) {
      try {
        await api.setModelSourceEnabled(m.model, m.channel, m.kind, next)
      } catch (error) {
        failed.push(`${m.model}@${m.channel}：${errorReason(error)}`)
      }
      batchDone.value += 1
    }
  } finally {
    await live.refresh().catch(() => undefined)
    batchRunning.value = false
  }
  const done = targets.length - failed.length
  if (failed.length) {
    notify(`◆ 批量${verb}完成 ${done}/${targets.length} · 失败 ${failed.length} 条`, { tone: 'bad', description: `${failed.slice(0, 3).join('；')}${failed.length > 3 ? ' …' : ''}` })
  } else {
    notify(`✓ 已批量${verb} ${targets.length} 条渠道映射`, { tone: 'ok' })
  }
  picked.value = new Set()
}

/* ── shell hooks: attention count on the rail, FIND commands from the loaded index ── */
watch(() => rows.value.filter((row) => row.bad).length, (n) => setNavCount('models', n), { immediate: true })
onBeforeUnmount(() => setNavCount('models', null))
usePaletteCommands(() => [
  {
    id: 'act:models:batch',
    title: '批量启用 / 停用模型映射…',
    section: 'ACT',
    keywords: ['batch', 'bulk', '批量', '映射'],
    run: () => { if (!batchMode.value) toggleBatch() },
  } satisfies CommandItem,
  ...rows.value.filter((row) => row.inUse).slice(0, 400).map((row) => ({
    id: `find:model:${row.key}`,
    title: row.id,
    section: 'FIND' as const,
    keywords: ['model', '模型', row.key, ...row.aliases],
    hint: row.statusLabel,
    run: () => openRow(row),
  })),
])
</script>

<template>
  <div class="ui-page mp">
    <PageHead title="模型">
      <template #status>
        <span v-if="discovery || priceSources" class="mp-sync">
          <template v-if="discovery">
            <span :title="discovery.detail || undefined"><StatusMark :state="discovery.state" :label="discovery.text" /></span>
            <span v-if="discoveryDetailShown" class="mp-sync__sum" :title="discoveryDetailShown">{{ discoveryDetailShown }}</span>
            <span v-if="discovery.next" class="mp-sync__k">下次 <span class="num">{{ discovery.next }}</span></span>
          </template>
          <span v-if="priceSources" class="mp-sync__k is-warn">价格源 <span class="num">{{ priceSources.ok }}/{{ priceSources.total }}</span></span>
          <RouterLink class="ui-link mp-sync__go" to="/settings#sync">同步中心 →</RouterLink>
        </span>
      </template>
      <template #live>
        <span class="mp-live" :class="{ 'is-quiet': live.state.value === 'ready' }">
          <LiveMark :state="live.state.value" :last-at="live.lastAt.value" :interval-ms="live.intervalMs" @retry="live.refresh" />
        </span>
      </template>
    </PageHead>

    <div class="ui-toolbar mp-tools">
      <Segmented v-model="viewModel" :items="segments" label="模型范围" />
      <Segmented v-if="typeChips" v-model="typeModel" :items="typeChips" label="模型类型" />
      <!-- one unit: when the chips need the row, 厂商 / 排序 / 搜索 move down together instead of stranding the search -->
      <span class="mp-tools__pick">
        <FilterField v-model="vendorModel" label="厂商" :options="vendorOptions" />
        <FilterField v-model="sortField" class="mp-sort" label="排序" :options="sortOptions" :all-label="null" :searchable="false" />
        <SearchField v-model="qModel" class="mp-search" placeholder="模型 ID / 别名 / 渠道" label="搜索模型" />
      </span>
    </div>

    <Plate
      title="模型目录"
      flush
      :state="live.state.value"
      :error="live.error.value"
      :stale-at="live.lastAt.value"
      :rows="12"
      :cols="['92px', '1fr', '148px', '112px', '52px', '60px', '150px', '76px']"
      empty-text="网关和价格源里都没有模型"
      @retry="live.refresh"
    >
      <template #meta>
        <span v-if="live.data.value" class="mp-meta">
          <span>近 {{ WINDOW_DAYS }} 天用量<span v-if="asOf" class="mp-meta__asof"> · 截至 <span class="num">{{ asOf }}</span></span></span>
          <span class="mp-meta__maps"><span class="num">{{ fmtInt(mappingCount) }}</span> 条渠道映射</span>
          <span v-for="note in plateNotes" :key="note" class="mp-meta__warn">◇ {{ note }}</span>
          <Tip>
            <button type="button" class="ui-link mp-legend">状态说明<span class="sr-only">：{{ STATUS_LEGEND.join('；') }}</span></button>
            <template #content><span v-for="line in STATUS_LEGEND" :key="line" class="mp-legend__ln">{{ line }}</span></template>
          </Tip>
        </span>
      </template>
      <template #actions>
        <TxButton size="sm" variant="ghost" :aria-pressed="batchMode" :disabled="batchRunning" @click="toggleBatch">{{ batchMode ? '退出批量' : '批量' }}</TxButton>
      </template>

      <div v-if="batchMode" class="mp-batch" role="region" aria-label="批量操作">
        <span class="num">已选 {{ fmtInt(pickedRows.length) }} 个模型</span>
        <button type="button" class="ui-link" :disabled="batchRunning || !paged.rows.length" @click="pickPage">选中本页</button>
        <button type="button" class="ui-link" :disabled="batchRunning || !picked.size" @click="picked = new Set()">清除</button>
        <span class="mp-batch__act">
          <span v-if="batchRunning" class="num mp-batch__run" aria-live="polite">执行中 {{ batchDone }}/{{ batchTotal }}</span>
          <TxButton size="sm" variant="secondary" :disabled="batchRunning || !pickedRows.length" @click="applyBatch(true)">启用映射</TxButton>
          <TxButton size="sm" variant="danger" :disabled="batchRunning || !pickedRows.length" @click="applyBatch(false)">停用映射</TxButton>
        </span>
      </div>

      <RowTable
        :columns="columns"
        :data="paged.rows"
        row-key="key"
        :row-tone="rowTone"
        :sort="tableSort"
        :sort-on-client="false"
        :empty-text="emptyText"
        :empty-action="emptyAction"
        caption="模型目录"
        @update:sort="onSort"
        @row-click="openRow"
        @empty-action="onEmptyAction"
      >
        <template #cell-pick="{ row }">
          <TxCheckbox :model-value="picked.has(row.key)" :disabled="batchRunning" :aria-label="`选择 ${row.id}`" @click.stop @keydown.stop @update:model-value="togglePick(row.key)" />
        </template>
        <template #cell-status="{ row }">
          <span :title="row.note || undefined"><StatusMark :state="row.status" :label="row.statusLabel" /></span>
        </template>
        <template #cell-id="{ row }">
          <span class="mr-id">
            <ProviderMark :provider="row.vendor === 'other' ? row.key : row.vendor" :size="18" />
            <button type="button" class="mr-id__t num" :title="row.id" @click.stop="openRow(row)">{{ row.id }}</button>
            <TxTag v-if="kindTag(row.kind, kind)" size="sm" variant="outline" class="mr-id__kind" :label="kindTag(row.kind) ?? ''" />
            <TxTag v-if="row.aliases.length" size="sm" variant="plain" class="mr-id__alias" :title="`别名：${row.aliases.join(' · ')}`" :label="width >= 1180 ? `+${row.aliases.length} 别名` : `+${row.aliases.length}`" />
          </span>
        </template>
        <template #cell-price="{ row }">
          <span class="mr-price num" :class="`is-${row.price.kind}`" :title="priceTitle(row)">{{ priceText(row) }}</span>
        </template>
        <template #cell-context="{ row }">
          <span class="num" :class="{ 'mr-dim': specText(row) === '—' }" :title="insightsReady ? undefined : '规格暂不可用'">{{ specText(row) }}</span>
        </template>
        <template #cell-reasoning="{ row }">
          <span class="num" :class="{ 'mr-dim': reasoningMark(row) !== '✓' }" :aria-label="reasoningMark(row) === '✓' ? '支持思考' : reasoningMark(row) === '否' ? '不支持思考' : '未知'">{{ reasoningMark(row) }}</span>
        </template>
        <template #cell-channels="{ row }">
          <span class="num" :class="{ 'mr-dim': !row.inUse }" :title="`${row.enabledChannels} 个渠道启用 · 共 ${row.channels} 个`">{{ row.catalogOnly ? '—' : `${row.enabledChannels}/${row.channels}` }}</span>
        </template>
        <template #cell-tokens="{ row }">
          <span class="mr-tok">
            <i class="mr-bar" :class="{ 'has-fill': hasBar(row) }" aria-hidden="true"><b v-if="hasBar(row)" :style="{ width: `${share(row) * 100}%` }" /></i>
            <span class="num" :class="{ 'mr-dim': !row.tokens }">{{ row.tokens === null ? '—' : row.tokens ? fmtCompact(row.tokens) : '0' }}</span>
          </span>
        </template>
        <template #cell-success="{ row }">
          <span class="num" :class="{ 'mr-hot': row.bad && row.successRate !== null, 'mr-dim': row.successRate === null }">{{ successText(row) }}</span>
        </template>
        <template #cell-note="{ row }">
          <span class="mr-note" :class="{ 'is-bad': row.bad }" :title="row.note || undefined">{{ evidenceText(row) }}</span>
        </template>

        <template #card="{ row }">
          <div class="mr-card">
            <div class="mr-card__l1">
              <TxCheckbox v-if="batchMode" :model-value="picked.has(row.key)" :disabled="batchRunning" :aria-label="`选择 ${row.id}`" @click.stop @keydown.stop @update:model-value="togglePick(row.key)" />
              <ProviderMark :provider="row.vendor === 'other' ? row.key : row.vendor" :size="16" />
              <span class="mr-card__id num">{{ row.id }}</span>
              <TxTag v-if="kindTag(row.kind, kind)" size="sm" variant="outline" class="mr-id__kind" :label="kindTag(row.kind) ?? ''" />
              <StatusMark :state="row.status" :label="row.statusLabel" />
            </div>
            <div class="mr-card__ln num">
              <span class="mr-price" :class="`is-${row.price.kind}`">{{ priceText(row) }}</span>
              <span v-if="specText(row) !== '—'">{{ specText(row) }}</span>
              <span v-if="reasoningMark(row) === '✓'">思考</span>
              <span v-if="row.aliases.length" class="mr-dim">+{{ row.aliases.length }} 别名</span>
            </div>
            <div class="mr-card__ln">
              <span class="mr-card__tok">
                <span class="mr-card__k">{{ WINDOW_DAYS }} 天</span>
                <i v-if="row.tokens" class="mr-bar" :class="{ 'has-fill': hasBar(row) }" aria-hidden="true"><b v-if="hasBar(row)" :style="{ width: `${share(row) * 100}%` }" /></i>
                <span class="num" :class="{ 'mr-dim': !row.tokens }">{{ row.tokens === null ? '—' : row.tokens ? fmtCompact(row.tokens) : row.requests || row.successRate !== null ? '0 Token' : '无调用' }}</span>
              </span>
              <span v-if="row.successRate !== null" class="num" :class="{ 'mr-hot': row.bad }">成功 {{ successText(row) }}</span>
              <span class="mr-card__ch num">{{ row.catalogOnly ? '仅目录' : `渠道 ${row.enabledChannels}/${row.channels}` }}</span>
            </div>
          </div>
        </template>
      </RowTable>

      <template #footer>
        <Pager v-model:page="page" :total="paged.total" :page-size="PAGE_SIZE" />
      </template>
    </Plate>

    <ModelSheet
      v-model="sheetOpen"
      :row="selected ?? lastSelected"
      :probes="probes"
      :source-status="live.data.value?.index.sourceStatus"
      :insights-ready="insightsReady"
      :usage-missing="Boolean(live.data.value?.usageFailed)"
      :reload="reload"
    />
  </div>
</template>

<style scoped>
.mp-sync { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; font-size: var(--fs-xs); color: var(--ink-2); }
.mp-sync__k { color: var(--ink-3); white-space: nowrap; }
.mp-sync__k .num { color: var(--ink-2); }
.mp-sync__k.is-warn, .mp-sync__k.is-warn .num { color: var(--signal-ink); }
.mp-sync__go { font-size: var(--fs-xs); }
.mp-sync__sum { max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ink-2); font-family: var(--font-mono); }
.mp-live { display: inline-flex; align-items: center; }
.mp-tools { margin-top: -8px; }
.mp-tools__pick { display: flex; flex: 1 1 auto; align-items: center; gap: 8px; min-width: 0; }
.mp-tools :deep(.ui-ff) { width: 172px; }
/* 排序 always has a value: it keeps the resting control edge, not the "filter applied" ink edge */
.mp-sort.ui-ff.is-set :deep(.tx-input) { border-color: var(--ctl); }
.mp-search { width: 260px; margin-left: auto; }
.mp-batch { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 14px; padding: 4px 0 10px; font-size: var(--fs-xs); color: var(--ink-2); }
.mp-batch__act { display: inline-flex; align-items: center; gap: 8px; margin-left: auto; }
.mp-batch__run { color: var(--ink-3); }
.mp-meta { display: inline-flex; flex-wrap: wrap; align-items: baseline; gap: 2px 12px; font-size: var(--fs-xs); color: var(--ink-3); }
.mp-meta__warn { color: var(--ink-2); }
.mp-meta__asof { display: none; }
.mp-legend { font-size: var(--fs-xs); color: var(--ink-3); cursor: help; border-bottom: 1px dotted var(--ink-4); }
.mp-legend:focus-visible { outline: 2px solid var(--signal); outline-offset: 2px; }
.mp-legend__ln { display: block; }
.mp-legend__ln + .mp-legend__ln { margin-top: 4px; }

.mr-id { display: flex; align-items: center; gap: 8px; min-width: 0; }
.mr-id__t {
  all: unset; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer;
  font-family: var(--font-mono); font-size: var(--fs-row); color: var(--ink);
}
.mr-id__t:hover { text-decoration: underline; text-underline-offset: 3px; text-decoration-color: var(--ink-3); }
.mr-id__t:focus-visible { outline: 2px solid var(--signal); outline-offset: 2px; }
.mr-id__alias, .mr-id__kind { flex: none; }
.mr-price { display: inline-block; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; vertical-align: middle; }
.mr-price.is-reference { color: var(--ink-2); }
.mr-price.is-none { color: var(--ink-3); }
.mr-dim { color: var(--ink-3); }
.mr-hot { color: var(--signal-ink); }
.mr-tok { display: inline-flex; align-items: center; justify-content: flex-end; gap: 8px; width: 100%; }
.mr-bar { display: inline-block; width: 48px; height: 3px; flex: none; overflow: hidden; font-style: normal; }
.mr-bar.has-fill { background: var(--paper-3); }
.mr-bar > b { display: block; height: 100%; background: var(--ink-2); transition: width var(--dur-5) var(--ease-settle); }
.mr-note { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--ink-3); }
.mr-note.is-bad { color: var(--signal-ink); }

.mr-card { display: grid; gap: 4px; min-width: 0; }
.mr-card__l1 { display: flex; align-items: center; gap: 8px; min-width: 0; }
.mr-card__id { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--fs-row); color: var(--ink); }
.mr-card__ln { display: flex; flex-wrap: wrap; align-items: center; gap: 2px 0; font-size: var(--fs-xs); color: var(--ink-2); min-width: 0; }
.mr-card__ln > span + span:not(.mr-card__ch)::before { content: "·"; margin: 0 6px; color: var(--ink-4); }
.mr-card__tok { display: inline-flex; align-items: center; gap: 6px; }
.mr-card__k { color: var(--ink-3); }
.mr-card__ch { margin-left: auto; padding-left: 8px; color: var(--ink-3); }

@media (max-width: 1179px) {
  /* label + gap + the select's 132px floor (FilterField): any narrower and the select spills into the next field */
  .mp-tools :deep(.ui-ff) { width: 164px; }
  .mp-search { width: 200px; }
}
@media (max-width: 599px) {
  .mp-meta__maps { display: none; }
}
@media (max-width: 959px) {
  .mp-tools { margin-top: -4px; }
  .mp-tools__pick { display: contents; }
  .mp-search { order: -1; width: 100%; margin-left: 0; }
  .mp-tools :deep(.ui-ff) { flex: 1 1 140px; width: auto; }
  .mp-sync { gap: 2px 10px; }
  .mp-sync__sum { max-width: 100%; }
  .mp-live.is-quiet { display: none; }
  .mp-meta__asof { display: inline; }
}
:deep(.ui-st) { flex: none; }
</style>
