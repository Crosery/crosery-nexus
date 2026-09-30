<script setup lang="ts">
import { TxCard } from '@talex-touch/tuffex/card'
import { TxButton } from '@talex-touch/tuffex/button'
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div class="page-head__text">
        <p class="muted text-xs">ACCESS CONTROL</p>
        <h1>API Key 管理</h1>
        <p>配置用户访问密钥、额度限制、并发控制与渠道白名单权限</p>
      </div>
      <div class="page-head__actions">
        <TxButton variant="primary" icon="i-carbon-add">创建 Key</TxButton>
      </div>
    </div>
    <TxCard>
      <p class="muted">加载 API Key 列表中...</p>
    </TxCard>
  </div>
</template>
