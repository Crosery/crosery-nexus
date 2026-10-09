<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import Plate from '../../ui/data/Plate.vue'
import RowTable from '../../ui/data/RowTable.vue'
import StatusMark from '../../ui/data/StatusMark.vue'
import Readout from '../../ui/viz/Readout.vue'
import Scope from '../../ui/viz/Scope.vue'
import TickStrip from '../../ui/viz/TickStrip.vue'
import Segmented from '../../ui/form/Segmented.vue'
import { useBreakpoint } from '../../ui/composables/useBreakpoint'
import { clockParts, fmtDuration, fmtInt, fmtNum, fmtPct, NONE } from '../../ui/fmt'
import type { DataState, RowColumn, SegmentItem } from '../../ui/types'
import type { PulseData } from '../../types'
import type { ChannelHealthRow } from './model'
import type { OverviewPayload, ScopeRange } from './types'

/**
 * 网关 (DESIGN §6.2): four readouts, the scope (req/min trace + error rug + separate P95 strip) and
 * channel health with 3h tick strips. 实时 draws /api/pulse (90 × 1 s); 1h · 6h · 24h draw /api/overview.
 * `请求/分` is always the pulse's 5-minute rate — the same figure as the statusline, so they never disagree.
 * The range switch in the head names the window once; a readout repeats a window only when it differs from it.
 */
const props = defineProps<{
  range: ScopeRange
  /** false until /api/overview answers (or after a 404 on an un-restarted server): only 实时 is offered */
  rangesAvailable: boolean
  overview: OverviewPayload | null
  pulse: PulseData | null
  state: DataState
  error?: unknown
  staleAt?: number | null
  health: ChannelHealthRow[]
  healthState: 'ready' | 'pending' | 'missing'
  kernel: string | null
  enabledKeys: number | null
}>()
const emit = defineEmits<{ 'update:range': [ScopeRange]; retry: [] }>()

const { width, isCompact } = useBreakpoint()

const rangeItems = computed<SegmentItem[]>(() => [
  { value: 'live', label: '实时' },
  { value: '1h', label: '1h', disabled: !props.rangesAvailable },
  { value: '6h', label: '6h', disabled: !props.rangesAvailable },
  { value: '24h', label: '24h', disabled: !props.rangesAvailable },
])
const rangeModel = computed({
  get: () => props.range,
  set: (value) => emit('update:range', value as ScopeRange),
})

const live = computed(() => props.range === 'live' || !props.overview)
const windowWord = computed(() => (live.value ? '近 5 分钟' : `近 ${props.range}`))

const scope = computed(() => {
  if (live.value) {
    const samples = props.pulse?.samples ?? []
    return {
      rpm: samples.map((s) => s.rps * 60),
      err: samples.map((s) => s.err),
      p95: null,
      from: '−90s',
      unit: 's',
      label: '网关近 90 秒每秒请求（按分钟折算）与错误',
    }
  }
  const o = props.overview!
  const perMin = o.bucketMs / 60_000
  return {
    rpm: o.gateway.series.requests.map((n) => n / perMin),
    err: o.gateway.series.errors,
    p95: o.gateway.series.p95Ms,
    from: `−${o.range}`,
    unit: o.bucketMs >= 3_600_000 ? 'h' : 'm',
    label: `网关近 ${o.range} 每分钟请求、错误与 P95 延迟`,
  }
})

const hhmm = (at: number | string) => {
  const p = clockParts(at)
  return p ? `${p.hour}:${p.minute}` : NONE
}
const g = computed(() => props.overview?.gateway ?? null)
const readouts = computed(() => {
  const p = props.pulse
  const gw = live.value ? null : g.value
  const peak = gw?.peak
  return [
    {
      key: 'rpm', label: '请求/分',
      value: p?.rpm ?? null,
      format: (v: string | number) => fmtNum(Number(v), 1),
      // always the pulse's 5-minute rate, whatever the range; the peak sits inside the ≤24h range (hh:mm is enough)
      sub: peak ? `近 5 分钟 · 峰值 ${fmtNum(peak.rpm, 1)} @${hhmm(peak.at)}` : '近 5 分钟',
    },
    {
      key: 'ok', label: '成功率',
      value: gw ? (gw.successRate === null ? null : fmtPct(gw.successRate, 2)) : p?.successRate == null ? null : fmtPct(p.successRate, 2),
      sub: gw ? `错误 ${fmtInt(gw.errors)} / ${fmtInt(gw.requests)}` : windowWord.value,
    },
    {
      // P95 is the figure; P50 and time-to-first-token sit under it (two durations on one 26px line overflow a 200px cell)
      key: 'lat', label: '延迟 P95',
      value: gw ? (gw.p95Ms === null ? null : fmtDuration(gw.p95Ms)) : p?.p95Ms == null ? null : fmtDuration(p.p95Ms),
      sub: gw
        ? [gw.p50Ms !== null ? `P50 ${fmtDuration(gw.p50Ms)}` : null, gw.ttftP50Ms !== null ? `首字 ${fmtDuration(gw.ttftP50Ms)}` : null].filter(Boolean).join(' · ') || null
        : windowWord.value,
    },
    {
      // 实时 still counts 活跃 Key over the 1h payload: say so, since it differs from the 5-minute range
      key: 'keys', label: '活跃 Key',
      value: g.value ? g.value.activeKeys : null,
      sub: [g.value ? (live.value ? '近 1h' : null) : '重启后可用', props.enabledKeys !== null ? `已启用 ${props.enabledKeys}` : null].filter(Boolean).join(' · ') || null,
    },
  ]
})

const scopeH = computed(() => (isCompact.value ? 96 : 120))
/** md (960–1179): 4 channel rows; 390: 18 ticks (90 min). */
const healthRows = computed(() => props.health.slice(0, width.value >= 960 && width.value < 1180 ? 4 : 5))
/** rows cut by the cap are named, never dropped silently */
const hiddenRows = computed(() => Math.max(0, props.health.length - healthRows.value.length))
const tickCount = computed(() => (isCompact.value ? 18 : 36))
const errWord = (r: ChannelHealthRow) => (r.errRate === null ? NONE : fmtPct(r.errRate))
const spanWord = computed(() => (isCompact.value ? '近 90 分钟' : '近 3 小时'))
const healthColumns = computed<RowColumn<ChannelHealthRow>[]>(() => [
  { key: 'name', title: '渠道', minWidth: 96 },
  { key: 'state', title: '状态', width: 96 },
  { key: 'p95', title: 'P95', width: 68, align: 'right' },
  { key: 'err', title: '错误', width: 60, align: 'right' },
  { key: 'span', title: spanWord.value, width: 4 * tickCount.value + 16, align: 'right' },
])
const healthTone = (r: ChannelHealthRow) => (r.state === 'off' ? 'off' : null)
const healthEmpty = computed(() => (props.healthState === 'missing' ? '渠道健康重启后可用' : '没有渠道'))
</script>

<template>
  <Plate title="网关" class="ov-gw" :state="state" :error="error" :stale-at="staleAt" :rows="6" @retry="emit('retry')">
    <template #meta>
      <span v-if="kernel" class="num">{{ kernel }}</span>
    </template>
    <template #actions>
      <Segmented v-model="rangeModel" :items="rangeItems" label="网关时间范围" />
    </template>

    <div class="ov-gw__ro">
      <Readout
        v-for="r in readouts"
        :key="r.key"
        :label="r.label"
        :value="r.value"
        :format="r.format"
        :live="r.key === 'rpm'"
        :state="state === 'stale' ? 'stale' : 'ready'"
      >
        <template v-if="r.sub" #sub><span class="ov-gw__sub">{{ r.sub }}</span></template>
      </Readout>
    </div>

    <Scope
      class="ov-gw__scope"
      :rpm="scope.rpm"
      :err="scope.err"
      :p95="scope.p95"
      :from-label="scope.from"
      :unit="scope.unit"
      :h="scopeH"
      :stale="state === 'stale'"
      :label="scope.label"
    />

    <RowTable
      class="ov-ch"
      :columns="healthColumns"
      :data="healthRows"
      row-key="key"
      density="dense"
      :row-tone="healthTone"
      :empty-text="healthEmpty"
      :caption="`渠道健康 · ${spanWord}`"
    >
      <template #cell-name="{ row }"><RouterLink :to="row.to" class="ov-ch__link num">{{ row.name }}</RouterLink></template>
      <template #cell-state="{ row }"><StatusMark :state="row.state" :label="row.stateLabel" /></template>
      <template #cell-p95="{ row }"><span class="num">{{ fmtDuration(row.p95Ms) }}</span></template>
      <template #cell-err="{ row }"><span class="num" :class="{ sig: row.hot }">{{ errWord(row) }}</span></template>
      <template #cell-span="{ row }">
        <TickStrip class="ov-ch__ticks" :ticks="row.ticks.slice(-tickCount)" :bad="row.bad.slice(-tickCount)" :label="`${row.name} 近 3 小时每 5 分钟：${fmtInt(row.requests)} 次请求，${fmtInt(row.errors)} 次错误`" />
      </template>

      <template #card="{ row }">
        <div class="ui-rcard__l1">
          <span class="ui-rcard__primary"><RouterLink :to="row.to" class="ov-ch__link num">{{ row.name }}</RouterLink></span>
          <span class="ui-rcard__meta" :class="{ sig: row.hot }">错误 {{ errWord(row) }}</span>
        </div>
        <div class="ui-rcard__ln ov-ch__cardln">
          <StatusMark :state="row.state" :label="row.stateLabel" />
          <TickStrip :ticks="row.ticks.slice(-tickCount)" :bad="row.bad.slice(-tickCount)" :label="`${row.name} ${spanWord}每 5 分钟：${fmtInt(row.requests)} 次请求，${fmtInt(row.errors)} 次错误`" />
        </div>
      </template>
    </RowTable>
    <p v-if="hiddenRows > 0" class="ov-ch__more"><RouterLink to="/channels" class="ui-link">其余 {{ hiddenRows }} 个渠道 →</RouterLink></p>
  </Plate>
</template>

<style>
/* four readouts in one row (2 × 2 below 1180); spacing separates them, no cell rules */
.ov-gw__ro { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px 24px; padding: 4px 0 2px; }
.ov-gw__ro > .ui-ro { align-content: start; }
.ov-gw__ro > .ui-ro:first-child .ui-ro__v { font-size: var(--fs-2xl); }
.ov-gw__sub { font-family: var(--font-sans); color: var(--ink-3); }
.ov-gw__scope { margin-top: 14px; }
.ov-ch { margin-top: 10px; }
.ov-ch__link { color: inherit; text-decoration: none; font-size: var(--fs-sm); }
.ov-ch .tx-data-table__row:not(.is-off) .ov-ch__link, .ov-ch .ui-rcard:not(.is-off) .ov-ch__link { color: var(--ink); }
.ov-ch__link:hover { text-decoration: underline; text-underline-offset: 3px; }
.ov-ch__ticks { margin-left: auto; }
.ov-ch__cardln { justify-content: space-between; }
.ov-ch__more { margin: 0; padding: 8px 0 0; font-size: var(--fs-xs); color: var(--ink-3); }
@media (max-width: 1179px) {
  .ov-gw__ro { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 599px) {
  .ov-gw__ro { gap: 12px 16px; }
  .ov-gw__ro > .ui-ro:first-child .ui-ro__v { font-size: var(--fs-xl); }
}
</style>
