<script setup lang="ts">
import { computed } from 'vue'
import StatusMark from '../data/StatusMark.vue'
import { useNow } from '../composables/useNow'
import { fmtAgo, fmtClock } from '../fmt'
import type { DataState, Instant } from '../types'

/**
 * Page live mark (DESIGN.md §4.1 page head): `● 实时 · 每 15s · 上次 14:32:08`. Stale or failing refresh →
 * `◇ 陈旧 · 3m 前 · 重试` (dashed ring, ink-3, retry is a text button). Pass useLive()'s state / lastAt.
 */
const props = withDefaults(
  defineProps<{
    state: DataState
    lastAt?: Instant
    intervalMs?: number
    /** e.g. "实时 · 不受时间筛选" */
    label?: string
  }>(),
  { lastAt: null, intervalMs: 15_000, label: '实时' },
)
const emit = defineEmits<{ retry: [] }>()
const now = useNow()
const every = computed(() => `每 ${Math.round(props.intervalMs / 1000)}s`)
const stale = computed(() => props.state === 'stale' || props.state === 'error')
</script>

<template>
  <span class="ui-livemark" :class="{ 'is-stale': stale }">
    <template v-if="stale">
      <StatusMark state="stale" label="陈旧" />
      <span v-if="lastAt" class="num">· {{ fmtAgo(lastAt, now) }}</span>
      <button type="button" class="ui-link" @click="emit('retry')">重试</button>
    </template>
    <template v-else>
      <StatusMark state="run" :label="label" :live="state === 'ready'" />
      <span class="num">· {{ every }}<template v-if="lastAt"> · 上次 {{ fmtClock(lastAt, now) }}</template></span>
    </template>
  </span>
</template>

<style>
.ui-livemark { display: inline-flex; align-items: center; gap: 6px; font-size: var(--fs-xs); color: var(--ink-3); white-space: nowrap; }
.ui-livemark .ui-st { font-size: var(--fs-xs); }
.ui-livemark .num { font-family: var(--font-mono); }
</style>
