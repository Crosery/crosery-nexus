<script setup lang="ts">
import { watch } from 'vue'
import { useQueryState } from '../../lib/listState'
import Segmented from './Segmented.vue'
import FilterField from './FilterField.vue'
import type { FilterBarField, SegmentItem } from '../types'

/**
 * Filter bar (DESIGN.md §5.2 form/FilterBar, §6.7): an optional range Segmented plus FilterFields, all bound
 * to the URL through ONE useQueryState (defaults stay out of the URL). One row on desktop; on mobile the range
 * runs full width and the fields sit 2×2 — everything wraps, nothing scrolls sideways. The resolved filter
 * object is the v-model (string values; '' = all). Slot `extra` = right-aligned meta / actions.
 */
const props = withDefaults(
  defineProps<{
    range?: { key: string; label?: string; items: SegmentItem[]; default: string } | null
    fields?: FilterBarField[]
  }>(),
  { range: null, fields: () => [] },
)
const model = defineModel<Record<string, string>>({ default: () => ({}) })

const defaults: Record<string, string> = {}
if (props.range) defaults[props.range.key] = props.range.default
for (const f of props.fields) defaults[f.key] = f.default ?? ''
const q = useQueryState(defaults)
const state = q.state as Record<string, string>

watch(
  () => ({ ...state }),
  (next) => {
    const same = Object.keys(next).every((k) => model.value[k] === next[k])
    if (!same) model.value = { ...model.value, ...next }
  },
  { immediate: true, deep: true },
)
function set(key: string, value: string | number | null | undefined) {
  state[key] = value === null || value === undefined ? '' : String(value)
}
defineExpose({ reset: q.reset, activeKeys: q.activeKeys })
</script>

<template>
  <div class="ui-fbar">
    <Segmented
      v-if="range"
      class="ui-fbar__range"
      :items="range.items"
      :label="range.label ?? '时间范围'"
      :model-value="state[range.key]"
      @update:model-value="set(range.key, $event)"
    />
    <div v-if="fields.length" class="ui-fbar__fields">
      <FilterField
        v-for="f in fields"
        :key="f.key"
        :label="f.label"
        :options="f.options"
        :all-label="f.allLabel"
        :model-value="state[f.key]"
        @update:model-value="set(f.key, $event)"
      />
    </div>
    <div v-if="$slots.extra" class="ui-fbar__extra"><slot name="extra" /></div>
  </div>
</template>

<style>
.ui-fbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 10px; min-width: 0; }
.ui-fbar__fields { display: flex; flex-wrap: wrap; gap: 8px; min-width: 0; }
.ui-fbar__extra { margin-left: auto; display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; font-size: var(--fs-xs); color: var(--ink-3); min-width: 0; }
@media (max-width: 959px) {
  html:root .ui-fbar__range { display: flex; width: 100%; }
  html:root .ui-fbar__range .tx-bui-filter-chips__chip { flex: 1 1 0; justify-content: center; }
  .ui-fbar__fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); width: 100%; }
  .ui-fbar__fields .ui-ff { width: 100%; }
  .ui-fbar__extra { margin-left: 0; width: 100%; }
}
</style>
