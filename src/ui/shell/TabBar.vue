<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { TxTabBar } from '@talex-touch/tuffex/tab-bar'
import { ICON_PATHS, type IconName } from '../icons'
import type { NavItem } from '../types'

/**
 * Mobile tab bar (DESIGN.md §4.2, <960) on TxTabBar: fixed bottom, 58px + safe area, opaque paper, a 2px
 * signal line slides along the top edge (indicator="line", styles/tx/tab-bar.css). Admin: 概览 · 账号 · Key ·
 * 用量 · 更多 (更多 opens MoreSheet); key user: 4 items, no 更多. Counts ride TxTabBar's own badge.
 * TxTabBar only takes icon *classes*: the kit's inline-SVG icons are exposed once as mask classes
 * (`ui-tbi--grid` …) built from icons.ts, so the bar keeps the same drawing as the rest of the console.
 */
const props = withDefaults(defineProps<{ items: NavItem[]; more?: { label?: string; count?: number } | null }>(), { more: null })
const emit = defineEmits<{ more: [] }>()
const route = useRoute()
const router = useRouter()
const MORE = '__more'

const activeId = computed(() => {
  const path = route.path
  let best: NavItem | null = null
  for (const item of props.items) {
    if (path === item.to || path.startsWith(`${item.to}/`)) if (!best || item.to.length > best.to.length) best = item
  }
  return best?.id ?? ''
})
const badge = (count?: number) => (count ? (count > 99 ? '99+' : count) : undefined)
const tabs = computed(() => [
  ...props.items.map((item) => ({ value: item.id, label: item.label, iconClass: iconClass(item.icon), badge: badge(item.count) })),
  ...(props.more ? [{ value: MORE, label: props.more.label ?? '更多', iconClass: iconClass('more'), badge: badge(props.more.count) }] : []),
])
function pick(value: string | number) {
  if (value === MORE) {
    emit('more')
    return
  }
  const item = props.items.find((it) => it.id === value)
  if (item && item.to !== route.path) void router.push(item.to)
}

function iconClass(name?: string) {
  const key = (name && name in ICON_PATHS ? name : 'grid') as IconName
  ensureIconCss()
  return `ui-tbi ui-tbi--${key}`
}
/* one stylesheet, written once per page: icon masks from the same static paths <Icon> renders (never user input) */
let iconCssDone = false
function ensureIconCss() {
  if (iconCssDone || typeof document === 'undefined') return
  iconCssDone = true
  const rules = (Object.keys(ICON_PATHS) as IconName[]).map((name) => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="#000" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${ICON_PATHS[name]}</svg>`
    return `.ui-tbi--${name}{--ui-tbi:url("data:image/svg+xml,${encodeURIComponent(svg)}")}`
  })
  const style = document.createElement('style')
  style.dataset.kit = 'tabbar-icons'
  style.textContent = rules.join('')
  document.head.appendChild(style)
}
</script>

<template>
  <TxTabBar class="ui-tabbar" :model-value="activeId" :items="tabs" indicator="line" :z-index="45" fixed safe-area-bottom aria-label="主导航" @update:model-value="pick" />
</template>

<style>
html:root .ui-tabbar .tx-tab-bar__inner { height: var(--tabbar); }
html:root .ui-tabbar .tx-tab-bar__label { font-size: var(--fs-xs); }
.ui-tbi { display: block; width: 20px; height: 20px; background: currentColor; -webkit-mask: var(--ui-tbi) center / contain no-repeat; mask: var(--ui-tbi) center / contain no-repeat; }
html:root .ui-tabbar .tx-tab-bar__badge { top: -5px; right: -10px; }
</style>
