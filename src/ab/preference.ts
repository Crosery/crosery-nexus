/**
 * A/B 偏好留痕的客户端契约（纯函数 + 一个 fetch 封装，便于被测试直接引用）。
 *
 * 权威校验在 `server/abLab.ts`：同一组规则在服务端再实现一次，客户端这份只用于
 * 「提交前给出即时反馈」，任何绕过前端的请求都必须被服务端拒绝。
 *
 * 留痕边界（与 task-5 一致）：只记 flow / choice / 一句话理由 / 卡点 / 时间 /
 * UA / 是否管理员。**禁止**记录密钥、密码、Prompt 内容。
 */

export const AB_FLOW_IDS = ['keys-access', 'integration-rtk', 'dashboard-overview'] as const
export type AbFlowId = (typeof AB_FLOW_IDS)[number]

export const AB_CHOICES = ['a', 'b', 'neither'] as const
export type AbChoice = (typeof AB_CHOICES)[number]

export const AB_CHOICE_LABEL: Record<AbChoice, string> = {
  a: '选 A（迁移前更顺手）',
  b: '选 B（迁移后更顺手）',
  neither: '都不行',
}

export const AB_NOTE_MAX = 500
export const AB_BLOCKER_MAX = 300

export interface AbPreferenceInput {
  flow: AbFlowId
  choice: AbChoice
  note: string
  blocker?: string
}

export interface AbPreferenceResult {
  ok: true
  id: string
}

export type AbValidation =
  | { ok: true; value: AbPreferenceInput }
  | { ok: false; error: string }

const isFlowId = (value: unknown): value is AbFlowId =>
  typeof value === 'string' && (AB_FLOW_IDS as readonly string[]).includes(value)

const isChoice = (value: unknown): value is AbChoice =>
  typeof value === 'string' && (AB_CHOICES as readonly string[]).includes(value)

/** 与 server/abLab.ts 的同名规则保持一致；不一致时以服务端为准。 */
export function validatePreference(input: unknown): AbValidation {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: '提交内容必须是一个对象' }
  const source = input as Record<string, unknown>
  if (!isFlowId(source.flow)) return { ok: false, error: `flow 必须是 ${AB_FLOW_IDS.join(' / ')} 之一` }
  if (!isChoice(source.choice)) return { ok: false, error: `choice 必须是 ${AB_CHOICES.join(' / ')} 之一` }

  const note = typeof source.note === 'string' ? source.note.trim() : ''
  const blocker = typeof source.blocker === 'string' ? source.blocker.trim() : ''
  if (note.length > AB_NOTE_MAX) return { ok: false, error: `理由最多 ${AB_NOTE_MAX} 字` }
  if (blocker.length > AB_BLOCKER_MAX) return { ok: false, error: `卡点最多 ${AB_BLOCKER_MAX} 字` }
  if (source.choice === 'neither' && !note) return { ok: false, error: '选「都不行」时请写一句话说明哪里不行' }

  return { ok: true, value: { flow: source.flow, choice: source.choice, note, ...(blocker ? { blocker } : {}) } }
}

/** 提交到 POST /api/ab/preference；失败抛错，由调用方渲染成**持久**错误态而不是一闪而过的 toast。 */
export async function submitPreference(input: AbPreferenceInput): Promise<AbPreferenceResult> {
  const response = await fetch('/api/ab/preference', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  const data = (await response.json().catch(() => null)) as { ok?: boolean; id?: string; error?: string } | null
  if (!response.ok || !data?.ok || typeof data.id !== 'string') {
    throw new Error(data?.error || `提交失败（HTTP ${response.status}）`)
  }
  return { ok: true, id: data.id }
}
