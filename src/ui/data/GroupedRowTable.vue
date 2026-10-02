<script setup lang="ts" generic="T extends Record<string, any>">
import { getCurrentInstance } from 'vue'
import RowTable from './RowTable.vue'
import StateBlock from './StateBlock.vue'
import type { DataState, RowColumn, RowTone } from '../types'

/**
 * Grouped rows (DESIGN.md §5.2 data/GroupedRowTable, /accounts): one RowTable per group with the same
 * column definitions (fixed layout + explicit widths keep the columns aligned across groups); only the first
 * group shows the column header. Each group gets a 46px provider head (slot `group-head`, strong rule under
 * it). Cell / card / expanded slots pass straight through to every group.
 */
type Key = string | number
type Group = { key: Key; head?: string; rows: T[] }
withDefaults(
  defineProps<{
    groups: Group[]
    columns: RowColumn<T>[]
    rowKey?: string | ((row: T, index: number) => Key)
    state?: DataState
    error?: unknown
    emptyText?: string
    density?: 'list' | 'dense' | 'two-line'
    expandable?: boolean
    rowExpandable?: (row: T, index: number) => boolean
    rowTone?: (row: T, index: number) => RowTone
    cardBelow?: number
    groupEmptyText?: string
  }>(),
  {
    rowKey: 'id', state: 'ready', error: undefined, emptyText: '没有数据', density: 'two-line',
    expandable: false, rowExpandable: undefined, rowTone: undefined, cardBelow: 960, groupEmptyText: '— 这一组没有数据',
  },
)
const emit = defineEmits<{ (e: 'rowClick', row: T, index: number, group: Group): void; (e: 'retry'): void }>()
defineSlots<Record<string, (props: any) => any>>()
const expanded = defineModel<Key[]>('expandedKeys', { default: () => [] })
/* rows are clickable only when the parent listens (same rule as RowTable) */
const clickable = Boolean(getCurrentInstance()?.vnode.props?.onRowClick)
const rowListeners = (g: Group) => (clickable ? { onRowClick: (row: T, i: number) => emit('rowClick', row, i, g) } : {})
</script>

<template>
  <div class="ui-grt">
    <StateBlock v-if="state === 'loading' || state === 'error' || state === 'forbidden'" :state="state" :error="error" :rows="8" @retry="emit('retry')" />
    <StateBlock v-else-if="state === 'empty' || !groups.length" state="empty" :empty-text="emptyText" />
    <template v-else>
    <section v-for="(g, gi) in groups" :key="g.key" class="ui-grt__group" data-print>
      <header class="ui-grt__head">
        <slot name="group-head" :group="g" :index="gi"><h3 class="ui-grt__title">{{ g.head }}</h3></slot>
      </header>
      <RowTable
        :columns="columns"
        :data="g.rows"
        :row-key="rowKey"
        :density="density"
        :expandable="expandable"
        :expanded-keys="expanded"
        :row-expandable="rowExpandable"
        :row-tone="rowTone"
        :card-below="cardBelow"
        :show-head="gi === 0"
        :caption="g.head"
        :empty-text="groupEmptyText"
        @update:expanded-keys="expanded = $event"
        v-bind="rowListeners(g)"
      >
        <template v-for="(_, name) in $slots" :key="name" #[name]="scope"><slot :name="name" v-bind="scope ?? {}" /></template>
      </RowTable>
    </section>
    </template>
  </div>
</template>

<style>
.ui-grt { display: grid; gap: 18px; min-width: 0; }
.ui-grt__head { display: flex; align-items: center; gap: 10px; min-height: var(--provider-head); border-bottom: 1px solid var(--rule-2); }
.ui-grt__title { margin: 0; font-size: var(--fs-md); font-weight: 600; }
@media (max-width: 959px) { .ui-grt__head { min-height: 44px; } }
</style>
