import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import { createServer, type Server } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

/**
 * task-57 的端到端验收：**真起一个 `server/index.ts` 子进程**（临时 DATA_DIR + 本地 CPA stub），
 * 只通过 HTTP 断言三块安全加固的行为。全程隔离，`finally` 里杀进程删目录。
 *
 * 覆盖：
 * ① 错误不泄堆栈：畸形 JSON → 400、超大 body → 413，响应体不含 `at `/`/Users/`/`node_modules`，
 *    而**子进程日志里仍有堆栈**（否则排障能力被牺牲了）；
 * ② 登录限流：连续失败 → 429 + `Retry-After`；成功后清零；不同 IP 互不影响；
 *    限流响应不泄漏「用户名是否存在」（合法与非法用户名得到同一文案/同一状态）；
 * ③ 会话：HTTPS 下发时 Cookie 带 `Secure`；登出后原 cookie 立即 401，另一会话不受影响。
 *
 * 本文件**不**引入 `./testDataDir.js`：自己 mkdtemp 并显式传给子进程（符合该模块文档的例外情形）。
 */

const REPO = new URL('../', import.meta.url).pathname

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address ? address.port : 0
      probe.close(() => (port ? resolve(port) : reject(new Error('拿不到空闲端口'))))
    })
  })
}

async function startCpaStub(): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    if ((req.url ?? '').startsWith('/api-keys')) {
      if (req.method === 'PUT') {
        req.on('data', () => undefined)
        req.on('end', () => res.end(JSON.stringify({ ok: true })))
        return
      }
      res.end(JSON.stringify({ 'api-keys': [] }))
      return
    }
    res.end(JSON.stringify({}))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return { server, port: typeof address === 'object' && address ? address.port : 0 }
}

type Harness = {
  base: string
  child: ChildProcess
  dataDir: string
  logs: () => string
  waitForLog: (pattern: RegExp, timeoutMs?: number) => Promise<boolean>
}

async function startHarness(stubPort: number, extraEnv: Record<string, string> = {}): Promise<Harness> {
  const port = await freePort()
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crosery-security-test-'))
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: REPO,
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      PORT: String(port),
      HOST: '127.0.0.1',
      CPA_BASE_URL: `http://127.0.0.1:${stubPort}`,
      CPA_MANAGEMENT_KEY: 'test-management-key',
      MAGPIE_CONTROL_PLANE: 'local',
      MAGPIE_PORT: String(stubPort),
      CONSOLE_USERNAME: 'admin',
      CONSOLE_PASSWORD: 'correct-horse-battery',
      SESSION_SECRET: 'e2e-session-secret',
      // 有意模拟生产启动脚本：显式写成 false，用来验证「HTTPS 下仍然带 Secure」。
      COOKIE_SECURE: 'false',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let buffer = ''
  child.stdout?.on('data', (chunk) => (buffer += String(chunk)))
  child.stderr?.on('data', (chunk) => (buffer += String(chunk)))
  const logs = () => buffer
  const waitForLog = async (pattern: RegExp, timeoutMs = 5_000) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (pattern.test(buffer)) return true
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    return pattern.test(buffer)
  }
  const base = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 25_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`服务子进程提前退出：${child.exitCode}\n${buffer}`)
    try {
      const res = await fetch(`${base}/api/session`)
      if (res.status < 500) break
    } catch {
      /* 还没起来 */
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  return { base, child, dataDir, logs, waitForLog }
}

async function stopHarness(harness: Harness) {
  harness.child.kill('SIGTERM')
  await new Promise((resolve) => setTimeout(resolve, 300))
  if (harness.child.exitCode === null) harness.child.kill('SIGKILL')
  fs.rmSync(harness.dataDir, { recursive: true, force: true })
}

const login = (harness: Harness, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${harness.base}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })

test('① 错误不泄堆栈：畸形 JSON / 超大 body 只回通用文案，堆栈只进服务端日志', async () => {
  const stub = await startCpaStub()
  let harness: Harness | null = null
  try {
    harness = await startHarness(stub.port)

    // 畸形 JSON（红队在生产上复现的那一类）
    const malformed = await login(harness, '{"username": "admin", ')
    assert.equal(malformed.status, 400)
    const malformedBody = await malformed.text()
    for (const leak of ['at ', '/Users/', '/opt/', 'node_modules', '.ts:', 'SyntaxError', 'stack']) {
      assert.ok(!malformedBody.includes(leak), `响应体不得包含 ${leak}：${malformedBody.slice(0, 200)}`)
    }
    assert.match(malformedBody, /请求格式不正确|error/)

    // 超大 body（express.json limit 1mb）→ 413
    const huge = await login(harness, JSON.stringify({ username: 'admin', password: 'x'.repeat(2 * 1024 * 1024) }))
    assert.equal(huge.status, 413)
    const hugeBody = await huge.text()
    for (const leak of ['at ', '/Users/', 'node_modules', 'PayloadTooLargeError', 'stack']) {
      assert.ok(!hugeBody.includes(leak), `413 响应体不得包含 ${leak}`)
    }

    // 服务端日志里必须有堆栈（排障能力不能丢）
    assert.ok(await harness.waitForLog(/\[error\] POST \/api\/login/), `日志里应记录该请求：${harness.logs().slice(-400)}`)
    assert.ok(await harness.waitForLog(/\n\s+at /), `日志里应保留堆栈帧：${harness.logs().slice(-300)}`)
  } finally {
    if (harness) await stopHarness(harness)
    await new Promise<void>((resolve) => stub.server.close(() => resolve()))
  }
})

test('② 登录限流：连续失败 429 + Retry-After、成功清零、不同 IP 独立、不泄漏用户名是否存在', async () => {
  const stub = await startCpaStub()
  let harness: Harness | null = null
  try {
    // 阈值调小便于测试；生产默认 5 次/5 分钟。
    harness = await startHarness(stub.port, { LOGIN_MAX_FAILURES: '3', LOGIN_WINDOW_MS: '60000' })
    const ipA = { 'x-forwarded-for': '203.0.113.10' }
    const ipB = { 'x-forwarded-for': '203.0.113.11' }

    // 3 次失败（阈值内）
    for (let i = 0; i < 3; i += 1) {
      const res = await login(harness, { username: 'admin', password: 'wrong' }, ipA)
      assert.equal(res.status, 401, `第 ${i + 1} 次失败应为 401`)
    }
    // 第 4 次：被限流
    const blocked = await login(harness, { username: 'admin', password: 'wrong' }, ipA)
    assert.equal(blocked.status, 429, '超过阈值应 429')
    const retryAfter = blocked.headers.get('retry-after')
    assert.ok(retryAfter && Number(retryAfter) >= 1, `应带 Retry-After：${retryAfter}`)

    // 被限流时，**正确密码也进不来**（否则限流形同虚设）
    const correctWhileBlocked = await login(harness, { username: 'admin', password: 'correct-horse-battery' }, ipA)
    assert.equal(correctWhileBlocked.status, 429)

    // 不泄漏「用户名是否存在」：给不存在的用户名也打满它自己的桶，得到的 429 与存在的用户名**完全一致**
    for (let i = 0; i < 3; i += 1) await login(harness, { username: 'no-such-user', password: 'wrong' }, ipA)
    const ghost = await login(harness, { username: 'no-such-user', password: 'wrong' }, ipA)
    assert.equal(ghost.status, 429, '不存在的用户名同样会被限流')
    assert.equal(await ghost.text(), await blocked.text(), '限流文案与存在的用户名完全一致（不泄漏存在性）')
    // 未触发限流时，两种用户名也都得到同一条 401 文案
    const ghostFirst = await login(harness, { username: 'another-ghost', password: 'wrong' }, ipB)
    const adminFirst = await login(harness, { username: 'admin', password: 'wrong' }, ipB)
    assert.equal(ghostFirst.status, adminFirst.status)
    assert.equal(await ghostFirst.text(), await adminFirst.text(), '401 文案同样不区分用户名是否存在')

    // 另一个 IP 不受影响，且能正常登录
    const otherIp = await login(harness, { username: 'admin', password: 'correct-horse-battery' }, ipB)
    assert.equal(otherIp.status, 200, '不同 IP 互不影响')

    // 成功登录后计数清零：该 IP 再失败两次不该立刻触发（阈值 3）
    const cookieB = (otherIp.headers.get('set-cookie') ?? '').split(';')[0]
    assert.equal(cookieB.includes('='), true, 'B 会话应拿到 cookie')
    await login(harness, { username: 'admin', password: 'wrong' }, ipB)
    await login(harness, { username: 'admin', password: 'wrong' }, ipB)
    const stillAllowed = await login(harness, { username: 'admin', password: 'wrong' }, ipB)
    assert.equal(stillAllowed.status, 401, '清零后重新计数，第 3 次仍是 401 而不是 429')
  } finally {
    if (harness) await stopHarness(harness)
    await new Promise<void>((resolve) => stub.server.close(() => resolve()))
  }
})

test('③ 会话加固：HTTPS 下发带 Secure；登出后原 cookie 立即 401，其它会话不受影响', async () => {
  const stub = await startCpaStub()
  let harness: Harness | null = null
  try {
    harness = await startHarness(stub.port)

    // 经 HTTPS（X-Forwarded-Proto）登录：即使 COOKIE_SECURE=false 也必须带 Secure
    const httpsLogin = await login(harness, { username: 'admin', password: 'correct-horse-battery' }, { 'x-forwarded-proto': 'https' })
    assert.equal(httpsLogin.status, 200)
    const httpsSetCookie = httpsLogin.headers.get('set-cookie') ?? ''
    assert.match(httpsSetCookie, /;\s*Secure/i, `HTTPS 下发的 Cookie 必须带 Secure：${httpsSetCookie}`)
    assert.match(httpsSetCookie, /HttpOnly/i)
    const sessionA = httpsSetCookie.split(';')[0]

    // 纯 HTTP 登录（本地调试）：不加 Secure，否则浏览器会丢 Cookie
    const httpLogin = await login(harness, { username: 'admin', password: 'correct-horse-battery' }, { 'x-forwarded-proto': 'http' })
    assert.equal(httpLogin.status, 200)
    const httpSetCookie = httpLogin.headers.get('set-cookie') ?? ''
    assert.ok(!/;\s*Secure/i.test(httpSetCookie), `纯 HTTP 不应带 Secure：${httpSetCookie}`)
    const sessionB = httpSetCookie.split(';')[0]

    // 两个会话都可用的前提
    const withCookie = (cookie: string) => fetch(`${harness!.base}/api/session`, { headers: { cookie } })
    assert.equal((await (await withCookie(sessionA)).json() as { authenticated: boolean }).authenticated, true)
    assert.equal((await (await withCookie(sessionB)).json() as { authenticated: boolean }).authenticated, true)

    // 登出 A：服务端吊销
    const logoutRes = await fetch(`${harness.base}/api/logout`, { method: 'POST', headers: { cookie: sessionA } })
    assert.equal(logoutRes.status, 200)

    const replayA = await withCookie(sessionA)
    assert.equal(replayA.status, 200, '/api/session 本身始终 200，但内容必须显示未认证')
    assert.equal(((await replayA.json()) as { authenticated: boolean }).authenticated, false, '登出后原 cookie 不得再被认作已认证')

    // A 访问受保护接口必须 401（旧 token 重放）
    const protectedA = await fetch(`${harness.base}/api/bootstrap`, { headers: { cookie: sessionA } })
    assert.equal(protectedA.status, 401, '登出后原 cookie 访问受保护接口必须 401')

    // 另一个未登出的会话不受影响
    assert.equal(((await (await withCookie(sessionB)).json()) as { authenticated: boolean }).authenticated, true)
    const protectedB = await fetch(`${harness.base}/api/bootstrap`, { headers: { cookie: sessionB } })
    assert.equal(protectedB.status, 200, '其它会话不受影响')
  } finally {
    if (harness) await stopHarness(harness)
    await new Promise<void>((resolve) => stub.server.close(() => resolve()))
  }
})
