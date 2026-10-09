import assert from 'node:assert/strict'
import test from 'node:test'
import { ApiError, qs, request, setAuthHooks } from '../src/api/http.js'
import { safeNext } from '../src/app/nextPath.js'
import { sharedUsageQuery } from '../src/features/usage/filters.js'
import { errorStatus } from '../src/lib/errors.js'
import { chipState, kernelWord, syncWords } from '../src/shell/statusModel.js'

/** Console v3 foundation: the client's global auth hooks, the post-login redirect guard and the chrome model. */

type Reply = { status: number; body?: unknown; headers?: Record<string, string> }

async function withFetch<T>(reply: Reply, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response(reply.body === undefined ? '' : JSON.stringify(reply.body), { status: reply.status, headers: reply.headers })) as typeof fetch
  try {
    return await run()
  } finally {
    globalThis.fetch = original
  }
}

function recordHooks() {
  const calls: Array<{ hook: 'unauthorized' | 'role'; url: string; code: string | null }> = []
  setAuthHooks({
    onUnauthorized: (error, url) => calls.push({ hook: 'unauthorized', url, code: error.code }),
    onRoleDenied: (error, url) => calls.push({ hook: 'role', url, code: error.code }),
  })
  return calls
}

test('http: errors carry status, server code and Retry-After; message falls back to 请求失败 <status>', async () => {
  recordHooks()
  const limited = await withFetch({ status: 429, body: { error: '尝试过于频繁 · 稍后再试', code: 'rate_limited' }, headers: { 'Retry-After': '42' } }, () =>
    request('/api/login', { method: 'POST' }).catch((error: unknown) => error))
  assert.ok(limited instanceof ApiError)
  assert.equal(limited.status, 429)
  assert.equal(limited.code, 'rate_limited')
  assert.equal(limited.retryAfterSec, 42)
  assert.equal(limited.message, '尝试过于频繁 · 稍后再试')
  assert.equal(errorStatus(limited), 429, 'lib/errors reads the status field, not the message')

  const bare = await withFetch({ status: 502 }, () => request('/api/keys').catch((error: unknown) => error))
  assert.equal((bare as ApiError).message, '请求失败 502')
  const nested = await withFetch({ status: 500, body: { error: { message: '上传失败', traceId: 't-1' } } }, () => request('/api/x').catch((error: unknown) => error))
  assert.equal((nested as ApiError).message, '上传失败 · Trace ID t-1')
})

test('http: 401 from a data endpoint signs out; 401 from the login/session probes is just an answer', async () => {
  const calls = recordHooks()
  await withFetch({ status: 401, body: { error: '请先登录' } }, () => request('/api/keys').catch(() => null))
  await withFetch({ status: 401, body: { error: 'API Key 已被停用', code: 'key_disabled' } }, () => request('/api/me/usage?days=7').catch(() => null))
  await withFetch({ status: 401, body: { error: 'API Key 无效', code: 'key_invalid' } }, () => request('/api/login', { method: 'POST' }).catch(() => null))
  await withFetch({ status: 401 }, () => request('/API/Session').catch(() => null))
  assert.deepEqual(calls, [
    { hook: 'unauthorized', url: '/api/keys', code: null },
    { hook: 'unauthorized', url: '/api/me/usage?days=7', code: 'key_disabled' },
  ])
})

test('http: only role codes on 403 send the user home; other 403s stay with the page', async () => {
  const calls = recordHooks()
  await withFetch({ status: 403, body: { error: '无权访问', code: 'forbidden_role' } }, () => request('/api/keys').catch(() => null))
  await withFetch({ status: 403, body: { error: '仅 API Key 登录可用', code: 'not_key_session' } }, () => request('/api/me').catch(() => null))
  const gate = await withFetch({ status: 403, body: { error: '需要确认', code: 'confirmation_required' } }, () =>
    request('/api/rtk/global', { method: 'POST' }).catch((error: unknown) => error))
  assert.deepEqual(calls.map((c) => [c.hook, c.code]), [['role', 'forbidden_role'], ['role', 'not_key_session']])
  assert.equal((gate as ApiError).code, 'confirmation_required')
  setAuthHooks({})
})

test('http: qs drops empty values and encodes the rest', () => {
  assert.equal(qs({ limit: 50, before: null, status: undefined, q: '' }), '?limit=50')
  assert.equal(qs({ before: '2026-10-02T06:00:00.000Z', model: 'a b&c' }), '?before=2026-10-02T06%3A00%3A00.000Z&model=a%20b%26c')
  assert.equal(qs({}), '')
})

test('safeNext: only same-origin app paths survive login', () => {
  for (const ok of ['/keys', '/usage/requests?days=30&keyId=k1', '/me/connect#step', '/settings']) assert.equal(safeNext(ok), ok)
  assert.equal(safeNext(['/keys', '/me']), '/keys')
  for (const bad of ['//evil.example', '/\\evil.example', 'https://evil.example/x', 'javascript:alert(1)', 'keys', '', '/api/keys', '/API/me', '/login', '/login?next=/keys', '/ok\nnext', '/a\\b', 42, null, undefined, `/${'x'.repeat(2050)}`]) {
    assert.equal(safeNext(bad), null, `应拒绝 ${JSON.stringify(bad)}`)
  }
  assert.equal(safeNext('/loginx'), '/loginx', '只拦 /login 本身，不误伤前缀相同的路径')
})

test('usage workspace: a tab switch carries shared filters and drops tab-local state', () => {
  assert.deepEqual(sharedUsageQuery({ days: '30', keyId: 'k1', page: '3', q: 'zz', request: 'r1', sort: 'x', hours: '' }), { days: '30', keyId: 'k1' })
  assert.deepEqual(sharedUsageQuery({ model: ['m1', 'm2'], provider: 'claude', client: null }), { model: 'm1', provider: 'claude' })
})

test('chrome model: sync chips, statusline words and kernel label', () => {
  const job = (over: Partial<Parameters<typeof chipState>[0]>) => ({
    label: '模型目录', state: 'idle', lastResult: 'ok', nextRunAt: null, backoffUntil: null, summary: null, lastError: null, ...over,
  })
  assert.equal(chipState(job({})), 'ok')
  assert.equal(chipState(job({ state: 'running' })), 'running')
  assert.equal(chipState(job({ state: 'backoff' })), 'backoff')
  assert.equal(chipState(job({ lastResult: 'error' })), 'failed')
  assert.equal(chipState(job({ state: 'disabled' })), 'idle')
  assert.equal(chipState(job({ lastResult: null })), 'idle', '从没跑过的任务不算正常')

  const now = Date.UTC(2026, 9, 2, 6, 0, 0)
  assert.equal(syncWords([job({}), job({ label: '账号额度' })], now), null, '全部正常时状态栏不说话')
  assert.equal(
    syncWords([job({ label: '价格元数据', state: 'backoff', backoffUntil: '2026-10-02T08:00:00Z' }), job({ label: '账号额度', state: 'running' })], now),
    '价格元数据 退避 → 16:00 · 账号额度 同步中',
  )

  assert.equal(kernelWord({ cpa: { version: 'v8.0.21', commit: '3fe2ff9c0ffee' } }), 'cpa 3fe2ff9')
  assert.equal(kernelWord({ cpa: { version: 'offline', commit: '' } }), 'cpa 离线')
  assert.equal(kernelWord({ cpa: { version: '6.1.0', commit: 'unknown' } }), 'cpa 6.1.0')
  assert.equal(kernelWord(undefined), null)
})
