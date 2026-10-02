<script setup lang="ts">
import { TxSwitch } from '@talex-touch/tuffex/switch'

/**
 * Switch (DESIGN.md §5.2 form/Switch): TxSwitch restyled (styles/tx/switch.css) to a 30×16 rectangular track
 * with a 12px square knob, ink when on, --dur-1. `label` is visible; `ariaLabel` names a label-less switch
 * (e.g. the 路由 column in /accounts). `loading` is shown as a disabled switch + aria-busy — TxSwitch's own
 * loading look (breathing track, conic-gradient border) is never used.
 */
withDefaults(defineProps<{ label?: string; ariaLabel?: string; disabled?: boolean; loading?: boolean }>(), {
  label: undefined,
  ariaLabel: undefined,
  disabled: false,
  loading: false,
})
const model = defineModel<boolean>({ default: false })
</script>

<template>
  <TxSwitch v-model="model" class="ui-switch" :label="label" :aria-label="ariaLabel ?? label" :disabled="disabled || loading" :aria-busy="loading || undefined" size="small" />
</template>
