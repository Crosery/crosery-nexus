<script setup lang="ts">
import { nextTick, ref } from 'vue'
import { TxIconButton } from '@talex-touch/tuffex/button'
import { TxDropdownItem, TxDropdownMenu } from '@talex-touch/tuffex/dropdown-menu'
import Icon from '../../ui/Icon.vue'
import { CALM_MENU } from '../../ui/form/anchor'
import type { MenuItem, RowAction } from './magpieModel'

/**
 * Row `⋯` (Magpie's account actions): 设为首选 · 同时启用 / 停用 · 使用重置 (ChatGPT) · 重新登录 · 移除….
 * An item that cannot run stays listed, disabled, with its reason under the label. Focus goes back to the
 * trigger before the action runs, so a confirm sheet returns focus to a button that still exists.
 */
const props = defineProps<{ label: string; items: MenuItem[]; busy?: boolean }>()
const emit = defineEmits<{ action: [action: RowAction] }>()

const open = ref(false)
const trigger = ref<{ $el: HTMLElement } | null>(null)

async function run(item: MenuItem) {
  if (item.disabled) return
  open.value = false
  await nextTick()
  trigger.value?.$el?.focus()
  emit('action', item.action)
}
</script>

<template>
  <TxDropdownMenu v-model="open" class="mx-menu" placement="bottom-end" :min-width="200" :offset="4" v-bind="CALM_MENU">
    <template #trigger>
      <TxIconButton
        ref="trigger"
        class="mx-menu__trigger"
        size="sm"
        :label="`${props.label} · 更多操作`"
        aria-haspopup="menu"
        :aria-expanded="open"
        :disabled="busy"
      >
        <Icon name="more" />
      </TxIconButton>
    </template>
    <template v-for="(item, i) in items" :key="item.action">
      <div v-if="item.danger && i > 0" class="mx-menu__rule" role="separator" />
      <TxDropdownItem :disabled="Boolean(item.disabled)" :danger="item.danger && !item.disabled" @select="run(item)">
        <span class="mx-menu__item">
          <span>{{ item.label }}</span>
          <span v-if="item.disabled" class="mx-menu__why">{{ item.disabled }}</span>
        </span>
      </TxDropdownItem>
    </template>
  </TxDropdownMenu>
</template>

<style>
.mx-menu__rule { height: 1px; margin: 4px 6px; background: var(--rule); }
.mx-menu__item { display: grid; gap: 1px; }
.mx-menu__why { font-size: var(--fs-xs); color: var(--ink-3); }
html:root .mx-menu__trigger[aria-expanded="true"] { background: var(--paper-2); color: var(--ink); }
</style>
