<script setup lang="ts">
import { computed } from 'vue'
import ShareBar from './ShareBar.vue'
import type { ShareSegment } from '../types'

/**
 * Token composition (DESIGN.md §6.7 02): 新输入 k1 · 输出 k4 · 缓存读 k5 · 缓存写 k3 (solid tonal steps).
 * Kept on ShareBar rather than TxAllocationBar: that one is an interactive radiogroup with a %-only legend. Reasoning tokens are part of output and are shown separately by the page, never added here.
 */
const props = withDefaults(
  defineProps<{
    input: number | null | undefined
    output: number | null | undefined
    cacheRead?: number | null
    cacheWrite?: number | null
    legend?: boolean
    height?: number
  }>(),
  { cacheRead: null, cacheWrite: null, legend: true, height: 12 },
)

const segments = computed<ShareSegment[]>(() => [
  { key: 'input', label: '新输入', value: props.input ?? 0, tone: 'k1' },
  { key: 'output', label: '输出', value: props.output ?? 0, tone: 'k4' },
  { key: 'cacheRead', label: '缓存读', value: props.cacheRead ?? 0, tone: 'k5' },
  { key: 'cacheWrite', label: '缓存写', value: props.cacheWrite ?? 0, tone: 'k3' },
])
</script>

<template>
  <ShareBar :segments="segments" :legend="legend" :height="height" label="Token 构成" />
</template>
