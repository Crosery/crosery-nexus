<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { TxDropdownItem, TxDropdownMenu } from '@talex-touch/tuffex/dropdown-menu'
import { TxButton, TxIconButton } from '@talex-touch/tuffex/button'
import PageHead from '../../ui/shell/PageHead.vue'
import LiveMark from '../../ui/shell/LiveMark.vue'
import Plate from '../../ui/data/Plate.vue'
import RowTable from '../../ui/data/RowTable.vue'
import StatusMark from '../../ui/data/StatusMark.vue'
import TickStrip from '../../ui/viz/TickStrip.vue'
import TimingLanes from '../../ui/viz/TimingLanes.vue'
import Segmented from '../../ui/form/Segmented.vue'
import SearchField from '../../ui/form/SearchField.vue'
import Switch from '../../ui/form/Switch.vue'
import Tip from '../../ui/form/Tip.vue'
import { CALM_MENU } from '../../ui/form/anchor'
import Icon from '../../ui/Icon.vue'
import { useBreakpoint } from '../../ui/composables/useBreakpoint'
import { useLive } from '../../ui/composables/useLive'
import { useNow, fmtCountdownClock } from '../../ui/composables/useNow'
import { NONE, fmtAgo, fmtDuration, fmtInt, fmtPct, fmtTime } from '../../ui/fmt'
import { copyText, notify } from '../../ui/feedback/toast'
import { confirmSheet } from '../../ui/feedback/confirmSheet'
import { setNavCount } from '../../shell/badges'
import { usePaletteCommands } from '../../shell/palette'
import { useQueryState } from '../../lib/listState'
import { errorReason } from '../../lib/errors'
import { whenIdle } from '../../lib/resource'
import { ApiError, api } from '../../api'
import type { ChannelItem, ChannelsData, SyncJob, SyncStatus } from '../../types'
import type { CommandItem, DataState, LaneJob, RowColumn, RowTone, SegmentItem, StatusKind } from '../../ui/types'
import ChannelSheet from './ChannelSheet.vue'
import CreateChannelSheet from './CreateChannelSheet.vue'
import { fetchChannelHealth, type HealthResult } from './channelsApi'
import {
  DEFAULT_WINDOW, HEALTH_RULES, WINDOWS, channelStatusFilter, classifyChannel, countChannels, discoveryCell, hostOf, lastErrorCell, middleEllipsis, modelCounts,
  poolSlots, windowLabel, type ChannelHealthClass, type ChannelHealthItem,
} from './channelModel'

/**
 * /channels (DESIGN §6.4): which upstreams are reachable and healthy, and when models were last discovered.
 * Rows = /api/channels (control plane) + /api/channel-health (local usage + discovery state, never upstream).
 * The only upstream-touching action here is 立即发现 — the existing model-discovery sync job, cooldown-aware.
 */
const { isMobile, isCompact, width } = useBreakpoint()
/** every figure gets its own column only when the name column keeps ≥200px (1440 → yes, 1097/1180 → no) */
const full = computed(() => width.value >= 1320)
const now = useNow()

const scope = useQueryState({ q: '', status: 'all', hours: DEFAULT_WINDOW, focus: '', new: '' })
const hours = computed(() => (WINDOWS.some((w) => w.value === scope.state.hours) ? scope.state.hours : DEFAULT_WINDOW))
const win = computed(() => windowLabel(hours.value))

/* ── data ── */
const channels = useLive<ChannelsData>(() => api.channels<ChannelsData>(), { intervalMs: 30_000, isEmpty: (d) => !d.channels?.length })
const health = useLive<HealthResult>((signal) => fetchChannelHealth(hours.value, signal), { intervalMs: 30_000 })
const sync = useLive<SyncStatus>((signal) => api.sync.status(signal), { intervalMs: 30_000 })
watch(hours, () => void health.refresh())

const list = computed<ChannelItem[]>(() => (Array.isArray(channels.data.value?.channels) ? channels.data.value.channels : []))
const healthPayload = computed(() => (health.data.value?.available ? health.data.value.payload : null))
/** false only when the server answered 404 (route not deployed yet); unknown while loading counts as available */
const healthAvailable = computed(() => health.data.value?.available !== false)
const healthMap = computed(() => new Map((Array.isArray(healthPayload.value?.channels) ? healthPayload.value.channels : []).map((h) => [h.name, h])))
const classes = computed(() => new Map(list.value.map((c) => [c.name, classifyChannel(c, healthMap.value.get(c.name), now.value)])))
const counts = computed(() => countChannels(list.value, classes.value))
const discoveryJob = computed<SyncJob | null>(() => sync.data.value?.jobs.find((job) => job.id === 'model-discovery') ?? null)

/* ── rows ── */
type Row = {
  name: string
  channel: ChannelItem
  health: ChannelHealthItem | null
  cls: ChannelHealthClass
  host: string
  models: { on: number; total: number; off: number }
  requests: number | null
  successRate: number | null
  p95Ms: number | null
  severity: number
}

const SEVERITY: Record<StatusKind, number> = { bad: 0, warn: 1, run: 2, busy: 2, cool: 2, pause: 3, idle: 3, stale: 3, off: 4 }

const rows = computed<Row[]>(() =>
  list.value
    .map((channel) => {
      const h = healthMap.value.get(channel.name) ?? null
      const cls = classes.value.get(channel.name)!
      return {
        name: channel.name,
        channel,
        health: h,
        cls,
        host: hostOf(channel.baseUrl),
        models: modelCounts(channel),
        requests: h ? h.requests : null,
        successRate: h?.successRate ?? null,
        p95Ms: h?.p95Ms ?? null,
        severity: SEVERITY[cls.state] ?? 3,
      }
    })
    .sort((a, b) => a.severity - b.severity || (b.requests ?? -1) - (a.requests ?? -1) || a.name.localeCompare(b.name)),
)

const statusFilter = computed(() => channelStatusFilter(scope.state.status))
// an old link (`?status=disabled`) or an unknown value is rewritten to what is applied, so the URL never claims a filter
watch(() => scope.state.status, (raw) => {
  const applied = channelStatusFilter(raw)
  if (applied !== raw) scope.patch({ status: applied })
}, { immediate: true })
const statusItems = computed<SegmentItem[]>(() => [
  { value: 'all', label: '全部', count: counts.value.total },
  { value: 'enabled', label: '启用', count: counts.value.enabled },
  { value: 'warn', label: '降级', count: counts.value.warn },
  { value: 'off', label: '停用', count: counts.value.off },
])
const filtered = computed(() => {
  const q = scope.state.q.trim().toLowerCase()
  return rows.value.filter((row) => {
    if (statusFilter.value === 'enabled' && !row.channel.enabled) return false
    if (statusFilter.value === 'warn' && row.cls.bucket !== 'warn') return false
    if (statusFilter.value === 'off' && row.cls.bucket !== 'off') return false
    if (q && !row.name.toLowerCase().includes(q) && !row.channel.baseUrl.toLowerCase().includes(q)) return false
    return true
  })
})
const hasFilter = computed(() => statusFilter.value !== 'all' || Boolean(scope.state.q.trim()))
const emptyText = computed(() => {
  if (!hasFilter.value) return '还没有渠道'
  const label = statusItems.value.find((item) => item.value === statusFilter.value)?.label
  return scope.state.q.trim() ? `没有匹配「${scope.state.q.trim()}」的渠道` : `没有「${label}」的渠道`
})
function clearFilters() {
  scope.patch({ q: '', status: 'all' })
}

const tableState = computed<DataState>(() => {
  const s = channels.state.value
  if (s === 'empty') return hasFilter.value ? 'ready' : 'empty'
  return s
})
const plateState = computed<DataState>(() => (channels.state.value === 'ready' && health.state.value === 'stale' ? 'stale' : tableState.value))
const plateStaleAt = computed(() => (channels.state.value === 'stale' ? channels.lastAt.value : health.lastAt.value))
function refreshAll() {
  void channels.refresh()
  void health.refresh()
}

/* ── columns: wide (≥1180) shows every figure; md folds requests and p95 into the 成功率 sub-line ── */
const columns = computed<RowColumn<Row>[]>(() => {
  const wide = full.value
  const cols: RowColumn<Row>[] = [
    { key: 'state', title: '状态', width: wide ? 136 : 132 },
    { key: 'name', title: '渠道', minWidth: 160 },
    { key: 'models', title: '模型', width: wide ? 96 : 84, align: 'right' },
  ]
  // the window is the toolbar's 统计窗口; column titles do not repeat it
  if (wide) cols.push({ key: 'requests', title: '请求', width: 88, align: 'right', sortable: true })
  cols.push({ key: 'successRate', title: '成功率', width: wide ? 88 : 112, align: 'right', sortable: true })
  if (wide) cols.push({ key: 'p95Ms', title: 'p95', width: 76, align: 'right', sortable: true })
  cols.push(
    { key: 'dist', title: '分布', width: wide ? 168 : 96 },
    { key: 'lastError', title: '最近错误', width: wide ? 156 : 144 },
    { key: 'discovery', title: '模型发现', width: wide ? 140 : 132 },
    { key: 'enabled', title: '启用', width: 52 },
    { key: 'more', title: '', width: 40, align: 'right' },
  )
  return cols
})
const rowTone = (row: Row): RowTone => {
  if (row.cls.bucket === 'off') return 'off'
  if (row.cls.bucket === 'warn') return 'attn'
  return null
}

function errorCell(row: Row) {
  return lastErrorCell(row.health, now.value)
}
function discCell(row: Row) {
  // without the health endpoint there is no per-channel probe state; say nothing rather than "waiting"
  if (!healthAvailable.value && row.channel.enabled) return { main: NONE, sub: '', hot: false }
  return discoveryCell(row.channel, row.health?.discovery ?? null, now.value)
}
function strip(row: Row, count: number) {
  const pooled = poolSlots(row.health?.slots ?? [], count)
  // a disabled channel's old failures are history, not a to-do: no orange marks on its strip
  return row.channel.enabled ? pooled : { ticks: pooled.ticks, bad: [] }
}
function stripLabel(row: Row) {
  const h = row.health
  if (!h) return `${row.name} 近 ${win.value} 分布：暂无数据`
  return `${row.name} 近 ${win.value} ${fmtInt(h.requests)} 次请求 · 上游失败 ${fmtInt(Math.max(0, h.errors - h.clientCancelled))}`
}
function successText(row: Row) {
  if (!healthAvailable.value || !row.health) return NONE
  return row.health.requests ? fmtPct(row.successRate, 1) : NONE
}
function successSub(row: Row) {
  const h = row.health
  if (!healthAvailable.value || !h) return ''
  // wide: the requests column already says 0 / 从未调用 — no second line repeating it
  if (!h.requests) return full.value ? '' : h.lastRequestAt ? `${win.value} 无调用` : '从未调用'
  if (full.value) return h.errors ? `失败 ${fmtInt(h.errors)}` : ''
  // narrow desktop: the requests column is gone, p95 rides here; the count is in the sheet and the strip label
  return h.p95Ms !== null ? `p95 ${fmtDuration(h.p95Ms)}` : `${fmtInt(h.requests)} 次`
}
function cardFigures(row: Row) {
  const parts = [`${fmtInt(row.models.on)}/${fmtInt(row.models.total)} 模型`]
  const h = row.health
  if (healthAvailable.value && h) {
    if (h.requests) {
      parts.push(`${fmtInt(h.requests)} 次`, fmtPct(row.successRate, 1))
      if (row.p95Ms !== null) parts.push(`p95 ${fmtDuration(row.p95Ms)}`)
    } else parts.push(`${win.value} 无调用`)
  }
  return parts.join(' · ')
}
const successHot = (row: Row) => row.cls.state === 'bad' && row.cls.label === '异常' && Boolean(row.health?.requests)

/* ── selection / sheets (deep-linkable: ?focus=<name>, ?new=1) ── */
const focused = computed(() => list.value.find((c) => c.name === scope.state.focus) ?? null)
const sheetOpen = computed({
  get: () => Boolean(focused.value),
  set: (open: boolean) => {
    if (!open) scope.patch({ focus: '' })
  },
})
function openChannel(row: Row | ChannelItem) {
  scope.patch({ focus: row.name })
}
const createOpen = computed({
  get: () => scope.state.new === '1',
  set: (open: boolean) => scope.patch({ new: open ? '1' : '' }),
})

/* ── mutations ── */
const pending = ref(new Set<string>())
function setPending(key: string, on: boolean) {
  const next = new Set(pending.value)
  if (on) next.add(key)
  else next.delete(key)
  pending.value = next
}
function failToast(title: string, error: unknown) {
  notify(`◆ ${title}`, { tone: 'bad', description: errorReason(error) })
}
/** after an acknowledged write the switch stays locked until the list shows it (a second click would repeat it) */
async function reconcile() {
  void health.refresh()
  await channels.refresh().catch(() => undefined)
  // superseded by a background poll: keep the switch locked until that newer read lands
  await whenIdle(channels.loading)
}

async function toggleChannel(channel: ChannelItem, next: boolean) {
  if (pending.value.has(channel.name)) return
  if (!next) {
    const m = modelCounts(channel)
    const h = healthMap.value.get(channel.name)
    const ok = await confirmSheet({
      title: `停用 ${channel.name}？`,
      facts: [
        { k: '地址', v: hostOf(channel.baseUrl) },
        { k: '开着的模型', v: `${fmtInt(m.on)} 个` },
        ...(h ? [{ k: `近 ${win.value} 请求`, v: `${fmtInt(h.requests)} 次` }] : []),
      ],
      consequence: '走这个渠道的模型立刻不可用 · 别的渠道有同名模型时改走别的渠道',
      confirmText: '停用',
      danger: true,
    })
    if (!ok) return
  }
  setPending(channel.name, true)
  try {
    await api.setChannelEnabled(channel.name, next)
    notify(next ? `✓ 已启用 ${channel.name}` : `✓ 已停用 ${channel.name} · 不参与路由`)
    await reconcile()
  } catch (error) {
    failToast(next ? '启用失败' : '停用失败', error)
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
    notify(next ? `✓ 已开启 ${modelId}` : `✓ 已停用 ${modelId} · 同步不会自动恢复`, { id: 'cx-channel-model' })
    await channels.refresh().catch(() => undefined)
    await whenIdle(channels.loading)
    return true
  } catch (error) {
    failToast('模型开关失败', error)
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
    if (scope.state.focus === channel.name) scope.patch({ focus: '' })
    notify(`✓ 已删除 ${channel.name}`)
    refreshAll()
  } catch (error) {
    failToast('删除失败', error)
  } finally {
    setPending(channel.name, false)
  }
}

/**
 * Always reachable: /api/channels drops enabled snapshots the gateway no longer has (server/channelView.ts), so the
 * list usually cannot count them — the server decides what is stale and reports what it removed.
 */
const pruning = ref(false)
async function pruneStale() {
  if (pruning.value) return
  const stale = list.value.filter((c) => c.stale)
  const ok = await confirmSheet({
    title: stale.length ? `清理 ${stale.length} 个残留渠道？` : '清理残留渠道？',
    facts: stale.length
      ? [{ k: '渠道', v: stale.map((c) => c.name).join('、') }]
      : [{ k: '范围', v: '网关里已不存在、也不是在这里停用的渠道快照' }],
    consequence: '只删本地快照 · 网关里本来就没有它们 · 不可撤销',
    confirmText: '清理',
    danger: true,
  })
  if (!ok) return
  pruning.value = true
  try {
    const result = await api.pruneStaleChannels()
    notify(result.removed?.length ? `✓ 已清理 ${result.removed.length} 个残留渠道 · ${result.removed.join('、')}` : '— 没有需要清理的渠道')
    refreshAll()
  } catch (error) {
    failToast('清理失败', error)
  } finally {
    pruning.value = false
  }
}

/* ── model discovery: the existing sync job (cooldown + per-host backoff live server-side) ── */
const discovering = ref(false)
const runCooldownMs = computed(() => {
  const until = discoveryJob.value?.runCooldownUntil
  const at = until ? Date.parse(until) : NaN
  return Number.isFinite(at) ? Math.max(0, at - now.value) : 0
})
const discoverButton = computed(() => {
  const job = discoveryJob.value
  if (!job) return { label: '立即发现', disabled: true, hint: sync.state.value === 'loading' ? '' : '同步状态读取失败' }
  if (discovering.value || job.state === 'running') return { label: '发现中···', disabled: true, hint: '' }
  if (runCooldownMs.value > 0) return { label: `冷却 ${fmtCountdownClock(runCooldownMs.value)}`, disabled: true, hint: '手动发现有冷却，避免频繁请求上游' }
  if (!job.canRunNow) return { label: '立即发现', disabled: true, hint: '暂不可运行' }
  return { label: '立即发现', disabled: false, hint: '' }
})
async function runDiscovery() {
  if (discoverButton.value.disabled) return
  const enabled = list.value.filter((c) => c.enabled)
  const ok = await confirmSheet({
    title: '立即发现模型？',
    facts: [
      { k: '探测', v: `${fmtInt(enabled.length)} 个启用渠道的 /models` },
      { k: '节流', v: '同主机间隔 ≥60s · 退避中的主机跳过' },
      { k: '之后', v: '手动发现冷却 5m' },
    ],
    consequence: '只加新模型 · 不会恢复人工停用的模型',
    confirmText: '开始发现',
  })
  if (!ok) return
  discovering.value = true
  try {
    await api.sync.run('model-discovery')
    notify('✓ 已开始发现 · 结果会出现在「模型发现」列')
    window.setTimeout(() => {
      void sync.refresh()
      refreshAll()
    }, 4_000)
  } catch (error) {
    if (error instanceof ApiError && error.code === 'cooldown') {
      notify(`◇ 冷却中 · ${fmtCountdownClock((error.retryAfterSec ?? 0) * 1000)} 后可再试`, { tone: 'warn' })
    } else if (error instanceof ApiError && error.code === 'running') {
      notify('— 正在发现中 · 稍后看结果')
    } else {
      failToast('发现没能开始', error)
    }
  } finally {
    discovering.value = false
    void sync.refresh()
  }
}

const discoveryLane = computed<LaneJob[]>(() => {
  const job = discoveryJob.value
  if (!job) return []
  const state: StatusKind = job.state === 'running' ? 'busy' : job.state === 'backoff' ? 'warn' : job.state === 'error' ? 'bad' : job.state === 'disabled' ? 'off' : 'run'
  return [{
    id: job.id,
    label: '运行记录',
    // the cadence is in the plate meta (每渠道 ≥30m); the plate title already names the lane
    every: null,
    runs: job.history.map((h) => ({ at: h.at, durationMs: h.durationMs, result: h.result })),
    nextAt: job.nextRunAt,
    backoffUntil: job.backoffUntil,
    calls24h: job.requests24h,
    state,
    stateLabel: job.state === 'backoff' ? '退避' : job.state === 'running' ? '发现中' : job.state === 'error' ? '失败' : job.state === 'disabled' ? '停用' : '正常',
    summary: job.lastError ? job.lastError : job.summary,
    lastAt: job.lastFinishedAt ?? job.lastRunAt,
  }]
})
const discoveryMeta = computed(() => {
  const policy = sync.data.value?.policy
  const job = discoveryJob.value
  const parts: string[] = []
  if (job?.intervalMs) parts.push(`每渠道 ≥${Math.round(job.intervalMs / 60_000)}m`)
  if (policy) parts.push(`同主机 ≥${Math.round(policy.minIntervalPerHostMs / 1000)}s`, `失败退避 ×${policy.backoff.factor} ≤${Math.round(policy.backoff.maxMs / 3_600_000)}h`)
  return parts.join(' · ')
})
/* the lane already carries the 24h upstream call count and the state, so this line is only last / result / next */
const discoveryLine = computed(() => {
  const job = discoveryJob.value
  if (!job) return ''
  const parts: string[] = []
  if (job.lastFinishedAt ?? job.lastRunAt) parts.push(`上次 ${fmtTime(job.lastFinishedAt ?? job.lastRunAt, now.value)}`)
  if (job.summary) parts.push(job.summary)
  if (job.nextRunAt) parts.push(Date.parse(job.nextRunAt) <= now.value ? '下次 · 已到期' : `下次 ${fmtTime(job.nextRunAt, now.value)}`)
  return parts.join(' · ')
})

/* ── page head ── */
const headStatus = computed(() => {
  const c = counts.value
  return { total: c.total, enabled: c.enabled, warn: c.warn, off: c.off, stale: c.stale, routable: c.routable, mappings: c.mappings }
})
const countTip = computed(() =>
  `可路由 = 启用渠道里开着的模型，按 id 去重（${fmtInt(counts.value.routable)}）· 映射 = 所有渠道的模型条目，含停用（${fmtInt(counts.value.mappings)}）· /models 的「在用」另含账号模型`,
)
const ruleTip = `降级 = 近窗口上游失败 ≥${HEALTH_RULES.warnRate * 100}%（≥${HEALTH_RULES.minRequests} 次）或近 1h 失败 ≥${HEALTH_RULES.warnRecent} 或发现退避 · 异常 = 失败 ≥${HEALTH_RULES.badRate * 100}% 或发现 401/403 · 客户端取消不计`

/* ── shell hooks ── */
watch(() => counts.value.warn, (n) => setNavCount('channels', n), { immediate: true })
onBeforeUnmount(() => setNavCount('channels', null))

usePaletteCommands(() => {
  const cmds: CommandItem[] = [
    { id: 'act:channel:new', title: '添加渠道…', section: 'ACT', keywords: ['channel', 'new', '渠道'], run: () => (createOpen.value = true) },
    {
      id: 'act:channel:discover',
      title: '立即发现模型',
      section: 'ACT',
      keywords: ['discover', 'models', 'sync', '发现'],
      hint: discoverButton.value.disabled ? discoverButton.value.label : undefined,
      disabled: discoverButton.value.disabled,
      run: () => void runDiscovery(),
    },
  ]
  cmds.push({
    id: 'act:channel:prune',
    title: counts.value.stale ? `清理 ${counts.value.stale} 个残留渠道…` : '清理残留渠道…',
    section: 'ACT',
    keywords: ['prune', 'stale', '残留', '清理'],
    disabled: pruning.value,
    run: () => void pruneStale(),
  })
  for (const channel of list.value) {
    cmds.push({ id: `find:channel:${channel.name}`, title: `渠道 ${channel.name}`, section: 'FIND', keywords: [hostOf(channel.baseUrl)], hint: classes.value.get(channel.name)?.label, run: () => openChannel(channel) })
  }
  return cmds
})

const menuFor = shallowRef<string | null>(null)
function copyAddress(channel: ChannelItem) {
  void copyText(channel.baseUrl, '地址')
}
</script>

<template>
  <div class="ui-page cx-channels">
    <PageHead title="渠道">
      <template #status>
        <span v-if="channels.data.value" class="cx-head num">
          <span>{{ fmtInt(headStatus.total) }} 个</span>
          <span class="cx-dot">·</span><span>启用 {{ fmtInt(headStatus.enabled) }}</span>
          <span class="cx-dot">·</span>
          <Tip :content="ruleTip"><span class="cx-tip" :class="{ sig: headStatus.warn > 0 }" tabindex="0">降级 {{ fmtInt(headStatus.warn) }}</span></Tip>
          <span class="cx-dot">·</span>
          <span>停用 {{ fmtInt(headStatus.off) }}</span>
          <span class="cx-dot">·</span>
          <Tip :content="countTip"><span class="cx-tip" tabindex="0">可路由 {{ fmtInt(headStatus.routable) }} 个模型</span></Tip>
          <template v-if="headStatus.stale">
            <span class="cx-dot">·</span>
            <span class="sig">残留 {{ fmtInt(headStatus.stale) }}</span>
          </template>
        </span>
      </template>
      <template v-if="!isMobile" #live>
        <LiveMark :state="channels.state.value" :last-at="channels.lastAt.value" :interval-ms="30_000" @retry="refreshAll" />
      </template>
      <template v-if="!isMobile" #actions>
        <TxButton variant="primary" @click="createOpen = true"><Icon name="plus" /><span>添加渠道</span></TxButton>
      </template>
    </PageHead>

    <div class="cx-body">
    <div class="ui-toolbar cx-toolbar">
      <div class="cx-searchrow">
        <SearchField v-model="scope.state.q" placeholder="名称 / 地址" label="搜索渠道" class="cx-search" />
        <TxButton v-if="isMobile" variant="primary" class="cx-add-m" @click="createOpen = true"><Icon name="plus" /><span>添加</span></TxButton>
      </div>
      <Segmented v-model="scope.state.status" :items="statusItems" label="按状态筛选" />
      <div class="push cx-window">
        <span class="micro" aria-hidden="true">统计窗口</span>
        <Segmented v-model="scope.state.hours" :items="WINDOWS.map((w) => ({ value: w.value, label: w.label }))" label="统计窗口" />
      </div>
    </div>

    <div class="ui-grid">
      <Plate
        title="上游渠道"
        class="c-12"
        flush
        :state="plateState"
        :error="channels.error.value"
        :stale-at="plateStaleAt"
        :rows="5"
        empty-text="还没有渠道"
        empty-action="添加渠道"
        @retry="refreshAll"
        @empty-action="createOpen = true"
      >
        <template #meta>
          <span v-if="!healthAvailable" class="cx-meta-note">◇ 健康数据待服务更新后可见</span>
          <span v-else-if="health.state.value === 'error'" class="cx-meta-note">
            ◇ 健康数据读取失败 <button type="button" class="ui-link" @click="health.refresh">重试</button>
          </span>
        </template>
        <template v-if="channels.data.value" #actions>
          <button type="button" class="ui-link" :disabled="pruning" title="删掉网关里已不存在的渠道快照 · 先确认" @click="pruneStale">清理残留</button>
        </template>

        <RowTable
          :columns="columns"
          :data="filtered"
          row-key="name"
          density="two-line"
          :state="tableState"
          :error="channels.error.value"
          :row-tone="rowTone"
          :empty-text="emptyText"
          :empty-action="hasFilter ? '清除筛选' : '添加渠道'"
          caption="渠道列表"
          @row-click="openChannel"
          @retry="refreshAll"
          @empty-action="hasFilter ? clearFilters() : (createOpen = true)"
        >
          <template #cell-state="{ row }">
            <span class="cx-2l">
              <StatusMark :state="row.cls.state" :label="row.cls.label" />
              <span v-if="row.cls.reason && row.cls.bucket !== 'off'" class="cx-l2 ellip" :class="{ sig: row.cls.state === 'bad' }" :title="row.cls.reason">{{ row.cls.reason }}</span>
            </span>
          </template>

          <template #cell-name="{ row }">
            <span class="cx-2l">
              <button type="button" class="ui-link cx-name mono ellip" :title="`查看 ${row.name}`" @click.stop="openChannel(row)">{{ row.name }}</button>
              <span class="cx-l2 mono ellip" :title="row.channel.baseUrl">{{ middleEllipsis(row.host, full ? 44 : 30) }}<template v-if="row.channel.keyCount > 1"> · {{ row.channel.keyCount }} Key</template></span>
            </span>
          </template>

          <template #cell-models="{ row }">
            <span class="cx-2l cx-r num">
              <span><b class="cx-strong">{{ fmtInt(row.models.on) }}</b><span class="dim"> / {{ fmtInt(row.models.total) }}</span></span>
              <span v-if="row.models.off" class="cx-l2">人工停用 {{ fmtInt(row.models.off) }}</span>
            </span>
          </template>

          <template #cell-requests="{ row }">
            <span class="cx-2l cx-r num">
              <span class="cx-strong">{{ healthAvailable && row.health ? fmtInt(row.health.requests) : NONE }}</span>
              <span v-if="healthAvailable && row.health" class="cx-l2">{{ row.health.recent.requests ? `1h ${fmtInt(row.health.recent.requests)}` : row.health.lastRequestAt ? fmtAgo(row.health.lastRequestAt, now) : '从未调用' }}</span>
            </span>
          </template>

          <template #cell-successRate="{ row }">
            <span class="cx-2l cx-r num">
              <span class="cx-strong" :class="{ sig: successHot(row) }">{{ successText(row) }}</span>
              <span v-if="successSub(row)" class="cx-l2 ellip">{{ successSub(row) }}</span>
            </span>
          </template>

          <template #cell-p95Ms="{ row }">
            <span class="cx-r num cx-strong">{{ healthAvailable && row.p95Ms !== null ? fmtDuration(row.p95Ms) : NONE }}</span>
          </template>

          <template #cell-dist="{ row }">
            <span class="cx-dist">
              <TickStrip v-if="row.health" :ticks="strip(row, full ? 36 : 18).ticks" :bad="strip(row, full ? 36 : 18).bad" :h="12" :label="stripLabel(row)" />
              <span v-else class="dim">{{ NONE }}</span>
            </span>
          </template>

          <template #cell-lastError="{ row }">
            <span v-if="errorCell(row)" class="cx-2l num">
              <span class="cx-l1" :class="{ sig: errorCell(row)!.hot }">{{ errorCell(row)!.main }}</span>
              <span class="cx-l2 ellip" :title="row.health?.lastError?.detail ?? undefined">{{ errorCell(row)!.sub }}</span>
            </span>
            <span v-else class="dim">{{ NONE }}</span>
          </template>

          <template #cell-discovery="{ row }">
            <span v-if="!row.channel.enabled" class="dim">不探测</span>
            <span v-else class="cx-2l num">
              <span class="cx-l1">{{ discCell(row).main }}</span>
              <span class="cx-l2 ellip" :class="{ sig: discCell(row).hot }">{{ discCell(row).sub }}</span>
            </span>
          </template>

          <template #cell-enabled="{ row }">
            <span class="cx-switch" @click.stop @keydown.stop>
              <Switch
                :model-value="row.channel.enabled"
                :aria-label="`${row.channel.enabled ? '停用' : '启用'}渠道 ${row.name}`"
                :loading="pending.has(row.name)"
                :disabled="row.channel.stale"
                @update:model-value="(v: boolean) => toggleChannel(row.channel, v)"
              />
            </span>
          </template>

          <template #cell-more="{ row }">
            <span class="cx-more" @click.stop @keydown.stop>
              <TxDropdownMenu
                v-bind="CALM_MENU"
                :model-value="menuFor === row.name"
                placement="bottom-end"
                :min-width="168"
                @update:model-value="(open: boolean) => (menuFor = open ? row.name : null)"
              >
                <template #trigger>
                  <TxIconButton :label="`${row.name} 更多操作`" title="更多操作" size="sm" aria-haspopup="menu" :aria-expanded="menuFor === row.name"><Icon name="dots" /></TxIconButton>
                </template>
                <TxDropdownItem @select="openChannel(row)">模型列表</TxDropdownItem>
                <TxDropdownItem @select="copyAddress(row.channel)">复制地址</TxDropdownItem>
                <TxDropdownItem danger @select="deleteChannel(row.channel)">删除</TxDropdownItem>
              </TxDropdownMenu>
            </span>
          </template>

          <!-- <960: row-card. Line 1 mark · name · enable switch (40px hit area); line 2 figures; enabled rows add strip + discovery -->
          <template #card="{ row }">
            <div class="cx-card">
              <div class="cx-card__l1">
                <StatusMark :state="row.cls.state" :label="row.cls.label" bare />
                <span class="cx-card__name mono ellip">{{ row.name }}</span>
                <span class="cx-card__st" :class="{ sig: row.cls.state === 'bad' || row.cls.state === 'warn' }">{{ row.cls.label }}</span>
                <span class="cx-card__switch" @click.stop @keydown.stop>
                  <Switch
                    :model-value="row.channel.enabled"
                    :aria-label="`${row.channel.enabled ? '停用' : '启用'}渠道 ${row.name}`"
                    :loading="pending.has(row.name)"
                    :disabled="row.channel.stale"
                    @update:model-value="(v: boolean) => toggleChannel(row.channel, v)"
                  />
                </span>
              </div>
              <div class="cx-card__ln num">
                <span class="ellip">{{ cardFigures(row) }}</span>
              </div>
              <div v-if="row.cls.reason && row.cls.bucket === 'warn'" class="cx-card__ln cx-card__why" :class="{ sig: row.cls.state === 'bad' }">
                <span class="ellip">{{ row.cls.reason }}</span>
              </div>
              <div v-if="row.channel.enabled" class="cx-card__ln num">
                <TickStrip v-if="row.health?.requests" :ticks="strip(row, 18).ticks" :bad="strip(row, 18).bad" :h="10" :label="stripLabel(row)" />
                <span class="ellip">发现 {{ discCell(row).main }} · {{ discCell(row).sub }}</span>
              </div>
            </div>
          </template>
        </RowTable>
      </Plate>

      <Plate
        title="模型发现"
        class="c-12"
        :state="sync.state.value === 'ready' && !discoveryJob ? 'empty' : sync.state.value"
        :error="sync.error.value"
        :stale-at="sync.lastAt.value"
        :rows="1"
        empty-text="没有模型发现任务"
        @retry="sync.refresh"
      >
        <template v-if="!isMobile" #meta>
          <span v-if="discoveryMeta" class="num">{{ discoveryMeta }}</span>
        </template>
        <template #actions>
          <Tip :content="discoverButton.hint" :disabled="!discoverButton.hint">
            <TxButton variant="secondary" size="sm" :disabled="discoverButton.disabled" :aria-disabled="discoverButton.disabled" @click="runDiscovery">
              <Icon name="refresh" :size="14" /><span class="num">{{ discoverButton.label }}</span>
            </TxButton>
          </Tip>
        </template>
        <p v-if="discoveryLine" class="cx-disc-line num">{{ discoveryLine }}</p>
        <!-- phones: the throttle rules move under the summary so the head keeps title + button on one line -->
        <p v-if="isMobile && discoveryMeta" class="cx-disc-line cx-disc-line--rule num">{{ discoveryMeta }}</p>
        <TimingLanes :jobs="discoveryLane" :from-hours="isCompact ? 6 : 24" :to-hours="isCompact ? 1 : 2" />
      </Plate>
    </div>
    </div>

    <ChannelSheet
      v-model="sheetOpen"
      :channel="focused"
      :health="focused ? healthMap.get(focused.name) ?? null : null"
      :cls="focused ? classes.get(focused.name) ?? null : null"
      :window-label="win"
      :health-available="healthAvailable"
      :pending="pending"
      :toggle-model="toggleModel"
      @toggle-channel="(c: ChannelItem, v: boolean) => toggleChannel(c, v)"
      @delete="deleteChannel"
    />
    <CreateChannelSheet v-model="createOpen" :existing="list.map((c) => c.name)" @created="refreshAll" />
  </div>
</template>

<style>
.cx-channels .cx-head { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 2px 6px; color: var(--ink-2); }
.cx-channels .cx-dot { color: var(--ink-4); }
.cx-channels .cx-tip { border-bottom: 1px dotted var(--ink-4); cursor: help; }
.cx-body { display: flex; flex-direction: column; gap: 14px; min-width: 0; }
.cx-toolbar { gap: 8px 12px; }
.cx-searchrow { display: flex; align-items: center; gap: 8px; min-width: 0; }
.cx-toolbar .cx-search { width: 240px; }
.cx-add-m { flex: none; }
.cx-window { display: inline-flex; align-items: center; gap: 8px; }
.cx-meta-note { color: var(--ink-2); display: inline-flex; align-items: center; gap: 6px; }
.cx-meta-note .ui-link { font-size: var(--fs-xs); }

/* two-line cells */
.cx-channels .cx-2l { display: flex; flex-direction: column; justify-content: center; gap: 2px; min-width: 0; max-width: 100%; overflow: hidden; line-height: 1.3; }
.cx-channels .cx-r { align-items: flex-end; text-align: right; }
.cx-channels .cx-l1 { font-family: var(--font-mono); font-size: var(--fs-sm); color: var(--ink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
.cx-channels .cx-l2 { font-size: var(--fs-xs); color: var(--ink-3); white-space: nowrap; max-width: 100%; }
.cx-channels .cx-strong { color: var(--ink); font-weight: 500; }
.cx-channels .cx-name {
  display: block; max-width: 100%; text-align: left; border-bottom: 0;
  font-size: var(--fs-base); font-weight: 600; color: var(--ink);
}
.cx-channels .cx-name:hover { text-decoration: underline; text-underline-offset: 3px; text-decoration-color: var(--ink-3); }
.cx-channels .cx-dist { display: inline-flex; align-items: center; min-height: 20px; }
.cx-channels .cx-switch, .cx-channels .cx-more { display: inline-flex; align-items: center; }
.cx-channels .sig { color: var(--signal-ink); }

/* disabled rows: ink-3 everywhere, the name keeps ink-2 so the list stays scannable */
.cx-channels .tx-data-table__row.is-off .cx-strong,
.cx-channels .tx-data-table__row.is-off .cx-l1 { color: var(--ink-3); }
.cx-channels .tx-data-table__row.is-off .cx-name { color: var(--ink-2); font-weight: 500; }

/* row cards (<960) */
.cx-channels .cx-card { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.cx-channels .cx-card__l1 { display: flex; align-items: center; gap: 8px; min-width: 0; min-height: 28px; }
.cx-channels .cx-card__name { flex: 0 1 auto; min-width: 0; font-size: var(--fs-row); font-weight: 600; color: var(--ink); }
.cx-channels .cx-card__st { flex: none; font-size: var(--fs-xs); color: var(--ink-3); }
.cx-channels .cx-card__st.sig, .cx-channels .cx-card__why.sig { color: var(--signal-ink); }
.cx-channels .cx-card__why { color: var(--ink-2); }
.cx-channels .cx-card__switch { margin-left: auto; flex: none; display: inline-grid; place-items: center; min-width: 44px; min-height: 40px; }
.cx-channels .cx-card__ln { display: flex; align-items: center; gap: 6px; min-width: 0; font-size: var(--fs-xs); color: var(--ink-3); }
.cx-channels .cx-card__ln > .ellip { min-width: 0; }
.cx-channels .ui-rcard.is-off .cx-card__name { color: var(--ink-2); font-weight: 500; }

.cx-disc-line { margin: 2px 0 6px; font-size: var(--fs-xs); color: var(--ink-2); overflow-wrap: anywhere; }
.cx-disc-line--rule { margin-top: -2px; color: var(--ink-3); }

@media (max-width: 959px) {
  .cx-searchrow { flex: 1 1 100%; }
  .cx-toolbar .cx-search { width: auto; flex: 1 1 auto; }
  .cx-toolbar .cx-window { margin-left: 0; }
}
</style>
