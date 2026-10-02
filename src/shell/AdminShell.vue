<script setup lang="ts">
import { computed } from 'vue'
import { RouterView, useRoute, useRouter } from 'vue-router'
import AppShell from '../ui/shell/AppShell.vue'
import { api } from '../api'
import { ADMIN_MORE_IDS, ADMIN_NAV, ADMIN_TAB_IDS, NAV_GROUP_LABEL, navItemFor, type AppNavItem } from '../app/nav'
import { session } from '../app/session'
import { errorMessage } from '../lib/errors'
import { useNow, fmtCountdownClock, toMs } from '../ui/composables/useNow'
import { notify } from '../ui/feedback/toast'
import { navCounts } from './badges'
import { useLogout } from './logout'
import { registeredCommands } from './palette'
import { useAdminStatus } from './useAdminStatus'
import type { SyncJob } from '../types'
import type { CommandItem, UserMenuItem } from '../ui/types'

/**
 * Admin chrome (DESIGN §4.1, §4.2, §4.4): the kit AppShell fed with the IA, live status, attention counts and
 * the ⌘K actions. ≥960 top rail + statusline; <960 top bar + ticker + tab bar 概览·账号·Key·用量·更多.
 */
const route = useRoute()
const router = useRouter()
const logout = useLogout()
const now = useNow()
const { status, samples, traceStale, jobs, syncAttention, refreshSync } = useAdminStatus()

const withCount = (item: AppNavItem): AppNavItem => {
  const count = navCounts[item.id] ?? (item.id === 'settings' ? syncAttention.value : 0)
  return count ? { ...item, count } : item
}
const nav = computed(() => ADMIN_NAV.map(withCount))
const byId = computed(() => new Map(nav.value.map((item) => [item.id, item])))
const tabs = computed(() => ADMIN_TAB_IDS.map((id) => byId.value.get(id)).filter((item): item is AppNavItem => Boolean(item)))
const moreGroups = computed(() =>
  ADMIN_MORE_IDS.map((group) => ({
    label: NAV_GROUP_LABEL[group.group],
    items: group.ids.map((id) => byId.value.get(id)).filter((item): item is AppNavItem => Boolean(item)),
  })),
)

const current = computed(() => navItemFor(route.path))
const title = computed(() => (route.meta.title as string | undefined) ?? current.value?.label ?? '')

const userMenu: UserMenuItem[] = [
  { id: 'session', label: '会话信息', to: '/settings#session' },
  { id: 'settings', label: '设置', to: '/settings' },
  { id: 'logout', label: '退出', danger: true, run: () => void logout() },
]

async function runSync(job: SyncJob) {
  try {
    await api.sync.run(job.id)
    notify(`已开始 · ${job.label}`, { tone: 'ok', id: `cx-sync-${job.id}` })
  } catch (error) {
    const code = (error as { code?: string | null }).code
    const retry = (error as { retryAfterSec?: number | null }).retryAfterSec
    if (code === 'cooldown') notify(`◇ ${job.label} 冷却中${retry ? ` · ${fmtCountdownClock(retry * 1000)} 后再试` : ''}`, { tone: 'warn', id: `cx-sync-${job.id}` })
    else if (code === 'running') notify(`◇ ${job.label} 正在同步`, { tone: 'note', id: `cx-sync-${job.id}` })
    else notify(`◆ ${job.label} · ${errorMessage(error) || '同步请求失败'}`, { tone: 'bad', id: `cx-sync-${job.id}` })
  } finally {
    void refreshSync()
  }
}

function syncCommand(job: SyncJob): CommandItem | null {
  if (job.kind === 'external' || job.state === 'disabled') return null
  const cooling = toMs(job.runCooldownUntil)
  const backoff = toMs(job.backoffUntil)
  // data-plane is in-process but never manually runnable (own 5 s loop); only list jobs that can run now or will after cooldown/run.
  if (!job.canRunNow && job.state !== 'running' && !(cooling !== null && cooling > now.value)) return null
  let hint: string | undefined
  if (job.state === 'running') hint = '运行中'
  else if (cooling !== null && cooling > now.value) hint = `冷却 ${fmtCountdownClock(cooling - now.value)}`
  else if (job.state === 'backoff' && backoff !== null && backoff > now.value) hint = `退避 ${fmtCountdownClock(backoff - now.value)}`
  return {
    id: `act:sync:${job.id}`,
    title: `立即同步 ${job.label}`,
    section: 'ACT',
    keywords: ['同步', 'sync', job.id],
    hint,
    disabled: !job.canRunNow || job.state === 'running' || (cooling !== null && cooling > now.value),
    run: () => void runSync(job),
  }
}

const commands = computed<CommandItem[]>(() => [
  { id: 'act:add-account', title: '添加账号…', section: 'ACT', keywords: ['oauth', '授权', 'account'], run: () => void router.push({ path: '/accounts', query: { add: '1' } }) },
  { id: 'act:new-key', title: '新建 Key…', section: 'ACT', keywords: ['key', 'api key', '创建'], run: () => void router.push({ path: '/keys', query: { new: '1' } }) },
  ...jobs.value.map(syncCommand).filter((cmd): cmd is CommandItem => cmd !== null),
  ...registeredCommands.value,
  { id: 'act:logout', title: '退出登录', section: 'ACT', keywords: ['logout', 'sign out'], run: () => void logout() },
])
</script>

<template>
  <AppShell
    role="admin"
    :nav="nav"
    :tabs="tabs"
    :more-groups="moreGroups"
    :user="session.user ?? { name: 'admin' }"
    :user-menu="userMenu"
    :status="status"
    :samples="samples"
    :trace-stale="traceStale"
    :commands="commands"
    :title="title"
    :en="current?.en"
    @logout="logout"
  >
    <RouterView />
  </AppShell>
</template>
