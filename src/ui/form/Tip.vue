<script setup lang="ts">
import { TxTooltip } from '@talex-touch/tuffex/tooltip'
import { CALM_TIP } from './anchor'

/**
 * Tooltip: TxTooltip on the calm panel (solid sheet, one hairline, no arrow, opacity fade). For icon-only
 * buttons and statusline segments; the trigger must still carry its own aria-label — a tooltip is never the
 * only name. Truncated table cells use the native `title` instead (one BaseAnchor per cell is too heavy).
 */
withDefaults(defineProps<{ content?: string; disabled?: boolean; openDelay?: number }>(), { content: '', disabled: false, openDelay: 300 })
</script>

<template>
  <TxTooltip :content="content" :disabled="disabled" :open-delay="openDelay" trigger="hover" :anchor="CALM_TIP">
    <slot />
    <template v-if="$slots.content" #content><slot name="content" /></template>
  </TxTooltip>
</template>

<style>
html:root .tx-tooltip { font-size: var(--fs-xs); line-height: 1.45; color: var(--ink-2); }
</style>
