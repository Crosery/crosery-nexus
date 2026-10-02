import './testDataDir.js'

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test, { after } from 'node:test'
import { testDataDir } from './testDataDir.js'

// 远端 CPA 控制面：额度读取经 /api-call 转发。全部指向假地址，由下面的 fetch 桩应答，绝不联网。
delete process.env.GATEWAY_ENGINE
process.env.CPA_BASE_URL = 'https://cpa.example.test'
process.env.CPA_MANAGEMENT_KEY = 'fixture-management-key'

const { config } = await import('./config.js')
const reader = await import('./accountQuotaReader.js')
const { syncRegistry } = await import('./syncRegistry.js')
const { AccountQuotaCache, AccountQuotaUpstreamError } = await import('./accountQuota.js')

syncRegistry.register({ id: 'account-quota', label: '账号额度', kind: 'in-process', intervalMs: null, scheduled: false, run: async () => ({ result: 'ok' }) })
const requests24h = async () => (await syncRegistry.status()).jobs.find(job => job.id === 'account-quota')!.requests24h ?? 0

type Upstream = (url: string) => { status_code: number; body?: unknown; header?: Record<string, string[]> }
let upstream: Upstream = () => ({ status_code: 200, body: {} })
let active = 0
let peak = 0
let calls: string[] = []
const originalFetch = globalThis.fetch
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input)
  if (url !== `${config.cpaBaseUrl}/v0/management/api-call`) throw new Error(`unexpected ${url}`)
  const request = JSON.parse(String(init?.body)) as { url: string }
  calls.push(request.url)
  active += 1
  peak = Math.max(peak, active)
  await new Promise(resolve => setTimeout(resolve, 5))
  active -= 1
  return new Response(JSON.stringify(upstream(request.url)), { status: 200 })
}) as typeof fetch
after(() => { globalThis.fetch = originalFetch })

const reset = () => {
  calls = []
  peak = 0
  for (const cache of [reader.claudeQuotaCache, reader.codexUsageCache, reader.codexCreditsCache, reader.antigravityQuotaCache]) cache.clear()
}

test('SB-16 全局上游闸门：3 个 Claude 账号并发（usage + profile = 6 次转发）同时在途不超过 4', async () => {
  reset()
  upstream = (url) => ({ status_code: 200, body: url.endsWith('/usage') ? { five_hour: { utilization: 1 } } : { account: {} } })
  const before = await requests24h()
  await Promise.all(['c1', 'c2', 'c3'].map(index => reader.readAccountQuota({ type: 'claude', auth_index: index })))
  assert.equal(calls.length, 6)
  assert.equal(peak, 4, `同时在途 ${peak}（无闸门时是 6）`)
  assert.equal(await requests24h() - before, 6, '每次真实转发计一次')
})

test('SB-11 AntiGravity 一个账号的多次真实请求（换域名 + loadCodeAssist）按实际次数计数', async () => {
  reset()
  upstream = (url) => {
    if (url.includes('loadCodeAssist')) return { status_code: 200, body: { currentTier: { id: 'g1-pro-tier', name: 'Pro' } } }
    if (url.startsWith('https://daily-cloudcode-pa.googleapis.com')) return { status_code: 503, body: 'busy' }
    return { status_code: 200, body: { groups: [{ displayName: 'Gemini Models', buckets: [{ remainingFraction: 0.5 }] }] } }
  }
  const before = await requests24h()
  const read = await reader.readAccountQuota({ type: 'antigravity', auth_index: 'ag1', project_id: 'project-1' })
  assert.ok(!(read.quota as { error?: string }).error)
  assert.equal(calls.length, 3)
  assert.equal(await requests24h() - before, 3)
})

test('SB-14 / SB-15 冷却落进同步中心状态（不含凭据）；上游 2h 的 Retry-After 不被 1h 封顶截短；重启后恢复不再打上游', async () => {
  reset()
  upstream = (url) => (url.endsWith('/wham/usage')
    ? { status_code: 429, body: 'slow down', header: { 'Retry-After': ['7200'] } }
    : { status_code: 200, body: { available_count: 0, credits: [] } })
  const startedAt = Date.now()
  const first = await reader.readAccountQuota({ type: 'codex', auth_index: 'cx1' })
  assert.match(String((first.quota as { error?: string }).error), /429/)
  const saved = structuredClone(syncRegistry.jobData('account-quota').cooldowns) as { codexUsage: Record<string, { blockedUntil: number; failures: number }> }
  const blockedUntil = saved.codexUsage.cx1.blockedUntil
  assert.ok(blockedUntil - startedAt >= 7_200_000 - 1_000, `冷却应服从上游 2h，实际 ${blockedUntil - startedAt}ms`)
  assert.equal(saved.codexUsage.cx1.failures, 1)

  syncRegistry.flush()
  const onDisk = fs.readFileSync(path.join(testDataDir, 'sync-state.json'), 'utf8')
  assert.ok(onDisk.includes('"cx1"'))
  assert.ok(!onDisk.includes('fixture-management-key'), '状态文件不含任何凭据')

  // 模拟重启：内存缓存清空，从状态文件恢复
  reader.codexUsageCache.clear()
  syncRegistry.jobData('account-quota').cooldowns = saved
  reader.restoreAccountQuotaCooldowns()
  calls = []
  const again = await reader.readAccountQuota({ type: 'codex', auth_index: 'cx1' })
  assert.equal(calls.filter(url => url.endsWith('/wham/usage')).length, 0, '冷却未到期，重启后不再打上游')
  assert.match(String((again.quota as { error?: string }).error), /冷却至/)
})

test('SB-14 恢复的失败档位接着翻倍，而不是重启后回到第一档', async () => {
  const clock = { now: 1_000_000 }
  const options = { ttlMs: 60_000, rateLimitCooldownMs: 10 * 60_000, maxCooldownMs: 60 * 60_000, jitterPct: 0, now: () => clock.now }
  const before = new AccountQuotaCache<{ v: number }>(options)
  await before.read('a', async () => { throw new AccountQuotaUpstreamError(429, 'HTTP 429') })
  const snapshot = before.exportCooldowns()
  const restarted = new AccountQuotaCache<{ v: number }>(options)
  restarted.importCooldowns(JSON.parse(JSON.stringify(snapshot)))
  let fetched = 0
  clock.now += 5 * 60_000
  await restarted.read('a', async () => { fetched += 1; return { v: 1 } })
  assert.equal(fetched, 0)
  clock.now += 6 * 60_000
  const second = await restarted.read('a', async () => { fetched += 1; throw new AccountQuotaUpstreamError(429, 'HTTP 429') })
  assert.equal(fetched, 1)
  assert.equal(second.blockedUntil, clock.now + 20 * 60_000, '第二次 429：20 分钟，而不是重启后又从 10 分钟起')
  restarted.importCooldowns({ x: { blockedUntil: 'never', failures: -1 }, y: null, z: { blockedUntil: clock.now + 1e15, failures: 2 } })
  assert.ok(restarted.exportCooldowns().z.blockedUntil <= clock.now + 24 * 60 * 60_000, '离谱的恢复值被夹住')
  assert.equal(restarted.exportCooldowns().x, undefined)
})

test('SB-14 冷却落盘与恢复都去掉错误文案里夹带的凭据（CPA 管理面的错误体可能回显 Authorization）', async () => {
  reset()
  const leaked = 'CPA 500: {"error":"bad auth","authorization":"Bearer sk-live-abcdefghijklmnop0123"}'
  await reader.codexUsageCache.read('leak', async () => { throw new Error(leaked) })
  reader.persistAccountQuotaCooldowns()
  const saved = syncRegistry.jobData('account-quota').cooldowns as { codexUsage: Record<string, { lastError?: string }> }
  assert.ok(saved.codexUsage.leak, '冷却照常落盘')
  assert.ok(!String(saved.codexUsage.leak.lastError).includes('sk-live-abcdefghijklmnop0123'))
  syncRegistry.flush()
  assert.ok(!fs.readFileSync(path.join(testDataDir, 'sync-state.json'), 'utf8').includes('abcdefghijklmnop0123'))

  // 旧版本写下的明文：恢复时同样去掉
  reader.codexUsageCache.clear()
  syncRegistry.jobData('account-quota').cooldowns = { codexUsage: { old: { blockedUntil: Date.now() + 600_000, failures: 1, lastError: leaked } } }
  reader.restoreAccountQuotaCooldowns()
  assert.ok(!String(reader.codexUsageCache.exportCooldowns().old.lastError).includes('abcdefghijklmnop0123'))
  assert.ok(!JSON.stringify(syncRegistry.jobData('account-quota').cooldowns).includes('abcdefghijklmnop0123'), '状态里的旧明文也被换掉，下一次落盘不会写回去')
  syncRegistry.flush()
  assert.ok(!fs.readFileSync(path.join(testDataDir, 'sync-state.json'), 'utf8').includes('abcdefghijklmnop0123'))
  reader.codexUsageCache.clear()
})

test('SB-14 Claude 重置成功后清冷却走 clearAccountQuota（同时更新落盘状态），而不是只清内存', async () => {
  reset()
  upstream = () => ({ status_code: 429, body: '{}' })
  await reader.readAccountQuota({ type: 'claude', auth_index: 'cl-reset' })
  const before = syncRegistry.jobData('account-quota').cooldowns as { claude: Record<string, unknown> }
  assert.ok(before.claude['cl-reset:usage'], '前提：冷却已落进状态')
  reader.clearAccountQuota('cl-reset')
  const after = syncRegistry.jobData('account-quota').cooldowns as { claude: Record<string, unknown> }
  assert.equal(after.claude['cl-reset:usage'], undefined)

  const source = fs.readFileSync(new URL('./index.ts', import.meta.url), 'utf8')
  const route = source.slice(source.indexOf("app.post('/api/accounts/:authIndex/reset-claude-quota'"))
  const handler = route.slice(0, route.indexOf('\napp.'))
  assert.match(handler, /clearAccountQuota\(authIndex\)/)
  assert.doesNotMatch(handler, /claudeQuotaCache\.clear\(/)
})
