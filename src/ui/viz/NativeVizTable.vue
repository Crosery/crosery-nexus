<script setup lang="ts" generic="T extends Record<string, any>">
import { TxDataTable } from '@talex-touch/tuffex/data-table'
import type { DataTableColumn } from '@talex-touch/tuffex/data-table'

withDefaults(
  defineProps<{
    columns: DataTableColumn<T>[]
    data: T[]
    rowKey?: keyof T | ((row: T, index: number) => string | number)
    ariaLabel: string
    emptyText?: string
  }>(),
  { rowKey: undefined, emptyText: '没有数据' },
)
</script>

<template>
  <TxDataTable
    :columns="columns"
    :data="data"
    :row-key="rowKey"
    :aria-label="ariaLabel"
    :empty-text="emptyText"
    table-layout="auto"
    scroll-x
  >
    <template v-for="column in columns" :key="column.key" #[`cell-${column.key}`]="scope">
      <slot :name="`cell-${column.key}`" v-bind="scope">{{ scope.value }}</slot>
    </template>
    <template v-for="column in columns" :key="`header-${column.key}`" #[`header-${column.key}`]="scope">
      <slot :name="`header-${column.key}`" v-bind="scope">{{ column.title }}</slot>
    </template>
  </TxDataTable>
</template>
