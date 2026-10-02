<script setup lang="ts">
import { nextTick, ref } from 'vue'
import { TxIconButton } from '@talex-touch/tuffex/button'
import { TxDropdownItem, TxDropdownMenu } from '@talex-touch/tuffex/dropdown-menu'
import Icon from '../../ui/Icon.vue'
import { CALM_MENU } from '../../ui/form/anchor'
import type { ProxyRowAction } from './proxyModel'

/**
 * Row `⋯` of one exit. Removing or switching off an exit that accounts still use is not offered here: the item is
 * disabled with the reason (move those accounts first). Focus returns to the trigger before the action runs.
 */
const props = defineProps<{
  name: string
  enabled: boolean
  inUse: number
  assignable: boolean
  assignReason: string | null
  /** 设为默认出口 is a CPA-only write */
  canDefault: boolean
  isDefault: boolean
}>()
const emit = defineEmits<{ action: [action: ProxyRowAction] }>()

const open = ref(false)
const trigger = ref<{ $el: HTMLElement } | null>(null)

async function run(action: ProxyRowAction) {
  open.value = false
  await nextTick()
  trigger.value?.$el?.focus()
  emit('action', action)
}
</script>

<template>
  <TxDropdownMenu v-model="open" class="px-menu" placement="bottom-end" :min-width="184" :offset="4" v-bind="CALM_MENU">
    <template #trigger>
      <TxIconButton ref="trigger" class="px-menu__trigger" size="sm" :label="`${props.name} · 更多操作`" aria-haspopup="menu" :aria-expanded="open">
        <Icon name="more" />
      </TxIconButton>
    </template>
    <TxDropdownItem @select="run('test')">立即检测</TxDropdownItem>
    <TxDropdownItem v-if="assignable" @select="run('assign')">分配给账号…</TxDropdownItem>
    <TxDropdownItem v-else disabled>
      分配给账号…
      <template #right><span class="px-menu__hint">{{ assignReason }}</span></template>
    </TxDropdownItem>
    <TxDropdownItem v-if="canDefault && !isDefault" :disabled="!assignable" @select="run('default')">设为默认出口</TxDropdownItem>
    <TxDropdownItem @select="run('edit')">重命名 / 标签</TxDropdownItem>
    <div class="px-menu__rule" role="separator" />
    <TxDropdownItem v-if="inUse > 0" disabled>
      {{ enabled ? '停用' : '启用' }}
      <template #right><span class="px-menu__hint">在用 {{ inUse }}</span></template>
    </TxDropdownItem>
    <TxDropdownItem v-else @select="run('toggle')">{{ enabled ? '停用' : '启用' }}</TxDropdownItem>
    <TxDropdownItem v-if="inUse > 0" disabled>
      删除
      <template #right><span class="px-menu__hint">先换出口</span></template>
    </TxDropdownItem>
    <TxDropdownItem v-else danger @select="run('remove')">删除</TxDropdownItem>
  </TxDropdownMenu>
</template>

<style>
.px-menu__rule { height: 1px; margin: 4px 6px; background: var(--rule); }
.px-menu__hint { font-size: var(--fs-xs); color: var(--ink-3); }
html:root .px-menu__trigger[aria-expanded="true"] { background: var(--paper-2); color: var(--ink); }
</style>
