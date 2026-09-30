<script setup lang="ts">
import { TxCard } from '@talex-touch/tuffex/card'
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div class="page-head__text">
        <p class="muted text-xs">USAGE</p>
        <h1>统计和使用情况</h1>
        <p>按周期、用户与模型统计消耗 Token 数量与结算花费</p>
      </div>
    </div>
    <TxCard>
      <p class="muted">加载统计数据中...</p>
    </TxCard>
  </div>
</template>
