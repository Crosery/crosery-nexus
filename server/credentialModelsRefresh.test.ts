import './testDataDir.js'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import test from 'node:test'
import cookieParser from 'cookie-parser'
import express from 'express'
import { FakeCpa } from './testing/proxyFakeCpa.js'

/**
 * 订阅账号池的「拉取模型」：`POST /api/credentials/models/refresh`。
 *
 * 账号的模型不是控制台向上游探测出来的，而是网关按凭据解析后下发的（/auth-files/models）。
 * 所以这条接口的全部职责就是**丢开 30s 目录缓存与 15s 网关快照，真打一次网关**，并如实报告
 * 读到几个 provider、多少模型、哪些 provider 空了（按降级规则沿用上次结果）。
 */

const fake = await new FakeCpa().start()
process.env.CPA_BASE_URL = fake.base
process.env.CPA_MANAGEMENT_KEY = fake.key
process.env.SESSION_SECRET ||= 'credential-models-refresh-unit-secret'

const auth = await import('./auth.js')
const { refreshCredentialModels, listCredentials, invalidateGatewaySnapshot } = await import('./channels.js')

const ADMIN = `${auth.SESSION_COOKIE}=${auth.createSessionToken({ role: 'admin' })}`
const KEY = `${auth.SESSION_COOKIE}=${auth.createSessionToken({ role: 'key', keyHash: 'c'.repeat(64) })}`

/** 该 provider 的 `/auth-files/models` 应答；缺 key 视为「网关没返回目录」。 */
let catalog: Record<string, string[]> = {}
const authFileModelCalls = () => fake.requests.filter((entry) => entry.path.startsWith('/v0/management/auth-files/models')).length

function seed() {
  invalidateGatewaySnapshot()
  fake.requests.length = 0
  fake.credentials.clear()
  fake.credentials.set('codex-a.json', { name: 'codex-a.json', type: 'codex', email: 'codex@example.test' })
  fake.credentials.set('claude-a.json', { name: 'claude-a.json', type: 'claude', email: 'claude@example.test' })
  catalog = { codex: ['gpt-5.1'], claude: ['claude-sonnet-4-5'] }
  fake.extra = (method, route, url) => {
    if (route === '/auth-files/models' && method === 'GET') {
      const item = fake.credentials.get(url.searchParams.get('name') ?? '')
      return { status: 200, body: { models: (catalog[item?.type ?? ''] ?? []).map(id => ({ id })) } }
    }
    if (route === '/oauth-excluded-models' && method === 'GET') return { status: 200, body: { 'oauth-excluded-models': {} } }
    if (route === '/proxy-url' && method === 'GET') return { status: 200, body: { 'proxy-url': '' } }
    return undefined
  }
}

/** 路由层自己起的 app：只有鉴权守卫与这一条路由，处理器就是 channels.ts 的真实现。 */
async function harness() {
  auth.setKeySessionLookup(() => 'active')
  const app = express()
  app.use(express.json({ limit: '1mb' }))
  app.use(cookieParser())
  app.use(auth.createSessionGuard(app))
  app.post('/api/credentials/models/refresh', async (_req, res) => {
    try {
      const { credentials, degraded } = await refreshCredentialModels()
      const providers = [...new Set(credentials.map(credential => credential.type).filter(Boolean))]
      res.json({
        ok: true,
        providers,
        totalModels: credentials.reduce((sum, credential) => sum + credential.modelCount, 0),
        degraded,
      })
    } catch (error) {
      res.status(502).json({ error: error instanceof Error ? error.message : '读取账号模型目录失败' })
    }
  })
  const server: Server = createServer(app)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  const send = async (method: string, path: string, cookie: string | null = ADMIN) => {
    const response = await fetch(`${base}${path}`, { method, headers: cookie ? { cookie } : {} })
    return { status: response.status, body: await response.json() as Record<string, any> }
  }
  return {
    send,
    close: async () => {
      auth.setKeySessionLookup(null)
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}

test.after(async () => { await fake.stop() })

test('拉取模型：重读网关目录，返回 provider 与模型数，并刷新后 /api/channels 的凭据目录', async () => {
  seed()
  const before = authFileModelCalls()
  const result = await refreshCredentialModels()
  assert.deepEqual([...result.credentials.map(c => c.type).sort()], ['claude', 'codex'])
  assert.deepEqual(result.degraded, [])
  assert.ok(authFileModelCalls() > before, '必须真打一次网关，不能被 30s 目录缓存挡掉')

  // 同一次刷新产出的凭据目录已经带上模型，下一次常规读拿到的就是新值
  const listed = await listCredentials()
  assert.equal(listed.find(c => c.type === 'codex')?.modelCount, 1)
})

test('拉取模型：网关这次返回空目录，按降级规则沿用上次结果并在 degraded 里点名', async () => {
  seed()
  await refreshCredentialModels()
  // 网关抖动：清掉这一轮的整个目录（`catalog = {}` 会让两个 provider 都答空）
  catalog = {}
  const result = await refreshCredentialModels()
  assert.deepEqual([...result.degraded].sort(), ['claude', 'codex'], '空目录的 provider 必须被点名，不能当成 0 个模型')
  assert.deepEqual(result.models.codex, ['gpt-5.1'], '沿用上一次的非空目录')
  assert.equal(result.credentials.find(c => c.type === 'codex')?.modelCount, 1)
})

test('接口契约：管理员可调；key 会话 403、匿名 401', async () => {
  seed()
  const h = await harness()
  try {
    const ok = await h.send('POST', '/api/credentials/models/refresh')
    assert.equal(ok.status, 200)
    assert.equal(ok.body.ok, true)
    assert.deepEqual([...ok.body.providers].sort(), ['claude', 'codex'])
    assert.equal(ok.body.totalModels, 2)

    const asKey = await h.send('POST', '/api/credentials/models/refresh', KEY)
    assert.equal(asKey.status, 403)
    assert.equal(asKey.body.code, 'forbidden_role')
    assert.equal((await h.send('POST', '/api/credentials/models/refresh', null)).status, 401)
  } finally { await h.close() }
})

test('网关读不到目录时如实失败（502），不拿空目录冒充成功', async () => {
  seed()
  fake.down = true
  const h = await harness()
  try {
    const failed = await h.send('POST', '/api/credentials/models/refresh')
    assert.equal(failed.status, 502)
    assert.equal(typeof failed.body.error, 'string')
  } finally {
    fake.down = false
    await h.close()
  }
})