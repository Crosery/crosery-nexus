/**
 * A/B 实验台深链状态（纯函数，可被测试直接引用）。
 *
 * 深链形如 `/ab?flow=keys-access&v=a`：
 * - `flow`：实验对象（三个真实流程之一）
 * - `v`：`a`（迁移前 legacy）/ `b`（迁移后 TUF）/ `split`（并排）
 * - `full`：`1` 时收起说明区，只留对照与投票（用于「在新标签打开单侧视图」）
 *
 * **参数名刻意避开 `q`/`status`/`page`/`days`/`keyId`**：B 侧渲染的是真实页面，
 * 这些页面会把自身的筛选状态写回 URL（TUF M6 模式），不能与实验台自己的参数抢名字。
 */

import { AB_FLOW_IDS, type AbFlowId } from './preference'

export const AB_VIEWS = ['a', 'b', 'split'] as const
export type AbView = (typeof AB_VIEWS)[number]
export const AB_VIEW_LABEL: Record<AbView, string> = {
  a: 'A · 迁移前',
  b: 'B · 迁移后',
  split: 'A / B 并排',
}

export const DEFAULT_FLOW: AbFlowId = 'keys-access'
export const DEFAULT_VIEW: AbView = 'split'

export interface AbLabState {
  flow: AbFlowId
  view: AbView
  full: boolean
}

const first = (value: unknown): string => (Array.isArray(value) ? String(value[0] ?? '') : typeof value === 'string' ? value : '')

/** 解析 URL query；任何无法识别的值都回落到默认值，不抛错（深链必须永远打得开）。 */
export function parseLabQuery(query: Record<string, unknown> | null | undefined): AbLabState {
  const source = query || {}
  const flowText = first(source.flow)
  const viewText = first(source.v)
  const flow = (AB_FLOW_IDS as readonly string[]).includes(flowText) ? (flowText as AbFlowId) : DEFAULT_FLOW
  const view = (AB_VIEWS as readonly string[]).includes(viewText) ? (viewText as AbView) : DEFAULT_VIEW
  return { flow, view, full: first(source.full) === '1' }
}

/** 生成深链；省略与默认值相同的参数，保证链接稳定可分享。 */
export function labLink(flow: AbFlowId, view: AbView, options: { full?: boolean } = {}): string {
  const params = new URLSearchParams()
  if (flow !== DEFAULT_FLOW) params.set('flow', flow)
  if (view !== DEFAULT_VIEW) params.set('v', view)
  if (options.full) params.set('full', '1')
  const query = params.toString()
  return query ? `/ab?${query}` : '/ab'
}
