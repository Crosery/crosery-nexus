<script setup lang="ts">
import { computed } from 'vue'
import { maskEmail, useMask } from '../../lib/privacy'

/**
 * Two-line account identity (DESIGN.md §6.5): local part in ink, domain receding in ink-3; when space runs out
 * the domain truncates first and the local part last. Line 2 (plan · 首选 · 参与路由) is 11px ink-3.
 * Under the privacy mask it renders `zh••••••s@•••` and drops the full-address tooltip.
 */
const props = withDefaults(defineProps<{ email: string; line2?: string; struck?: boolean; mono?: boolean }>(), {
  line2: undefined,
  struck: false,
  mono: true,
})

const { on: masked } = useMask()
const at = computed(() => props.email.lastIndexOf('@'))
const local = computed(() => (at.value > 0 ? props.email.slice(0, at.value) : props.email))
const domain = computed(() => (at.value > 0 ? props.email.slice(at.value) : ''))
const hidden = computed(() => maskEmail(props.email))
</script>

<template>
  <span class="ui-em" :class="{ 'is-struck': struck, 'is-sans': !mono }">
    <span class="ui-em__l1" :title="masked ? undefined : email">
      <span class="pii-t ui-em__local">{{ local }}</span><span class="pii-t ui-em__domain">{{ domain }}</span>
      <span class="pii-m ui-em__masked">{{ hidden }}</span>
    </span>
    <span v-if="line2 || $slots.line2" class="ui-em__l2"><slot name="line2">{{ line2 }}</slot></span>
  </span>
</template>

<style>
.ui-em { display: inline-flex; flex-direction: column; min-width: 0; max-width: 100%; vertical-align: middle; }
.ui-em__l1 { display: flex; min-width: 0; max-width: 100%; white-space: nowrap; font-family: var(--font-mono); font-size: 12.5px; }
.ui-em.is-sans .ui-em__l1 { font-family: var(--font-sans); font-size: var(--fs-row); }
.ui-em__local { flex: 0 1 auto; min-width: 3ch; overflow: hidden; text-overflow: ellipsis; color: var(--ink); }
.ui-em__domain { flex: 0 1000 auto; min-width: 1ch; overflow: hidden; text-overflow: ellipsis; color: var(--ink-3); }
.ui-em__masked { color: var(--ink); }
.ui-em.is-struck .ui-em__local { text-decoration: line-through; text-decoration-color: var(--signal); }
.ui-em__l2 { font-size: var(--fs-xs); color: var(--ink-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
</style>
