<script setup lang="ts">
import { useTemplateRef } from 'vue'
import { useRouteScan } from '../composables/useRouteScan'

/** Route scanline (motion recipe 1): one 1px signal line with a wash trail on every path change. */
const el = useTemplateRef<HTMLElement>('el')
useRouteScan(el)
</script>

<template>
  <div ref="el" class="ui-scan" aria-hidden="true" />
</template>
