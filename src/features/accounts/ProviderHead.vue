<script setup lang="ts">
import { computed } from 'vue'
import { TxTag } from '@talex-touch/tuffex/tag'
import ProviderMark from '../../ui/data/ProviderMark.vue'
import Icon from '../../ui/Icon.vue'
import { flowLabel, type ProviderGroup, type ProviderInfo } from './model'

/**
 * Provider head (DESIGN §6.5, 46px / 44px mobile, one hairline under it): logo, name, vendor, the 登录风控
 * tag for the providers Magpie flags, the routing facts, and the in-place `+ 添加账号` (its flow is the title).
 */
const props = withDefaults(defineProps<{ group?: ProviderGroup | null; provider: ProviderInfo | null; name: string; vendor: string; compact?: boolean; headingId: string }>(), {
  group: null,
  compact: false,
})
const emit = defineEmits<{ add: [] }>()
const total = computed(() => props.group?.accounts.length ?? 0)
const facts = computed(() => {
  const g = props.group
  if (!g || !g.accounts.length) return ''
  const parts = [`${total.value} 账号`, `${g.routable} 参与路由`]
  if (g.tiered) parts.push('按优先级选号')
  return parts.join(' · ')
})
</script>

<template>
  <header class="acc-ph" :class="{ 'is-compact': compact }">
    <ProviderMark :provider="provider?.mark ?? name" :size="compact ? 20 : 22" />
    <h3 :id="headingId" class="acc-ph__name">{{ name }}</h3>
    <span v-if="!compact" class="acc-ph__vendor">{{ vendor }}</span>
    <TxTag v-if="provider?.risk && !compact" size="sm" variant="outline" label="登录有风控风险" title="通过网关共享订阅账号可能违反供应商条款" />
    <span v-if="facts" class="acc-ph__facts num">{{ compact ? `${total}` : facts }}</span>
    <button
      v-if="provider"
      type="button"
      class="ui-link acc-ph__add"
      :aria-label="`添加 ${provider.name} 账号`"
      :title="flowLabel(provider)"
      @click="emit('add')"
    ><Icon name="plus" :size="14" />{{ compact ? '添加' : '添加账号' }}</button>
  </header>
</template>

<style>
.acc-ph { display: flex; align-items: center; gap: 10px; min-height: var(--provider-head); border-bottom: 1px solid var(--rule-2); min-width: 0; }
.acc-ph__name { margin: 0; font-size: var(--fs-md); font-weight: 600; white-space: nowrap; }
.acc-ph__vendor { font-size: var(--fs-xs); color: var(--ink-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; flex: 0 1 auto; }
.acc-ph__facts { font-size: var(--fs-xs); color: var(--ink-3); white-space: nowrap; }
.acc-ph__add { margin-left: auto; display: inline-flex; align-items: center; gap: 4px; font-size: var(--fs-xs); flex: none; min-height: 28px; }
.acc-ph.is-compact { min-height: 44px; gap: 8px; }
@media (pointer: coarse) { .acc-ph__add { min-height: var(--tap); padding: 0 4px; } }
</style>
