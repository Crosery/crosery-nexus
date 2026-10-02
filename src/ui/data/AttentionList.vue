<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import { TxButton } from '@talex-touch/tuffex/button'
import EmailIdentity from './EmailIdentity.vue'
import { useNow } from '../composables/useNow'
import { fmtAgo } from '../fmt'
import type { AttentionItem } from '../types'

/**
 * Attention list (DESIGN.md §5.2 data/AttentionList, dashboard): 48px rows ranked by severity —
 * ◆ bad (signal), ◇ warn (signal outline), ○ note (ink-3) — with a micro kind tag (KEY · ACCT · CHAN · SYNC ·
 * KERN), the subject (email identities mask-aware), a plain-word reason, an optional mono metric and ONE
 * boxed action. When fewer than 4 items are open it fills up to 3 `最近 24h 已恢复` rows (✓ ink-3) so the
 * plate never leaves a dead band. Empty + nothing recovered = one ink-3 line.
 */
const props = withDefaults(
  defineProps<{
    items: AttentionItem[]
    /** recently recovered items (last 24h), newest first */
    recovered?: AttentionItem[]
    max?: number
    fillRecovered?: boolean
    emptyText?: string
  }>(),
  { recovered: () => [], max: 7, fillRecovered: true, emptyText: '— 没有需要处理的事项' },
)
const emit = defineEmits<{ action: [item: AttentionItem] }>()

const RANK = { bad: 0, warn: 1, note: 2, ok: 3 } as const
const MARK = { bad: '◆', warn: '◇', note: '○', ok: '✓' } as const
const open = computed(() => [...props.items].sort((a, b) => RANK[a.severity] - RANK[b.severity]).slice(0, props.max))
const filler = computed(() => (props.fillRecovered && open.value.length < 4 ? props.recovered.slice(0, 3) : []))
const more = computed(() => Math.max(0, props.items.length - props.max))
const tick = useNow()
</script>

<template>
  <div class="ui-attn">
    <ol v-if="open.length" class="ui-attn__list">
      <li v-for="(it, i) in open" :key="it.id" class="ui-attn__row" :class="`is-${it.severity}`" data-row :style="{ '--r': i }">
        <span class="ui-attn__mark" aria-hidden="true">{{ MARK[it.severity] }}</span>
        <span class="ui-attn__kind">{{ it.kind }}</span>
        <span class="ui-attn__main">
          <span class="ui-attn__subj">
            <EmailIdentity v-if="it.email" :email="it.subject" /><template v-else>{{ it.subject }}</template>
          </span>
          <span class="ui-attn__why">{{ it.reason }}<template v-if="it.at"> · {{ fmtAgo(it.at, tick) }}</template></span>
        </span>
        <span v-if="it.metric" class="ui-attn__metric num">{{ it.metric }}</span>
        <span class="ui-attn__act">
          <template v-if="it.action">
            <RouterLink v-if="it.action.to" :to="it.action.to" class="ui-btn ui-btn--sm">{{ it.action.label }}</RouterLink>
            <TxButton v-else size="sm" @click="emit('action', it)">{{ it.action.label }}</TxButton>
          </template>
        </span>
        <span class="sr-only">{{ { bad: '严重', warn: '注意', note: '提示', ok: '已恢复' }[it.severity] }}</span>
      </li>
    </ol>
    <p v-else class="ui-attn__empty">{{ emptyText }}</p>
    <p v-if="more" class="ui-attn__more">另有 {{ more }} 项</p>
    <template v-if="filler.length">
      <p class="ui-attn__rec-h">最近 24h 已恢复</p>
      <ol class="ui-attn__list">
        <li v-for="it in filler" :key="`r-${it.id}`" class="ui-attn__row is-rec">
          <span class="ui-attn__mark" aria-hidden="true">✓</span>
          <span class="ui-attn__kind">{{ it.kind }}</span>
          <span class="ui-attn__main">
            <span class="ui-attn__subj"><EmailIdentity v-if="it.email" :email="it.subject" /><template v-else>{{ it.subject }}</template></span>
            <span class="ui-attn__why">{{ it.reason }}<template v-if="it.at"> · {{ fmtAgo(it.at, tick) }}</template></span>
          </span>
        </li>
      </ol>
    </template>
  </div>
</template>

<style>
.ui-attn { min-width: 0; }
.ui-attn__list { margin: 0; padding: 0; list-style: none; }
.ui-attn__row { display: grid; grid-template-columns: 14px 40px minmax(0, 1fr) auto auto; align-items: center; gap: 0 10px; min-height: var(--row-attn); border-bottom: 1px solid var(--rule); font-size: var(--fs-sm); }
.ui-attn__mark { font-size: 11px; line-height: 1; color: var(--ink-3); }
.ui-attn__row.is-bad .ui-attn__mark, .ui-attn__row.is-warn .ui-attn__mark { color: var(--signal); }
.ui-attn__kind { font-family: var(--font-mono); font-size: var(--fs-micro); letter-spacing: .08em; color: var(--ink-3); }
.ui-attn__main { display: grid; min-width: 0; }
.ui-attn__subj { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ink); }
.ui-attn__why { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--fs-xs); color: var(--ink-2); }
.ui-attn__row.is-bad .ui-attn__why { color: var(--signal-ink); }
.ui-attn__metric { font-size: var(--fs-xs); color: var(--ink-2); white-space: nowrap; }
.ui-attn__act { justify-self: end; }
.ui-attn__row.is-rec { color: var(--ink-3); grid-template-columns: 14px 40px minmax(0, 1fr); min-height: 40px; }
.ui-attn__row.is-rec .ui-attn__subj, .ui-attn__row.is-rec .ui-attn__why { color: var(--ink-3); }
.ui-attn__empty, .ui-attn__more { margin: 0; padding: 8px 0; font-size: var(--fs-sm); color: var(--ink-3); }
.ui-attn__rec-h { margin: 10px 0 0; font-family: var(--font-mono); font-size: var(--fs-micro); letter-spacing: .09em; color: var(--ink-3); }
/* 390 (§6.2): ≥64px card — line 1 mark · kind · subject, line 2 the reason; metric above the action at the right */
@media (max-width: 599px) {
  .ui-attn__row {
    grid-template-columns: 14px auto minmax(0, 1fr) auto; grid-template-areas: "mark kind main metric" "mark kind main act";
    gap: 2px 8px; min-height: 64px; padding: 8px 0;
  }
  .ui-attn__mark { grid-area: mark; }
  .ui-attn__kind { grid-area: kind; align-self: start; padding-top: 3px; }
  .ui-attn__main { grid-area: main; }
  .ui-attn__metric { grid-area: metric; align-self: end; justify-self: end; }
  .ui-attn__act { grid-area: act; align-self: start; }
  .ui-attn__why { white-space: normal; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
  .ui-attn__row.is-rec { grid-template-columns: 14px auto minmax(0, 1fr); grid-template-areas: "mark kind main" "mark kind main"; min-height: 48px; }
}
</style>
