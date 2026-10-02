<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, useId, useTemplateRef } from 'vue'
import { TxSelect } from '@talex-touch/tuffex/select'
import { CALM_PANEL } from './anchor'
import { fmtInt } from '../fmt'
import type { SegmentItem } from '../types'

/**
 * Filter field (DESIGN.md §5.2 form/FilterField): `厂商 [全部 ⌄]` — the label is plain text OUTSIDE the box, the
 * TxSelect trigger is the only box (so the label can never be covered and the panel lines up with the box).
 * The first option is "全部" (value '') unless `allLabel` is null. Searchable only past 8 options.
 */
const props = withDefaults(
  defineProps<{
    label: string
    options: SegmentItem[]
    /** label of the empty value; null = no "all" option */
    allLabel?: string | null
    /** result count for the current value, shown after the box */
    count?: number | null
    searchable?: boolean
  }>(),
  { allLabel: '全部', count: null, searchable: true },
)
const model = defineModel<string>({ default: '' })
const id = useId()

const selectOptions = computed(() => [
  ...(props.allLabel === null ? [] : [{ value: '', label: props.allLabel }]),
  ...props.options.map((o) => ({ value: String(o.value), label: o.count != null ? `${o.label} · ${fmtInt(o.count)}` : o.label, disabled: o.disabled })),
])

/* TxSelect moves arrow-key focus through aria-activedescendant only (no class on the option): mirror it as
   `.is-kbd` so sighted keyboard users see which option Enter will pick. */
const root = useTemplateRef<HTMLElement>('root')
let observer: MutationObserver | null = null
let marked: Element | null = null
function syncKbd(input: HTMLElement) {
  marked?.classList.remove('is-kbd')
  const target = input.getAttribute('aria-activedescendant')
  marked = target ? document.getElementById(target) : null
  marked?.classList.add('is-kbd')
}
onMounted(() => {
  const input = root.value?.querySelector<HTMLElement>('[role="combobox"]')
  if (!input || typeof MutationObserver === 'undefined') return
  observer = new MutationObserver(() => syncKbd(input))
  observer.observe(input, { attributes: true, attributeFilter: ['aria-activedescendant'] })
})
onBeforeUnmount(() => {
  observer?.disconnect()
  marked?.classList.remove('is-kbd')
})
</script>

<template>
  <div ref="root" class="ui-ff" :class="{ 'is-set': model !== '' }">
    <label class="ui-ff__k" :for="id">{{ label }}</label>
    <TxSelect
      :id="id"
      v-model="model"
      class="ui-ff__sel"
      v-bind="CALM_PANEL"
      :options="selectOptions"
      :searchable="searchable && selectOptions.length > 8"
      :placeholder="allLabel ?? '请选择'"
      search-placeholder="筛选…"
      empty-text="没有匹配项"
      loading-text="加载中…"
      :dropdown-offset="4"
      :aria-label="label"
    />
    <span v-if="count != null" class="ui-ff__n num" aria-hidden="true">{{ count }}</span>
  </div>
</template>

<style>
.ui-ff { display: inline-flex; align-items: center; gap: 8px; min-width: 0; max-width: 100%; }
.ui-ff__k { flex: none; font-size: var(--fs-sm); color: var(--ink-3); white-space: nowrap; cursor: pointer; }
.ui-ff__n { flex: none; font-size: var(--fs-xs); color: var(--ink-3); }
html:root .ui-ff .tuff-select { min-width: 0; flex: 1 1 auto; }
@media (min-width: 600px) { html:root .ui-ff .tuff-select { min-width: 132px; } }
html:root .ui-ff .tx-input { padding: 0 6px 0 10px; }
html:root .ui-ff.is-set .tx-input { border-color: var(--ink-3); }
html:root .ui-ff .tx-input__inner { font-size: var(--fs-sm); }
</style>
