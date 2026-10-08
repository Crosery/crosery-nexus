import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

/**
 * 「默认拒绝」的结构性断言 + 端到端验证（task-58）。
 *
 * 为什么需要**结构性**断言（红队审计 §1.3 的结构性提醒）：
 * 以前的安全不是设计出来的，而是「恰好所有敏感路由都挂在 `/api` 前缀下」；
 * 下一个加 `app.get('/metrics')` 或 `app.use('/internal', …)` 的人会得到一条默认公开的路由，
 * 而没有任何测试会拦住他。所以：
 *   ① 结构性：解析 `server/index.ts` 的所有 `app.<verb>('<path>')` 与 `app.use('<prefix>')`，
 *      断言**每一条都已归类**——要么在 `PUBLIC_PATHS` 白名单（且写明理由），要么在受保护前缀下。
 *      新增一条既不在白名单、也不在受保护前缀的路由 → **本测试必须红**。
 *   ② 行为性：真起一个子进程实例，断言未认证时「白名单内可访问、白名单外 401」。
 */

const REPO = new URL('../', import.meta.url).pathname

const auth = await import('./auth.js')

/* ────────────────── ① 结构性断言 ────────────────── */

/** 从 `server/index.ts` 源码里抽出所有路由/挂载点（本仓库没有动态注册与子路由，正则足够，且更直观）。 */
function registeredPaths(source: string): Array<{ kind: 'route' | 'mount'; method: string; path: string }> {
  const found: Array<{ kind: 'route' | 'mount'; method: string; path: string }> = []
  const routePattern = /^app\.(get|post|put|patch|delete|all)\(\s*(\[[^\]]*\]|'[^']*')/gm
  for (const match of source.matchAll(routePattern)) {
    const raw = match[2]
    const paths = raw.startsWith('[')
      ? [...raw.matchAll(/'([^']*)'/g)].map(entry => entry[1])
      : [raw.slice(1, -1)]
    for (const one of paths) found.push({ kind: 'route', method: match[1].toUpperCase(), path: one })
  }
  const mountPattern = /^app\.use\(\s*'([^']+)'/gm
  for (const match of source.matchAll(mountPattern)) {
    found.push({ kind: 'mount', method: 'USE', path: match[1] })
  }
  return found
}

const isPublicPath = (method: string, routePath: string): boolean => {
  const matches = (pattern: RegExp) => pattern.test(routePath)
  return auth.PUBLIC_PATHS.some(rule =>
    (!rule.method || rule.method === method) && matches(rule.pattern))
}

test('结构性断言：index.ts 里每条路由都已归类（白名单 or 受保护前缀），没有"默认公开"的新路由', () => {
  const source = fs.readFileSync(path.join(REPO, 'server/index.ts'), 'utf8')
  const entries = registeredPaths(source)
  assert.ok(entries.length > 40, `应当解析出全部路由（实际 ${entries.length} 条）——解析器失效会让本条断言失去意义`)

  const unclassified: string[] = []
  for (const entry of entries) {
    if (isPublicPath(entry.method, entry.path)) continue
    if (auth.SESSION_PROTECTED_PREFIXES.some(pattern => pattern.test(entry.path))) continue
    unclassified.push(`${entry.method} ${entry.path}（${entry.kind}）`)
  }
  assert.deepEqual(unclassified, [],
    '以下路由既不在 PUBLIC_PATHS 白名单、也不在受保护前缀下：\n  ' + unclassified.join('\n  ')
    + '\n处理方式：要么在 server/auth.ts 的 PUBLIC_PATHS 里加一条**并写清为什么可以公开**，'
    + '要么把它放到受保护前缀（例如 /api）下。默认拒绝下不需要额外动作。')

  // 白名单本身必须逐条写明理由（防止有人只加 pattern 不写 why）
  for (const rule of auth.PUBLIC_PATHS) {
    assert.ok(rule.why && rule.why.trim().length > 10, `白名单 ${String(rule.pattern)} 缺少「为什么可以公开」的说明`)
  }
})

test('结构性断言：白名单只覆盖必须公开的路径（不误放行 /api 下的业务路由）', () => {
  const source = fs.readFileSync(path.join(REPO, 'server/index.ts'), 'utf8')
  const apiRoutes = registeredPaths(source).filter(entry => entry.path.startsWith('/api/') && entry.kind === 'route')
  const publicApi = apiRoutes.filter(entry => isPublicPath(entry.method, entry.path)).map(entry => `${entry.method} ${entry.path}`)
  // GET /api/public/model-catalog 自鉴权（API Key），中转站旧版即公开、线上有 Key 用户在调
  // GET /api/public/release 只回发布身份（RELEASE.json 的可公开字段），发布脚本与外部验收用
  assert.deepEqual(publicApi.sort(), ['GET /api/session', 'POST /api/login', 'POST /api/logout', 'GET /api/public/model-catalog', 'GET /api/public/release'].sort(),
    `公开的 /api 路由必须恰好是这五个（实际：${publicApi.join(', ')}）`)
})

test('结构性断言：key 会话的可达面只有 /api/me*、/api/session、/api/logout，且 /api/me 下只有只读路由', () => {
  const allowed = (pathname: string) => auth.KEY_SESSION_PATHS.some(pattern => pattern.test(pathname))
  for (const pathname of ['/api/me', '/api/me/usage', '/api/me/requests', '/api/session', '/api/logout']) {
    assert.ok(allowed(pathname), `${pathname} 应对 key 会话可达`)
  }
  for (const pathname of ['/api/meta', '/api/mex', '/api/keys', '/api/keys/x/reveal-token', '/api/monitor', '/api/usage-page', '/api/audit', '/api', '/api/', '/me', '/v1/usage']) {
    assert.ok(!allowed(pathname), `${pathname} 不得出现在 key 会话的可达面里`)
  }

  const index = fs.readFileSync(path.join(REPO, 'server/index.ts'), 'utf8')
  const mounts = registeredPaths(index).filter(entry => entry.kind === 'mount' && /^\/api\/me(\/|$)/.test(entry.path))
  assert.deepEqual(mounts.map(entry => entry.path), ['/api/me'], 'key 用户数据面只挂在 /api/me（受保护前缀下）')

  // /api/me 的路由在独立模块里注册：解析它，断言全部是 GET（key 会话的数据面不提供任何写操作）
  const meSource = fs.readFileSync(path.join(REPO, 'server/meRoutes.ts'), 'utf8')
  const meRoutes = [...meSource.matchAll(/router\.(get|post|put|patch|delete|all|use)\(\s*('[^']*')?/g)].map(match => `${match[1]} ${match[2] ?? ''}`.trim())
  assert.ok(meRoutes.filter(route => route.startsWith('get ')).length >= 5, `应解析出 /api/me 的全部 GET 路由：${meRoutes.join(', ')}`)
  assert.deepEqual(meRoutes.filter(route => !route.startsWith('get ') && route !== 'use'), [], `/api/me 下只允许 GET：${meRoutes.join(', ')}`)
})

/* ────────────────── ② 端到端行为 ────────────────── */

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

async function waitForReady(base: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 25_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`服务子进程提前退出：${child.exitCode}`)
    try {
      const response = await fetch(`${base}/api/session`)
      if (response.status < 500) return
    } catch {
      /* 还没起来 */
    }
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  throw new Error('服务子进程 25s 内没就绪')
}

test('端到端：未认证时白名单内可访问、白名单外 401、SPA 深链接仍是 index.html', { timeout: 120_000 }, async (t) => {
  const dist = path.join(REPO, 'dist')
  if (!fs.existsSync(path.join(dist, 'index.html'))) {
    t.skip('dist 不存在（先 npm run build）')
    return
  }
  const port = await freePort()
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crosery-default-deny-'))
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: REPO,
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      PORT: String(port),
      HOST: '127.0.0.1',
      CPA_BASE_URL: 'http://127.0.0.1:9',
      CPA_MANAGEMENT_KEY: 'test-management-key',
      MAGPIE_CONTROL_PLANE: 'local',
      CONSOLE_USERNAME: 'admin',
      CONSOLE_PASSWORD: 'default-deny-password',
      SESSION_SECRET: 'default-deny-session-secret',
      COOKIE_SECURE: 'false',
      GATEWAY_ENGINE: 'cpa',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const base = `http://127.0.0.1:${port}`
  let log = ''
  child.stdout.on('data', chunk => { log += chunk })
  child.stderr.on('data', chunk => { log += chunk })
  try {
    await waitForReady(base, child)

    // 白名单内：未认证也必须可达
    const session = await fetch(`${base}/api/session`)
    assert.equal(session.status, 200, `未登录的 /api/session 必须 200：${session.status}`)
    assert.deepEqual(await session.json(), { authenticated: false }, '未登录返回 {authenticated:false}（前端据此跳登录页）')

    const login = await fetch(`${base}/api/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'wrong-password' }),
    })
    assert.equal(login.status, 401, '登录入口必须匿名可达（凭据错误 → 它的 401，而不是守卫的）')
    assert.deepEqual(await login.json(), { error: '管理员账号或密码不正确', code: 'invalid_credentials' })

    const logout = await fetch(`${base}/api/logout`, { method: 'POST' })
    assert.equal(logout.status, 200, '登出必须匿名可达')

    // 白名单外：一律 401（含未知 /api 路径）
    for (const [label, url] of [['/api/audit', `${base}/api/audit`], ['未知 /api 路径', `${base}/api/definitely-not-a-route`]] as const) {
      const response = await fetch(url)
      assert.equal(response.status, 401, `${label} 未认证必须 401（实际 ${response.status}）`)
      assert.deepEqual(await response.json(), { error: '请先登录' })
    }

    // /v1/* 公开但自鉴权：不得被会话守卫拦下（它的 401 文案是 API Key 的）
    const usage = await fetch(`${base}/v1/usage`)
    assert.equal(usage.status, 401)
    const usageBody = await usage.json() as { error?: { message?: string } | string }
    const usageMessage = typeof usageBody.error === 'string' ? usageBody.error : usageBody.error?.message
    assert.match(String(usageMessage), /API Key/, `必须是它自己的鉴权错误，而不是会话守卫的：${JSON.stringify(usageBody)}`)

    // Agent 模型目录同样自鉴权：没 Key / 坏 Key 都是它自己的 401，而不是会话守卫的「请先登录」
    const catalog = await fetch(`${base}/api/public/model-catalog`)
    assert.equal(catalog.status, 401)
    assert.deepEqual(await catalog.json(), { error: '缺少 API Key' })
    const badKey = await fetch(`${base}/api/public/model-catalog`, { headers: { authorization: 'Bearer sk-not-a-real-key' } })
    assert.equal(badKey.status, 401)
    assert.deepEqual(await badKey.json(), { error: 'API Key 无效或网关暂不可用' })
    assert.equal((await fetch(`${base}/api/public/model-catalog`, { method: 'POST' })).status, 401, '只公开 GET')

    // 发布身份公开、不缓存、只有固定字段；只公开 GET
    const release = await fetch(`${base}/api/public/release`)
    assert.equal(release.status, 200)
    assert.equal(release.headers.get('cache-control'), 'no-store')
    assert.deepEqual(Object.keys(await release.json() as object).sort(), ['commit', 'createdAt', 'env', 'releaseId', 'tag', 'version'])
    assert.equal((await fetch(`${base}/api/public/release`, { method: 'POST' })).status, 401, '只公开 GET')

    // 静态与 SPA：/docs 与深链接仍返回 index.html/docs.html，不能变成 401 页面
    const docs = await fetch(`${base}/docs`)
    assert.equal(docs.status, 200, '/docs 必须公开')
    assert.match(String(docs.headers.get('content-type')), /text\/html/)
    assert.equal(docs.headers.get('content-encoding') ?? 'none', 'none', 'docs.html <1KB 不压缩（压缩层行为未变）')

    for (const deep of ['/', '/rtk', '/cache/whatever', '/not-a-real-page']) {
      const response = await fetch(`${base}${deep}`)
      assert.equal(response.status, 200, `SPA 深链接 ${deep} 必须 200（不得变成 401 页面）`)
      const body = await response.text()
      assert.match(body, /<div id="app"|<!doctype html>/i, `${deep} 应当返回 index.html`)
    }

    // 登录后：受保护接口放行
    const okLogin = await fetch(`${base}/api/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'default-deny-password' }),
    })
    assert.equal(okLogin.status, 200)
    const cookie = String(okLogin.headers.get('set-cookie') || '').split(';')[0]
    assert.ok(cookie.includes('crosery_console_session='), '登录必须下发会话 Cookie')
    const authed = await fetch(`${base}/api/audit`, { headers: { cookie } })
    assert.equal(authed.status, 200, `带会话访问受保护接口必须 200（实际 ${authed.status}）`)

    // 撤销后：受保护接口 401，/api/session 仍是 200 + {authenticated:false}（有意行为）
    const bye = await fetch(`${base}/api/logout`, { method: 'POST', headers: { cookie } })
    assert.equal(bye.status, 200)
    const afterRevoke = await fetch(`${base}/api/audit`, { headers: { cookie } })
    assert.equal(afterRevoke.status, 401, '已撤销会话访问受保护接口必须 401')
    const sessionAfter = await fetch(`${base}/api/session`, { headers: { cookie } })
    assert.equal(sessionAfter.status, 200, '已撤销会话的 /api/session 仍必须 200（有意行为，不能改 401）')
    assert.deepEqual(await sessionAfter.json(), { authenticated: false })
    // 已撤销会话下的 SPA 深链接也必须仍是 index.html（清 Cookie 后由前端跳登录页），不能变成 401 页面
    const deepAfterRevoke = await fetch(`${base}/rtk`, { headers: { cookie } })
    assert.equal(deepAfterRevoke.status, 200, '已撤销会话的深链接仍必须 200')
    assert.match(await deepAfterRevoke.text(), /<div id="app"|<!doctype html>/i)
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n--- 子进程日志 ---\n${log.slice(-800)}`)
  } finally {
    child.kill('SIGTERM')
    await new Promise(resolve => setTimeout(resolve, 200))
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})
