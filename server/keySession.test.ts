import './testDataDir.js'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import test from 'node:test'
import express from 'express'
import cookieParser from 'cookie-parser'

// config.ts 在模块求值时读取 SESSION_SECRET：先设环境，再动态导入被测模块。
const SECRET = 'key-session-unit-secret'
process.env.SESSION_SECRET = SECRET

const auth = await import('./auth.js')
const { config } = await import('./config.js')
const { db } = await import('./db.js')
const { hashKey } = await import('./cpa.js')
const keySession = await import('./keySession.js')

/**
 * role=key 会话的单元/进程内测试：token v2 的签名覆盖面、旧 admin token 兼容、空密钥拒验、
 * Key 存活判定，以及守卫在**处理器运行之前**按角色裁决（端到端隔离见 meIsolation.test.ts）。
 */

const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)
const hmac = (value: string, secret = SECRET) => createHmac('sha256', secret).update(value).digest('hex')
const future = () => Date.now() + 60_000
const requestWith = (token: string) => ({ cookies: { [auth.SESSION_COOKIE]: token } }) as unknown as import('express').Request

/* ────────────────── token v2 ────────────────── */

test('v2 token 往返：admin 与 key 角色、key_hash 都从签名里还原', () => {
  assert.deepEqual(auth.verifySessionToken(auth.createSessionToken({ role: 'admin' })), { role: 'admin' })
  assert.deepEqual(auth.verifySessionToken(auth.createSessionToken({ role: 'key', keyHash: HASH_A })), { role: 'key', keyHash: HASH_A })
  const token = auth.createSessionToken({ role: 'key', keyHash: HASH_A })
  assert.equal(token.split('.').length, 5)
  assert.match(token.split('.')[0], /^\d+$/, '到期时间必须留在第 0 段（撤销表据此推算寿命）')
  assert.throws(() => auth.createSessionToken({ role: 'key', keyHash: 'not-a-hash' }))
})

test('旧版两段式 admin token（部署前签发）仍然有效，且只能是 admin', () => {
  const expires = String(future())
  const legacy = `${expires}.${hmac(expires)}`
  assert.deepEqual(auth.verifySessionToken(legacy), { role: 'admin' })
  assert.equal(auth.isAuthenticated(requestWith(legacy)), true)
})

test('篡改任一字段都失效：角色、key_hash、到期、签名、段数、跨版本拼接、别的密钥', () => {
  const expires = String(future())
  const keyToken = auth.createSessionToken({ role: 'key', keyHash: HASH_A }, Number(expires))
  const [, , , , signature] = keyToken.split('.')
  const forged = [
    `${expires}.v2.admin.-.${signature}`, // 把 key 会话改成 admin
    `${expires}.v2.admin.${HASH_A}.${signature}`,
    `${expires}.v2.key.${HASH_B}.${signature}`, // 换成别人的 Key
    `${Number(expires) + 1000}.v2.key.${HASH_A}.${signature}`, // 延长有效期
    `${expires}.v2.key.${HASH_A}.${signature.slice(0, -2)}00`,
    `${expires}.v2.key.${HASH_A}.${signature.toUpperCase()}`,
    `${expires}.v2.key.${HASH_A.toUpperCase()}.${hmac(`crosery-console-session|v2|${expires}|key|${HASH_A.toUpperCase()}`)}`,
    `${expires}.v2.root.-.${hmac(`crosery-console-session|v2|${expires}|root|-`)}`, // 未知角色，即使签名正确
    `${expires}.${hmac(expires)}.extra`, // v1 后面拼段：旧验证器曾经静默忽略多余段
    `${expires}.v2.admin.-.${hmac(expires)}`, // 把 v1 签名塞进 v2
    `${expires}.v3.admin.-.${hmac(`crosery-console-session|v2|${expires}|admin|-`)}`,
    `${expires}.v2.key.${HASH_A}.${hmac(`crosery-console-session|v2|${expires}|key|${HASH_A}`, 'other-secret')}`,
    `${expires}.${hmac(expires, 'other-secret')}`,
    `1e15.${hmac('1e15')}`,
    `${Date.now() - 1000}.${hmac(String(Date.now() - 1000))}`, // 已过期
    '',
    `${expires}.v2.key.${HASH_A}.${signature}.${'x'.repeat(300)}`,
  ]
  for (const token of forged) {
    assert.equal(auth.verifySessionToken(token), null, `必须拒绝：${token.slice(0, 90)}`)
  }
  assert.deepEqual(auth.verifySessionToken(keyToken), { role: 'key', keyHash: HASH_A }, '原 token 仍然有效（对照）')
})

test('SESSION_SECRET 为空时拒绝验证（HMAC 空密钥可公开计算），也拒绝签发', () => {
  const expires = String(future())
  const original = config.sessionSecret
  try {
    config.sessionSecret = ''
    assert.equal(auth.verifySessionToken(`${expires}.${hmac(expires, '')}`), null)
    assert.equal(auth.verifySessionToken(`${expires}.v2.admin.-.${hmac(`crosery-console-session|v2|${expires}|admin|-`, '')}`), null)
    assert.throws(() => auth.createSessionToken({ role: 'admin' }), /配置缺失/)
  } finally {
    config.sessionSecret = original
  }
})

test('撤销对 v2 token 同样生效', () => {
  auth.clearRevokedSessions()
  const token = auth.createSessionToken({ role: 'key', keyHash: HASH_A })
  auth.setKeySessionLookup(() => 'active')
  try {
    assert.deepEqual(auth.currentSession(requestWith(token)), { role: 'key', keyHash: HASH_A })
    auth.revokeSession(token)
    assert.equal(auth.isSessionRevoked(token), true)
    assert.equal(auth.currentSession(requestWith(token)), null)
  } finally {
    auth.setKeySessionLookup(null)
    auth.clearRevokedSessions()
  }
})

/* ────────────────── Key 存活 ────────────────── */

test('Key 会话每次回库：删除 → key_invalid，人工停用 → key_disabled，未接线 → 失效；查询异常 → 不放行也不判失效（unavailable）', () => {
  const token = auth.createSessionToken({ role: 'key', keyHash: HASH_A })
  const states: Array<[Parameters<typeof auth.setKeySessionLookup>[0], { principal: unknown; keyRejection: unknown; unavailable?: true }]> = [
    [() => 'active', { principal: { role: 'key', keyHash: HASH_A }, keyRejection: null }],
    [() => 'missing', { principal: null, keyRejection: 'key_invalid' }],
    [() => 'disabled', { principal: null, keyRejection: 'key_disabled' }],
    [() => { throw new Error('db down') }, { principal: null, keyRejection: null, unavailable: true }],
    [null, { principal: null, keyRejection: 'key_invalid' }],
  ]
  try {
    for (const [lookup, expected] of states) {
      auth.setKeySessionLookup(lookup)
      assert.deepEqual(auth.resolveSession(requestWith(token)), expected)
    }
    auth.setKeySessionLookup(null)
    assert.deepEqual(auth.resolveSession(requestWith(auth.createSessionToken({ role: 'admin' }))).principal, { role: 'admin' }, 'admin 不受 Key 查询影响')
  } finally {
    auth.setKeySessionLookup(null)
  }
})

test('按明文找 Key：走 hash 主键 + 定长比较；未知/过短/过长一律 null；额度停用仍 active、人工停用 disabled', () => {
  const now = new Date().toISOString()
  const insert = db.prepare(`INSERT OR REPLACE INTO api_keys (key_hash,key_value,name,note,enabled,groups_json,total_concurrency,group_concurrency_json,created_at,updated_at,quota_blocked_reason)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
  const live = 'sk-unit-live-0123456789abcdef0123456789abcdef'
  const quotaBlocked = 'sk-unit-quota-0123456789abcdef0123456789abcde'
  const manual = 'sk-unit-manual-0123456789abcdef0123456789abcd'
  insert.run(hashKey(live), live, 'live', '', 1, '[]', 4, '{}', now, now, '')
  insert.run(hashKey(quotaBlocked), quotaBlocked, 'quota', '', 0, '[]', 4, '{}', now, now, '日额度已用完')
  insert.run(hashKey(manual), manual, 'manual', '', 0, '[]', 4, '{}', now, now, '')

  assert.equal(keySession.findKeyByPresentedValue(live)?.name, 'live')
  assert.equal(keySession.findKeyByPresentedValue(`${live}x`), null)
  assert.equal(keySession.findKeyByPresentedValue('short'), null)
  assert.equal(keySession.findKeyByPresentedValue('x'.repeat(600)), null)
  assert.equal(keySession.findKeyByPresentedValue(''), null)
  // 网关侧配置后同步进来的存量短 Key：登录准入界不放它，/v1/usage 的宽界照旧查得到（旧实现是 key_value 精确匹配）
  const shortStored = 'gw-1234'
  insert.run(hashKey(shortStored), shortStored, 'short-stored', '', 1, '[]', 4, '{}', now, now, '')
  assert.equal(keySession.findKeyByPresentedValue(shortStored), null)
  assert.equal(keySession.findKeyByPresentedValue(shortStored, { min: 1, max: 8192 })?.name, 'short-stored')
  assert.equal(keySession.findKeyByPresentedValue('gw-1235', { min: 1, max: 8192 }), null)

  assert.equal(keySession.keySessionState(hashKey(live)), 'active')
  assert.equal(keySession.keySessionState(hashKey(quotaBlocked)), 'active', '额度超限自动停用：仍可读自己的数据')
  assert.equal(keySession.keySessionState(hashKey(manual)), 'disabled')
  assert.equal(keySession.keySessionState(HASH_B), 'missing')
  assert.equal(keySession.keySessionState("' OR 1=1 --"), 'missing')

  const masked = keySession.maskApiKey(live)
  assert.equal(masked, 'sk-un…cdef')
  assert.ok(!masked.includes(live.slice(5, -4)))
  assert.equal(keySession.maskApiKey('sk-short1'), 'sk…t1')
})

/* ────────────────── 守卫：按角色在处理器之前裁决 ────────────────── */

async function guardHarness(): Promise<{ base: string; hits: string[]; close: () => Promise<void> }> {
  const app = express()
  app.set('trust proxy', 'loopback')
  app.use(cookieParser())
  app.use(auth.createSessionGuard(app))
  const hits: string[] = []
  const handler = (label: string) => (_request: express.Request, response: express.Response) => {
    hits.push(label)
    response.json({ ok: label })
  }
  app.get('/api/session', handler('session'))
  app.post('/api/logout', handler('logout'))
  app.get('/api/keys', handler('keys'))
  app.post('/api/keys/:id/reveal-token', handler('reveal-token'))
  app.get('/api/keys/:id/reveal', handler('reveal'))
  app.get('/api/monitor', handler('monitor'))
  app.get('/api/usage-page', handler('usage-page'))
  app.get('/api/audit', handler('audit'))
  app.get('/internal/metrics', handler('internal'))
  const me = express.Router()
  me.get('/', handler('me'))
  me.get('/usage', handler('me-usage'))
  app.use('/api/me', me)
  app.use('/api', (_request, response) => response.status(404).json({ error: 'not found' }))
  app.use((_request, response) => response.type('html').send('<!doctype html><div id="app"></div>'))
  const server: Server = createServer(app)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return { base: `http://127.0.0.1:${port}`, hits, close: () => new Promise(resolve => server.close(() => resolve())) }
}

test('守卫：key 会话只到得了 /api/me*、/api/session、/api/logout；管理端（含大小写变体）403 且处理器未运行', async () => {
  let state: 'active' | 'disabled' | 'missing' = 'active'
  auth.setKeySessionLookup(hash => (hash === HASH_A ? state : 'missing'))
  const harness = await guardHarness()
  try {
    const keyCookie = `${auth.SESSION_COOKIE}=${auth.createSessionToken({ role: 'key', keyHash: HASH_A })}`
    const adminCookie = `${auth.SESSION_COOKIE}=${auth.createSessionToken({ role: 'admin' })}`
    const call = (path: string, cookie: string, method = 'GET') => fetch(`${harness.base}${path}`, { method, headers: { cookie } })

    for (const [method, path] of [
      ['GET', '/api/keys'],
      ['POST', `/api/keys/${HASH_B}/reveal-token`],
      ['GET', `/api/keys/${HASH_B}/reveal?token=x`],
      ['GET', '/api/monitor'],
      ['GET', `/api/usage-page?keyId=${HASH_B}`],
      ['GET', '/api/audit'],
      ['GET', '/API/KEYS'],
      ['GET', '/Api/Audit'],
      ['GET', '/api/definitely-unknown'],
      ['GET', '/api/meta'],
      ['GET', '/internal/metrics'],
    ] as const) {
      const response = await call(path, keyCookie, method)
      assert.equal(response.status, 403, `key 会话访问 ${method} ${path} 必须 403（实际 ${response.status}）`)
      assert.deepEqual(await response.json(), { error: '无权访问', code: 'forbidden_role' })
    }
    assert.deepEqual(harness.hits, [], `被拒的请求不得进入任何处理器：${harness.hits.join(',')}`)

    for (const [path, label] of [['/api/me', 'me'], ['/api/me/usage?keyId=x', 'me-usage'], ['/api/session', 'session']] as const) {
      const response = await call(path, keyCookie)
      assert.equal(response.status, 200, `${path} 必须放行`)
      assert.deepEqual(await response.json(), { ok: label })
    }
    assert.equal((await call('/api/logout', keyCookie, 'POST')).status, 200)
    const spa = await call('/me/usage', keyCookie)
    assert.equal(spa.status, 200, 'SPA 深链接仍返回前端产物')
    assert.match(await spa.text(), /<div id="app">/)

    // admin 行为不变：全部放行（/api/me* 由路由自己回 not_key_session，见 meIsolation.test.ts）
    for (const path of ['/api/keys', '/api/monitor', '/api/audit', '/internal/metrics']) {
      assert.equal((await call(path, adminCookie)).status, 200, `admin 访问 ${path} 必须 200`)
    }

    // Key 被人工停用 / 删除：会话立即失效，/api 401 带原因并清 Cookie；/api/session 仍 200
    state = 'disabled'
    const disabled = await call('/api/me', keyCookie)
    assert.equal(disabled.status, 401)
    assert.deepEqual(await disabled.json(), { error: 'API Key 已被停用', code: 'key_disabled' })
    assert.match(String(disabled.headers.get('set-cookie')), new RegExp(`${auth.SESSION_COOKIE}=;`), '必须清掉失效会话的 Cookie')
    state = 'missing'
    const deleted = await call('/api/keys', keyCookie)
    assert.equal(deleted.status, 401)
    assert.deepEqual(await deleted.json(), { error: 'API Key 已失效 · 重新登录', code: 'key_invalid' })
    assert.equal((await call('/api/session', keyCookie)).status, 200)
    const anonymous = await call('/api/audit', '')
    assert.deepEqual(await anonymous.json(), { error: '请先登录' }, '匿名 401 文案保持不变')
  } finally {
    auth.setKeySessionLookup(null)
    await harness.close()
  }
})

/* ────────────────── review-auth-isolation ────────────────── */

test('AI-07 Key 存活查询异常：受保护接口 503 session_unavailable、不清 Cookie、处理器未运行；库恢复后同一 token 继续可用', async () => {
  let failing = true
  auth.setKeySessionLookup(() => {
    if (failing) throw new Error('SQLITE_BUSY: database is locked')
    return 'active'
  })
  const harness = await guardHarness()
  try {
    const cookie = `${auth.SESSION_COOKIE}=${auth.createSessionToken({ role: 'key', keyHash: HASH_A })}`
    for (const path of ['/api/me', '/api/keys', '/internal/metrics']) {
      const response = await fetch(`${harness.base}${path}`, { headers: { cookie } })
      assert.equal(response.status, 503, `${path} 必须 503（实际 ${response.status}）`)
      assert.deepEqual(await response.json(), { error: '暂时无法确认登录状态 · 稍后重试', code: 'session_unavailable' })
      assert.equal(response.headers.get('set-cookie'), null, '查不清不等于失效：不得清掉 Cookie')
      assert.equal(response.headers.get('retry-after'), '5')
    }
    assert.deepEqual(harness.hits, [], '503 必须发生在处理器之前')
    const spa = await fetch(`${harness.base}/me/usage`, { headers: { cookie } })
    assert.equal(spa.status, 200, 'SPA 深链接仍返回前端产物')
    failing = false
    const recovered = await fetch(`${harness.base}/api/me`, { headers: { cookie } })
    assert.equal(recovered.status, 200, '库恢复后不需要重新登录')
  } finally {
    auth.setKeySessionLookup(null)
    await harness.close()
  }
})

test('AI-07 /api/session：查询异常回 503（不是 {authenticated:false}）；真实库故障时 Key 登录 500 只回通用文案（AI-15）', async () => {
  const { sessionProbe, loginRoute } = await import('./sessionRoutes.js')
  auth.setKeySessionLookup(keySession.keySessionState)
  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.get('/api/session', sessionProbe)
  app.post('/api/login', loginRoute)
  const server: Server = createServer(app)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  const presented = 'sk-unit-probe-0123456789abcdef0123456789abcdef'
  const now = new Date().toISOString()
  db.prepare(`INSERT OR REPLACE INTO api_keys (key_hash,key_value,name,note,enabled,groups_json,total_concurrency,group_concurrency_json,created_at,updated_at,quota_blocked_reason)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(hashKey(presented), presented, 'probe', '', 1, '[]', 4, '{}', now, now, '')
  const cookie = `${auth.SESSION_COOKIE}=${auth.createSessionToken({ role: 'key', keyHash: hashKey(presented) })}`
  const originalError = console.error
  const logged: string[] = []
  try {
    assert.deepEqual(await (await fetch(`${base}/api/session`, { headers: { cookie } })).json(), { authenticated: true, role: 'key', key: { name: 'probe', masked: keySession.maskApiKey(presented), ref: keySession.keyRef(hashKey(presented)) } })
    // 模拟库故障：表不可读时 Key 查询抛 `no such table`
    db.exec('ALTER TABLE api_keys RENAME TO api_keys_offline')
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')) }
    const probe = await fetch(`${base}/api/session`, { headers: { cookie } })
    assert.equal(probe.status, 503)
    assert.deepEqual(await probe.json(), { error: '暂时无法确认登录状态 · 稍后重试', code: 'session_unavailable' })
    const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.200' }, body: JSON.stringify({ apiKey: presented }) })
    const text = await login.text()
    assert.equal(login.status, 500)
    assert.deepEqual(JSON.parse(text), { error: '服务器内部错误' }, `公开登录口不得回原始异常：${text}`)
    assert.ok(!/no such table|api_keys|sqlite/i.test(text))
    assert.equal(logged.length, 1, '服务端留一条诊断')
    assert.match(logged[0], /POST \/api\/login \(key\) → 500/)
    assert.ok(!logged[0].includes(presented), '诊断里不得出现提交的 Key')
  } finally {
    console.error = originalError
    try { db.exec('ALTER TABLE api_keys_offline RENAME TO api_keys') } catch { /* 没改名成功就不用还原 */ }
    auth.setKeySessionLookup(null)
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

test('AI-09 Key 停用期间被拒的 token 记入撤销表：Key 重新启用后同一 token 不复活', async () => {
  let state: 'active' | 'disabled' = 'active'
  auth.setKeySessionLookup(() => state)
  const harness = await guardHarness()
  try {
    const token = auth.createSessionToken({ role: 'key', keyHash: HASH_A })
    const cookie = `${auth.SESSION_COOKIE}=${token}`
    assert.equal((await fetch(`${harness.base}/api/me`, { headers: { cookie } })).status, 200)
    state = 'disabled'
    const rejected = await fetch(`${harness.base}/api/me`, { headers: { cookie } })
    assert.deepEqual([rejected.status, (await rejected.json() as { code?: string }).code], [401, 'key_disabled'])
    const again = await fetch(`${harness.base}/api/me/usage`, { headers: { cookie } })
    assert.deepEqual([again.status, (await again.json() as { code?: string }).code], [401, 'key_disabled'], '并发的后续请求仍拿到同一个原因')
    state = 'active'
    const replay = await fetch(`${harness.base}/api/me`, { headers: { cookie } })
    assert.equal(replay.status, 401, '重新启用后旧 token 必须重新登录，不得复活')
    assert.equal(auth.isSessionRevoked(token), true)
  } finally {
    auth.setKeySessionLookup(null)
    auth.clearRevokedSessions()
    await harness.close()
  }
})
