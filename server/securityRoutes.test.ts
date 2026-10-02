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

/**
 * task-61（红队第十七轮 F1/F2）：凭据名/provider 的路径穿越在 **HTTP 层**被拒。
 *
 * 与红队同构的生产参数：`GATEWAY_ENGINE=magpie` + `MAGPIE_CONTROL_PLANE=local`
 * （这样 `/api/credentials/*` 才会走 `magpieControl` 的本地实现，也就是漏洞所在的那条链）。
 */
test('凭据名穿越（越界删/读）与 provider 穿越（越界写）在 HTTP 层被拒，合法路径仍可用', { timeout: 90_000 }, async () => {
  const stub = await startCpaStub()
  let harness: Harness | null = null
  const cleanup: string[] = []
  try {
    // GATEWAY_ENGINE=magpie 才会走 magpieControl 的本地实现（cpa.ts:56 的 local 分支），
    // 同时必须给它一个**独立的** MAGPIE_PORT（不能用 stub 的端口，否则引擎起不来 → EADDRINUSE）。
    harness = await startHarness(stub.port, { GATEWAY_ENGINE: 'magpie', MAGPIE_PORT: String(await freePort()) })
    const base = harness.base
    const dataDir = path.resolve(harness.dataDir)
    const authDir = path.join(dataDir, 'auth-files')
    fs.mkdirSync(authDir, { recursive: true })

    // 未认证也要先 401（守卫没被放宽）
    assert.equal((await fetch(`${base}/api/credentials/x.json`, { method: 'DELETE' })).status, 401)

    const session = await login(harness, { username: 'admin', password: 'correct-horse-battery' })
    assert.equal(session.status, 200)
    const cookie = String(session.headers.get('set-cookie') || '').split(';')[0]
    assert.ok(cookie.includes('crosery_console_session='))

    // 哨兵：DATA_DIR **之外**（与红队用例同构）
    const outsideDir = path.dirname(dataDir)
    const canary = path.join(outsideDir, `cac-wp-e2e-canary-${process.pid}.txt`)
    const probe = path.join(outsideDir, `cac-wp-e2e-probe-${process.pid}.json`)
    fs.writeFileSync(canary, 'CANARY\n')
    fs.writeFileSync(probe, JSON.stringify({ secret: 'OUTSIDE-DATA' }))
    cleanup.push(canary, probe)
    const relCanary = `..%2F..%2F${path.basename(canary)}`
    const relProbe = `..%2F..%2F${path.basename(probe)}`

    // ① DELETE：红队实测的越界删除
    const del = await fetch(`${base}/api/credentials/${relCanary}`, { method: 'DELETE', headers: { cookie } })
    assert.equal(del.status, 400, `越界删除必须 400：${del.status}`)
    assert.equal((await del.json() as { reason?: string }).reason, 'credential_name_invalid')
    assert.equal(fs.existsSync(canary), true, 'DATA_DIR 之外的哨兵必须还在')
    assert.equal(fs.readFileSync(canary, 'utf8'), 'CANARY\n')

    // ② GET：红队实测的越界读取
    const read = await fetch(`${base}/api/credentials/${relProbe}/proxy`, { headers: { cookie } })
    assert.equal(read.status, 400, `越界读取必须 400：${read.status}`)
    const readBody = JSON.stringify(await read.json())
    assert.ok(!readBody.includes('OUTSIDE-DATA'), `响应不得带出越界内容：${readBody}`)
    assert.equal((JSON.parse(readBody) as { reason?: string }).reason, 'credential_name_invalid')

    // ③ 绝对路径变体（无论被路由层还是守卫拦下，都必须是 4xx 且不返回文件内容）
    const abs = await fetch(`${base}/api/credentials/${encodeURIComponent('/etc/hosts')}/proxy`, { headers: { cookie } })
    assert.ok(abs.status >= 400, `绝对路径必须被拒：${abs.status}`)
    assert.ok(!JSON.stringify(await abs.json()).includes('localhost'), '不得返回 /etc/hosts 内容')

    // ④ symlink 变体：名字是单段，但文件指向 DATA_DIR 之外
    const linkName = `cac-wp-e2e-link-${process.pid}.json`
    const linkPath = path.join(authDir, linkName)
    fs.rmSync(linkPath, { force: true })
    fs.symlinkSync(probe, linkPath)
    const linked = await fetch(`${base}/api/credentials/${encodeURIComponent(linkName)}/proxy`, { headers: { cookie } })
    assert.equal(linked.status, 400, `软链接逃逸必须 400：${linked.status}`)
    assert.equal((await linked.json() as { reason?: string }).reason, 'credential_path_escape')
    assert.equal(fs.existsSync(probe), true, '软链接目标不得被删除或改写')

    // ⑤ 硬链接变体（F3）：路径在目录内但 inode 属于目录外的文件
    const hardName = `cac-wp-e2e-hard-${process.pid}.json`
    const hardPath = path.join(authDir, hardName)
    fs.rmSync(hardPath, { force: true })
    fs.linkSync(probe, hardPath)
    const hard = await fetch(`${base}/api/credentials/${encodeURIComponent(hardName)}/proxy`, { headers: { cookie } })
    assert.equal(hard.status, 400, `硬链接必须 400：${hard.status}`)
    assert.equal((await hard.json() as { reason?: string }).reason, 'credential_hardlink_rejected')
    assert.equal(fs.existsSync(probe), true)

    // ⑥ F2：OAuth 回调的 provider 穿越（越界写）
    const canaryWrite = `/tmp/cac-wp-e2e-oauth-${process.pid}`
    const callback = await fetch(`${base}/api/cpa/oauth/callback`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ provider: `../../../../tmp/cac-wp-e2e-oauth-${process.pid}`, redirectUrl: 'https://example.com/cb?code=abc' }),
    })
    assert.equal(callback.status, 400, `穿越型 provider 必须 400：${callback.status}`)
    const cbBody = await callback.json() as { reason?: string; error?: string }
    assert.equal(cbBody.reason, 'provider_not_supported')
    assert.match(String(cbBody.error), /不支持的 OAuth 提供商/)
    const strays = fs.readdirSync('/tmp').filter(name => name.startsWith(path.basename(canaryWrite)))
    assert.deepEqual(strays, [], `DATA_DIR 之外不得落盘：${strays.join(', ')}`)

    // ⑦ 合法 provider 在 magpie + local 下走「账号」页的真实登录：模拟器 start/callback 410，且不落盘
    const before = new Set(fs.readdirSync(authDir))
    const start = await fetch(`${base}/api/cpa/oauth/start`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'claude' }),
    })
    assert.equal(start.status, 410, `本机模拟器已退役，合法 provider 的 oauth/start 必须 410：${start.status}`)
    assert.equal((await start.json() as { code?: string }).code, 'use_accounts_signin')
    const retiredCallback = await fetch(`${base}/api/cpa/oauth/callback`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'claude', redirectUrl: 'https://example.com/cb?code=xyz', state: 'any' }),
    })
    assert.equal(retiredCallback.status, 410, `退役的回调必须 410：${retiredCallback.status}`)
    assert.deepEqual(fs.readdirSync(authDir).filter(name => !before.has(name)), [], '退役路径不得落盘')
    const created = [`anthropic-${process.pid}.json`]
    fs.writeFileSync(path.join(authDir, created[0]), JSON.stringify({ type: 'claude', provider: 'claude', email: 'fixture@example.test', access_token: 'fixture-token' }), { mode: 0o600 })
    cleanup.push(path.join(authDir, created[0]))

    // ⑧ 合法凭据的读取/删除仍然可用（同一路由，合法名字必须 200 —— 与越界名字的 400 成对照）
    const legitRead = await fetch(`${base}/api/credentials/${encodeURIComponent(created[0])}/proxy`, { headers: { cookie } })
    const legitText = await legitRead.text()
    assert.equal(legitRead.status, 200, `合法凭据的 /proxy 必须 200：${legitRead.status} ${legitText}`)
    const removed = await fetch(`${base}/api/credentials/${encodeURIComponent(created[0])}`, { method: 'DELETE', headers: { cookie } })
    assert.equal(removed.status, 200, `合法凭据删除必须成功：${removed.status} ${await removed.text()}`)
    assert.equal(fs.existsSync(path.join(authDir, created[0])), false, '合法删除必须真的删掉')
  } finally {
    for (const file of cleanup) fs.rmSync(file, { force: true })
    if (harness) await stopHarness(harness)
    stub.server.close()
  }
})
