import './testDataDir.js'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import test from 'node:test'
import cookieParser from 'cookie-parser'
import express from 'express'

process.env.SESSION_SECRET ||= 'accounts-routes-unit-secret'

const auth = await import('./auth.js')
const { createAccountsService, registerAccountsRoutes } = await import('./accountsRoutes.js')

const ADMIN = `${auth.SESSION_COOKIE}=${auth.createSessionToken({ role: 'admin' })}`
const KEY = `${auth.SESSION_COOKIE}=${auth.createSessionToken({ role: 'key', keyHash: 'a'.repeat(64) })}`

async function harness() {
  auth.setKeySessionLookup(() => 'active')
  const app = express()
  app.use(express.json({ limit: '1mb' }))
  app.use(cookieParser())
  app.use(auth.createSessionGuard(app))
  registerAccountsRoutes(app, createAccountsService())
  const server: Server = createServer(app)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  const send = async (method: string, path: string, cookie: string | null = ADMIN) => {
    const response = await fetch(`${base}${path}`, { method, headers: cookie ? { cookie } : {} })
    return { status: response.status, body: await response.json() as Record<string, any>, cacheControl: response.headers.get('cache-control') }
  }
  return {
    send,
    close: async () => {
      auth.setKeySessionLookup(null)
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}

const ROUTES = ['/api/accounts', '/api/accounts/catalog']

test('roles: key sessions get 403 and anonymous requests 401 on every accounts route', async () => {
  const h = await harness()
  try {
    for (const path of ROUTES) {
      const asKey = await h.send('GET', path, KEY)
      assert.equal(asKey.status, 403, `${path} as a key session`)
      assert.equal(asKey.body.code, 'forbidden_role')
      assert.equal((await h.send('GET', path, null)).status, 401, `${path} without a session`)
    }
  } finally { await h.close() }
})

test('list and catalog describe the CPA backend and its providers, uncached', async () => {
  const h = await harness()
  try {
    const list = await h.send('GET', '/api/accounts')
    assert.equal(list.status, 200)
    assert.equal(list.body.backend, 'cpa')
    assert.equal(list.body.available, true)
    assert.equal(list.cacheControl, 'no-store')
    const catalog = await h.send('GET', '/api/accounts/catalog')
    assert.equal(catalog.body.backend, 'cpa')
    assert.deepEqual(catalog.body.items.map((item: { agent: string }) => item.agent), ['codex', 'claude', 'antigravity', 'kimi', 'kimi-ai', 'xai', 'devin', 'meta'])
  } finally { await h.close() }
})
