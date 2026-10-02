<script setup lang="ts">
/**
 * Masked API key (DESIGN.md §5.2 form/MaskedKey, §6.10): only ever the stored tail (`sk-cr…7f3a`) as plain
 * mono text with `完整 Key 只在你自己的设备上`. There is deliberately NO reveal and NO copy — nothing here
 * could be revealed. Admins use the one-time reveal flow on /keys instead.
 */
withDefaults(defineProps<{ tail: string; label?: string; hint?: string | null }>(), { label: 'API KEY', hint: '完整 Key 只在你自己的设备上' })
</script>

<template>
  <div class="ui-mkey">
    <span class="ui-mkey__k">{{ label }}</span>
    <span class="ui-mkey__v">{{ tail }}</span>
    <span v-if="hint" class="ui-mkey__hint">{{ hint }}</span>
  </div>
</template>

<style>
.ui-mkey { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px; min-width: 0; }
.ui-mkey__k { font-family: var(--font-mono); font-size: var(--fs-micro); letter-spacing: .09em; color: var(--ink-3); }
.ui-mkey__v { font-family: var(--font-mono); font-size: var(--fs-sm); color: var(--ink); }
.ui-mkey__hint { font-size: var(--fs-xs); color: var(--ink-3); }
</style>
