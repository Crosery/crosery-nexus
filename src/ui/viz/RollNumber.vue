<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useTemplateRef, watch } from 'vue'
import { isReducedMotion } from '../../lib/motion'

/**
 * Odometer (DESIGN.md §3.2 #3–4, motion.css recipe 4). Every digit is a 0–9 column translated −d em:
 * first paint rolls from 0, live updates roll only the digits that changed (right-to-left, 34ms stagger,
 * 760ms settle); a change in string length rebuilds with a 160ms crossfade instead. Tabular numerals keep
 * the width fixed (CLS 0). Screen readers get the value once as visually-hidden text (aria-label is not
 * allowed on a generic span); the digit columns are aria-hidden.
 * `live` adds the neutral --wash cue on change (never orange).
 */
const props = withDefaults(
  defineProps<{
    value: string | number | null | undefined
    format?: (value: string | number) => string
    live?: boolean
    /** start from 0 on mount (default); false renders the value straight away */
    rollIn?: boolean
  }>(),
  { format: undefined, live: false, rollIn: true },
)

const text = computed(() => {
  if (props.value === null || props.value === undefined || props.value === '') return '—'
  return props.format ? props.format(props.value) : String(props.value)
})
const chars = computed(() => [...text.value])
const zero = ref(props.rollIn && !isReducedMotion())
const gen = ref(0)
const fading = ref(false)
const root = useTemplateRef<HTMLElement>('root')
let raf = 0
let fadeTimer: ReturnType<typeof setTimeout> | null = null

onMounted(() => {
  if (zero.value) raf = requestAnimationFrame(() => (raf = requestAnimationFrame(() => (zero.value = false))))
})
onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
  if (fadeTimer) clearTimeout(fadeTimer)
})

watch(text, (next, prev) => {
  if (next.length !== prev.length) {
    gen.value += 1
    fading.value = true
    if (fadeTimer) clearTimeout(fadeTimer)
    fadeTimer = setTimeout(() => (fading.value = false), 180)
  }
  if (props.live && next !== prev && root.value && !isReducedMotion()) {
    const el = root.value
    el.classList.remove('ui-washed')
    void nextTick(() => {
      void el.offsetWidth
      el.classList.add('ui-washed')
    })
  }
})

const isDigit = (c: string) => c >= '0' && c <= '9'
</script>

<template>
  <span ref="root" class="ui-roll" :class="{ 'is-fading': fading }">
    <span class="sr-only">{{ text }}</span>
    <template v-for="(c, i) in chars" :key="`${gen}:${chars.length - 1 - i}`">
      <span v-if="isDigit(c)" class="rd" aria-hidden="true">
        <span :style="{ '--k': chars.length - 1 - i, transform: `translateY(${zero ? 0 : -Number(c)}em)` }">
          <span>0</span><span>1</span><span>2</span><span>3</span><span>4</span><span>5</span><span>6</span><span>7</span><span>8</span><span>9</span>
        </span>
      </span>
      <span v-else class="rc" aria-hidden="true">{{ c }}</span>
    </template>
  </span>
</template>
