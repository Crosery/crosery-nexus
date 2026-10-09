import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, createHmac } from 'node:crypto'
import { createServer } from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import { hashKey } from './cpa.js'

/**
 * API Key 用户登录（role=key）的端到端保证，真起一个 `server/index.ts` 子进程：
 * ① 登录入口：Key 登录、人工停用 401、额度停用可登录、IP 限流不因换 Key / 成功登录而重置、审计只记名字；
 * ② 角色：key 会话访问管理端（含 reveal-token）在处理器之前 403、库里无副作用；admin 行为不变、旧 token 仍是 admin；
 * ③ 隔离：A 的 /api/me* 只含 A 的数据，参数注入无效；响应里没有别的 Key、IP、UA、渠道名、上游 ID；
 * ④ 生命周期：Key 被删除/停用后会话下一次请求即失效，登出后失效；
 * ⑤ 口径：/me/usage、/me 今日、/me/requests、额度账本对同一把 Key 给出同一套数（含已下线渠道与空 provider 的流量），
 *   所有时间字段都是 UTC ISO（`…Z`）。
 */

const REPO = new URL('../', import.meta.url).pathname
const SECRET = 'me-isolation-session-secret'

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

const hex32 = (seed: string) => createHmac('sha256', 'fixture').update(seed).digest('hex').slice(0, 32)
const KEY_A = `sk-mealpha-${hex32('a')}`
const KEY_B = `sk-mebeta-${hex32('b')}`
const KEY_C = `sk-medisabled-${hex32('c')}`
const KEY_D = `sk-mequota-${hex32('d')}`
const KEY_E = `sk-medelete-${hex32('e')}`
const KEY_F = `sk-mestop-${hex32('f')}`
const KEY_G = `sk-megamma-${hex32('g')}`
const KEY_H = `sk-mehotel-${hex32('h')}`
const MARKER_A = 'marker-me-alpha-model'
const MARKER_B = 'marker-me-beta-model'
const MARKER_G1 = 'marker-me-gamma-one'
const MARKER_G2 = 'marker-me-gamma-two'
const CHANNEL = 'zz-secret-channel'
/** 已从渠道配置里下线的上游：它承载过的流量仍然是这把 Key 的花费。 */
const RETIRED = 'zz-retired-channel'
/** 这些字符串只出现在库里的敏感列；任何 /api/me* 响应都不得包含它们。 */
const SECRETS = [CHANNEL, RETIRED, '198.51.100.77', 'secret-agent/9.9', 'upstream-req-xyz', 'source-secret', 'auth-idx-secret', 'detail-secret-text']
/** 上游原样的偏移时间串（带纳秒）：响应里只许出现 UTC `Z` 形式。 */
const offsetTimestamp = (ms: number) => {
  const shifted = new Date(ms - 4 * 3_600_000).toISOString().slice(0, 19)
  return `${shifted}.${String(ms % 1000).padStart(3, '0')}744654-04:00`
}

/** G 的流量：当前渠道、已下线渠道、空 provider 各有一条；一条失败；成本都已入账。 */
type GammaEvent = { id: string; ms: number; provider: string; model: string; success: number; status: number; category: string; cost: number; offset: boolean }
function gammaEvents(now: number): GammaEvent[] {
  return [
    { id: 'req-g-1', ms: now - 4_000, provider: CHANNEL, model: MARKER_G1, success: 1, status: 200, category: '', cost: 0.5, offset: false },
    { id: 'req-g-2', ms: now - 6_000, provider: RETIRED, model: MARKER_G2, success: 1, status: 200, category: '', cost: 0.25, offset: false },
    { id: 'req-g-3', ms: now - 8_000, provider: '', model: MARKER_G2, success: 0, status: 429, category: 'rate_limited', cost: 0, offset: false },
    { id: 'req-g-4', ms: now - 10_000, provider: RETIRED, model: MARKER_G1, success: 1, status: 200, category: '', cost: 1, offset: true },
  ]
}

/** 返回播种时刻（G 的事件时间都相对它）。 */
function seed(dataDir: string): number {
  const database = new DatabaseSync(path.join(dataDir, 'console.db'))
  try {
    const now = new Date()
    const iso = now.toISOString()
    const insertKey = database.prepare(`INSERT OR REPLACE INTO api_keys
      (key_hash,key_value,name,note,enabled,groups_json,total_concurrency,group_concurrency_json,created_at,updated_at,quota_daily_usd,quota_blocked_reason)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    insertKey.run(hashKey(KEY_A), KEY_A, 'alpha-key', 'admin-private-note', 1, JSON.stringify([CHANNEL]), 4, '{}', iso, iso, 5, '')
    insertKey.run(hashKey(KEY_B), KEY_B, 'beta-key-name', '', 1, JSON.stringify([CHANNEL]), 4, '{}', iso, iso, 0, '')
    insertKey.run(hashKey(KEY_C), KEY_C, 'disabled-key', '', 0, '[]', 4, '{}', iso, iso, 0, '')
    // 额度停用：给它一个已超出的日额度 + 账本消费，保证同步循环不会把它自动恢复
    insertKey.run(hashKey(KEY_D), KEY_D, 'quota-key', '', 0, JSON.stringify([CHANNEL]), 4, JSON.stringify({ [CHANNEL]: 4 }), iso, iso, 0.01, '日额度已用完')
    insertKey.run(hashKey(KEY_E), KEY_E, 'delete-me', '', 1, '[]', 4, '{}', iso, iso, 0, '')
    insertKey.run(hashKey(KEY_F), KEY_F, 'stop-me', '', 1, '[]', 4, '{}', iso, iso, 0, '')
    insertKey.run(hashKey(KEY_G), KEY_G, 'gamma-key', '', 1, JSON.stringify([CHANNEL]), 4, '{}', '2026-07-27 03:42:10', iso, 0, '')
    insertKey.run(hashKey(KEY_H), KEY_H, 'hotel-key', '', 1, '[]', 4, '{}', iso, iso, 0, '')
    database.prepare('UPDATE api_keys SET last_used_at = ? WHERE key_hash = ?').run(offsetTimestamp(now.getTime() - 4_000), hashKey(KEY_G))
    database.prepare(`INSERT OR REPLACE INTO quota_usage_events (request_id,timestamp,timestamp_ms,key_hash,provider,model,input_tokens,output_tokens,cached_tokens,cache_write_tokens,cost_usd)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run('quota-d-1', iso, now.getTime() - 1000, hashKey(KEY_D), CHANNEL, MARKER_A, 10, 10, 0, 0, 1)

    database.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run('reporting.groups.lastKnown.v1', JSON.stringify({
        version: 1,
        generatedAt: iso,
        groups: [{ id: CHANNEL, name: 'ZZ Secret', color: '#123456', kind: 'compat', models: [MARKER_A, MARKER_B] }],
      }))

    const insertEvent = database.prepare(`INSERT INTO usage_events
      (request_id,timestamp,timestamp_ms,key_hash,provider,model,model_group,endpoint,success,status_code,
       latency_ms,ttft_ms,input_tokens,output_tokens,reasoning_tokens,cached_tokens,cache_write_tokens,total_tokens,
       user_agent,client_ip,error_detail,error_category,upstream_request_id,source,auth_index)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    const at = now.getTime() - 5_000
    // A：5 条（其中两条同一毫秒，用来压测分页边界；一条失败）；B：2 条
    const events: Array<[string, number, string, string, number, number, string]> = [
      ['req-a-1', at, hashKey(KEY_A), MARKER_A, 1, 200, ''],
      ['req-a-2', at - 1000, hashKey(KEY_A), MARKER_A, 1, 200, ''],
      ['req-a-3', at - 1000, hashKey(KEY_A), MARKER_A, 1, 200, ''],
      ['req-a-4', at - 2000, hashKey(KEY_A), MARKER_A, 0, 429, 'rate_limit'],
      ['fallback-abc', at - 3000, hashKey(KEY_A), MARKER_A, 1, 200, ''],
      ['req-b-1', at, hashKey(KEY_B), MARKER_B, 1, 200, ''],
      ['req-b-2', at - 1000, hashKey(KEY_B), MARKER_B, 0, 500, 'upstream_error'],
    ]
    for (const [requestId, ms, keyHash, model, success, status, category] of events) {
      insertEvent.run(requestId, new Date(ms).toISOString(), ms, keyHash, CHANNEL, model, CHANNEL, '/v1/messages', success, status,
        120, 40, 100, 50, 0, 10, 0, 160,
        'secret-agent/9.9', '198.51.100.77', success ? '' : 'detail-secret-text', category, 'upstream-req-xyz', 'source-secret', 'auth-idx-secret')
    }
    // G：同一请求同时进用量事件与额度账本（与 sync 的双写一致），成本逐条入账。
    const insertCostedEvent = database.prepare(`INSERT INTO usage_events
      (request_id,timestamp,timestamp_ms,key_hash,provider,model,model_group,endpoint,success,status_code,
       latency_ms,ttft_ms,input_tokens,output_tokens,reasoning_tokens,cached_tokens,cache_write_tokens,total_tokens,
       user_agent,client_ip,error_detail,error_category,upstream_request_id,source,auth_index,cost_usd)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    const insertLedger = database.prepare(`INSERT OR REPLACE INTO quota_usage_events (request_id,timestamp,timestamp_ms,key_hash,provider,model,input_tokens,output_tokens,cached_tokens,cache_write_tokens,cost_usd)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    for (const event of gammaEvents(now.getTime())) {
      const stamp = event.offset ? offsetTimestamp(event.ms) : new Date(event.ms).toISOString()
      insertCostedEvent.run(event.id, stamp, event.ms, hashKey(KEY_G), event.provider, event.model, '', '/v1/chat/completions', event.success, event.status,
        300, 90, 1000, 200, 0, 0, 0, 1200,
        'secret-agent/9.9', '198.51.100.77', event.success ? '' : 'detail-secret-text', event.category, 'upstream-req-xyz', 'source-secret', 'auth-idx-secret', event.cost)
      insertLedger.run(event.id, stamp, event.ms, hashKey(KEY_G), event.provider, event.model, 1000, 200, 0, 0, event.cost)
    }
    return now.getTime()
  } finally {
    database.close()
  }
}

type Harness = { base: string; dataDir: string; cpaBaseUrl: string; stop: () => Promise<void>; logs: () => string }

/** A CPA management API that accepts every write and lists no keys (the key PATCH syncs its key list there). */
async function startCpaStub() {
  const server = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify((req.url || '').startsWith('/v0/management/api-keys') ? { 'api-keys': [] } : {}))
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return { server, base: `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}` }
}

async function startHarness(): Promise<Harness> {
  const port = await freePort()
  const cpa = await startCpaStub()
  const cpaBaseUrl = cpa.base
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crosery-me-isolation-'))
  const child: ChildProcess = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: REPO,
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      PORT: String(port),
      HOST: '127.0.0.1',
      CONSOLE_USERNAME: 'admin',
      CONSOLE_PASSWORD: 'me-isolation-password',
      SESSION_SECRET: SECRET,
      COOKIE_SECURE: 'false',
      CPA_BASE_URL: cpaBaseUrl,
      CPA_MANAGEMENT_KEY: 'me-isolation-management-key',
      PUBLIC_GATEWAY_BASE_URL: '',
      LOGIN_MAX_FAILURES: '3',
      LOGIN_WINDOW_MS: '60000',
      KEY_LOGIN_MAX_PER_KEY: '4',
      PUBLIC_USAGE_MAX_FAILURES: '3',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let buffer = ''
  child.stdout?.on('data', chunk => { buffer += String(chunk) })
  child.stderr?.on('data', chunk => { buffer += String(chunk) })
  const base = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 25_000
  for (;;) {
    if (child.exitCode !== null) throw new Error(`服务子进程提前退出：${child.exitCode}\n${buffer}`)
    try { if ((await fetch(`${base}/api/session`)).status < 500) break } catch { /* 还没起来 */ }
    if (Date.now() > deadline) throw new Error(`服务 25s 内没就绪\n${buffer}`)
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  return {
    base,
    dataDir,
    cpaBaseUrl,
    logs: () => buffer,
    stop: async () => {
      child.kill('SIGTERM')
      await new Promise(resolve => setTimeout(resolve, 300))
      if (child.exitCode === null) child.kill('SIGKILL')
      cpa.server.close()
      fs.rmSync(dataDir, { recursive: true, force: true })
    },
  }
}

const cookieOf = (response: Response) => String(response.headers.get('set-cookie') || '').split(';')[0]

test('API Key 用户：登录、角色裁决、跨 Key 隔离、限流与生命周期', { timeout: 120_000 }, async () => {
  const harness = await startHarness()
  const ip = (n: number) => ({ 'x-forwarded-for': `203.0.113.${n}` })
  const login = (body: unknown, headers: Record<string, string> = ip(1)) => fetch(`${harness.base}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  })
  const get = (pathname: string, cookie: string, init: RequestInit = {}) =>
    fetch(`${harness.base}${pathname}`, { ...init, headers: { cookie, 'content-type': 'application/json', ...(init.headers as Record<string, string> || {}) } })
  try {
    const seededAt = seed(harness.dataDir)
    const database = new DatabaseSync(path.join(harness.dataDir, 'console.db'))
    try {
      /* ── ① 登录 ── */
      const loginA = await login({ apiKey: `  ${KEY_A}\n` }, ip(10))
      assert.equal(loginA.status, 200, '首尾空白应被容忍')
      assert.deepEqual(await loginA.json(), { ok: true, role: 'key' })
      const cookieA = cookieOf(loginA)
      assert.match(cookieA, /^crosery_console_session=\d+\.v2\.key\.[0-9a-f]{64}\.[0-9a-f]{64}$/)
      assert.ok(!cookieA.includes(KEY_A), 'Cookie 里绝不带明文 Key')

      const session = await get('/api/session', cookieA)
      const refOf = (key: string) => createHash('sha256').update(`crosery-console-key-ref|${hashKey(key)}`).digest('hex').slice(0, 16)
      assert.deepEqual(await session.json(), { authenticated: true, role: 'key', key: { name: 'alpha-key', masked: `${KEY_A.slice(0, 5)}…${KEY_A.slice(-4)}`, ref: refOf(KEY_A) } })
      assert.notEqual(refOf(KEY_A), refOf(KEY_B))
      assert.ok(!refOf(KEY_A).includes(hashKey(KEY_A).slice(0, 16)), 'ref 不是 key_hash 的前缀')

      const invalid = await login({ apiKey: `${KEY_A}x` }, ip(11))
      assert.equal(invalid.status, 401)
      assert.deepEqual(await invalid.json(), { error: 'API Key 无效', code: 'key_invalid' })
      const disabled = await login({ apiKey: KEY_C }, ip(11))
      assert.equal(disabled.status, 401)
      assert.deepEqual(await disabled.json(), { error: 'API Key 已被停用', code: 'key_disabled' })
      const quotaBlocked = await login({ apiKey: KEY_D }, ip(12))
      assert.equal(quotaBlocked.status, 200, '额度超限自动停用的 Key 仍可登录看自己的数据（与 /v1/usage 一致）')
      const cookieD = cookieOf(quotaBlocked)

      const audit = database.prepare("SELECT action, target, details FROM audit_log WHERE action = 'login_key' ORDER BY id").all() as Array<Record<string, string>>
      assert.deepEqual(audit.map(row => row.target), ['alpha-key', 'quota-key'], '审计只记 Key 名字')
      const auditText = JSON.stringify(database.prepare('SELECT * FROM audit_log').all())
      for (const key of [KEY_A, KEY_D, hashKey(KEY_A)]) assert.ok(!auditText.includes(key), '审计里不得出现明文 Key 或其 hash')

      /* ── ① 限流：只按 IP；换 Key 不换桶；用自己的有效 Key 登录成功也不清零 ── */
      for (let index = 0; index < 3; index += 1) {
        const guess = await login({ apiKey: `sk-guess-${index}-${hex32(String(index))}` }, ip(20))
        assert.equal(guess.status, 401)
      }
      const blocked = await login({ apiKey: KEY_A }, ip(20))
      assert.equal(blocked.status, 429, '同一 IP 换着 Key 猜，第 4 次（即使是有效 Key）也必须 429')
      const blockedBody = await blocked.json() as { code?: string; retryAfterSec?: number }
      assert.equal(blockedBody.code, 'rate_limited')
      assert.ok(Number(blocked.headers.get('retry-after')) >= 1 && blockedBody.retryAfterSec === Number(blocked.headers.get('retry-after')))
      assert.equal((await login({ username: 'admin', password: 'me-isolation-password' }, ip(20))).status, 200, '管理员登录的桶与 Key 登录互不串扰')

      await login({ apiKey: 'sk-guess-y1-aaaaaaaaaaaaaaaa' }, ip(21))
      await login({ apiKey: 'sk-guess-y2-aaaaaaaaaaaaaaaa' }, ip(21))
      assert.equal((await login({ apiKey: KEY_B }, ip(21))).status, 200)
      assert.equal((await login({ apiKey: 'sk-guess-y3-aaaaaaaaaaaaaaaa' }, ip(21))).status, 401)
      assert.equal((await login({ apiKey: KEY_B }, ip(21))).status, 429, '成功登录不得清零（否则「猜几次→登自己→再猜」可无限续命）')

      /* ── ② 角色：管理端在处理器之前 403，且没有任何副作用 ── */
      const keysBefore = (database.prepare('SELECT COUNT(*) count FROM api_keys').get() as { count: number }).count
      const quotaBefore = JSON.stringify(database.prepare('SELECT quota_total_usd, quota_daily_usd, quota_daily_since FROM api_keys WHERE key_hash = ?').get(hashKey(KEY_A)))
      const forbidden: Array<[string, string, unknown?]> = [
        ['POST', `/api/keys/${hashKey(KEY_B)}/reveal-token`],
        ['GET', `/api/keys/${hashKey(KEY_B)}/reveal?token=anything`],
        ['GET', '/api/keys'],
        ['POST', '/api/keys', { name: 'evil', groups: [CHANNEL] }],
        ['PATCH', `/api/keys/${hashKey(KEY_A)}/quota`, { totalUsd: 0, dailyUsd: 0, weeklyUsd: 0 }],
        ['POST', `/api/keys/${hashKey(KEY_A)}/quota/reset`, { window: 'daily' }],
        ['DELETE', `/api/keys/${hashKey(KEY_B)}`],
        ['GET', '/api/monitor'],
        ['GET', `/api/usage-page?keyId=${hashKey(KEY_B)}`],
        ['GET', '/api/bootstrap'],
        ['GET', '/api/audit'],
        ['GET', '/api/rtk/status'],
        ['POST', '/api/models/sync'],
        ['GET', '/API/BOOTSTRAP'],
        ['GET', '/api/not-a-route'],
      ]
      for (const [method, pathname, body] of forbidden) {
        const response = await get(pathname, cookieA, { method, ...(body ? { body: JSON.stringify(body) } : {}) })
        assert.equal(response.status, 403, `key 会话 ${method} ${pathname} 必须 403（实际 ${response.status}）`)
        assert.deepEqual(await response.json(), { error: '无权访问', code: 'forbidden_role' })
      }
      assert.equal((database.prepare('SELECT COUNT(*) count FROM api_keys').get() as { count: number }).count, keysBefore, '被拒请求不得建/删 Key')
      assert.equal(JSON.stringify(database.prepare('SELECT quota_total_usd, quota_daily_usd, quota_daily_since FROM api_keys WHERE key_hash = ?').get(hashKey(KEY_A))), quotaBefore, '被拒请求不得改额度')

      /* ── ② admin：行为不变；旧两段式 token 仍是 admin；/api/me 对 admin 403 not_key_session ── */
      const adminLogin = await login({ username: 'admin', password: 'me-isolation-password' }, ip(30))
      assert.deepEqual(await adminLogin.json(), { ok: true, role: 'admin' })
      const adminCookie = cookieOf(adminLogin)
      assert.deepEqual(await (await get('/api/session', adminCookie)).json(), { authenticated: true, role: 'admin', user: { name: 'admin' } })
      assert.equal((await get('/api/audit', adminCookie)).status, 200)
      const wrongAdmin = await login({ username: 'admin', password: 'nope' }, ip(31))
      assert.deepEqual(await wrongAdmin.json(), { error: '管理员账号或密码不正确', code: 'invalid_credentials' })

      const expires = String(Date.now() + 60_000)
      const legacy = `crosery_console_session=${expires}.${createHmac('sha256', SECRET).update(expires).digest('hex')}`
      assert.deepEqual(await (await get('/api/session', legacy)).json(), { authenticated: true, role: 'admin', user: { name: 'admin' } }, '部署前签发的两段式 token 仍是 admin')
      assert.equal((await get('/api/audit', legacy)).status, 200)
      const adminMe = await get('/api/me', legacy)
      assert.equal(adminMe.status, 403)
      assert.equal((await adminMe.json() as { code?: string }).code, 'not_key_session')

      const [exp, , , subject, signature] = cookieA.split('=')[1].split('.')
      for (const forged of [`${exp}.v2.admin.-.${signature}`, `${exp}.v2.admin.${subject}.${signature}`, `${exp}.v2.key.${hashKey(KEY_B)}.${signature}`, `${exp}.${signature}`]) {
        const cookie = `crosery_console_session=${forged}`
        assert.equal((await get('/api/audit', cookie)).status, 401, `伪造 token 必须 401：${forged.slice(0, 40)}`)
        assert.equal((await get('/api/me', cookie)).status, 401)
        assert.deepEqual(await (await get('/api/session', cookie)).json(), { authenticated: false })
      }

      /* ── ③ 隔离：A 只看到 A；参数注入无效；不泄漏敏感列 ── */
      const injection = `keyId=${hashKey(KEY_B)}&key_hash=${hashKey(KEY_B)}&key=${encodeURIComponent(KEY_B)}&keyHash=${hashKey(KEY_B)}`
      const meEndpoints = [
        `/api/me?${injection}`,
        `/api/me/usage?days=30&${injection}`,
        `/api/me/usage/daily?${injection}&model=${MARKER_B}&provider=zz&currentOnly=1`,
        `/api/me/requests?limit=50&${injection}`,
        `/api/me/requests?status=error&${injection}`,
        `/api/me/models?${injection}`,
        `/api/me/connect?${injection}`,
      ]
      const bodies = new Map<string, string>()
      for (const endpoint of meEndpoints) {
        const response = await get(endpoint, cookieA)
        const text = await response.text()
        assert.equal(response.status, 200, `${endpoint} 必须 200：${text.slice(0, 200)}\n${harness.logs().slice(-600)}`)
        assert.equal(response.headers.get('cache-control'), 'no-store')
        bodies.set(endpoint.split('?')[0] + (endpoint.includes('status=error') ? '#error' : ''), text)
        for (const forbiddenText of [MARKER_B, 'beta-key-name', KEY_B, hashKey(KEY_B), KEY_A, hashKey(KEY_A), 'admin-private-note', 'disabled-key', 'quota-key', 'marker-me-gamma', 'gamma-key', 'hotel-key', KEY_G, hashKey(KEY_G), ...SECRETS]) {
          assert.ok(!text.includes(forbiddenText), `${endpoint} 泄漏了「${forbiddenText}」：${text.slice(0, 300)}`)
        }
      }

      const me = JSON.parse(bodies.get('/api/me')!) as {
        key: Record<string, unknown>
        quota: { timeZone: string; daily: Record<string, unknown>; weekly: Record<string, unknown>; total: Record<string, unknown> }
        today: { requests: number; errors: number; hourly: Array<{ requests: number }>; costUsd: number | null; unpricedRequests: number }
      }
      assert.equal(me.key.name, 'alpha-key')
      assert.equal(me.key.enabled, true)
      assert.equal(me.key.blockedReason, null)
      assert.deepEqual(me.key.groups, [], '授权分组是渠道名，不对 Key 用户公开')
      assert.equal(me.quota.daily.limitUsd, 5)
      assert.equal(me.quota.weekly.limitUsd, null, '不限额 = null，不是 0')
      assert.equal(me.quota.total.resetsAt, null)
      assert.equal(me.today.hourly.reduce((sum, hour) => sum + hour.requests, 0), me.today.requests, '逐小时之和等于当天总数')
      assert.ok(me.today.requests <= 5)

      const usage = JSON.parse(bodies.get('/api/me/usage')!) as {
        days: number; daily: Array<{ requests: number; errors: number; intensity: number }>
        totals: { requests: number; errors: number; costUsd: number | null; unpricedRequests: number }
        models: Array<{ model: string; requests: number; errors: number; costUsd: number | null }>
      }
      assert.equal(usage.days, 30)
      assert.deepEqual(usage.models.map(model => model.model), [MARKER_A])
      assert.equal(usage.totals.requests, 5)
      assert.equal(usage.totals.errors, 1)
      assert.equal(usage.models[0].errors, 1)
      assert.equal(usage.totals.costUsd, null, '无价模型：null 而不是 0')
      assert.equal(usage.totals.unpricedRequests, 5)
      assert.equal(usage.daily.reduce((sum, day) => sum + day.requests, 0), 5)
      // 热力图日序列：只有会话 Key 的数（query 里的 Key / 模型 / 渠道参数一律不认），与 /me/usage 同一套数
      const daily = JSON.parse(bodies.get('/api/me/usage/daily')!) as {
        range: { year: string | number }; days: Array<{ day: string; requests: number; errors: number; topModels: Array<{ model: string }> }>
        totals: { requests: number; errors: number; costUsd: number | null }
      }
      assert.equal(daily.range.year, 'recent')
      assert.deepEqual([daily.totals.requests, daily.totals.errors, daily.totals.costUsd], [5, 1, null])
      assert.deepEqual([...new Set(daily.days.flatMap(day => day.topModels.map(model => model.model)))], [MARKER_A])
      assert.deepEqual(Object.keys(daily).sort(), ['days', 'generatedAt', 'history', 'range', 'totals', 'years'], '逐字段构造：没有 filters / scope / 渠道')

      const errorsOnly = JSON.parse(bodies.get('/api/me/requests#error')!) as { items: Array<{ success: boolean; status: number; errorCategory: string }> }
      assert.deepEqual(errorsOnly.items.map(item => [item.success, item.status, item.errorCategory]), [[false, 429, 'rate_limit']])

      // 分页：limit=2 翻完必须恰好是 A 的 5 条、不重不漏（含同一毫秒跨页边界）
      const seen: string[] = []
      let cursor: string | null = ''
      for (let page = 0; page < 10 && cursor !== null; page += 1) {
        const pageResponse = await get(`/api/me/requests?limit=2${cursor ? `&before=${encodeURIComponent(cursor)}` : ''}`, cookieA)
        const pageBody = await pageResponse.json() as { items: Array<{ id: string; model: string; requestId: string | null }>; nextBefore: string | null }
        for (const item of pageBody.items) {
          assert.equal(item.model, MARKER_A)
          seen.push(item.id)
        }
        cursor = pageBody.nextBefore
      }
      assert.equal(seen.length, 5, `分页必须恰好返回 5 条：${seen.join(',')}`)
      assert.equal(new Set(seen).size, 5, '分页不得重复')
      const firstPage = await (await get('/api/me/requests?limit=50', cookieA)).json() as { items: Array<{ requestId: string | null }> }
      assert.ok(firstPage.items.some(item => item.requestId === null), '内部生成的 fallback- 标识不当作请求 ID 返回')
      assert.equal((await get('/api/me/requests?before=not-a-date', cookieA)).status, 400)

      const connect = JSON.parse(bodies.get('/api/me/connect')!) as { baseUrl: string; anthropicBaseUrl: string | null; masked: string; configured?: boolean }
      assert.equal(connect.baseUrl, `${harness.cpaBaseUrl}/v1`, '未配置公网地址时回退本机网关')
      assert.equal(connect.anthropicBaseUrl, harness.cpaBaseUrl)
      assert.equal(connect.configured, false, 'AI-17：回退地址必须标明「未配置」，页面据此提示外部不可用')

      // 对称：B 只看到 B
      const cookieB = cookieOf(await login({ apiKey: KEY_B }, ip(40)))
      const usageBText = await (await get('/api/me/usage?days=30', cookieB)).text()
      assert.ok(usageBText.includes(MARKER_B) && !usageBText.includes(MARKER_A), `B 只能看到自己的数据：${usageBText.slice(0, 200)}`)

      // 额度停用的 Key：能看自己，模型列表如实为空并给出原因
      const meD = await (await get('/api/me', cookieD)).json() as { key: { enabled: boolean; blockedReason: string | null } }
      assert.deepEqual([meD.key.enabled, meD.key.blockedReason], [false, '日额度已用完'])
      const modelsD = await (await get('/api/me/models', cookieD)).json() as { models: unknown[]; reason: string | null }
      assert.deepEqual([modelsD.models, modelsD.reason], [[], 'key_blocked'])

      /* ── ⑤ 口径：同一把 Key 的四处数字对得上；时间都是 UTC Z ── */
      const cookieG = cookieOf(await login({ apiKey: KEY_G }, ip(60)))
      const meG = await (await get('/api/me', cookieG)).json() as {
        key: { createdAt: string | null; lastUsedAt: string | null }
        quota: Record<'daily' | 'weekly' | 'total', { spentUsd: number; resetsAt: string | null; startsAt: string | null }>
        today: { requests: number; errors: number; costUsd: number | null; hourly: Array<{ hour: string; requests: number; costUsd: number | null }>; failures: Array<{ status: number | null; category: string | null; count: number }>; avgLatencyMs: number | null }
        generatedAt: string
        degraded?: string
      }
      const usageGText = await (await get('/api/me/usage?days=7', cookieG)).text()
      for (const leaked of [RETIRED, CHANNEL, MARKER_A, MARKER_B]) assert.ok(!usageGText.includes(leaked), `G 的用量不得出现「${leaked}」`)
      const usageG = JSON.parse(usageGText) as {
        daily: Array<{ day: string; requests: number; errors: number; estimatedCostUsd: number | null }>
        totals: { requests: number; errors: number; costUsd: number | null; unpricedRequests: number }
        models: Array<{ model: string; requests: number; costUsd: number | null; errors: number }>
        failures: Array<{ status: number | null; category: string | null; count: number }>
        trackingSince: string | null
        from: string
      }
      const itemsG: Array<{ id: string; timestamp: string; success: boolean; costUsd: number | null }> = []
      let cursorG: string | null = ''
      for (let page = 0; page < 10 && cursorG !== null; page += 1) {
        const pageBody = await (await get(`/api/me/requests?limit=3${cursorG ? `&before=${encodeURIComponent(cursorG)}` : ''}`, cookieG)).json() as { items: typeof itemsG; nextBefore: string | null }
        itemsG.push(...pageBody.items)
        cursorG = pageBody.nextBefore
      }
      const seeded = gammaEvents(seededAt)
      const close = (actual: number | null | undefined, expected: number, label: string) =>
        assert.ok(typeof actual === 'number' && Math.abs(actual - expected) < 1e-9, `${label}：期望 ${expected}，实际 ${actual}`)
      const ledgerTotal = seeded.reduce((sum, event) => sum + event.cost, 0)

      // 全量：当前渠道 + 已下线渠道 + 空 provider，一条不少（修复前只算当前渠道的 1 条）
      assert.equal(itemsG.length, seeded.length)
      assert.equal(usageG.totals.requests, itemsG.length, '/me/usage 总数 = /me/requests 条数')
      assert.equal(usageG.totals.errors, itemsG.filter(item => !item.success).length, '/me/usage 失败数 = 请求列表里的失败条数')
      close(usageG.totals.costUsd, itemsG.reduce((sum, item) => sum + (item.costUsd ?? 0), 0), '/me/usage 花费 = 请求逐条花费之和')
      close(usageG.totals.costUsd, ledgerTotal, '/me/usage 花费 = 账本')
      assert.equal(usageG.totals.unpricedRequests, 0)
      close(meG.quota.weekly.spentUsd, ledgerTotal, '额度周窗口 = 账本')
      // 日历窗：日格之和恰好等于窗口总数（含花费）
      assert.equal(usageG.daily.length, 7)
      assert.equal(usageG.daily.reduce((sum, day) => sum + day.requests, 0), usageG.totals.requests, '日格之和 = 总数')
      assert.equal(usageG.daily.reduce((sum, day) => sum + day.errors, 0), usageG.totals.errors)
      close(usageG.daily.reduce((sum, day) => sum + (day.estimatedCostUsd ?? 0), 0), ledgerTotal, '日格花费之和 = 总花费')
      assert.deepEqual(usageG.models.map(model => model.model).sort(), [MARKER_G1, MARKER_G2])
      assert.equal(usageG.models.reduce((sum, model) => sum + model.requests, 0), usageG.totals.requests, '按模型之和 = 总数')
      assert.deepEqual(usageG.failures, [{ status: 429, category: 'rate_limited', count: 1 }])
      // 今日 = 额度日窗口（同一起点、同一全量口径）
      const midnight = new Date(seededAt)
      midnight.setHours(0, 0, 0, 0)
      const todayEvents = seeded.filter(event => event.ms >= midnight.getTime())
      assert.equal(meG.today.requests, todayEvents.length)
      assert.equal(meG.today.hourly.reduce((sum, hour) => sum + hour.requests, 0), meG.today.requests)
      close(meG.today.costUsd, todayEvents.reduce((sum, event) => sum + event.cost, 0), '/me 今日花费')
      close(meG.today.costUsd, meG.quota.daily.spentUsd, '/me 今日花费 = 额度日窗口已用')
      assert.equal(meG.degraded, undefined, '不再按渠道过滤，也就没有「过滤不可用」的降级')
      if (todayEvents.some(event => !event.success)) assert.deepEqual(meG.today.failures, [{ status: 429, category: 'rate_limited', count: 1 }])
      assert.equal(meG.today.avgLatencyMs, todayEvents.some(event => event.success) ? 300 : null)

      // 时间：一律 UTC ISO `Z`；偏移 + 纳秒的原串被换算成同一瞬间
      const UTC_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
      const stamps: Array<[string, string | null]> = [
        ['key.createdAt', meG.key.createdAt], ['key.lastUsedAt', meG.key.lastUsedAt], ['generatedAt', meG.generatedAt],
        ['quota.daily.resetsAt', meG.quota.daily.resetsAt], ['quota.weekly.resetsAt', meG.quota.weekly.resetsAt],
        ['quota.daily.startsAt', meG.quota.daily.startsAt], ['quota.weekly.startsAt', meG.quota.weekly.startsAt], ['quota.total.startsAt', meG.quota.total.startsAt],
        ['usage.trackingSince', usageG.trackingSince], ['usage.from', usageG.from],
        ...meG.today.hourly.map((hour, index): [string, string] => [`today.hourly[${index}]`, hour.hour]),
        ...itemsG.map((item): [string, string] => [`requests ${item.id}`, item.timestamp]),
      ]
      for (const [label, value] of stamps) assert.match(String(value), UTC_Z, `${label} 必须是 UTC Z：${value}`)
      assert.equal(meG.key.createdAt, '2026-07-27T03:42:10.000Z', '无时区的 SQLite 时间按 UTC 解释')
      assert.equal(meG.key.lastUsedAt, new Date(seeded[0].ms).toISOString())
      assert.equal(itemsG.find(item => item.id === 'req-g-4')?.timestamp, new Date(seeded[3].ms).toISOString(), '偏移时间串换算成同一瞬间')
      assert.equal(meG.quota.total.resetsAt, null)
      const fromMs = Date.parse(usageG.from)
      const fromLocal = new Date(fromMs)
      assert.deepEqual([fromLocal.getHours(), fromLocal.getMinutes()], [0, 0], '窗口从本地 00:00 起')
      assert.equal(usageG.daily[0].day, `${fromLocal.getFullYear()}-${String(fromLocal.getMonth() + 1).padStart(2, '0')}-${String(fromLocal.getDate()).padStart(2, '0')}`, '首个日格 = 窗口起点那天')

      /* ── ④ 生命周期 ── */
      const cookieE = cookieOf(await login({ apiKey: KEY_E }, ip(50)))
      assert.equal((await get('/api/me', cookieE)).status, 200)
      database.prepare('DELETE FROM api_keys WHERE key_hash = ?').run(hashKey(KEY_E))
      const afterDelete = await get('/api/me', cookieE)
      assert.equal(afterDelete.status, 401, 'Key 被删除后下一次请求即失效')
      assert.equal((await afterDelete.json() as { code?: string }).code, 'key_invalid')
      assert.match(String(afterDelete.headers.get('set-cookie')), /crosery_console_session=;/)
      assert.deepEqual(await (await get('/api/session', cookieE)).json(), { authenticated: false })

      const cookieF = cookieOf(await login({ apiKey: KEY_F }, ip(51)))
      database.prepare('UPDATE api_keys SET enabled = 0 WHERE key_hash = ?').run(hashKey(KEY_F))
      const afterDisable = await get('/api/me/usage', cookieF)
      assert.equal(afterDisable.status, 401)
      assert.equal((await afterDisable.json() as { code?: string }).code, 'key_disabled')
      // AI-09：停用期间被拒过的 token 已撤销，Key 重新启用后不复活
      database.prepare('UPDATE api_keys SET enabled = 1 WHERE key_hash = ?').run(hashKey(KEY_F))
      assert.equal((await get('/api/me', cookieF)).status, 401, '重新启用后旧会话必须重新登录')
      assert.equal((await login({ apiKey: KEY_F }, ip(52))).status, 200, '重新登录照常')

      // AI-08：对一把额度停用中的 Key 显式人工停用 → 不再按「额度停用」放行它的会话
      const meDBefore = await get('/api/me', cookieD)
      assert.equal(meDBefore.status, 200, '额度停用的 Key 会话可读自己的数据（对照）')
      const patch = await get(`/api/keys/${hashKey(KEY_D)}`, adminCookie, { method: 'PATCH', body: JSON.stringify({ enabled: false }) })
      assert.equal(patch.status, 200, `人工停用必须成功：${await patch.text()}`)
      const rowD = database.prepare('SELECT enabled, quota_blocked_reason reason FROM api_keys WHERE key_hash = ?').get(hashKey(KEY_D)) as { enabled: number; reason: string }
      assert.deepEqual([rowD.enabled, rowD.reason], [0, ''], '显式 enabled:false 清掉额度停用标记（对账不会再自动恢复它）')
      const afterManual = await get('/api/me', cookieD)
      assert.deepEqual([afterManual.status, (await afterManual.json() as { code?: string }).code], [401, 'key_disabled'])
      assert.equal((await login({ apiKey: KEY_D }, ip(53))).status, 401, '人工停用的 Key 不能再登录')

      // AI-02：同一把 Key 的成功登录有上限（本实例 KEY_LOGIN_MAX_PER_KEY=4），审计 10 分钟只记一条
      for (let index = 0; index < 4; index += 1) assert.equal((await login({ apiKey: KEY_H }, ip(70 + index))).status, 200)
      const flood = await login({ apiKey: KEY_H }, ip(75))
      const floodBody = await flood.json() as { code?: string; retryAfterSec?: number }
      assert.deepEqual([flood.status, floodBody.code], [429, 'rate_limited'], '循环登录必须被挡住（换 IP 也一样）')
      assert.ok(Number(flood.headers.get('retry-after')) >= 1 && floodBody.retryAfterSec === Number(flood.headers.get('retry-after')))
      const hotelAudit = database.prepare("SELECT COUNT(*) count FROM audit_log WHERE action = 'login_key' AND target = 'hotel-key'").get() as { count: number }
      assert.equal(hotelAudit.count, 1, '同一把 Key 的登录审计 10 分钟内只记一条，刷不掉管理员事件')

      // AI-18：/v1/usage 与控制台登录同一套 Key 查找（hash 主键），错 Key 次数按 IP 限流
      const v1 = (key: string, n: number) => fetch(`${harness.base}/v1/usage?days=7`, { headers: { authorization: `Bearer ${key}`, ...ip(n) } })
      assert.equal((await v1(KEY_A, 80)).status, 200)
      for (let index = 0; index < 3; index += 1) assert.equal((await v1(`sk-guess-v1-${index}-${hex32(`v1${index}`)}`, 81)).status, 401)
      const v1Blocked = await v1(KEY_A, 81)
      assert.equal(v1Blocked.status, 429, '同一 IP 错 Key 超过阈值后 429（不再是不限次的有效性探测口）')
      assert.ok(Number(v1Blocked.headers.get('retry-after')) >= 1)
      assert.equal((await v1(KEY_A, 82)).status, 200, '别的 IP 不受影响')
      assert.equal((await login({ apiKey: KEY_B }, ip(81))).status, 200, '/v1/usage 的失败桶不占 Key 登录的配额')
      // 同一出口（NAT/代理）上别人的错 Key 把地址锁住：此前在这个地址成功过的 Key 照常放行，
      // 没在这里成功过的 Key 不论真假都 429（锁定期间猜 Key 的人得不到有效性信号）
      assert.equal((await v1(KEY_A, 83)).status, 200)
      for (let index = 0; index < 3; index += 1) assert.equal((await v1(`sk-guess-nat-${index}-${hex32(`nat${index}`)}`, 83)).status, 401)
      assert.equal((await v1(KEY_A, 83)).status, 200, '已在本地址跑通的客户端不被同出口的错 Key 连坐')
      assert.equal((await v1(KEY_B, 83)).status, 429, '没在本地址成功过的有效 Key 也 429：不泄漏有效性')
      assert.equal((await v1(`sk-guess-nat-x-${hex32('natx')}`, 83)).status, 429)

      assert.equal((await get('/api/logout', cookieA, { method: 'POST' })).status, 200)
      assert.equal((await get('/api/me', cookieA)).status, 401, '登出后 Key 会话立即失效')
    } finally {
      database.close()
    }
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.stack || error.message : String(error)}\n--- 子进程日志 ---\n${harness.logs().slice(-1500)}`)
  } finally {
    await harness.stop()
  }
})
