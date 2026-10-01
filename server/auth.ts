/**
 * 控制台会话的**唯一归属模块**（task-58 把 task-57 里散在 `security.ts` 的会话实现合并进来）。
 *
 * 边界（为什么这样切）：
 * - 本模块 = **会话域**：口令校验、会话签发/读取/校验/撤销、登出，以及「默认拒绝」的
 *   鉴权中间件与公开白名单。会话的生命周期只在这一个文件里，**签发与验证共用同一份签名规则**
 *   （过去签发在 `security.ts`、验证在 `auth.ts`，两处各写一遍 HMAC，只能靠一条契约测试防漂移）。
 * - `server/security.ts` = **传输与滥用防护工具**：Cookie 的 `Secure` 协议推导、登录限流、
 *   错误体文案。它们不持有会话状态，被本模块调用（依赖方向 auth → security，单向）。
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import type { Express, NextFunction, Request, Response } from 'express'
import { config } from './config.js'
import { shouldSecureCookie } from './security.js'

/** 会话 Cookie 名（本模块是唯一定义处）。 */
export const SESSION_COOKIE = 'crosery_console_session'
/** 会话有效期：12h。 */
export const SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000
/** 撤销集合上限：超过就按「最早到期」淘汰，保证内存有界。 */
const REVOCATION_CAPACITY = 10_000

function sign(value: string) {
  return createHmac('sha256', config.sessionSecret).update(value).digest('hex')
}

function safeEqual(a: string, b: string) {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

export function validateCredentials(username: string, password: string, expectedUsername: string, expectedPassword: string) {
  return safeEqual(username, expectedUsername) && safeEqual(password, expectedPassword)
}

/* ────────────────────────── 会话签发与验证 ────────────────────────── */

/** 给定 token 是否通过本模块的签名与有效期校验（签发/校验共用这一份实现）。 */
export function sessionTokenValid(token: string | null): boolean {
  if (!token) return false
  const [expiresText, signature] = token.split('.')
  const expires = Number(expiresText)
  if (!Number.isFinite(expires) || expires <= Date.now()) return false
  return safeEqual(signature || '', sign(expiresText))
}

/** 读取请求里的会话 token（没有则 null）。 */
export function readSessionToken(request: Request): string | null {
  const value = request.cookies?.[SESSION_COOKIE]
  return typeof value === 'string' && value ? value : null
}

/**
 * 签发会话 Cookie。
 *
 * `Secure` 按**请求协议**推导（见 `security.ts:shouldSecureCookie`）：HTTPS 到达的请求一定带
 * `Secure`，即使环境变量写着 `COOKIE_SECURE=false` —— 生产启动脚本此前写死 false，
 * 只靠环境变量修不掉这条（task-57 ③、Lead 的 launcher 修复）。
 */
export function issueSession(request: Request, response: Response): void {
  if (!config.sessionSecret) throw new Error('控制台登录配置缺失')
  const expires = Date.now() + SESSION_MAX_AGE_MS
  const payload = `${expires}.${sign(String(expires))}`
  response.cookie(SESSION_COOKIE, payload, {
    httpOnly: true,
    sameSite: 'strict',
    secure: shouldSecureCookie(request),
    maxAge: SESSION_MAX_AGE_MS,
    path: '/',
  })
}

export function logout(response: Response) {
  response.clearCookie(SESSION_COOKIE, { path: '/' })
}

/* ────────────────────────── 登出撤销（服务端失效） ────────────────────────── */

/**
 * 撤销集合：`token 摘要 → 到期时刻`。
 *
 * 为什么存**摘要**而不是原文：撤销表只用于判定「这个 token 是否已登出」，
 * 存原文等于在内存里再放一份可用凭据；摘要用 sha256。
 * 为什么带到期：会话本身最多活 12h，过期条目没有保留价值——按时清理即天然有界，
 * 再叠一个容量上限兜住异常流量。
 */
const revokedSessions = new Map<string, number>()

const digest = (token: string) => createHash('sha256').update(token).digest('hex')

function pruneRevoked(now = Date.now()) {
  for (const [key, expiresAt] of revokedSessions) {
    if (expiresAt <= now) revokedSessions.delete(key)
  }
  if (revokedSessions.size <= REVOCATION_CAPACITY) return
  const ordered = [...revokedSessions.entries()].sort((a, b) => a[1] - b[1])
  for (const [key] of ordered.slice(0, revokedSessions.size - REVOCATION_CAPACITY)) revokedSessions.delete(key)
}

/** token 自带的到期时刻（解析失败时按满有效期处理，宁可多留一会儿也不误判）。 */
function tokenExpiry(token: string): number {
  const expires = Number(token.split('.')[0])
  return Number.isFinite(expires) && expires > 0 ? expires : Date.now() + SESSION_MAX_AGE_MS
}

/** 登出：把该 token 记入撤销集合，直到它自己到期为止。 */
export function revokeSession(token: string | null): void {
  if (!token) return
  revokedSessions.set(digest(token), tokenExpiry(token))
  pruneRevoked()
}

/** 该 token 是否已被登出撤销。 */
export function isSessionRevoked(token: string | null): boolean {
  if (!token) return false
  pruneRevoked()
  const expiresAt = revokedSessions.get(digest(token))
  if (expiresAt === undefined) return false
  return expiresAt > Date.now()
}

/** 仅供测试/诊断：当前撤销集合大小（有界性的判据）。 */
export const revokedSessionCount = () => revokedSessions.size
/** 仅供测试：清空撤销集合。 */
export const clearRevokedSessions = () => revokedSessions.clear()

/**
 * 请求是否持有一个**有效且未被撤销**的控制台会话。
 *
 * 注意这里包含撤销检查：`/api/session` 对已撤销会话返回 `200 {authenticated:false}`
 * 是**有意行为**（前端据此跳登录页），不要改成 401。
 */
export function isAuthenticated(request: Request): boolean {
  const token = readSessionToken(request)
  return sessionTokenValid(token) && !isSessionRevoked(token)
}

/* ────────────────────────── 默认拒绝：白名单 + 全局守卫 ────────────────────────── */

/**
 * 公开路径白名单 —— **默认拒绝的唯一例外来源**。
 *
 * 安全模型（task-58）：不再依赖「所有敏感路由恰好都挂在 `/api` 前缀下」，而是
 * 「**不在这里、也不在受保护前缀下、也不是静态/SPA 回退的请求，一律要求控制台会话**」。
 * 新增路由时先回答：它该不该公开？要公开就在这里加一条并写清理由；不公开就什么都不用做
 * （默认拒绝），结构性断言测试会拦住「加了路由却既不在白名单也不在受保护前缀下」的情况。
 */
export type PublicPathRule = { method?: string; pattern: RegExp; why: string }

export const PUBLIC_PATHS: PublicPathRule[] = [
  {
    pattern: /^\/api\/session\/?$/,
    why: '登录态探测端点：未登录/已撤销都必须 200 {authenticated:false}（前端据此跳登录页）。'
      + '改成 401 会打乱前端状态机，且这是 blue-ui 在 task-57 明确记录的有意行为。',
  },
  {
    method: 'POST',
    pattern: /^\/api\/login\/?$/,
    why: '登录入口本身必须匿名可达；滥用由按「来源 IP + 用户名」的滑动窗口限流兜住（security.ts）。',
  },
  {
    method: 'POST',
    pattern: /^\/api\/logout\/?$/,
    why: '登出必须匿名可达：持过期/已撤销 Cookie 的请求也要能被清理（否则用户卡在坏会话里）。',
  },
  {
    pattern: /^\/v1(\/|$)/,
    why: '自助用量接口用 Authorization 里的 API Key **自鉴权**（index.ts:publicUsageKey），与控制台会话无关，'
      + '且只返回该 Key 自己的数据。',
  },
  {
    pattern: /^\/docs(\/|$)/,
    why: '产品文档页：静态 HTML（dist/docs.html），不含任何用户数据，路由自带 max-age=300。',
  },
]

/** 受会话保护的前缀：不在白名单里的这些前缀一律要求会话（保住「未知 /api 路径返回 401」的既有行为）。 */
export const SESSION_PROTECTED_PREFIXES: RegExp[] = [/^\/api(\/|$)/]

/** 请求是否命中公开白名单。 */
export function isPublicRequest(request: Request): boolean {
  const method = request.method.toUpperCase()
  return PUBLIC_PATHS.some(rule => (!rule.method || rule.method === method) && rule.pattern.test(request.path))
}

/**
 * 该请求是否会命中一条**已注册的路由**（而不是落到静态资源/SPA 回退）。
 *
 * 为什么需要它：SPA 深链接（`/rtk`、`/cache/…`）在服务端并没有路由，靠最后的回退返回 index.html；
 * 全局守卫如果一律 401，就会把深链接变成 401 页面。这里用 Express 的路由表判断：
 * 「没有路由会处理它」⇒ 只会返回前端产物 ⇒ 公开。
 * 方法是 `layer.match()`（Express 5 仍有），只在**未认证的非公开请求**上跑，代价可忽略。
 */
function matchesRegisteredRoute(app: Express, request: Request): boolean {
  const stack = (app as unknown as { router?: { stack?: unknown[] } }).router?.stack
  if (!Array.isArray(stack)) return false
  const method = request.method.toLowerCase()
  for (const entry of stack) {
    const layer = entry as { route?: { methods?: Record<string, boolean> }; match?: (path: string) => boolean }
    if (!layer.route || typeof layer.match !== 'function') continue
    if (!layer.route.methods?.[method]) continue
    if (layer.match(request.path)) return true
  }
  return false
}

/**
 * 全局鉴权守卫（**默认拒绝**）。
 *
 * 挂载点：`cookieParser()` 之后、**所有路由之前**（`server/index.ts`）。判定顺序：
 * 1. 命中公开白名单 → 放行；
 * 2. 持有有效且未撤销的会话 → 放行；
 * 3. 路径在受保护前缀（`/api/*`）→ 401（保住「未知 API 路径也是 401」）；
 * 4. 会命中某条已注册路由（例如将来新增的 `/internal/...`）→ 401；
 * 5. 其余（静态资源、`/`、SPA 深链接回退）→ 放行：只可能返回前端产物，不返回数据。
 * 已撤销的会话在步骤 2 判为未认证，但**同样走 3~5 的归类**：受保护接口 401、
 * 深链接仍返回 index.html（清掉 Cookie 后由前端跳登录页），不会变成 401 页面。
 */
export function createSessionGuard(app: Express) {
  return function sessionGuard(request: Request, response: Response, next: NextFunction): void {
    const token = readSessionToken(request)
    const revoked = isSessionRevoked(token)
    if (revoked) logout(response)
    if (isPublicRequest(request)) return next()
    // isAuthenticated 已包含撤销检查：已撤销会话在这里必然为 false，随后走同一套归类
    // （受保护前缀/已注册路由 → 401；静态与 SPA 回退 → 放行，不能把深链接变成 401 页面）。
    if (isAuthenticated(request)) return next()
    if (SESSION_PROTECTED_PREFIXES.some(pattern => pattern.test(request.path))) {
      return void response.status(401).json({ error: '请先登录' })
    }
    if (matchesRegisteredRoute(app, request)) return void response.status(401).json({ error: '请先登录' })
    next()
  }
}
