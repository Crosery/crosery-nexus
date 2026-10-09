/**
 * The real console (`server/index.ts`) as a child process for contract tests, with the route-table preload
 * (`routeTableDump.ts`): a throwaway DATA_DIR/HOME, no native responses server, admin login ready.
 */
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { RouteTableEntry } from './routeTableDump.js'

const REPO = new URL('../../', import.meta.url).pathname
const ADMIN_PASSWORD = 'contract-admin-password'

export type ConsoleReply = { status: number; headers: Headers; body: any; text: string }

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address ? address.port : 0
      probe.close(() => (port ? resolve(port) : reject(new Error('no free port'))))
    })
  })
}

export async function launchConsole(env: Record<string, string>) {
  const port = await freePort()
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cac-contract-'))
  const tableFile = path.join(dataDir, 'route-table.json')
  const child = spawn(process.execPath, ['--import', 'tsx', '--import', './server/testing/routeTableDump.ts', 'server/index.ts'], {
    cwd: REPO,
    env: {
      PATH: process.env.PATH ?? '', HOME: dataDir, TMPDIR: os.tmpdir(), DATA_DIR: dataDir,
      PORT: String(port), HOST: '127.0.0.1', NATIVE_RESPONSES_ENABLED: 'false',
      CONSOLE_USERNAME: 'admin', CONSOLE_PASSWORD: ADMIN_PASSWORD, SESSION_SECRET: 'contract-session-secret',
      COOKIE_SECURE: 'false', ROUTE_TABLE_FILE: tableFile, ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  child.stdout.on('data', chunk => { log += chunk })
  child.stderr.on('data', chunk => { log += chunk })
  const base = `http://127.0.0.1:${port}`
  const stop = async () => {
    if (child.exitCode === null) {
      child.kill('SIGTERM')
      await once(child, 'exit')
    }
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
  const deadline = Date.now() + 40_000
  for (;;) {
    if (child.exitCode !== null) { await stop(); throw new Error(`console exited early (${child.exitCode})\n${log.slice(-1500)}`) }
    try { if ((await fetch(`${base}/api/session`)).status < 500) break } catch { /* not up yet */ }
    if (Date.now() > deadline) { await stop(); throw new Error(`console did not start in 40 s\n${log.slice(-1500)}`) }
    await new Promise(resolve => setTimeout(resolve, 100))
  }

  const send = async (method: string, route: string, options: { cookie?: string; body?: unknown } = {}): Promise<ConsoleReply> => {
    const response = await fetch(`${base}${route}`, {
      method,
      headers: { 'content-type': 'application/json', ...(options.cookie ? { cookie: options.cookie } : {}) },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    })
    const text = await response.text()
    let body: any = null
    try { body = JSON.parse(text) } catch { /* not JSON */ }
    return { status: response.status, headers: response.headers, body, text }
  }
  const login = async (credentials: Record<string, string>) => {
    const reply = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(credentials) })
    if (reply.status !== 200) throw new Error(`login failed: ${reply.status} ${await reply.text()}`)
    return String(reply.headers.get('set-cookie') || '').split(';')[0]
  }
  const adminCookie = await login({ username: 'admin', password: ADMIN_PASSWORD }).catch(async (error: unknown) => { await stop(); throw error })
  /** a new key on every group the gateway lists; returns the key itself */
  const createKey = async (name: string): Promise<string> => {
    const boot = await send('GET', '/api/bootstrap', { cookie: adminCookie })
    const groups: string[] = (boot.body?.groups ?? []).map((group: { id: string }) => group.id)
    const groupConcurrency = Object.fromEntries(groups.map(id => [id, 2]))
    const created = await send('POST', '/api/keys', { cookie: adminCookie, body: { name, groups, totalConcurrency: 4, groupConcurrency } })
    if (created.status !== 201) throw new Error(`key not created: ${created.status} ${created.text}`)
    return created.body.key as string
  }

  return {
    base,
    adminCookie,
    send,
    createKey,
    /** a key-user session for `apiKey` */
    loginKey: (apiKey: string) => login({ apiKey }),
    routes: (): RouteTableEntry[] => JSON.parse(fs.readFileSync(tableFile, 'utf8')) as RouteTableEntry[],
    log: () => log,
    stop,
  }
}

export type ConsoleProcess = Awaited<ReturnType<typeof launchConsole>>
