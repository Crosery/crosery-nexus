<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import Plate from '../../../ui/data/Plate.vue'
import Readout from '../../../ui/viz/Readout.vue'
import Heatmap from '../../../ui/viz/Heatmap.vue'
import HeatYears from '../../../ui/viz/HeatYears.vue'
import RankList from '../../../ui/viz/RankList.vue'
import Segmented from '../../../ui/form/Segmented.vue'
import { useLive } from '../../../ui/composables/useLive'
import { fmtCompact, fmtInt, fmtPct, fmtUsd, NONE } from '../../../ui/fmt'
import { useQueryState } from '../../../lib/listState'
import type { RankRow, ReadoutDelta } from '../../../ui/types'
import { heatSummary, type HeatMetric, type HeatYear } from '../../../ui/viz/heatModel'
import { sharedUsageQuery, USAGE_FILTER_DEFAULTS, usageFilterFrom, windowText as windowTextOf } from '../filters'
import { api } from '../shared/api'
import { categoryLabel, costNote, costText, ppDelta, relDelta, shortStamp, windowSpan } from '../shared/format'
import UsageState from '../shared/UsageState.vue'
import '../shared/rank.css'
import type { UsageDay, UsageOverviewData, UsageRank } from '../shared/types'

/**
 * 用量 · 总览 (DESIGN §6.7): ledger, daily intensity with a docked day readout, token mix, four ranks and the
 * failure mix — all from ONE `/api/usage-overview?view=workspace` read under the shared filter, so every number
 * on the tab (and on 请求 / the dashboard for the same filter) adds up.
 */
const route = useRoute()
const scope = useQueryState({ ...USAGE_FILTER_DEFAULTS, heat: 'tokens' })
const filter = computed(() => usageFilterFrom(scope.state))
const carried = computed(() => sharedUsageQuery(route.query))

const live = useLive((signal) => api.usageOverview<UsageOverviewData>(filter.value, signal), {
  intervalMs: 60_000,
  isEmpty: (data) => data.ledger.requests === 0 && data.daily.every((day) => day.requests === 0),
})
watch(
  [() => scope.state.days, () => scope.state.from, () => scope.state.to, () => scope.state.keyId, () => scope.state.model, () => scope.state.provider, () => scope.state.client, () => scope.state.currentOnly],
  () => void live.refresh(),
)

const data = computed(() => live.data.value ?? null)
const state = computed(() => live.state.value)
const busy = computed(() => live.loading.value && data.value !== null)
const plateState = computed(() => (state.value === 'stale' ? 'stale' : data.value ? 'ready' : 'loading'))
const ledger = computed(() => data.value?.ledger ?? null)
const previous = computed(() => data.value?.previous ?? null)
const approx = computed(() => Boolean(ledger.value && (ledger.value.costEstimated || ledger.value.hasPartialCost)))
const windowText = computed(() => windowTextOf(data.value?.window, filter.value.days))
const asOf = computed(() => (data.value ? `截至 ${shortStamp(data.value.window.to).slice(6)}` : ''))
const vsLabel = computed(() => {
  const days = data.value?.window.days ?? filter.value.days
  return days === 1 ? 'vs 前 24 小时' : `vs 前 ${days} 日`
})
const lastSeven = (pick: (day: UsageDay) => number | null) => (data.value?.daily ?? []).slice(-7).map(pick)
const perDay = (value: number) => value / Math.max(1, data.value?.window.days ?? 1)

/* ── ledger ──────────────────────────────────────────────────────────────────────────────────── */
type Cell = { key: string; label: string; value: string; unit?: string; roll?: boolean; delta: ReadoutDelta | null; history?: Array<number | null>; sub: string }
const cells = computed<Cell[]>(() => {
  const l = ledger.value
  if (!l) return []
  const p = previous.value
  const delta = (value: number | null, unit: ReadoutDelta['unit'] = 'pct', bad = false, threshold = 0): ReadoutDelta | null =>
    p ? { value, unit, bad, threshold, label: vsLabel.value } : null
  const cost = costText(l.costUsd, { estimated: l.costEstimated, partial: l.hasPartialCost, mark: false })
  const errorDelta = ppDelta(l.errorRate, p?.errorRate)
  return [
    {
      key: 'requests', label: '请求', value: fmtInt(l.requests),
      delta: delta(relDelta(l.requests, p?.requests)), history: lastSeven((d) => d.requests),
      sub: l.requests ? `日均 ${fmtInt(perDay(l.requests))}` : '',
    },
    {
      key: 'tokens', label: 'Token', value: fmtCompact(l.tokens),
      delta: delta(relDelta(l.tokens, p?.tokens)), history: lastSeven((d) => d.tokens),
      sub: l.requests ? `每次 ${fmtCompact(l.tokens / l.requests)}` : '',
    },
    {
      key: 'cost', label: approx.value && cost !== NONE ? '花费 ≈' : '花费', value: cost, roll: cost !== '免费',
      delta: delta(relDelta(l.costUsd, p?.costUsd)), history: lastSeven((d) => d.costUsd),
      sub: l.costUsd === null && l.requests > 0 ? '未定价' : costNote(l),
    },
    {
      key: 'errors', label: '失败率', value: l.errorRate === null ? NONE : fmtPct(l.errorRate, 2),
      delta: delta(errorDelta, 'pp', errorDelta !== null && errorDelta > 0, 0.005),
      sub: `${fmtInt(l.errors)} 次失败`,
    },
    {
      key: 'cache', label: '缓存命中', value: l.cacheHitRate === null ? NONE : fmtPct(l.cacheHitRate),
      delta: delta(ppDelta(l.cacheHitRate, p?.cacheHitRate), 'pp'),
      // the 缓存 tab's own headline and wording (cacheIdleModels = its excluded.models)
      sub: l.cacheHitRate === null ? '没有可缓存的请求' : l.cacheIdleModels > 0 ? `不支持缓存 ${l.cacheIdleModels} 个模型 · 不计入` : '',
    },
    {
      key: 'keys', label: '活跃 Key', value: fmtInt(l.activeKeys), unit: `/ ${fmtInt(l.totalKeys)}`,
      delta: delta(p ? l.activeKeys - p.activeKeys : null, 'abs'),
      sub: `已启用 ${fmtInt(l.enabledKeys)}`,
    },
  ]
})

/* ── heatmap: a year of days, independent of the window; a selected span becomes the window ────── */
const HEAT_ITEMS = [
  { value: 'tokens', label: 'Token' },
  { value: 'requests', label: '请求' },
  { value: 'cost', label: '花费' },
]
const heatMetric = computed<HeatMetric>(() => (scope.state.heat === 'requests' || scope.state.heat === 'cost' ? scope.state.heat : 'tokens'))
const heatYear = ref<HeatYear>('recent')
const daily = useLive((signal) => api.daily(filter.value, heatYear.value, signal), { intervalMs: 5 * 60_000 })
watch(
  [() => scope.state.keyId, () => scope.state.model, () => scope.state.provider, () => scope.state.client, () => scope.state.currentOnly, heatYear],
  () => void daily.refresh(),
)
const series = computed(() => daily.data.value ?? null)
const heatApprox = computed(() => Boolean(series.value && (series.value.totals.costEstimated || series.value.totals.unpricedRequests > 0)))
const HEAT_FMT = { compact: fmtCompact, int: fmtInt, usd: (v: number) => fmtUsd(v, { approx: heatApprox.value }) }
const heatTitle = computed(() => heatSummary(series.value, heatMetric.value, heatYear.value, HEAT_FMT))
const heatState = computed(() => (daily.state.value === 'empty' ? 'ready' : daily.state.value))
/** the shared filters minus the window: a day / span link sets its own from / to */
const scoped = computed(() => {
  const { days: _days, from: _from, to: _to, hours: _hours, ...rest } = carried.value
  return rest
})
const dayLink = (day: string) => ({ path: '/usage/requests', query: { ...scoped.value, from: day, to: day } })
function applySpan(from: string, to: string) {
  scope.patch({ from, to })
  scope.flush()
}

/* ── token mix ───────────────────────────────────────────────────────────────────────────────── */
const mixRows = computed(() => {
  const mix = data.value?.mix
  if (!mix) return []
  const total = mix.freshInput + mix.output + mix.cacheRead + mix.cacheWrite
  return [
    { key: 'in', label: '新输入', tone: 'uov-t1', value: mix.freshInput },
    { key: 'out', label: '输出', tone: 'uov-t2', value: mix.output },
    { key: 'cr', label: '缓存读', tone: 'uov-t3', value: mix.cacheRead },
    { key: 'cw', label: '缓存写', tone: 'uov-t4', value: mix.cacheWrite },
  ].map((row) => ({ ...row, share: total > 0 ? row.value / total : null }))
})

/* ── 03–06 ranks ─────────────────────────────────────────────────────────────────────────────── */
const errOf = (r: UsageRank) => (r.requests > 0 ? r.errors / r.requests : null)
const modelRows = computed<RankRow[]>(() => (data.value?.models ?? []).map((r) => ({ key: r.id, name: r.label, value: r.tokens, err: errOf(r) })))
const UNSELECTABLE = new Set(['__deleted__', '__none__'])
// 按 Key ranks by spend; when nothing in the window is priced above zero it ranks by requests instead of a column of $0.00
const keysByCost = computed(() => (data.value?.keys ?? []).some((r) => (r.costUsd ?? 0) > 0))
const keyRows = computed<RankRow[]>(() =>
  (data.value?.keys ?? []).map((r) => ({
    key: r.id,
    name: r.label,
    value: !keysByCost.value ? r.requests : r.costUsd === 0 && r.partialCost ? null : r.costUsd,
    sub: r.id === '__deleted__' ? '已删除' : r.id === '__none__' ? '未带 Key' : r.enabled === false ? '已停用' : undefined,
  })),
)
// a channel removed since keeps its history here, named by its id and marked (the 全部渠道 scope is the default)
const channelRows = computed<RankRow[]>(() => (data.value?.channels ?? []).map((r) => ({ key: r.id, name: r.removed ? `${r.label} · 已移除` : r.label, value: r.requests, err: errOf(r) })))
const clientRows = computed<RankRow[]>(() => (data.value?.clients ?? []).map((r) => ({ key: r.id, name: r.label, value: r.requests, err: errOf(r) })))
// the plate meta carries the ≈; rows stay bare numbers
const costFormat = (value: number | null) => (value === null ? NONE : fmtUsd(value, { digits: value >= 100 ? 0 : 2 }))

function pick(field: 'model' | 'keyId' | 'provider' | 'client', row: RankRow) {
  const id = String(row.key ?? '')
  if (!id || UNSELECTABLE.has(id)) return
  scope.patch({ [field]: scope.state[field] === id ? '' : id })
  scope.flush()
}

/* ── 07 failures ─────────────────────────────────────────────────────────────────────────────── */
const failures = computed(() => {
  const list = data.value?.failures ?? []
  const max = Math.max(1, ...list.map((f) => f.count))
  return list.map((f) => ({
    ...f,
    label: categoryLabel(f.category),
    codes: f.codes.map((c) => c.code).join(' / '),
    bar: f.count / max,
    to: { path: '/usage/requests', query: { ...carried.value, status: 'error', category: f.category } },
  }))
})

const widen = () => {
  scope.patch({ days: '90', from: '', to: '' })
  scope.flush()
}
const emptyText = computed(() => `${windowText.value}没有请求`)
</script>

<template>
  <div class="ui-grid uov" :class="{ 'is-busy': busy }" :aria-busy="busy || undefined">
    <UsageState
      v-if="state === 'error' || state === 'forbidden' || state === 'empty'"
      class="c-12"
      :state="state"
      :error="live.error.value"
      :empty-text="emptyText"
      :action-label="filter.days < 90 ? '看近 90 天' : undefined"
      @retry="live.refresh"
      @action="widen"
    />

    <template v-else>
      <section class="c-12 uov-ledger" aria-label="汇总">
        <p class="uov-ledger__meta">
          <span>{{ windowText }}</span>
          <span v-if="data" class="num">{{ windowSpan(data.window) }}</span>
          <span v-if="data && !previous">前 {{ data.window.days === 1 ? '24 小时' : `${data.window.days} 日` }}无记录 · 不比较</span>
          <span v-if="state === 'stale'" class="uov-ledger__stale">◇ 陈旧 <button type="button" class="ui-link" @click="live.refresh">重试</button></span>
        </p>
        <div class="uov-ledger__grid">
          <template v-if="ledger">
            <Readout
              v-for="c in cells"
              :key="c.key"
              :label="c.label"
              :value="c.value"
              :unit="c.unit"
              :roll="c.roll ?? true"
              :delta="c.delta"
              :history="c.history"
              :state="state === 'stale' ? 'stale' : 'ready'"
            >
              <template v-if="c.key === 'cost' && ledger.hasPartialCost" #sub><span class="uov-sub" :title="ledger.unpricedModels.join(' · ')">{{ c.sub }}</span></template>
              <template v-else-if="c.sub" #sub><span class="uov-sub">{{ c.sub }}</span></template>
            </Readout>
          </template>
          <template v-else>
            <Readout v-for="k in ['请求', 'Token', '花费', '失败率', '缓存命中', '活跃 Key']" :key="k" :label="k" :value="null" state="loading" />
          </template>
        </div>
      </section>

      <Plate :title="heatTitle" class="c-12 uov-heat stretch" :state="heatState" :error="daily.error.value" :stale-at="daily.lastAt.value" :rows="7" @retry="daily.refresh">
        <template #actions>
          <HeatYears v-if="series" v-model="heatYear" :years="series.years" />
          <Segmented :items="HEAT_ITEMS" label="热力图指标" :model-value="heatMetric" @update:model-value="scope.patch({ heat: String($event ?? 'tokens') })" />
        </template>
        <Heatmap :series="series" :metric="heatMetric" :approx="heatApprox" :day-link="dayLink" span-action="按这段时间查看" @apply="applySpan" />
      </Plate>

      <Plate title="Token 构成" class="c-4 md-c-6 uov-mixp stretch" :state="plateState" :stale-at="live.lastAt.value" @retry="live.refresh">
        <template #meta><span>{{ windowText }}</span></template>
        <div v-if="data" class="uov-mix">
          <div class="uov-mix__bar" role="img" :aria-label="mixRows.map((row) => `${row.label} ${row.share === null ? NONE : fmtPct(row.share)}`).join('，')">
            <i v-for="row in mixRows.filter((r) => r.value > 0)" :key="row.key" :class="row.tone" :style="{ flexGrow: row.value }" />
          </div>
          <dl class="uov-mix__rows">
            <template v-for="row in mixRows" :key="row.key">
              <dt><i :class="row.tone" aria-hidden="true" />{{ row.label }}</dt>
              <dd class="num">{{ fmtCompact(row.value) }}</dd>
              <dd class="num dim">{{ row.share === null ? NONE : fmtPct(row.share) }}</dd>
            </template>
          </dl>
          <dl class="uov-mix__facts">
            <div>
              <dt>缓存净节省</dt>
              <dd class="num">{{ data.mix.cacheSavingsUsd === null ? NONE : fmtUsd(data.mix.cacheSavingsUsd, { approx: true }) }}</dd>
            </div>
            <div>
              <dt>推理 Token</dt>
              <dd class="num">{{ fmtCompact(data.mix.reasoning) }}</dd>
            </div>
          </dl>
        </div>
      </Plate>

      <Plate title="按模型" class="c-4 md-c-6" :state="plateState" :stale-at="live.lastAt.value" @retry="live.refresh">
        <template #meta><span>Token · 份额</span></template>
        <RankList :rows="modelRows" selectable empty-text="— 没有请求" @select="(row) => pick('model', row)" />
      </Plate>

      <Plate title="按 Key" class="c-4 md-c-6" :state="plateState" :stale-at="live.lastAt.value" @retry="live.refresh">
        <template #meta><span>{{ keysByCost ? (approx ? '花费 ≈' : '花费') : '请求' }} · 份额</span></template>
        <RankList :rows="keyRows" :format="keysByCost ? costFormat : fmtInt" selectable empty-text="— 没有请求" @select="(row) => pick('keyId', row)" />
      </Plate>

      <Plate title="按渠道" class="c-4 md-c-6" :state="plateState" :stale-at="live.lastAt.value" @retry="live.refresh">
        <template #meta><span>请求 · 份额</span></template>
        <RankList :rows="channelRows" :format="fmtInt" selectable empty-text="— 没有请求" @select="(row) => pick('provider', row)" />
      </Plate>

      <Plate title="按客户端" class="c-4 md-c-6 uov-half" :state="plateState" :stale-at="live.lastAt.value" @retry="live.refresh">
        <template #meta><span>请求 · 份额</span></template>
        <RankList :rows="clientRows" :format="fmtInt" selectable empty-text="— 没有请求" @select="(row) => pick('client', row)" />
      </Plate>

      <Plate title="失败构成" class="c-4 md-c-6 uov-half" :state="plateState" :stale-at="live.lastAt.value" @retry="live.refresh">
        <template #meta><span>{{ ledger ? `${fmtInt(ledger.errors)} 次` : '' }}</span></template>
        <ol v-if="failures.length" class="uov-fail">
          <li v-for="f in failures" :key="f.category">
            <RouterLink :to="f.to" class="uov-fail__n">
              <span class="uov-fail__code num">{{ f.codes || '—' }}</span>
              <span class="ellip">{{ f.label }}</span>
            </RouterLink>
            <span class="uov-fail__bar" aria-hidden="true"><b :style="{ transform: `scaleX(${f.bar})` }" /></span>
            <span class="num">{{ fmtInt(f.count) }}</span>
            <span class="uov-fail__o">{{ f.owner }}</span>
          </li>
        </ol>
        <p v-else class="uov-none">— {{ windowText }}没有失败</p>
      </Plate>
    </template>
  </div>
</template>

<style>
.uov { transition: opacity var(--dur-2) linear; }
.uov.is-busy { opacity: .62; }
html[data-motion="reduce"] .uov { transition: none; }

.uov-ledger { display: grid; gap: 4px; }
.uov-ledger__meta { display: flex; flex-wrap: wrap; gap: 2px 14px; margin: 0; font-size: var(--fs-xs); color: var(--ink-3); }
.uov-ledger__stale { color: var(--ink-2); }
.uov-ledger__stale .ui-link { font-size: var(--fs-xs); }
/* six readouts on the paper: spacing separates them, no hairline between every cell */
.uov-ledger__grid { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 14px 28px; padding: 8px 0 4px; }
.uov-ledger__grid > .ui-ro { align-content: start; }
.uov-ledger .ui-ro__d { white-space: normal; overflow: visible; }
.uov-sub { display: block; margin-top: 2px; font-family: var(--font-sans); color: var(--ink-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

/* RankList's selectable names reset all styles on the button, which drops the ellipsis: long model ids wrapped */
.uov .ui-rank__btn { display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

/* token mix: solid tonal steps of ink (no textures), spacing instead of hairlines */
.uov-t1 { background: var(--ink); }
.uov-t2 { background: color-mix(in oklab, var(--ink) 62%, var(--paper-3)); }
.uov-t3 { background: color-mix(in oklab, var(--ink) 36%, var(--paper-3)); }
.uov-t4 { background: color-mix(in oklab, var(--ink) 16%, var(--paper-3)); }
.uov-mix { display: grid; gap: 14px; padding-top: 12px; }
.uov-mix__bar { display: flex; gap: 2px; height: 10px; background: var(--paper-3); border-radius: 2px; overflow: hidden; }
.uov-mix__bar i { display: block; flex: 1 1 0; min-width: 2px; }
.uov-mix__rows { display: grid; grid-template-columns: minmax(0, 1fr) auto 6ch; gap: 8px 12px; margin: 0; font-size: var(--fs-sm); }
.uov-mix__rows > * { margin: 0; }
.uov-mix__rows dt { display: flex; align-items: center; gap: 8px; min-width: 0; color: var(--ink); }
.uov-mix__rows dt i { width: 10px; height: 10px; flex: none; border-radius: 2px; }
.uov-mix__rows dd { text-align: right; }
.uov-mix__facts { display: flex; flex-wrap: wrap; gap: 8px 24px; margin: 0; }
.uov-mix__facts dt { font-size: var(--fs-xs); color: var(--ink-3); }
.uov-mix__facts dd { margin: 2px 0 0; font-family: var(--font-mono); font-size: var(--fs-md); font-variant-numeric: tabular-nums; color: var(--ink); }

.uov-fail { margin: 0; padding: 0; list-style: none; }
.uov-fail li { display: grid; grid-template-columns: minmax(0, 1fr) minmax(32px, 18%) auto 6ch; align-items: center; gap: 0 10px; min-height: 34px; border-bottom: 1px solid var(--rule); font-size: var(--fs-sm); }
.uov-fail__n { display: flex; align-items: baseline; gap: 8px; min-width: 0; color: var(--ink); text-decoration: none; }
.uov-fail__n:hover .ellip { text-decoration: underline; text-underline-offset: 3px; }
.uov-fail__code { flex: none; font-size: var(--fs-xs); color: var(--ink-2); }
.uov-fail__bar { height: 3px; background: var(--paper-3); overflow: hidden; }
.uov-fail__bar b { display: block; height: 100%; background: var(--ink-2); transform-origin: left; }
.uov-fail__o { text-align: right; font-size: var(--fs-xs); color: var(--ink-3); white-space: nowrap; }
.uov-none { margin: 0; padding: 8px 0; font-size: var(--fs-sm); color: var(--ink-3); }

/* ≥1280: a year of weeks needs ~9/12 of the row at ≥13px cells, so the graph and the token mix share one row at
   equal height (nothing empty under either); below that the graph runs full width and the mix joins the ranks */
@media (min-width: 1280px) {
  .uov > .uov-heat { grid-column: span 9 !important; }
  .uov > .uov-mixp { grid-column: span 3 !important; }
  .uov > .uov-half { grid-column: span 6 !important; }
}
/* the 7-day bars only where a ledger cell is wide enough to hold them next to the value */
@media (min-width: 1180px) and (max-width: 1439px), (max-width: 959px) {
  .uov-ledger .ui-ro__hist { display: none; }
}
@media (min-width: 600px) and (max-width: 1179px) {
  .uov-ledger__grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
}
@media (max-width: 599px) {
  .uov-ledger__grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px 16px; }
  .uov-ledger .ui-ro__hist { display: none; }
  .uov-fail li { grid-template-columns: minmax(0, 1fr) auto 6ch; border-bottom: 0; }
  .uov-fail__bar { grid-column: 1 / -1; grid-row: 2; margin-bottom: 6px; }
}
</style>
