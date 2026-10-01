/**
 * 表格列 ↔ 排序字段的映射，以及「没有匹配就不打 aria-sort」的 fail-safe。
 *
 * 为什么单独抽出来（而不是留在页面里）：`aria-sort` 是表格**唯一**的排序指示器，
 * 映射错一列，屏幕阅读器就会播报错误的排序列（红队第四轮 R4-A：`?sort=output` 时
 * `aria-sort` 落到了「模型名称」列）。把映射做成纯函数，才能用行为级测试逐列锁住，
 * 而不是靠读源码文本来猜。
 */
export type ColumnSortMap = Record<string, readonly string[]>

/**
 * 一列可以承载多个排序字段：定价列同时承载「按输入单价」与「按输出单价」，
 * 这样 URL 里出现 `sort=output` 时，指示器仍落在定价列，而不是被兜底到第一列。
 */
export const MODEL_COLUMN_SORTS: ColumnSortMap = {
  model: ['name'],
  sources: ['sources'],
  pricing: ['input', 'output'],
  usage: ['usage'],
}

/** 当前排序字段落在哪一列；**没有匹配返回 null**，调用方据此不打 `aria-sort`（不猜、不兜底到第一列）。 */
export function columnForSortKey(sortKey: string, map: ColumnSortMap = MODEL_COLUMN_SORTS): string | null {
  for (const [column, keys] of Object.entries(map)) {
    if (keys.includes(sortKey)) return column
  }
  return null
}

/** 表头点击回报的列 → 该列的默认排序字段（定价列默认按输入单价）。 */
export function sortKeyForColumn(columnKey: string, map: ColumnSortMap = MODEL_COLUMN_SORTS): string | null {
  return map[columnKey]?.[0] ?? null
}

/** 传给 Tuffex `TxDataTable` 的受控 `sort`：没有匹配时返回 null（全列 `aria-sort="none"`）。 */
export function tableSortState(
  sortKey: string,
  dir: 'asc' | 'desc',
  map: ColumnSortMap = MODEL_COLUMN_SORTS,
): { key: string; order: 'asc' | 'desc' } | null {
  const column = columnForSortKey(sortKey, map)
  return column ? { key: column, order: dir } : null
}
