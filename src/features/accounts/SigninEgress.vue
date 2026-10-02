<script setup lang="ts">
import { computed } from 'vue'
import FilterField from '../../ui/form/FilterField.vue'
import type { EgressData, EgressService } from '../../types'
import { egressOptions, signinVia } from './egressModel'

/**
 * 登录出口 in a sign-in sheet. No backend can send one sign-in through an exit chosen for it (CPA signs in through
 * its global proxy, the Magpie kernel directly), so the sign-in's own route is stated, not offered. The account
 * that comes out of it can take an exit straight away: 账号出口 is picked here and written when the sign-in
 * completes — only where accounts can hold an exit of their own and the pool has one to give.
 */
const props = withDefaults(defineProps<{ egress: EgressData | null; service: EgressService | null; agent?: string | null }>(), { agent: null })
const choice = defineModel<string>({ default: '' })

const via = computed(() => signinVia(props.egress))
const canPick = computed(() => Boolean(props.egress?.accountProxy.supported && props.egress.entries.some((entry) => entry.assignable)))
// 继承 means CPA's global proxy, or (Magpie) the service's own proxy: the inherit label reads the service from the ref
const options = computed(() => egressOptions(props.egress, props.egress?.backend === 'magpie' ? `magpie:${props.agent ?? ''}:` : 'cpa:', props.service))
</script>

<template>
  <div v-if="egress" class="se">
    <p class="se__row">
      <span class="se__k">登录出口</span>
      <span class="se__v">{{ via.label }}</span>
      <span class="se__note">{{ via.note }}</span>
    </p>
    <div v-if="canPick" class="se__row se__row--pick">
      <FilterField v-model="choice" class="se__pick" label="账号出口" :all-label="null" :options="options" />
      <span class="se__note">登录完成后这个账号改走所选出口</span>
    </div>
  </div>
</template>

<style>
.se { display: grid; gap: 8px; padding: 10px 0 2px; border-top: 1px solid var(--rule); min-width: 0; }
.se__row { margin: 0; display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 10px; min-width: 0; font-size: var(--fs-xs); }
.se__row--pick { align-items: center; }
.se__k { flex: none; color: var(--ink-3); min-width: 4.5em; }
.se__v { color: var(--ink); }
.se__note { flex: 1 1 100%; color: var(--ink-3); line-height: 1.55; }
.se__pick .ui-ff__k { font-size: var(--fs-xs); min-width: 4.5em; }
html:root .se__pick .tuff-select { max-width: 320px; }
@media (min-width: 600px) { .se__note { flex-basis: auto; } }
</style>
