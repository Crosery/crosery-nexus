<script setup lang="ts">
import { computed, defineAsyncComponent, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import AppHeader from './AppHeader.vue'
import StatusLine from './StatusLine.vue'
import Ticker from './Ticker.vue'
import TabBar from './TabBar.vue'
import ScanLine from './ScanLine.vue'
import CommandPalette from './CommandPalette.vue'
import { useBreakpoint } from '../composables/useBreakpoint'
import { useShortcuts, type ShortcutMap } from '../composables/useShortcuts'
import { toggleTheme } from '../../lib/theme'
import { toggleMask } from '../../lib/privacy'
import type { CommandItem, NavItem, ShellRole, ShellStatus, TraceSample, UserMenuItem } from '../types'

/**
 * App shell (DESIGN.md §4, §5.2 shell/AppShell). ≥960: AppHeader (top rail + HeaderTrace) and the fixed
 * StatusLine; <960: top bar + Ticker + TabBar (+ 更多 sheet). Always: skip link, <main id="main">, ScanLine,
 * ⌘K CommandPalette. Global keys: mod+k palette, ? shortcut sheet, T theme, M mask (admin), 1–7 / 1–4 jump
 * (single-key rules in useShortcuts). The toast host and ConfirmHost stay in App.vue (they also serve /login).
 */
const props = withDefaults(
  defineProps<{
    role: ShellRole
    /** desktop rail, in order (idx 01…), grouped by `group` */
    nav: NavItem[]
    /** mobile tab bar items (admin 4 + 更多, key 4) */
    tabs?: NavItem[]
    /** 更多 sheet groups (admin) */
    moreGroups?: Array<{ label: string; items: NavItem[] }>
    user?: { name: string } | null
    userMenu?: UserMenuItem[]
    status?: ShellStatus
    samples?: TraceSample[]
    traceStale?: boolean
    /** extra palette commands (actions / finds) */
    commands?: CommandItem[]
    /** mobile top bar */
    title?: string
    en?: string
    back?: string | null
  }>(),
  {
    tabs: () => [], moreGroups: () => [], user: null, userMenu: () => [], status: () => ({}), samples: () => [],
    traceStale: false, commands: () => [], title: '', en: undefined, back: null,
  },
)
const emit = defineEmits<{ logout: [] }>()
const router = useRouter()
const { isMobile } = useBreakpoint()

const MoreSheet = defineAsyncComponent(() => import('./MoreSheet.vue'))
const ShortcutHelp = defineAsyncComponent(() => import('./ShortcutHelp.vue'))
const paletteOpen = ref(false)
const moreOpen = ref(false)
const moreUsed = ref(false)
const helpOpen = ref(false)
const helpUsed = ref(false)
watch(moreOpen, (v) => { if (v) moreUsed.value = true })
watch(helpOpen, (v) => { if (v) helpUsed.value = true })

const allCommands = computed<CommandItem[]>(() => [
  ...props.nav.map((item) => ({ id: `go:${item.id}`, title: item.label, section: 'GO' as const, hint: item.idx, keywords: [item.to], run: () => void router.push(item.to) })),
  ...props.commands,
  { id: 'view:theme', title: '切换主题', section: 'VIEW', hint: 'T', run: () => toggleTheme() },
  ...(props.role === 'admin' ? [{ id: 'view:mask', title: '隐私脱敏 开 / 关', section: 'VIEW' as const, hint: 'M', run: () => toggleMask() }] : []),
  { id: 'view:keys', title: '快捷键', section: 'VIEW', hint: '?', run: () => (helpOpen.value = true) },
])

const shortcuts = computed<ShortcutMap>(() => {
  const map: ShortcutMap = {
    'mod+k': () => (paletteOpen.value = !paletteOpen.value),
    '?': () => (helpOpen.value = true),
    t: () => toggleTheme(document.querySelector('.ui-head [aria-label^="切换到"]')),
  }
  if (props.role === 'admin') map.m = () => toggleMask()
  const max = props.role === 'admin' ? 7 : 4
  props.nav.slice(0, max).forEach((item, i) => {
    map[String(i + 1)] = () => void router.push(item.to)
  })
  return map
})
useShortcuts(() => shortcuts.value)
/* skip link: focus <main> directly (no hash navigation, so the router and page hashes such as #sync stay put) */
function skipToMain() {
  const main = document.getElementById('main')
  if (!main) return
  main.focus()
}
const moreCount = computed(() => props.moreGroups.reduce((n, g) => n + g.items.reduce((m, it) => m + (it.count ?? 0), 0), 0))
</script>

<template>
  <div class="ui-shell" :class="[`is-${role}`, { 'is-m': isMobile }]">
    <a class="skip-link" href="#main" @click.prevent="skipToMain">跳到主内容</a>
    <AppHeader
      :role="role"
      :nav="nav"
      :user="user"
      :user-menu="userMenu"
      :title="title"
      :en="en"
      :back="back"
      :status="status"
      :samples="samples"
      :trace-stale="traceStale"
      @palette="paletteOpen = true"
      @logout="emit('logout')"
    />
    <Ticker v-if="isMobile" :role="role" :status="status" />
    <main id="main" class="ui-main" tabindex="-1">
      <slot />
    </main>
    <StatusLine v-if="!isMobile" :role="role" :status="status" />
    <template v-else>
      <TabBar :items="tabs" :more="role === 'admin' && moreGroups.length ? { count: moreCount } : null" @more="moreOpen = true" />
      <MoreSheet v-if="moreUsed" v-model="moreOpen" :groups="moreGroups" :show-mask="role === 'admin'" @logout="emit('logout')" />
    </template>
    <ShortcutHelp v-if="helpUsed" v-model="helpOpen" :role="role" />
    <CommandPalette v-model="paletteOpen" :commands="allCommands" />
    <ScanLine />
  </div>
</template>

<style>
.ui-shell { min-height: 100vh; min-height: 100dvh; display: flex; flex-direction: column; }
/* the single owner of the page inset (DESIGN §2.6): content max 1680 centred, var(--page-x) margins; page
   containers inside (.ui-page / legacy .page) add no horizontal padding of their own (styles/layout.css) */
.ui-main { flex: 1; width: 100%; max-width: calc(var(--page-max) + 2 * var(--page-x)); margin: 0 auto; padding: 0 var(--page-x) calc(var(--statusline) + 32px); min-width: 0; }
.ui-main:focus { outline: none; }
.ui-shell.is-m .ui-main { padding-bottom: calc(var(--tabbar) + env(safe-area-inset-bottom) + 16px); }
</style>
