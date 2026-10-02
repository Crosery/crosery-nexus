<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import Plate from '../../ui/data/Plate.vue'
import RowTable from '../../ui/data/RowTable.vue'
import StatusMark from '../../ui/data/StatusMark.vue'
import TickMeter from '../../ui/viz/TickMeter.vue'
import MicroBars from '../../ui/viz/MicroBars.vue'
import { useBreakpoint } from '../../ui/composables/useBreakpoint'
import { fmtAgo, fmtInt, fmtSpend } from '../../ui/fmt'
import { useNow } from '../../ui/composables/useNow'
import type { DataState, RowColumn } from '../../ui/types'
import { tightWindow, type BurnRow } from './model'

/**
 * Key 消耗 (DESIGN §6.2): Keys ranked by quota pressure, then spend. Money is the Key quota ledger
 * (what the limits are enforced on); the 24h bars are every logged request of that Key, per hour.
 * One quota column shows the tightest limited window (日 / 周 / 总) — most Keys have no limit, and two
 * `不限` meters per row would repeat the same nothing (operator critique #7).
 */
const props = defineProps<{
  rows: BurnRow[]
  state: DataState
  error?: unknown
  staleAt?: number | null
  hoursAvailable: boolean
  /** the plate spans the whole row (no account plate beside it): room for 最近调用 and wider 24h bars */
  full?: boolean
}>()
const emit = defineEmits<{ retry: [] }>()
const router = useRouter()
const { width, isMobile } = useBreakpoint()
const now = useNow()

const limit = computed(() => (isMobile.value ? 5 : 8))
const shown = computed(() => props.rows.slice(0, limit.value))
const rest = computed(() => props.rows.slice(limit.value))
const restToday = computed(() => rest.value.reduce((s, r) => s + r.today.spent, 0))
const restWeek = computed(() => rest.value.reduce((s, r) => s + r.week.spent, 0))
const wide = computed(() => width.value >= 1180)

/** tightest limited window of 日 / 周 / 总, for the one meter (the same max that ranks the row) */
const tight = tightWindow

/** 24h bars: a bucket counts as failing only when ≥ 20% of its requests failed (one 429 in 500 is not red) */
function failing(row: BurnRow): number[] {
  return (row.hours ?? []).map((n, i) => (n > 0 && (row.hourErrors?.[i] ?? 0) / n >= 0.2 ? 1 : 0))
}

const columns = computed<RowColumn<BurnRow>[]>(() => [
  { key: 'name', title: 'Key', minWidth: 150 },
  { key: 'today', title: '今日', width: 84, align: 'right' },
  { key: 'week', title: '本周', width: 92, align: 'right' },
  { key: 'quota', title: '额度', width: 176 },
  ...(wide.value && props.hoursAvailable ? [{ key: 'h24', title: '24h', width: props.full ? 168 : 84 } as RowColumn<BurnRow>] : []),
  ...(wide.value && (props.full || !props.hoursAvailable) ? [{ key: 'last', title: '最近调用', width: 96, align: 'right' } as RowColumn<BurnRow>] : []),
  { key: 'state', title: '状态', width: 96 },
])
const rowTone = (row: BurnRow) => (row.exceeded ? 'attn' : !row.enabled ? 'off' : null)
const open = (row: BurnRow) => router.push(`/keys?q=${encodeURIComponent(row.name)}`)
</script>

<template>
  <Plate title="Key 消耗" class="ov-burn" :state="state" :error="error" :stale-at="staleAt" :rows="8" :cols="['1fr', '84px', '92px', '176px', '96px']" flush empty-text="还没有 Key" empty-action="新建 Key" @retry="emit('retry')" @empty-action="router.push('/keys?new=1')">
    <template #meta>
      <span>按额度压力 · 本周花费</span>
      <RouterLink to="/keys" class="ui-link">全部 {{ fmtInt(rows.length) }} 个 →</RouterLink>
    </template>

    <RowTable :columns="columns" :data="shown" row-key="id" density="dense" :row-tone="rowTone" caption="Key 消耗" @row-click="open">
      <template #cell-name="{ row }">
        <span class="ov-burn__key"><b class="num">{{ row.name }}</b><span class="num dim">{{ row.tail }}</span></span>
      </template>
      <template #cell-today="{ row }"><span class="num" :class="{ dim: !row.today.spent }">{{ fmtSpend(row.today.spent) }}</span></template>
      <template #cell-week="{ row }"><span class="num" :class="{ dim: !row.week.spent }">{{ fmtSpend(row.week.spent) }}</span></template>
      <template #cell-quota="{ row }">
        <TickMeter v-if="tight(row)" :value="tight(row)!.ratio" :label="tight(row)!.label" :width="84" :aria-label="`${row.name} ${tight(row)!.label}额度`" />
        <span v-else class="ov-burn__free">不限</span>
      </template>
      <template #cell-h24="{ row }">
        <MicroBars v-if="row.hours" :buckets="row.hours" :errors="failing(row)" :w="full ? 144 : 72" :h="16" :label="`${row.name} 近 24 小时每小时请求，共 ${fmtInt(row.requests24h)} 次`" />
      </template>
      <template #cell-last="{ row }"><span class="num dim">{{ row.lastUsedAt ? fmtAgo(row.lastUsedAt, now) : '从未' }}</span></template>
      <template #cell-state="{ row }"><StatusMark :state="row.state" :label="row.stateLabel" :live="row.live" /></template>

      <template #card="{ row }">
        <div class="ui-rcard__l1">
          <span class="ui-rcard__primary ov-burn__key"><b class="num">{{ row.name }}</b><span class="num dim">{{ row.tail }}</span></span>
          <span class="ui-rcard__meta num" :class="{ dim: !row.today.spent }">今日 {{ fmtSpend(row.today.spent) }}</span>
        </div>
        <!-- a meter line only for Keys with a limit; 不限 rides on the spend line instead of a line of its own -->
        <div v-if="tight(row)" class="ui-rcard__ln ov-burn__cardmeter">
          <TickMeter :value="tight(row)!.ratio" :label="tight(row)!.label" fluid :aria-label="`${row.name} ${tight(row)!.label}额度`" />
        </div>
        <div class="ui-rcard__ln">
          <span class="num dim">本周 {{ fmtSpend(row.week.spent) }}<template v-if="row.requests24h !== null"> · 24h {{ fmtInt(row.requests24h) }} 次</template><template v-if="!tight(row)"> · 不限额</template></span>
          <StatusMark :state="row.state" :label="row.stateLabel" :live="row.live" />
        </div>
      </template>
    </RowTable>

    <!-- the head already links to all Keys; the foot only sums the rows the cap left out -->
    <template v-if="rest.length" #footer>
      <span>其余 {{ rest.length }} 个 · 今日 <span class="num">{{ fmtSpend(restToday) }}</span> · 本周 <span class="num">{{ fmtSpend(restWeek) }}</span></span>
    </template>
  </Plate>
</template>

<style>
.ov-burn .ui-plate__foot { margin-top: 0; padding: 8px 0 10px; }
.ov-burn__key { display: inline-flex; align-items: baseline; gap: 8px; min-width: 0; max-width: 100%; }
.ov-burn__key b { font-weight: 500; color: var(--ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.ov-burn__key .dim { flex: none; font-size: var(--fs-xs); }
.ov-burn__free { font-size: var(--fs-xs); color: var(--ink-3); }
.ov-burn__cardmeter { display: block; }
.ov-burn .ui-rcard .ui-rcard__ln { justify-content: space-between; }
</style>
