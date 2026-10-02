<script setup lang="ts">
import { computed, ref, useTemplateRef } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { TxButton, TxIconButton } from '@talex-touch/tuffex/button'
import { TxDropdownItem, TxDropdownMenu } from '@talex-touch/tuffex/dropdown-menu'
import BrandMark from './BrandMark.vue'
import HeaderTrace from './HeaderTrace.vue'
import ThemeToggle from './ThemeToggle.vue'
import MaskToggle from './MaskToggle.vue'
import Icon from '../Icon.vue'
import Kbd from '../form/Kbd.vue'
import { CALM_MENU } from '../form/anchor'
import StatusMark from '../data/StatusMark.vue'
import { useBreakpoint } from '../composables/useBreakpoint'
import { useIndicator } from '../composables/useIndicator'
import type { NavItem, ShellRole, ShellStatus, TraceSample, UserMenuItem } from '../types'

/**
 * App header (DESIGN.md §4.1–4.3). ≥960: 52px sticky bar on 88% paper with a 6px blur — brand, the grouped
 * top rail (`概览 │ Key 渠道 …`, signal-ink attention count superscript, a 2px signal underline that slides),
 * then ⌘K field (TxButton; icon below 1280), mask (admin), theme (TxIconButton), user menu (TxDropdownMenu); the bottom edge is the
 * HeaderTrace ruler. <960: mark or back arrow, page title, sync chip (admin), theme and
 * search (opens the palette as a full-height sheet); key users get 退出 here instead of a menu.
 * Key users (§4.3) have no ⌘K field and no mask: the right cluster is the key chip
 * (`● name  sk-cr…7f3a`, the status word only when the key is not usable), theme, 退出. ⌘K still opens the palette.
 */
const props = withDefaults(
  defineProps<{
    role: ShellRole
    nav: NavItem[]
    user?: { name: string } | null
    userMenu?: UserMenuItem[]
    /** mobile top bar title / EN micro */
    title?: string
    en?: string
    /** mobile: show a back arrow to this route instead of the mark */
    back?: string | null
    status?: ShellStatus
    samples?: TraceSample[]
    traceStale?: boolean
    syncTo?: string
  }>(),
  { user: null, userMenu: () => [], title: '', en: undefined, back: null, status: () => ({}), samples: () => [], traceStale: false, syncTo: '/settings#sync' },
)
const emit = defineEmits<{ palette: []; logout: [] }>()
const route = useRoute()
const router = useRouter()
const { isMobile } = useBreakpoint()

const activeId = computed(() => {
  let best: NavItem | null = null
  for (const item of props.nav) {
    if (route.path === item.to || route.path.startsWith(`${item.to}/`)) if (!best || item.to.length > best.to.length) best = item
  }
  return best?.id ?? null
})
const rail = computed(() => props.nav.map((item, i) => ({ item, divider: i > 0 && item.group !== props.nav[i - 1].group })))

const railEl = useTemplateRef<HTMLElement>('rail')
const indEl = useTemplateRef<HTMLElement>('ind')
useIndicator(railEl, indEl, '.ui-rail__it.is-active', [activeId, isMobile], 10)

/* user menu: TxDropdownMenu (focus-first-item, arrow keys, Esc and outside click are built in) */
const menuOpen = ref(false)
const menuBtn = useTemplateRef<{ $el: HTMLElement }>('menuBtn')
function pick(item: UserMenuItem) {
  menuOpen.value = false
  menuBtn.value?.$el?.focus()
  if (item.run) item.run()
  else if (item.to) void router.push(item.to)
}
const syncBars = computed(() => (props.status.sync ?? []).slice(0, 5))
const keyChip = computed(() => {
  const k = props.role === 'key' ? props.status.key : null
  if (!k?.name) return null
  const state = k.state ?? null
  const word = k.stateLabel ?? ''
  return {
    name: k.name,
    masked: k.masked ?? '',
    state,
    word,
    label: ['当前 Key', k.name, k.masked, word].filter(Boolean).join(' · '),
  }
})
</script>

<template>
  <header class="ui-head" :class="{ 'is-m': isMobile }">
    <template v-if="!isMobile">
      <BrandMark :sub="role === 'key' ? 'my key' : 'console'" :to="role === 'key' ? '/me' : '/'" />
      <nav ref="rail" class="ui-rail" aria-label="主导航">
        <template v-for="r in rail" :key="r.item.id">
          <span v-if="r.divider" class="ui-rail__div" aria-hidden="true" />
          <RouterLink
            :to="r.item.to"
            class="ui-rail__it"
            :class="{ 'is-active': r.item.id === activeId }"
            :aria-current="r.item.id === activeId ? 'page' : undefined"
          >
            {{ r.item.label }}<sup v-if="r.item.count" class="ui-rail__n"><span class="sr-only">，</span>{{ r.item.count }}<span class="sr-only"> 项待处理</span></sup>
          </RouterLink>
        </template>
        <span ref="ind" class="ui-ind ui-rail__ind" aria-hidden="true" />
      </nav>
      <div class="ui-head__r">
        <TxButton v-if="role === 'admin'" variant="secondary" class="ui-head__k" aria-label="跳转或执行（命令面板）" title="命令面板 (⌘K)" @click="emit('palette')">
          <Icon name="search" /><span class="ui-head__kt" aria-hidden="true">跳转或执行…</span><Kbd keys="mod+k" class="ui-head__kk" />
        </TxButton>
        <span v-if="keyChip" class="ui-keychip" role="group" :aria-label="keyChip.label">
          <StatusMark v-if="keyChip.state" :state="keyChip.state" :label="keyChip.word || undefined" :bare="keyChip.state === 'run' || !keyChip.word" />
          <span class="ui-keychip__n" aria-hidden="true">{{ keyChip.name }}</span>
          <span v-if="keyChip.masked" class="ui-keychip__k" aria-hidden="true">{{ keyChip.masked }}</span>
        </span>
        <MaskToggle v-if="role === 'admin'" />
        <ThemeToggle />
        <TxDropdownMenu v-if="role === 'admin' && user" v-model="menuOpen" class="ui-umenu" placement="bottom-end" :min-width="168" :offset="6" v-bind="CALM_MENU">
          <template #trigger>
            <TxButton ref="menuBtn" variant="ghost" class="ui-umenu__btn" :aria-expanded="menuOpen" aria-haspopup="menu" :aria-label="`用户菜单：${user.name}`">
              <span class="ui-umenu__av" aria-hidden="true">{{ user.name.slice(0, 1).toUpperCase() }}</span>
              <span class="ui-umenu__name">{{ user.name }}</span>
              <Icon name="chev" />
            </TxButton>
          </template>
          <TxDropdownItem v-for="m in userMenu" :key="m.id" :danger="m.danger" @select="pick(m)">{{ m.label }}</TxDropdownItem>
        </TxDropdownMenu>
        <TxButton v-else-if="role === 'key'" variant="ghost" size="sm" class="ui-head__out" @click="emit('logout')"><Icon name="out" />退出</TxButton>
      </div>
    </template>
    <template v-else>
      <RouterLink v-if="back" :to="back" class="ui-icon-btn" aria-label="返回"><Icon name="chev-left" /></RouterLink>
      <BrandMark v-else compact :sub="role === 'key' ? 'my key' : 'console'" :to="role === 'key' ? '/me' : '/'" />
      <div class="ui-head__title">
        <span class="ui-head__tt">{{ title }}</span>
      </div>
      <div class="ui-head__r">
        <RouterLink v-if="role === 'admin' && syncBars.length" :to="syncTo" class="ui-head__sync" :aria-label="`同步状态：${syncBars.map((j) => j.label + ' ' + j.state).join('，')}`">
          <i v-for="j in syncBars" :key="j.id" :class="`is-${j.state}`" />
        </RouterLink>
        <ThemeToggle />
        <TxIconButton v-if="role === 'admin'" label="搜索与命令" size="sm" @click="emit('palette')"><Icon name="search" /></TxIconButton>
        <TxIconButton v-else label="退出" title="退出" size="sm" @click="emit('logout')"><Icon name="out" /></TxIconButton>
      </div>
    </template>
    <HeaderTrace v-if="!isMobile" :samples="role === 'admin' ? samples : []" :stale="traceStale" />
  </header>
</template>

<style>
.ui-head {
  position: sticky; top: 0; z-index: var(--z-head); height: var(--head);
  display: flex; align-items: center; gap: 22px; padding: 0 var(--page-x);
  background: color-mix(in srgb, var(--paper) 88%, transparent); -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px);
}
.ui-head.is-m { gap: 10px; padding-top: env(safe-area-inset-top); height: calc(var(--head) + env(safe-area-inset-top)); border-bottom: 1px solid var(--rule-2); }
.ui-rail { position: relative; display: flex; align-items: center; gap: 2px; min-width: 0; height: 100%; }
.ui-rail__it { position: relative; display: inline-flex; align-items: baseline; height: 100%; padding: 0 10px; line-height: var(--head); font-size: var(--fs-base); color: var(--ink-2); text-decoration: none; white-space: nowrap; }
.ui-rail__it:hover { color: var(--ink); }
.ui-rail__it.is-active { color: var(--ink); font-weight: 600; }
.ui-rail__it:focus-visible { outline-offset: -6px; }
.ui-rail__n { margin-left: 2px; font-family: var(--font-mono); font-size: 10px; font-weight: 600; color: var(--signal-ink); vertical-align: 6px; line-height: 0; }
.ui-rail__div { width: 1px; height: 16px; margin: 0 6px; background: var(--rule-2); flex: none; }
.ui-rail__ind { bottom: 0; }
.ui-head__r { margin-left: auto; display: flex; align-items: center; gap: 6px; flex: none; }
html:root .ui-head__k.tx-button { justify-content: flex-start; gap: 8px; width: 188px; height: var(--ctl-h); padding: 0 6px 0 10px; color: var(--ink-3); font-weight: 400; }
html:root .ui-head__k.tx-button:hover { color: var(--ink-2); }
.ui-head__kt { flex: 1; }
@media (max-width: 1279px) {
  html:root .ui-head__k.tx-button { width: 32px; height: 32px; padding: 0; justify-content: center; --tx-button-border-color: transparent; }
  html:root .ui-head__k :is(.ui-head__kt, .ui-head__kk) { display: none; }
  .ui-umenu__name { display: none; }
}
/* key chip (§4.3): 1px rule-2 box, mark + mono name (ellipsis) + ink-2 tail; the tail never truncates */
.ui-keychip { display: inline-flex; align-items: center; gap: 8px; height: 30px; max-width: 340px; min-width: 0; padding: 0 10px; border: 1px solid var(--rule-2); border-radius: var(--r-1); font-family: var(--font-mono); font-size: 11.5px; color: var(--ink); white-space: nowrap; }
.ui-keychip .ui-st { font-family: var(--font-sans); font-size: var(--fs-xs); flex: none; }
.ui-keychip__n { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.ui-keychip__k { flex: none; font-size: 11px; color: var(--ink-2); }
@media (max-width: 1179px) { .ui-keychip { max-width: 260px; } }
.ui-head__out { margin-left: 2px; }
html:root .ui-umenu__btn.tx-button { gap: 6px; height: 32px; padding: 0 6px; color: var(--ink-2); font-size: var(--fs-sm); font-weight: 400; }
.ui-umenu__av { display: inline-grid; place-items: center; width: 22px; height: 22px; border: 1px solid var(--ink); border-radius: 50%; font: 600 11px var(--font-mono); color: var(--ink); }
html:root .ui-umenu__btn[aria-expanded="true"] { background: var(--paper-2); }
.ui-head__title { flex: 1; min-width: 0; display: flex; align-items: baseline; gap: 8px; overflow: hidden; }
.ui-head__tt { font-size: var(--fs-md); font-weight: 650; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ui-head__sync { display: inline-flex; align-items: center; gap: 2px; height: 32px; padding: 0 6px; }
.ui-head__sync i { width: 3px; height: 12px; background: var(--ink-3); }
.ui-head__sync i.is-idle { background: var(--rule-2); }
.ui-head__sync i.is-running { background: var(--ink); }
.ui-head__sync i.is-backoff, .ui-head__sync i.is-failed { background: var(--signal); }
</style>
