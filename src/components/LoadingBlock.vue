<script setup lang="ts">
import { TxCard } from '@talex-touch/tuffex/card'
import { TxSkeleton } from '@talex-touch/tuffex/skeleton'

/**
 * 加载占位：卡片里几行骨架，行数按页面实际内容给。
 *
 * 对照参考实现 `geek_main/app/console/src/components/LoadingBlock.vue:1-20`。
 * 只在「首次加载、还没有任何数据」时渲染（见 `useResource` 的 `initial`），
 * 刷新时保留旧数据，列表不会闪成空白。
 */
withDefaults(defineProps<{ lines?: number; label?: string }>(), { lines: 5, label: '正在加载' })
</script>

<template>
  <TxCard class="loading-block" role="status" aria-live="polite" :aria-label="label">
    <TxSkeleton :loading="true" :lines="1" :width="180" :height="16" />
    <TxSkeleton class="loading-block__rows" :loading="true" :lines="lines" :height="14" :gap="14" />
  </TxCard>
</template>

<style scoped>
.loading-block {
  width: 100%;
}
.loading-block__rows {
  margin-top: 18px;
}
</style>
