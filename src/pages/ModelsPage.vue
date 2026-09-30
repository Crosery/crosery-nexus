<script setup lang="ts">
import { TxCard } from '@talex-touch/tuffex/card'
import { TxButton } from '@talex-touch/tuffex/button'
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div class="page-head__text">
        <p class="muted text-xs">MODELS</p>
        <h1>模型总览</h1>
        <p>查看实时渠道状态、每百万 token 单价，以及输入、输出、缓存的实际用量与花费</p>
      </div>
      <div class="page-head__actions">
        <TxButton variant="secondary" icon="i-carbon-renew">同步最新模型</TxButton>
      </div>
    </div>
    <TxCard>
      <p class="muted">加载模型列表中...</p>
    </TxCard>
  </div>
</template>
