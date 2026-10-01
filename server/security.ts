import type { Request } from 'express'

/**
 * 控制台的**传输与滥用防护工具**（task-57 起；task-58 把会话实现迁到 `server/auth.ts`）。
 *
 * 本模块只留：Cookie 的 `Secure` 协议推导、登录失败限流、错误响应文案。
 * 会话的签发/读取/校验/撤销/登出**全部归属 `server/auth.ts`**——依赖方向是单向的
 * `auth.ts → security.ts`（auth 用这里的 `shouldSecureCookie`），不会出现环形依赖。
 *
 * 共同约束：**不新增依赖**、**有界内存**（按时间过期清理）、**不改变既有安全优点**
 * （登录错误文案不区分「用户名是否存在」、时序不可区分）。
 */

/* ────────────────────────── ① Cookie 的 Secure 推导（会话本身在 auth.ts） ────────────────────────── */

/**
 * 是否给会话 Cookie 加 `Secure`（task-57 ③；会话签发已归 `server/auth.ts`，这里只负责协议判据）。
 *
 * 判据（三层，任何一层都不依赖 `NODE_ENV` 正确设置）：
 * 1. 请求**经 HTTPS 到达**（`trust proxy` 之后 `req.secure`，或 `X-Forwarded-Proto: https`）
 *    → **一定**加 `Secure`，即使环境变量写着 `COOKIE_SECURE=false`。
 *    （生产启动脚本曾写死 `false`，只靠环境变量修不掉这条；Lead 的 launcher 修复已去掉写死。）
 * 2. 否则看显式开关：`COOKIE_SECURE=true` 强制加（例如 TLS 终止层没传 X-Forwarded-Proto）。
 * 3. 都没给：纯 HTTP 本地不加，否则浏览器会丢 Cookie。
 */
export function shouldSecureCookie(request: Request): boolean {
  const forwarded = (request.header('x-forwarded-proto') || '').split(',')[0].trim().toLowerCase()
  const overTls = request.secure || forwarded === 'https'
  if (overTls) return true
  return process.env.COOKIE_SECURE === 'true'
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
