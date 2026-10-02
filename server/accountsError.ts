import { maskIdentity } from './accountProjection.js'
import { KERNEL_MESSAGES, KernelError, kernelRefusal, type KernelReply } from './magpieKernel.js'
import { sanitizeSyncError } from './syncRegistry.js'

/** A refusal of an /api/accounts route: HTTP status, a machine code, the zh line the page shows, optional detail. */
export class AccountsError extends Error {
  constructor(readonly status: number, readonly code: string, message = ACCOUNTS_MESSAGES[code] ?? '操作失败', readonly detail: string | null = null) {
    super(message)
    this.name = 'AccountsError'
  }
}

export const ACCOUNTS_MESSAGES: Record<string, string> = {
  ...KERNEL_MESSAGES,
  kernel_error: '内核内部错误',
  catalog_missing: '订阅目录缺失或无效，需要重新生成',
  cpa_backend: 'CPA 模式沿用现有账号入口',
  agent_unsupported: '此内核不支持该服务',
  signin_gated: '该服务要在服务器上运行厂商 CLI 或安装器，已关闭',
  risk_unconfirmed: '请先确认封号风险',
  site_required: '请选择账号所在的站点',
  port_busy: '本机端口被占用（可能有另一处登录在进行）',
  signin_not_found: '这次登录已结束，请重新开始',
  signin_starting: '该服务的登录正在启动',
  signin_limit: '同时进行的登录太多，请先完成或取消一个',
  signin_timeout: '登录超时，请重新开始',
  signin_failed: '登录未完成',
  signin_not_waiting: '登录已不在等待回调',
  callback_not_supported: '这种登录不需要粘贴回调地址',
  callback_locked: '回调地址已提交，正在等待完成',
  callback_too_large: '回调地址太长',
  callback_mismatch: '这不是本次登录的回调地址',
  callback_no_code: '地址里没有授权码，请复制浏览器最终跳转的完整地址',
  callback_rejected: '回调未被接受，请复制浏览器最终跳转的完整地址',
  relay_failed: '无法把回调地址交给本机的登录监听',
  relay_timeout: '本机登录监听响应超时',
  account_active: '这是当前首选账号，先把其它账号设为首选',
  account_not_found: '账号不存在或已被移除',
  codex_only: '只有 ChatGPT（Codex）账号支持使用重置',
  reset_in_progress: '这个账号的重置正在进行',
  kernel_rejected: '操作被内核拒绝',
  invalid_request: '请求不合法',
  invalid_action: '不支持的操作',
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g

/** Kernel/Magpie English text for a `detail` line: no URL queries (codes, states), no full emails, no credentials. */
export function sanitizeDetail(value: unknown): string | null {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) return null
  return sanitizeSyncError(text
    .replace(/(https?:\/\/[^\s?#"']+)[?#][^\s"']*/gi, '$1')
    .replace(EMAIL, match => maskIdentity(match))).slice(0, 300) || null
}

export type KernelContext = 'signin' | 'account' | 'callback' | 'usage'

/** A non-2xx kernel reply → the console's status and code (ACCOUNTS-ALIGN §2.7). */
export function kernelFailure(reply: KernelReply, context: KernelContext): AccountsError {
  const { error, code } = kernelRefusal(reply.body)
  const detail = sanitizeDetail(error)
  if (reply.status === 504 || code === 'timeout') return new AccountsError(504, 'kernel_timeout')
  if (code === 'request_id_required' || error === 'no such kernel route' || (reply.status === 400 && !code)) return new AccountsError(501, 'kernel_outdated')
  if (reply.status === 404) return new AccountsError(404, context === 'account' ? 'account_not_found' : 'signin_not_found')
  if (reply.status >= 500) return new AccountsError(502, 'kernel_error')
  switch (code) {
    case 'agent_disabled': return new AccountsError(403, 'signin_gated')
    case 'agent_unknown': return new AccountsError(422, 'agent_unsupported')
    case 'account_active': return new AccountsError(409, 'account_active', undefined, detail)
    case 'invalid_request':
    case 'too_large': return new AccountsError(400, 'invalid_request')
  }
  if (/port\b.*\bbusy|ports? .* are all busy/i.test(error)) return new AccountsError(409, 'port_busy', undefined, detail)
  if (/can't sign in to .* accounts/i.test(error)) return new AccountsError(422, 'agent_unsupported', undefined, detail)
  if (context === 'callback') {
    if (/no longer waiting/i.test(error)) return new AccountsError(409, 'signin_not_waiting')
    if (/carries no code/i.test(error)) return new AccountsError(422, 'callback_no_code')
    if (/callback (address|path)|another sign-in's state|isn't a URL|does not accept a callback/i.test(error)) return new AccountsError(422, 'callback_mismatch', undefined, detail)
  }
  return new AccountsError(422, 'kernel_rejected', undefined, detail)
}

/** Any thrown value → the response pair; unknown errors never echo their message (it may carry internals). */
export function errorResponse(error: unknown): { status: number; body: { error: string; code: string; detail?: string } } {
  if (error instanceof AccountsError) {
    return { status: error.status, body: { error: error.message, code: error.code, ...(error.detail ? { detail: error.detail } : {}) } }
  }
  if (error instanceof KernelError) return { status: error.status, body: { error: error.message, code: error.code } }
  return { status: 500, body: { error: '操作失败', code: 'internal_error' } }
}
