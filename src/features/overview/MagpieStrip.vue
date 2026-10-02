<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import Tip from '../../ui/form/Tip.vue'
import type { MagpieGatewayInfo } from '../../types'

/**
 * 概览 · 网关 head: `Magpie 3fe2ff9 · 已是最新`, or `… · 落后 ≥66 · 待评审 →` — one quiet line that links to
 * 设置 › 网关 Magpie. Same model and words as the settings section and the statusline (`cpa.gateway`).
 */
const props = defineProps<{ info: MagpieGatewayInfo }>()

const tail = computed(() => {
  const g = props.info
  if (!g.current.running) return { text: '离线', review: false, hot: true }
  if (g.gap.state === 'latest') return { text: '已是最新', review: false, hot: false }
  if (g.gap.state === 'behind') return { text: g.gap.commitsAtLeast ? `落后 ≥${g.gap.commitsAtLeast}` : '落后', review: g.review.pending, hot: false }
  return { text: '差距未知', review: false, hot: false }
})
</script>

<template>
  <!-- the gap note (how the commit gap is sampled) is a calm tooltip, not a native title; screen readers get it inline -->
  <Tip :content="info.gap.note ?? ''" :disabled="!info.gap.note">
    <RouterLink to="/settings#magpie" class="ov-mag">
      <span class="ov-mag__name">Magpie</span>
      <b class="num">{{ info.current.label }}</b>
      <span class="ov-mag__tail" :class="{ 'is-hot': tail.hot }">· {{ tail.hot ? '◆ ' : '' }}{{ tail.text }}<span v-if="tail.review" class="ov-mag__review"> · 待评审</span></span>
      <span v-if="info.gap.note" class="sr-only">（{{ info.gap.note }}）</span>
      <span class="ov-mag__go" aria-hidden="true">→</span>
    </RouterLink>
  </Tip>
</template>

<style>
.ov-mag { display: inline-flex; align-items: baseline; gap: 5px; min-width: 0; color: var(--ink-3); text-decoration: none; white-space: nowrap; font-size: var(--fs-xs); }
.ov-mag b { font-weight: 500; color: var(--ink-2); }
.ov-mag__tail { overflow: hidden; text-overflow: ellipsis; }
.ov-mag__tail.is-hot { color: var(--signal-ink); }
.ov-mag:hover { color: var(--ink-2); }
.ov-mag:hover b { color: var(--ink); }
/* the gateway head also carries the range switch: below 1180 the strip keeps version and gap only */
@media (max-width: 1179px) { .ov-mag__review { display: none; } }
</style>
