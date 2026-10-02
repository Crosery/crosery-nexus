// HTTP：只调控制台 /api/*；错误统一映射成中文 CliError（不含 body、cookie、密码）。
import { CancelError, CliError } from './args.mjs'

export const TIMEOUT_MS = 30_000

export class HttpError extends CliError {
  constructor(message, exitCode, status, body) {
    super(message, exitCode)
    this.name = 'HttpError'
    this.status = status
    this.code = typeof body?.code === 'string' ? body.code : ''
    this.reason = typeof body?.reason === 'string' ? body.reason : ''
    this.retryAfterSec = Number.isFinite(Number(body?.retryAfterSec)) ? Number(body.retryAfterSec) : null
  }
}

const errorText = body => {
  const raw = body?.error
  if (typeof raw === 'string') return raw
  if (raw && typeof raw.message === 'string') return raw.message
  return ''
}

/** 服务端错误 → 中文提示与退出码（表见规格 §5）。 */
export function mapHttpError(status, body, { label = '操作', target = '', tier = '', retryAfter = null } = {}) {
  const text = errorText(body)
  const code = typeof body?.code === 'string' ? body.code : ''
  const reason = typeof body?.reason === 'string' ? body.reason : ''
  const seconds = Number(body?.retryAfterSec ?? retryAfter ?? 0) || 0
  let message
  let exitCode = 1
  if (status === 401) {
    message = `管理员密码不对或会话过期${tier ? `（凭据来源：${tier}）` : ''}`
    exitCode = 3
  } else if (status === 403 && code === 'forbidden_role') {
    message = '这是 Key 会话，不是管理员'
    exitCode = 3
  } else if (status === 403) {
    message = `服务端拒绝：${text || reason || code || '403'}`
  } else if (status === 429 && code === 'rate_limited') {
    message = `登录失败次数过多，请 ${seconds} 秒后再试（网页登录同样被锁）`
    exitCode = 4
  } else if (status === 429) {
    message = `${label} 冷却中，还需 ${seconds} 秒`
    exitCode = 4
  } else if (status === 404 && text === '接口不存在') {
    message = '服务端没有这个接口（版本太旧？）'
  } else if (status === 404 && reason) {
    message = `找不到：${target || text}（${reason}）`
  } else if (status === 404) {
    message = `找不到：${target || text || '对象'}`
  } else if (status === 503) {
    message = '控制台暂时不可用（503）'
  } else {
    message = `服务端返回 ${status}${text ? `：${text}` : ''}`
  }
  return new HttpError(message, exitCode, status, { ...body, retryAfterSec: seconds || body?.retryAfterSec })
}

export function networkError(error, base, { method = 'GET', timeoutMs = TIMEOUT_MS, unknownHint = '' } = {}) {
  const name = error?.name || ''
  if (name === 'TimeoutError' || name === 'AbortError') {
    const seconds = Math.round(timeoutMs / 1000)
    // 写请求超时 ≠ 没执行：服务端可能仍在跑，不能报成「连不上」诱导重试
    if (method !== 'GET') return new CliError(`等了 ${seconds} 秒没有响应，结果未知（服务端可能仍在执行）`, 1, unknownHint || '先用对应的读命令确认结果，不要直接重试')
    return new CliError(`连不上控制台 ${base}：请求超时（${seconds} 秒）`, 1, '运行 cradmin doctor 排查')
  }
  const code = error?.cause?.code || error?.code || ''
  return new CliError(`连不上控制台 ${base}：服务启动了吗？${code ? `（${code}）` : ''}`, 1, '运行 cradmin doctor 排查')
}

async function readBody(response) {
  const text = await response.text()
  if (!text) return null
  try { return JSON.parse(text) } catch { return { error: '' } }
}

/**
 * 一次原始请求（不处理鉴权重试）。返回 {status, body, headers}。
 * fetch 抛出的异常只取 name/code，绝不 String(err)。
 */
export async function rawRequest(rt, method, pathname, { body, cookie, timeoutMs = TIMEOUT_MS, unknownHint, ignoreAbort = false } = {}) {
  const headers = { accept: 'application/json', 'user-agent': rt.userAgent }
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (cookie) headers.cookie = cookie
  // 菜单里按 Ctrl+C：中止当前动作的请求、回到菜单（ctx 是 runtime 的浅拷贝，信号从 runtime 上实时读）
  const interrupt = ignoreAbort ? null : (rt.rt || rt).signal || null
  const timeout = AbortSignal.timeout(timeoutMs)
  let response
  try {
    response = await rt.fetch(`${rt.target.base}${pathname}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
      signal: interrupt ? AbortSignal.any([timeout, interrupt]) : timeout, redirect: 'manual',
    })
  } catch (error) {
    if (interrupt?.aborted) throw new CancelError()
    throw networkError(error, rt.target.base, { method, timeoutMs, unknownHint })
  }
  return { status: response.status, body: await readBody(response), headers: response.headers }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * 带鉴权的请求：自动登录；缓存会话收到 401 时删缓存、重登一次、原请求重发一次；
 * GET 遇到 503 按 Retry-After 重试一次（最多等 5 秒）。
 * opts: {body, label, target, auth=true, write=false}
 */
export async function request(rt, method, pathname, opts = {}) {
  const { body, label, target, auth = true, timeoutMs, unknownHint, ignoreAbort } = opts
  if (method !== 'GET' && rt.dryRun && !opts.allowInDryRun) throw new CliError('内部错误：--dry-run 下不应发写请求', 1)
  let retried401 = false
  let retried503 = false
  for (;;) {
    const cookie = auth ? await rt.session.cookie() : undefined
    const result = await rawRequest(rt, method, pathname, { body, cookie, timeoutMs, unknownHint, ignoreAbort })
    if (result.status >= 200 && result.status < 300) return result.body
    if (result.status === 401 && auth && !retried401 && await rt.session.invalidate(cookie)) {
      retried401 = true
      continue
    }
    if (result.status === 503 && method === 'GET' && !retried503) {
      retried503 = true
      const wait = Math.min(5, Math.max(0, Number(result.headers.get('retry-after')) || 1))
      await sleep(wait * 1000)
      continue
    }
    throw mapHttpError(result.status, result.body, {
      label, target, tier: auth ? rt.session.tierLabel() : '', retryAfter: result.headers.get('retry-after'),
    })
  }
}
