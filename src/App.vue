<script setup lang="ts">
import { RouterView } from 'vue-router'
import { TxToastHost } from '@talex-touch/tuffex/toast'
</script>

<template>
  <RouterView />
  <TxToastHost position="bottom-right" />
</template>
