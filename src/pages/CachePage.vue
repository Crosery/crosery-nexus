<script setup lang="ts">
import { TxCard } from '@talex-touch/tuffex/card'
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div class="page-head__text">
        <p class="muted text-xs">PROMPT CACHE</p>
        <h1>缓存命中率</h1>
        <p>监控上下文提示词缓存命中比例、节省成本与写入上限追踪</p>
      </div>
    </div>
    <TxCard>
      <p class="muted">加载缓存分析中...</p>
    </TxCard>
  </div>
</template>
