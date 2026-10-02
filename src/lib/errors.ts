/**
 * 把接口错误翻成用户能看懂的一句话：出了什么事、下一步做什么。
 *
 * `src/api/http.ts` 抛带 status/code 的 `ApiError`；其它来源的 `Error` 仍从「请求失败 500」这类文案里回读状态码，
 * 拿不到就给中性兜底，绝不把 `[object Object]` 之类的内部字符串端到用户面前。
 */

export type ErrorView = {
  kind: 'signed_out' | 'forbidden' | 'not_found' | 'invalid' | 'server' | 'network'
  title: string
  detail: string
  /** 一行技术信息（状态码 + 原始文案），供排查用，等宽显示。 */
  trace: string
  status: number | null
}

const STATUS_TEXT: Record<number, { kind: ErrorView['kind']; title: string; detail: string }> = {
  400: { kind: 'invalid', title: '请求没有通过校验', detail: '请检查填写的内容后重试。' },
  401: { kind: 'signed_out', title: '登录已失效', detail: '请重新登录后再试。' },
  403: { kind: 'forbidden', title: '没有权限', detail: '当前账号不能执行这个操作。' },
  404: { kind: 'not_found', title: '找不到这条记录', detail: '它可能已被删除，或者链接有误。' },
  409: { kind: 'invalid', title: '操作冲突', detail: '数据已被其它操作改动，刷新后重试。' },
  429: { kind: 'invalid', title: '操作太频繁', detail: '请稍等片刻再试。' },
}

/** 状态码：优先读 `ApiError.status`（服务端文案里通常不含状态码），否则从 `请求失败 500` 文案回读；读不到返回 null。 */
export function errorStatus(error: unknown): number | null {
  const field = (error as { status?: unknown } | null)?.status
  if (typeof field === 'number' && Number.isInteger(field) && field >= 400 && field < 600) return field
  const message = error instanceof Error ? error.message : String(error ?? '')
  const match = message.match(/(?:失败|error)\s*(\d{3})\b/i) ?? message.match(/\b(4\d{2}|5\d{2})\b/)
  return match ? Number(match[1]) : null
}

/** 错误原始文案；过滤掉无信息量的内部字符串。 */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const message = error.message.trim()
    if (!message || message === '[object Object]') return ''
    return message
  }
  if (typeof error === 'string') return error.trim()
  return ''
}

export function describeError(error: unknown): ErrorView {
  const status = errorStatus(error)
  const raw = errorMessage(error)
  const known = status ? STATUS_TEXT[status] : undefined

  if (known) {
    return { ...known, status, trace: [status ? `HTTP ${status}` : null, raw].filter(Boolean).join(' · ') }
  }
  if (status && status >= 500) {
    return {
      kind: 'server',
      title: '服务器出错了',
      detail: '稍后重试通常就好了；一直失败请把下面这行发给维护者。',
      status,
      trace: [`HTTP ${status}`, raw].filter(Boolean).join(' · '),
    }
  }
  if (!status) {
    return {
      kind: 'network',
      title: '连不上服务器',
      detail: '请检查网络或服务是否在运行，然后重试。',
      status: null,
      trace: raw || 'network_error',
    }
  }
  return {
    kind: 'invalid',
    title: '请求失败',
    detail: raw || '请重试；一直失败请把下面这行发给维护者。',
    status,
    trace: [`HTTP ${status}`, raw].filter(Boolean).join(' · '),
  }
}

/**
 * 一句失败原因：服务端给了具体文案（「渠道“x”已存在」「模型扫描失败。上游返回 HTTP 401」）就用它，
 * 只有 `请求失败 500` 这种兜底文案或网络错误才退回 describeError 的通用说明。
 */
export function errorReason(error: unknown): string {
  const view = describeError(error)
  const raw = errorMessage(error)
  if (view.status === null || !raw || /^请求失败\s*\d{3}$/.test(raw)) return view.detail
  return raw
}

export type ErrorAction = { kind: 'retry' | 'reload'; label: string }

/** 错误卡片的主按钮：给了重试函数就给「重试」；登录失效给「重新加载」。 */
export function errorAction(view: Pick<ErrorView, 'kind'>, canRetry: boolean): ErrorAction | null {
  if (view.kind === 'signed_out') return { kind: 'reload', label: '重新加载' }
  return canRetry ? { kind: 'retry', label: '重试' } : null
}
