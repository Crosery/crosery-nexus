import './testDataDir.js'

import assert from 'node:assert/strict'
import fs from 'node:fs'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import test, { after } from 'node:test'
import express from 'express'
import { testDataDir } from './testDataDir.js'

process.env.RTK_HOME = path.join(testDataDir, 'rtk-home')
process.env.RTK_BIN = path.join(testDataDir, 'no-rtk')
fs.mkdirSync(process.env.RTK_HOME, { recursive: true })
for (const name of ['MAGPIE_SOURCE_CPA_BASE_URL', 'MAGPIE_SOURCE_CPA_KEY', 'GATEWAY_ENGINE']) delete process.env[name]

const { createExternalJobs, installSyncCenter, launchdIntervalMs, parseModelsSyncLog } = await import('./syncRoutes.js')
const { SyncRegistry } = await import('./syncRegistry.js')

const root = fs.mkdtempSync(path.join(testDataDir, 'agents-'))
const write = (rel: string, content: string) => {
  const file = path.join(root, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
  return file
}

test('sync.log 解析：applied / failed 两种行，生成摘要与时间线', () => {
  const entries = parseModelsSyncLog([
    '[2026-10-01T10:48:02.687Z] applied: 47 models, +0 ~0 -0',
    'garbage line',
    '[2026-10-01T13:00:00.000Z] failed: TypeError: fetch failed',
    '[2026-10-01T16:48:04.415Z] applied: 64 models, +17 ~1 -2, held 3',
  ].join('\n'))
  assert.deepEqual(entries.map(entry => entry.result), ['ok', 'error', 'ok'])
  assert.equal(entries[2].summary, '64 模型 · +17 · ~1 · −2 · 暂留 3')
  assert.equal(entries[1].error, 'TypeError: fetch failed')
})

test('LaunchAgent 周期只读 plist；读不到用默认值', () => {
  const dir = path.join(root, 'LaunchAgents')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'com.example.job.plist'), '<dict><key>RunAtLoad</key><true/><key>StartInterval</key><integer>1800</integer></dict>')
  assert.equal(launchdIntervalMs('com.example.job', 1, dir), 1_800_000)
  assert.equal(launchdIntervalMs('com.example.missing', 42, dir), 42)
})

test('外部任务：共享目录、内核上游、RTK 版本只读状态文件', async () => {
  const now = Date.now()
  const catalogFile = write('catalog.json', JSON.stringify({
    version: 1, generatedAt: now - 60_000, provider: 'crosery', baseUrl: 'https://gw.example.test/v1', models: [{ id: 'a' }, { id: 'b' }],
    pricing: { sources: { openrouter: { ok: true }, 'models.dev': { ok: false } } },
  }))
  write('logs/sync.log', `[${new Date(now - 120_000).toISOString()}] applied: 2 models, +1 ~0 -0\n`)
  const upstreamDir = path.join(root, 'upstream')
  const status = { version: 1, checkedAt: new Date(now - 30_000).toISOString(), status: 'review_required', candidateRevision: 'a'.repeat(40), latestRelease: 'v0.1.604', rtkRelease: 'v0.51.0' }
  write('upstream/status.json', JSON.stringify(status))
  const jobs = createExternalJobs({ catalogFile, upstreamDir, launchAgentsDir: path.join(root, 'none'), localRtkVersion: async () => '0.50.0', magpieLocal: () => true, platform: 'darwin' })
  const [catalog, kernel, rtk] = await Promise.all(jobs.map(job => job.read()))

  assert.equal(catalog.lastResult, 'partial', '价格源有一个失败')
  assert.equal(catalog.summary, '2 模型 · +1 · 价格源 1/2')
  assert.equal(catalog.intervalMs, 6 * 60 * 60_000)
  assert.equal(catalog.history?.length, 1)
  // no LaunchAgent: auto-update is on by default but cannot run, and the row says so instead of a bare 待复核
  assert.equal(kernel.summary, '检查 · 自动更新未生效 · 待复核 aaaaaaa · v0.1.604')
  assert.equal(kernel.state, 'idle')
  assert.equal(rtk.summary, '检查 · 自动升级未生效 · 可升级 v0.51.0 · 本机 0.50.0')

  // the job runs `scheduled` and has held the candidate / the rtk release
  write('agents/com.crosery.magpie-upstream-check.plist', '<plist><dict><key>ProgramArguments</key><array><string>node</string><string>x</string><string>scheduled</string></array><key>StartInterval</key><integer>1800</integer></dict></plist>')
  write('upstream/autoupdate-magpie.json', JSON.stringify({ version: 1, candidate: 'a'.repeat(40), why: 'held', result: 'held', reasons: [{ code: 'login-agents', text: '登录方式变了：移除 dimagent' }] }))
  write('upstream/autoupdate-rtk.json', JSON.stringify({ version: 1, latest: 'v0.51.0', why: 'breaking', result: 'held', reasons: [{ code: 'breaking', text: 'v0.51.0 声明了破坏性变更' }] }))
  const live = createExternalJobs({ catalogFile, upstreamDir, launchAgentsDir: path.join(root, 'agents'), localRtkVersion: async () => '0.50.0', magpieLocal: () => true, platform: 'darwin' })
  assert.equal((await live[1].read()).summary, '检查 · 自动更新开 · aaaaaaa 停在待复核 · v0.1.604')
  assert.equal((await live[2].read()).summary, '检查 · 自动升级开 · v0.51.0 停在待复核 · 本机 0.50.0')
  write('upstream/autoupdate.json', JSON.stringify({ magpie: { enabled: false }, rtk: { enabled: false } }))
  assert.equal((await live[1].read()).summary, '检查 · 自动更新关 · 待复核 aaaaaaa · v0.1.604')
  assert.equal((await live[2].read()).summary, '检查 · 自动升级关 · 可升级 v0.51.0 · 本机 0.50.0')
  const cpa = createExternalJobs({ catalogFile, upstreamDir, launchAgentsDir: path.join(root, 'agents'), localRtkVersion: async () => '0.50.0', magpieLocal: () => false, platform: 'darwin' })
  assert.equal((await cpa[1].read()).summary, '检查 · 仅本机 Magpie 网关 · v0.1.604')

  write('upstream/status.json', JSON.stringify({ ...status, status: 'error', errorStage: 'source-checkout', error: 'Upstream check failed at source-checkout' }))
  const failed = await jobs[1].read()
  assert.equal(failed.state, 'error')
  assert.match(failed.summary ?? '', /^失败于 source-checkout · /)

  const missing = createExternalJobs({ catalogFile: path.join(root, 'nope/catalog.json'), upstreamDir: path.join(root, 'nope') })
  assert.equal((await missing[0].read()).state, 'unknown')
  assert.equal((await missing[1].read()).state, 'unknown')
})

/* ────────────────────────── 路由 ────────────────────────── */

const registry = new SyncRegistry({ file: null, log: () => undefined })
let refreshes = 0
const audits: string[] = []
const app = express()
app.use(express.json())
const center = installSyncCenter(app, {
  refreshAccountQuota: async () => {
    refreshes += 1
    return { accounts: [{ normalizedQuota: { error: null } }, { normalizedQuota: { error: 'HTTP 429' } }] }
  },
  onModelsChanged: () => undefined,
  dataPlaneStatus: () => ({ enabled: false, pending: 0, deadLetters: 0, oldestPendingAgeMs: null, lastErrorCode: null, lastAttemptAt: null, lastSuccessAt: null, effectiveBatchSize: 200 }),
  addAudit: (action, target) => { audits.push(`${action}:${target}`) },
  externalJobs: { catalogFile: path.join(root, 'nope/catalog.json'), upstreamDir: path.join(root, 'nope'), localRtkVersion: async () => null, platform: 'darwin' },
}, registry)
assert.equal(typeof center.start, 'function')
const server = app.listen(0, '127.0.0.1')
await new Promise(resolve => server.once('listening', resolve))
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
after(() => new Promise<void>(resolve => server.close(() => resolve())))

test('GET /api/sync/status 按契约 C3 返回全部任务', async () => {
  const response = await fetch(`${base}/api/sync/status`)
  assert.equal(response.status, 200)
  const body = await response.json() as { policy: Record<string, unknown>; jobs: Array<Record<string, unknown>>; generatedAt: string }
  assert.deepEqual(Object.keys(body.policy).sort(), ['backoff', 'globalUpstreamConcurrency', 'jitterPct', 'minIntervalPerHostMs'])
  assert.deepEqual(body.jobs.map(job => job.id), ['model-discovery', 'pricing', 'price-watch', 'cpa-catalog', 'account-quota', 'data-plane', 'catalog-sync', 'kernel-upstream', 'rtk-version'])
  const required = ['id', 'label', 'kind', 'intervalMs', 'lastRunAt', 'lastFinishedAt', 'nextRunAt', 'state', 'lastResult', 'lastError', 'summary',
    'backoffUntil', 'backoffLevel', 'requests24h', 'history', 'canRunNow', 'runCooldownUntil']
  for (const job of body.jobs) for (const key of required) assert.ok(key in job, `${String(job.id)} 缺少 ${key}`)
  assert.equal(body.jobs.find(job => job.id === 'data-plane')!.state, 'disabled')
  // CPA_MODELS_CATALOG_FILE unset: the catalog job is listed but never runs
  const catalog = body.jobs.find(job => job.id === 'cpa-catalog')!
  assert.deepEqual([catalog.state, catalog.canRunNow, catalog.nextRunAt, catalog.summary], ['disabled', false, null, '未设置 CPA_MODELS_CATALOG_FILE'])
  assert.equal(body.jobs.find(job => job.id === 'kernel-upstream')!.canRunNow, false)
  // CPA engine: discovery would write live routing, so it never runs on its own — only from the sync center
  const discovery = body.jobs.find(job => job.id === 'model-discovery')!
  assert.equal(discovery.intervalMs, null)
  assert.equal(discovery.nextRunAt, null)
  assert.equal(discovery.canRunNow, true)
})

test('POST /api/sync/:id/run：202 → 冷却 429（带 Retry-After）；外部任务 400；未知 404', async () => {
  const accepted = await fetch(`${base}/api/sync/account-quota/run`, { method: 'POST' })
  assert.equal(accepted.status, 202)
  assert.deepEqual(await accepted.json(), { accepted: true, jobId: 'account-quota' })
  for (let tries = 0; tries < 50 && (registry.isRunning('account-quota') || refreshes === 0); tries += 1) await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(refreshes, 1)
  const view = (await registry.status()).jobs.find(job => job.id === 'account-quota')!
  assert.equal(view.lastResult, 'partial')
  assert.equal(view.summary, '2 账号 · 1 异常')

  const cooled = await fetch(`${base}/api/sync/account-quota/run`, { method: 'POST' })
  assert.equal(cooled.status, 429)
  assert.ok(Number(cooled.headers.get('retry-after')) > 0)
  assert.equal((await cooled.json() as { code: string }).code, 'cooldown')

  const external = await fetch(`${base}/api/sync/kernel-upstream/run`, { method: 'POST' })
  assert.equal(external.status, 400)
  assert.equal((await external.json() as { code: string }).code, 'not_runnable')
  assert.equal((await fetch(`${base}/api/sync/nope/run`, { method: 'POST' })).status, 404)
  assert.deepEqual(audits, ['sync_run:account-quota'])
})

test('RTK 全局开关路由：没确认 403、参数错 400、读取不写任何东西', async () => {
  const noConfirm = await fetch(`${base}/api/rtk/global`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ on: true }) })
  assert.equal(noConfirm.status, 403)
  assert.equal((await noConfirm.json() as { code: string }).code, 'confirmation_required')
  const invalid = await fetch(`${base}/api/rtk/global`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ on: 'yes', confirm: true }) })
  assert.equal(invalid.status, 400)
  const view = await (await fetch(`${base}/api/rtk/global`)).json() as { on: boolean | null; writable: boolean; reason: string | null; agents: { supported: number } }
  assert.equal(view.agents.supported, 0)
  assert.equal(view.on, null)
  assert.equal(view.writable, false)
  assert.equal(view.reason, 'no_supported_agents')
  assert.deepEqual(fs.readdirSync(process.env.RTK_HOME!), [])
})

/* ────────────────────────── review-sync-balance ────────────────────────── */

test('SB-22 内核上游：检查脚本持久化的 nextAttemptAt / retryNotBefore 显示成 backoff 与下次真正检查时间', async () => {
  const now = Date.now()
  const upstreamDir = path.join(root, 'upstream-backoff')
  const checkedAt = now - 60_000
  const nextAttemptAt = now + 2 * 60 * 60_000
  write('upstream-backoff/status.json', JSON.stringify({
    version: 1, checkedAt: new Date(checkedAt).toISOString(), status: 'error', errorStage: 'public-metadata', failures: 3,
    nextAttemptAt: new Date(nextAttemptAt).toISOString(), retryNotBefore: new Date(now + 3 * 60 * 60_000).toISOString(), rtkRelease: 'v0.51.0',
  }))
  const jobs = createExternalJobs({ catalogFile: path.join(root, 'nope/catalog.json'), upstreamDir, launchAgentsDir: path.join(root, 'none'), localRtkVersion: async () => null })
  const kernel = await jobs[1].read()
  assert.equal(kernel.backoffUntil, now + 3 * 60 * 60_000, '取两者中更晚的')
  assert.equal(kernel.backoffLevel, 3)
  assert.equal(kernel.nextRunAt, now + 3 * 60 * 60_000)
  const scratch = new SyncRegistry({ file: null, log: () => undefined })
  for (const job of jobs) scratch.register(job)
  const view = (await scratch.status()).jobs.find(job => job.id === 'kernel-upstream')!
  assert.equal(view.state, 'backoff')
  assert.equal(view.backoffLevel, 3)
  assert.equal((await scratch.status()).jobs.find(job => job.id === 'rtk-version')!.state, 'backoff')
})

test('SB-04 兼容入口 POST /api/models/sync：与 run-now 共用冷却，冷却内返回 429 而不是再强制全量探测', async () => {
  const first = await center.runModelDiscovery()
  assert.equal(first.status, 200)
  assert.ok('result' in first && typeof first.result.summary === 'string', '放行时保持 {result} 形状')
  const second = await center.runModelDiscovery()
  assert.equal(second.status, 429)
  assert.ok(!('result' in second))
  assert.equal(second.body.code, 'cooldown')
  assert.ok(Number(second.body.retryAfterSec) > 0)
  const viaRunNow = await fetch(`${base}/api/sync/model-discovery/run`, { method: 'POST' })
  assert.equal(viaRunNow.status, 429, '两个入口是同一个冷却')
})

test('SB-07 本机控制面（magpie+local）：账号额度任务整体标为不支持，不逐账号报错、不能手动运行', async () => {
  const { config } = await import('./config.js')
  const { accountQuotaSupport, readAccountQuota, summarizeAccountQuota } = await import('./accountQuotaReader.js')
  const { normalizeAccountQuota } = await import('./accountQuota.js')
  const original = { engine: config.gatewayEngine, plane: config.magpieControlPlane }
  config.gatewayEngine = 'magpie'
  config.magpieControlPlane = 'local'
  try {
    assert.equal(accountQuotaSupport().supported, false)
    const before = (await registry.status()).jobs.find(job => job.id === 'account-quota')!
    const read = await readAccountQuota({ type: 'claude', auth_index: '1' })
    const normalized = normalizeAccountQuota('claude', read.quota, read.resetCredits)
    assert.equal(normalized.unsupported, true)
    assert.match(normalized.error ?? '', /本机控制面/)
    const outcome = summarizeAccountQuota({ accounts: [{ normalizedQuota: normalized }], quotaSupport: accountQuotaSupport() })
    assert.equal(outcome.silent, true)
    const view = (await registry.status()).jobs.find(job => job.id === 'account-quota')!
    assert.equal(view.state, 'disabled')
    assert.equal(view.canRunNow, false)
    assert.match(view.summary ?? '', /不支持/)
    assert.equal(view.requests24h, before.requests24h, '不支持时不发也不计任何上游请求')
    const run = await fetch(`${base}/api/sync/account-quota/run`, { method: 'POST' })
    assert.equal(run.status, 400)
    assert.equal((await run.json() as { code: string }).code, 'disabled')
  } finally {
    config.gatewayEngine = original.engine
    config.magpieControlPlane = original.plane
  }
})

test('SB-21 网关价格部分来源失败：刷新报 partial 并列出失败来源，不再显示健康', async () => {
  const { config } = await import('./config.js')
  const original = { fetch: globalThis.fetch, key: config.cpaManagementKey, base: config.cpaBaseUrl, engine: config.gatewayEngine, catalog: process.env.CROSERY_SHARED_CATALOG }
  config.gatewayEngine = 'cpa'
  config.cpaManagementKey = 'fixture-management-key'
  config.cpaBaseUrl = 'https://cpa.example.test'
  process.env.CROSERY_SHARED_CATALOG = path.join(root, 'nope/catalog.json')
  const priced = { id: 'priced-model', pricing: { input: 1, output: 2 }, cost: { input: 1, output: 2 } }
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input)
    if (url.endsWith('/model-definitions/gemini')) return new Response('boom', { status: 500 })
    if (url.includes('/model-definitions/')) return new Response(JSON.stringify({ models: [priced] }), { status: 200 })
    if (url.endsWith('/openai-compatibility')) return new Response(JSON.stringify({ 'openai-compatibility': [] }), { status: 200 })
    if (url.endsWith('/available-models')) return new Response(JSON.stringify({ models: [priced] }), { status: 200 })
    throw new Error(`unexpected ${url}`)
  }) as typeof fetch
  try {
    const { refreshGatewayPricingDetailed } = await import('./modelCatalog.js')
    const detailed = await refreshGatewayPricingDetailed()
    assert.equal(detailed.ok, true)
    assert.deepEqual(detailed.failedSources, ['gemini'])
    const { outcome } = await registry.run('pricing', 'manual')
    assert.equal(outcome.result, 'partial', '有价格回来但缺一个来源：不能报 ok')
    assert.match(outcome.error ?? '', /gemini/)
    assert.match(outcome.summary ?? '', /缺 1 源/)
  } finally {
    globalThis.fetch = original.fetch
    config.cpaManagementKey = original.key
    config.cpaBaseUrl = original.base
    config.gatewayEngine = original.engine
    if (original.catalog === undefined) delete process.env.CROSERY_SHARED_CATALOG
    else process.env.CROSERY_SHARED_CATALOG = original.catalog
  }
})

test('模型可用性：给了依赖才登记，周期 30 分钟；上次/下次运行、结果与告警都进同步中心', async () => {
  const scratch = new SyncRegistry({ file: null, log: () => undefined })
  let enabled = true
  let runs = 0
  installSyncCenter(express(), {
    refreshAccountQuota: async () => ({ accounts: [] }),
    onModelsChanged: () => undefined,
    dataPlaneStatus: () => ({ enabled: false, pending: 0, deadLetters: 0, oldestPendingAgeMs: null, lastErrorCode: null, lastAttemptAt: null, lastSuccessAt: null, effectiveBatchSize: 200 }),
    addAudit: () => undefined,
    externalJobs: { platform: 'linux' },
    modelAvailability: {
      enabled: () => enabled,
      run: async (context) => {
        runs += 1
        context.countRequests(3)
        return { result: 'partial', summary: '2 服务 · 在线 3', error: 'kimi：本轮将使全部 1 个对话模型下线，已保持原状态' }
      },
    },
  }, scratch)
  const view = async () => (await scratch.status()).jobs.find(job => job.id === 'model-availability')!
  assert.deepEqual((await scratch.status()).jobs.map(job => job.id), ['model-discovery', 'pricing', 'model-availability', 'price-watch', 'cpa-catalog', 'account-quota', 'data-plane'])
  assert.equal((await view()).intervalMs, 30 * 60_000)

  scratch.start()
  try {
    assert.ok((await view()).nextRunAt, '排程后有下次运行时间')
    assert.equal(scratch.requestRun('model-availability').status, 202)
    for (let tries = 0; tries < 50 && scratch.isRunning('model-availability'); tries += 1) await new Promise(resolve => setTimeout(resolve, 5))
    const ran = await view()
    assert.equal(runs, 1)
    assert.ok(ran.lastRunAt)
    assert.equal(ran.lastResult, 'partial')
    assert.match(ran.lastError ?? '', /^kimi：/)
    assert.equal(ran.requests24h, 3)
    assert.equal(scratch.requestRun('model-availability').status, 429, '手动重跑有冷却')

    enabled = false
    assert.equal((await view()).state, 'disabled')
  } finally {
    scratch.stop()
  }
})

test('价格变更任务登记在同步中心：读网关价与共享产物，共享产物缺失时报 partial 并写明原因', async () => {
  const { config } = await import('./config.js')
  const original = { fetch: globalThis.fetch, key: config.cpaManagementKey, base: config.cpaBaseUrl, engine: config.gatewayEngine, catalog: process.env.CROSERY_SHARED_CATALOG }
  config.gatewayEngine = 'cpa'
  config.cpaManagementKey = 'fixture-management-key'
  config.cpaBaseUrl = 'https://cpa.example.test'
  process.env.CROSERY_SHARED_CATALOG = path.join(root, 'nope/catalog.json')
  const priced = { id: 'watched-model', cost: { input: 1, output: 2 } }
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input)
    if (url.includes('/model-definitions/')) return new Response(JSON.stringify({ models: [priced] }), { status: 200 })
    if (url.endsWith('/openai-compatibility')) return new Response(JSON.stringify({ 'openai-compatibility': [] }), { status: 200 })
    if (url.endsWith('/available-models')) return new Response(JSON.stringify({ models: [priced] }), { status: 200 })
    throw new Error(`unexpected ${url}`)
  }) as typeof fetch
  try {
    const { outcome } = await registry.run('price-watch', 'manual')
    assert.equal(outcome.result, 'partial')
    assert.equal(outcome.summary, '无改价生效 · 价格源 1/3')
    assert.match(outcome.error ?? '', /models\.dev 读取失败：共享目录没有价格段；OpenRouter 读取失败：共享目录没有价格段/)
    const view = (await registry.status()).jobs.find(job => job.id === 'price-watch')!
    assert.deepEqual([view.intervalMs, view.requests24h, view.lastResult], [6 * 60 * 60_000, 7, 'partial'])
  } finally {
    globalThis.fetch = original.fetch
    config.cpaManagementKey = original.key
    config.cpaBaseUrl = original.base
    config.gatewayEngine = original.engine
    if (original.catalog === undefined) delete process.env.CROSERY_SHARED_CATALOG
    else process.env.CROSERY_SHARED_CATALOG = original.catalog
  }
})
