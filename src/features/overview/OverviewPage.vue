<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch, watchEffect } from 'vue'
import { RouterLink } from 'vue-router'
import PageHead from '../../ui/shell/PageHead.vue'
import LiveMark from '../../ui/shell/LiveMark.vue'
import Plate from '../../ui/data/Plate.vue'
import AttentionList from '../../ui/data/AttentionList.vue'
import Readout from '../../ui/viz/Readout.vue'
import TimingLanes from '../../ui/viz/TimingLanes.vue'
import { useBreakpoint } from '../../ui/composables/useBreakpoint'
import { useLive } from '../../ui/composables/useLive'
import { useNow } from '../../ui/composables/useNow'
import { fmtTime } from '../../ui/fmt'
import type { DataState } from '../../ui/types'
import { api } from '../../api'
import { ApiError, request } from '../../api/http'
import { errorStatus } from '../../lib/errors'
import { useQueryState } from '../../lib/listState'
import { setNavCount } from '../../shell/badges'
import { useSharedAdminLive } from '../../shell/useAdminStatus'
import type { ApiKeyItem, CacheTrendData, ChannelsData, ChartsData, DashboardData, MonitorData, UsageOverviewData } from '../../types'
import GatewayPlate from './GatewayPlate.vue'
import KeyBurnPlate from './KeyBurnPlate.vue'
import PressurePlate from './PressurePlate.vue'
import ChecksList from './ChecksList.vue'
import { attention, burnRows, channelHealth, checks, inspection, kindWord, laneJobs, ledger, policyWords, pressureRows, severityWords, type CacheSummaryLike } from './model'
import type { MonitorAccount, OverviewPayload, OverviewRange, ScopeRange } from './types'

/**
 * 概览 (DESIGN §6.2) — "has anything gone wrong, and what do I do?"
 * Each plate reads the endpoint that owns its fact; nothing is re-aggregated here except the rolling-window
 * arithmetic in model.ts. Sources poll on their own cadence and pause while the tab is hidden (useLive); pulse,
 * sync and versions are the shell's own polls (useSharedAdminLive), not a second copy.
 */
const { width, isMobile } = useBreakpoint()
const now = useNow()

/* ── gateway: /api/pulse (live, 2 s) + /api/overview (range, 15 s) ─────────────────────────────── */
const scope = useQueryState({ range: '1h' })
/** true after /api/overview answered 404 (a console not yet restarted since the route landed) */
const overviewMissing = ref(false)
const RANGES: OverviewRange[] = ['1h', '6h', '24h']
const selectedRange = computed<ScopeRange>(() => (scope.state.range === 'live' ? 'live' : RANGES.includes(scope.state.range as OverviewRange) ? (scope.state.range as OverviewRange) : '1h'))
/** live mode still loads the 1h payload: channel health, Key hours and 活跃 Key do not depend on the scope range */
const fetchRange = computed<OverviewRange>(() => (selectedRange.value === 'live' ? '1h' : selectedRange.value))

/** a 200 whose body is not JSON reaches here as `{}` (api/http): refuse it so the plate shows its error state, not a crashed render */
function shaped<T>(data: T, ok: (d: T) => boolean): T {
  if (!data || typeof data !== 'object' || !ok(data)) throw new ApiError(502, '响应格式异常 · 不是预期的 JSON', {}, null)
  return data
}

const overview = useLive<OverviewPayload>(
  async (signal) => shaped(
    await request<OverviewPayload>(`/api/overview?range=${fetchRange.value}`, { signal }),
    (d) => Array.isArray(d.gateway?.series?.requests) && Array.isArray(d.channels?.rows) && Array.isArray(d.keys?.rows),
  ),
  { intervalMs: 15_000, enabled: () => !overviewMissing.value },
)
watch(overview.error, (err) => {
  // stop asking after a 404 and draw 实时 (pulse) only; useLive keeps the timer disarmed once enabled() is false
  if (err && errorStatus(err) === 404) overviewMissing.value = true
})
watch(fetchRange, () => void overview.refresh())
const shared = useSharedAdminLive()
/** own pulse only (outside the shell): true after a 404 from a server without /api/pulse — stop asking */
const pulseMissing = ref(false)
const pulse = shared?.pulse ?? useLive(async (signal) => shaped(await api.pulse(signal), (d) => Array.isArray(d.samples)), { intervalMs: 2_000, enabled: () => !pulseMissing.value })
watch(pulse.error, (err) => {
  if (err && errorStatus(err) === 404) pulseMissing.value = true
})

const effectiveRange = computed<ScopeRange>(() => (overviewMissing.value ? 'live' : selectedRange.value))
const gatewayState = computed<DataState>(() => {
  if (effectiveRange.value === 'live') return pulse.state.value
  return overview.state.value
})
const gatewayError = computed(() => (effectiveRange.value === 'live' ? pulse.error.value : overview.error.value))
const gatewayAt = computed(() => (effectiveRange.value === 'live' ? pulse.lastAt.value : overview.lastAt.value))
function setRange(value: ScopeRange) {
  scope.state.range = value
}

/* ── state sources (Key ledger, accounts, channels, sync, kernel) ─────────────────────────────── */
const boot = useLive(async (_signal) => shaped(await api.bootstrap<{ keys: ApiKeyItem[] }>(), (d) => Array.isArray(d.keys)), { intervalMs: 60_000, isEmpty: (d) => !d.keys.length })
const monitor = useLive(async (_signal) => shaped(await api.monitor<MonitorData>(), (d) => d.accounts === undefined || Array.isArray(d.accounts)), { intervalMs: 60_000, isEmpty: (d) => !(d.accounts ?? []).length })
const channels = useLive(async (_signal) => shaped(await api.channels<ChannelsData>(), (d) => Array.isArray(d.channels)), { intervalMs: 60_000 })
const sync = shared?.sync ?? useLive(async (signal) => shaped(await api.sync.status(signal), (d) => Array.isArray(d.jobs)), { intervalMs: 30_000 })
const versions = shared?.versions ?? useLive(async (_signal) => shaped(await api.version(), () => true), { intervalMs: 5 * 60_000 })
/** no registered jobs reads as the plate's empty state (the shared source does not classify emptiness) */
const syncState = computed<DataState>(() => (sync.state.value === 'ready' && !(sync.data.value?.jobs?.length) ? 'empty' : sync.state.value))

/* ── 近 24 小时 ledger: the 用量 endpoints at days=1 (+ days=8 for the 7-day baseline) ─────────── */
type LedgerData = {
  d1: DashboardData
  d8: DashboardData | null
  u1: UsageOverviewData | null
  u8: UsageOverviewData | null
  cache: CacheTrendData | null
  /** null when /api/cache-summary is not served yet (404) or failed: the ledger falls back to the labelled trend */
  cacheSummary: CacheSummaryLike | null
  charts: ChartsData | null
}
const settle = <T,>(p: PromiseSettledResult<T>): T | null => (p.status === 'fulfilled' ? p.value : null)
const ledgerLive = useLive<LedgerData>(async () => {
  const [d1, d8, u1, u8, cache, cacheSummary, charts] = await Promise.allSettled([
    api.dashboard<DashboardData>(1),
    api.dashboard<DashboardData>(8),
    api.usageOverview<UsageOverviewData>(1),
    api.usageOverview<UsageOverviewData>(8),
    api.cacheTrend<CacheTrendData>(24),
    // the 缓存 tab's figure (cache-capable models only), so the two pages never disagree
    request<CacheSummaryLike>('/api/cache-summary?days=1'),
    api.charts<ChartsData>(1),
  ])
  if (d1.status === 'rejected') throw d1.reason
  const series = (d: DashboardData | null) => (d && Array.isArray(d.trend) && d.summary ? d : null)
  const usage = (d: UsageOverviewData | null) => (d && typeof d.requests === 'number' ? d : null)
  const c = settle(cache)
  const cs = settle(cacheSummary)
  const ch = settle(charts)
  return {
    d1: shaped(d1.value, (d) => series(d) !== null),
    d8: series(settle(d8)),
    u1: usage(settle(u1)),
    u8: usage(settle(u8)),
    cache: c && Array.isArray(c.points) ? c : null,
    cacheSummary: cs && cs.totals && typeof cs.totals === 'object' ? cs : null,
    charts: ch && typeof ch === 'object' ? ch : null,
  }
}, { intervalMs: 60_000 })

/* ── model ───────────────────────────────────────────────────────────────────────────────────── */
const keys = computed(() => boot.data.value?.keys ?? null)
const accounts = computed(() => (monitor.data.value ? ((monitor.data.value.accounts ?? []) as MonitorAccount[]) : null))
const channelList = computed(() => channels.data.value?.channels ?? null)
const jobs = computed(() => sync.data.value?.jobs ?? null)

const health = computed(() => channelHealth(overview.data.value?.channels.rows ?? null, channelList.value))
const healthState = computed(() => (overview.data.value ? 'ready' : overviewMissing.value ? 'missing' : 'pending'))

const att = computed(() =>
  attention({
    now: now.value,
    keys: keys.value,
    accounts: accounts.value,
    channels: channelList.value,
    health: overview.data.value ? health.value : null,
    jobs: jobs.value,
    versions: versions.data.value ?? null,
  }),
)
/** the kind column reads Chinese (渠道 · 内核 …); the model keeps its stable codes */
const attItems = computed(() => att.value.items.map((it) => ({ ...it, kind: kindWord(it.kind) })))
const attRecovered = computed(() => att.value.recovered.map((it) => ({ ...it, kind: kindWord(it.kind) })))
const press = computed(() => (accounts.value ? pressureRows(accounts.value, now.value) : []))
const sev = computed(() => severityWords(att.value.counts))

const attState = computed<DataState>(() => {
  const sources = [boot, monitor, channels, sync, versions]
  if (sources.every((s) => s.state.value === 'loading')) return 'loading'
  if (sources.every((s) => s.state.value === 'error')) return 'error'
  return 'ready'
})
/** 全部正常 only when every source the attention list is built from was read (FF-07) */
const insp = computed(() => inspection([
  { label: 'Key', state: boot.state.value },
  { label: '账号', state: monitor.state.value },
  { label: '渠道', state: channels.state.value },
  { label: '同步', state: syncState.value },
  { label: '内核', state: versions.state.value },
  // channel error-rate items come from /api/overview; a server without the route (404) has no health to read
  ...(overviewMissing.value ? [] : [{ label: '渠道健康', state: overview.state.value }]),
]))
const attEmpty = computed(() => {
  if (insp.value.state === 'complete') return '● 全部正常 · 没有需要处理的事项'
  if (insp.value.state === 'loading') return `${insp.value.words}`
  return `◇ ${insp.value.words} · 已读到的部分没有待办`
})
const attError = computed(() => boot.error.value ?? monitor.error.value ?? channels.error.value ?? sync.error.value)

const gatewayCheck = computed(() => {
  const o = overview.data.value
  if (!o) return null
  return { requests: o.gateway.requests, successRate: o.gateway.successRate, window: `近 ${o.range} ` }
})
const checkRows = computed(() =>
  checks({
    attention: att.value,
    gateway: gatewayCheck.value,
    pulse: pulse.data.value ? { rpm: pulse.data.value.rpm, successRate: pulse.data.value.successRate } : null,
    keys: keys.value,
    accounts: accounts.value ? press.value : null,
    channels: channelList.value,
    health: overview.data.value ? health.value : null,
    jobs: jobs.value,
    versions: versions.data.value ?? null,
  }),
)

const hours = computed(() => {
  const rows = overview.data.value?.keys.rows
  return rows ? new Map(rows.map((r) => [r.id, r])) : null
})
const burn = computed(() => (keys.value ? burnRows(keys.value, hours.value, now.value) : []))
const enabledKeys = computed(() => (keys.value ? keys.value.filter((k) => k.enabled).length : null))

const ledgerCells = computed(() => {
  const d = ledgerLive.data.value
  return ledger({ now: now.value, d1: d?.d1, d8: d?.d8, u1: d?.u1, u8: d?.u8, cache: d?.cache, cacheSummary: d?.cacheSummary, charts: d?.charts })
})
const ledgerAsOf = computed(() => {
  const at = ledgerLive.data.value?.d1.generatedAt ?? ledgerLive.lastAt.value
  return at ? fmtTime(at) : null
})

const lanes = computed(() => laneJobs(jobs.value ?? []))
const policy = computed(() => policyWords(sync.data.value?.policy))

const kernel = computed(() => {
  const cpa = versions.data.value?.cpa
  if (!cpa) return null
  const engine = cpa.engine === 'magpie' ? 'magpie' : 'cpa'
  if (cpa.version === 'offline') return `${engine} 离线`
  return `${engine} ${cpa.commit && cpa.commit !== 'unknown' ? cpa.commit.slice(0, 7) : cpa.version}`
})

/* ── nav badges ───────────────────────────────────────────────────────────────────────────────── */
watchEffect(() => {
  const by = (domain: string) => att.value.items.filter((it) => it.domain === domain && it.severity !== 'note').length
  setNavCount('keys', by('key'))
  setNavCount('accounts', by('acct'))
  setNavCount('channels', by('chan'))
})
onBeforeUnmount(() => {
  for (const id of ['keys', 'accounts', 'channels']) setNavCount(id, null)
})

/** no OAuth accounts at all: the pressure plate is one line, so it takes its own row instead of leaving a dead band */
const noAccounts = computed(() => monitor.state.value === 'empty')
const ledgerCols = computed(() => (width.value >= 1180 ? 6 : isMobile.value ? 2 : 3))
</script>

<template>
  <div class="ui-page ov">
    <PageHead title="概览">
      <template #status>
        <span class="ov-head">
          <span v-if="sev.length" class="ov-head__sev">
            <span v-for="(s, i) in sev" :key="s.text" :class="{ sig: s.hot }"><template v-if="i"> · </template>{{ s.mark }} {{ s.text }}</span>
          </span>
          <!-- 全部正常 only when every source was read (insp); otherwise say what is missing -->
          <template v-if="insp.state === 'complete'"><span v-if="!sev.length" class="ov-head__ok">● 全部正常</span></template>
          <span v-else-if="insp.state === 'loading'" class="dim">{{ insp.words }}</span>
          <span v-else class="ov-head__gap" :class="{ sig: insp.state === 'failed' }">{{ insp.state === 'failed' ? '◆' : '◇' }} {{ insp.words }}</span>
        </span>
      </template>
      <template #live>
        <LiveMark :state="attState === 'loading' ? 'loading' : syncState" :last-at="sync.lastAt.value" :interval-ms="sync.intervalMs" @retry="sync.refresh" />
      </template>
    </PageHead>

    <div class="ui-grid ov-grid">
      <Plate title="需要处理" class="c-5 md-c-6 stretch ov-att" :state="attState" :error="attError" :rows="5" :cols="['14px', '32px', '1fr', '64px']" @retry="boot.refresh(); monitor.refresh(); channels.refresh(); sync.refresh()">
        <AttentionList :items="attItems" :recovered="attRecovered" :max="7" :empty-text="attEmpty" />
        <ChecksList v-if="!isMobile || att.items.length < 3" :rows="checkRows" />
      </Plate>

      <GatewayPlate
        class="c-7 md-c-6 stretch"
        :range="effectiveRange"
        :ranges-available="!overviewMissing"
        :overview="effectiveRange === 'live' ? null : overview.data.value ?? null"
        :pulse="pulse.data.value ?? null"
        :state="gatewayState"
        :error="gatewayError"
        :stale-at="gatewayAt"
        :health="health"
        :health-state="healthState"
        :kernel="kernel"
        :magpie="versions.data.value?.cpa.gateway ?? null"
        :enabled-keys="enabledKeys"
        @update:range="setRange"
        @retry="effectiveRange === 'live' ? pulse.refresh() : overview.refresh()"
      />

      <Plate title="近 24 小时" class="c-12 ov-ledger" :state="ledgerLive.state.value" :error="ledgerLive.error.value" :stale-at="ledgerLive.lastAt.value" :rows="2" @retry="ledgerLive.refresh">
        <template #meta>
          <span>对比前 7 日日均 · 全部渠道<template v-if="ledgerAsOf"> · 截至 {{ ledgerAsOf }}</template></span>
          <RouterLink to="/usage?days=1" class="ui-link">用量 →</RouterLink>
        </template>
        <div class="ov-ledger__grid" :style="{ '--cols': ledgerCols }">
          <Readout
            v-for="c in ledgerCells"
            :key="c.key"
            :label="c.label"
            :value="c.value"
            :delta="c.delta"
            :history="c.history"
            :state="ledgerLive.state.value === 'stale' ? 'stale' : 'ready'"
          >
            <template v-if="c.sub && !c.delta" #sub><span class="ov-ledger__sub">{{ c.sub }}</span></template>
            <template v-else-if="c.sub" #sub><span class="ov-ledger__sub ov-ledger__sub--2">{{ c.sub }}</span></template>
          </Readout>
        </div>
      </Plate>

      <KeyBurnPlate
        :class="noAccounts ? 'c-12' : 'c-7 md-c-7 stretch'"
        :rows="burn"
        :state="boot.state.value"
        :error="boot.error.value"
        :stale-at="boot.lastAt.value"
        :hours-available="Boolean(hours)"
        :full="noAccounts"
        @retry="boot.refresh"
      />

      <PressurePlate :class="noAccounts ? 'c-12' : 'c-5 md-c-5 stretch'" :rows="press" :state="monitor.state.value" :error="monitor.error.value" :stale-at="monitor.lastAt.value" @retry="monitor.refresh" />

      <Plate title="后台同步" class="c-12 ov-sync" :state="syncState" :error="sync.error.value" :stale-at="sync.lastAt.value" :rows="6" empty-text="没有同步任务" @retry="sync.refresh">
        <template #meta>
          <span v-if="policy && !isMobile">{{ policy }}</span>
          <RouterLink to="/settings#sync" class="ui-link">同步中心 →</RouterLink>
        </template>
        <TimingLanes :jobs="lanes" :from-hours="isMobile ? 6 : 24" :to-hours="isMobile ? 1 : 2" />
      </Plate>
    </div>
  </div>
</template>

<style>
.ov-head { display: inline-flex; flex-wrap: wrap; align-items: baseline; gap: 2px 14px; }
.ov-head__ok, .ov-head__gap, .ov-head__sev { color: var(--ink-2); }
.ov-head__gap.sig { color: var(--signal-ink); }
/* ledger: six readouts on one row (3 × 2 at md, 2 × 3 on a phone); spacing separates them, no cell rules */
.ov-ledger__grid { display: grid; grid-template-columns: repeat(var(--cols, 6), minmax(0, 1fr)); gap: 16px 28px; padding: 4px 0 2px; }
.ov-ledger__grid > .ui-ro { align-content: start; }
.ov-ledger__sub { font-family: var(--font-sans); color: var(--ink-3); }
.ov-ledger__sub--2 { display: block; margin-top: 2px; }
.ov-sync .ui-lanes__name { white-space: nowrap; }
@media (max-width: 599px) {
  .ov-ledger__grid { gap: 14px 16px; }
}
</style>
