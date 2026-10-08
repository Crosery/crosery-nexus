/**
 * 控制台会话的**唯一归属模块**（task-58 把 task-57 里散在 `security.ts` 的会话实现合并进来）。
 *
 * 边界（为什么这样切）：
 * - 本模块 = **会话域**：口令校验、会话签发/读取/校验/撤销、登出，以及「默认拒绝」的
 *   鉴权中间件与公开白名单。会话的生命周期只在这一个文件里，**签发与验证共用同一份签名规则**
 *   （过去签发在 `security.ts`、验证在 `auth.ts`，两处各写一遍 HMAC，只能靠一条契约测试防漂移）。
 * - 会话分两种角色：`admin`（控制台管理员）与 `key`（用自己的 API Key 登录、只能读自己数据的用户）。
 *   角色写在签名内，守卫在**进入任何处理器之前**按角色裁决（`createSessionGuard`）。
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

/** 定长比较；长度不同直接 false（长度本身不是秘密：密钥/签名长度固定或已公开）。 */
export function safeEqual(a: string, b: string) {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

export function validateCredentials(username: string, password: string, expectedUsername: string, expectedPassword: string) {
  return safeEqual(username, expectedUsername) && safeEqual(password, expectedPassword)
}

/* ────────────────────────── 会话签发与验证 ────────────────────────── */

/**
 * 会话主体。`key` 会话只携带该 Key 的 `key_hash`（sha256，`api_keys` 主键），
 * 每次请求都回库确认 Key 仍存在且未被人工停用（见 `resolveSession`）。
 */
export type SessionPrincipal = { role: 'admin' } | { role: 'key'; keyHash: string }

const KEY_HASH_PATTERN = /^[0-9a-f]{64}$/
const EXPIRES_PATTERN = /^\d{1,16}$/
/** 合法 token 最长 ~160 字符；超长直接拒绝，不进 HMAC。 */
const MAX_TOKEN_LENGTH = 256

/**
 * v2 token：`<expires>.v2.<role>.<subject>.<hmac>`，HMAC 覆盖全部字段。
 * - `expires` 必须留在第 0 段：撤销表按它推算条目寿命（`revokeSession`）。
 * - 签名输入带固定前缀做域分离：v1 签名是 `HMAC(expires)`，无法被拼进 v2。
 * - v1（`<expires>.<hmac>`，恰好两段）仍按 admin 接受，部署后已登录的管理员不掉线；
 *   新签发一律 v2。
 */
const v2SignedPayload = (expiresText: string, role: string, subject: string) =>
  `crosery-console-session|v2|${expiresText}|${role}|${subject}`

/** 生成会话 token（签发与验证共用 `sign`）。 */
export function createSessionToken(principal: SessionPrincipal, expires = Date.now() + SESSION_MAX_AGE_MS): string {
  if (!config.sessionSecret) throw new Error('控制台登录配置缺失')
  const subject = principal.role === 'key' ? principal.keyHash : '-'
  if (principal.role === 'key' && !KEY_HASH_PATTERN.test(subject)) throw new Error('invalid_key_session_subject')
  const expiresText = String(Math.floor(expires))
  return `${expiresText}.v2.${principal.role}.${subject}.${sign(v2SignedPayload(expiresText, principal.role, subject))}`
}

/**
 * 校验 token 的签名、格式与有效期，返回会话主体；任何不符一律 null。
 * `SESSION_SECRET` 为空时拒绝验证：`HMAC('')` 是公开可算的，空密钥下任何人都能伪造 admin。
 */
export function verifySessionToken(token: string | null): SessionPrincipal | null {
  if (!token || !config.sessionSecret || token.length > MAX_TOKEN_LENGTH) return null
  const parts = token.split('.')
  const expiresText = parts[0]
  if (!EXPIRES_PATTERN.test(expiresText) || Number(expiresText) <= Date.now()) return null
  if (parts.length === 2) return safeEqual(parts[1], sign(expiresText)) ? { role: 'admin' } : null
  if (parts.length !== 5 || parts[1] !== 'v2') return null
  const [, , role, subject, signature] = parts
  const shapeOk = role === 'admin' ? subject === '-' : role === 'key' && KEY_HASH_PATTERN.test(subject)
  if (!shapeOk || !safeEqual(signature, sign(v2SignedPayload(expiresText, role, subject)))) return null
  return role === 'key' ? { role: 'key', keyHash: subject } : { role: 'admin' }
}

/** 给定 token 是否通过本模块的签名与有效期校验（不含撤销与 Key 存活检查）。 */
export function sessionTokenValid(token: string | null): boolean {
  return verifySessionToken(token) !== null
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
export function issueSession(request: Request, response: Response, principal: SessionPrincipal = { role: 'admin' }): string {
  const payload = createSessionToken(principal)
  response.cookie(SESSION_COOKIE, payload, {
    httpOnly: true,
    sameSite: 'strict',
    secure: shouldSecureCookie(request),
    maxAge: SESSION_MAX_AGE_MS,
    path: '/',
  })
  return payload
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

/**
 * 登出：把该 token 记入撤销集合，直到它自己到期为止。
 *
 * 只收**本服务签发、仍在有效期内**的 token，且寿命不超过一个会话周期：撤销表满了会淘汰最早到期的条目，
 * 若匿名请求能塞进伪造的远期 token（`9999999999999999.x`），就能把真正被登出的 token 挤出去让它复活。
 */
export function revokeSession(token: string | null): void {
  if (!token || verifySessionToken(token) === null) return
  const expires = Math.min(Number(token.split('.')[0]), Date.now() + SESSION_MAX_AGE_MS)
  revokedSessions.set(digest(token), expires)
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

/* ────────────────────────── Key 会话的存活判定 ────────────────────────── */

/** `active` = 启用，或仅因额度超限被自动停用（与 `/v1/usage` 一致：仍可读自己的数据）。 */
export type KeySessionState = 'active' | 'disabled' | 'missing'
export type KeySessionRejection = 'key_disabled' | 'key_invalid'

/**
 * Key 存活查询由 `server/index.ts` 在启动时注入（本模块不依赖数据库）。
 * 未注入时**一律视为不存在**：漏接线只会让 Key 会话失效，不会放行。
 */
let keySessionLookup: ((keyHash: string) => KeySessionState) | null = null

export function setKeySessionLookup(lookup: ((keyHash: string) => KeySessionState) | null): void {
  keySessionLookup = lookup
}

/**
 * `unavailable` = Key 存活查询本身失败（库忙/锁）：既不能放行，也不能断定 Key 已失效。
 * 守卫回 503、**不清 Cookie**，库恢复后同一会话继续可用，用户不必重新粘贴 Key。
 */
export type SessionResolution = { principal: SessionPrincipal | null; keyRejection: KeySessionRejection | null; unavailable?: true }

/** 同一请求内只解析一次（守卫与路由处理器共用，Key 只回库一次）。 */
const resolutions = new WeakMap<Request, SessionResolution>()

/**
 * 解析请求的会话：签名有效 + 未撤销 +（Key 会话）Key 仍存在且未被人工停用。
 * Key 被删除 → `key_invalid`；被人工停用 → `key_disabled`；两者都让会话立即失效。
 */
export function resolveSession(request: Request): SessionResolution {
  const cached = resolutions.get(request)
  if (cached) return cached
  const token = readSessionToken(request)
  let resolution: SessionResolution = { principal: null, keyRejection: null }
  const principal = verifySessionToken(token)
  const revoked = principal !== null && isSessionRevoked(token)
  if (principal?.role === 'admin') {
    if (!revoked) resolution = { principal, keyRejection: null }
  } else if (principal?.role === 'key') {
    let state: KeySessionState | 'error'
    try { state = keySessionLookup ? keySessionLookup(principal.keyHash) : 'missing' } catch { state = 'error' }
    // Key 已删除/停用：即使这枚 token 已被撤销也照实报原因——守卫会顺手撤销它，并发的后续请求仍拿到同一个 code。
    if (state === 'disabled' || state === 'missing') resolution = { principal: null, keyRejection: state === 'disabled' ? 'key_disabled' : 'key_invalid' }
    else if (revoked) resolution = { principal: null, keyRejection: null }
    else if (state === 'active') resolution = { principal, keyRejection: null }
    else resolution = { principal: null, keyRejection: null, unavailable: true }
  }
  resolutions.set(request, resolution)
  return resolution
}

/** 当前请求的会话主体（无会话 / 无效 / 已撤销 / Key 已失效 → null）。 */
export function currentSession(request: Request): SessionPrincipal | null {
  return resolveSession(request).principal
}

/**
 * 请求是否持有一个**有效且未被撤销**的控制台会话（任一角色）。
 *
 * 注意这里包含撤销检查：`/api/session` 对已撤销会话返回 `200 {authenticated:false}`
 * 是**有意行为**（前端据此跳登录页），不要改成 401。
 */
export function isAuthenticated(request: Request): boolean {
  return currentSession(request) !== null
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
    // task-61：从 `/^\/v1(\/|$)/` 前缀规则收紧为**精确路径集合**——将来在 /v1 下新增接口必须显式加进白名单
    pattern: /^\/v1\/(?:usage|usage\/requests)$/,
    why: '自助用量接口（/v1/usage、/v1/usage/requests）用 Authorization 里的 API Key **自鉴权**'
      + '（index.ts:publicUsageKey），与控制台会话无关，且只返回该 Key 自己的数据。',
  },
  {
    method: 'GET',
    pattern: /^\/api\/public\/model-catalog$/,
    why: 'Agent 模型目录（文档里让 Key 用户先调它）：处理器用 Authorization 里的 API Key 自鉴权，'
      + 'Key 校验转给网关 /v1/models（与公网网关同一判定，不新增猜 Key 的面），只返回该 Key 可见的模型。'
      + '中转站旧版即公开、线上有 Key 用户在调。',
  },
  {
    method: 'GET',
    pattern: /^\/api\/public\/release$/,
    why: '发布身份（版本、tag、提交号、环境，来自发布目录的 RELEASE.json）：发布脚本和外部验收用它确认线上运行的提交；'
      + '不含用户数据、主机或密钥，仓库本身公开。',
  },
  {
    pattern: /^\/docs(\/|$)/,
    why: '产品文档页：静态 HTML（dist/docs.html），不含任何用户数据，路由自带 max-age=300。',
  },
]

/**
 * 受会话保护的前缀：不在白名单里的这些前缀一律要求会话（保住「未知 /api 路径返回 401」的既有行为）。
 * 大小写不敏感：Express 路由默认不区分大小写，`/API/keys` 同样会落到 `/api/keys` 的处理器。
 */
export const SESSION_PROTECTED_PREFIXES: RegExp[] = [/^\/api(\/|$)/i]

/**
 * Key 会话（`role=key`）唯一可达的受保护路径。其余 `/api/*` 与已注册路由在**进入处理器之前** 403。
 * `/api/session`、`/api/logout` 本就在公开白名单里，这里列出只为让允许面一眼可见。
 */
export const KEY_SESSION_PATHS: RegExp[] = [/^\/api\/me(\/|$)/i, /^\/api\/session\/?$/i, /^\/api\/logout\/?$/i]

const FORBIDDEN_ROLE_BODY = { error: '无权访问', code: 'forbidden_role' } as const
/** 会话查不清（Key 存活查询异常）时的 503 体；`/api/session` 与 `/api/me*` 共用。 */
export const SESSION_UNAVAILABLE_BODY = { error: '暂时无法确认登录状态 · 稍后重试', code: 'session_unavailable' } as const
const KEY_REJECTION_BODY: Record<KeySessionRejection, { error: string; code: KeySessionRejection }> = {
  key_invalid: { error: 'API Key 已失效 · 重新登录', code: 'key_invalid' },
  key_disabled: { error: 'API Key 已被停用', code: 'key_disabled' },
}

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
 * 2. admin 会话 → 放行；
 * 3. key 会话 → 只放行 `KEY_SESSION_PATHS`；其余受保护前缀/已注册路由 → 403 `forbidden_role`；
 * 4. 路径在受保护前缀（`/api/*`）→ 401（保住「未知 API 路径也是 401」）；
 * 5. 会命中某条已注册路由（例如将来新增的 `/internal/...`）→ 401；
 * 6. 其余（静态资源、`/`、SPA 深链接回退）→ 放行：只可能返回前端产物，不返回数据。
 * 已撤销的会话、Key 已删除/停用的会话判为未认证并清 Cookie，**同样走 4~6 的归类**：
 * 受保护接口 401、深链接仍返回 index.html，不会变成 401 页面。
 * Key 已删除/停用时这枚 token 同时记入撤销表：Key 之后被重新启用，旧 token 也不会复活，必须重新登录。
 * Key 存活查询异常（`unavailable`）：受保护接口 503 `session_unavailable`，Cookie 保留。
 */
export function createSessionGuard(app: Express) {
  return function sessionGuard(request: Request, response: Response, next: NextFunction): void {
    const token = readSessionToken(request)
    const { principal, keyRejection, unavailable } = resolveSession(request)
    if (keyRejection) revokeSession(token)
    if (isSessionRevoked(token) || keyRejection) logout(response)
    if (isPublicRequest(request)) return next()
    if (principal?.role === 'admin') return next()
    const protectedPath = SESSION_PROTECTED_PREFIXES.some(pattern => pattern.test(request.path))
    if (principal?.role === 'key') {
      if (KEY_SESSION_PATHS.some(pattern => pattern.test(request.path))) return next()
      if (protectedPath || matchesRegisteredRoute(app, request)) return void response.status(403).json(FORBIDDEN_ROLE_BODY)
      return next()
    }
    if (unavailable && (protectedPath || matchesRegisteredRoute(app, request))) {
      response.setHeader('Retry-After', '5')
      return void response.status(503).json(SESSION_UNAVAILABLE_BODY)
    }
    if (protectedPath) {
      return void response.status(401).json(keyRejection ? KEY_REJECTION_BODY[keyRejection] : { error: '请先登录' })
    }
    if (matchesRegisteredRoute(app, request)) return void response.status(401).json({ error: '请先登录' })
    next()
  }
}
