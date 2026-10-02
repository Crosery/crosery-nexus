import { createHash } from 'node:crypto'
import { once } from 'node:events'
import fs from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import os from 'node:os'
import path from 'node:path'

/**
 * A scripted stand-in for the console kernel's private socket (deploy/magpie/kernel), same routes and JSON
 * shapes: health with capabilities, sign-in flows whose state a test moves by hand, the account store, usage
 * and Codex resets. Every call is recorded. Not a Magpie: no vendor, no listener, no credential.
 */

export type FakeLogin = { agent: string; user: string; plan?: string; active?: boolean; on?: boolean; own?: boolean; lapsed?: string }
export type FakeFlow = {
  id: string; agent: string; url: string; code?: string; state: string
  pasteCallback?: boolean; installing?: string; user?: string; plan?: string; using?: boolean; error?: string
}
export type FakeCall = { method: string; path: string; body: unknown }

export const PIN_REVISION = '3fe2ff99587e17dfe0ea707ffd0eccc088824433'
export const LOGIN_AGENTS = ['antigravity', 'claude', 'codex', 'commandcode-plan', 'copilot', 'cursor', 'devin', 'dimagent', 'factory',
  'gemini', 'grok', 'kiro', 'mimo-app', 'qoder', 'workbuddy', 'workbuddy-ai', 'zcode', 'zed']

export class FakeKernel {
  readonly calls: FakeCall[] = []
  /** 'ok' = today's kernel; 'old' = a binary from before the account routes; an object overrides health fields */
  health: Record<string, unknown> | 'old' | 'ok' = 'ok'
  signinDeny = ['cursor', 'devin', 'grok']
  loginAgents = [...LOGIN_AGENTS]
  readonly flows = new Map<string, FakeFlow>()
  logins: FakeLogin[] = []
  usage: Record<string, Record<string, unknown>> = {}
  usageStatus = 200
  resetCode = 'reset'
  /** the loopback port a relay flow's redirect_uri names */
  listenerPort = 0
  /** next sign-in start answers this instead of a flow */
  nextStartError: { status: number; code: string; error: string } | null = null
  /** agents that start in `installing` (no URL yet) */
  installing = new Set<string>()
  private seq = 0
  private server: Server | null = null
  socket = ''
  private directory = ''

  async start(): Promise<this> {
    this.directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cac-fk-'))
    this.socket = path.join(this.directory, 'k.sock')
    this.server = createServer((req, res) => { void this.handle(req, res) })
    this.server.listen(this.socket)
    await once(this.server, 'listening')
    return this
  }

  async stop(): Promise<void> {
    if (this.server) await new Promise<void>(resolve => this.server!.close(() => resolve()))
    fs.rmSync(this.directory, { recursive: true, force: true })
  }

  count(method: string, prefix: string): number {
    return this.calls.filter(call => call.method === method && call.path.startsWith(prefix)).length
  }

  set(id: string, patch: Partial<FakeFlow>): void {
    const flow = this.flows.get(id)
    if (!flow) throw new Error(`no fake flow ${id}`)
    Object.assign(flow, patch)
  }

  /** a flow started outside this console (another client of the same kernel) */
  foreignFlow(agent = 'copilot'): string {
    const id = `foreign${++this.seq}`
    this.flows.set(id, { id, agent, url: 'https://github.com/login/device', state: 'waiting' })
    return id
  }

  private healthBody(): Record<string, unknown> {
    if (this.health === 'old') return { engine: 'magpie', ok: true, revision: PIN_REVISION }
    const base = {
      ok: true, engine: 'magpie', revision: PIN_REVISION,
      capabilities: ['providers', 'rtk', 'signin', 'accounts', 'usage', 'codex-reset'],
      loginAgents: this.loginAgents, signinDeny: this.signinDeny, keychain: false,
    }
    return this.health === 'ok' ? base : { ...base, ...this.health }
  }

  private url(agent: string, state: string): string {
    const redirect = (route: string, host = 'localhost') => encodeURIComponent(`http://${host}:${this.listenerPort}${route}`)
    switch (agent) {
      case 'claude': return `https://claude.com/cai/oauth/authorize?code=true&redirect_uri=${redirect('/callback')}&state=${state}`
      case 'codex': return `https://auth.openai.com/oauth/authorize?redirect_uri=${redirect('/auth/callback')}&state=${state}`
      case 'gemini': return `https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=${redirect('/oauth2callback', '127.0.0.1')}&state=${state}`
      case 'antigravity': return `https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=${redirect('/oauth-callback')}&state=${state}`
      case 'kiro': return `https://app.kiro.dev/signin?state=${state}&redirect_uri=${redirect('')}`
      case 'devin': return `https://app.devin.ai/auth/cli/continue?redirect_uri=${redirect('/callback', '127.0.0.1')}&state=${state}`
      case 'copilot': return 'https://github.com/login/device'
      case 'dimagent': return `https://dimagent.cn/oauth/authorize?state=${state}`
      default: return `https://example.test/${agent}/signin?state=${state}`
    }
  }

  private loginView(login: FakeLogin) {
    return {
      id: idOf(login.agent, login.user), agent: login.agent, user: login.user, ...(login.plan ? { plan: login.plan } : {}),
      active: Boolean(login.active), on: Boolean(login.on || login.active), ...(login.own ? { own: true } : {}),
      needsRelogin: Boolean(login.lapsed), ...(login.lapsed ? { lapsed: login.lapsed } : {}),
      seen: '2026-10-01T08:00:00Z',
      // a field the kernel never sends; the console must not pass it through if it ever did
      auth: { access_token: 'fixture-access-token-should-never-leave' },
    }
  }

  private agentView(agent: string) {
    return { agent, ...(this.signinDeny.includes(agent) ? { signinDenied: true } : {}), accounts: this.logins.filter(login => login.agent === agent).map(login => this.loginView(login)) }
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const raw = Buffer.concat(chunks).toString('utf8')
    let body: Record<string, unknown> = {}
    try { body = raw ? JSON.parse(raw) : {} } catch { body = {} }
    const url = new URL(req.url || '/', 'http://k')
    this.calls.push({ method: req.method || 'GET', path: `${url.pathname}${url.search}`, body: raw ? body : null })
    const json = (status: number, value: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(value))
    }
    const fail = (status: number, code: string, error: string) => json(status, { error, code })
    const route = `${req.method} ${url.pathname}`

    if (route === 'GET /internal/health') return json(200, this.healthBody())
    if (this.health === 'old' && url.pathname.startsWith('/internal/')) {
      res.writeHead(400, { 'content-type': 'text/plain' })
      return res.end('request id required\n')
    }
    if (route === 'POST /internal/signin') {
      const agent = String(body.agent || '')
      if (!this.loginAgents.includes(agent)) return fail(400, 'agent_unknown', 'not a sign-in agent of this kernel')
      if (this.signinDeny.includes(agent)) return fail(400, 'agent_disabled', `${agent} signs in through a CLI`)
      if (this.nextStartError) {
        const error = this.nextStartError
        this.nextStartError = null
        return fail(error.status, error.code, error.error)
      }
      for (const flow of this.flows.values()) if (flow.agent === agent && flow.state === 'waiting') flow.state = 'canceled'
      const id = `flow${++this.seq}x`
      const state = `st${this.seq}state`
      const installing = this.installing.has(agent)
      const flow: FakeFlow = {
        id, agent, url: installing ? '' : this.url(agent, state), state: installing ? 'installing' : 'waiting',
        ...(agent === 'copilot' ? { code: 'ABCD-1234' } : {}), ...(agent === 'dimagent' ? { pasteCallback: true } : {}),
        ...(installing ? { installing: 'Devin CLI' } : {}),
      }
      this.flows.set(id, flow)
      return json(200, flow)
    }
    const status = /^\/internal\/signin\/([^/]+)$/.exec(url.pathname)
    if (req.method === 'GET' && status) {
      const flow = this.flows.get(status[1])
      return flow ? json(200, flow) : fail(404, 'not_found', 'no such sign-in')
    }
    if (route === 'POST /internal/signin/cancel') {
      const flow = this.flows.get(String(body.id || ''))
      if (flow && ['installing', 'waiting'].includes(flow.state)) flow.state = 'canceled'
      res.writeHead(204)
      return res.end()
    }
    if (route === 'POST /internal/signin/callback') {
      const flow = this.flows.get(String(body.id || ''))
      if (!flow) return fail(404, 'not_found', 'no such sign-in')
      if (flow.agent !== 'dimagent') return fail(400, 'rejected', 'this sign-in does not accept a callback URL')
      if (flow.state !== 'waiting') return fail(400, 'rejected', 'this sign-in is no longer waiting for a callback')
      const pasted = new URL(String(body.url || ''), 'http://x')
      if (!pasted.searchParams.get('code')) return fail(400, 'rejected', 'that URL carries no code')
      Object.assign(flow, { state: 'done', user: 'dim.user@example.test', using: true })
      res.writeHead(204)
      return res.end()
    }
    if (route === 'GET /internal/accounts') {
      return json(200, { agents: this.loginAgents.map(agent => this.agentView(agent)), excluded: [
        { agent: 'claude', provider: 'claude', why: 'You removed it from magpie.' },
        { agent: 'codex', signedOut: true, why: '1 account is saved in magpie, but it isn\'t signed in here (nothing at /Users/someone/.codex/auth.json)' },
      ] })
    }
    if (route === 'GET /internal/accounts/usage') {
      const agent = url.searchParams.get('agent') || ''
      if (this.usageStatus !== 200) return fail(this.usageStatus, this.usageStatus === 504 ? 'timeout' : 'kernel_error', 'magpie took too long')
      return json(200, { agent, usage: this.usage[agent] ?? {} })
    }
    if (route === 'POST /internal/accounts/codex-reset') {
      return json(200, { user: body.user, code: this.resetCode, windows: this.resetCode === 'reset' ? 1 : 0, text: 'x' })
    }
    const action = /^\/internal\/accounts\/(on|off|switch|forget)$/.exec(url.pathname)
    if (req.method === 'POST' && action) {
      const agent = String(body.agent || '')
      const user = String(body.user || '')
      const login = this.logins.find(entry => entry.agent === agent && entry.user.toLowerCase() === user.toLowerCase())
      if (!login) return fail(404, 'not_found', 'no such account')
      if ((action[1] === 'off' || (action[1] === 'forget' && ['claude', 'codex'].includes(agent))) && login.active) {
        return fail(400, 'account_active', 'switch to another account first')
      }
      if (action[1] === 'on') login.on = true
      if (action[1] === 'off') login.on = false
      if (action[1] === 'switch') for (const entry of this.logins) if (entry.agent === agent) entry.active = entry === login
      if (action[1] === 'forget') this.logins = this.logins.filter(entry => entry !== login)
      return json(200, this.agentView(agent))
    }
    return fail(404, 'not_found', 'no such kernel route')
  }
}

/** The kernel's account id: first 16 hex of sha256(agent NUL lower(user)). */
export function idOf(agent: string, user: string): string {
  return createHash('sha256').update(`${agent}\0${user.toLowerCase()}`).digest('hex').slice(0, 16)
}

/** A loopback listener standing in for Magpie's sign-in listener; records each GET it receives. */
export async function fakeListener(onRequest: (path: string) => { status: number; location?: string } = () => ({ status: 200 })) {
  const requests: string[] = []
  const server = createServer((req, res) => {
    requests.push(req.url || '')
    const answer = onRequest(req.url || '')
    res.writeHead(answer.status, answer.location ? { location: answer.location } : {})
    res.end('<html>signed in fixture</html>')
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return { port, requests, close: () => new Promise<void>(resolve => server.close(() => resolve())) }
}

/** Keys and values that must never reach a browser: every key matching SECRET_KEY, and each listed value. */
export const SECRET_KEY = /(^|_|-)(access|refresh|id)?_?token$|token|secret|password|cookie|api[-_]?key|^auth$|authorization|verifier/i

export function secretFindings(value: unknown, secretValues: string[] = []): string[] {
  const findings: string[] = []
  const walk = (node: unknown, trail: string) => {
    if (typeof node === 'string') {
      for (const secret of secretValues) if (secret && node.includes(secret)) findings.push(`${trail}: carries a fixture secret`)
      return
    }
    if (!node || typeof node !== 'object') return
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      if (!Array.isArray(node) && SECRET_KEY.test(key)) findings.push(`${trail}.${key}`)
      walk(child, `${trail}.${key}`)
    }
  }
  walk(value, '$')
  return findings
}
