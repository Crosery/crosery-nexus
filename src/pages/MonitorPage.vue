<script setup lang="ts">
import { TxCard } from '@talex-touch/tuffex/card'
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div class="page-head__text">
        <p class="muted text-xs">MONITOR</p>
        <h1>账号监控</h1>
        <p>上游第三方供应商账户额度、状态窗口与限流配额监控</p>
      </div>
    </div>
    <TxCard>
      <p class="muted">加载监控信息中...</p>
    </TxCard>
  </div>
</template>
