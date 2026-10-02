<script setup lang="ts">
import { RouterLink } from 'vue-router'

/**
 * Reticle mark (ring, crosshair, orange core) + mono wordmark `CROSERY / console` (DESIGN.md §4.1).
 * The wordmark hides below 1180px (`compact` forces mark-only).
 */
withDefaults(defineProps<{ sub?: string; to?: string; compact?: boolean }>(), { sub: 'console', to: '/', compact: false })
</script>

<template>
  <RouterLink :to="to" class="ui-brand" :class="{ 'is-compact': compact }" :aria-label="`CROSERY ${sub} 首页`">
    <svg class="ui-brand__mark" viewBox="0 0 22 22" width="22" height="22" aria-hidden="true">
      <circle cx="11" cy="11" r="8.5" fill="none" stroke="currentColor" stroke-width="1.5" />
      <path d="M11 0.5v5M11 16.5v5M0.5 11h5M16.5 11h5" stroke="currentColor" stroke-width="1.5" />
      <circle cx="11" cy="11" r="2.6" class="ui-brand__core" />
    </svg>
    <span class="ui-brand__word" aria-hidden="true"><b>CROSERY</b> / {{ sub }}</span>
  </RouterLink>
</template>

<style>
.ui-brand { display: inline-flex; align-items: center; gap: 10px; color: var(--ink); text-decoration: none; flex: none; min-height: 32px; }
.ui-brand__core { fill: var(--signal); }
.ui-brand__word { font-family: var(--font-mono); font-size: 12px; letter-spacing: .06em; color: var(--ink-2); white-space: nowrap; }
.ui-brand__word b { font-weight: 700; color: var(--ink); }
.ui-brand.is-compact .ui-brand__word { display: none; }
@media (max-width: 1179px) { .ui-brand__word { display: none; } }
</style>
