<script setup lang="ts">
import { RouterLink } from 'vue-router'
import Sheet from '../feedback/Sheet.vue'
import Switch from '../form/Switch.vue'
import Segmented from '../form/Segmented.vue'
import Icon from '../Icon.vue'
import { useThemePref } from '../../lib/theme'
import { useMotionPref } from '../../lib/motion'
import { useMask } from '../../lib/privacy'
import type { IconName } from '../icons'
import type { NavItem } from '../types'

/**
 * 更多 sheet (DESIGN.md §4.2): bottom Sheet with the remaining nav grouped like the IA (接入: 渠道 · 模型 /
 * 系统: 设置 · 帮助), then 主题 (浅 / 深 / 跟随), 隐私脱敏, 减弱动效 and 退出. 48px rows: icon, label, count.
 */
withDefaults(defineProps<{ groups: Array<{ label: string; items: NavItem[] }>; showMask?: boolean }>(), { showMask: true })
const open = defineModel<boolean>({ default: false })
const emit = defineEmits<{ logout: [] }>()
const theme = useThemePref()
const motion = useMotionPref()
const mask = useMask()
const THEMES = [
  { value: 'light', label: '浅' },
  { value: 'dark', label: '深' },
  { value: 'system', label: '跟随' },
]
</script>

<template>
  <Sheet v-model="open" title="更多" side="bottom">
    <nav aria-label="更多页面">
      <section v-for="g in groups" :key="g.label" class="ui-more__g">
        <h3 class="ui-more__h">{{ g.label }}</h3>
        <RouterLink v-for="item in g.items" :key="item.id" :to="item.to" class="ui-more__row" @click="open = false">
          <Icon :name="(item.icon as IconName) ?? 'grid'" />
          <span class="ui-more__lb">{{ item.label }}</span>
          <b v-if="item.count" class="ui-more__n">{{ item.count }}</b>
          <Icon name="chev-right" class="dim" />
        </RouterLink>
      </section>
    </nav>
    <section class="ui-more__g">
      <h3 class="ui-more__h">外观</h3>
      <div class="ui-more__row is-ctl">
        <span class="ui-more__lb">主题</span>
        <Segmented :items="THEMES" label="主题" :model-value="theme.pref.value" @update:model-value="theme.set($event as 'light' | 'dark' | 'system')" />
      </div>
      <div v-if="showMask" class="ui-more__row is-ctl">
        <span class="ui-more__lb">隐私脱敏</span>
        <Switch :model-value="mask.on.value" aria-label="隐私脱敏" @update:model-value="mask.set($event)" />
      </div>
      <div class="ui-more__row is-ctl">
        <span class="ui-more__lb">减弱动效</span>
        <Switch :model-value="motion.reduced.value" aria-label="减弱动效" @update:model-value="motion.set($event ? 'reduce' : 'full')" />
      </div>
    </section>
    <button type="button" class="ui-more__row ui-more__out" @click="emit('logout')"><Icon name="out" /><span class="ui-more__lb">退出</span></button>
  </Sheet>
</template>

<style>
.ui-more__g + .ui-more__g, nav + .ui-more__g { margin-top: 12px; }
.ui-more__h { margin: 0 0 2px; font-family: var(--font-mono); font-size: var(--fs-micro); font-weight: 500; letter-spacing: .09em; color: var(--ink-3); }
.ui-more__row { all: unset; box-sizing: border-box; display: flex; align-items: center; gap: 12px; width: 100%; min-height: 48px; border-bottom: 1px solid var(--rule); color: var(--ink); font-size: var(--fs-md); cursor: pointer; }
.ui-more__row.is-ctl { cursor: default; justify-content: space-between; }
.ui-more__row:focus-visible { outline: 2px solid var(--signal); outline-offset: -2px; }
.ui-more__lb { flex: 1; min-width: 0; }
.ui-more__n { font: 600 var(--fs-xs) var(--font-mono); color: var(--signal-ink); }
.ui-more__out { margin-top: 12px; color: var(--ink-2); border-bottom: 0; }
</style>
