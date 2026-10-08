<script setup lang="ts">
import Sheet from '../feedback/Sheet.vue'
import { TxKbd } from '@talex-touch/tuffex/kbd'
import Kbd from '../form/Kbd.vue'
import Switch from '../form/Switch.vue'
import { useSingleKeyPref } from '../composables/useShortcuts'
import type { ShellRole } from '../types'

/** `?` sheet (DESIGN.md §4.4): every shortcut, plus the 单键快捷键 switch (WCAG 2.1.4). Lazy-loaded by AppShell. */
const props = defineProps<{ role: ShellRole }>()
const open = defineModel<boolean>({ default: false })
const single = useSingleKeyPref()
const singleOn = single.on
const rows = [
  { keys: 'mod+k', label: '命令面板：跳转、执行、查找' },
  { keys: '/', label: '聚焦本页搜索' },
  { keys: props.role === 'admin' ? '1–7' : '1–4', label: '跳到第 N 个页面' },
  { keys: 't', label: '切换主题' },
  ...(props.role === 'admin' ? [{ keys: 'm', label: '隐私脱敏' }] : []),
  { keys: '?', label: '本页' },
  { keys: 'esc', label: '关闭最上层' },
]
</script>

<template>
  <Sheet v-model="open" title="快捷键" :en="role === 'admin' ? 'KEYS' : undefined" size="420px">
    <dl class="ui-keys">
      <template v-for="r in rows" :key="r.keys">
        <dt><Kbd v-if="!r.keys.includes('–')" :keys="r.keys" size="md" /><TxKbd v-else size="md">{{ r.keys }}</TxKbd></dt>
        <dd>{{ r.label }}</dd>
      </template>
    </dl>
    <div class="ui-keys__pref">
      <span>单键快捷键<small>输入框内与按住修饰键时不响应</small></span>
      <Switch :model-value="singleOn" aria-label="单键快捷键" @update:model-value="single.set($event)" />
    </div>
  </Sheet>
</template>

<style>
.ui-keys { display: grid; grid-template-columns: 72px minmax(0, 1fr); align-items: center; margin: 0; font-size: var(--fs-base); }
.ui-keys dt, .ui-keys dd { margin: 0; min-height: 36px; display: flex; align-items: center; border-bottom: 1px solid var(--rule); }
.ui-keys dd { color: var(--ink-2); }
.ui-keys__pref { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 16px; font-size: var(--fs-base); }
.ui-keys__pref small { display: block; font-size: var(--fs-xs); color: var(--ink-3); }
</style>
