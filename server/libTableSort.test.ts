import assert from 'node:assert/strict'
import test from 'node:test'
import { MODEL_COLUMN_SORTS, columnForSortKey, sortKeyForColumn, tableSortState } from '../src/lib/tableSort.js'

/**
 * R4-A：`aria-sort` 是表格**唯一**的排序指示器，映射错列等于向屏幕阅读器播报错误的排序列。
 * 这里逐列锁住映射（行为级断言纯函数，不是读源码文本）。
 */

test('每一个排序字段都映射到正确的列（含定价列承载 input/output 两个字段）', () => {
  const expected: Record<string, string> = {
    name: 'model',
    sources: 'sources',
    input: 'pricing',
    output: 'pricing',
    usage: 'usage',
  }
  for (const [sortKey, column] of Object.entries(expected)) {
    assert.equal(columnForSortKey(sortKey), column, `sort=${sortKey} 应落在 ${column} 列`)
  }
})

test('受控 sort 状态带上方向；?sort=output 不再落到「模型名称」列', () => {
  assert.deepEqual(tableSortState('output', 'desc'), { key: 'pricing', order: 'desc' })
  assert.deepEqual(tableSortState('output', 'asc'), { key: 'pricing', order: 'asc' })
  assert.deepEqual(tableSortState('input', 'asc'), { key: 'pricing', order: 'asc' })
  assert.deepEqual(tableSortState('name', 'asc'), { key: 'model', order: 'asc' })
  assert.deepEqual(tableSortState('usage', 'desc'), { key: 'usage', order: 'desc' })
  assert.deepEqual(tableSortState('sources', 'asc'), { key: 'sources', order: 'asc' })
})

test('未知排序字段是 fail-safe：不打 aria-sort（返回 null），而不是兜底标到第一列', () => {
  assert.equal(columnForSortKey('zzz'), null)
  assert.equal(tableSortState('zzz', 'asc'), null)
  // 空字符串（URL 里 ?sort= 被清空）同样不打指示器
  assert.equal(columnForSortKey(''), null)
  assert.equal(tableSortState('', 'desc'), null)
})

test('表头点击回报的列映射回该列的默认排序字段', () => {
  assert.equal(sortKeyForColumn('model'), 'name')
  assert.equal(sortKeyForColumn('pricing'), 'input', '定价列表头默认按输入单价')
  assert.equal(sortKeyForColumn('usage'), 'usage')
  assert.equal(sortKeyForColumn('sources'), 'sources')
  assert.equal(sortKeyForColumn('未知列'), null)
})

test('映射是全覆盖且无重复列：每个列都有排序字段，列名不重复', () => {
  const columns = Object.keys(MODEL_COLUMN_SORTS)
  assert.deepEqual(new Set(columns).size, columns.length, '列名不得重复')
  for (const column of columns) {
    assert.ok(MODEL_COLUMN_SORTS[column].length > 0, `${column} 列至少要有一个排序字段`)
  }
  // 每个排序字段只能归属一列（否则 aria-sort 会有歧义）
  const seen = new Map<string, string>()
  for (const [column, keys] of Object.entries(MODEL_COLUMN_SORTS)) {
    for (const key of keys) {
      assert.equal(seen.get(key), undefined, `排序字段 ${key} 不应同时属于 ${seen.get(key)} 与 ${column}`)
      seen.set(key, column)
    }
  }
})
