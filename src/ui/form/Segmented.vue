<script setup lang="ts">
import { computed, watch } from 'vue'
import { TxFilterChips } from '@talex-touch/tuffex/filter-chips'
import { useQueryState } from '../../lib/listState'
import type { SegmentItem } from '../types'

/**
 * Segmented control (DESIGN.md §5.2 form/Segmented, motion recipe 8): TxFilterChips restyled (styles/tx/
 * filter-chips.css) into one 1px ctl box whose ink fill slides under the active item; 30px on fine pointers,
 * 42px on touch; it WRAPS instead of scrolling. `query` binds the value to that URL key (default values stay
 * out of the URL), so filters survive reload and shared links.
 */
const props = withDefaults(
  defineProps<{
    items: SegmentItem[]
    /** accessible name, e.g. "时间范围" */
    label: string
    /** URL query key to sync with */
    query?: string
    /** value when the URL has no key (query mode) */
    defaultValue?: string | number
    /** stretch items to fill the row (mobile range control) */
    block?: boolean
    disabled?: boolean
    /** tablist when the segments switch panels (selection follows focus) */
    tabs?: boolean
  }>(),
  { query: undefined, defaultValue: undefined, block: false, disabled: false, tabs: false },
)
const model = defineModel<string | number | null>()

const url = props.query ? useQueryState({ [props.query]: String(props.defaultValue ?? props.items[0]?.value ?? '') }) : null
if (url && props.query) {
  const key = props.query
  watch(
    () => url.state[key],
    (value) => {
      const match = props.items.find((item) => String(item.value) === value)
      if (match && model.value !== match.value) model.value = match.value
    },
    { immediate: true },
  )
}

const chips = computed(() => props.items.map((item) => ({ value: item.value, label: item.label, count: item.count ?? undefined, disabled: item.disabled })))
const current = computed(() => model.value ?? props.defaultValue ?? props.items[0]?.value)
function onChange(value: string | number) {
  model.value = value
  if (url && props.query) url.state[props.query] = String(value)
}
</script>

<template>
  <TxFilterChips
    class="ui-seg"
    :class="{ 'ui-seg--block': block }"
    :model-value="current"
    :items="chips"
    :disabled="disabled"
    :aria-label="label"
    :role="tabs ? 'tablist' : 'toolbar'"
    @update:model-value="onChange"
  />
</template>

<style>
html:root .ui-seg.ui-seg--block { display: flex; width: 100%; }
html:root .ui-seg.ui-seg--block .tx-bui-filter-chips__chip { flex: 1 1 0; justify-content: center; }
</style>
