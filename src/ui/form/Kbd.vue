<script setup lang="ts">
import { computed } from 'vue'
import { TxKbd } from '@talex-touch/tuffex/kbd'

/**
 * Key cap (DESIGN.md §4.4) on TxKbd (flat: styles/tx/kbd.css): `mod+k` renders ⌘K on Apple platforms and
 * Ctrl K elsewhere; the spoken name is in an sr-only span.
 */
const props = withDefaults(defineProps<{ keys: string; size?: 'sm' | 'md' }>(), { size: 'sm' })

const isMac = typeof navigator !== 'undefined' && /Mac|iP(hone|ad|od)/.test(navigator.platform || navigator.userAgent)
const NAMES: Record<string, string> = { mod: isMac ? '⌘' : 'Ctrl', shift: '⇧', alt: isMac ? '⌥' : 'Alt', enter: '↵', esc: 'Esc', escape: 'Esc', up: '↑', down: '↓', left: '←', right: '→', tab: 'Tab' }
const caps = computed(() => props.keys.split('+').map((k) => NAMES[k.toLowerCase()] ?? (k.length === 1 ? k.toUpperCase() : k)))
const spoken = computed(() => props.keys.replace(/mod/i, isMac ? 'Command' : 'Control'))
</script>

<template>
  <TxKbd class="ui-kbd" :size="size"><span class="sr-only">{{ spoken }}</span><span v-for="(c, i) in caps" :key="i" aria-hidden="true">{{ c }}</span></TxKbd>
</template>
