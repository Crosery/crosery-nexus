import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

/**
 * 已下线的接口：A/B 实验台（Console v3 契约 C5）与 Magpie 内核的接口（2026-10-09 随内核一起下线：网关功能设置、
 * 内核更新、账号页的内核登录与额度）。已登录管理员打这些旧入口必须落到 `/api` 兜底 404（不是 400/500，也不落盘），
 * bootstrap 不再下发上传限额；同前缀仍在线的路由（`/api/credentials/:name`、`/api/accounts`）照常命中。
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

type Harness = { base: string; child: ChildProcess; dataDir: string; logs: () => string }

async function startHarness(): Promise<Harness> {
  const port = await freePort()
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crosery-removed-routes-'))
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: REPO,
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      PORT: String(port),
      HOST: '127.0.0.1',
      CONSOLE_USERNAME: 'admin',
      CONSOLE_PASSWORD: 'correct-horse-battery',
      SESSION_SECRET: 'removed-routes-secret',
      COOKIE_SECURE: 'false',
      CPA_BASE_URL: 'http://127.0.0.1:9',
      CPA_MANAGEMENT_KEY: 'unused-by-these-routes',
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

const MAGPIE_ROUTES: Array<[string, string, unknown?]> = [
  ['GET', '/api/gateway/settings'],
  ['PUT', '/api/gateway/settings', { redact: true }],
  ['GET', '/api/magpie/update-status'],
  ['POST', '/api/magpie/update', { action: 'apply', confirm: true }],
  ['POST', '/api/accounts/signin', { agent: 'codex' }],
  ['GET', '/api/accounts/signin/flow1x'],
  ['POST', '/api/accounts/signin/flow1x/callback', { url: 'http://localhost:1455/auth/callback?code=x' }],
  ['POST', '/api/accounts/signin/flow1x/cancel', {}],
  ['POST', '/api/accounts/login/on', { agent: 'codex', id: '0123456789abcdef' }],
  ['POST', '/api/accounts/codex-reset', { id: '0123456789abcdef' }],
  ['POST', '/api/accounts/quota/refresh', {}],
]

test('A/B 投票与 Magpie 内核的接口已下线：管理员请求落到 404 兜底，同前缀的在线路由仍在', { timeout: 120_000 }, async () => {
  const harness = await startHarness()
  try {
    const login = await fetch(`${harness.base}/api/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'correct-horse-battery' }),
    })
    assert.equal(login.status, 200, `管理员登录失败：${login.status}\n${harness.logs().slice(-400)}`)
    const cookie = String(login.headers.get('set-cookie') || '').split(';')[0]

    const vote = await fetch(`${harness.base}/api/ab/preference`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ flow: 'keys-access', choice: 'a' }),
    })
    assert.equal(vote.status, 404, `A/B 投票入口必须已下线：${vote.status}`)
    assert.deepEqual(await vote.json(), { error: '接口不存在' })
    assert.equal(fs.existsSync(path.join(harness.dataDir, 'ab-preferences.jsonl')), false)

    const bootstrap = await fetch(`${harness.base}/api/bootstrap`, { headers: { cookie } })
    assert.equal(bootstrap.status, 200)
    assert.equal('credentialUploadLimits' in (await bootstrap.json() as Record<string, unknown>), false)

    for (const [method, route, body] of MAGPIE_ROUTES) {
      const response = await fetch(`${harness.base}${route}`, {
        method, headers: { cookie, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
      })
      assert.equal(response.status, 404, `${method} ${route} 必须已下线：${response.status}`)
      assert.deepEqual(await response.json(), { error: '接口不存在' }, `${method} ${route}`)
    }

    // 同前缀的路由必须仍被路由命中，而不是兜底的「接口不存在」。
    const toggle = await fetch(`${harness.base}/api/credentials/ghost-cred.json`, {
      method: 'PATCH', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    })
    assert.notDeepEqual(await toggle.json(), { error: '接口不存在' })
    const accounts = await fetch(`${harness.base}/api/accounts`, { headers: { cookie } })
    assert.equal(accounts.status, 200)
    assert.equal((await accounts.json() as { backend?: string }).backend, 'cpa')
  } finally {
    await stopHarness(harness)
  }
})
