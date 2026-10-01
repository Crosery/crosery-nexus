<script setup lang="ts">
import { RouterView } from 'vue-router'
import { TxToastHost } from '@talex-touch/tuffex/toast'
import ConfirmHost from './components/ConfirmHost.vue'
</script>

<template>
  <RouterView />
  <TxToastHost position="bottom-right" />
  <!-- 全站唯一的确认框：页面用 `await confirm({...})` 触发，见 src/lib/confirm.ts -->
  <ConfirmHost />
</template>
