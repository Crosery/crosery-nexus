<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { TxButton, TxIconButton } from '@talex-touch/tuffex/button'
import Icon from '../Icon.vue'
import Segmented from './Segmented.vue'
import { copyText } from '../feedback/toast'
import { useBreakpoint } from '../composables/useBreakpoint'

/**
 * Code snippet (DESIGN.md §5.2 form/CodeSnippet, /me/connect): a Segmented to switch clients, a <pre> with
 * the highlighted tokens (default `$CROSERY_API_KEY`) marked, and a copy button. Below 600px it wraps by
 * default (toggle 换行); otherwise long lines scroll inside the block with an edge fade — never the page.
 * `copyValue` per variant lets the copy differ from the shown code (e.g. an empty export).
 */
const props = withDefaults(
  defineProps<{
    variants: Array<{ id: string; label: string; code: string; copyValue?: string }>
    highlight?: string[]
    /** accessible name of the variant switch */
    label?: string
    /** URL key for the selected variant */
    query?: string
  }>(),
  { highlight: () => ['$CROSERY_API_KEY'], label: '客户端', query: undefined },
)
const selected = defineModel<string>('variant', { default: '' })
const { isCompact } = useBreakpoint()
const wrap = ref(isCompact.value)
watch(isCompact, (compact) => (wrap.value = compact))

const current = computed(() => props.variants.find((v) => v.id === selected.value) ?? props.variants[0])
const items = computed(() => props.variants.map((v) => ({ value: v.id, label: v.label })))
const parts = computed(() => {
  const code = current.value?.code ?? ''
  const tokens = props.highlight.filter(Boolean)
  if (!tokens.length) return [{ text: code, mark: false }]
  const escaped = tokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  return code.split(new RegExp(`(${escaped.join('|')})`, 'g')).filter((t) => t !== '').map((text) => ({ text, mark: tokens.includes(text) }))
})
function copy() {
  if (current.value) void copyText(current.value.copyValue ?? current.value.code, current.value.label)
}
</script>

<template>
  <div class="ui-code">
    <div class="ui-code__bar">
      <Segmented v-if="variants.length > 1" v-model="selected" :items="items" :label="label" :query="query" :default-value="variants[0]?.id" />
      <span class="ui-code__tools">
        <TxButton variant="ghost" size="sm" class="ui-code__wrap" :class="{ 'is-on': wrap }" :aria-pressed="wrap" @click="wrap = !wrap">换行</TxButton>
        <TxIconButton :label="`复制${current?.label ?? '代码'}`" :title="`复制${current?.label ?? '代码'}`" size="sm" @click="copy"><Icon name="copy" /></TxIconButton>
      </span>
    </div>
    <pre class="ui-code__pre" :class="{ 'is-wrap': wrap }" tabindex="0" :aria-label="`${current?.label ?? ''} 代码`"><code><template v-for="(p, i) in parts" :key="i"><mark v-if="p.mark">{{ p.text }}</mark><template v-else>{{ p.text }}</template></template></code></pre>
  </div>
</template>

<style>
.ui-code { display: grid; gap: 8px; min-width: 0; }
.ui-code__bar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.ui-code__tools { margin-left: auto; display: inline-flex; align-items: center; gap: 4px; }
.ui-code__pre {
  position: relative; margin: 0; padding: 12px 14px; min-width: 0; overflow-x: auto; background: var(--paper-2); border-radius: var(--r-1);
  font-family: var(--font-mono); font-size: var(--fs-sm); line-height: 1.6; color: var(--ink); white-space: pre;
}
.ui-code__pre.is-wrap { white-space: pre-wrap; overflow-wrap: anywhere; }
html:root .ui-code__wrap.is-on { color: var(--ink); background: var(--paper-2); }
.ui-code__pre mark { background: var(--paper-3); color: var(--ink); box-shadow: inset 0 -1px 0 var(--ink-3); padding: 0 1px; }
</style>
