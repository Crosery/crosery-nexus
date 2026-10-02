<script setup lang="ts">
import { computed } from 'vue'
import { ICON_PATHS, type IconName } from './icons'

const props = withDefaults(defineProps<{ name: IconName; size?: number; label?: string }>(), { size: 16, label: undefined })
// paths are static strings from icons.ts (never user input), so v-html is safe here
const markup = computed(() => ICON_PATHS[props.name] ?? '')
</script>

<template>
  <svg
    class="ui-ico"
    :width="size"
    :height="size"
    viewBox="0 0 16 16"
    :role="label ? 'img' : undefined"
    :aria-label="label"
    :aria-hidden="label ? undefined : 'true'"
    v-html="markup"
  />
</template>

<style>
.ui-ico { flex: none; stroke: currentColor; fill: none; stroke-width: 1.4; stroke-linecap: round; stroke-linejoin: round; }
</style>
