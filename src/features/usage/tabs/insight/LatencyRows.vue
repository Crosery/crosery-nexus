<script setup lang="ts">
import { computed } from 'vue'
import { fmtDuration, fmtInt, fmtPct } from '../../../../ui/fmt'
import { axisMs, logPos, logTicks, SUCCESS_ATTN, type PerfGroup } from './model'

/**
 * 首字 vs 耗时 per channel / model (local: kit RangeBars draws one range per row). Each row carries two lanes on
 * one shared log-ms axis — 首字 (TTFT) above, 耗时 (total) below — a dot at P50 and a bar to P95, so the gap
 * between first token and completion reads at a glance. Log scale because 200ms and 80s share a page.
 * Success rate turns signal-ink only below SUCCESS_ATTN (an act-on-this row); unknown is —, never 0.
 */
const props = withDefaults(
  defineProps<{
    rows: PerfGroup[]
    /** name column heading */
    nameLabel: string
    emptyText?: string
  }>(),
  { emptyText: '— 没有请求' },
)

const axis = computed(() => {
  const values: number[] = []
  for (const r of props.rows) for (const s of [r.latency, r.ttft]) for (const v of [s?.p50, s?.p95]) if (typeof v === 'number' && v > 0) values.push(v)
  return logTicks(values.length ? Math.min(...values) : 100, values.length ? Math.max(...values) : 10_000, 6)
})
const pos = (v: number | null | undefined) => {
  const p = logPos(v ?? null, axis.value.lo, axis.value.hi)
  return p === null ? null : p * 100
}
const lane = (s: { p50: number | null; p95: number | null } | null) => {
  const a = pos(s?.p50)
  const b = pos(s?.p95)
  if (a === null) return null
  return { dot: a, from: Math.min(a, b ?? a), width: Math.max(0, Math.abs((b ?? a) - a)) }
}
/** hairline gridlines at the log ticks (one background layer per tick) */
const grid = computed(() => {
  const ticks = axis.value.ticks
  return {
    backgroundImage: ticks.map(() => 'linear-gradient(var(--rule), var(--rule))').join(', '),
    backgroundSize: ticks.map(() => '1px 100%').join(', '),
    backgroundPosition: ticks.map((t) => `${pos(t) ?? 0}% 0`).join(', '),
    backgroundRepeat: 'no-repeat',
  }
})
const items = computed(() => props.rows.map((r, i) => ({ r, i, ttft: lane(r.ttft), total: lane(r.latency), attn: r.successRate !== null && r.successRate < SUCCESS_ATTN })))
const pair = (s: { p50: number | null; p95: number | null } | null) => (s ? `${fmtDuration(s.p50)} / ${fmtDuration(s.p95)}` : '—')
const aria = (r: PerfGroup) => `${r.label}：首字 P50 ${fmtDuration(r.ttft?.p50)}、P95 ${fmtDuration(r.ttft?.p95)}；耗时 P50 ${fmtDuration(r.latency?.p50)}、P95 ${fmtDuration(r.latency?.p95)}`
</script>

<template>
  <div v-if="rows.length" class="lr" role="table" :aria-label="`${nameLabel} 延迟`">
    <div class="lr__row lr__head" role="row">
      <span role="columnheader">{{ nameLabel }}</span>
      <span role="columnheader" class="r">请求</span>
      <span role="columnheader" class="r">成功率</span>
      <span role="columnheader" class="lr__legend"><i class="k-ttft" />首字 <i class="k-total" />耗时 <span class="dim">· 点 P50 · 线到 P95</span></span>
      <span role="columnheader" class="r">P50 / P95</span>
    </div>
    <div v-for="it in items" :key="it.r.id" class="lr__row" :class="{ 'is-attn': it.attn }" role="row" data-row :style="{ '--r': Math.min(it.i, 14) }">
      <span class="lr__n" role="cell"><span class="ellip mono" :title="it.r.removed ? `${it.r.label} · 已移除` : it.r.label">{{ it.r.label }}</span><span v-if="it.r.removed" class="lr__gone">已移除</span></span>
      <span class="r num" role="cell"><span class="lr__k">请求 </span>{{ fmtInt(it.r.requests) }}</span>
      <span class="r num lr__ok" :class="{ sig: it.attn }" role="cell"><span class="lr__k">成功 </span>{{ fmtPct(it.r.successRate) }}</span>
      <span class="lr__lanes" role="cell" :aria-label="aria(it.r)" :style="grid">
        <span class="lr__lane is-ttft" aria-hidden="true">
          <template v-if="it.ttft"><b :style="{ left: `${it.ttft.from}%`, width: `${it.ttft.width}%` }" /><i :style="{ left: `${it.ttft.dot}%` }" /></template>
        </span>
        <span class="lr__lane is-total" aria-hidden="true">
          <template v-if="it.total"><b :style="{ left: `${it.total.from}%`, width: `${it.total.width}%` }" /><i :style="{ left: `${it.total.dot}%` }" /></template>
          <em v-else-if="!it.ttft" class="lr__none">无成功请求</em>
        </span>
      </span>
      <span class="lr__v num" role="cell">
        <span><span class="lr__k">首字 </span>{{ pair(it.r.ttft) }}</span>
        <span class="ink"><span class="lr__k">耗时 </span>{{ pair(it.r.latency) }}</span>
      </span>
    </div>
    <div class="lr__row lr__axis" aria-hidden="true">
      <span /><span /><span />
      <span class="lr__ticks">
        <span v-for="t in axis.ticks" :key="t" :style="{ left: `${pos(t)}%` }">{{ axisMs(t) }}</span>
      </span>
      <span class="lr__scale">对数刻度</span>
    </div>
  </div>
  <p v-else class="lr__empty">{{ emptyText }}</p>
</template>

<style scoped>
.lr { display: grid; }
.lr__row { position: relative; display: grid; grid-template-columns: minmax(120px, 26%) 64px 64px minmax(0, 1fr) 132px; align-items: center; gap: 0 14px; min-height: 44px; border-bottom: 1px solid var(--rule); font-size: var(--fs-sm); }
.lr__head { min-height: 30px; font-family: var(--font-mono); font-size: var(--fs-micro); letter-spacing: .06em; color: var(--ink-3); text-transform: uppercase; }
.lr__head .lr__legend { text-transform: none; letter-spacing: 0; font-family: var(--font-sans); font-size: var(--fs-xs); display: inline-flex; align-items: center; gap: 6px; }
.lr__legend i { display: inline-block; width: 12px; height: 3px; }
.lr__legend .k-ttft { background: var(--k3); }
.lr__legend .k-total { background: var(--ink); margin-left: 6px; }
.r { text-align: right; }
.lr__n { min-width: 0; display: flex; align-items: baseline; gap: 6px; }
.lr__n .ellip { min-width: 0; }
.lr__gone { flex: none; font-size: var(--fs-micro); color: var(--ink-3); white-space: nowrap; }
.lr__k { display: none; }
.lr__ok.sig { color: var(--signal-ink); }
/* attention edge on the plate's left edge (like RowTable's attn tone), so the columns stay aligned */
.lr__row.is-attn::before { content: ''; position: absolute; left: -14px; top: 0; bottom: 0; width: 2px; background: var(--signal); }
.lr__lanes { position: relative; display: grid; gap: 5px; padding: 6px 0; }
.lr__lane { position: relative; height: 6px; }
.lr__lane b { position: absolute; top: 2px; height: 2px; }
.lr__lane i { position: absolute; top: 0; width: 6px; height: 6px; margin-left: -3px; border-radius: 50%; }
.lr__lane.is-ttft b { background: var(--k3); }
.lr__lane.is-ttft i { background: var(--paper); box-shadow: inset 0 0 0 1.5px var(--k3); }
.lr__lane.is-total b { top: 1.5px; height: 3px; background: var(--ink-2); }
.lr__lane.is-total i { background: var(--ink); }
.lr__none { position: absolute; left: 0; top: -6px; font-style: normal; font-size: var(--fs-xs); color: var(--ink-3); }
.lr__v { display: grid; justify-items: end; gap: 1px; font-size: var(--fs-xs); color: var(--ink-3); white-space: nowrap; }
.lr__v .ink { color: var(--ink); }
.lr__axis { min-height: 22px; border-bottom: 0; }
.lr__ticks { position: relative; height: 100%; min-height: 18px; }
.lr__ticks span { position: absolute; top: 4px; transform: translateX(-50%); font-family: var(--font-mono); font-size: 10px; color: var(--ink-3); white-space: nowrap; }
.lr__ticks span:first-child { transform: none; }
.lr__ticks span:last-child { transform: translateX(-100%); }
.lr__scale { justify-self: end; font-size: var(--fs-xs); color: var(--ink-3); }
.lr__empty { margin: 0; padding: 8px 0; font-size: var(--fs-sm); color: var(--ink-3); }
@media (max-width: 1179px) {
  .lr__row { grid-template-columns: minmax(110px, 24%) 56px 60px minmax(0, 1fr) 124px; gap: 0 10px; }
}
@media (max-width: 599px) {
  .lr__head { display: none; }
  .lr__row { grid-template-columns: minmax(0, 1fr) auto auto; grid-template-areas: 'n q ok' 'l l l' 'v v v'; gap: 4px 10px; padding: 8px 0; }
  .lr__n { grid-area: n; }
  .lr__row > .r:nth-child(2) { grid-area: q; }
  .lr__ok { grid-area: ok; }
  /* phones: the axis labels sit at the very bottom of a long list, so the per-row log gridlines read as stray boxes */
  .lr__lanes { grid-area: l; background-image: none !important; }
  .lr__v { grid-area: v; display: flex; justify-content: space-between; gap: 12px; }
  .lr__k { display: inline; color: var(--ink-3); }
  .lr__axis { grid-template-columns: 1fr; grid-template-areas: none; padding: 0; }
  .lr__axis > span:not(.lr__ticks) { display: none; }
  .lr__axis .lr__ticks { grid-area: auto; }
}
</style>
