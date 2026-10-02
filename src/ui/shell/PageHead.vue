<script setup lang="ts">
/**
 * Page head (DESIGN.md §4.1, ≈60px): h1 20/650 then ONE status line (`20 账号 · 运行 15 · 冷却 2 · 失效 1`) —
 * never a description paragraph. Right side: the page's live mark and its primary action (slot `actions`).
 * Slot `status` replaces the status string when parts of it need marks (e.g. only 失效 in signal-ink).
 * `idx` / `group` / `en` (the old `05 / 接入 · MODELS` micro) are accepted for compatibility but not rendered.
 */
withDefaults(
  defineProps<{
    title: string
    idx?: string
    group?: string
    en?: string
    status?: string
    /** key-user pages: no index / EN micro */
    plain?: boolean
  }>(),
  { idx: undefined, group: undefined, en: undefined, status: undefined, plain: false },
)
</script>

<template>
  <header class="ui-phead">
    <div class="ui-phead__l">
      <h1 class="ui-phead__t">{{ title }}</h1>
      <span v-if="status || $slots.status" class="ui-phead__st"><slot name="status">{{ status }}</slot></span>
    </div>
    <div v-if="$slots.live || $slots.actions" class="ui-phead__r">
      <slot name="live" />
      <slot name="actions" />
    </div>
  </header>
</template>

<style>
.ui-phead { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 16px; min-height: 60px; padding: 10px 0 12px; }
.ui-phead__l { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 14px; min-width: 0; }
.ui-phead__t { margin: 0; font-size: var(--fs-lg); font-weight: 650; letter-spacing: -.005em; color: var(--ink); }
.ui-phead__st { font-size: var(--fs-sm); color: var(--ink-2); min-width: 0; }
.ui-phead__r { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px; margin-left: auto; }
@media (max-width: 959px) {
  .ui-phead { min-height: 0; padding: 8px 0 10px; }
}
</style>
