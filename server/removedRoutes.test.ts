import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

/**
 * Console v3 契约 C5：凭据导入与 A/B 实验台已整体下线。
 * 已登录管理员打这两个旧写入口必须落到 `/api` 兜底 404（不是 400/500，也不落盘），
 * bootstrap 不再下发上传限额；同前缀的账号管理路由 `/api/credentials/:name` 仍然在线。
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
      GATEWAY_ENGINE: 'magpie',
      MAGPIE_CONTROL_PLANE: 'local',
      MAGPIE_PORT: String(await freePort()),
      CPA_BASE_URL: 'http://127.0.0.1:9',
      CPA_MANAGEMENT_KEY: 'unused-in-local-mode',
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

test('凭据导入与 A/B 投票接口已下线：管理员请求落到 404 兜底，账号管理路由仍在', { timeout: 120_000 }, async () => {
  const harness = await startHarness()
  try {
    const login = await fetch(`${harness.base}/api/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'correct-horse-battery' }),
    })
    assert.equal(login.status, 200, `管理员登录失败：${login.status}\n${harness.logs().slice(-400)}`)
    const cookie = String(login.headers.get('set-cookie') || '').split(';')[0]

    const form = new FormData()
    form.set('file', new Blob([JSON.stringify({ type: 'xai', access_token: 'a', refresh_token: 'r' })]), 'xai-one.json')
    const upload = await fetch(`${harness.base}/api/credentials/upload`, { method: 'POST', headers: { cookie }, body: form })
    assert.equal(upload.status, 404, `上传入口必须已下线：${upload.status}`)
    assert.deepEqual(await upload.json(), { error: '接口不存在' })
    assert.equal(fs.existsSync(path.join(harness.dataDir, 'auth-files', 'xai-one.json')), false, '不得落盘任何上传内容')

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

    // 同前缀的账号管理路由必须仍被路由命中：返回的是业务 404（credential_not_found），而不是兜底的「接口不存在」。
    const toggle = await fetch(`${harness.base}/api/credentials/ghost-cred.json`, {
      method: 'PATCH', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    })
    const toggleBody = await toggle.json() as { reason?: string }
    assert.equal(toggle.status, 404)
    assert.equal(toggleBody.reason, 'credential_not_found')
  } finally {
    await stopHarness(harness)
  }
})
