<script setup lang="ts">
import { TxCard } from '@talex-touch/tuffex/card'
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div class="page-head__text">
        <p class="muted text-xs">ANALYTICS</p>
        <h1>请求明细</h1>
        <p>实时查看所有 API 请求日志、Token 统计、耗时分析与首字延迟</p>
      </div>
    </div>
    <TxCard>
      <p class="muted">加载请求明细中...</p>
    </TxCard>
  </div>
</template>
