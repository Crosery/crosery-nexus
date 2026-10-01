import './testDataDir.js'
import assert from 'node:assert/strict'
import test from 'node:test'

// 先设好环境再**动态**导入被测模块：`server/config.ts` 在模块求值时读取 SESSION_SECRET。
process.env.SESSION_SECRET = 'unit-test-session-secret'

// task-58：会话实现已归并到 auth.ts，本文件只测「传输与滥用防护工具」，
// 会话相关的原语改从 auth.js 导入（契约测试「签发↔验证」随之变成同模块内自洽 + 与 isAuthenticated 对照）。
const { createLoginRateLimiter, shouldSecureCookie, errorResponseBody } = await import('./security.js')
const {
  clearRevokedSessions,
  isAuthenticated,
  isSessionRevoked,
  issueSession,
  revokeSession,
  revokedSessionCount,
  sessionTokenValid,
  SESSION_COOKIE,
} = await import('./auth.js')

/**
 * task-57 的三块安全原语的**行为级**单测（不需要 HTTP）；
 * task-58 把会话实现迁到 `auth.ts` 后，本文件只覆盖 security.ts 的工具 + 会话契约。
 * 端到端（限流 429、登出后 401、错误不泄堆栈）在 `server/securityRoutes.test.ts`。
 */

/* ────────────────── ① 登录限流 ────────────────── */

test('连续失败达到阈值后触发限流，并给出 Retry-After 秒数', () => {
  let now = 1_000_000
  const limiter = createLoginRateLimiter({ maxFailures: 3, windowMs: 60_000, maxBlockMs: 300_000, now: () => now })
  const key = '1.2.3.4|admin'
  assert.equal(limiter.check(key).allowed, true, '一开始允许')
  for (let i = 0; i < 3; i += 1) {
    limiter.check(key)
    limiter.recordFailure(key)
    now += 100
  }
  const blocked = limiter.check(key)
  assert.equal(blocked.allowed, false)
  assert.ok(!blocked.allowed && blocked.retryAfterSeconds >= 1, 'Retry-After 必须是 ≥1 的秒数')
})

test('窗口滑过之后自动恢复（滑动窗口而不是永久锁定）', () => {
  let now = 0
  const limiter = createLoginRateLimiter({ maxFailures: 2, windowMs: 1_000, maxBlockMs: 1_000, now: () => now })
  const key = 'ip|admin'
  limiter.recordFailure(key); limiter.recordFailure(key)
  assert.equal(limiter.check(key).allowed, false)
  now += 5_000
  assert.equal(limiter.check(key).allowed, true, '失败早已滑出窗口，且封禁到期 → 恢复')
})

test('登录成功后计数清零（不会累积到被自己锁住）', () => {
  let now = 0
  const limiter = createLoginRateLimiter({ maxFailures: 3, windowMs: 60_000, now: () => now })
  const key = 'ip|admin'
  limiter.recordFailure(key); limiter.recordFailure(key)
  limiter.clear(key)
  now += 10
  limiter.recordFailure(key); limiter.recordFailure(key)
  assert.equal(limiter.check(key).allowed, true, '清零后再失败两次仍不该触发（阈值 3）')
})

test('不同来源互相独立（不同 IP、不同用户名都不共享计数）', () => {
  let now = 0
  const limiter = createLoginRateLimiter({ maxFailures: 2, windowMs: 60_000, now: () => now })
  limiter.recordFailure('1.1.1.1|admin'); limiter.recordFailure('1.1.1.1|admin')
  assert.equal(limiter.check('1.1.1.1|admin').allowed, false, '这个 IP 被限流')
  assert.equal(limiter.check('2.2.2.2|admin').allowed, true, '另一个 IP 不受影响')
  assert.equal(limiter.check('1.1.1.1|other').allowed, true, '同一 IP 的另一个用户名不受影响')
})

test('限流器内存有界：过期条目会被清理', () => {
  let now = 0
  const limiter = createLoginRateLimiter({ maxFailures: 5, windowMs: 1_000, now: () => now })
  for (let i = 0; i < 500; i += 1) limiter.recordFailure(`10.0.0.${i}|admin`)
  const grown = limiter.size()
  assert.ok(grown > 0)
  now += 60_000
  limiter.check('10.0.0.0|admin')
  assert.ok(limiter.size() < grown, `过期条目应被清理：${grown} → ${limiter.size()}`)
})

/* ────────────────── ② 会话撤销 ────────────────── */

test('撤销集合按 token 摘要记录，且**不保存 token 原文**', () => {
  clearRevokedSessions()
  const token = `${Date.now() + 60_000}.deadbeef`
  revokeSession(token)
  assert.equal(isSessionRevoked(token), true)
  assert.equal(isSessionRevoked(`${Date.now() + 60_000}.other`), false)
  assert.equal(revokedSessionCount(), 1)
  clearRevokedSessions()
})

test('已过期的 token 不会被判定为「在撤销集合里」（集合有界）', () => {
  clearRevokedSessions()
  const expired = `${Date.now() - 1_000}.sig`
  revokeSession(expired)
  assert.equal(isSessionRevoked(expired), false, 'token 自己都过期了，无需保留撤销记录')
  assert.equal(revokedSessionCount(), 0, '过期条目已被清理，内存有界')
})

test('没有 cookie / 空 token 时撤销判定与常规一致（不抛错）', () => {
  assert.equal(isSessionRevoked(null), false)
  assert.equal(isSessionRevoked(''), false)
  revokeSession(null)
  assert.equal(revokedSessionCount(), 0)
})

/* ────────────────── ③ Secure 推导 ────────────────── */

const fakeRequest = (options: { secure?: boolean; forwardedProto?: string } = {}) =>
  ({
    secure: options.secure ?? false,
    header: (name: string) => (name.toLowerCase() === 'x-forwarded-proto' ? options.forwardedProto : undefined),
  }) as unknown as import('express').Request

test('HTTPS 请求一定带 Secure —— 即使环境变量写着 COOKIE_SECURE=false（生产启动脚本就是 false）', () => {
  process.env.COOKIE_SECURE = 'false'
  assert.equal(shouldSecureCookie(fakeRequest({ secure: true })), true, 'req.secure')
  assert.equal(shouldSecureCookie(fakeRequest({ forwardedProto: 'https' })), true, 'X-Forwarded-Proto: https')
  assert.equal(shouldSecureCookie(fakeRequest({ forwardedProto: 'https, http' })), true, '多跳只取第一跳')
})

test('纯 HTTP：显式 false 允许本地调试，显式 true 仍可强制带 Secure', () => {
  process.env.COOKIE_SECURE = 'false'
  assert.equal(shouldSecureCookie(fakeRequest()), false, '本地 HTTP 调试不加 Secure，否则浏览器会丢 Cookie')
  process.env.COOKIE_SECURE = 'true'
  assert.equal(shouldSecureCookie(fakeRequest()), true, 'TLS 终止层没传 X-Forwarded-Proto 时可强制')
  delete process.env.COOKIE_SECURE
  assert.equal(shouldSecureCookie(fakeRequest()), false, '未显式设置且非 HTTPS → 不加')
})

/* ────────────────── 契约：签发的 Cookie 必须被 auth.ts 接受 ────────────────── */

test('issueSession 签发的 Cookie 能被 server/auth.ts 的 isAuthenticated 接受（防签名规则漂移）', () => {
  const cookies: Record<string, { value: string; options: Record<string, unknown> }> = {}
  const response = {
    cookie: (name: string, value: string, options: Record<string, unknown>) => {
      cookies[name] = { value, options }
    },
  } as unknown as import('express').Response
  process.env.COOKIE_SECURE = 'false'
  issueSession(fakeRequest({ forwardedProto: 'https' }), response)

  const issued = cookies[SESSION_COOKIE]
  assert.ok(issued, `应当写入 ${SESSION_COOKIE} Cookie`)
  assert.equal(issued.options.httpOnly, true)
  assert.equal(issued.options.sameSite, 'strict')
  assert.equal(issued.options.secure, true, 'HTTPS 下必须带 Secure')

  // 交给真正的验证方（auth.ts）判定：签名格式一致才算通过。
  assert.equal(isAuthenticated({ cookies: { [SESSION_COOKIE]: issued.value } } as unknown as import('express').Request), true)
  assert.equal(sessionTokenValid(issued.value), true, '本模块自验证也通过')
  const tampered = `${issued.value.slice(0, -2)}xx`
  assert.equal(isAuthenticated({ cookies: { [SESSION_COOKIE]: tampered } } as unknown as import('express').Request), false, '伪造签名必须 401')
})

/* ────────────────── 错误响应体不泄内部信息 ────────────────── */

test('错误响应体只有通用文案（不含堆栈/路径/内部细节）', () => {
  for (const status of [400, 413, 500, 502]) {
    const body = errorResponseBody(status)
    assert.deepEqual(Object.keys(body), ['error'])
    assert.doesNotMatch(body.error, /at |\/Users\/|\/opt\/|node_modules|\.ts:|secret/i)
  }
  assert.equal(errorResponseBody(413).error, '请求体过大')
  assert.equal(errorResponseBody(500).error, '服务器内部错误')
})
