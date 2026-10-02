<script setup lang="ts">
import { defineAsyncComponent, ref, watch } from 'vue'
import type { CommandItem } from '../types'

/**
 * ⌘K palette host (DESIGN.md §4.4). Loads the TxCommandPalette body on first open so the entry chunk carries
 * none of its JS/CSS. `commands` are CommandItem (section GO / ACT / FIND / VIEW, run(), disabled with a
 * hint such as `冷却 04:12`). AppShell binds mod+k; pages add their own commands through AppShell's prop.
 */
withDefaults(defineProps<{ commands: CommandItem[]; placeholder?: string }>(), { placeholder: '跳转或执行…' })
const open = defineModel<boolean>({ default: false })
const PaletteBody = defineAsyncComponent(() => import('./PaletteBody.vue'))
const used = ref(open.value)
watch(open, (value) => {
  if (value) used.value = true
})
</script>

<template>
  <PaletteBody v-if="used" v-model="open" :commands="commands" :placeholder="placeholder" />
</template>
