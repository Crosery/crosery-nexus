<script setup lang="ts">
import { computed, useTemplateRef, watch } from 'vue'
import { RouterLink, RouterView, useRoute, useRouter } from 'vue-router'
import FilterBar from '../../ui/form/FilterBar.vue'
import Switch from '../../ui/form/Switch.vue'
import { useIndicator } from '../../ui/composables/useIndicator'
import { useLive } from '../../ui/composables/useLive'
import { fmtInt, fmtPct } from '../../ui/fmt'
import { useQueryState } from '../../lib/listState'
import { USAGE_TABS } from '../../app/nav'
import type { FilterBarField, SegmentItem } from '../../ui/types'
import { isCurrentOnly, sharedUsageQuery, spanLabel, USAGE_DAYS, USAGE_FILTER_DEFAULTS, USAGE_RANGE_ITEMS, usageFilterFrom } from './filters'
import { api } from './shared/api'
import { isPendingRestart } from './shared/format'
import type { UsageFacetOption } from './shared/types'

/**
 * 用量 workspace (DESIGN §6.7): the tab row is the page head (live metrics on the labels), and ONE FilterBar under it owns the shared URL filters (window · Key · 模型 · 渠道 · 客户端) for all
 * four tabs, with the same defaults everywhere (filters.ts). A tab switch carries the shared keys and drops
 * tab-local state (page, status, open request).
 * Channel scope: every tab counts ALL traffic by default — channels removed since then included (history is
 * history; spend is spend), so /usage, /keys, the dashboard and /me agree for one Key. 「只看当前渠道」 is the
 * opt-in `currentOnly=1`, shared by the four tabs.
 */
const route = useRoute()
const router = useRouter()
const carried = computed(() => sharedUsageQuery(route.query))
const activeId = computed(() => (typeof route.name === 'string' ? route.name : 'usage'))

// Old `/cache?hours=24` links: the window is `days` now (the server snaps to 24h / 7d / 30d / 90d the same way).
if (typeof route.query.hours === 'string' && route.query.hours && !route.query.days) {
  const hours = Number(route.query.hours)
  const days = USAGE_DAYS.find((d) => d * 24 >= hours) ?? USAGE_DAYS[USAGE_DAYS.length - 1]
  const { hours: _hours, ...rest } = route.query
  void router.replace({ query: { ...rest, ...(String(days) === USAGE_FILTER_DEFAULTS.days ? {} : { days: String(days) }) } })
}

const scope = useQueryState(USAGE_FILTER_DEFAULTS)
const filter = computed(() => usageFilterFrom(scope.state))

const facets = useLive((signal) => api.facets(filter.value, signal), { intervalMs: 60_000 })
watch(
  [() => scope.state.days, () => scope.state.from, () => scope.state.to, () => scope.state.keyId, () => scope.state.model, () => scope.state.provider, () => scope.state.client, () => scope.state.currentOnly],
  () => void facets.refresh(),
)

/*
 * Custom window (from / to, set from the heatmap's 「按这段时间查看」): the range control becomes one chip
 * `9/01 → 9/28 ×`; × drops the span (and the tab's page) and the `days` window that was there comes back.
 * Tabs are keyed on the span so every tab reads the new window at once, whatever keys it watches.
 */
const span = computed(() => (filter.value.from && filter.value.to ? { from: filter.value.from, to: filter.value.to } : null))
const spanText = computed(() => (span.value ? spanLabel(span.value) : ''))
const spanKey = computed(() => (span.value ? `${span.value.from}~${span.value.to}` : ''))
function clearSpan() {
  const { from: _from, to: _to, page: _page, ...rest } = route.query
  void router.replace({ query: rest })
}
const currentOnly = computed({
  get: () => isCurrentOnly(scope.state.currentOnly),
  set: (on: boolean) => scope.patch({ currentOnly: on ? '1' : '' }),
})

const data = computed(() => facets.data.value ?? null)

function withSelected(options: UsageFacetOption[], selected: string, label: (value: string) => string): SegmentItem[] {
  const items: SegmentItem[] = options.map((o) => ({ value: o.value, label: o.removed ? `${o.label} · 已移除` : o.current === false ? `${o.label} · 停用` : o.label, count: o.count }))
  if (selected && !items.some((o) => o.value === selected)) items.unshift({ value: selected, label: label(selected) })
  return items
}
const fields = computed<FilterBarField[]>(() => [
  { key: 'keyId', label: 'Key', options: withSelected(data.value?.keys ?? [], scope.state.keyId, (v) => `${v.slice(0, 8)}…`) },
  { key: 'model', label: '模型', options: withSelected(data.value?.models ?? [], scope.state.model, (v) => v) },
  { key: 'provider', label: '渠道', options: withSelected(data.value?.channels ?? [], scope.state.provider, (v) => v) },
  { key: 'client', label: '客户端', options: withSelected(data.value?.clients ?? [], scope.state.client, (v) => v) },
])
const range = { key: 'days', label: '时间范围', items: USAGE_RANGE_ITEMS, default: USAGE_FILTER_DEFAULTS.days }

const tabMetric = computed<Record<string, string>>(() => {
  const totals = data.value?.totals
  if (!totals) return {}
  return {
    'usage-requests': fmtInt(totals.requests),
    'usage-cache': totals.cacheHitRate === null ? '' : fmtPct(totals.cacheHitRate),
  }
})
/** Removed-channel traffic in the same window and filter: counted by default, left out under 只看当前渠道. */
const removed = computed(() => {
  const s = data.value?.scope
  if (!s) return null
  return s.kind === 'current' ? s.excluded : (s.removed ?? null)
})
const removedTitle = computed(() => (removed.value?.channels ?? []).map((c) => `${c.label} ${fmtInt(c.requests)}`).join(' · '))
const unpriced = computed(() => data.value?.totals.unpricedModels.length ?? 0)
const facetsPending = computed(() => facets.state.value === 'error' && isPendingRestart(facets.error.value))

const host = useTemplateRef<HTMLElement>('host')
const ind = useTemplateRef<HTMLElement>('ind')
useIndicator(host, ind, '.usage-ws__tab.is-active', [activeId, tabMetric], 2)
</script>

<template>
  <div class="ui-page usage-ws">
    <header class="usage-ws__head">
      <h1 class="sr-only">用量</h1>
      <nav ref="host" class="usage-ws__tabs" aria-label="用量视图">
        <RouterLink
          v-for="tab in USAGE_TABS"
          :key="tab.id"
          :to="{ path: tab.to, query: carried }"
          class="usage-ws__tab"
          :class="{ 'is-active': tab.id === activeId }"
          :aria-current="tab.id === activeId ? 'page' : undefined"
        >{{ tab.label }}<span v-if="tabMetric[tab.id]" class="usage-ws__m">{{ tabMetric[tab.id] }}</span></RouterLink>
        <span ref="ind" class="ui-ind" aria-hidden="true" />
      </nav>
    </header>

    <div class="usage-ws__barrow">
    <span v-if="span" class="usage-ws__span">
      <span class="sr-only">时间范围</span>
      <span class="num">{{ spanText }}</span>
      <button type="button" class="usage-ws__span-x" :aria-label="`清除时间范围 ${spanText}`" title="清除，回到滚动窗口" @click="clearSpan">×</button>
    </span>
    <FilterBar :key="span ? 'span' : 'days'" class="usage-ws__bar" :range="span ? null : range" :fields="fields">
      <template #extra>
        <span v-if="facetsPending">筛选计数待重启生效</span>
        <template v-else-if="data">
          <span v-if="removed && removed.requests > 0" :title="removedTitle">{{ data.scope.kind === 'current' ? '未含' : '含' }}已移除渠道 {{ fmtInt(removed.requests) }} 次</span>
          <span v-if="unpriced > 0" :title="data.totals.unpricedModels.join(' · ')">未定价 {{ unpriced }} 个模型不计入</span>
        </template>
        <Switch v-model="currentOnly" class="usage-ws__scope" label="只看当前渠道" />
      </template>
    </FilterBar>
    </div>

    <RouterView v-slot="{ Component }">
      <component :is="Component" :key="spanKey" />
    </RouterView>
  </div>
</template>

<style>
.usage-ws { gap: 18px; }
.usage-ws__head { position: relative; display: flex; align-items: flex-end; justify-content: space-between; gap: 12px; border-bottom: 1px solid var(--rule-2); }
.usage-ws__tabs { position: relative; display: flex; flex-wrap: wrap; gap: 0 22px; min-width: 0; }
.usage-ws__tab {
  display: inline-flex; align-items: baseline; gap: 7px; height: 44px; line-height: 44px; padding: 0 2px;
  font-size: 15px; color: var(--ink-2); text-decoration: none; white-space: nowrap;
}
.usage-ws__tab:hover { color: var(--ink); }
.usage-ws__tab.is-active { color: var(--ink); font-weight: 650; }
.usage-ws__tab:focus-visible { outline: 2px solid var(--signal); outline-offset: -6px; }
.usage-ws__m { font-family: var(--font-mono); font-variant-numeric: tabular-nums; font-size: var(--fs-xs); font-weight: 400; color: var(--ink-3); }
.usage-ws__bar { padding-bottom: 2px; }
.usage-ws__barrow { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 10px; min-width: 0; }
.usage-ws__barrow > .usage-ws__bar { flex: 1 1 auto; }
.usage-ws__span {
  display: inline-flex; align-items: center; gap: 2px; height: var(--ctl-h); padding: 0 2px 0 10px; border-radius: var(--r-1);
  background: var(--ink); color: var(--paper); font-size: var(--fs-sm);
}
.usage-ws__span .num { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
.usage-ws__span-x {
  all: unset; box-sizing: border-box; display: inline-grid; place-items: center; width: 24px; height: 24px; border-radius: var(--r-1);
  cursor: pointer; font-size: 15px; line-height: 1; color: var(--paper);
}
.usage-ws__span-x:hover { background: color-mix(in oklab, var(--paper) 18%, transparent); }
.usage-ws__span-x:focus-visible { outline: 2px solid var(--signal); outline-offset: 1px; }
@media (pointer: coarse) { .usage-ws__span-x { width: 36px; height: 36px; } }
@media (max-width: 959px) {
  .usage-ws { gap: 14px; }
  .usage-ws__tabs { gap: 0 16px; }
  .usage-ws__tab { height: 42px; line-height: 42px; }
}
@media (max-width: 599px) {
  .usage-ws__tabs { justify-content: space-between; width: 100%; gap: 0 4px; }
  .usage-ws__m { display: none; }
}
</style>
