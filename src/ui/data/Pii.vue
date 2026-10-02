<script setup lang="ts">
import { computed } from 'vue'
import { maskPii, type PiiKind } from '../../lib/privacy'

/**
 * Personal text (email, person or account name) that the privacy mask hides: renders the original and the
 * masked twin; html[data-mask="on"] swaps which one is displayed (src/styles/base.css), so screen readers and
 * copy/paste get exactly what is visible.
 */
const props = withDefaults(defineProps<{ value: string | null | undefined; kind?: PiiKind }>(), { kind: 'auto' })
const text = computed(() => props.value ?? '')
const masked = computed(() => maskPii(text.value, props.kind))
</script>

<template>
  <span class="pii"><span class="pii-t">{{ text }}</span><span class="pii-m">{{ masked }}</span></span>
</template>
