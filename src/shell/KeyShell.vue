<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { RouterView, useRoute } from 'vue-router'
import AppShell from '../ui/shell/AppShell.vue'
import { api } from '../api'
import { KEY_NAV, navItemFor } from '../app/nav'
import { loadSession, session, sessionIdentity } from '../app/session'
import { errorMessage } from '../lib/errors'
import { useLive } from '../ui/composables/useLive'
import { copyText, notify } from '../ui/feedback/toast'
import { fmtPct, fmtUsd } from '../ui/fmt'
import { useLogout } from './logout'
import { registeredCommands } from './palette'
import { callableCount } from '../features/me/meModel'
import type { MeModels, MeOverview } from '../types'
import type { CommandItem, ShellStatus, StatusKind } from '../ui/types'

/**
 * Key-user chrome (DESIGN §4.3): `CROSERY / my key`, rail 01 概览 02 用量 03 模型 04 接入, no mask, no sync,
 * no gateway trace (ruler only). The statusline / ticker keep today's spend vs. the daily limit in view.
 */
const route = useRoute()
const logout = useLogout()

const me = useLive<MeOverview>((signal) => api.me.overview(signal), { intervalMs: 30_000 })
const models = useLive<MeModels>((signal) => api.me.models(signal), { intervalMs: 5 * 60_000 })

/*
 * The cookie is shared by every tab. The page below is keyed on the signed-in key and remounts when it changes,
 * so no rows or paging cursor of the previous key carry over. A sign-out (empty identity) does not remount: the
 * router leaves instead. If /api/me answers for a different key than this tab thinks it holds, another tab signed
 * in as someone else: re-probe (cross-tab announcements usually get here first).
 */
const pageKey = ref(sessionIdentity.value)
watch(sessionIdentity, (identity) => {
  if (identity) pageKey.value = identity
})
watch(
  () => me.data.value?.key,
  (key) => {
    const known = session.key
    const other = key && known && (key.ref && known.ref ? key.ref !== known.ref : key.name !== known.name || key.masked !== known.masked)
    if (other) void loadSession(true)
  },
)

/** The key's mark for the header chip: usable · 停用 · 超额停用 · 陈旧 (refresh failing); nothing until known. */
function keyMark(data: MeOverview | undefined): { state: StatusKind | null; stateLabel: string | null } {
  const live = me.state.value
  if (!data) return { state: live === 'error' ? 'stale' : null, stateLabel: live === 'error' ? '读取失败' : null }
  if (live === 'stale') return { state: 'stale', stateLabel: '陈旧' }
  const quota = data.quota
  const exceeded = quota.daily.exceeded || quota.weekly.exceeded || quota.total.exceeded
  if (!data.key.enabled) return data.key.blockedReason || exceeded ? { state: 'bad', stateLabel: '超额停用' } : { state: 'off', stateLabel: '停用' }
  if (exceeded) return { state: 'bad', stateLabel: '超额' }
  return { state: 'run', stateLabel: '可用' }
}

const status = computed<ShellStatus>(() => {
  const data = me.data.value
  const name = data?.key.name ?? session.key?.name ?? ''
  if (!name) return {}
  const daily = data?.quota.daily
  return {
    key: {
      name,
      masked: data?.key.masked ?? session.key?.masked ?? null,
      ...keyMark(data),
      // quota spend is what the daily limit is measured against
      today: daily ? fmtUsd(daily.spentUsd) : null,
      limit: daily?.limitUsd != null ? fmtUsd(daily.limitUsd) : null,
      week: data?.quota.weekly.ratio != null ? fmtPct(data.quota.weekly.ratio, 0) : null,
      // unknown (gateway unreadable) is no count at all, never 0
      models: callableCount(models.data.value),
    },
  }
})

const current = computed(() => navItemFor(route.path, KEY_NAV))
const title = computed(() => (route.meta.title as string | undefined) ?? current.value?.label ?? '')

async function copyBaseUrl() {
  try {
    const connect = await api.me.connect()
    await copyText(connect.baseUrl, 'Base URL')
  } catch (error) {
    notify(`◆ 读取接入地址失败 · ${errorMessage(error) || '稍后重试'}`, { tone: 'warn', id: 'cx-copy' })
  }
}

const commands = computed<CommandItem[]>(() => [
  { id: 'act:copy-base', title: '复制 Base URL', section: 'ACT', keywords: ['base url', '接入', 'copy'], run: () => void copyBaseUrl() },
  ...registeredCommands.value,
  { id: 'act:logout', title: '退出', section: 'ACT', keywords: ['logout'], run: () => void logout() },
])
</script>

<template>
  <AppShell role="key" :nav="KEY_NAV" :tabs="KEY_NAV" :status="status" :commands="commands" :title="title" @logout="logout">
    <RouterView v-slot="{ Component }">
      <component :is="Component" :key="pageKey" />
    </RouterView>
  </AppShell>
</template>
