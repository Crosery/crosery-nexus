<script setup lang="ts">
import { TxButton } from '@talex-touch/tuffex/button'
import StateBlock from '../../../ui/data/StateBlock.vue'
import type { DataState } from '../../../ui/types'
import { isPendingRestart } from './format'

/**
 * Non-ready states of the 用量 tabs: the kit StateBlock, plus one honest line for "the service still runs the
 * previous build" (instead of `503 · 服务器出错了`).
 */
withDefaults(
  defineProps<{ state: DataState; error?: unknown; rows?: number; cols?: string[]; emptyText?: string; actionLabel?: string }>(),
  { error: null, rows: 3, cols: undefined, emptyText: '没有数据', actionLabel: undefined },
)
const emit = defineEmits<{ retry: []; action: [] }>()
</script>

<template>
  <div v-if="state === 'error' && isPendingRestart(error)" class="uw-pending" role="status">
    <span class="uw-pending__mark" aria-hidden="true">◇</span>
    <span>用量接口待重启生效</span>
    <span class="uw-pending__why">控制台服务还是旧版本 · 重启后自动显示</span>
    <TxButton size="sm" @click="emit('retry')">重试</TxButton>
  </div>
  <StateBlock
    v-else
    :state="state"
    :error="error"
    :rows="rows"
    :cols="cols"
    :empty-text="emptyText"
    :action-label="actionLabel"
    @retry="emit('retry')"
    @action="emit('action')"
  />
</template>

<style>
.uw-pending { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; min-height: 34px; font-size: var(--fs-sm); color: var(--ink); }
.uw-pending__mark { font-family: var(--font-mono); width: 12px; text-align: center; color: var(--ink-2); }
.uw-pending__why { color: var(--ink-3); }
</style>
