<script setup lang="ts">
import { computed } from 'vue'
import { TxIconButton } from '@talex-touch/tuffex/button'
import Icon from '../Icon.vue'
import { useThemePref } from '../../lib/theme'

/**
 * Theme toggle (DESIGN.md §3.2 #12): flips light ↔ dark with a circular View-Transition wipe that starts at
 * this button (instant under reduced motion; scanline once without View Transitions). `T` is bound by AppShell.
 */
const { theme, toggle } = useThemePref()
const label = computed(() => (theme.value === 'dark' ? '切换到浅色主题' : '切换到深色主题'))
</script>

<template>
  <TxIconButton :label="label" size="sm" :title="`${label} (T)`" @click="toggle($event)">
    <Icon :name="theme === 'dark' ? 'sun' : 'moon'" />
  </TxIconButton>
</template>
