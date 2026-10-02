<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import { TxButton } from '@talex-touch/tuffex/button'
import TickMeter from '../../ui/viz/TickMeter.vue'
import MicroBars from '../../ui/viz/MicroBars.vue'
import RankList from '../../ui/viz/RankList.vue'
import { clockParts, fmtClock, fmtCompact, fmtDate, fmtInt, fmtPct, fmtUsd } from '../../ui/fmt'
import type { RankRow } from '../../ui/types'
import type { ApiKeyItem, Group } from '../../types'
import {
  capMoney,
  ERROR_ALERT,
  errorRate,
  errorWords,
  failingBuckets,
  groupScope,
  limited,
  resetLabel,
  windowRatio,
  WINDOW_LABEL,
  type ActivityState,
  type KeyActivity,
  type WindowKey,
} from './keysModel'

/**
 * One Key in depth (DESIGN §6.3 expanded row; the same body is the phone detail sheet): 额度 (three windows
 * with reset times) · 近 7 天 (7 × 24h bars, top models, main error kinds) · 最近错误 (plain words, ≤5) ·
 * a facts strip (渠道, 并发, 创建, 备注). Spend comes from the quota ledger; request counts from
 * /api/keys/activity (current channels) — the head of each column says which.
 */
const props = withDefaults(
  defineProps<{
    item: ApiKeyItem
    activity: KeyActivity | null
    activityState: ActivityState
    groups: Group[]
    compact?: boolean
    /** desktop meter width (multiple of 4) */
    meterWidth?: number
  }>(),
  { compact: false, meterWidth: 180 },
)
const emit = defineEmits<{ quota: [] }>()

const windows = computed(() =>
  (['daily', 'weekly', 'total'] as WindowKey[]).map((key) => {
    const w = props.item.quotaState?.[key]
    const isLimited = limited(w)
    const ratio = windowRatio(w)
    // an unlimited total is not tallied by the ledger (only the day/week windows are read), so no amount
    const money = (v: number) => capMoney(v, fmtUsd)
    // the meter already says 不限 for an open window, so the line only carries what was spent
    const amount = !w ? '—' : isLimited ? `${money(w.spentUsd)} / ${money(w.limitUsd)}` : key === 'total' ? '' : money(w.spentUsd)
    const reset = key !== 'total' ? resetLabel(w?.resetsAt, Date.now(), clockParts) : isLimited ? '手动重置' : ''
    return { key, label: WINDOW_LABEL[key], isLimited, ratio, amount, reset, over: Boolean(w?.exceeded) }
  }),
)

const a = computed(() => props.activity)
const rate = computed(() => errorRate(a.value))
const topRows = computed<RankRow[]>(() =>
  (a.value?.d7.topModels ?? []).map((m) => ({
    key: m.model,
    name: m.model,
    value: m.requests,
    share: a.value && a.value.d7.requests > 0 ? m.requests / a.value.d7.requests : null,
  })),
)
const kinds = computed(() => (a.value?.d7.errorKinds ?? []).map((k) => `${errorWords(k.category, k.status)} ×${fmtInt(k.count)}`).join(' · '))
const usageNote = computed(() => {
  if (props.activityState === 'unavailable') return '用量暂不可用 · 服务更新后显示'
  if (props.activityState === 'error' && !a.value) return '用量读取失败'
  if (props.activityState === 'loading' && !a.value) return '读取中'
  return ''
})

const scope = computed(() => groupScope(props.item, props.groups))
const concurrency = computed(() => {
  const total = props.item.totalConcurrency
  if (!total) return '不限'
  const per = Object.entries(props.item.groupConcurrency ?? {})
    .filter(([id]) => props.item.groups.includes(id))
    .map(([id, n]) => `${props.groups.find((g) => g.id === id)?.name ?? id} ${n}`)
  return per.length ? `${total} · ${per.join(' · ')}` : String(total)
})
/* 渠道 · 并发 · 创建 · 备注: under 额度 on desktop (fills that column's spare height), last on the phone sheet */
const facts = computed(() => [
  { k: '渠道', v: scope.value.label, dim: scope.value.none },
  { k: '并发', v: concurrency.value, num: true },
  { k: '创建', v: fmtDate(props.item.createdAt), num: true },
  ...(props.item.note ? [{ k: '备注', v: props.item.note, note: true }] : []),
])
const requestsLink = computed(() => ({ path: '/usage/requests', query: { keyId: props.item.id, days: '7' } }))
</script>

<template>
  <div class="kx-detail" :class="{ 'is-compact': compact }">
    <section class="kx-detail__col" aria-label="额度">
      <h3 class="kx-detail__h">额度 <span class="kx-detail__sub">花费按额度账本</span></h3>
      <p v-if="item.blockedReason" class="kx-detail__blocked">
        <span aria-hidden="true">◆</span> 超额停用 · {{ item.blockedReason }} · 调高额度或重置后自动恢复
      </p>
      <ul class="kx-detail__wins">
        <li v-for="w in windows" :key="w.key" class="kx-detail__win">
          <span class="kx-detail__wk">{{ w.label }}</span>
          <TickMeter
            :value="w.ratio"
            :unlimited="!w.isLimited"
            :width="meterWidth"
            :fluid="compact"
            :aria-label="`${w.label}额度`"
          />
          <span v-if="w.amount || w.reset" class="kx-detail__amt num"><span :class="{ sig: w.over }">{{ w.amount }}</span><span v-if="w.reset" class="kx-detail__rst"><template v-if="w.amount"> · </template>{{ w.reset }}</span></span>
        </li>
      </ul>
      <TxButton v-if="!compact" variant="secondary" size="sm" @click="emit('quota')">调整额度</TxButton>
      <dl v-if="!compact" class="kx-detail__facts">
        <div v-for="f in facts" :key="f.k" :class="{ 'kx-detail__note': f.note }"><dt>{{ f.k }}</dt><dd :class="{ dim: f.dim, num: f.num }">{{ f.v }}</dd></div>
      </dl>
    </section>

    <section class="kx-detail__col" aria-label="近 7 天">
      <h3 class="kx-detail__h">近 7 天 <span class="kx-detail__sub">全部渠道 · 每格 24h</span></h3>
      <p v-if="usageNote" class="kx-detail__empty">— {{ usageNote }}</p>
      <template v-else-if="a">
        <div class="kx-detail__days">
          <MicroBars
            :buckets="a.d7.daily.map((d) => d.requests)"
            :errors="failingBuckets(a.d7.daily.map((d) => d.requests), a.d7.daily.map((d) => d.errors))"
            :w="146"
            :h="30"
            :gap="5"
            :label="`近 7 天每 24 小时请求数：${a.d7.daily.map((d) => d.requests).join('、')}`"
          />
          <p class="kx-detail__sum num">
            {{ fmtInt(a.d7.requests) }} 次
            <template v-if="rate !== null"> · <span :class="{ sig: rate >= ERROR_ALERT }">错误 {{ fmtPct(rate) }}</span></template>
            <template v-if="a.d7.tokens"> · {{ fmtCompact(a.d7.tokens) }} Token</template>
          </p>
        </div>
        <p v-if="!a.d7.requests" class="kx-detail__empty">— 近 7 天没有调用</p>
        <template v-else>
          <RankList :rows="topRows" :limit="3" :format="(v) => fmtInt(v)" />
          <p v-if="kinds" class="kx-detail__kinds">主因 {{ kinds }}</p>
        </template>
      </template>
    </section>

    <section class="kx-detail__col" aria-label="最近错误">
      <h3 class="kx-detail__h">最近错误 <span class="kx-detail__sub">近 7 天</span></h3>
      <p v-if="usageNote" class="kx-detail__empty">— {{ usageNote }}</p>
      <template v-else-if="a">
        <ol v-if="a.recentErrors.length" class="kx-detail__errs">
          <li v-for="(e, i) in a.recentErrors" :key="i" class="kx-detail__err">
            <span class="kx-detail__t num">{{ fmtClock(e.at) }}</span>
            <span class="kx-detail__w"><span class="kx-detail__mk" aria-hidden="true">◆</span>{{ errorWords(e.category, e.status) }}</span>
            <span class="kx-detail__m mono">{{ e.model }}</span>
          </li>
        </ol>
        <p v-else class="kx-detail__empty">— 近 7 天没有错误</p>
      </template>
      <RouterLink class="ui-link kx-detail__link" :to="requestsLink">看请求 →</RouterLink>
    </section>

    <dl v-if="compact" class="kx-detail__facts">
      <div v-for="f in facts" :key="f.k" :class="{ 'kx-detail__note': f.note }"><dt>{{ f.k }}</dt><dd :class="{ dim: f.dim, num: f.num }">{{ f.v }}</dd></div>
    </dl>
  </div>
</template>

<style>
.kx-detail { display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr) minmax(0, 1fr); gap: 0 clamp(24px, 2.6vw, 40px); white-space: normal; }
/* spacing alone separates the three columns and the facts line (no rules inside the expanded band) */
.kx-detail__col { min-width: 0; padding: 2px 0 10px; display: flex; flex-direction: column; align-items: flex-start; gap: 8px; }
.kx-detail__col:first-child { padding-left: 4px; }
.kx-detail__h { margin: 0; display: flex; align-items: baseline; gap: 8px; font-size: var(--fs-sm); font-weight: 600; color: var(--ink); }
.kx-detail__sub { font-size: var(--fs-xs); font-weight: 400; color: var(--ink-3); }
.kx-detail__blocked { margin: 0; font-size: var(--fs-xs); color: var(--ink); }
.kx-detail__blocked span { color: var(--signal); }
.kx-detail__wins { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; width: 100%; }
.kx-detail__win { display: grid; grid-template-columns: 28px auto minmax(0, 1fr); align-items: center; gap: 10px; min-width: 0; }
.kx-detail__wk { font-size: var(--fs-xs); color: var(--ink-3); }
.kx-detail__amt { font-size: var(--fs-xs); color: var(--ink-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kx-detail__rst { color: var(--ink-3); }
.kx-detail__days { display: flex; align-items: flex-end; gap: 14px; flex-wrap: wrap; }
.kx-detail__sum { margin: 0; font-size: var(--fs-xs); color: var(--ink-2); }
.kx-detail__kinds { margin: 0; font-size: var(--fs-xs); color: var(--ink-2); }
.kx-detail__empty { margin: 0; font-size: var(--fs-xs); color: var(--ink-3); }
.kx-detail__errs { list-style: none; margin: 0; padding: 0; width: 100%; display: grid; gap: 4px; }
.kx-detail__err { display: grid; grid-template-columns: auto auto minmax(0, 1fr); gap: 10px; align-items: baseline; font-size: var(--fs-xs); min-width: 0; }
.kx-detail__t { color: var(--ink-3); }
.kx-detail__w { color: var(--ink-2); white-space: nowrap; }
.kx-detail__mk { color: var(--signal); margin-right: 4px; font-size: 9px; }
.kx-detail__m { color: var(--ink-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kx-detail__link { margin-top: auto; font-size: var(--fs-xs); }
.kx-detail .ui-rank { width: 100%; }
.kx-detail__facts { display: flex; flex-wrap: wrap; gap: 4px 18px; margin: 4px 0 0; padding: 0; font-size: var(--fs-xs); }
.kx-detail__facts > div { display: inline-flex; gap: 6px; min-width: 0; max-width: 100%; }
.kx-detail__facts dt { color: var(--ink-3); }
.kx-detail__facts dd { margin: 0; color: var(--ink-2); min-width: 0; overflow-wrap: anywhere; }
.kx-detail__note { flex: 1 1 260px; }

.kx-detail.is-compact { grid-template-columns: minmax(0, 1fr); }
.kx-detail.is-compact .kx-detail__col { padding: 12px 0; }
.kx-detail.is-compact .kx-detail__col + .kx-detail__col { border-top: 1px solid var(--rule); }
.kx-detail.is-compact .kx-detail__col:first-child { padding-top: 0; }
.kx-detail.is-compact .kx-detail__win { grid-template-columns: 32px minmax(0, 1fr); row-gap: 2px; }
.kx-detail.is-compact .kx-detail__amt { grid-column: 2; }
.kx-detail.is-compact .kx-detail__facts { flex-direction: column; margin: 0; padding: 12px 0 0; border-top: 1px solid var(--rule); }
</style>
