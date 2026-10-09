import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type express from 'express'
import { config } from './config.js'
import { summarizeAccountQuota } from './accountQuotaReader.js'
import type { DataPlaneRelayStatus } from './dataPlane.js'
import { gatewayPricingMap, gatewayPricingRequests, refreshGatewayPricingDetailed, refreshSharedPricingIfStale } from './modelCatalog.js'
import {
  DISCOVERY_POLICY, discoveryBackoff, nextDiscoveryAt, readSharedCatalog, sanitizeDiscoveryState, sharedCatalogPath, startModelCatalogWatcher, syncUpstreamModels,
  type DiscoveryState, type ModelSyncResult,
} from './modelSync.js'
import { pricingSourceStatus } from './pricing.js'
import { isoOrNull, syncRegistry, type ExternalJobDef, type ExternalSnapshot, type SyncOutcome, type SyncRegistry, type SyncResult, type SyncRunContext } from './syncRegistry.js'
import { PROBE_INTERVAL_MS } from './modelAvailability.js'
import { rtkStateDir } from './autoupdate.js'
import { CATALOG_INTERVAL_MS, runCpaCatalogSync, sanitizeCatalogData } from './cpaCatalog.js'
import { PRICE_WATCH_INTERVAL_MS, gatewayPriceRead, priceWatcher, sharedPriceReads } from './priceWatch.js'
import { DEFAULT_KERNEL_WINDOW, zonedClock } from './kernels.js'

/* ────────────────────────── 外部（launchd）任务：只读状态文件 ────────────────────────── */

const MAX_STATUS_BYTES = 1024 * 1024
const MAX_LOG_TAIL_BYTES = 32 * 1024

function readJsonFile(file: string): Record<string, unknown> | null {
  try {
    const stat = fs.statSync(file)
    if (!stat.isFile() || stat.size > MAX_STATUS_BYTES) return null
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

function readTail(file: string, bytes = MAX_LOG_TAIL_BYTES): string {
  try {
    const stat = fs.statSync(file)
    if (!stat.isFile()) return ''
    const length = Math.min(stat.size, bytes)
    const handle = fs.openSync(file, 'r')
    try {
      const buffer = Buffer.alloc(length)
      fs.readSync(handle, buffer, 0, length, stat.size - length)
      return buffer.toString('utf8')
    } finally {
      fs.closeSync(handle)
    }
  } catch {
    return ''
  }
}

/** 从 LaunchAgent plist 读 StartInterval（秒）；读不到就用调用方给的默认值。只读，不碰 launchctl。 */
export function launchdIntervalMs(label: string, fallbackMs: number, directory = path.join(os.homedir(), 'Library/LaunchAgents')): number {
  try {
    const xml = fs.readFileSync(path.join(directory, `${label}.plist`), 'utf8')
    const match = /<key>StartInterval<\/key>\s*<integer>(\d+)<\/integer>/.exec(xml)
    const seconds = match ? Number(match[1]) : NaN
    return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : fallbackMs
  } catch {
    return fallbackMs
  }
}

const parseTime = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value
  if (typeof value === 'string') {
    const at = Date.parse(value)
    return Number.isFinite(at) ? at : null
  }
  return null
}

const tag = (value: unknown): string | null => (typeof value === 'string' && /^v?\d+\.\d+\.\d+[-.a-zA-Z0-9]*$/.test(value) ? value : null)

export type ExternalJobOptions = {
  catalogFile?: string
  launchAgentsDir?: string
  platform?: NodeJS.Platform
  /** Linux: scripts/rtk-autoupdate.mjs 的状态目录（RTK_STATE_DIR，与 crosery-rtk-autoupdate.service 相同） */
  rtkStateDir?: string
}

/** `sync.log` 行：`[ISO] applied: 64 models, +17 ~0 -0[, held N][, confirmed-removed N]` 或 `[ISO] failed: …`。 */
export function parseModelsSyncLog(text: string): Array<{ at: number; result: SyncResult; summary: string | null; error: string | null }> {
  const entries: Array<{ at: number; result: SyncResult; summary: string | null; error: string | null }> = []
  for (const line of text.split('\n')) {
    const match = /^\[([^\]]+)\]\s+(applied|failed):\s*(.*)$/.exec(line.trim())
    if (!match) continue
    const at = Date.parse(match[1])
    if (!Number.isFinite(at)) continue
    if (match[2] === 'failed') {
      entries.push({ at, result: 'error', summary: null, error: match[3].slice(0, 200) })
      continue
    }
    const counts = /(\d+)\s+models,\s*\+(\d+)\s*~(\d+)\s*-(\d+)/.exec(match[3])
    let summary: string | null = null
    if (counts) {
      const [, total, added, changed, removed] = counts.map(Number)
      summary = [`${total} 模型`, added ? `+${added}` : '', changed ? `~${changed}` : '', removed ? `−${removed}` : ''].filter(Boolean).join(' · ')
      const held = /held\s+(\d+)/.exec(match[3])
      if (held) summary += ` · 暂留 ${held[1]}`
    }
    entries.push({ at, result: 'ok', summary, error: null })
  }
  return entries
}

export function createExternalJobs(options: ExternalJobOptions = {}): ExternalJobDef[] {
  const catalogFile = options.catalogFile ?? sharedCatalogPath()
  const agentsRoot = path.dirname(catalogFile)
  const catalogSync: ExternalJobDef = {
    id: 'catalog-sync',
    label: '共享模型目录',
    kind: 'external',
    read: (): ExternalSnapshot => {
      const intervalMs = launchdIntervalMs('com.crosery.crosery-models-sync', 6 * 60 * 60_000, options.launchAgentsDir)
      const catalog = readJsonFile(catalogFile)
      const log = parseModelsSyncLog(readTail(path.join(agentsRoot, 'logs/sync.log')))
      const last = log.at(-1)
      const lastSuccess = [...log].reverse().find(entry => entry.result === 'ok')
      const generatedAt = parseTime(catalog?.generatedAt)
      const lastRunAt = last?.at ?? generatedAt
      if (!lastRunAt) return { intervalMs, lastRunAt: null, state: 'unknown', lastResult: null, summary: catalog ? null : '未找到共享目录' }
      const sources = catalog?.pricing && typeof catalog.pricing === 'object' ? (catalog.pricing as { sources?: Record<string, { ok?: boolean }> }).sources ?? {} : {}
      const sourceList = Object.values(sources)
      const priceNote = sourceList.length ? `价格源 ${sourceList.filter(source => source?.ok).length}/${sourceList.length}` : ''
      const models = Array.isArray(catalog?.models) ? catalog.models.length : null
      const summary = [last?.result === 'ok' ? last.summary : lastSuccess?.summary ?? (models !== null ? `${models} 模型` : null), priceNote].filter(Boolean).join(' · ') || null
      const result: SyncResult = last?.result ?? 'ok'
      return {
        intervalMs,
        lastRunAt,
        nextRunAt: lastRunAt + intervalMs,
        state: result === 'error' ? 'error' : 'idle',
        lastResult: result === 'ok' && sourceList.some(source => source?.ok === false) ? 'partial' : result,
        lastError: last?.result === 'error' ? last.error : null,
        summary,
        history: log.map(entry => ({ at: entry.at, result: entry.result })),
      }
    },
  }

  return [catalogSync]
}

const RTK_DAILY_MS = 24 * 60 * 60_000
const RTK_FAILED = new Set(['error', 'verify-failed', 'rolled-back', 'trial-failed', 'rate-limited', 'no-release', 'unsupported', 'unwritable'])

/**
 * Linux（预发布、正式）：crosery-rtk-autoupdate.timer 每天跑一次 scripts/rtk-autoupdate.mjs auto，这里只读它的
 * autoupdate-rtk.json。预发布先装上新版本试运行满时长，正式只装预发布验收过的版本。
 */
export function rtkAutoupdateJob(options: ExternalJobOptions = {}): ExternalJobDef {
  const dir = options.rtkStateDir ?? rtkStateDir()
  return {
    id: 'rtk-autoupdate',
    label: 'RTK 自动升级',
    kind: 'external',
    read: (): ExternalSnapshot => {
      const intervalMs = RTK_DAILY_MS
      const s = readJsonFile(path.join(dir, 'autoupdate-rtk.json'))
      const checkedAt = parseTime(s?.checkedAt)
      if (!s || !checkedAt) return { intervalMs, lastRunAt: null, state: 'unknown', lastResult: null, summary: '定时任务还没跑过' }
      const now = Date.now()
      const clock = (value: unknown) => { const at = parseTime(value); return at ? zonedClock(at, now, DEFAULT_KERNEL_WINDOW.tz) : '—' }
      const local = tag(s.local)
      const latest = tag(s.latest)
      const target = tag(s.target)
      const trial = s.trial && typeof s.trial === 'object' ? s.trial as Record<string, unknown> : null
      const reasons = Array.isArray(s.reasons) ? s.reasons as Array<{ code?: unknown; text?: unknown }> : []
      const reason = typeof reasons[0]?.text === 'string' ? reasons[0].text.slice(0, 200) : null
      const why = typeof s.why === 'string' ? s.why : ''
      const failed = RTK_FAILED.has(why)
      const words: Record<string, string> = {
        disabled: '自动升级关',
        missing: '本机没有安装 rtk',
        'up-to-date': `已是最新 ${latest ?? local ?? ''}`.trim(),
        upgraded: trial?.status === 'soaking' ? `已升级到 ${local} · 试运行到 ${clock(trial.soakUntil)} 后验收` : `已升级到 ${local}`,
        soaking: `${tag(trial?.version) ?? target} 试运行中 · ${clock(trial?.soakUntil)} 后验收`,
        accepted: `${tag(trial?.version) ?? target} 试运行通过 · 正式下次检查可装`,
        'not-promoted': `${latest} 等预发布试运行通过 · 本机 ${local ?? '—'}`,
        breaking: `${target ?? latest} 停在待复核`,
        'no-latest': '还没取到 rtk 最新版本',
      }
      const role = s.role === 'preview' ? '预发布' : s.role === 'production' ? '正式' : ''
      const text = failed ? `${target ?? latest ?? ''} 没升级成功`.trim() : words[why] ?? (local ? `本机 ${local}` : '—')
      const deadline = Math.max(parseTime(s.nextAttemptAt) ?? 0, parseTime(s.retryNotBefore) ?? 0)
      const backoffUntil = deadline > now ? deadline : null
      return {
        intervalMs,
        lastRunAt: checkedAt,
        nextRunAt: Math.max(checkedAt + intervalMs, backoffUntil ?? 0),
        backoffUntil,
        backoffLevel: backoffUntil ? Math.max(1, Math.floor(Number(s.failures) || 0)) : 0,
        state: failed ? 'error' : 'idle',
        lastResult: failed ? 'error' : why === 'disabled' || why === 'missing' || why === 'breaking' || why === 'not-promoted' ? 'skipped' : 'ok',
        // production waiting for preview is normal; an unusable preview record is not
        lastError: failed || (why === 'not-promoted' && reasons[0]?.code !== 'not-promoted') ? reason : null,
        summary: [role, text].filter(Boolean).join(' · '),
      }
    },
  }
}

/* ────────────────────────── 进程内任务 ────────────────────────── */

export type SyncCenterDeps = {
  /** 丢掉 /api/monitor 的整页缓存后重新加载一次；上游请求仍受每账号 TTL/冷却约束。 */
  refreshAccountQuota: () => Promise<unknown>
  /** 模型表有新增时清控制面缓存（渠道快照、模型索引）。 */
  onModelsChanged: () => void
  dataPlaneStatus: () => DataPlaneRelayStatus
  addAudit: (action: string, target: string, detail: string) => void
  externalJobs?: ExternalJobOptions
  /** 模型可用性探测（server/modelAvailability.ts）；不给就不登记。 */
  modelAvailability?: {
    enabled: () => boolean
    run: (context: SyncRunContext) => Promise<SyncOutcome & { value?: unknown }>
  }
}

const iso = isoOrNull

export function registerSyncJobs(registry: SyncRegistry, deps: SyncCenterDeps): void {
  registry.register({
    id: 'model-discovery',
    label: '模型目录',
    kind: 'in-process',
    intervalMs: config.modelDiscoveryScheduled ? DISCOVERY_POLICY.channelIntervalMs : null,
    tickMs: DISCOVERY_POLICY.tickMs,
    scheduled: config.modelDiscoveryScheduled,
    initialDelayMs: 60_000,
    manualCooldownMs: 5 * 60_000,
    // 手动运行仍服从每主机/每渠道退避（runDiscovery 在 force 下也跳过退避中的主机），任务级退避从不设置。
    manualBypassesBackoff: true,
    sanitizeData: (data, now) => { sanitizeDiscoveryState(data, now) },
    run: async (context) => {
      const result = await syncUpstreamModels({
        force: context.trigger === 'manual',
        state: context.data as DiscoveryState,
        deps: { countRequest: () => context.countRequests() },
      })
      if (result.addedModels.length) deps.onModelsChanged()
      return {
        result: result.result,
        summary: result.summary,
        error: result.errors.length ? result.errors.join('；') : null,
        silent: result.silent,
        skipBackoff: true,
        value: result,
      }
    },
    nextRunAt: (data, now) => (config.modelDiscoveryScheduled ? nextDiscoveryAt(data as DiscoveryState, now) : null),
    overlay: (now) => {
      if (registry.isRunning('model-discovery')) return {}
      const backoff = discoveryBackoff(registry.jobData('model-discovery') as DiscoveryState, now)
      return backoff ? { state: 'backoff', backoffUntil: iso(backoff.backoffUntil), backoffLevel: backoff.backoffLevel } : {}
    },
  })

  registry.register({
    id: 'pricing',
    label: '价格元数据',
    kind: 'in-process',
    intervalMs: 30 * 60_000,
    initialDelayMs: 5_000,
    manualCooldownMs: 5 * 60_000,
    // 不打第三方上游：本机控制面只读磁盘，CPA 控制面读的是自己的管理接口。管理员修好控制面后应能立即重刷，
    // 不必等任务级退避（最长 6h）结束；手动冷却照常生效。
    manualBypassesBackoff: true,
    run: async (context) => {
      const gateway = await refreshGatewayPricingDetailed()
      context.countRequests(gateway.requests)
      await refreshSharedPricingIfStale(0)
      const shared = pricingSourceStatus()
      const parts = [`网关 ${gateway.priced}`, `双源 ${shared.models}`]
      if (gateway.added) parts.push(`+${gateway.added}`)
      if (gateway.failedSources.length) parts.push(`缺 ${gateway.failedSources.length} 源`)
      const degraded = shared.degraded.length > 0
      const gatewayPartial = gateway.ok && gateway.failedSources.length > 0
      const result: SyncResult = gateway.ok ? (degraded || gatewayPartial ? 'partial' : 'ok') : shared.models > 0 ? 'partial' : 'error'
      const errors = [
        gateway.error,
        gatewayPartial ? `网关价格源失败（沿用上次价格）：${gateway.failedSources.join('、')}` : null,
        degraded ? `双源降级：${shared.degraded.join('、')}` : null,
      ].filter(Boolean)
      if (gateway.added) {
        console.log(JSON.stringify({ category: '[AUDIT]', event: 'pricing.gateway_merge', stage: context.trigger, outcome: 'ok', added: gateway.added }))
      }
      return { result, summary: parts.join(' · '), error: errors.length ? errors.join('；') : null }
    },
  })

  if (deps.modelAvailability) {
    const job = deps.modelAvailability
    registry.register({
      id: 'model-availability',
      label: '模型可用性',
      kind: 'in-process',
      intervalMs: PROBE_INTERVAL_MS,
      // 重启后按状态文件里的下次时间续上；首次启动先等渠道快照和对账稳定
      initialDelayMs: 3 * 60_000,
      // 每轮对每个对话模型各发一次请求：手动重跑的冷却放长，避免变成刷上游的按钮
      manualCooldownMs: 10 * 60_000,
      enabled: job.enabled,
      run: (context) => job.run(context),
    })
  }

  registry.register({
    id: 'price-watch',
    label: '价格变更',
    kind: 'in-process',
    intervalMs: PRICE_WATCH_INTERVAL_MS,
    initialDelayMs: 3 * 60_000,
    manualCooldownMs: 5 * 60_000,
    // 只读本机网关的管理接口和共享产物，不打第三方上游。
    manualBypassesBackoff: true,
    run: (context) => priceWatcher.run({
      now: context.now(),
      readOfficial: async () => {
        const failures: string[] = []
        context.countRequests(gatewayPricingRequests())
        return gatewayPriceRead(await gatewayPricingMap(failures), failures, context.now())
      },
      readShared: () => sharedPriceReads(readSharedCatalog()?.pricing),
      audit: deps.addAudit,
    }),
  })

  registry.register({
    id: 'cpa-catalog',
    label: 'CPA 模型目录',
    kind: 'in-process',
    intervalMs: CATALOG_INTERVAL_MS,
    initialDelayMs: 2 * 60_000,
    manualCooldownMs: 5 * 60_000,
    // 拉的是第三方（GitHub）：出错退避照常生效，手动也不能绕过。
    enabled: () => Boolean(config.cpaModelsCatalogFile),
    sanitizeData: (data) => { sanitizeCatalogData(data) },
    overlay: () => (config.cpaModelsCatalogFile ? {} : { summary: '未设置 CPA_MODELS_CATALOG_FILE' }),
    run: (context) => runCpaCatalogSync({
      file: config.cpaModelsCatalogFile,
      historyFile: path.join(config.dataDir, 'cpa-catalog-history.jsonl'),
      data: context.data,
      now: context.now,
      countRequest: () => context.countRequests(),
      audit: deps.addAudit,
    }),
  })

  registry.register({
    id: 'account-quota',
    label: '账号额度',
    kind: 'in-process',
    intervalMs: null,
    scheduled: false,
    manualCooldownMs: 2 * 60_000,
    // 每账号/每端点冷却在读取层生效（冷却中的账号不打上游），任务级退避从不设置（skipBackoff）。
    manualBypassesBackoff: true,
    run: async () => {
      const payload = await deps.refreshAccountQuota()
      return { ...summarizeAccountQuota(payload as Parameters<typeof summarizeAccountQuota>[0]), value: payload }
    },
  })

  registry.register({
    id: 'data-plane',
    label: '数据桥',
    kind: 'in-process',
    intervalMs: config.dataPlaneRelayIntervalMs,
    scheduled: false,
    runnable: false,
    enabled: () => config.dataPlaneEnabled,
    overlay: () => {
      try {
        const status = deps.dataPlaneStatus()
        if (!status.enabled) return { summary: `积压 ${status.pending}` }
        const failing = Boolean(status.lastErrorCode) && (status.lastAttemptAt ?? 0) >= (status.lastSuccessAt ?? 0)
        return {
          lastRunAt: iso(status.lastAttemptAt),
          lastFinishedAt: iso(status.lastAttemptAt),
          lastResult: status.lastAttemptAt ? (failing ? 'error' : 'ok') : null,
          lastError: failing ? status.lastErrorCode : null,
          state: failing ? 'error' : 'idle',
          summary: `积压 ${status.pending} · 死信 ${status.deadLetters}`,
        }
      } catch {
        return { state: 'unknown' }
      }
    },
  })

  // the Mac's external jobs are launchd agents; a Linux host (preview, production) has the RTK systemd timer
  const platform = deps.externalJobs?.platform ?? process.platform
  if (platform === 'darwin') {
    for (const job of createExternalJobs(deps.externalJobs)) registry.register(job)
  } else if (platform === 'linux') {
    registry.register(rtkAutoupdateJob(deps.externalJobs))
  }
}

/* ────────────────────────── 路由 ────────────────────────── */

type RtkFailureBody = { status: number; error: string; plane?: string; reason?: string }

async function rtkError(res: express.Response, error: unknown) {
  const { rtkFailure } = await import('./rtkService.js')
  const failure = rtkFailure(error) as RtkFailureBody
  res.status(failure.status).json({ error: failure.error, ...(failure.plane ? { plane: failure.plane } : {}), ...(failure.reason ? { reason: failure.reason, code: failure.reason } : {}) })
}

export function installSyncCenter(app: express.Express, deps: SyncCenterDeps, registry: SyncRegistry = syncRegistry) {
  registerSyncJobs(registry, deps)

  app.get('/api/sync/status', async (_req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.json(await registry.status())
  })

  app.post('/api/sync/:id/run', (req, res) => {
    const id = String(req.params.id)
    const outcome = registry.requestRun(id)
    if (outcome.status === 429 && typeof outcome.body.retryAfterSec === 'number') res.setHeader('Retry-After', String(outcome.body.retryAfterSec))
    if (outcome.status === 202) deps.addAudit('sync_run', id, 'accepted')
    res.status(outcome.status).json(outcome.body)
  })

  app.get('/api/rtk/global', async (_req, res) => {
    try {
      const { readRTKGlobal } = await import('./rtkService.js')
      res.setHeader('Cache-Control', 'no-store')
      res.json(await readRTKGlobal())
    } catch (error) {
      await rtkError(res, error)
    }
  })

  app.post('/api/rtk/global', async (req, res) => {
    const on = req.body?.on
    if (typeof on !== 'boolean') return res.status(400).json({ error: 'on 必须是布尔值', code: 'invalid_on' })
    try {
      const { setRTKGlobal } = await import('./rtkService.js')
      const result = await setRTKGlobal(on, { confirm: req.body?.confirm === true })
      const failed = result.results.filter(item => !item.ok).map(item => item.agent)
      const changed = result.results.filter(item => item.ok && !item.unchanged).map(item => item.agent)
      deps.addAudit('rtk_global', on ? 'on' : 'off', `plane=${result.plane}, changed=${changed.join('+') || 'none'}, failed=${failed.join('+') || 'none'}`)
      res.json(result)
    } catch (error) {
      const { rtkFailure } = await import('./rtkService.js')
      const failure = rtkFailure(error) as RtkFailureBody
      deps.addAudit('rtk_global', on ? 'on' : 'off', `outcome=error, status=${failure.status}, reason=${failure.reason || 'unknown'}`)
      await rtkError(res, error)
    }
  })

  return {
    /** 进程启动后调用：排程进程内任务 + 监听共享目录。不运行、不触发任何外部任务；不会改 RTK 开关。 */
    start() {
      registry.start()
      if (config.modelDiscoveryScheduled) startModelCatalogWatcher(() => { void registry.run('model-discovery', 'watch').catch(() => undefined) })
    },
    /**
     * `POST /api/models/sync` 的兼容入口：与 `POST /api/sync/model-discovery/run` 走同一个准入（手动冷却、记 manualAt），
     * 被拒时返回 { status, body }（429 带 retryAfterSec），放行或正在运行时等这一次单飞运行的结果。
     * 正在运行时直接加入那次运行：不会多发任何上游请求，也不消耗冷却。
     */
    async runModelDiscovery(): Promise<{ status: 200; result: ModelSyncResult } | { status: number; body: Record<string, unknown> }> {
      const id = 'model-discovery'
      if (!registry.isRunning(id)) {
        const rejected = registry.admitManual(id)
        if (rejected) return rejected
      }
      const { value, outcome } = await registry.run(id, 'manual')
      if (!value) throw new Error(outcome.error || '模型同步失败')
      return { status: 200, result: value as ModelSyncResult }
    },
  }
}
