<script setup lang="ts">
import { TxIconButton } from '@talex-touch/tuffex/button'
import Icon from '../Icon.vue'
import { useMask } from '../../lib/privacy'

/**
 * Privacy mask toggle (admin only, DESIGN.md §4.1): html[data-mask="on"] swaps every <Pii>/EmailIdentity to
 * its masked twin (zh•••••g@•••). Persisted per device. `M` is bound by AppShell.
 */
const { on, toggle } = useMask()
</script>

<template>
  <TxIconButton label="隐私脱敏" size="sm" :pressed="on" :title="on ? '隐私脱敏：开 (M)' : '隐私脱敏：关 (M)'" @click="toggle()">
    <Icon :name="on ? 'eye-off' : 'eye'" />
  </TxIconButton>
</template>
