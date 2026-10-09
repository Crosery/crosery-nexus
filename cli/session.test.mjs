import assert from 'node:assert/strict'
import test from 'node:test'
import { mapHttpError, request } from './lib/client.mjs'
import { SESSION_SERVICE, cookieFromHeaders, createSession, createSessionCache, tokenExpiry } from './lib/session.mjs'

const NOW = 1_800_000_000_000
const fresh = (ms = 60 * 60 * 1000) => `${NOW + ms}.v2.admin.-.0123456789abcdef`
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

function harness({ cacheEnabled = false, execute = () => '', responses }) {
  const calls = []
  const rt = {
    target: { base: 'http://127.0.0.1:8791', origin: 'http://127.0.0.1:8791' },
    userAgent: 'cradmin/test',
    cacheEnabled,
    execute,
    now: () => NOW,
    dryRun: false,
    fetch: async (url, init) => {
      const pathname = new URL(url).pathname
      calls.push({ pathname, method: init.method, cookie: init.headers.cookie || '', body: init.body || '' })
      const next = responses(pathname, init, calls)
      return typeof next === 'function' ? next() : next
    },
    credentials: () => ({ username: 'admin', password: async () => ({ password: 'test-only-value', tier: 'env' }) }),
  }
  rt.session = createSession(rt)
  return { rt, calls }
}

test('token 只经 stdin 进 security -i，从不出现在 argv；格式不对不写', () => {
  const runs = []
  const cache = createSessionCache({ account: 'admin@http://127.0.0.1:8791', now: () => NOW, execute: (file, args, options) => { runs.push({ file, args, options }); return '' } })
  const token = fresh()
  assert.equal(cache.write(token), true)
  assert.equal(runs[0].file, '/usr/bin/security')
  assert.deepEqual(runs[0].args, ['-i'])
  assert.ok(!runs.some(run => run.args.join(' ').includes(token)))
  assert.equal(runs[0].options.input, `add-generic-password -U -s ${SESSION_SERVICE} -a admin@http://127.0.0.1:8791 -w ${token}\n`)
  for (const bad of ['123.abc def', `${fresh()}\nquit`, 'abc.def', `${fresh()} -A`, '']) {
    assert.equal(cache.write(bad), false, JSON.stringify(bad))
  }
  assert.equal(runs.length, 1)
  assert.equal(createSessionCache({ account: 'ad min@x', execute: () => { throw new Error('不应调用') } }).write(token), false)
})

test('缓存读取：剩余不足 5 分钟视为过期', () => {
  const cache = token => createSessionCache({ account: 'admin@http://127.0.0.1:8791', now: () => NOW, execute: () => `${token}\n` })
  assert.equal(cache(fresh()).read(), fresh())
  assert.equal(cache(fresh(4 * 60 * 1000)).read(), null)
  assert.equal(cache('garbage value').read(), null)
  assert.equal(tokenExpiry(fresh()), NOW + 3_600_000)
})

test('cookieFromHeaders 只取 crosery_console_session', () => {
  const headers = new Headers()
  headers.append('set-cookie', 'other=1; Path=/')
  headers.append('set-cookie', 'crosery_console_session=abc.def; HttpOnly; SameSite=Strict')
  assert.equal(cookieFromHeaders(headers), 'abc.def')
})

test('不缓存：每进程只登录一次，close 时注销', async () => {
  const token = fresh()
  const { rt, calls } = harness({
    responses: pathname => (pathname === '/api/login'
      ? json(200, { ok: true, role: 'admin' }, { 'set-cookie': `crosery_console_session=${token}; Path=/` })
      : json(200, { ok: true })),
  })
  await request(rt, 'GET', '/api/bootstrap')
  await request(rt, 'GET', '/api/channels')
  await rt.session.close()
  assert.deepEqual(calls.map(call => call.pathname), ['/api/login', '/api/bootstrap', '/api/channels', '/api/logout'])
  assert.equal(calls[1].cookie, `crosery_console_session=${token}`)
  assert.ok(calls[0].body.includes('test-only-value'))
  assert.ok(!calls.slice(1).some(call => call.body.includes('test-only-value')))
})

test('缓存会话收到 401：删缓存、重新登录一次、原请求重发一次', async () => {
  const stale = fresh()
  const renewed = fresh(7_200_000)
  const runs = []
  const execute = (_file, args) => {
    runs.push(args[0])
    if (args[0] === 'find-generic-password') return `${stale}\n`
    return ''
  }
  let gets = 0
  const { rt, calls } = harness({
    cacheEnabled: true,
    execute,
    responses: pathname => {
      if (pathname === '/api/login') return json(200, { ok: true }, { 'set-cookie': `crosery_console_session=${renewed}` })
      gets += 1
      return gets === 1 ? json(401, { error: '请先登录' }) : json(200, { ok: true })
    },
  })
  assert.deepEqual(await request(rt, 'GET', '/api/bootstrap'), { ok: true })
  assert.deepEqual(calls.map(call => call.pathname), ['/api/bootstrap', '/api/login', '/api/bootstrap'])
  assert.equal(calls[0].cookie, `crosery_console_session=${stale}`)
  assert.equal(calls[2].cookie, `crosery_console_session=${renewed}`)
  assert.deepEqual(runs, ['find-generic-password', 'delete-generic-password', '-i'])
  await rt.session.close()
  assert.equal(calls.length, 3, '缓存模式结束时不注销')
})

test('登录 401 不重试，退出 3 并写明凭据来源档位', async () => {
  const { rt, calls } = harness({ responses: () => json(401, { error: '管理员账号或密码不正确', code: 'invalid_credentials' }) })
  await assert.rejects(request(rt, 'GET', '/api/bootstrap'), error => error.exitCode === 3 && error.message === '管理员密码不对或会话过期（凭据来源：环境变量 CONSOLE_PASSWORD）')
  assert.deepEqual(calls.map(call => call.pathname), ['/api/login'])
})

test('登录被限流 429 → 退出 4，给出秒数', async () => {
  const { rt } = harness({ responses: () => json(429, { error: 'too many', code: 'rate_limited', retryAfterSec: 120 }, { 'retry-after': '120' }) })
  await assert.rejects(request(rt, 'GET', '/api/bootstrap'), error => error.exitCode === 4 && /120 秒/.test(error.message))
})

test('非缓存会话收到 401 不重登', async () => {
  let logins = 0
  const { rt } = harness({
    responses: pathname => {
      if (pathname === '/api/login') { logins += 1; return json(200, {}, { 'set-cookie': `crosery_console_session=${fresh()}` }) }
      return json(401, { error: '请先登录' })
    },
  })
  await assert.rejects(request(rt, 'GET', '/api/bootstrap'), error => error.exitCode === 3)
  assert.equal(logins, 1)
})

test('错误映射', () => {
  assert.equal(mapHttpError(403, { error: '无权访问', code: 'forbidden_role' }).message, '这是 Key 会话，不是管理员')
  assert.equal(mapHttpError(403, { error: '无权访问', code: 'forbidden_role' }).exitCode, 3)
  assert.equal(mapHttpError(403, { error: '需要确认', reason: 'confirm_required' }).message, '服务端拒绝：需要确认')
  const cooldown = mapHttpError(429, { code: 'cooldown', retryAfterSec: 299 }, { label: '价格元数据' })
  assert.equal(cooldown.message, '价格元数据 冷却中，还需 299 秒')
  assert.equal(cooldown.exitCode, 4)
  assert.equal(mapHttpError(404, { error: '接口不存在' }).message, '服务端没有这个接口（版本太旧？）')
  assert.equal(mapHttpError(404, { error: '渠道不存在', reason: 'channel_not_found' }, { target: '渠道 x' }).message, '找不到：渠道 x（channel_not_found）')
  assert.equal(mapHttpError(409, { error: '冲突' }).message, '服务端返回 409：冲突')
  assert.equal(mapHttpError(500, null).exitCode, 1)
})

test('网络错误只取 code，不带 URL 以外的细节；GET 503 重试一次', async () => {
  const { rt } = harness({ responses: () => () => { const error = new TypeError('fetch failed http://secret'); error.cause = { code: 'ECONNREFUSED' }; throw error } })
  await assert.rejects(request(rt, 'GET', '/api/session', { auth: false }), error => error.exitCode === 1 && error.message === '连不上控制台 http://127.0.0.1:8791：服务启动了吗？（ECONNREFUSED）')
  let hits = 0
  const retry = harness({ responses: () => { hits += 1; return hits === 1 ? json(503, { code: 'session_unavailable' }, { 'retry-after': '0' }) : json(200, { ok: true }) } })
  assert.deepEqual(await request(retry.rt, 'GET', '/api/session', { auth: false }), { ok: true })
  assert.equal(hits, 2)
})

test('--dry-run 下写请求被拦截（内部保护）', async () => {
  const { rt, calls } = harness({ responses: () => json(200, {}) })
  rt.dryRun = true
  await assert.rejects(request(rt, 'PATCH', '/api/keys/x', { body: {} }), /dry-run/)
  assert.equal(calls.length, 0)
})

test('并发的第一批请求只登录一次（单飞）；结束时只注销一次', async () => {
  const token = fresh()
  const { rt, calls } = harness({
    responses: pathname => (pathname === '/api/login'
      ? () => new Promise(resolve => setTimeout(() => resolve(json(200, {}, { 'set-cookie': `crosery_console_session=${token}` })), 20))
      : json(200, { ok: true })),
  })
  await Promise.all([request(rt, 'GET', '/api/version'), request(rt, 'GET', '/api/sync/status'), request(rt, 'GET', '/api/bootstrap')])
  await rt.session.close()
  assert.equal(calls.filter(call => call.pathname === '/api/login').length, 1)
  assert.equal(calls.filter(call => call.pathname === '/api/logout').length, 1)
})

test('缓存会话失效时并发请求都收到 401：只重登一次，每个请求都重发成功', async () => {
  const stale = fresh()
  const renewed = fresh(7_200_000)
  const execute = (_file, args) => (args[0] === 'find-generic-password' ? `${stale}\n` : '')
  const { rt, calls } = harness({
    cacheEnabled: true,
    execute,
    responses: (pathname, init) => {
      if (pathname === '/api/login') return () => new Promise(resolve => setTimeout(() => resolve(json(200, {}, { 'set-cookie': `crosery_console_session=${renewed}` })), 20))
      return init.headers.cookie === `crosery_console_session=${renewed}` ? json(200, { ok: pathname }) : json(401, { error: '请先登录' })
    },
  })
  const results = await Promise.all(['/api/version', '/api/bootstrap', '/api/channels'].map(pathname => request(rt, 'GET', pathname)))
  assert.deepEqual(results, [{ ok: '/api/version' }, { ok: '/api/bootstrap' }, { ok: '/api/channels' }])
  assert.equal(calls.filter(call => call.pathname === '/api/login').length, 1)
})

test('会话写不进钥匙串：不算已缓存，结束时注销', async () => {
  const token = fresh()
  const execute = (_file, args) => {
    if (args[0] === '-i') throw new Error('security -i failed')
    const error = new Error('not found')
    error.status = 44
    throw error
  }
  const { rt, calls } = harness({
    cacheEnabled: true,
    execute,
    responses: pathname => (pathname === '/api/login' ? json(200, {}, { 'set-cookie': `crosery_console_session=${token}` }) : json(200, {})),
  })
  await request(rt, 'GET', '/api/bootstrap')
  assert.equal(rt.session.info().cached, false)
  await rt.session.close()
  assert.equal(calls.at(-1).pathname, '/api/logout')
})

test('密码被拒后本进程不再重发：第二个请求不再 POST /api/login', async () => {
  const { rt, calls } = harness({ responses: () => json(401, { error: '管理员账号或密码不正确', code: 'invalid_credentials' }) })
  await assert.rejects(request(rt, 'GET', '/api/bootstrap'), error => error.exitCode === 3)
  await assert.rejects(request(rt, 'GET', '/api/channels'), error => error.exitCode === 3 && /不再重试/.test(error.hint))
  assert.equal(calls.filter(call => call.pathname === '/api/login').length, 1)
})

test('终端输入的密码被拒：最多再问到第 3 次失败为止，之后不再发登录', async () => {
  let asked = 0
  const calls = []
  const rt = {
    target: { base: 'http://127.0.0.1:8791', origin: 'http://127.0.0.1:8791' }, userAgent: 'cradmin/test', cacheEnabled: false, now: () => NOW, warn: () => {},
    fetch: async url => { calls.push(new URL(url).pathname); return json(401, { error: 'bad' }) },
  }
  let cached = null
  const creds = {
    username: 'admin',
    async password({ retry = false } = {}) {
      if (!retry && cached) return cached
      if (retry && cached?.tier !== 'prompt') return null
      asked += 1
      return (cached = { password: `try-${asked}`, tier: 'prompt' })
    },
    forget() { cached = null },
  }
  rt.credentials = () => creds
  rt.session = createSession(rt)
  await assert.rejects(request(rt, 'GET', '/api/bootstrap'), error => error.exitCode === 3)
  await assert.rejects(request(rt, 'GET', '/api/bootstrap'), error => error.exitCode === 3)
  assert.equal(asked, 3)
  assert.equal(calls.filter(pathname => pathname === '/api/login').length, 3)
})

test('远程目标是明文 http：拒绝发送管理员密码，退出 2', async () => {
  const { rt, calls } = harness({ responses: () => json(200, {}) })
  rt.target = { base: 'http://203.0.113.5:8791', origin: 'http://203.0.113.5:8791', host: '203.0.113.5:8791', remote: true }
  await assert.rejects(request(rt, 'GET', '/api/bootstrap'), error => error.exitCode === 2 && /明文 http/.test(error.message))
  assert.equal(calls.length, 0)
})

test('写请求超时报「结果未知」而不是「连不上」；读请求照旧', async () => {
  const hang = (_url, init) => new Promise((_resolve, reject) => {
    if (init.signal.aborted) return reject(init.signal.reason)
    init.signal.addEventListener('abort', () => reject(init.signal.reason))
  })
  const { rt } = harness({ responses: () => json(200, {}) })
  rt.session = { cookie: async () => 'c=1', invalidate: async () => false, tierLabel: () => '' }
  rt.fetch = hang
  await assert.rejects(request(rt, 'POST', '/api/sync/run/pricing', { body: {}, timeoutMs: 30, unknownHint: '用 status 确认' }),
    error => error.exitCode === 1 && /结果未知/.test(error.message) && error.hint === '用 status 确认')
  await assert.rejects(request(rt, 'GET', '/api/version', { timeoutMs: 30 }), error => /连不上控制台.*请求超时/.test(error.message))
})

test('菜单 Ctrl+C：runtime 上的中止信号让进行中的请求变成取消（130），不当成网络错误', async () => {
  const hang = (_url, init) => new Promise((_resolve, reject) => {
    if (init.signal.aborted) return reject(init.signal.reason)
    init.signal.addEventListener('abort', () => reject(init.signal.reason))
  })
  const { rt } = harness({ responses: () => json(200, {}) })
  rt.session = { cookie: async () => 'c=1', invalidate: async () => false, tierLabel: () => '' }
  rt.fetch = hang
  const controller = new AbortController()
  rt.signal = controller.signal
  const pending = request({ ...rt, rt }, 'GET', '/api/bootstrap')
  controller.abort()
  await assert.rejects(pending, error => error.exitCode === 130)
})
