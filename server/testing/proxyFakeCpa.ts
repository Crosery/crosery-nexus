/**
 * A fake CPA management API for proxy-pool tests (PROXY-SPEC §14.8). Shapes follow CLIProxyAPI:
 * `GET /auth-files` carries no `proxy_url`; `GET /auth-files/download` returns the whole credential (incl. fake
 * tokens); `PATCH /auth-files/fields`; `GET/PUT/DELETE /proxy-url` (`{value}`); compat channels and key lists.
 * Every request is recorded so tests can assert "zero PATCH calls" and "the bridge was never contacted".
 */

import { createServer, type Server } from 'node:http'

export type FakeCredential = { name: string; type: string; email?: string; proxy_url?: string; disabled?: boolean }

export class FakeCpa {
  readonly requests: Array<{ method: string; path: string; body?: string }> = []
  credentials = new Map<string, FakeCredential>()
  globalProxy = ''
  compat: Array<Record<string, unknown>> = []
  providerKeys: Record<string, Array<Record<string, unknown>>> = {}
  failDownloads = new Set<string>()
  down = false
  /** management routes a test adds on top of these (asked before the 404); `undefined` falls through */
  extra: ((method: string, route: string, url: URL, raw: string) => { status: number; body: unknown } | undefined) | null = null
  /** inference routes (`/v1/*`) a test answers; asked before the management-key check, with the caller's Authorization */
  gateway: ((method: string, url: URL, authorization: string) => { status: number; body: unknown } | undefined) | null = null
  private server: Server | null = null
  base = ''

  constructor(readonly key = 'fake-management-key-0123456789') {}

  static token(name: string) { return `fake-access-token-${name}-SECRET` }

  async start(): Promise<this> {
    this.server = createServer((req, res) => {
      let raw = ''
      req.on('data', (chunk) => { raw += chunk })
      req.on('end', () => {
        const url = new URL(req.url ?? '/', 'http://fake')
        const method = req.method ?? 'GET'
        this.requests.push({ method, path: url.pathname + url.search, ...(raw ? { body: raw } : {}) })
        const send = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
        if (this.down) return send(503, { error: 'down' })
        const inference = url.pathname.startsWith('/v1/') ? this.gateway?.(method, url, req.headers.authorization ?? '') : undefined
        if (inference) return send(inference.status, inference.body)
        if (req.headers.authorization !== `Bearer ${this.key}`) return send(401, { error: 'unauthorized' })
        const route = url.pathname.replace(/^\/v0\/management/, '')
        if (route === '/auth-files' && method === 'GET') {
          return send(200, { files: [...this.credentials.values()].map(item => ({ name: item.name, type: item.type, provider: item.type, email: item.email ?? '', disabled: Boolean(item.disabled), status: 'active', auth_index: item.name })) })
        }
        if (route === '/auth-files/download' && method === 'GET') {
          const name = url.searchParams.get('name') ?? ''
          const item = this.credentials.get(name)
          if (!item) return send(404, { error: 'not found' })
          if (this.failDownloads.has(name)) return send(500, { error: 'boom' })
          return send(200, { type: item.type, email: item.email, access_token: FakeCpa.token(name), refresh_token: `fake-refresh-${name}`, ...(item.proxy_url !== undefined ? { proxy_url: item.proxy_url } : {}) })
        }
        if (route === '/auth-files/fields' && method === 'PATCH') {
          const body = JSON.parse(raw || '{}') as { name?: string; proxy_url?: string }
          const item = this.credentials.get(String(body.name))
          if (!item) return send(404, { error: 'not found' })
          if (typeof body.proxy_url === 'string') item.proxy_url = body.proxy_url
          return send(200, { status: 'ok' })
        }
        if (route === '/proxy-url') {
          if (method === 'GET') return send(200, { 'proxy-url': this.globalProxy })
          if (method === 'PUT') { this.globalProxy = String((JSON.parse(raw || '{}') as { value?: string }).value ?? ''); return send(200, { status: 'ok' }) }
          if (method === 'DELETE') { this.globalProxy = ''; return send(200, { status: 'ok' }) }
        }
        if (route === '/openai-compatibility' && method === 'GET') return send(200, { 'openai-compatibility': this.compat })
        const keyRoute = /^\/(claude|codex|gemini|vertex)-api-key$/.exec(route)
        if (keyRoute && method === 'GET') return send(200, { [`${keyRoute[1]}-api-key`]: this.providerKeys[`${keyRoute[1]}-api-key`] ?? [] })
        const added = this.extra?.(method, route, url, raw)
        if (added) return send(added.status, added.body)
        return send(404, { error: 'no route' })
      })
    })
    await new Promise<void>(resolve => this.server?.listen(0, '127.0.0.1', resolve))
    const address = this.server.address()
    this.base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
    return this
  }

  writes() { return this.requests.filter(item => item.method !== 'GET') }

  async stop() {
    await new Promise<void>(resolve => (this.server ? this.server.close(() => resolve()) : resolve()))
  }
}
