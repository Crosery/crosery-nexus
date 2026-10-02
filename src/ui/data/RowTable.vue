<script setup lang="ts" generic="T extends Record<string, any>">
import { computed, getCurrentInstance, nextTick, onMounted, ref, watch } from 'vue'
import { TxDataTable } from '@talex-touch/tuffex/data-table'
import StateBlock from './StateBlock.vue'
import './rowcard.css'
import { useBreakpoint } from '../composables/useBreakpoint'
import { useQueryState } from '../../lib/listState'
import type { DataState, RowColumn, RowTone, SortState } from '../types'

/**
 * DataGrid (DESIGN.md §5.2 data/RowTable). Desktop: TxDataTable with hairline rows, sticky header, hover band.
 * Below `cardBelow` (default 960 = mobile chrome) the same columns render as row-cards driven by each column's
 * `card` role — so no table ever scrolls sideways on a phone.
 * Sorting happens here (client side) so table and cards agree; `sortQuery` binds it to the URL (?sort=key:desc).
 * Row tone: attn = 2px signal inset edge, cool = a quiet paper-2 fill + ink-2 text, off = ink-3 text.
 */
type Key = string | number

const props = withDefaults(
  defineProps<{
    columns: RowColumn<T>[]
    data: T[]
    rowKey?: string | ((row: T, index: number) => Key)
    state?: DataState
    error?: unknown
    emptyText?: string
    emptyAction?: string
    skeletonRows?: number
    density?: 'list' | 'dense' | 'two-line'
    expandable?: boolean
    expandedKeys?: Key[]
    rowExpandable?: (row: T, index: number) => boolean
    rowTone?: (row: T, index: number) => RowTone
    sort?: SortState | null
    defaultSort?: SortState | null
    /** URL query key for the sort (e.g. 'sort'); omit to keep sort in memory */
    sortQuery?: string
    sortOnClient?: boolean
    maxHeight?: number | string
    cardBelow?: number
    showHead?: boolean
    caption?: string
  }>(),
  {
    rowKey: 'id',
    state: 'ready',
    error: undefined,
    emptyText: '没有数据',
    emptyAction: undefined,
    skeletonRows: 6,
    density: 'list',
    expandable: false,
    expandedKeys: undefined,
    rowExpandable: undefined,
    rowTone: undefined,
    sort: undefined,
    defaultSort: null,
    sortQuery: undefined,
    sortOnClient: true,
    maxHeight: undefined,
    cardBelow: 960,
    showHead: true,
    caption: undefined,
  },
)

const emit = defineEmits<{
  (e: 'rowClick', row: T, index: number): void
  (e: 'update:sort', value: SortState | null): void
  (e: 'update:expandedKeys', value: Key[]): void
  (e: 'retry'): void
  (e: 'emptyAction'): void
}>()

defineSlots<Record<string, (props: any) => any>>()

const instance = getCurrentInstance()
const clickable = computed(() => Boolean(instance?.vnode.props?.onRowClick))

const { width } = useBreakpoint()
const asCards = computed(() => width.value < props.cardBelow)

/* ── sort: URL → prop → local ── */
const encode = (s: SortState | null | undefined) => (s && s.order ? `${s.key}:${s.order}` : '')
const decode = (raw: string): SortState | null => {
  const [key, order] = raw.split(':')
  return key && (order === 'asc' || order === 'desc') ? { key, order } : null
}
const query = props.sortQuery ? useQueryState({ [props.sortQuery]: encode(props.defaultSort) }) : null
const localSort = ref<SortState | null>(props.defaultSort ?? null)
const sortState = computed<SortState | null>(() => {
  if (query && props.sortQuery) return decode(query.state[props.sortQuery] ?? '')
  if (props.sort !== undefined) return props.sort
  return localSort.value
})
function onSort(next: SortState | null) {
  const value = next && next.order ? next : null
  if (query && props.sortQuery) query.patch({ [props.sortQuery]: encode(value) })
  localSort.value = value
  emit('update:sort', value)
}

function valueOf(row: T, col: RowColumn<T>): unknown {
  return row[(col.dataIndex ?? col.key) as keyof T]
}
function compare(a: unknown, b: unknown): number {
  if (a === b) return 0
  if (a === null || a === undefined) return 1
  if (b === null || b === undefined) return -1
  if (typeof a === 'number' && typeof b === 'number') return a - b
  return String(a).localeCompare(String(b), 'zh-CN', { numeric: true })
}
const rows = computed<T[]>(() => {
  const s = sortState.value
  if (!props.sortOnClient || !s || !s.order) return props.data
  const col = props.columns.find((c) => c.key === s.key)
  if (!col) return props.data
  const dir = s.order === 'desc' ? -1 : 1
  return [...props.data].sort((a, b) => {
    const base = col.sorter ? col.sorter(a, b) : compare(valueOf(a, col), valueOf(b, col))
    // nulls stay last in both directions: unknown is never "smallest"
    if (!col.sorter && (valueOf(a, col) == null || valueOf(b, col) == null)) return base
    return base * dir
  })
})

function keyOf(row: T, index: number): Key {
  return typeof props.rowKey === 'function' ? props.rowKey(row, index) : (row[props.rowKey as keyof T] as Key) ?? index
}
function cellText(row: T, col: RowColumn<T>, index: number): string {
  const value = valueOf(row, col)
  if (col.format) return col.format(value, row, index)
  return value === null || value === undefined || value === '' ? '—' : String(value)
}
function toneOf(row: T, index: number): string {
  const tone = props.rowTone?.(row, index)
  return tone ? `is-${tone}` : ''
}

/* TxDataTable column objects: card metadata stripped, alignment kept */
const tableColumns = computed(() =>
  props.columns.map(({ card: _card, cardLabel: _label, ...rest }) => ({ ...rest, nowrap: rest.nowrap ?? true })),
)
const CARD_LINES = ['line2', 'line3'] as const
const cardCols = computed(() => {
  const by = (role: string) => props.columns.filter((c) => c.card === role)
  return { primary: by('primary'), meta: by('meta'), line2: by('line2'), line3: by('line3'), actions: by('actions') }
})

const loadingState = computed(() => props.state === 'loading' || props.state === 'error' || props.state === 'forbidden')
const isEmpty = computed(() => props.state === 'empty' || (props.state === 'ready' && rows.value.length === 0))
const skeletonCols = computed(() => props.columns.map((c) => (typeof c.width === 'number' ? `${c.width}px` : c.width ?? '1fr')))
const rowHeight = computed(() => ({ list: 40, dense: 34, 'two-line': 44 })[props.density])

/* row stagger for print-in: tag rows with their index once they exist */
const host = ref<HTMLElement | null>(null)
function tagRows() {
  const list = host.value?.querySelectorAll<HTMLElement>('tbody > tr.tx-data-table__row:not(.tx-data-table__row--detail), .ui-rcard')
  list?.forEach((el, i) => {
    el.dataset.row = ''
    el.style.setProperty('--r', String(Math.min(i, 14)))
  })
}
onMounted(() => void nextTick(tagRows))
watch([rows, asCards], () => void nextTick(tagRows), { flush: 'post' })

function onCardKey(event: KeyboardEvent, row: T, index: number) {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    emit('rowClick', row, index)
  }
}
const tableListeners = computed(() =>
  clickable.value ? { onRowClick: (p: { row: T; index: number }) => emit('rowClick', p.row, p.index) } : {},
)
</script>

<template>
  <div ref="host" class="ui-rt" :class="[`ui-rt--${density}`, { 'is-cards': asCards, 'is-headless': !showHead }]">
    <StateBlock
      v-if="loadingState"
      :state="state"
      :rows="skeletonRows"
      :cols="skeletonCols"
      :row-height="rowHeight"
      :error="error"
      @retry="emit('retry')"
    />
    <StateBlock
      v-else-if="isEmpty"
      state="empty"
      :empty-text="emptyText"
      :action-label="emptyAction"
      @action="emit('emptyAction')"
    >
      <template v-if="$slots.empty" #empty-extra><slot name="empty" /></template>
    </StateBlock>

    <ul v-else-if="asCards" class="ui-rcards" :aria-label="caption">
      <li
        v-for="(row, i) in rows"
        :key="keyOf(row, i)"
        class="ui-rcard"
        :class="[toneOf(row, i), { 'is-clickable': clickable }]"
        :tabindex="clickable ? 0 : undefined"
        :role="clickable ? 'button' : undefined"
        @click="clickable && emit('rowClick', row, i)"
        @keydown="clickable && onCardKey($event, row, i)"
      >
        <slot name="card" :row="row" :index="i">
          <div class="ui-rcard__l1">
            <span class="ui-rcard__primary">
              <template v-for="col in cardCols.primary" :key="col.key">
                <slot :name="`cell-${col.key}`" :row="row" :column="col" :value="valueOf(row, col)" :index="i">{{ cellText(row, col, i) }}</slot>
              </template>
            </span>
            <span v-if="cardCols.meta.length" class="ui-rcard__meta">
              <template v-for="col in cardCols.meta" :key="col.key">
                <slot :name="`cell-${col.key}`" :row="row" :column="col" :value="valueOf(row, col)" :index="i">{{ cellText(row, col, i) }}</slot>
              </template>
            </span>
          </div>
          <div v-for="line in CARD_LINES" v-show="cardCols[line].length" :key="line" class="ui-rcard__ln">
            <span v-for="col in cardCols[line]" :key="col.key" class="ui-rcard__seg">
              <span v-if="col.cardLabel" class="ui-rcard__lbl">{{ col.cardLabel }}</span>
              <slot :name="`cell-${col.key}`" :row="row" :column="col" :value="valueOf(row, col)" :index="i">{{ cellText(row, col, i) }}</slot>
            </span>
            <span v-if="line === 'line2' && cardCols.actions.length" class="ui-rcard__act" @click.stop>
              <template v-for="col in cardCols.actions" :key="col.key">
                <slot :name="`cell-${col.key}`" :row="row" :column="col" :value="valueOf(row, col)" :index="i" />
              </template>
            </span>
          </div>
        </slot>
      </li>
    </ul>

    <TxDataTable
      v-else
      :columns="tableColumns"
      :data="rows"
      :row-key="keyOf"
      table-layout="fixed"
      hover
      :sticky-header="maxHeight !== undefined"
      :max-height="maxHeight"
      :sort="sortState"
      :sort-on-client="false"
      sort-cycle="tri"
      :expandable="expandable"
      :expanded-keys="expandedKeys"
      :row-expandable="rowExpandable"
      expand-label="展开"
      collapse-label="收起"
      :row-class="toneOf"
      :aria-label="caption"
      v-bind="tableListeners"
      @update:sort="onSort"
      @update:expanded-keys="emit('update:expandedKeys', $event)"
    >
      <template v-for="col in columns" :key="col.key" #[`cell-${col.key}`]="scope">
        <slot :name="`cell-${col.key}`" v-bind="scope">{{ cellText(scope.row, col, scope.index) }}</slot>
      </template>
      <template v-for="col in columns.filter((c) => $slots[`header-${c.key}`])" :key="`h-${col.key}`" #[`header-${col.key}`]="scope">
        <slot :name="`header-${col.key}`" v-bind="scope" />
      </template>
      <template v-if="$slots.expanded" #expanded="scope"><slot name="expanded" v-bind="scope" /></template>
    </TxDataTable>
  </div>
</template>

<style>
.ui-rt { min-width: 0; }
.ui-rt.is-headless .tx-data-table__table > thead { display: none; }
html:root .ui-rt .tx-data-table__cell { height: var(--row); }
html:root .ui-rt--dense .tx-data-table__cell { height: var(--row-dense); }
html:root .ui-rt--two-line .tx-data-table__cell { height: var(--row-2l); }
html:root .ui-rt .tx-data-table__cell { overflow: hidden; text-overflow: ellipsis; }
html:root .ui-rt .tx-data-table__th:first-child, html:root .ui-rt .tx-data-table__cell:first-child { padding-left: 0; }
html:root .ui-rt .tx-data-table__th:last-child, html:root .ui-rt .tx-data-table__cell:last-child { padding-right: 0; }
html:root .ui-rt .tx-data-table__row.is-attn > .tx-data-table__cell:first-child { box-shadow: inset 2px 0 0 var(--signal); padding-left: 10px; }
html:root .ui-rt .tx-data-table__row.is-cool > .tx-data-table__cell { background: var(--paper-2); color: var(--ink-2); }
html:root .ui-rt .tx-data-table__row.is-cool > .tx-data-table__cell :is(.dim, .muted, .micro, .cell-sub, .ui-em__domain, .ui-em__l2) { color: var(--ink-2); }
html:root .ui-rt .tx-data-table__row.is-off > .tx-data-table__cell { color: var(--ink-3); }

</style>
