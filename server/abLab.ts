/**
 * A/B 实验台的偏好留痕（独立文件，不被任何其他 server 模块依赖）。
 *
 * ## 对接口契约
 *
 * Lead 只需注册一条路由（本文件自带鉴权，不依赖中间件）：
 *
 * ```ts
 * import { handleAbPreference } from './abLab.js'
 * app.post('/api/ab/preference', handleAbPreference)
 * ```
 *
 * 纯函数入口（可单测、可复用）：
 *
 * ```ts
 * export async function recordAbPreference(
 *   payload: unknown,
 *   context?: { userAgent?: string | null; admin?: boolean | null },
 * ): Promise<{ ok: true; id: string }>
 * ```
 *
 * 成功返回 `{ ok: true, id }`；校验失败抛 `AbPreferenceError`（`status = 400`）；
 * 落盘失败抛原始 Error（调用方应回 500）。
 *
 * ## 校验规则（服务端为权威）
 *
 * | 字段 | 规则 | 违反时 |
 * | --- | --- | --- |
 * | payload | 非 null 的非数组对象 | 400 |
 * | flow | 必须是 `keys-access` / `integration-rtk` / `dashboard-overview` | 400 |
 * | choice | 必须是 `a` / `b` / `neither` | 400 |
 * | note | 可选字符串；trim 后 ≤ 500 字；`choice === 'neither'` 时必须非空 | 400 |
 * | blocker | 可选字符串；trim 后 ≤ 300 字 | 400 |
 * | 其它键 | **一律丢弃**，从不透传（因此不可能落任何密钥/密码/Prompt 字段） | 忽略 |
 *
 * ## 落盘内容与隐私边界
 *
 * 每行一条 JSON，写 `config.dataDir/ab-preferences.jsonl`（默认 `data/ab-preferences.jsonl`，
 * 权限 0o600）：`id / at / flow / choice / note / blocker / userAgent / admin / schema`。
 * `userAgent`、`admin` **只接受服务端传入的 context**，请求体里同名键一律忽略，无法伪造。
 * 自由文本会先做密钥形状脱敏（`sk-`/`gsk_`/`AIza`/`ghp_`/`xox`/JWT/Bearer/私钥/≥40 位长串），
 * 命中时替换为 `[已隐去疑似密钥]` 并置 `redacted: true`。
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import type { Request, Response } from 'express'
import { config } from './config.js'
import { isAuthenticated } from './auth.js'
import { addAudit } from './db.js'

export const AB_FLOW_IDS = ['keys-access', 'integration-rtk', 'dashboard-overview'] as const
export type AbFlowId = (typeof AB_FLOW_IDS)[number]

export const AB_CHOICES = ['a', 'b', 'neither'] as const
export type AbChoice = (typeof AB_CHOICES)[number]

export const AB_NOTE_MAX = 500
export const AB_BLOCKER_MAX = 300
export const AB_PREFERENCE_SCHEMA = 1

export interface AbPreferenceRecord {
  schema: number
  id: string
  at: string
  flow: AbFlowId
  choice: AbChoice
  note: string
  blocker: string
  userAgent: string | null
  admin: boolean | null
  redacted: boolean
}

export interface AbRecordContext {
  userAgent?: string | null
  admin?: boolean | null
}

/** 校验失败（HTTP 400）时抛出；单测可直接断言 `error.status`。 */
export class AbPreferenceError extends Error {
  readonly status: number

  constructor(message: string, status = 400) {
    super(message)
    this.name = 'AbPreferenceError'
    this.status = status
  }
}

export const abPreferenceFilePath = () => path.join(config.dataDir, 'ab-preferences.jsonl')

/** 控制字符 / 零宽字符 / 行分隔符：一律换成空格，保证「一行一条 JSON」且不夹带不可见内容。 */
const CONTROL_CHARS = /[\p{C}\u2028\u2029]/gu

/**
 * 自由文本脱敏：只保留可读内容，疑似凭据一律替换。
 * 返回 `{ text, redacted }`，`redacted` 用于在记录里留一个「本条被脱敏过」的标记。
 */
export function redactAbText(value: string): { text: string; redacted: boolean } {
  let redacted = false
  let text = value.replace(CONTROL_CHARS, ' ')
  const patterns: RegExp[] = [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g,
    /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/gi,
    /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{12,}/g,
    /\bgsk_[A-Za-z0-9]{12,}/g,
    /\bAIza[A-Za-z0-9_-]{20,}/g,
    /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
    /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
    /[A-Za-z0-9_-]{40,}/g,
  ]
  for (const pattern of patterns) {
    text = text.replace(pattern, () => {
      redacted = true
      return '[已隐去疑似密钥]'
    })
  }
  return { text: text.trim(), redacted }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const asText = (value: unknown): string => (typeof value === 'string' ? value : '')

/** 服务端权威校验 + 构造待落盘记录（不写盘）。导出便于单测与复用。 */
export function buildAbPreferenceRecord(payload: unknown, context: AbRecordContext = {}): AbPreferenceRecord {
  if (!isRecord(payload)) throw new AbPreferenceError('提交内容必须是一个对象')

  const flow = asText(payload.flow)
  if (!(AB_FLOW_IDS as readonly string[]).includes(flow)) {
    throw new AbPreferenceError(`flow 必须是 ${AB_FLOW_IDS.join(' / ')} 之一`)
  }
  const choice = asText(payload.choice)
  if (!(AB_CHOICES as readonly string[]).includes(choice)) {
    throw new AbPreferenceError(`choice 必须是 ${AB_CHOICES.join(' / ')} 之一`)
  }

  // 长度上限必须**在脱敏之前**按原文判定：否则 `'x'.repeat(501)` 这类输入会先被
  // 「≥40 位长串」规则替换成 11 个字，绕过上限检查（自测时真踩到过）。
  const rawNote = asText(payload.note)
  const rawBlocker = asText(payload.blocker)
  if (rawNote.trim().length > AB_NOTE_MAX) throw new AbPreferenceError(`理由最多 ${AB_NOTE_MAX} 字`)
  if (rawBlocker.trim().length > AB_BLOCKER_MAX) throw new AbPreferenceError(`卡点最多 ${AB_BLOCKER_MAX} 字`)

  const note = redactAbText(rawNote)
  const blocker = redactAbText(rawBlocker)
  if (choice === 'neither' && !note.text) throw new AbPreferenceError('选「都不行」时请写一句话说明哪里不行')

  const userAgent = typeof context.userAgent === 'string' && context.userAgent.trim() ? context.userAgent.trim().slice(0, 300) : null
  const admin = typeof context.admin === 'boolean' ? context.admin : null

  return {
    schema: AB_PREFERENCE_SCHEMA,
    id: `abp_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`,
    at: new Date().toISOString(),
    flow: flow as AbFlowId,
    choice: choice as AbChoice,
    note: note.text,
    blocker: blocker.text,
    userAgent,
    admin,
    redacted: note.redacted || blocker.redacted,
  }
}

/* 追加写：串行化，避免并发请求把两行 JSON 写进同一行。 */
let writeQueue: Promise<void> = Promise.resolve()

function appendLine(file: string, line: string): Promise<void> {
  const attempt = writeQueue.then(async () => {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.appendFile(file, line, { encoding: 'utf8', mode: 0o600 })
  })
  writeQueue = attempt.catch(() => undefined)
  return attempt
}

/** 校验 + 落盘。成功返回 `{ ok: true, id }`。 */
export async function recordAbPreference(payload: unknown, context: AbRecordContext = {}): Promise<{ ok: true; id: string }> {
  const record = buildAbPreferenceRecord(payload, context)
  await appendLine(abPreferenceFilePath(), `${JSON.stringify(record)}\n`)
  try {
    addAudit('ab_preference', record.flow, `choice=${record.choice}, id=${record.id}`)
  } catch {
    // 审计日志写失败不能影响留痕本身（jsonl 已经落盘）
  }
  return { ok: true, id: record.id }
}

/**
 * Express 处理器（自带 401/400/500 映射）。
 * 注册方式：`app.post('/api/ab/preference', handleAbPreference)`。
 */
export async function handleAbPreference(request: Request, response: Response): Promise<void> {
  if (!isAuthenticated(request)) {
    response.status(401).json({ error: '请先登录' })
    return
  }
  try {
    const body: unknown = request.body
    const result = await recordAbPreference(body, {
      userAgent: request.header('user-agent') ?? null,
      // 本控制台只有单一管理员账号（config.consoleUsername，默认 admin），
      // 因此「已通过 session 校验」就等于管理员会话；这里如实从 cookie 推导，不硬编码 true。
      admin: isAuthenticated(request),
    })
    response.json(result)
  } catch (error) {
    if (error instanceof AbPreferenceError) {
      response.status(error.status).json({ error: error.message })
      return
    }
    response.status(500).json({ error: error instanceof Error ? error.message : '偏好留痕写入失败' })
  }
}
