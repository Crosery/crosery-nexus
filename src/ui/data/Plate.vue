<script setup lang="ts">
import { computed, inject, provide, ref } from 'vue'
import { TxCard } from '@talex-touch/tuffex/card'
import StateBlock from './StateBlock.vue'
import { usePrintIn } from '../composables/usePrintIn'
import { useNow, toMs } from '../composables/useNow'
import { fmtAgo } from '../fmt'
import type { DataState } from '../composables/useLive'

/**
 * A region: TxCard (pure sheet fill on the paper, no border, no shadow, 2px radius) — the tonal step alone
 * separates regions, so there are no corner ticks / crop marks (calm-down). Never nested.
 * Head: the Chinese title, then meta / actions on the right — nothing else: `idx` (01…) and `en` (ATTENTION…)
 * are still accepted for compatibility but no longer rendered (calm-down).
 * `state` handles §5.1: loading/empty/error/forbidden replace the body with a StateBlock; stale keeps the body
 * in ink-2 and reads `◇ 陈旧 · 3m 前 · 重试` in the meta.
 */
const props = withDefaults(
  defineProps<{
    title: string
    /** @deprecated not rendered */
    idx?: string | number
    /** @deprecated not rendered */
    en?: string
    state?: DataState
    staleAt?: string | number | Date | null
    error?: unknown
    /** skeleton rows / columns while loading */
    rows?: number
    cols?: string[]
    emptyText?: string
    emptyAction?: string
    /** no bottom padding: the body (a table) runs to the bottom edge */
    flush?: boolean
    /** print in with the route scanline */
    print?: boolean
    as?: string
    headingLevel?: 2 | 3
  }>(),
  {
    idx: undefined,
    en: undefined,
    state: 'ready',
    staleAt: null,
    error: undefined,
    rows: 4,
    cols: undefined,
    emptyText: undefined,
    emptyAction: undefined,
    flush: false,
    print: true,
    as: 'section',
    headingLevel: 2,
  },
)

const emit = defineEmits<{ (e: 'retry'): void; (e: 'empty-action'): void }>()

const nested = inject<boolean>('ui-plate', false)
if (nested && import.meta.env.DEV) console.warn(`[ui] <Plate title="${props.title}"> is nested in another Plate — plates never nest (DESIGN.md §7.1)`)
provide('ui-plate', true)

const root = ref<HTMLElement | null>(null)
usePrintIn(root, () => props.print)

const now = useNow()
const showBody = computed(() => props.state === 'ready' || props.state === 'stale')
const staleLabel = computed(() => {
  const at = toMs(props.staleAt)
  return at === null ? '陈旧' : `陈旧 · ${fmtAgo(at, now.value)}`
})
const headingTag = computed(() => `h${props.headingLevel}`)
</script>

<template>
  <component
    :is="as"
    ref="root"
    class="ui-plate"
    :class="{ 'is-flush': flush, 'is-stale': state === 'stale' }"
    :aria-busy="state === 'loading' || undefined"
  >
    <TxCard class="ui-plate__card" variant="plain" background="pure" shadow="none" :radius="2" :padding="0">
      <header class="ui-plate__head">
        <component :is="headingTag" class="ui-plate__title">{{ title }}</component>
        <slot name="title-extra" />
        <div class="ui-plate__meta">
          <span v-if="state === 'stale'" class="ui-plate__stale">
            <span aria-hidden="true">◇</span> {{ staleLabel }}
            <button type="button" class="ui-link" @click="emit('retry')">重试</button>
          </span>
          <slot name="meta" />
          <slot name="actions" />
        </div>
      </header>
      <div class="ui-plate__body">
        <slot v-if="showBody" />
        <StateBlock
          v-else
          :state="state"
          :rows="rows"
          :cols="cols"
          :error="error"
          :empty-text="emptyText"
          :action-label="emptyAction"
          @retry="emit('retry')"
          @action="emit('empty-action')"
        >
          <template v-if="$slots.empty" #empty-extra><slot name="empty" /></template>
        </StateBlock>
      </div>
      <footer v-if="$slots.footer" class="ui-plate__foot"><slot name="footer" /></footer>
    </TxCard>
  </component>
</template>

<style>
/* --surface: what sits under the plate's content (fixed table columns, sticky heads paint it) */
.ui-plate { --surface: var(--sheet); position: relative; min-width: 0; display: flex; flex-direction: column; }
html:root .ui-plate > .ui-plate__card {
  flex: 1 1 auto; min-width: 0; padding: 0 14px 12px; background: var(--surface);
  will-change: auto; transform: none; transition: none; touch-action: auto;
}
html:root .ui-plate > .ui-plate__card > .tx-card__surface { display: none; }
html:root .ui-plate > .ui-plate__card > .tx-card__body { flex: 1 1 auto; display: flex; flex-direction: column; min-width: 0; }
.ui-plate.is-flush > .ui-plate__card { padding-bottom: 0; }
.ui-plate__head { display: flex; align-items: center; gap: 10px; min-height: 42px; min-width: 0; }
.ui-plate__title { margin: 0; font-size: var(--fs-base); font-weight: 600; letter-spacing: .01em; white-space: nowrap; flex: none; }
.ui-plate__meta {
  margin-left: auto; display: flex; flex-wrap: wrap; justify-content: flex-end; align-items: center; gap: 2px 12px; flex: 0 1 auto; min-width: 0;
  color: var(--ink-3); font-size: var(--fs-xs); white-space: nowrap;
}
.ui-plate__stale { display: inline-flex; align-items: center; gap: 6px; color: var(--ink-2); }
.ui-plate__stale .ui-link { font-size: var(--fs-xs); }
.ui-plate.is-stale .ui-plate__body { color: var(--ink-2); }
.ui-plate__body { flex: 1 1 auto; min-width: 0; }
/* a stretched plate (grid `.stretch`) lets its body column fill the height */
.ui-plate.stretch .ui-plate__body { display: flex; flex-direction: column; }
.ui-plate__foot { margin-top: 10px; display: flex; justify-content: space-between; align-items: center; gap: 12px; font-size: var(--fs-xs); color: var(--ink-3); }
@media (max-width: 959px) {
  .ui-plate__head { min-height: 44px; flex-wrap: wrap; row-gap: 2px; padding: 8px 0 6px; }
  .ui-plate__meta { flex-wrap: wrap; white-space: normal; row-gap: 4px; }
}
</style>
