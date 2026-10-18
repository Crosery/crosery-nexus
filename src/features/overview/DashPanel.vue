<script setup lang="ts">
import { useId } from 'vue'
import { TxButton } from '@talex-touch/tuffex/button'
import { TxStatusBadge } from '@talex-touch/tuffex/status-badge'
import StateBlock from '../../ui/data/StateBlock.vue'
import { fmtTime } from '../../ui/fmt'
import type { DataState } from '../../ui/types'

/**
 * One panel of the 简约 概览 dashboard (Tuff Pulse `.pulse__panel`): white surface, title + sub on the left, actions
 * on the right. Loading / empty / error / forbidden render through StateBlock (TxSkeleton · TxEmptyState ·
 * TxErrorState with a real retry); stale keeps the last data and says so beside a retry.
 */
withDefaults(
  defineProps<{
    title: string
    sub?: string | null
    state?: DataState
    error?: unknown
    staleAt?: number | null
    rows?: number
    cols?: string[]
    emptyText?: string
    emptyAction?: string
    /** the body runs edge to edge (tables); the head keeps its padding */
    flush?: boolean
  }>(),
  { sub: null, state: 'ready', error: undefined, staleAt: null, rows: 4, cols: undefined, emptyText: undefined, emptyAction: undefined, flush: false },
)
const emit = defineEmits<{ retry: []; 'empty-action': [] }>()
const headingId = useId()
</script>

<template>
  <section class="ovd-panel" :class="{ 'is-flush': flush }" :aria-labelledby="headingId">
    <header class="ovd-panel__head">
      <div class="ovd-panel__titles">
        <h2 :id="headingId" class="ovd-panel__title">{{ title }}</h2>
        <span v-if="sub || $slots.sub" class="ovd-panel__sub"><slot name="sub">{{ sub }}</slot></span>
      </div>
      <div v-if="state === 'stale' || $slots.actions" class="ovd-panel__actions">
        <template v-if="state === 'stale'">
          <TxStatusBadge size="sm" status="warning" :text="staleAt ? `数据陈旧 · ${fmtTime(staleAt)}` : '数据陈旧'" />
          <TxButton size="sm" variant="ghost" @click="emit('retry')">重试</TxButton>
        </template>
        <slot name="actions" />
      </div>
    </header>
    <div v-if="state === 'ready' || state === 'stale'" class="ovd-panel__body">
      <slot />
    </div>
    <div v-else class="ovd-panel__state">
      <StateBlock
        :state="state"
        :rows="rows"
        :cols="cols"
        :error="error"
        :empty-text="emptyText"
        :action-label="emptyAction"
        @retry="emit('retry')"
        @action="emit('empty-action')"
      />
    </div>
    <footer v-if="$slots.footer && (state === 'ready' || state === 'stale')" class="ovd-panel__foot">
      <slot name="footer" />
    </footer>
  </section>
</template>
