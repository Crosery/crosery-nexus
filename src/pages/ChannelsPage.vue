<script setup lang="ts">
import { TxCard } from '@talex-touch/tuffex/card'
import { TxButton } from '@talex-touch/tuffex/button'
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div class="page-head__text">
        <p class="muted text-xs">CHANNELS</p>
        <h1>渠道账号</h1>
        <p>管理上游模型供应商渠道、多账号池状态、出口代理与模型映射</p>
      </div>
      <div class="page-head__actions">
        <TxButton variant="primary" icon="i-carbon-add">添加渠道</TxButton>
      </div>
    </div>
    <TxCard>
      <p class="muted">加载渠道列表中...</p>
    </TxCard>
  </div>
</template>
