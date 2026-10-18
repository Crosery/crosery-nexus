<script setup lang="ts">
import { ref } from 'vue'
import { TxButton } from '@talex-touch/tuffex/button'
import { TxDropdownItem, TxDropdownMenu } from '@talex-touch/tuffex/dropdown-menu'
import { useSkinPref, type SkinPref } from '../../lib/skin'
defineProps<{ compact?: boolean }>()

const skin = useSkinPref()
const open = ref(false)
const choices: Array<{ value: SkinPref; label: string }> = [
  { value: 'telemetry', label: 'Telemetry' },
  { value: 'minimal', label: '简约' },
]
function choose(value: SkinPref) {
  skin.set(value)
  open.value = false
}
</script>

<template>
  <TxDropdownMenu v-model="open">
    <template #trigger>
      <TxButton aria-label="选择皮肤" :title="skin.pref.value === 'minimal' ? '当前皮肤：简约' : '当前皮肤：Telemetry'" :aria-expanded="open" aria-haspopup="menu">{{ compact ? '皮肤' : `皮肤：${skin.pref.value === 'minimal' ? '简约' : 'Telemetry'}` }}</TxButton>
    </template>
    <TxDropdownItem v-for="choice in choices" :key="choice.value" :aria-current="skin.pref.value === choice.value ? 'true' : undefined" @select="choose(choice.value)">
      {{ choice.label }}
    </TxDropdownItem>
  </TxDropdownMenu>
</template>
