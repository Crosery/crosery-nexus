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

const { createExternalJobs, installSyncCenter, launchdIntervalMs, parseModelsSyncLog, registerSyncJobs, rtkAutoupdateJob } = await import('./syncRoutes.js')
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

test('外部任务：共享目录只读状态文件', async () => {
  const now = Date.now()
  const catalogFile = write('catalog.json', JSON.stringify({
    version: 1, generatedAt: now - 60_000, provider: 'crosery', baseUrl: 'https://gw.example.test/v1', models: [{ id: 'a' }, { id: 'b' }],
    pricing: { sources: { openrouter: { ok: true }, 'models.dev': { ok: false } } },
  }))
  write('logs/sync.log', `[${new Date(now - 120_000).toISOString()}] applied: 2 models, +1 ~0 -0\n`)
  const jobs = createExternalJobs({ catalogFile, launchAgentsDir: path.join(root, 'none'), platform: 'darwin' })
  assert.deepEqual(jobs.map(job => job.id), ['catalog-sync'])
  const catalog = await jobs[0].read()
  assert.equal(catalog.lastResult, 'partial', '价格源有一个失败')
  assert.equal(catalog.summary, '2 模型 · +1 · 价格源 1/2')
  assert.equal(catalog.intervalMs, 6 * 60 * 60_000)
  assert.equal(catalog.history?.length, 1)

  const missing = createExternalJobs({ catalogFile: path.join(root, 'nope/catalog.json') })
  assert.equal((await missing[0].read()).state, 'unknown')
})

test('Linux：RTK 自动升级只读 autoupdate-rtk.json，按角色说预发布试运行 / 正式等验收，失败与退避照实显示', async () => {
  const dir = path.join(root, 'rtk-state')
  const job = rtkAutoupdateJob({ rtkStateDir: dir })
  const state = (value: Record<string, unknown>) => write('rtk-state/autoupdate-rtk.json', JSON.stringify({ version: 1, ...value }))
  assert.deepEqual(await job.read(), { intervalMs: 86_400_000, lastRunAt: null, state: 'unknown', lastResult: null, summary: '定时任务还没跑过' })
  const checkedAt = new Date(Date.now() - 3_600_000).toISOString()
  state({ role: 'preview', checkedAt, why: 'soaking', local: '0.51.0', latest: 'v0.51.0', target: 'v0.51.0',
    trial: { version: '0.51.0', status: 'soaking', soakUntil: new Date(Date.UTC(2026, 9, 3, 1, 30)).toISOString() } })
  const soaking = await job.read()
  assert.equal(soaking.lastRunAt, Date.parse(checkedAt))
  assert.equal(soaking.nextRunAt, Date.parse(checkedAt) + 86_400_000)
  assert.equal(soaking.state, 'idle')
  assert.match(soaking.summary ?? '', /^预发布 · 0\.51\.0 试运行中 · (10\/03 )?09:30 后验收$/)
  state({ role: 'production', checkedAt, why: 'not-promoted', local: '0.50.0', latest: 'v0.51.0', reasons: [{ code: 'not-promoted', text: 'v0.51.0 还没在预发布跑满 24 小时' }] })
  const waiting = await job.read()
  assert.equal(waiting.summary, '正式 · v0.51.0 等预发布试运行通过 · 本机 0.50.0')
  assert.equal(waiting.lastResult, 'skipped')
  assert.equal(waiting.lastError, null)
  state({ role: 'production', checkedAt, why: 'not-promoted', local: '0.50.0', latest: 'v0.51.0', reasons: [{ code: 'stale', text: '预发布的记录超过 7 天' }] })
  assert.equal((await job.read()).lastError, '预发布的记录超过 7 天')
  const retry = new Date(Date.now() + 2 * 3_600_000).toISOString()
  state({ role: 'production', checkedAt, why: 'error', target: 'v0.51.0', failures: 2, nextAttemptAt: retry, reasons: [{ code: 'download', text: 'v0.51.0 下载失败：HTTP 502' }] })
  const failed = await job.read()
  assert.equal(failed.state, 'error')
  assert.equal(failed.lastResult, 'error')
  assert.equal(failed.lastError, 'v0.51.0 下载失败：HTTP 502')
  assert.equal(failed.summary, '正式 · v0.51.0 没升级成功')
  assert.equal(failed.backoffUntil, Date.parse(retry))
  assert.equal(failed.backoffLevel, 2)
  assert.equal(failed.nextRunAt, Date.parse(checkedAt) + 86_400_000)

  // registered on Linux only; the Mac keeps its launchd rows
  const linux = new SyncRegistry({ file: null, log: () => undefined })
  const deps = {
    refreshAccountQuota: async () => ({}), onModelsChanged: () => undefined, addAudit: () => undefined,
    dataPlaneStatus: () => ({ enabled: false, pending: 0, deadLetters: 0, oldestPendingAgeMs: null, lastErrorCode: null, lastAttemptAt: null, lastSuccessAt: null, effectiveBatchSize: 200 }),
  }
  registerSyncJobs(linux, { ...deps, externalJobs: { platform: 'linux', rtkStateDir: dir } })
  const ids = (await linux.status()).jobs.map(item => item.id)
  assert.ok(ids.includes('rtk-autoupdate'))
  assert.ok(!ids.includes('rtk-version'))
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
  externalJobs: { catalogFile: path.join(root, 'nope/catalog.json'), platform: 'darwin' },
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
  assert.deepEqual(body.jobs.map(job => job.id), ['model-discovery', 'pricing', 'price-watch', 'cpa-catalog', 'account-quota', 'data-plane', 'catalog-sync'])
  const required = ['id', 'label', 'kind', 'intervalMs', 'lastRunAt', 'lastFinishedAt', 'nextRunAt', 'state', 'lastResult', 'lastError', 'summary',
    'backoffUntil', 'backoffLevel', 'requests24h', 'history', 'canRunNow', 'runCooldownUntil']
  for (const job of body.jobs) for (const key of required) assert.ok(key in job, `${String(job.id)} 缺少 ${key}`)
  assert.equal(body.jobs.find(job => job.id === 'data-plane')!.state, 'disabled')
  // CPA_MODELS_CATALOG_FILE unset: the catalog job is listed but never runs
  const catalog = body.jobs.find(job => job.id === 'cpa-catalog')!
  assert.deepEqual([catalog.state, catalog.canRunNow, catalog.nextRunAt, catalog.summary], ['disabled', false, null, '未设置 CPA_MODELS_CATALOG_FILE'])
  assert.equal(body.jobs.find(job => job.id === 'catalog-sync')!.canRunNow, false)
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

  const external = await fetch(`${base}/api/sync/catalog-sync/run`, { method: 'POST' })
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

test('SB-21 网关价格部分来源失败：刷新报 partial 并列出失败来源，不再显示健康', async () => {
  const { config } = await import('./config.js')
  const original = { fetch: globalThis.fetch, key: config.cpaManagementKey, base: config.cpaBaseUrl, catalog: process.env.CROSERY_SHARED_CATALOG }
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
  // Linux: the RTK systemd job is the only external row
  assert.deepEqual((await scratch.status()).jobs.map(job => job.id), ['model-discovery', 'pricing', 'model-availability', 'price-watch', 'cpa-catalog', 'account-quota', 'data-plane', 'rtk-autoupdate'])
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
  const original = { fetch: globalThis.fetch, key: config.cpaManagementKey, base: config.cpaBaseUrl, catalog: process.env.CROSERY_SHARED_CATALOG }
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
    if (original.catalog === undefined) delete process.env.CROSERY_SHARED_CATALOG
    else process.env.CROSERY_SHARED_CATALOG = original.catalog
  }
})
