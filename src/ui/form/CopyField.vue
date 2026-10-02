<script setup lang="ts">
import { TxIconButton } from '@talex-touch/tuffex/button'
import Icon from '../Icon.vue'
import { copyText } from '../feedback/toast'

/**
 * Copy field (DESIGN.md §5.2 form/CopyField): small label, the value in mono on one paper-2 fill (wraps, never scrolls), a 32px
 * (40px touch) copy button with aria-label + title; toast `已复制 ‹label›`. `copyValue` lets the button copy
 * something else than what is shown (e.g. `export CROSERY_API_KEY=''`).
 */
const props = withDefaults(
  defineProps<{
    label: string
    value: string
    copyValue?: string
    mono?: boolean
    /** caption under the value (ink-3) */
    hint?: string
  }>(),
  { copyValue: undefined, mono: true, hint: undefined },
)

function copy() {
  void copyText(props.copyValue ?? props.value, props.label)
}
</script>

<template>
  <div class="ui-copy">
    <span class="ui-copy__k">{{ label }}</span>
    <div class="ui-copy__row">
      <code class="ui-copy__v" :class="{ 'is-sans': !mono }">{{ value }}</code>
      <TxIconButton :label="`复制${label}`" :title="`复制${label}`" size="sm" @click="copy"><Icon name="copy" /></TxIconButton>
    </div>
    <p v-if="hint" class="ui-copy__hint">{{ hint }}</p>
  </div>
</template>

<style>
.ui-copy { display: grid; gap: 4px; min-width: 0; }
.ui-copy__k { font-size: var(--fs-xs); color: var(--ink-3); }
.ui-copy__row { display: flex; align-items: center; gap: 6px; min-height: var(--btn-h); padding-left: 10px; border-radius: var(--r-1); background: var(--paper-2); min-width: 0; }
.ui-copy__v { flex: 1; min-width: 0; padding: 6px 0; background: none; font-family: var(--font-mono); font-size: var(--fs-sm); color: var(--ink); overflow-wrap: anywhere; white-space: pre-wrap; }
.ui-copy__v.is-sans { font-family: var(--font-sans); }
.ui-copy__hint { margin: 0; font-size: var(--fs-xs); color: var(--ink-3); }
</style>
