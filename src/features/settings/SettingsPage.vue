<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { TxButton } from '@talex-touch/tuffex/button'
import PageHead from '../../ui/shell/PageHead.vue'
import LiveMark from '../../ui/shell/LiveMark.vue'
import Plate from '../../ui/data/Plate.vue'
import { api } from '../../api'
import { session } from '../../app/session'
import { useLogout } from '../../shell/logout'
import { useSharedAdminLive } from '../../shell/useAdminStatus'
import { useLive } from '../../ui/composables/useLive'
import { useThemePref } from '../../ui/composables/prefs'
import { confirmSheet } from '../../ui/feedback/confirmSheet'
import { notify } from '../../ui/feedback/toast'
import { errorMessage } from '../../lib/errors'
import type { SyncStatus, VersionsData } from '../../types'
import SyncCenter from './SyncCenter.vue'
import RtkRelaySection from './RtkRelaySection.vue'
import VersionSection from './VersionSection.vue'
import PrefsSection from './PrefsSection.vue'
import ProxySection from './ProxySection.vue'
import { syncTally } from './settingsModel'

/**
 * 设置 (DESIGN §6.8, BRIEF IA 系统): every background job and global switch in one place —
 * 同步中心 #sync · 网关 #gateway (#version lands there too) · 代理 #proxy · RTK 中转 #rtk-relay · 偏好 #prefs · 会话 #session.
 * Sources are the shell's (sync 30s, versions 5m): no second poll, and a write here (run-now, re-check) refreshes
 * the statusline with the same read. Outside the shell the page polls its own.
 */
const logout = useLogout()
const route = useRoute()
const router = useRouter()
const theme = useThemePref()

const shared = useSharedAdminLive()
const sync = shared?.sync ?? useLive<SyncStatus>((signal) => api.sync.status(signal), { intervalMs: 15_000 })
const versions = shared?.versions ?? useLive<VersionsData>(() => api.version(), { intervalMs: 0 })

const checking = ref(false)
async function recheck() {
  if (checking.value) return
  checking.value = true
  try {
    versions.data.value = await api.version(true)
    versions.error.value = null
    versions.lastAt.value = Date.now()
  } catch (error) {
    notify(`◆ 重新检测失败 · ${errorMessage(error) || '请求失败'}`, { tone: 'bad', id: 'cx-version' })
  } finally {
    checking.value = false
  }
}

const tally = computed(() => syncTally(sync.data.value?.jobs ?? []))

/** 代理 section's own read (it polls /api/proxies itself): its index word and status-line part */
const proxyIndex = ref<{ value: string; hot: boolean; status: string } | null>(null)
/** RTK 中转's own read (/api/rtk/relay): its index word */
const relayIndex = ref<{ value: string; hot: boolean } | null>(null)

const statusLine = computed(() => {
  const parts: string[] = []
  if (sync.data.value) {
    const t = tally.value
    const attn = [t.bad ? `失败 ${t.bad}` : '', t.warn ? `注意 ${t.warn}` : '', t.busy ? `运行 ${t.busy}` : ''].filter(Boolean)
    parts.push(t.total ? `${t.total} 个同步任务 · ${attn.length ? attn.join(' · ') : '全部正常'}` : '没有同步任务')
  }
  if (proxyIndex.value?.status) parts.push(proxyIndex.value.status)
  return parts.join(' · ')
})

const THEME_WORD = { light: '浅色', dark: '深色', system: '跟随' } as const
const toc = computed(() => [
  { id: 'sync', label: '同步中心', value: sync.data.value ? (tally.value.bad + tally.value.warn ? `◇ ${tally.value.bad + tally.value.warn}` : `${tally.value.total} 任务`) : '', hot: tally.value.bad + tally.value.warn > 0 },
  { id: 'gateway', label: '网关', value: '', hot: false },
  { id: 'proxy', label: '代理', value: proxyIndex.value?.value ?? '', hot: proxyIndex.value?.hot ?? false },
  { id: 'rtk-relay', label: 'RTK 中转', value: relayIndex.value?.value ?? '', hot: relayIndex.value?.hot ?? false },
  { id: 'prefs', label: '偏好', value: THEME_WORD[theme.pref.value], hot: false },
  { id: 'session', label: '会话', value: session.user?.name ?? 'admin', hot: false },
])

/* scroll spy: the index marks the last section whose head has passed a line just under the header */
const SECTIONS = ['sync', 'gateway', 'proxy', 'rtk-relay', 'prefs', 'session']
/** old anchors that now live inside another section */
const ALIASES: Record<string, string> = { version: 'gateway', magpie: 'gateway' }
const sectionOf = (hash: string) => {
  const id = hash.slice(1)
  return ALIASES[id] ?? id
}
const active = ref('sync')
/** a jump (index, hash, deep link) pins the index until the person scrolls themselves */
let pinned = false
let frame = 0
function spy() {
  frame = 0
  if (pinned) return
  const line = 140
  let current = SECTIONS[0]
  for (const id of SECTIONS) {
    const el = document.getElementById(id)
    if (el && el.getBoundingClientRect().top <= line) current = id
  }
  if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) current = SECTIONS[SECTIONS.length - 1]
  active.value = current
}
const onScroll = () => { if (!frame) frame = requestAnimationFrame(spy) }
const unpin = () => { pinned = false }
const USER_SCROLL_EVENTS = ['wheel', 'touchmove', 'keydown'] as const

function reveal(id: string) {
  // scrollIntoView honours scroll-margin-top (header, plus the ticker on mobile); the router's offset does not
  document.getElementById(id)?.scrollIntoView({ block: 'start' })
}

/** 代理 and RTK 中转 read their own data and grow after the shell's answers: keep the deep-linked plate placed
 *  while the plates above it grow, until the person scrolls, jumps elsewhere, or 4 s pass */
const body = ref<HTMLElement | null>(null)
let holding: ResizeObserver | null = null
function holdPlace(id: string) {
  if (!body.value || typeof ResizeObserver === 'undefined') return
  holding?.disconnect()
  const observer = new ResizeObserver(() => {
    if (pinned && active.value === id) reveal(id)
  })
  observer.observe(body.value)
  holding = observer
  setTimeout(() => {
    observer.disconnect()
    if (holding === observer) holding = null
  }, 4000)
}

onMounted(async () => {
  window.addEventListener('scroll', onScroll, { passive: true })
  for (const type of USER_SCROLL_EVENTS) window.addEventListener(type, unpin, { passive: true })
  const id = sectionOf(route.hash)
  if (!SECTIONS.includes(id)) return spy()
  active.value = id
  pinned = true
  // deep link (#rtk-relay, #session …): the plates above print their data late and push the target down — wait for
  // the first answers (max 4 s), then place it once
  const settled = () => [sync.state.value, versions.state.value].every((s) => s !== 'loading')
  if (!settled()) {
    await new Promise<void>((resolve) => {
      const stop = watch(settled, (ready) => {
        if (!ready) return
        stop()
        resolve()
      })
      setTimeout(() => {
        stop()
        resolve()
      }, 4000)
    })
  }
  await nextTick()
  if (!pinned) return
  reveal(id)
  holdPlace(id)
})
onBeforeUnmount(() => {
  holding?.disconnect()
  window.removeEventListener('scroll', onScroll)
  for (const type of USER_SCROLL_EVENTS) window.removeEventListener(type, unpin)
  if (frame) cancelAnimationFrame(frame)
})

// in-page hash changes (statusline sync squares → #sync, user menu → #session, the index below): the router
// scrolls first with its fixed offset, then this places the plate under the header (and ticker) again
watch(
  () => route.hash,
  async (hash) => {
    const id = sectionOf(hash)
    if (!SECTIONS.includes(id)) return
    active.value = id
    pinned = true
    await nextTick()
    requestAnimationFrame(() => reveal(id))
  },
)

async function jump(id: string) {
  active.value = id
  pinned = true
  if (route.hash === `#${id}`) return reveal(id)
  await router.replace({ hash: `#${id}` })
}

async function signOut() {
  const ok = await confirmSheet({
    title: '退出登录？',
    facts: [{ k: '身份', v: `${session.user?.name ?? 'admin'} · 管理员` }],
    consequence: '只退出这个浏览器 · 其他设备不受影响',
    confirmText: '退出',
  })
  if (ok) await logout()
}
</script>

<template>
  <div class="ui-page set-page">
    <PageHead title="设置" :status="statusLine">
      <template #live>
        <LiveMark :state="sync.state.value" :last-at="sync.lastAt.value" :interval-ms="sync.intervalMs" @retry="sync.refresh" />
      </template>
    </PageHead>

    <div class="set-layout">
      <nav class="set-toc" aria-label="设置分区">
        <a
          v-for="item in toc"
          :key="item.id"
          :href="`#${item.id}`"
          :aria-current="active === item.id ? 'location' : undefined"
          @click.prevent="void jump(item.id)"
        >
          <span class="set-toc__l">{{ item.label }}</span>
          <span class="set-toc__v num" :class="{ 'is-hot': item.hot }">{{ item.value }}</span>
        </a>
      </nav>

      <div ref="body" class="set-body ui-grid">
        <SyncCenter
          class="c-12"
          :data="sync.data.value"
          :state="sync.state.value"
          :error="sync.error.value"
          :last-at="sync.lastAt.value"
          @retry="sync.refresh"
          @refresh="sync.refresh"
        />
        <VersionSection
          :data="versions.data.value"
          :state="versions.state.value"
          :error="versions.error.value"
          :last-at="versions.lastAt.value"
          :checking="checking"
          @retry="versions.refresh"
          @recheck="recheck"
        />
        <ProxySection class="c-12" @index="proxyIndex = $event" />
        <RtkRelaySection class="c-12" @index="relayIndex = $event" />
        <PrefsSection class="c-8" />
        <Plate id="session" title="会话" class="set-sec c-4">
          <dl class="set-session">
            <dt>身份</dt>
            <dd class="num">{{ session.user?.name ?? 'admin' }} · 管理员</dd>
            <dt>登录方式</dt>
            <dd>账号密码 · 本浏览器</dd>
          </dl>
          <div class="set-session__act">
            <span class="dim">退出只影响这个浏览器</span>
            <TxButton size="sm" variant="secondary" @click="signOut">退出登录</TxButton>
          </div>
        </Plate>
      </div>
    </div>
  </div>
</template>

<style>
.set-page .set-sec { scroll-margin-top: calc(var(--head) + 16px); }

.set-layout { display: grid; grid-template-columns: 168px minmax(0, 1fr); gap: 0 28px; align-items: start; }
/* the index: quiet text rows, spacing between them, the active one gets a signal bar and a paper fill */
.set-toc { position: sticky; top: calc(var(--head) + 18px); display: grid; gap: 2px; }
.set-toc a {
  position: relative; display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 8px;
  min-height: 34px; padding: 0 8px 0 12px; border-radius: var(--r-1); color: var(--ink-2); text-decoration: none; font-size: var(--fs-base);
  transition: background-color var(--dur-2), color var(--dur-2);
}
.set-toc a::before { content: ''; position: absolute; left: 0; top: 9px; bottom: 9px; width: 2px; background: transparent; transition: background-color var(--dur-2); }
.set-toc a:hover { background: var(--paper-2); color: var(--ink); }
.set-toc a[aria-current] { background: var(--paper-2); color: var(--ink); font-weight: 600; }
.set-toc a[aria-current]::before { background: var(--signal); }
.set-toc__l { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.set-toc__v { font-size: var(--fs-xs); color: var(--ink-3); font-weight: 400; white-space: nowrap; }
.set-toc__v.is-hot { color: var(--signal-ink); }
.set-body { min-width: 0; }

.set-session { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 0 20px; margin: 0; font-size: var(--fs-sm); }
.set-session dt, .set-session dd { margin: 0; min-height: 40px; display: flex; align-items: center; }
.set-session dt { color: var(--ink-3); }
.set-session dd { color: var(--ink); }
.set-session__act { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 44px; margin-top: 4px; font-size: var(--fs-xs); }

/* < 1180: the index becomes one wrapping row of quiet tabs above the plates (never scrolls sideways) */
@media (max-width: 1179px) {
  .set-layout { grid-template-columns: minmax(0, 1fr); gap: 14px; }
  .set-toc { position: static; display: flex; flex-wrap: wrap; gap: 4px; }
  .set-toc a { grid-template-columns: auto auto; gap: 6px; min-height: 32px; padding: 0 10px; }
  .set-toc a::before { display: none; }
  .set-toc a[aria-current] { background: var(--paper-3); }
}
@media (max-width: 959px) {
  .set-page .set-sec { scroll-margin-top: calc(var(--head) + var(--ticker) + 12px); }
  .set-toc a { min-height: 40px; }
}
@media (max-width: 599px) {
  .set-toc__v { display: none; }
}
/* touch: switches keep their 30px look but get a 44px hit area */
@media (pointer: coarse) {
  html:root .set-page .tuff-switch { position: relative; }
  html:root .set-page .tuff-switch::after { content: ''; position: absolute; inset: -14px -8px; }
}
</style>
