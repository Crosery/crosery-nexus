<script setup lang="ts">
import { computed, useTemplateRef, watch } from 'vue'
import { TxFlex } from '@talex-touch/tuffex/flex'
import { TxSearchInput } from '@talex-touch/tuffex/search-input'
import { useSkinPref } from '../../lib/skin'
import { useQueryState } from '../../lib/listState'
import { useShortcuts } from '../composables/useShortcuts'
import Kbd from './Kbd.vue'

/**
 * Page search (DESIGN.md §5.2 form/SearchField): TxSearchInput, `/` focuses it (single-key shortcut rules:
 * ignored in fields, switchable off). `query` syncs the text to that URL key (debounced by useQueryState).
 */
const props = withDefaults(
  defineProps<{
    placeholder?: string
    /** accessible name (defaults to the placeholder) */
    label?: string
    query?: string
    /** bind `/` to focus this field (one per page) */
    slash?: boolean
  }>(),
  { placeholder: '搜索', label: undefined, query: undefined, slash: true },
)
const model = defineModel<string>({ default: '' })
const root = useTemplateRef<HTMLElement | { $el: HTMLElement }>('root')

const url = props.query ? useQueryState({ [props.query]: '' }) : null
if (url && props.query) {
  const key = props.query
  watch(() => url.state[key], (value) => { if (value !== model.value) model.value = value }, { immediate: true })
  watch(model, (value) => { if (url.state[key] !== value) url.state[key] = value })
}

function focus() {
  const element = root.value && ('$el' in root.value ? root.value.$el : root.value)
  const input = element?.querySelector('input')
  input?.focus()
  input?.select()
}
if (props.slash) useShortcuts({ '/': focus })
const { pref: skin } = useSkinPref()
const minimal = computed(() => skin.value === 'minimal')
defineExpose({ focus })
</script>

<template>
  <component :is="minimal ? TxFlex : 'div'" ref="root" class="ui-search" :direction="minimal ? 'row' : undefined" :gap="minimal ? 8 : undefined" align="center" role="search">
    <TxSearchInput v-model="model" :placeholder="placeholder" :aria-label="label ?? placeholder" clearable />
    <Kbd v-if="slash && !model" keys="/" class="ui-search__kbd" />
  </component>
</template>

<style>
.ui-search { position: relative; min-width: 0; width: 240px; max-width: 100%; }
.ui-search .tx-search-input, .ui-search .tx-input { width: 100%; }
.ui-search__kbd { position: absolute; right: 8px; top: 50%; transform: translateY(-50%); pointer-events: none; }
@media (max-width: 599px) { .ui-search { width: 100%; } html:root .ui-search .ui-search__kbd { display: none; } }
</style>
