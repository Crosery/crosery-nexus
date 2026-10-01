import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import { createServer, type Server } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

/**
 * task-66 回归：**local 控制面**下「凭据启用/禁用」与「凭据级代理」必须真正生效；
 * 同时证明 **cpa（远端）模式**的请求方言**没有变**。
 *
 * 背景（红队第十八轮副作用发现）：`cpa.ts` 按远端 CPA 的管理面发
 * `PATCH /auth-files/status`、`PATCH /auth-files/fields`，而本地 shim 只认
 * `PUT /auth-files/status`、`PUT /auth-files/proxy` → 本机控制台这两个操作 100% 400。
 * 修法是在 `cpaRequest` 的 local 分支做**单点方言翻译**，这些用例把它钉住。
 *
 * 用例都是**真子进程 + 生产模式参数 + 真实 HTTP 路由**（不 mock 路由层）。
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

type RecordedRequest = { method: string; url: string; body: string }

/** 记录收到的每一个上游请求：cpa 模式的「方言未变」断言靠它。 */
async function startRecordingStub(): Promise<{ server: Server; port: number; requests: RecordedRequest[] }> {
  const requests: RecordedRequest[] = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += String(chunk) })
    req.on('end', () => {
      requests.push({ method: req.method || '', url: req.url || '', body })
      res.setHeader('content-type', 'application/json')
      // 形状贴近真实 CPA：Key 列表用 {'api-keys': []}，其余管理面端点给空对象。
      // （给 {ok:true} 会让 reconcile 路径把某个 boolean 当可迭代对象 → 400，那是**桩**的形状问题，
      //   不是被测代码的问题；已用 /tmp/cpa-mode-probe.mjs 定位过。）
      if ((req.url || '').startsWith('/api-keys')) return void res.end(JSON.stringify({ 'api-keys': [] }))
      res.end(JSON.stringify({}))
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return { server, port: typeof address === 'object' && address ? address.port : 0, requests }
}

type Harness = { base: string; child: ChildProcess; dataDir: string; logs: () => string }

async function startHarness(env: Record<string, string>): Promise<Harness> {
  const port = await freePort()
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crosery-local-control-'))
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: REPO,
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      PORT: String(port),
      HOST: '127.0.0.1',
      CONSOLE_USERNAME: 'admin',
      CONSOLE_PASSWORD: 'correct-horse-battery',
      SESSION_SECRET: 'local-control-secret',
      COOKIE_SECURE: 'false',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let buffer = ''
  child.stdout?.on('data', chunk => { buffer += String(chunk) })
  child.stderr?.on('data', chunk => { buffer += String(chunk) })
  const base = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 25_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`服务子进程提前退出：${child.exitCode}\n${buffer}`)
    try {
      const response = await fetch(`${base}/api/session`)
      if (response.status < 500) break
    } catch { /* 还没起来 */ }
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  return { base, child, dataDir, logs: () => buffer }
}

async function stopHarness(harness: Harness): Promise<void> {
  harness.child.kill('SIGTERM')
  await new Promise(resolve => setTimeout(resolve, 300))
  if (harness.child.exitCode === null) harness.child.kill('SIGKILL')
  fs.rmSync(harness.dataDir, { recursive: true, force: true })
}

async function login(harness: Harness): Promise<string> {
  const response = await fetch(`${harness.base}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'correct-horse-battery' }),
  })
  assert.equal(response.status, 200)
  return String(response.headers.get('set-cookie') || '').split(';')[0]
}

const readMeta = (dataDir: string): Record<string, { disabled?: boolean; proxy_url?: string }> => {
  const file = path.join(dataDir, 'auth-files-meta.json')
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return {} }
}

/* ────────────────── ① local 控制面：两个操作真正生效 ────────────────── */

test('local 控制面：凭据启用/禁用与凭据级代理写入 200 且状态真的变了（含回读）', { timeout: 120_000 }, async () => {
  const harness = await startHarness({
    GATEWAY_ENGINE: 'magpie',
    MAGPIE_CONTROL_PLANE: 'local',
    MAGPIE_PORT: String(await freePort()),
    CPA_BASE_URL: 'http://127.0.0.1:9',
    CPA_MANAGEMENT_KEY: 'unused-in-local-mode',
  })
  try {
    const cookie = await login(harness)
    const authDir = path.join(harness.dataDir, 'auth-files')

    // 临时凭据：走**合法** OAuth 流程落盘（不触碰任何真实凭据）
    const start = await fetch(`${harness.base}/api/cpa/oauth/start`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'claude' }),
    })
    assert.equal(start.status, 200)
    const started = await start.json() as { state?: string }
    const callback = await fetch(`${harness.base}/api/cpa/oauth/callback`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'claude', redirectUrl: 'https://example.com/cb?code=abc', state: started.state }),
    })
    assert.equal(callback.status, 200, `OAuth 回调必须成功：${callback.status} ${await callback.text()}`)
    const name = fs.readdirSync(authDir).find(entry => entry.endsWith('.json'))
    assert.ok(name, `auth-files 里应当有刚创建的凭据：${JSON.stringify(fs.readdirSync(authDir))}`)

    // 禁用 → 200 且 meta 真的写了
    const disable = await fetch(`${harness.base}/api/credentials/${encodeURIComponent(name)}`, {
      method: 'PATCH', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    })
    const disableText = await disable.text()
    assert.equal(disable.status, 200, `禁用必须 200（修前是 400）：${disable.status} ${disableText}`)
    assert.equal(readMeta(harness.dataDir)[name]?.disabled, true, 'meta 里的 disabled 必须为 true')

    // 重新启用 → 200 且 meta 跟着变
    const enable = await fetch(`${harness.base}/api/credentials/${encodeURIComponent(name)}`, {
      method: 'PATCH', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    })
    assert.equal(enable.status, 200, `启用必须 200：${enable.status} ${await enable.text()}`)
    assert.equal(readMeta(harness.dataDir)[name]?.disabled, false, 'meta 里的 disabled 必须为 false')

    // 凭据级代理：写入 → 200 + meta 有值 + **回读一致**（修前回读永远是空串）
    const proxy = 'http://127.0.0.1:7890'
    const setProxy = await fetch(`${harness.base}/api/credentials/${encodeURIComponent(name)}/proxy`, {
      method: 'PATCH', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ proxyUrl: proxy }),
    })
    assert.equal(setProxy.status, 200, `设置代理必须 200：${setProxy.status} ${await setProxy.text()}`)
    assert.equal(readMeta(harness.dataDir)[name]?.proxy_url, proxy, 'meta 里的 proxy_url 必须写进去')
    const readProxy = await fetch(`${harness.base}/api/credentials/${encodeURIComponent(name)}/proxy`, { headers: { cookie } })
    assert.equal(readProxy.status, 200)
    assert.deepEqual(await readProxy.json(), { proxyUrl: proxy }, '回读必须与写入一致（同一语义）')

    // 清理：临时凭据必须能删掉
    const removed = await fetch(`${harness.base}/api/credentials/${encodeURIComponent(name)}`, { method: 'DELETE', headers: { cookie } })
    assert.equal(removed.status, 200, `删除临时凭据必须成功：${removed.status} ${await removed.text()}`)
    assert.equal(fs.existsSync(path.join(authDir, name)), false, '临时凭据文件必须真的被删掉')
  } finally {
    await stopHarness(harness)
  }
})

/* ────────────────── ② cpa（远端）模式：请求方言不变 ────────────────── */

test('cpa 模式未回归：发往远端的仍是 PATCH /auth-files/status 与 PATCH /auth-files/fields', { timeout: 120_000 }, async () => {
  const stub = await startRecordingStub()
  const harness = await startHarness({
    GATEWAY_ENGINE: 'cpa',
    MAGPIE_CONTROL_PLANE: 'local',
    CPA_BASE_URL: `http://127.0.0.1:${stub.port}`,
    CPA_MANAGEMENT_KEY: 'test-management-key',
  })
  try {
    const cookie = await login(harness)
    const name = 'regression-credential.json'

    const disable = await fetch(`${harness.base}/api/credentials/${encodeURIComponent(name)}`, {
      method: 'PATCH', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    })
    assert.equal(disable.status, 200, `cpa 模式下禁用必须仍然成功：${disable.status} ${await disable.text()}`)

    const setProxy = await fetch(`${harness.base}/api/credentials/${encodeURIComponent(name)}/proxy`, {
      method: 'PATCH', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ proxyUrl: 'http://127.0.0.1:7890' }),
    })
    assert.equal(setProxy.status, 200, `cpa 模式下设置代理必须仍然成功：${setProxy.status} ${await setProxy.text()}`)

    const status = stub.requests.find(entry => entry.url.includes('/auth-files/status'))
    assert.ok(status, `远端必须收到 /auth-files/status：${JSON.stringify(stub.requests.map(r => `${r.method} ${r.url}`))}`)
    assert.equal(status.method, 'PATCH', '远端方言必须仍是 PATCH（本地适配不得泄漏到远端路径）')
    assert.deepEqual(JSON.parse(status.body), { name, disabled: true })

    const fields = stub.requests.find(entry => entry.url.includes('/auth-files/fields'))
    assert.ok(fields, `远端必须收到 /auth-files/fields：${JSON.stringify(stub.requests.map(r => `${r.method} ${r.url}`))}`)
    assert.equal(fields.method, 'PATCH')
    assert.deepEqual(JSON.parse(fields.body), { name, proxy_url: 'http://127.0.0.1:7890' })
  } finally {
    await stopHarness(harness)
    stub.server.close()
  }
})

/* ────────────────── ③ 已知 reason 映射 ────────────────── */

test('通用错误体带上已知 reason：invalid_json / payload_too_large', { timeout: 120_000 }, async () => {
  const harness = await startHarness({
    GATEWAY_ENGINE: 'magpie',
    MAGPIE_CONTROL_PLANE: 'local',
    MAGPIE_PORT: String(await freePort()),
    CPA_BASE_URL: 'http://127.0.0.1:9',
    CPA_MANAGEMENT_KEY: 'unused-in-local-mode',
  })
  try {
    const malformed = await fetch(`${harness.base}/api/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json',
    })
    assert.equal(malformed.status, 400)
    const malformedBody = await malformed.json() as { error?: string; reason?: string }
    assert.equal(malformedBody.reason, 'invalid_json', `JSON 解析失败必须给出 reason：${JSON.stringify(malformedBody)}`)
    assert.equal(malformedBody.error, '请求格式不正确', '通用文案保持不变')

    const huge = await fetch(`${harness.base}/api/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'a'.repeat(2 * 1024 * 1024), password: 'x' }),
    })
    assert.equal(huge.status, 413)
    const hugeBody = await huge.json() as { error?: string; reason?: string }
    assert.equal(hugeBody.reason, 'payload_too_large', `超大 body 必须给出 reason：${JSON.stringify(hugeBody)}`)
    assert.equal(hugeBody.error, '请求体过大')
  } finally {
    await stopHarness(harness)
  }
})
