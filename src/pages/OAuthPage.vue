<script setup lang="ts">
import { TxCard } from '@talex-touch/tuffex/card'
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div class="page-head__text">
        <p class="muted text-xs">AUTHENTICATION</p>
        <h1>OAuth 授权登录</h1>
        <p>通过官方 OAuth 流程或设备码将上游提供商账号连接至中转站</p>
      </div>
    </div>
    <TxCard>
      <p class="muted">加载登录提供商列表中...</p>
    </TxCard>
  </div>
</template>
