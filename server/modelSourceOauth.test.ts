import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import { createServer } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

/**
 * 回归：`PATCH /api/model-index/:model/sources/:channel` 在 `kind:'oauth'` 时，「渠道」是账号池 provider，
 * 必须按凭据的 type 校验存在性。修前它查兼容渠道表，账号池来源恒 404（网页 ModelSheet 与 cradmin 都受影响）。
 * 真子进程 + 本机控制面 + 临时 DATA_DIR；临时凭据走合法的 OAuth start/callback 落盘。
 */

const REPO = new URL('../', import.meta.url).pathname
const PASSWORD = 'model-source-oauth-pass'

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address ? address.port : 0
      probe.close(() => (port ? resolve(port) : reject(new Error('拿不到空闲端口'))))
    })
  })
}

type Harness = { base: string; child: ChildProcess; tmp: string; cookie: string }

async function startHarness(): Promise<Harness> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crosery-model-source-oauth-'))
  // 本机 OAuth 模拟器已退役（410），账号池凭据直接以夹具落盘
  const authDir = path.join(tmp, 'data', 'auth-files')
  fs.mkdirSync(authDir, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(authDir, 'codex-fixture.json'), JSON.stringify({ type: 'codex', provider: 'codex', email: 'fixture@example.test', access_token: 'fixture-token' }), { mode: 0o600 })
  const port = await freePort()
  const env: Record<string, string | undefined> = { ...process.env }
  for (const name of ['CONSOLE_PASSWORD_FILE', 'SESSION_SECRET_FILE', 'PUBLIC_GATEWAY_BASE_URL', 'MAGPIE_CHANNELS_FILE', 'MAGPIE_KERNEL_SOCKET']) delete env[name]
  for (const name of Object.keys(env)) if (name.startsWith('DATA_PLANE_') || name.startsWith('NGINX_UNLIMITED_')) delete env[name]
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: REPO,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...env,
      DATA_DIR: path.join(tmp, 'data'), PORT: String(port), HOST: '127.0.0.1',
      CONSOLE_USERNAME: 'admin', CONSOLE_PASSWORD: PASSWORD, SESSION_SECRET: 'model-source-oauth-secret', COOKIE_SECURE: 'false',
      GATEWAY_ENGINE: 'magpie', MAGPIE_CONTROL_PLANE: 'local', MAGPIE_PORT: String(await freePort()),
      CPA_BASE_URL: 'http://127.0.0.1:9', CPA_MANAGEMENT_KEY: 'unused-in-local-mode',
      RTK_HOME: path.join(tmp, 'rtkhome'), RTK_WRITE_MODE: 'off', CROSERY_SHARED_CATALOG: path.join(tmp, 'catalog.json'),
    },
  })
  let logs = ''
  child.stdout?.on('data', chunk => { logs += String(chunk) })
  child.stderr?.on('data', chunk => { logs += String(chunk) })
  const base = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 25_000
  for (;;) {
    if (child.exitCode !== null) throw new Error(`服务子进程提前退出：${child.exitCode}\n${logs}`)
    try {
      if ((await fetch(`${base}/api/session`)).status < 500) break
    } catch { /* 还没起来 */ }
    if (Date.now() > deadline) throw new Error(`服务 25 秒内没起来\n${logs}`)
    await new Promise(resolve => setTimeout(resolve, 150))
  }
  const login = await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: PASSWORD }),
  })
  assert.equal(login.status, 200)
  return { base, child, tmp, cookie: String(login.headers.get('set-cookie') || '').split(';')[0] }
}

async function stopHarness(harness: Harness): Promise<void> {
  harness.child.kill('SIGTERM')
  await new Promise(resolve => setTimeout(resolve, 300))
  if (harness.child.exitCode === null) harness.child.kill('SIGKILL')
  fs.rmSync(harness.tmp, { recursive: true, force: true })
}

async function call(harness: Harness, method: string, pathname: string, body?: unknown) {
  const response = await fetch(`${harness.base}${pathname}`, {
    method,
    headers: { cookie: harness.cookie, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() as Record<string, any> }
}

test('账号池来源的模型开关：provider 存在时生效，未知 provider 仍 404，兼容渠道行为不变', { timeout: 120_000 }, async () => {
  const harness = await startHarness()
  try {
    const index = await call(harness, 'GET', '/api/model-index')
    const model = (index.body.models as Array<{ id: string; sources: Array<{ channel: string; kind: string }> }>)
      .find(entry => entry.sources.some(source => source.channel === 'codex' && source.kind === 'oauth'))?.id
    assert.ok(model, '临时 codex 凭据应当带出至少一个 oauth 来源的模型')
    const route = `/api/model-index/${encodeURIComponent(model)}/sources/codex`

    const disabled = await call(harness, 'PATCH', route, { kind: 'oauth', enabled: false })
    assert.equal(disabled.status, 200, `修前这里恒为 404 channel_not_found：${JSON.stringify(disabled.body)}`)
    const sourceOf = async () => ((await call(harness, 'GET', '/api/model-index')).body.models as Array<{ id: string; sources: Array<{ channel: string; kind: string; enabled: boolean }> }>)
      .find(entry => entry.id === model)?.sources.find(source => source.channel === 'codex' && source.kind === 'oauth')
    assert.equal((await sourceOf())?.enabled, false)

    const enabled = await call(harness, 'PATCH', route, { kind: 'oauth', enabled: true })
    assert.equal(enabled.status, 200)
    assert.equal((await sourceOf())?.enabled, true)

    const unknown = await call(harness, 'PATCH', `/api/model-index/${encodeURIComponent(model)}/sources/no-such-provider`, { kind: 'oauth', enabled: false })
    assert.equal(unknown.status, 404)
    assert.equal(unknown.body.reason, 'channel_not_found')

    // compat 仍查兼容渠道表：provider 名不是兼容渠道 → 404（行为不变）
    const compat = await call(harness, 'PATCH', route, { kind: 'compat', enabled: false })
    assert.equal(compat.status, 404)
    assert.equal(compat.body.reason, 'channel_not_found')
  } finally {
    await stopHarness(harness)
  }
})
