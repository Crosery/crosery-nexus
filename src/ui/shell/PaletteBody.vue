<script setup lang="ts">
import { computed } from 'vue'
import { TxCommandPalette } from '@talex-touch/tuffex/command-palette'
import type { CommandItem } from '../types'

/**
 * Palette body (lazy, see CommandPalette.vue): TxCommandPalette restyled to a solid sheet with one hairline,
 * 48px input, 40px rows tagged 跳转 / 操作 / 查找 / 视图 in plain ink-3 text, the selected row a light fill. Full-height top
 * sheet below 960px. Disabled commands stay listed with their hint (e.g. `冷却 04:12`).
 */
const props = defineProps<{ commands: CommandItem[]; placeholder: string }>()
const open = defineModel<boolean>({ default: false })
const ORDER = { GO: 0, ACT: 1, FIND: 2, VIEW: 3 } as const
const WORD = { GO: '跳转', ACT: '操作', FIND: '查找', VIEW: '视图' } as const
const items = computed(() =>
  [...props.commands]
    .sort((a, b) => ORDER[a.section] - ORDER[b.section])
    .map((c) => ({ id: c.id, title: c.title, description: c.hint, keywords: c.keywords, shortcut: WORD[c.section], disabled: c.disabled })),
)
function onSelect(item: { id: string }) {
  const cmd = props.commands.find((c) => c.id === item.id)
  if (!cmd || cmd.disabled) return
  open.value = false
  cmd.run()
}
</script>

<template>
  <TxCommandPalette
    v-model="open"
    :commands="items"
    :placeholder="placeholder"
    empty-text="— 没有匹配的页面或操作"
    aria-label="命令面板"
    overlay-class="ui-pal__overlay"
    panel-class="ui-pal"
    :max-height="420"
    @select="onSelect"
  />
</template>

<style>
html:root .ui-pal__overlay { background: var(--scrim); padding-top: 12vh; }
html:root .ui-pal { width: min(92vw, 600px); background: var(--sheet); border: 1px solid var(--rule-2); border-radius: var(--r-2); box-shadow: var(--shadow-pop); }
html:root .ui-pal .tx-command-palette__search { height: 48px; padding: 0 14px; border-bottom: 1px solid var(--rule); }
html:root .ui-pal .tx-command-palette__input { font-size: var(--fs-md); color: var(--ink); }
html:root .ui-pal .tx-command-palette__list { gap: 0; padding: 6px; }
html:root .ui-pal .tx-command-palette__item { min-height: 40px; padding: 0 10px; border-radius: var(--r-1); gap: 10px; flex-direction: row-reverse; justify-content: flex-end; }
html:root .ui-pal .tx-command-palette__item.is-active { background: var(--paper-2); color: var(--ink); box-shadow: inset 2px 0 0 var(--ink); }
html:root .ui-pal .tx-command-palette__item.is-disabled { opacity: 1; color: var(--ink-3); }
html:root .ui-pal .tx-command-palette__content { flex-direction: row; align-items: baseline; gap: 10px; }
html:root .ui-pal .tx-command-palette__title { font-size: var(--fs-base); font-weight: 500; }
html:root .ui-pal .tx-command-palette__desc { font-size: var(--fs-xs); color: var(--ink-3); font-family: var(--font-mono); }
html:root .ui-pal .tx-command-palette__shortcut { flex: none; width: 3em; padding: 0; border: 0; background: none; font-size: var(--fs-xs); color: var(--ink-3); }
html:root .ui-pal .tx-command-palette__highlight { background: none; text-decoration: underline; text-underline-offset: 2px; }
html:root .ui-pal .tx-command-palette__empty { text-align: left; color: var(--ink-3); }
@media (max-width: 959px) {
  html:root .ui-pal__overlay { padding: 0; align-items: stretch; }
  html:root .ui-pal { width: 100%; height: 100%; border: 0; border-radius: 0; }
  html:root .ui-pal .tx-command-palette__list { max-height: calc(100dvh - 60px); }
  html:root .ui-pal .tx-command-palette__item { min-height: 44px; }
}
</style>
