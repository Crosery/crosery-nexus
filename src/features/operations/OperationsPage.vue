<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import { TxStatCard } from '@talex-touch/tuffex/stat-card'
import PageHead from '../../ui/shell/PageHead.vue'
import LiveMark from '../../ui/shell/LiveMark.vue'
import Plate from '../../ui/data/Plate.vue'
import Pii from '../../ui/data/Pii.vue'
import StatusMark from '../../ui/data/StatusMark.vue'
import { useLive } from '../../ui/composables/useLive'
import { useSkinPref } from '../../lib/skin'
import { fmtInt } from '../../ui/fmt'
import { api } from '../../api'
import { useSharedAdminLive } from '../../shell/useAdminStatus'
import { chipState } from '../../shell/statusModel'
import type { ApiKeyItem, ChannelItem, ChannelsData, MonitorData, SyncJob, SyncStatus, VersionsData } from '../../types'
import type { MonitorAccount } from './types'
import type { DataState, StatusKind } from '../../ui/types'

type StatusRow = { kind: StatusKind; label: string }

type AccountRow = {
  name: string
  detail: string
  status: StatusRow
}

const { pref: skin } = useSkinPref()
const shared = useSharedAdminLive()
const sync = shared?.sync ?? useLive<SyncStatus>(() => api.sync.status(), { intervalMs: 30_000 })
const versions = shared?.versions ?? useLive<VersionsData>(() => api.version(), { intervalMs: 5 * 60_000 })
const keys = useLive<{ keys: ApiKeyItem[] }>(() => api.bootstrap<{ keys: ApiKeyItem[] }>(), {
  intervalMs: 60_000,
  isEmpty: (data) => !data.keys.length,
})
const accounts = useLive<MonitorData>(() => api.monitor<MonitorData>(), {
  intervalMs: 60_000,
  isEmpty: (data) => !(data.accounts ?? []).length,
})
const channels = useLive<ChannelsData>(() => api.channels<ChannelsData>(), {
  intervalMs: 60_000,
  isEmpty: (data) => !data.channels.length,
})

function accountStatus(account: MonitorAccount): StatusRow {
  const status = String(account.status ?? '').toLowerCase()
  if (account.disabled) return { kind: 'off', label: '已停用' }
  if (account.unavailable || /error|fail|blocked|offline/.test(status)) return { kind: 'bad', label: '不可用' }
  if (account.quota?.error || /cool|retry|rate/.test(status)) return { kind: 'warn', label: '需处理' }
  if (/active|running|ready|ok|healthy/.test(status)) return { kind: 'run', label: '正常' }
  return { kind: 'idle', label: '已读取' }
}

function accountRows(data: MonitorData | undefined): AccountRow[] {
  return ((data?.accounts ?? []) as MonitorAccount[]).map((account, index) => ({
    name: account.name || account.email || account.account || account.provider || `账号 ${index + 1}`,
    detail: account.status_message || (account.next_retry_after ? `下次重试 ${account.next_retry_after}` : account.provider || '状态已读取'),
    status: accountStatus(account),
  }))
}

const accountList = computed(() => accountRows(accounts.data.value))
const channelList = computed<ChannelItem[]>(() => channels.data.value?.channels ?? [])
const jobs = computed<SyncJob[]>(() => sync.data.value?.jobs ?? [])
const enabledKeys = computed(() => (keys.data.value?.keys ?? []).filter((key) => key.enabled).length)
const enabledChannels = computed(() => channelList.value.filter((channel) => channel.enabled).length)
const accountAttention = computed(() => accountList.value.filter((row) => row.status.kind === 'bad' || row.status.kind === 'warn').length)
const runningJobs = computed(() => jobs.value.filter((job) => job.state === 'running').length)
const failedJobs = computed(() => jobs.value.filter((job) => ['failed', 'backoff'].includes(chipState(job))).length)
const accountCount = computed(() => accounts.data.value ? accountList.value.length : null)
const syncSummary = computed(() => {
  if (sync.state.value === 'loading') return '读取中'
  if (sync.state.value === 'forbidden') return '无权限'
  if (sync.state.value === 'error') return '读取失败'
  if (sync.state.value === 'stale') return '数据已过期'
  if (!jobs.value.length) return '没有同步任务'
  if (failedJobs.value) return `${failedJobs.value} 个需处理`
  if (runningJobs.value) return `${runningJobs.value} 个运行中`
  return jobs.value.some(job => chipState(job) === 'idle') ? '包含未运行或停用任务' : '全部正常'
})

function readStatus(state: DataState): StatusRow | null {
  if (state === 'loading') return { kind: 'busy', label: '读取中' }
  if (state === 'forbidden') return { kind: 'warn', label: '无权限' }
  if (state === 'error') return { kind: 'bad', label: '读取失败' }
  if (state === 'stale') return { kind: 'warn', label: '数据已过期' }
  return null
}

const overallState = computed<DataState>(() => {
  const states = [sync.state.value, versions.state.value, accounts.state.value, channels.state.value, keys.state.value]
  if (states.includes('forbidden')) return 'forbidden'
  if (states.includes('error')) return 'error'
  if (states.includes('stale')) return 'stale'
  if (states.includes('loading')) return 'loading'
  return 'ready'
})
const overallError = computed(() => sync.error.value ?? versions.error.value ?? accounts.error.value ?? channels.error.value ?? keys.error.value)

const systemRows = computed(() => {
  const kernel = versions.data.value?.cpa
  const kernelStatus = readStatus(versions.state.value)
    ?? (kernel?.version === 'offline' ? { kind: 'bad' as const, label: '离线' }
      : kernel?.version && kernel.version !== 'unknown' ? { kind: 'run' as const, label: '控制面可访问' }
        : { kind: 'idle' as const, label: '状态未知' })
  const channelStatus = readStatus(channels.state.value)
    ?? { kind: 'idle' as const, label: '配置已读取' }
  return [
    {
      label: '网关',
      value: kernelStatus.label,
      status: kernelStatus,
    },
    {
      label: '内核',
      value: kernel ? `CPA ${kernel.version}` : kernelStatus.label,
      status: kernelStatus,
    },
    {
      label: '同步中心',
      value: syncSummary.value,
      status: readStatus(sync.state.value) ?? { kind: failedJobs.value ? 'warn' as const : runningJobs.value ? 'busy' as const : 'idle' as const, label: syncSummary.value },
    },
    {
      label: '渠道配置',
      value: readStatus(channels.state.value)?.label ?? `${enabledChannels.value}/${channelList.value.length} 已启用`,
      status: channelStatus,
    },
  ]
})

const jobStatus = (job: SyncJob): StatusRow => {
  const state = chipState(job)
  if (state === 'running') return { kind: 'busy', label: '运行中' }
  if (state === 'failed' || state === 'backoff') return { kind: 'warn', label: '需处理' }
  if (job.state === 'disabled') return { kind: 'off', label: '已停用' }
  if (state === 'idle') return { kind: 'idle', label: '尚未运行' }
  return { kind: 'run', label: '正常' }
}
</script>

<template>
  <div class="ui-page ops-page">
    <PageHead title="运营数据">
      <template #status>
        <span class="ops-head">账号 {{ fmtInt(accountCount) }} · Key {{ fmtInt(keys.data.value?.keys.length ?? null) }} · 渠道 {{ fmtInt(channels.data.value ? channelList.length : null) }}</span>
      </template>
      <template #live>
        <LiveMark :state="overallState" :last-at="sync.lastAt.value" :interval-ms="sync.intervalMs" @retry="sync.refresh" />
      </template>
    </PageHead>

    <section class="ops-kpis" aria-label="运营核心指标">
      <TxStatCard
        v-if="skin === 'minimal'"
        label="账号总数"
        :value="fmtInt(accountCount)"
        icon-class="i-carbon-user"
        :meta="readStatus(accounts.state.value)?.label ?? (accountAttention ? `${accountAttention} 个需处理` : '全部已读取')"
        class="ops-kpi ops-kpi--acc"
      />
      <TxStatCard
        v-if="skin === 'minimal'"
        label="上游渠道"
        :value="fmtInt(channels.data.value ? channelList.length : null)"
        icon-class="i-carbon-network-4"
        :meta="readStatus(channels.state.value)?.label ?? `${fmtInt(enabledChannels)} 个已启用`"
        class="ops-kpi ops-kpi--chan"
      />
      <TxStatCard
        v-if="skin === 'minimal'"
        label="API Key"
        :value="fmtInt(keys.data.value?.keys.length ?? null)"
        icon-class="i-carbon-password"
        :meta="readStatus(keys.state.value)?.label ?? `${fmtInt(enabledKeys)} 个已启用`"
        class="ops-kpi ops-kpi--key"
      />
      <TxStatCard
        v-if="skin === 'minimal'"
        label="后台任务"
        :value="fmtInt(sync.data.value ? jobs.length : null)"
        icon-class="i-carbon-task"
        :meta="syncSummary"
        class="ops-kpi ops-kpi--sync"
      />
      <Plate v-else title="运行概览" class="ops-summary" :state="overallState" :error="overallError" :rows="2" @retry="sync.refresh">
        <dl class="ops-stats">
          <div><dt>账号</dt><dd class="num">{{ fmtInt(accountCount) }}</dd><small>{{ accountAttention ? `${accountAttention} 个需处理` : '全部已读取' }}</small></div>
          <div><dt>渠道</dt><dd class="num">{{ fmtInt(channelList.length) }}</dd><small>{{ fmtInt(enabledChannels) }} 个已启用</small></div>
          <div><dt>Key</dt><dd class="num">{{ fmtInt(keys.data.value?.keys.length ?? null) }}</dd><small>{{ fmtInt(enabledKeys) }} 个已启用</small></div>
          <div><dt>后台任务</dt><dd class="num">{{ fmtInt(jobs.length) }}</dd><small>{{ runningJobs ? `${runningJobs} 个运行中` : '暂无运行中' }}</small></div>
        </dl>
      </Plate>
    </section>

    <div class="ops-grid">
      <Plate title="账号运行状态" class="ops-col ops-accounts" :state="accounts.state.value" :error="accounts.error.value" :rows="6" empty-text="还没有账号" @retry="accounts.refresh">
        <template #actions><RouterLink to="/accounts" class="ui-link">账号页 →</RouterLink></template>
        <ul class="ops-list">
          <li v-for="(row, index) in accountList.slice(0, 8)" :key="index" class="ops-list__row">
            <span class="ops-list__name"><Pii :value="row.name" /></span>
            <StatusMark :state="row.status.kind" :label="row.status.label" />
            <span class="ops-list__detail"><Pii :value="row.detail" /></span>
          </li>
        </ul>
      </Plate>

      <Plate title="系统运行状态" class="ops-col ops-system" :state="overallState" :error="overallError" :rows="5" @retry="sync.refresh">
        <template #actions><RouterLink to="/settings" class="ui-link">系统设置 →</RouterLink></template>
        <dl class="ops-system__list">
          <div v-for="row in systemRows" :key="row.label"><dt>{{ row.label }}</dt><dd><StatusMark :state="row.status.kind" :label="row.status.label" /><span class="ops-system__value">{{ row.value }}</span></dd></div>
        </dl>
      </Plate>

      <Plate title="后台同步任务" class="ops-col-full ops-jobs" :state="sync.state.value" :error="sync.error.value" :rows="6" empty-text="没有同步任务" @retry="sync.refresh">
        <template #actions><RouterLink to="/settings#sync" class="ui-link">同步中心 →</RouterLink></template>
        <ul class="ops-list ops-list--jobs">
          <li v-for="job in jobs" :key="job.id" class="ops-list__row">
            <span class="ops-list__name">{{ job.label }}</span>
            <StatusMark :state="jobStatus(job).kind" :label="jobStatus(job).label" />
            <span class="ops-list__detail">{{ job.summary || job.kind }}</span>
          </li>
        </ul>
      </Plate>
    </div>
  </div>
</template>

<style>
.ops-page { gap: 22px; }
.ops-head { color: var(--ink-2); font-size: var(--fs-sm); }
.ops-grid { display: grid; grid-template-columns: repeat(12, minmax(0, 1fr)); gap: 22px var(--gutter); align-items: start; }
.ops-summary, .ops-jobs { grid-column: 1 / -1; }
.ops-accounts { grid-column: span 7; }
.ops-system { grid-column: span 5; }
.ops-stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 18px; margin: 0; }
.ops-stats > div { min-width: 0; }
.ops-stats dt { color: var(--ink-3); font-size: var(--fs-xs); }
.ops-stats dd { margin: 4px 0 2px; color: var(--ink); font-size: var(--fs-xl); line-height: 1.1; }
.ops-stats small { color: var(--ink-3); font-size: var(--fs-xs); }
.ops-list, .ops-system__list { list-style: none; margin: 0; padding: 0; }
.ops-list__row { display: grid; grid-template-columns: minmax(120px, 1fr) auto minmax(0, 1.8fr); align-items: center; gap: 12px; min-height: 42px; border-bottom: 1px solid var(--rule); }
.ops-list__row:last-child { border-bottom: 0; }
.ops-list__name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ink); }
.ops-list__detail { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ink-3); font-size: var(--fs-xs); text-align: right; }
.ops-system__list { display: grid; gap: 2px; margin-bottom: 14px; }
.ops-system__list > div { display: grid; grid-template-columns: 88px minmax(0, 1fr); align-items: center; min-height: 38px; border-bottom: 1px solid var(--rule); }
.ops-system__list dt { color: var(--ink-2); font-size: var(--fs-sm); }
.ops-system__list dd { display: flex; align-items: center; justify-content: flex-end; gap: 10px; margin: 0; }
.ops-system__value { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ink-3); font-size: var(--fs-xs); }
@media (max-width: 959px) {
  .ops-accounts, .ops-system { grid-column: 1 / -1; }
  .ops-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 599px) {
  .ops-grid { gap: 16px; }
  .ops-stats { gap: 16px; }
  .ops-list__row { grid-template-columns: minmax(96px, 1fr) auto; }
  .ops-list__detail { grid-column: 1 / -1; padding: 0 0 8px; text-align: left; }
  .ops-system__list > div { grid-template-columns: 74px minmax(0, 1fr); }
}
</style>
