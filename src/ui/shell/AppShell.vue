<script setup lang="ts">
import { computed, defineAsyncComponent, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import AppHeader from './AppHeader.vue'
import StatusLine from './StatusLine.vue'
import Ticker from './Ticker.vue'
import TabBar from './TabBar.vue'
import ScanLine from './ScanLine.vue'
import CommandPalette from './CommandPalette.vue'
import Icon from '../Icon.vue'
import { ICON_PATHS, type IconName } from '../icons'
import { useBreakpoint } from '../composables/useBreakpoint'
import { useShortcuts, type ShortcutMap } from '../composables/useShortcuts'
import { toggleTheme, useThemePref, type ThemePref } from '../../lib/theme'
import { toggleMask, useMask } from '../../lib/privacy'
import { useSkinPref, type SkinPref } from '../../lib/skin'
import { useTitlePref } from '../../lib/title'
import ConsoleTitleEditor from './ConsoleTitleEditor.vue'
import type { CommandItem, NavItem, ShellRole, ShellStatus, TraceSample, UserMenuItem } from '../types'
import { TxSidebarNav, type SidebarNavGroup, type SidebarNavItem } from '@talex-touch/tuffex/sidebar-nav'
import { TxBreadcrumb, type BreadcrumbItem } from '@talex-touch/tuffex/breadcrumb'
import { TxIconButton } from '@talex-touch/tuffex/button'
import { TxIconChip } from '@talex-touch/tuffex/icon-chip'
import { TxAvatar } from '@talex-touch/tuffex/avatar'
import { TxKbd } from '@talex-touch/tuffex/kbd'
import { TxTooltip } from '@talex-touch/tuffex/tooltip'
import { TxDropdownItem, TxDropdownMenu } from '@talex-touch/tuffex/dropdown-menu'
import { TxCommandPalette, type CommandPaletteItem } from '@talex-touch/tuffex/command-palette'

/**
 * App shell (DESIGN.md §4, §5.2 shell/AppShell). Telemetry ≥960: AppHeader top rail and fixed StatusLine;
 * <960: top bar + Ticker + TabBar (+ 更多 sheet). Minimal: the Tuffex Template Shell sidebar workbench —
 * TxSidebarNav (CROSERY plate, grouped icon rows, count badges, live status footer) beside a white top bar
 * (TxBreadcrumb, ⌘K, 外观 menu, account menu) over a token canvas; ≤639 the sidebar folds into a menu button.
 * Always: skip link, <main id="main">, ⌘K CommandPalette (Telemetry adds ScanLine). Global keys: mod+k palette,
 * ? shortcut sheet, T theme, M mask (admin), 1–8 / 1–4 jump (single-key rules in useShortcuts). The toast host
 * and ConfirmHost stay in App.vue (they also serve /login).
 */
const props = withDefaults(
  defineProps<{
    role: ShellRole
    /** desktop navigation, in order, grouped by `group` */
    nav: NavItem[]
    /** mobile tab bar items (admin 4 + 更多, key 4) */
    tabs?: NavItem[]
    /** 更多 sheet groups (admin); minimal also names its sidebar groups after them */
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
const route = useRoute()
const router = useRouter()
const { isMobile } = useBreakpoint()
const skin = useSkinPref()
const theme = useThemePref()
const mask = useMask()
const titlePref = useTitlePref()
const minimal = computed(() => skin.pref.value === 'minimal')

/* Minimal: 可编辑的品牌名 → 侧栏品牌、面包屑首页、浏览器标签页。blank/重置恢复 Crosery。 */
const consoleTitle = computed(() => titlePref.pref.value)
const titleEditorOpen = ref(false)

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
  ...(['telemetry', 'minimal'] as const).map((value) => ({ id: `view:skin:${value}`, title: `皮肤：${value === 'minimal' ? '简约' : 'Telemetry'}`, section: 'VIEW' as const, run: () => skin.set(value) })),
  ...props.commands,
  { id: 'view:theme', title: '切换主题', section: 'VIEW', hint: 'T', run: () => toggleTheme() },
  ...(props.role === 'admin' ? [{ id: 'view:mask', title: '隐私脱敏 开 / 关', section: 'VIEW' as const, hint: 'M', run: () => toggleMask() }] : []),
  ...(minimal.value ? [{ id: 'view:title', title: '编辑控制台标题', section: 'VIEW' as const, run: () => (titleEditorOpen.value = true) }] : []),
  { id: 'view:keys', title: '快捷键', section: 'VIEW', hint: '?', run: () => (helpOpen.value = true) },
])

const shortcuts = computed<ShortcutMap>(() => {
  const map: ShortcutMap = {
    'mod+k': () => (paletteOpen.value = !paletteOpen.value),
    '?': () => (helpOpen.value = true),
    t: () => toggleTheme(document.querySelector('.ui-head [aria-label^="切换到"]')),
  }
  if (minimal.value && paletteOpen.value) map.escape = () => (paletteOpen.value = false)
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

/* ── minimal: Template Shell workbench ─────────────────────────────────────────────────────────── */

const isMac = typeof navigator !== 'undefined' && /Mac|iP(hone|ad|od)/.test(navigator.platform || navigator.userAgent)
const paletteKeys = isMac ? '⌘K' : 'Ctrl K'
const navMenuOpen = ref(false)
const appearanceOpen = ref(false)
const accountOpen = ref(false)

/** The nav entry that owns the current path (longest prefix), so /operations stays on 运营数据 and /me only owns /me. */
const activeItem = computed(() => {
  let best: NavItem | null = null
  for (const item of props.nav) {
    if (route.path === item.to || route.path.startsWith(`${item.to}/`)) if (!best || item.to.length > best.to.length) best = item
  }
  return best
})
const badge = (count?: number) => (count ? (count > 99 ? '99+' : count) : undefined)
const iconName = (item: NavItem | undefined): IconName => (item?.icon && item.icon in ICON_PATHS ? item.icon : 'grid') as IconName
const navById = computed(() => new Map(props.nav.map((item) => [item.id, item])))
const sideItems = computed<SidebarNavItem[]>(() => props.nav.map((item) => ({ value: item.id, label: item.label, group: item.group, badge: badge(item.count) })))
/* Groups keep the IA order. A group is named only where the 更多 sheet already names it (接入 · 系统); a group of one
   (概览, 用量) stays unlabeled rather than repeating its only row. */
const sideGroups = computed<SidebarNavGroup[]>(() => {
  const labels = new Map<string, string>()
  for (const group of props.moreGroups) for (const item of group.items) if (item.group) labels.set(item.group, group.label)
  const keys = [...new Set(props.nav.map((item) => item.group).filter((key): key is string => Boolean(key)))]
  return keys.map((key) => ({ key, label: labels.get(key) ?? '' }))
})
function goTo(id: string | number) {
  const item = navById.value.get(String(id))
  if (item && item.to !== route.path) void router.push(item.to)
}

const workspaceRole = computed(() => (props.role === 'admin' ? '管理控制台' : '我的 Key'))
/* Minimal: 第一块面包屑用可编辑标题；Telemetry 保持 CROSERY */
const crumbs = computed<BreadcrumbItem[]>(() => {
  const list: BreadcrumbItem[] = [{ label: minimal.value ? consoleTitle.value : 'CROSERY' }]
  const section = activeItem.value?.label
  if (section) list.push({ label: section })
  if (props.title && props.title !== section) list.push({ label: props.title })
  return list
})
function onCrumb(_item: BreadcrumbItem, index: number) {
  const target = index === 0 ? props.nav[0] : activeItem.value
  if (target && target.to !== route.path) void router.push(target.to)
}

/** Live facts the Telemetry statusline prints, as the sidebar footer (desktop) and the phone menu's head. */
const statusLines = computed(() => {
  const s = props.status
  const lines: string[] = []
  if (s.gateway) {
    const latency = s.gateway.p95Ms == null ? '—' : `${s.gateway.p95Ms} ms`
    lines.push(`${s.gateway.rpm ?? '—'} 次请求/分 · P95 ${latency}${s.gateway.stale ? ' · 陈旧' : ''}`)
  }
  if (s.syncText) lines.push(s.syncText)
  if (s.kernel) lines.push(s.kernel)
  if (s.key) {
    lines.push(`${s.key.name}${s.key.stateLabel ? ` · ${s.key.stateLabel}` : ''}`)
    lines.push(`今日 ${s.key.today ?? '—'} / ${s.key.limit ?? '—'} · ${s.key.models ?? '—'} 个模型`)
  }
  return lines
})
const statusWarn = computed(() => Boolean(props.status.gateway?.stale) || ['bad', 'warn', 'stale', 'off'].includes(props.status.key?.state ?? ''))

const accountName = computed(() => props.user?.name ?? props.status.key?.name ?? 'Key')
const accountMeta = computed(() => (props.role === 'admin' ? '管理员' : props.status.key?.masked ?? '我的 Key'))
/** Admin's user menu already carries 退出; the key user gets the shell's own. */
const ownLogout = computed(() => !props.userMenu.some((item) => item.id === 'logout'))
function runUserItem(item: UserMenuItem) {
  if (item.to) void router.push(item.to)
  else item.run?.()
}

const themeChoices: Array<{ value: ThemePref; label: string; icon: IconName }> = [
  { value: 'light', label: '浅色', icon: 'sun' },
  { value: 'dark', label: '深色', icon: 'moon' },
  { value: 'system', label: '跟随系统', icon: 'sys' },
]
const skinChoices: Array<{ value: SkinPref; label: string; icon: IconName }> = [
  { value: 'telemetry', label: 'Telemetry', icon: 'term' },
  { value: 'minimal', label: '简约', icon: 'grid' },
]

const nativeCommands = computed<CommandPaletteItem[]>(() => allCommands.value.map(({ id, title, keywords, hint, disabled }) => ({ id, title, keywords, shortcut: hint, disabled })))
function runCommand(command: CommandPaletteItem) {
  allCommands.value.find((item) => item.id === command.id && !item.disabled)?.run()
}
function openPalette() {
  paletteOpen.value = true
}
</script>

<template>
  <div v-if="minimal" class="mshell" :class="`is-${role}`">
    <a class="mshell__skip" href="#main" @click.prevent="skipToMain">跳到主内容</a>
    <TxSidebarNav
      class="mshell__sidebar"
      :model-value="activeItem?.id"
      :items="sideItems"
      :groups="sideGroups"
      aria-label="主导航"
      @select="goTo($event.value)"
    >
      <template #workspace>
        <div class="mshell__workspace">
          <TxIconChip :size="32" tone="ink" :font-size="13">C</TxIconChip>
          <span class="tx-bui-sidebar-nav__workspace-text">
            <span class="tx-bui-sidebar-nav__workspace-name">{{ consoleTitle }}</span>
            <span class="tx-bui-sidebar-nav__workspace-desc">{{ workspaceRole }}</span>
          </span>
        </div>
      </template>
      <template #item-icon="{ item }">
        <Icon :name="iconName(navById.get(String(item.value)))" :size="14" />
      </template>
      <template #footer>
        <div v-if="statusLines.length" class="mshell__status" :class="{ 'is-warn': statusWarn }" role="status">
          <span class="mshell__status-dot" aria-hidden="true" />
          <span class="mshell__status-text">
            <span v-for="(line, i) in statusLines" :key="i">{{ line }}</span>
          </span>
        </div>
      </template>
    </TxSidebarNav>

    <div class="mshell__main">
      <header class="mshell__topbar">
        <div class="mshell__burger">
          <TxDropdownMenu v-model="navMenuOpen" placement="bottom-start" :min-width="232">
            <template #trigger>
              <TxIconButton size="sm" label="打开导航" :aria-expanded="navMenuOpen" aria-haspopup="menu">
                <Icon name="menu" />
              </TxIconButton>
            </template>
            <div v-if="statusLines.length" class="mshell__who">
              <strong>{{ consoleTitle }}</strong>
              <span v-for="(line, i) in statusLines" :key="i">{{ line }}</span>
            </div>
            <TxDropdownItem v-for="item in nav" :key="item.id" :aria-current="item.id === activeItem?.id ? 'page' : undefined" @select="goTo(item.id)">
              <span class="mshell__menu-row" :class="{ 'is-current': item.id === activeItem?.id }">
                <Icon :name="iconName(item)" :size="15" />
                {{ item.label }}
              </span>
              <template v-if="badge(item.count)" #right>
                <span class="mshell__menu-count">{{ badge(item.count) }}</span>
              </template>
            </TxDropdownItem>
          </TxDropdownMenu>
        </div>

        <TxBreadcrumb class="mshell__crumbs" :items="crumbs" @click="onCrumb" />

        <div class="mshell__tools">
          <TxTooltip content="命令面板">
            <button type="button" class="mshell__palette" aria-label="打开命令面板" @click="openPalette">
              <TxKbd>{{ paletteKeys }}</TxKbd>
            </button>
          </TxTooltip>

          <TxDropdownMenu v-model="appearanceOpen" placement="bottom-end" :min-width="208">
            <template #trigger>
              <TxIconButton size="sm" label="外观与显示" :aria-expanded="appearanceOpen" aria-haspopup="menu">
                <Icon :name="theme.theme.value === 'dark' ? 'moon' : 'sun'" />
              </TxIconButton>
            </template>
            <div class="mshell__menu-label">主题</div>
            <TxDropdownItem v-for="choice in themeChoices" :key="choice.value" :aria-current="theme.pref.value === choice.value ? 'true' : undefined" @select="theme.set(choice.value)">
              <span class="mshell__menu-row"><Icon :name="choice.icon" :size="15" />{{ choice.label }}</span>
              <template v-if="theme.pref.value === choice.value" #right><Icon name="check" :size="14" /></template>
            </TxDropdownItem>
            <div class="mshell__menu-label">皮肤</div>
            <TxDropdownItem v-for="choice in skinChoices" :key="choice.value" :aria-current="skin.pref.value === choice.value ? 'true' : undefined" @select="skin.set(choice.value)">
              <span class="mshell__menu-row"><Icon :name="choice.icon" :size="15" />{{ choice.label }}</span>
              <template v-if="skin.pref.value === choice.value" #right><Icon name="check" :size="14" /></template>
            </TxDropdownItem>
            <div class="mshell__menu-label">标题</div>
            <TxDropdownItem @select="titleEditorOpen = true">
              <span class="mshell__menu-row"><Icon name="edit" :size="15" />编辑标题</span>
              <template #right><span class="mshell__menu-state">{{ consoleTitle }}</span></template>
            </TxDropdownItem>
            <template v-if="role === 'admin'">
              <div class="mshell__menu-label">隐私</div>
              <TxDropdownItem @select="mask.toggle()">
                <span class="mshell__menu-row"><Icon :name="mask.on.value ? 'eye-off' : 'eye'" :size="15" />隐私脱敏</span>
                <template #right><span class="mshell__menu-state">{{ mask.on.value ? '开' : '关' }}</span><TxKbd>M</TxKbd></template>
              </TxDropdownItem>
            </template>
          </TxDropdownMenu>

          <TxDropdownMenu v-model="accountOpen" placement="bottom-end" :min-width="232">
            <template #trigger>
              <button type="button" class="mshell__user" :aria-label="`账号菜单：${accountName}`" :aria-expanded="accountOpen" aria-haspopup="menu">
                <TxAvatar :name="accountName" size="small" />
              </button>
            </template>
            <div class="mshell__who">
              <strong>{{ accountName }}</strong>
              <span>{{ accountMeta }}</span>
            </div>
            <TxDropdownItem @select="openPalette">
              <span class="mshell__menu-row"><Icon name="search" :size="15" />命令面板</span>
              <template #right><TxKbd>{{ paletteKeys }}</TxKbd></template>
            </TxDropdownItem>
            <TxDropdownItem @select="helpOpen = true">
              <span class="mshell__menu-row"><Icon name="help" :size="15" />快捷键</span>
              <template #right><TxKbd>?</TxKbd></template>
            </TxDropdownItem>
            <TxDropdownItem v-for="item in userMenu" :key="item.id" :danger="item.danger" @select="runUserItem(item)">
              <span class="mshell__menu-row">
                <Icon :name="item.id === 'logout' ? 'out' : item.id === 'settings' ? 'gear' : 'user'" :size="15" />
                {{ item.label }}
              </span>
            </TxDropdownItem>
            <TxDropdownItem v-if="ownLogout" danger @select="emit('logout')">
              <span class="mshell__menu-row"><Icon name="out" :size="15" />退出</span>
            </TxDropdownItem>
          </TxDropdownMenu>
        </div>
      </header>

      <main id="main" class="mshell__content" tabindex="-1">
        <slot />
      </main>
    </div>

    <ShortcutHelp v-if="helpUsed" v-model="helpOpen" :role="role" />
    <TxCommandPalette v-model="paletteOpen" :commands="nativeCommands" aria-label="命令面板" placeholder="搜索页面或操作" empty-text="没有匹配的命令" @select="runCommand">
      <template #footer>
        <div class="mshell__palette-foot">
          <span><TxKbd>↑</TxKbd><TxKbd>↓</TxKbd>移动</span>
          <span><TxKbd>↵</TxKbd>执行</span>
          <span><TxKbd>Esc</TxKbd>关闭</span>
        </div>
      </template>
    </TxCommandPalette>
    <ConsoleTitleEditor v-model="titleEditorOpen" />
  </div>
  <div v-else class="ui-shell" :class="[`is-${role}`, { 'is-m': isMobile }]">
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
