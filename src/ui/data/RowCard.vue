<script setup lang="ts">
import type { RowTone } from '../types'
import './rowcard.css'

/**
 * Row card (DESIGN.md §5.2 data/RowCard): the mobile stand-in for a table row, ≥56px. Line 1 = primary
 * (ellipsis) + meta (mono, right); then up to two ink-3 lines; actions sit at the end of line 2.
 * `clickable` makes the whole card a button (Enter / Space) that emits `open` — e.g. the detail sheet.
 * Use inside `<ul class="ui-rcards">`.
 */
withDefaults(
  defineProps<{
    primary?: string
    meta?: string
    lines?: string[]
    tone?: RowTone
    clickable?: boolean
  }>(),
  { primary: undefined, meta: undefined, lines: () => [], tone: undefined, clickable: false },
)
const emit = defineEmits<{ open: [] }>()

function onKey(event: KeyboardEvent) {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    emit('open')
  }
}
</script>

<template>
  <li
    class="ui-rcard"
    :class="[tone ? `is-${tone}` : '', { 'is-clickable': clickable }]"
    data-row
    :tabindex="clickable ? 0 : undefined"
    :role="clickable ? 'button' : undefined"
    @click="clickable && emit('open')"
    @keydown="clickable && onKey($event)"
  >
    <div class="ui-rcard__l1">
      <span class="ui-rcard__primary"><slot name="primary">{{ primary }}</slot></span>
      <span v-if="meta || $slots.meta" class="ui-rcard__meta"><slot name="meta">{{ meta }}</slot></span>
    </div>
    <div v-if="lines[0] || $slots.line2 || $slots.actions" class="ui-rcard__ln">
      <span class="ui-rcard__seg"><slot name="line2">{{ lines[0] }}</slot></span>
      <span v-if="$slots.actions" class="ui-rcard__act" @click.stop><slot name="actions" /></span>
    </div>
    <div v-if="lines[1] || $slots.line3" class="ui-rcard__ln">
      <span class="ui-rcard__seg"><slot name="line3">{{ lines[1] }}</slot></span>
    </div>
    <slot />
  </li>
</template>
