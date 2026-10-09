import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import { createServer, type Server } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

/**
 * task-66 回归：「凭据启用/禁用」与「凭据级代理」发往 CPA 管理面的请求方言**没有变**；
 * 另有通用错误体的 reason 与渠道类路由「目标不存在」的 404。
 *
 * 用例都是**真子进程 + 生产模式参数 + 真实 HTTP 路由**（不 mock 路由层）。
 * 文件名沿用 task-66（docs/qa 引用它）；当年的本机控制面已随 Magpie 下线。
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

/** 记录收到的每一个上游请求：「方言未变」断言靠它。 */
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

/* ────────────────── ① 请求方言不变 ────────────────── */

test('发往 CPA 的仍是 PATCH /auth-files/status 与 PATCH /auth-files/fields', { timeout: 120_000 }, async () => {
  const stub = await startRecordingStub()
  const harness = await startHarness({
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
    assert.equal(disable.status, 200, `禁用必须成功：${disable.status} ${await disable.text()}`)

    const setProxy = await fetch(`${harness.base}/api/credentials/${encodeURIComponent(name)}/proxy`, {
      method: 'PATCH', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ proxyUrl: 'http://127.0.0.1:7890' }),
    })
    assert.equal(setProxy.status, 200, `设置代理必须成功：${setProxy.status} ${await setProxy.text()}`)

    const status = stub.requests.find(entry => entry.url.includes('/auth-files/status'))
    assert.ok(status, `远端必须收到 /auth-files/status：${JSON.stringify(stub.requests.map(r => `${r.method} ${r.url}`))}`)
    assert.equal(status.method, 'PATCH', '远端方言必须仍是 PATCH')
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

/* ────────────────── ② 已知 reason 映射 ────────────────── */

test('通用错误体带上已知 reason：invalid_json / payload_too_large', { timeout: 120_000 }, async () => {
  const harness = await startHarness({
    CPA_BASE_URL: 'http://127.0.0.1:9',
    CPA_MANAGEMENT_KEY: 'unused-by-these-routes',
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

/* ────────────────── ③ 目标不存在（task-68） ────────────────── */

test('渠道类路由：目标不存在返回 404 channel_not_found（不再报"未启用/不存在或已停用"）', { timeout: 120_000 }, async () => {
  const stub = await startRecordingStub()
  const harness = await startHarness({
    CPA_BASE_URL: `http://127.0.0.1:${stub.port}`,
    CPA_MANAGEMENT_KEY: 'test-management-key',
  })
  try {
    const cookie = await login(harness)
    for (const [label, path_, method, body] of [
      ['PATCH /api/channels/:name', '/api/channels/ghost-channel', 'PATCH', { enabled: false }],
      ['PATCH /api/channels/:name/models/:model', '/api/channels/ghost-channel/models/ghost-model', 'PATCH', { enabled: false }],
      ['PATCH /api/model-index/:model/sources/:channel', '/api/model-index/ghost-model/sources/ghost-channel', 'PATCH', { enabled: false }],
    ] as const) {
      const response = await fetch(`${harness.base}${path_}`, {
        method, headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body),
      })
      const payload = await response.json() as { reason?: string; error?: string }
      assert.equal(response.status, 404, `${label} 目标不存在必须 404：${response.status} ${JSON.stringify(payload)}`)
      assert.equal(payload.reason, 'channel_not_found', label)
    }
  } finally {
    await stopHarness(harness)
    stub.server.close()
  }
})
