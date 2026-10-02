<script setup lang="ts">
/**
 * Dual-source price for one model (task-78/79): the billing price next to what models.dev and OpenRouter quote,
 * each with its own fetch time, the source the billing price matches marked `✓ 采用`. A missing quote reads
 * 未收录, a missing billing price reads 未定价 — neither is ever `$0` (0 means 免费).
 * RowTable: a table in the sheet on desktop, one two-line card per source on a phone.
 */
import { computed } from 'vue'
import RowTable from '../../ui/data/RowTable.vue'
import { fmtTime } from '../../ui/fmt'
import { PRICE_SOURCE_KEYS, fmtUnitPrice, type ModelRow, type PriceSourceKey } from './modelRows'
import type { ModelIndexData } from '../../types'
import type { RowColumn } from '../../ui/types'

const props = defineProps<{
  row: ModelRow
  sourceStatus?: ModelIndexData['sourceStatus']
}>()

const LABEL: Record<PriceSourceKey, string> = { 'models.dev': 'models.dev', openrouter: 'OpenRouter' }
const FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite'] as const
type Field = (typeof FIELDS)[number]

type PriceLine = {
  key: string
  label: string
  /** null = this source has no quote / no billing price */
  cells: Record<Field, string> | null
  missing: string
  at: string | null
  adopted: boolean
  billing: boolean
}

const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)
const cell = (value: unknown) => {
  const n = num(value)
  return n === null ? '—' : n === 0 ? '免费' : fmtUnitPrice(n)
}
const cellsOf = (quote: Partial<Record<Field, unknown>> | null | undefined) =>
  quote ? (Object.fromEntries(FIELDS.map((field) => [field, cell(quote[field])])) as Record<Field, string>) : null

const adopted = computed(() => (props.row.price.kind === 'billing' ? props.row.price.source : null))

const lines = computed<PriceLine[]>(() => [
  {
    key: 'billing',
    label: '计费',
    cells: cellsOf(props.row.billing),
    missing: '未定价',
    at: props.row.billing && !adopted.value ? '价表' : null,
    adopted: false,
    billing: true,
  },
  ...PRICE_SOURCE_KEYS.map((key) => {
    const quote = props.row.sources[key]
    return {
      key,
      label: LABEL[key],
      cells: cellsOf(quote),
      missing: '未收录',
      at: num(quote?.fetchedAt) ? fmtTime(quote!.fetchedAt as number) : null,
      adopted: adopted.value === key,
      billing: false,
    }
  }),
])

const columns: RowColumn<PriceLine>[] = [
  { key: 'label', title: '来源', minWidth: 120 },
  { key: 'input', title: '输入', width: 72, align: 'right' },
  { key: 'output', title: '输出', width: 72, align: 'right' },
  { key: 'cacheRead', title: '缓存读', width: 72, align: 'right' },
  { key: 'cacheWrite', title: '缓存写', width: 72, align: 'right' },
  { key: 'at', title: '抓取', width: 60, align: 'right' },
]
const rowTone = (line: PriceLine) => (line.cells ? null : 'off')

/** Two quotes for the same model: say how far apart they are so nobody has to do the arithmetic. */
const spread = computed(() => {
  const a = num(props.row.sources['models.dev']?.input)
  const b = num(props.row.sources.openrouter?.input)
  if (a === null || b === null || a === b) return null
  const ratio = Math.abs(a - b) / Math.max(a, b)
  if (ratio < 0.01) return null
  return `两源输入价差 ${(ratio * 100).toFixed(1)}% · ${a < b ? 'models.dev' : 'OpenRouter'} 更低`
})

const REASONS: Record<string, string> = {
  'shared-pricing-not-loaded': '价格源尚未加载',
  'shared-pricing-missing': '共享目录缺价格段',
  'shared-pricing-empty': '共享目录价格为空',
}
const degraded = computed(() => {
  const status = props.sourceStatus
  if (!status) return null
  const failed = PRICE_SOURCE_KEYS.filter((key) => status.sources?.[key]?.ok === false)
  if (failed.length) return `${failed.map((key) => LABEL[key]).join('、')} 本次取不到 · 下面可能是旧值`
  const reasons = (status.degraded ?? []).filter((reason) => !reason.startsWith('source-unavailable'))
  return reasons.length ? `${reasons.map((reason) => REASONS[reason] ?? reason).join('、')} · 双源数据不完整` : null
})
</script>

<template>
  <div class="mps">
    <RowTable
      :columns="columns"
      :data="lines"
      row-key="key"
      density="dense"
      :row-tone="rowTone"
      :sort-on-client="false"
      :caption="`${row.id} 每百万 token 单价`"
    >
      <template #cell-label="{ row: line }">
        <span class="mps__src" :class="{ 'is-bill': line.billing, 'is-miss': !line.cells }">{{ line.label }}</span>
        <span v-if="line.adopted" class="mps__mark">✓ 采用</span>
        <span v-else-if="!line.cells" class="mps__mark">{{ line.missing }}</span>
      </template>
      <template v-for="field in FIELDS" :key="field" #[`cell-${field}`]="{ row: line }">
        <span class="num" :class="{ 'is-bill': line.billing }">{{ line.cells ? line.cells[field] : '—' }}</span>
      </template>
      <template #cell-at="{ row: line }">
        <span class="num mps__at">{{ line.at ?? '' }}</span>
      </template>

      <template #card="{ row: line }">
        <div class="mps__card">
          <span class="mps__src" :class="{ 'is-bill': line.billing, 'is-miss': !line.cells }">{{ line.label }}</span>
          <span v-if="line.adopted" class="mps__mark">✓ 采用</span>
          <span class="mps__io num" :class="{ 'is-bill': line.billing && line.cells }">{{ line.cells ? `${line.cells.input} / ${line.cells.output}` : line.missing }}</span>
        </div>
        <div v-if="line.cells" class="mps__card2 num">
          <span>缓存读 {{ line.cells.cacheRead }}</span>
          <span>缓存写 {{ line.cells.cacheWrite }}</span>
          <span v-if="line.at">抓取 {{ line.at }}</span>
        </div>
      </template>
    </RowTable>
    <p class="mps__foot">
      <span>$ / 百万 token · — 未收录</span>
      <span v-if="spread">{{ spread }}</span>
      <span v-if="degraded" class="mps__warn">◇ {{ degraded }}</span>
    </p>
  </div>
</template>

<style scoped>
.mps { display: grid; gap: 6px; min-width: 0; }
.mps__src { color: var(--ink); }
.is-bill { font-weight: 600; }
.mps__mark { margin-left: 8px; font-size: var(--fs-xs); color: var(--ink-3); }
.mps__at { color: var(--ink-3); font-size: var(--fs-xs); }
.mps__card { display: flex; align-items: baseline; gap: 0; min-width: 0; font-size: var(--fs-sm); }
.mps__io { margin-left: auto; padding-left: 12px; white-space: nowrap; color: var(--ink); }
.mps__card2 { display: flex; flex-wrap: wrap; gap: 2px 0; font-size: var(--fs-xs); color: var(--ink-3); }
.mps__card2 > span + span::before { content: "·"; margin: 0 6px; color: var(--ink-4); }
.mps__foot { display: flex; flex-wrap: wrap; gap: 2px 14px; margin: 0; font-size: var(--fs-xs); color: var(--ink-3); }
.mps__warn { color: var(--ink-2); }
.mps__src.is-miss { color: var(--ink-3); }
:deep(.ui-rcard) { min-height: 0; padding: 8px 0; }
</style>
