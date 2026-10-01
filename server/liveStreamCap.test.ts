import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import { createServer, type Server } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { Response } from 'express'

/**
 * SSE 并发上限（task-76）。
 *
 * 红队句柄泄漏审计：9 个长期结构里 8 个有上界，**只有 `clients` 集合没有**（只受 OS 句柄限制）。
 * 这条不是"已经漏了"，而是"没有上限保护"——一个卡住的客户端就能吃光句柄。
 *
 * 覆盖：① 超上限被拒（模块返回 null / HTTP 503 + Retry-After + 可读原因）
 *      ② 断开释放计数后可再连（含**异常断开**：客户端粗暴 destroy，不是正常 close）
 *      ③ ≤上限的多路订阅不受影响
 *      ④ 两种负向验证：去掉上限 → 用例①必红；去掉释放 → 用例②必红
 */

const { addClient, addBufferedClient, broadcast, clientCount, hasClientCapacity, sseClientLimit, toLiveEvent } =
  await import('./liveStream.js')

const fakeRes = () => {
  const frames: string[] = []
  const res = {
    writableEnded: false,
    write: (chunk: string) => { frames.push(chunk); return true },
    end: () => { (res as { writableEnded: boolean }).writableEnded = true },
  }
  return { res: res as unknown as Response, frames }
}

const withLimit = async (limit: number, fn: () => Promise<void> | void) => {
  const previous = process.env.SSE_MAX_CLIENTS
  process.env.SSE_MAX_CLIENTS = String(limit)
  try { await fn() } finally {
    if (previous === undefined) delete process.env.SSE_MAX_CLIENTS
    else process.env.SSE_MAX_CLIENTS = previous
  }
}

test('上限可配置：SSE_MAX_CLIENTS 生效，未设置时默认 16（单管理员控制台 1–2 个订阅的 8–16 倍余量）', async () => {
  const previous = process.env.SSE_MAX_CLIENTS
  delete process.env.SSE_MAX_CLIENTS
  assert.equal(sseClientLimit(), 16, '默认值 16')
  process.env.SSE_MAX_CLIENTS = '3'
  assert.equal(sseClientLimit(), 3)
  process.env.SSE_MAX_CLIENTS = 'abc'
  assert.equal(sseClientLimit(), 16, '非法值回落默认')
  process.env.SSE_MAX_CLIENTS = '0'
  assert.equal(sseClientLimit(), 16, '0/负数无意义 → 回落默认')
  if (previous === undefined) delete process.env.SSE_MAX_CLIENTS
  else process.env.SSE_MAX_CLIENTS = previous
})

test('用例①：连满后第 N+1 个注册被**拒绝**（返回 null，不是静默加入）', async () => {
  await withLimit(3, () => {
    assert.equal(clientCount(), 0, '前置：无连接')
    const a = addClient(fakeRes().res)
    const b = addClient(fakeRes().res)
    const c = addClient(fakeRes().res)
    assert.ok(a && b && c, '前 3 条应当成功')
    assert.equal(clientCount(), 3)
    assert.equal(hasClientCapacity(), false)

    const rejected = addClient(fakeRes().res)
    assert.equal(rejected, null, '超过上限必须被拒绝（调用方据此回 503）')
    assert.equal(clientCount(), 3, '被拒的连接不能计入')
    const rejectedBuffered = addBufferedClient(fakeRes().res)
    assert.equal(rejectedBuffered, null, '缓冲注册路径同样受限')
    assert.equal(clientCount(), 3)

    a!(); b!(); c!()
    assert.equal(clientCount(), 0, '清理后归零')
  })
})

test('用例②：断开一个后计数回落、可再次连接（连满 → 拒绝 → 断开 → 成功）', async () => {
  await withLimit(2, () => {
    const first = addClient(fakeRes().res)
    const second = addClient(fakeRes().res)
    assert.ok(first && second)
    assert.equal(addClient(fakeRes().res), null, '满员时拒绝')
    assert.equal(clientCount(), 2)

    first!()                                   // = req.on('close') 的释放路径
    assert.equal(clientCount(), 1, '断开必须释放计数（只加不减就是另一个泄漏）')
    assert.equal(hasClientCapacity(), true)

    const third = addClient(fakeRes().res)
    assert.ok(third, '释放后应当能再连')
    assert.equal(clientCount(), 2)
    third!(); second!()
    assert.equal(clientCount(), 0)
  })
})

test('用例③：≤上限的多路订阅不受影响（广播照常到达每个客户端）', async () => {
  await withLimit(4, () => {
    const targets = [fakeRes(), fakeRes(), fakeRes()]
    const unsubscribes: Array<(() => void) | null> = []
    try {
      for (const target of targets) unsubscribes.push(addClient(target.res))
      assert.ok(unsubscribes.every(Boolean), '上限内的 3 条都该成功')
      // broadcast 只把 `success` 事件算进"已投递"（失败请求没有可比较的缓存命中）
      const delivered = broadcast([toLiveEvent({ requestId: 'cap-1', model: 'claude-opus-5', inputTokens: 10, success: true } as never)])
      assert.equal(delivered, 3, '广播应到达 3 个客户端')
      for (const target of targets) assert.equal(target.frames.length, 1)
    } finally {
      // 无论断言是否失败都要撤销：否则客户端会残留，污染后面的用例（这是测试自身的卫生问题）
      unsubscribes.forEach((unsubscribe) => unsubscribe?.())
    }
    assert.equal(clientCount(), 0)
  })
})

test('负向验证 A：**去掉上限**后，用例①的期望必然落空（演示"必红"）', async () => {
  // 把上限放到极大 = 等价于"没有上限"（红队指出的原始状态）。同一个断言在这里会失败：
  await withLimit(1_000_000, () => {
    const handle = addClient(fakeRes().res)
    assert.ok(handle, '无上限时当然能连上')
    // 用例①断言"第 N+1 个被拒绝"——在无上限配置下 registerClient 返回的是客户端而不是 null，
    // 所以那条断言会红。这里显式把它写出来，证明用例①真的能抓住"去掉上限"。
    const withCapRemoved = addClient(fakeRes().res)
    assert.notEqual(withCapRemoved, null, '无上限 ⇒ 永远不会返回 null ⇒ 用例①必然失败')
    handle!(); withCapRemoved!()
  })
})

test('负向验证 B：**去掉释放**（不断开就再连）后，用例②的期望必然落空（演示"必红"）', async () => {
  await withLimit(1, () => {
    assert.equal(clientCount(), 0, '前置：不应有残留连接（前面用例必须自己清理）')
    const first = addClient(fakeRes().res)
    assert.ok(first)
    // 模拟"路由忘了在 close 里调用 remove()"：不调用 first()，直接再连
    const second = addClient(fakeRes().res)
    assert.equal(second, null, '没有释放 ⇒ 计数永远占着 ⇒ 再连被拒')
    assert.equal(clientCount(), 1, '用例②要求"断开后计数回落到 0 并可再连"，在缺失释放时必然失败')
    first!()                                   // 收尾
    assert.equal(clientCount(), 0)
  })
})

/* ─────────── 端到端（真起服务）：503 + Retry-After + 异常断开释放 ─────────── */

const REPO = new URL('../', import.meta.url).pathname

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createServer()
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address ? address.port : 0
      probe.close(() => resolve(port))
    })
  })
}

async function startCpaStub(): Promise<{ server: Server; port: number }> {
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'application/json')
    res.end('{}')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return { server, port: typeof address === 'object' && address ? address.port : 0 }
}

type Harness = { base: string; child: ChildProcess; dataDir: string; logs: () => string }

async function startHarness(stubPort: number, extraEnv: Record<string, string>): Promise<Harness> {
  const port = await freePort()
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crosery-sse-cap-'))
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: REPO,
    env: {
      ...process.env,
      DATA_DIR: dataDir, PORT: String(port), HOST: '127.0.0.1',
      CPA_BASE_URL: `http://127.0.0.1:${stubPort}`, CPA_MANAGEMENT_KEY: 'test',
      MAGPIE_CONTROL_PLANE: 'local', MAGPIE_PORT: String(stubPort),
      CONSOLE_USERNAME: 'admin', CONSOLE_PASSWORD: 'sse-cap-password', SESSION_SECRET: 'sse-cap-secret',
      COOKIE_SECURE: 'false',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let buffer = ''
  child.stdout?.on('data', (chunk) => (buffer += String(chunk)))
  child.stderr?.on('data', (chunk) => (buffer += String(chunk)))
  const base = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 25_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`服务提前退出：${child.exitCode}\n${buffer}`)
    try {
      const res = await fetch(`${base}/api/session`)
      if (res.status < 500) break
    } catch { /* 还没起来 */ }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  return { base, child, dataDir, logs: () => buffer }
}

async function stopHarness(harness: Harness) {
  harness.child.kill('SIGTERM')
  await new Promise((resolve) => setTimeout(resolve, 300))
  if (harness.child.exitCode === null) harness.child.kill('SIGKILL')
  fs.rmSync(harness.dataDir, { recursive: true, force: true })
}

/** 打开一条 SSE 连接并保持；返回 `{ destroy }`（destroy = 粗暴断开，模拟客户端被杀）。 */
function openSse(base: string, cookie: string, onStatus: (status: number, headers: http.IncomingHttpHeaders) => void) {
  const request = http.get(`${base}/api/cache-live?limit=5`, { headers: { cookie, accept: 'text/event-stream' } }, (res) => {
    onStatus(res.statusCode ?? 0, res.headers)
    res.on('data', () => undefined)
  })
  request.on('error', () => undefined)
  return request
}

const adminCookie = async (base: string) => {
  const login = await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'sse-cap-password' }),
  })
  assert.equal(login.status, 200, '测试实例登录必须成功')
  return (login.headers.get('set-cookie') ?? '').split(';')[0]
}

const waitFor = async (predicate: () => Promise<boolean>, timeoutMs = 8000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  return false
}

test('端到端：连满 → 503 + Retry-After + 可读原因 → **异常断开**释放 → 再连成功', async () => {
  const stub = await startCpaStub()
  let harness: Harness | null = null
  try {
    harness = await startHarness(stub.port, { SSE_MAX_CLIENTS: '1' })
    const base = harness.base
    const cookie = await adminCookie(base)
    const statusOf = async () => {
      const res = await fetch(`${base}/api/cache-live/status`, { headers: { cookie } })
      return res.json() as Promise<{ clients: number; limit: number }>
    }
    const initial = await statusOf()
    assert.equal(initial.clients, 0, '前置：无 SSE 连接')
    assert.equal(initial.limit, 1, '状态载荷要能看到上限（运维不必猜）')

    // 第 1 条：正常建立
    let firstStatus = 0
    const first = openSse(base, cookie, (status) => { firstStatus = status })
    assert.ok(await waitFor(async () => (await statusOf()).clients === 1), '第 1 条应连上且计入')
    assert.equal(firstStatus, 200)

    // 第 2 条：超上限 → 503 + Retry-After + 可读原因
    const rejected = await fetch(`${base}/api/cache-live?limit=5`, { headers: { cookie } })
    assert.equal(rejected.status, 503, '超上限必须显式 503')
    assert.ok(rejected.headers.get('retry-after'), '必须带 Retry-After')
    const body = await rejected.json() as { error?: string; clients?: number; limit?: number }
    assert.match(String(body.error ?? ''), /上限|稍后重试/, `503 要有可读原因：${JSON.stringify(body)}`)
    assert.equal(body.limit, 1)
    assert.equal((await statusOf()).clients, 1, '被拒的连接不能计入')

    // 异常断开：直接 destroy socket（模拟客户端进程被杀 / 网络 RST），不是正常 close
    first.destroy()
    assert.ok(await waitFor(async () => (await statusOf()).clients === 0), '异常断开后计数必须回落（req.on("close") 在这里也要触发）')

    // 释放后可以再连
    let secondStatus = 0
    const second = openSse(base, cookie, (status) => { secondStatus = status })
    assert.ok(await waitFor(async () => (await statusOf()).clients === 1), '释放后应能再连上')
    assert.equal(secondStatus, 200)
    second.destroy()
    assert.ok(await waitFor(async () => (await statusOf()).clients === 0))
  } finally {
    if (harness) await stopHarness(harness)
    await new Promise<void>((resolve) => stub.server.close(() => resolve()))
  }
})
