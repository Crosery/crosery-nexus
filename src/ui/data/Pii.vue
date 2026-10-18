<script setup lang="ts">
import { computed } from 'vue'
import { maskPii, type PiiKind, useMask } from '../../lib/privacy'
import { useSkinPref } from '../../lib/skin'
/**
 * Personal text (email, person or account name) that the privacy mask hides: renders the original and the
 * masked twin; html[data-mask="on"] swaps which one is displayed (src/styles/base.css), so screen readers and
 * copy/paste get exactly what is visible.
 */
const props = withDefaults(defineProps<{ value: string | null | undefined; kind?: PiiKind }>(), { kind: 'auto' })
const text = computed(() => props.value ?? '')
const masked = computed(() => maskPii(text.value, props.kind))
const { on: maskedOn } = useMask()
const { pref: skin } = useSkinPref()
const minimal = computed(() => skin.value === 'minimal')
</script>

<template>
  <span v-if="minimal">{{ maskedOn ? masked : text }}</span>
  <span v-else class="pii"><span class="pii-t">{{ text }}</span><span class="pii-m">{{ masked }}</span></span>
</template>
