import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import type { Request, Response } from 'express'
import { config } from './config.js'

/**
 * 控制台安全加固的三块内存实现（task-57，依据红队第十五轮安全审计）。
 *
 * 三块共同的设计约束：**不新增依赖**、**有界内存**（按时间过期清理，绝不无限增长）、
 * **不改变现有安全优点**（登录错误文案不区分「用户名是否存在」、时序不可区分）。
 */

/* ────────────────────────── ① 会话 Cookie 与撤销 ────────────────────────── */

/** 会话 Cookie 名。与 `server/auth.ts` 保持一致（那边是同一会话的验证方）。 */
export const SESSION_COOKIE = 'crosery_console_session'
/** 会话有效期，与 `server/auth.ts` 的 MAX_AGE 一致（12h）。 */
const SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000
/** 撤销集合上限：超过就按「最早到期」淘汰，保证内存有界。 */
const REVOCATION_CAPACITY = 10_000

const sign = (value: string) => createHmac('sha256', config.sessionSecret).update(value).digest('hex')

/**
 * 撤销集合：`token 摘要 → 到期时刻`。
 *
 * 为什么存**摘要**而不是原文：撤销表只用于判定「这个 token 是否已登出」，
 * 存原文等于在内存里再放一份可用凭据；摘要用 sha256，比较用 `timingSafeEqual`。
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
  // 仍然超限（异常流量）：按最早到期淘汰，直到回到上限。
  const ordered = [...revokedSessions.entries()].sort((a, b) => a[1] - b[1])
  for (const [key] of ordered.slice(0, revokedSessions.size - REVOCATION_CAPACITY)) revokedSessions.delete(key)
}

/** 读取请求里的会话 token（没有则 null）。 */
export function readSessionToken(request: Request): string | null {
  const value = request.cookies?.[SESSION_COOKIE]
  return typeof value === 'string' && value ? value : null
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
  const key = digest(token)
  const expiresAt = revokedSessions.get(key)
  if (expiresAt === undefined) return false
  return expiresAt > Date.now()
}

/** 仅供测试/诊断：当前撤销集合大小（有界性的判据）。 */
export const revokedSessionCount = () => revokedSessions.size
/** 仅供测试：清空撤销集合。 */
export const clearRevokedSessions = () => revokedSessions.clear()

/**
 * 是否给会话 Cookie 加 `Secure`（task-57 ③）。
 *
 * 判据（三层，任何一层都不依赖 `NODE_ENV` 正确设置）：
 * 1. 请求**经 HTTPS 到达**（`trust proxy` 之后 `req.secure`，或 `X-Forwarded-Proto: https`）
 *    → **一定**加 `Secure`，即使环境变量写着 `COOKIE_SECURE=false`。
 *    （生产启动脚本目前写死 `false`，只靠环境变量修不掉这条；按协议推导才是真正的兜底。）
 * 2. 否则看显式开关：`COOKIE_SECURE=true` 强制加（例如 TLS 终止层没传 X-Forwarded-Proto）；
 *    `COOKIE_SECURE=false` 用于纯 HTTP 本地调试。
 * 3. 都没给：只有 HTTPS 才加（等价于第 1 层的结论，纯 HTTP 本地不加，否则浏览器会丢 Cookie）。
 */
export function shouldSecureCookie(request: Request): boolean {
  const forwarded = (request.header('x-forwarded-proto') || '').split(',')[0].trim().toLowerCase()
  const overTls = request.secure || forwarded === 'https'
  if (overTls) return true
  const explicit = process.env.COOKIE_SECURE
  if (explicit === 'true') return true
  return false
}

/** 签发会话 Cookie（payload 格式与 `server/auth.ts` 的验证方一致：`<expires>.<hmac>`）。 */
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

/**
 * 契约自检用：给定 token 是否被**本模块的签名规则**接受（与 auth.ts 的验证逻辑等价）。
 * 测试会拿它去对照 `server/auth.ts` 的 `isAuthenticated`，防止两处签名规则漂移。
 */
export function isSessionTokenValid(token: string | null): boolean {
  if (!token) return false
  const [expiresText, signature] = token.split('.')
  const expires = Number(expiresText)
  if (!Number.isFinite(expires) || expires <= Date.now()) return false
  const expected = sign(expiresText)
  const left = Buffer.from(signature || '')
  const right = Buffer.from(expected)
  return left.length === right.length && timingSafeEqual(left, right)
}

/* ────────────────────────── ② 登录失败限流 ────────────────────────── */

export type RateLimitDecision = { allowed: true } | { allowed: false; retryAfterSeconds: number }

export type LoginRateLimiter = {
  /** 判断这次登录尝试是否允许（在验证凭据**之前**调用）。 */
  check(key: string, now?: number): RateLimitDecision
  /** 记录一次失败。 */
  recordFailure(key: string, now?: number): void
  /** 登录成功：清零该键。 */
  clear(key: string): void
  /** 仅供测试/诊断：当前跟踪的键数量。 */
  size(): number
}

const positiveInt = (raw: string | undefined, fallback: number) => {
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

export function createLoginRateLimiter(options?: {
  maxFailures?: number
  windowMs?: number
  /** 触发限流后的封禁时长上限（指数退避到它为止）。 */
  maxBlockMs?: number
  now?: () => number
}): LoginRateLimiter {
  const maxFailures = options?.maxFailures ?? positiveInt(process.env.LOGIN_MAX_FAILURES, 5)
  const windowMs = options?.windowMs ?? positiveInt(process.env.LOGIN_WINDOW_MS, 5 * 60 * 1000)
  const maxBlockMs = options?.maxBlockMs ?? positiveInt(process.env.LOGIN_MAX_BLOCK_MS, 15 * 60 * 1000)
  const clock = options?.now ?? (() => Date.now())

  /** 键 → { 失败时刻列表（滑动窗口）, 封禁截止时刻 }。 */
  const buckets = new Map<string, { failures: number[]; blockedUntil: number }>()

  // 空闲条目清理：每次访问顺带清一遍过期桶；桶数超上限时按最旧失败时间淘汰。
  const MAX_KEYS = 10_000
  function prune(now: number) {
    for (const [key, bucket] of buckets) {
      bucket.failures = bucket.failures.filter((at) => now - at < windowMs)
      if (bucket.failures.length === 0 && bucket.blockedUntil <= now) buckets.delete(key)
    }
    if (buckets.size <= MAX_KEYS) return
    const ordered = [...buckets.entries()].sort((a, b) => (a[1].failures[0] ?? 0) - (b[1].failures[0] ?? 0))
    for (const [key] of ordered.slice(0, buckets.size - MAX_KEYS)) buckets.delete(key)
  }

  function check(key: string, now = clock()): RateLimitDecision {
    prune(now)
    const bucket = buckets.get(key)
    if (!bucket) return { allowed: true }
    if (bucket.blockedUntil > now) {
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((bucket.blockedUntil - now) / 1000)) }
    }
    // 窗口内失败次数达到阈值：进入退避。退避时长按「超出阈值的倍数」指数增长，封顶。
    const recent = bucket.failures.filter((at) => now - at < windowMs)
    if (recent.length >= maxFailures) {
      const over = recent.length - maxFailures
      const blockMs = Math.min(maxBlockMs, windowMs * 3 * 2 ** Math.min(over, 6))
      bucket.blockedUntil = now + blockMs
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(blockMs / 1000)) }
    }
    return { allowed: true }
  }

  function recordFailure(key: string, now = clock()) {
    prune(now)
    const bucket = buckets.get(key) ?? { failures: [], blockedUntil: 0 }
    bucket.failures = bucket.failures.filter((at) => now - at < windowMs)
    bucket.failures.push(now)
    buckets.set(key, bucket)
  }

  function clear(key: string) {
    buckets.delete(key)
  }

  return { check, recordFailure, clear, size: () => buckets.size }
}

/**
 * 限流键：**来源 IP + 用户名**（各自独立计数，互不影响）。
 *
 * IP 取 `request.ip`（在 `app.set('trust proxy', …)` 之后由 Express 依据
 * `X-Forwarded-Proto`/`X-Forwarded-For` 解析）；取不到时退回 socket 地址。
 */
export function loginRateLimitKey(request: Request, username: string): string {
  const ip = request.ip || request.socket?.remoteAddress || 'unknown'
  return `${ip}|${username.trim().toLowerCase()}`
}

/** 进程内单例：登录路由用它。 */
export const loginRateLimiter = createLoginRateLimiter()

/* ────────────────────────── ③ 错误响应（不泄堆栈） ────────────────────────── */

/**
 * 兜底错误响应体：**只有通用信息**，不含堆栈、绝对路径、内部标识。
 * 无论 `NODE_ENV` 是什么都一样（生产当前就没设 `NODE_ENV`，不能依赖它）。
 */
export function errorResponseBody(status: number): { error: string } {
  if (status === 413) return { error: '请求体过大' }
  if (status >= 400 && status < 500) return { error: '请求格式不正确' }
  return { error: '服务器内部错误' }
}
