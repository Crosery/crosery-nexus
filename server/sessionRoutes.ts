/**
 * `/api/session`、`/api/login`、`/api/logout` 的处理器（契约 C1）。
 *
 * 同一个登录入口接两种凭据：`{username,password}` → admin，`{apiKey}` → key 用户。
 * 复用同一个公开路由，而不是新开 `/api/login/key`：公开面不扩大，默认拒绝的白名单不变。
 */
import type { Request, Response } from 'express'
import {
  issueSession,
  logout,
  readSessionToken,
  resolveSession,
  revokeSession,
  SESSION_UNAVAILABLE_BODY,
  sessionTokenValid,
  validateCredentials,
  type SessionPrincipal,
} from './auth.js'
import { config } from './config.js'
import { addAudit } from './db.js'
import { findKeyByPresentedValue, isManuallyDisabled, keyByHash, keyRef, maskApiKey, type KeyRecord } from './keySession.js'
import {
  errorResponseBody,
  keyLoginRateLimitKey,
  keyLoginRateLimiter,
  keyLoginSuccessLimiter,
  loginRateLimitKey,
  loginRateLimiter,
  type RateLimitDecision,
} from './security.js'

const rateLimited = (response: Response, decision: Extract<RateLimitDecision, { allowed: false }>, error: string) => {
  response.setHeader('Retry-After', String(decision.retryAfterSeconds))
  return response.status(429).json({ error, code: 'rate_limited', retryAfterSec: decision.retryAfterSeconds })
}

const sessionUnavailable = (response: Response) => {
  response.setHeader('Retry-After', '5')
  return response.status(503).json(SESSION_UNAVAILABLE_BODY)
}

/**
 * 公开登录口的 500：客户端只拿通用文案（与全局错误处理同一份 `errorResponseBody`），
 * 服务端留一条诊断——用户提交的凭据从文本里抹掉。
 */
function loginFailed(response: Response, kind: 'admin' | 'key', error: unknown, secrets: string[]) {
  let text = error instanceof Error ? error.stack || `${error.name}: ${error.message}` : String(error)
  for (const secret of secrets) if (secret.length >= 4) text = text.split(secret).join('[redacted]')
  console.error(`[error] POST /api/login (${kind}) → 500\n${text.slice(0, 2000)}`)
  return response.status(500).json(errorResponseBody(500))
}

/**
 * `login_key` 审计按 Key 节流：同一把 Key 10 分钟内只记一条。
 * 成功登录不受 IP 限流（设计如此），不节流的话任何 Key 持有者都能刷屏 audit_log，把管理员操作挤出最近 100 条。
 */
const KEY_LOGIN_AUDIT_EVERY_MS = 10 * 60_000
const lastKeyLoginAudit = new Map<string, number>()
function auditKeyLogin(key: KeyRecord, now = Date.now()) {
  const last = lastKeyLoginAudit.get(key.key_hash)
  if (last !== undefined && now - last < KEY_LOGIN_AUDIT_EVERY_MS) return
  if (lastKeyLoginAudit.size >= 5_000) {
    for (const [hash, at] of lastKeyLoginAudit) if (now - at >= KEY_LOGIN_AUDIT_EVERY_MS) lastKeyLoginAudit.delete(hash)
  }
  addAudit('login_key', key.name)
  lastKeyLoginAudit.set(key.key_hash, now)
}

/** 新会话写入前吊销本浏览器原来的 token：同名 Cookie 会被覆盖，旧值不该还能被重放。 */
function replaceSession(request: Request, response: Response, principal: SessionPrincipal) {
  const previous = readSessionToken(request)
  const issued = issueSession(request, response, principal)
  if (previous && previous !== issued && sessionTokenValid(previous)) revokeSession(previous)
}

export function sessionProbe(request: Request, response: Response) {
  response.setHeader('Cache-Control', 'no-store')
  const { principal, unavailable } = resolveSession(request)
  // 查不清 ≠ 未登录：回 503 而不是 {authenticated:false}，前端不会因为一次库忙把人请回登录页。
  if (unavailable) return sessionUnavailable(response)
  if (!principal) return response.json({ authenticated: false })
  if (principal.role === 'admin') {
    return response.json({ authenticated: true, role: 'admin', user: { name: config.consoleUsername } })
  }
  let key: KeyRecord | null
  try {
    key = keyByHash(principal.keyHash)
  } catch {
    return sessionUnavailable(response)
  }
  if (!key) return response.json({ authenticated: false })
  return response.json({ authenticated: true, role: 'key', key: { name: key.name, masked: maskApiKey(key.key_value), ref: keyRef(key.key_hash) } })
}

function adminLogin(request: Request, response: Response) {
  // 限流（task-57 ②）：按「来源 IP + 用户名」滑动窗口计数，超阈值 429 + Retry-After。
  // 放在凭据校验**之前**，且对任何用户名一视同仁——不泄漏「该用户名是否存在」。
  const username = String(request.body?.username || '')
  const password = String(request.body?.password || '')
  const limitKey = loginRateLimitKey(request, username)
  const decision = loginRateLimiter.check(limitKey)
  if (!decision.allowed) return rateLimited(response, decision, '登录尝试过于频繁，请稍后再试')
  try {
    if (!validateCredentials(username, password, config.consoleUsername, config.consolePassword)) {
      loginRateLimiter.recordFailure(limitKey)
      // 文案与「用户名不存在 / 密码错误」完全一致，也不区分时序（保持红队认可的两条优点）。
      return response.status(401).json({ error: '管理员账号或密码不正确', code: 'invalid_credentials' })
    }
    loginRateLimiter.clear(limitKey)
    replaceSession(request, response, { role: 'admin' })
    addAudit('login', 'console')
    response.json({ ok: true, role: 'admin' })
  } catch (error) {
    loginFailed(response, 'admin', error, [password])
  }
}

function keyLogin(request: Request, response: Response) {
  const limitKey = keyLoginRateLimitKey(request)
  const decision = keyLoginRateLimiter.check(limitKey)
  if (!decision.allowed) return rateLimited(response, decision, '尝试过于频繁 · 稍后再试')
  const raw = request.body?.apiKey
  const presented = typeof raw === 'string' ? raw.trim() : ''
  try {
    const key = findKeyByPresentedValue(presented)
    if (!key) {
      keyLoginRateLimiter.recordFailure(limitKey)
      return response.status(401).json({ error: 'API Key 无效', code: 'key_invalid' })
    }
    // 额度超限自动停用的 Key 仍可登录查看自己的用量（与 /v1/usage 同一规则）；人工停用的不行。
    if (isManuallyDisabled(key)) {
      keyLoginRateLimiter.recordFailure(limitKey)
      return response.status(401).json({ error: 'API Key 已被停用', code: 'key_disabled' })
    }
    // 同一把 Key 的成功登录也有上限：每次成功都签发新 token、撤销旧 token，不设上限就能无限刷会话与撤销表。
    const perKey = keyLoginSuccessLimiter.check(key.key_hash)
    if (!perKey.allowed) return rateLimited(response, perKey, '登录过于频繁 · 稍后再试')
    keyLoginSuccessLimiter.recordFailure(key.key_hash) // 这个实例计的是「成功次数」
    replaceSession(request, response, { role: 'key', keyHash: key.key_hash })
    auditKeyLogin(key)
    response.json({ ok: true, role: 'key' })
  } catch (error) {
    loginFailed(response, 'key', error, [presented])
  }
}

export function loginRoute(request: Request, response: Response) {
  const body = request.body
  if (body && typeof body === 'object' && Object.hasOwn(body, 'apiKey')) return keyLogin(request, response)
  return adminLogin(request, response)
}

// 登出做**服务端吊销**（task-57 ③）：记下 token 摘要直到它自己到期，旧 cookie 重放立即失效。
// 只吊销验签通过的 token：匿名请求带伪造 Cookie 不得往撤销表里塞条目（会把真正登出的 token 挤出去）。
export function logoutRoute(request: Request, response: Response) {
  const token = readSessionToken(request)
  if (sessionTokenValid(token)) revokeSession(token)
  logout(response)
  response.json({ ok: true })
}
