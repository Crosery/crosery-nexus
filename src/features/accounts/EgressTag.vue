<script setup lang="ts">
import type { EgressBadge } from './egressModel'

/**
 * An account's exit in one quiet run of text: `出口 日本 · 东京-01 ✓ 230ms` (region, then name; never an address).
 * The mark is a glyph plus a word, never colour alone; the failing case takes the signal colour. Nothing renders
 * while the exit is not known.
 */
withDefaults(defineProps<{ badge: EgressBadge | null; bare?: boolean }>(), { bare: false })
</script>

<template>
  <span v-if="badge" class="eg" :class="[`is-${badge.kind}`, { 'is-bad': badge.mark.ok === false }]" :title="badge.title">
    <span v-if="!bare" class="eg__k">出口</span>
    <span class="eg__n">{{ badge.label }}</span>
    <span v-if="badge.mark.text" class="eg__m num">{{ badge.mark.text }}</span>
  </span>
</template>

<style>
.eg { display: inline-flex; align-items: baseline; gap: 5px; min-width: 0; max-width: 100%; font-size: var(--fs-xs); color: var(--ink-2); white-space: nowrap; }
.eg__k { color: var(--ink-3); flex: none; }
.eg__n { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.eg.is-direct .eg__n, .eg.is-inherit .eg__n { color: var(--ink-3); }
.eg__m { flex: none; color: var(--ink-3); }
.eg.is-entry .eg__m, .eg.is-inherit .eg__m { color: var(--ink-2); }
.eg.is-bad .eg__m, .eg.is-invalid .eg__n { color: var(--signal-ink); }
</style>
