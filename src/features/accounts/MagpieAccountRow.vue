<script setup lang="ts">
import { computed } from 'vue'
import { TxTag } from '@talex-touch/tuffex/tag'
import StatusMark from '../../ui/data/StatusMark.vue'
import Pii from '../../ui/data/Pii.vue'
import TickMeter from '../../ui/viz/TickMeter.vue'
import { fmtTime } from '../../ui/fmt'
import { maskPii, useMask } from '../../lib/privacy'
import type { EgressData, MagpieAccount } from '../../types'
import MagpieRowMenu from './MagpieRowMenu.vue'
import EgressTag from './EgressTag.vue'
import { quotaLine, rowMenu, rowStatus, type RowAction } from './magpieModel'
import { egressBadge, magpieRef, serviceOf } from './egressModel'

/**
 * One Magpie account, one ~40px line (two lines in a narrow list): status dot + word · the account (privacy
 * mask) and its plan · at most two allowance windows · ⋯. A lapsed account shows 登录已失效 and 重新登录
 * instead of the bars.
 */
const props = withDefaults(defineProps<{ account: MagpieAccount; now: number; busy?: string; washed?: boolean; egress?: EgressData | null }>(), {
  busy: undefined,
  washed: false,
  egress: null,
})
const emit = defineEmits<{ action: [action: RowAction] }>()
const { on: masked } = useMask()

const status = computed(() => rowStatus(props.account))
const line = computed(() => quotaLine(props.account, props.now))
const menu = computed(() => rowMenu(props.account, props.egress?.accountProxy ?? null))
/** where this account goes out and whether that reaches its vendor (a Claude account shows the Claude check) */
const exitBadge = computed(() => egressBadge(props.egress, magpieRef(props.account.agent, props.account.user), serviceOf(props.account.agent)))
const who = computed(() => (masked.value ? maskPii(props.account.user) : props.account.user))
const moreTitle = computed(() => (line.value.kind === 'bars' ? line.value.more.map((b) => `${b.label} ${b.pct}%`).join(' · ') : ''))
const staleTitle = computed(() => (line.value.kind === 'bars' && line.value.asOf ? `上次读取失败，显示 ${fmtTime(line.value.asOf)} 读到的用量` : '上次读取失败，显示之前读到的用量'))
</script>

<template>
  <li class="mx-row" :class="{ 'is-off': status.kind === 'off', 'is-attn': status.attention, 'ui-washed': washed }" :data-acc="account.id">
    <span class="mx-c mx-c--st">
      <StatusMark :state="busy ? 'busy' : status.kind" :label="busy ? '处理中' : status.word" />
    </span>
    <span class="mx-c mx-c--id">
      <Pii class="mx-user" :value="account.user" />
      <TxTag v-if="account.plan" class="mx-plan" size="sm" variant="outline" :label="account.plan" />
      <EgressTag v-if="exitBadge && (exitBadge.kind !== 'inherit' || exitBadge.country)" class="mx-eg" :badge="exitBadge" />
    </span>
    <span class="mx-c mx-c--q" :class="{ 'is-bars': line.kind === 'bars' }">
      <template v-if="line.kind === 'relogin'">
        <span class="mx-msg sig">{{ line.text }}</span>
        <button type="button" class="ui-link ui-link--sig mx-relogin" :aria-label="`重新登录 ${who}`" @click="emit('action', 'relogin')">重新登录</button>
      </template>
      <template v-else-if="line.kind === 'bars'">
        <span v-for="bar in line.bars" :key="bar.id" class="mx-q" :class="{ 'is-hot': bar.hot }" :title="`${bar.label} · 已用 ${bar.pct}%`">
          <span class="mx-q__k">{{ bar.short }}</span>
          <TickMeter :value="bar.used" :width="36" :show-pct="false" :aria-label="bar.label" />
          <b class="mx-q__pct num">{{ bar.pct }}%</b>
          <span v-if="bar.reset" class="mx-q__rst">{{ bar.reset }}</span>
        </span>
        <span v-if="line.more.length || line.resets > 0 || line.stale" class="mx-extra">
          <span v-if="line.more.length" class="mx-more num" :title="moreTitle">+{{ line.more.length }}</span>
          <span v-if="line.resets > 0" class="mx-more num" :title="`可用重置 ${line.resets} 次`">↺ {{ line.resets }}</span>
          <span v-if="line.stale" class="mx-more" :title="staleTitle" aria-label="用量不是最新">◇</span>
        </span>
      </template>
      <span v-else class="mx-msg" :class="{ sig: line.kind === 'error' && line.signedOut }" :title="line.kind === 'error' ? line.text : undefined">{{ line.text }}</span>
    </span>
    <span class="mx-c mx-c--act">
      <MagpieRowMenu :label="who" :items="menu" :busy="Boolean(busy)" @action="emit('action', $event)" />
    </span>
  </li>
</template>

<style>
/* one line: status · account + plan · two windows in fixed slots (they line up across rows and groups) · ⋯ */
.mx-row {
  display: grid; grid-template-columns: 96px minmax(0, 1fr) 486px 32px; grid-template-areas: "st id q act";
  column-gap: 14px; align-items: center; min-height: var(--row); padding: 2px 0 2px 2px; border-bottom: 1px solid var(--rule); min-width: 0;
  transition: background-color var(--dur-2) var(--ease-swift);
}
.mx-row:hover { background: color-mix(in srgb, var(--paper-2) 55%, transparent); }
.mx-row.is-attn { box-shadow: inset 2px 0 0 var(--signal); padding-left: 10px; }
.mx-row.is-off .mx-user { color: var(--ink-3); }
.mx-c { min-width: 0; display: flex; align-items: center; gap: 8px; white-space: nowrap; }
.mx-c--st { grid-area: st; }
.mx-c--id { grid-area: id; overflow: hidden; }
.mx-c--q { grid-area: q; gap: 12px; overflow: hidden; }
.mx-c--q.is-bars { display: grid; grid-template-columns: 200px 200px minmax(0, 1fr); column-gap: 14px; }
.mx-c--act { grid-area: act; justify-content: flex-end; }
.mx-user { min-width: 0; overflow: hidden; text-overflow: ellipsis; font-size: var(--fs-row); color: var(--ink); }
.mx-user .pii-t, .mx-user .pii-m { overflow: hidden; text-overflow: ellipsis; }
.mx-plan { flex: none; }
.mx-eg { flex: 0 1 auto; }
.mx-q { display: inline-flex; align-items: center; gap: 6px; min-width: 0; font-size: var(--fs-xs); }
.mx-q__k { flex: none; width: 7ch; text-align: right; font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--ink-3); overflow: hidden; text-overflow: ellipsis; }
.mx-q__pct { min-width: 4ch; text-align: right; font-weight: 400; color: var(--ink); }
.mx-q.is-hot .mx-q__pct { color: var(--signal-ink); }
.mx-q__rst { color: var(--ink-3); overflow: hidden; text-overflow: ellipsis; }
.mx-extra { display: inline-flex; align-items: center; gap: 10px; }
.mx-more { font-size: var(--fs-xs); color: var(--ink-3); flex: none; }
.mx-msg { font-size: var(--fs-xs); color: var(--ink-3); overflow: hidden; text-overflow: ellipsis; }
.mx-relogin { font-size: var(--fs-xs); flex: none; }

/* narrow list: status · account · ⋯ / plan · the two windows / exit */
@container mxlist (max-width: 760px) {
  .mx-row { display: flex; flex-wrap: wrap; align-items: center; column-gap: 10px; row-gap: 4px; padding: 7px 0; }
  .mx-row::before { content: ""; order: 4; flex-basis: 100%; height: 0; }
  .mx-c--st { order: 1; flex: none; }
  .mx-c--id { display: contents; }
  .mx-user { order: 2; flex: 1 1 0; }
  .mx-c--act { order: 3; flex: none; }
  .mx-plan { order: 5; }
  .mx-eg { order: 7; flex: 1 1 100%; }
  .mx-c--q, .mx-c--q.is-bars { order: 6; display: flex; flex: 1 1 0; gap: 12px; flex-wrap: wrap; row-gap: 4px; }
  .mx-q__k { width: auto; text-align: left; max-width: 8ch; }
}
@media (pointer: coarse) { .mx-relogin { min-height: var(--tap); } }
</style>
