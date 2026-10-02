// 一次性控制台实例：子进程 + 临时 DATA_DIR + 空闲端口，只供测试使用（server/index.ts 不能 import）。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { createServer } from 'node:net'
import os from 'node:os'
import path from 'node:path'

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..')

export function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      probe.close(() => resolve(address.port))
    })
  })
}

const STRIPPED = /^(CONSOLE_|SESSION_SECRET|DATA_PLANE_|NGINX_UNLIMITED_|PUBLIC_GATEWAY_BASE_URL$|MAGPIE_|CPA_|RTK_|CROSERY_|CRADMIN_|LOGIN_|PROXY_PRESETS$|GATEWAY_ENGINE$|DATA_DIR$|PORT$|HOST$)/

export async function startThrowawayServer({ password = 'cradmin-test-pass-1', env = {}, prepare } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cradmin-e2e-'))
  const dataDir = path.join(tmp, 'data')
  fs.mkdirSync(dataDir, { recursive: true })
  if (prepare) await prepare({ tmp, dataDir })
  const port = await freePort()
  const magpiePort = await freePort()
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !STRIPPED.test(name)))
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: REPO,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...inherited,
      DATA_DIR: dataDir, PORT: String(port), HOST: '127.0.0.1',
      CONSOLE_USERNAME: 'admin', CONSOLE_PASSWORD: password, SESSION_SECRET: 'cradmin-test-secret', COOKIE_SECURE: 'false',
      GATEWAY_ENGINE: 'magpie', MAGPIE_CONTROL_PLANE: 'local', MAGPIE_PORT: String(magpiePort),
      CPA_BASE_URL: 'http://127.0.0.1:9', CPA_MANAGEMENT_KEY: 'unused',
      RTK_HOME: path.join(tmp, 'rtkhome'), RTK_WRITE_MODE: 'off',
      CROSERY_SHARED_CATALOG: path.join(tmp, 'catalog.json'),
      MAGPIE_UPDATE_SCRIPT: path.join(tmp, 'none.mjs'), MAGPIE_UPDATE_ROOT: path.join(tmp, 'none'), MAGPIE_UPSTREAM_RUNTIME: path.join(tmp, 'up'),
      ...env,
    },
  })
  let logs = ''
  child.stdout.on('data', chunk => { logs += chunk })
  child.stderr.on('data', chunk => { logs += chunk })
  const base = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 25_000
  for (;;) {
    if (child.exitCode !== null) throw new Error(`一次性实例提前退出：${child.exitCode}\n${logs.slice(-2000)}`)
    try {
      const response = await fetch(`${base}/api/session`)
      if (response.status < 500) break
    } catch { /* 还没起来 */ }
    if (Date.now() > deadline) {
      child.kill('SIGKILL')
      throw new Error(`一次性实例 25 秒内没起来\n${logs.slice(-2000)}`)
    }
    await new Promise(resolve => setTimeout(resolve, 150))
  }
  async function stop() {
    if (child.exitCode === null) {
      child.kill('SIGTERM')
      await new Promise(resolve => setTimeout(resolve, 300))
      if (child.exitCode === null) child.kill('SIGKILL')
    }
    fs.rmSync(tmp, { recursive: true, force: true })
  }
  return { base, port, password, tmp, dataDir, child, stop, logs: () => logs }
}

/** 测试里直接打服务端（不经 CLI）：登录拿 cookie，再发请求。 */
export async function adminCall(server, method, pathname, body) {
  if (!server.cookie) {
    const login = await fetch(`${server.base}/api/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: server.password }),
    })
    if (login.status !== 200) throw new Error(`测试登录失败 ${login.status}`)
    server.cookie = login.headers.getSetCookie()[0].split(';')[0]
  }
  const response = await fetch(`${server.base}${pathname}`, {
    method,
    headers: { cookie: server.cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  let json
  try { json = JSON.parse(text) } catch { json = text }
  return { status: response.status, body: json }
}
