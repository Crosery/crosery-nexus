<script setup lang="ts">
import { nextTick, ref } from 'vue'
import { TxIconButton } from '@talex-touch/tuffex/button'
import { TxDropdownItem, TxDropdownMenu } from '@talex-touch/tuffex/dropdown-menu'
import Icon from '../../ui/Icon.vue'
import { CALM_MENU } from '../../ui/form/anchor'

/**
 * Row `⋯` menu (DESIGN §6.0 actions): the rare actions of one Key. Destructive items (停用, 删除) are `danger`,
 * sit last below a rule, and every one of them goes through a confirm sheet in the page. Focus goes back to
 * the trigger before the action runs, so the sheet / confirm returns focus to a button that still exists.
 */
type Action = 'edit' | 'quota' | 'reveal' | 'reset-daily' | 'toggle' | 'delete'

const props = defineProps<{
  name: string
  enabled: boolean
  blocked: boolean
  hasDaily: boolean
}>()
const emit = defineEmits<{ action: [action: Action] }>()

const open = ref(false)
const trigger = ref<{ $el: HTMLElement } | null>(null)

async function run(action: Action) {
  open.value = false
  await nextTick()
  trigger.value?.$el?.focus()
  emit('action', action)
}
</script>

<template>
  <TxDropdownMenu v-model="open" class="kx-menu" placement="bottom-end" :min-width="184" :offset="4" v-bind="CALM_MENU">
    <template #trigger>
      <TxIconButton
        ref="trigger"
        class="kx-menu__trigger"
        size="sm"
        :label="`${props.name} · 更多操作`"
        aria-haspopup="menu"
        :aria-expanded="open"
      >
        <Icon name="more" />
      </TxIconButton>
    </template>
    <TxDropdownItem @select="run('edit')">编辑</TxDropdownItem>
    <TxDropdownItem @select="run('quota')">调整额度</TxDropdownItem>
    <TxDropdownItem @select="run('reveal')">显示完整 Key</TxDropdownItem>
    <TxDropdownItem v-if="hasDaily" @select="run('reset-daily')">重置今日额度</TxDropdownItem>
    <div class="kx-menu__rule" role="separator" />
    <TxDropdownItem v-if="blocked" disabled>
      启用
      <template #right><span class="kx-menu__hint">先调额度</span></template>
    </TxDropdownItem>
    <TxDropdownItem v-else :danger="enabled" @select="run('toggle')">{{ enabled ? '停用' : '启用' }}</TxDropdownItem>
    <TxDropdownItem danger @select="run('delete')">删除</TxDropdownItem>
  </TxDropdownMenu>
</template>

<style>
.kx-menu__rule { height: 1px; margin: 4px 6px; background: var(--rule); }
.kx-menu__hint { font-size: var(--fs-xs); color: var(--ink-3); }
html:root .kx-menu__trigger[aria-expanded="true"] { background: var(--paper-2); color: var(--ink); }
</style>
