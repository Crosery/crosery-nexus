<script setup lang="ts">
import { computed } from 'vue'
import { TxTag } from '@talex-touch/tuffex/tag'
import RowCard from '../../ui/data/RowCard.vue'
import StatusMark from '../../ui/data/StatusMark.vue'
import EmailIdentity from '../../ui/data/EmailIdentity.vue'
import CountdownPie from '../../ui/viz/CountdownPie.vue'
import QuotaCell from './QuotaCell.vue'
import EgressTag from './EgressTag.vue'
import type { EgressData } from '../../types'
import type { AccountView } from './model'
import { cpaRef, egressBadge, serviceOf } from './egressModel'
import { proxyRead } from './proxyStore'

/**
 * 390 card (DESIGN §6.5): status + plan tag · email · `5H ▮▮▮ 88% · 7D ▮▮ 64%` · the reason line for
 * cooldown / lapsed. Tapping opens the detail sheet with the 40px actions.
 */
const props = defineProps<{ row: AccountView; mode: 'used' | 'left'; now: number; washed?: boolean; egress?: EgressData | null }>()
const emit = defineEmits<{ open: []; cooled: [] }>()
const tone = computed(() => (props.row.attention ? 'attn' : props.row.state === 'cool' ? 'cool' : props.row.state === 'pause' ? 'off' : null))
const exitBadge = computed(() => {
  const read = proxyRead(props.row.name)
  return egressBadge(props.egress, cpaRef(props.row.name), serviceOf(props.row.type), read.state === 'ready' ? read.value : null)
})
const message = computed(() => {
  switch (props.row.quotaState) {
    case 'error': return '额度读取失败 · 稍后自动重试'
    case 'missing': return '额度这次没读到'
    case 'none': return '上游不报告额度窗口'
    default: return '上游没有返回额度窗口'
  }
})
</script>

<template>
  <RowCard :tone="tone" clickable class="acc-card" :class="{ 'ui-washed': washed }" @open="emit('open')">
    <template #primary>
      <CountdownPie v-if="row.state === 'cool' && row.coolUntil" :until="row.coolUntil" :total="row.coolTotal" @done="emit('cooled')" />
      <StatusMark v-else :state="row.state" :label="row.stateLabel" />
      <b v-if="row.first" class="acc-first">首选</b>
    </template>
    <template v-if="row.plan" #meta><TxTag size="sm" variant="outline" :label="row.plan" /></template>
    <template #line2><EmailIdentity :email="row.email" :struck="row.lapsed" /></template>
    <template #line3>
      <span v-if="row.a || row.b" class="acc-card__q">
        <QuotaCell v-if="row.a" :win="row.a" :mode="mode" :width="48" :now="now" />
        <QuotaCell v-if="row.b" :win="row.b" :mode="mode" :width="48" :now="now" />
      </span>
      <span v-else class="acc-card__msg">{{ row.lapsed ? '授权失效 · 额度不可读' : message }}</span>
    </template>
    <p v-if="row.leader" class="acc-card__leader" :class="{ sig: row.attention }">{{ row.leader }}</p>
    <p v-if="exitBadge" class="acc-card__eg"><EgressTag :badge="exitBadge" /></p>
  </RowCard>
</template>

<style>
.acc-card .ui-rcard__primary { font-weight: 400; }
.acc-card .ui-rcard__ln { color: var(--ink-2); }
.acc-card .ui-em { width: 100%; }
.acc-card__q { display: flex; flex-wrap: wrap; gap: 4px 16px; min-width: 0; }
.acc-card__q .acc-q__rst { display: none; }
.acc-card__msg { color: var(--ink-3); }
.acc-card__leader { margin: 0; font-size: var(--fs-xs); color: var(--ink-2); line-height: 1.4; }
.acc-card__leader.sig { color: var(--signal-ink); }
.acc-card__eg { margin: 0; display: flex; min-width: 0; }
</style>
