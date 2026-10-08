import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type express from 'express'
import { config } from './config.js'
import { accountQuotaSupport, summarizeAccountQuota } from './accountQuotaReader.js'
import type { DataPlaneRelayStatus } from './dataPlane.js'
import { gatewayPricingMap, gatewayPricingRequests, refreshGatewayPricingDetailed, refreshSharedPricingIfStale } from './modelCatalog.js'
import {
  DISCOVERY_POLICY, discoveryBackoff, nextDiscoveryAt, readSharedCatalog, sanitizeDiscoveryState, sharedCatalogPath, startModelCatalogWatcher, syncUpstreamModels,
  type DiscoveryState, type ModelSyncResult,
} from './modelSync.js'
import { pricingSourceStatus } from './pricing.js'
import { isoOrNull, syncRegistry, type ExternalJobDef, type ExternalSnapshot, type SyncOutcome, type SyncRegistry, type SyncResult, type SyncRunContext } from './syncRegistry.js'
import { PROBE_INTERVAL_MS } from './modelAvailability.js'
import { autoRowWords, autoupdatePathsFor, buildMagpieAuto, buildRtkAuto, readAutoupdateFacts } from './autoupdate.js'
import { CATALOG_INTERVAL_MS, runCpaCatalogSync, sanitizeCatalogData } from './cpaCatalog.js'
import { PRICE_WATCH_INTERVAL_MS, gatewayPriceRead, priceWatcher, sharedPriceReads } from './priceWatch.js'

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

function compareVersions(left: string, right: string): number {
  const parts = (value: string) => value.replace(/^v/i, '').split(/[.-]/).map(part => Number.parseInt(part, 10) || 0)
  const [a, b] = [parts(left), parts(right)]
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0)
    if (diff) return diff
  }
  return 0
}

/** 本机 rtk 版本：走 rtkService 的 30s 缓存，同步中心轮询不会每次都起子进程。 */
async function defaultLocalRtkVersion(): Promise<string | null> {
  const { findRTKBinary, readLocalPayload } = await import('./rtkService.js')
  const binary = findRTKBinary()
  return binary ? (await readLocalPayload(binary)).version : null
}

export type ExternalJobOptions = {
  catalogFile?: string
  upstreamDir?: string
  launchAgentsDir?: string
  localRtkVersion?: () => Promise<string | null>
  /** a local Magpie kernel this host could auto-update (GATEWAY_ENGINE=magpie, local control plane) */
  magpieLocal?: () => boolean
  platform?: NodeJS.Platform
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
  const upstreamDir = options.upstreamDir ?? (process.env.MAGPIE_UPSTREAM_RUNTIME || path.join(os.homedir(), '.agents/crosery/magpie-upstream'))
  const upstreamInterval = () => launchdIntervalMs('com.crosery.magpie-upstream-check', 30 * 60_000, options.launchAgentsDir)
  const readUpstream = () => readJsonFile(path.join(upstreamDir, 'status.json'))
  const magpieLocal = options.magpieLocal ?? (() => config.gatewayEngine === 'magpie' && config.magpieControlPlane === 'local')
  /** auto-update facts from the same runtime dir; the running revision is not needed for the row words */
  const autoFacts = (rtkLocal: string | null) => readAutoupdateFacts(autoupdatePathsFor(upstreamDir, options.launchAgentsDir), { magpieLocal: magpieLocal(), running: null, rtkLocal, platform: options.platform })
  /**
   * 检查脚本自己持久化的退避（scripts/magpie-upstream.mjs）：nextAttemptAt 之前的 launchd 轮次直接跳过、不发请求，
   * retryNotBefore 是 GitHub 给的硬下限。同步中心照实显示成 backoff + 下次真正会检查的时间。
   */
  const upstreamSchedule = (status: Record<string, unknown>, checkedAt: number, intervalMs: number) => {
    const deadline = Math.max(parseTime(status.nextAttemptAt) ?? 0, parseTime(status.retryNotBefore) ?? 0)
    const backoffUntil = deadline > checkedAt ? deadline : null
    const failures = Number(status.failures)
    return {
      nextRunAt: Math.max(checkedAt + intervalMs, backoffUntil ?? 0),
      backoffUntil,
      backoffLevel: backoffUntil && Number.isFinite(failures) && failures > 0 ? Math.floor(failures) : 0,
    }
  }

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

  const kernelUpstream: ExternalJobDef = {
    id: 'kernel-upstream',
    label: '内核上游',
    kind: 'external',
    read: (): ExternalSnapshot => {
      const intervalMs = upstreamInterval()
      const status = readUpstream()
      const checkedAt = parseTime(status?.checkedAt)
      if (!status || !checkedAt) return { intervalMs, lastRunAt: null, state: 'unknown', lastResult: null, summary: '尚未检查' }
      const failed = status.status === 'error'
      const candidate = typeof status.candidateRevision === 'string' ? status.candidateRevision.slice(0, 7) : ''
      const release = tag(status.latestRelease)
      const plain = status.status === 'review_required' ? `待复核 ${candidate}` : '无变化'
      const words = autoRowWords(buildMagpieAuto(autoFacts(null), Date.now()), plain)
      const summary = failed
        ? `失败于 ${typeof status.errorStage === 'string' ? status.errorStage : '未知阶段'} · ${words}`
        : [words, release].filter(Boolean).join(' · ')
      return {
        intervalMs,
        lastRunAt: checkedAt,
        ...upstreamSchedule(status, checkedAt, intervalMs),
        state: failed ? 'error' : 'idle',
        lastResult: failed ? 'error' : 'ok',
        lastError: failed && typeof status.error === 'string' ? status.error : null,
        summary,
      }
    },
  }

  const rtkVersion: ExternalJobDef = {
    id: 'rtk-version',
    label: 'RTK 版本',
    kind: 'external',
    read: async (): Promise<ExternalSnapshot> => {
      const intervalMs = upstreamInterval()
      const status = readUpstream()
      const checkedAt = parseTime(status?.checkedAt)
      const latest = tag(status?.rtkRelease)
      const local = await (options.localRtkVersion ?? defaultLocalRtkVersion)().catch(() => null)
      if (!status || !checkedAt) return { intervalMs, lastRunAt: null, state: 'unknown', lastResult: null, summary: local ? `本机 ${local}` : null }
      const plain = !latest
        ? ['未取到最新版本', local ? `本机 ${local}` : ''].filter(Boolean).join(' · ')
        : local && compareVersions(latest, local) > 0
          ? `可升级 ${latest} · 本机 ${local}`
          : [`最新 ${latest}`, local ? `本机 ${local}` : ''].filter(Boolean).join(' · ')
      const auto = buildRtkAuto(autoFacts(local), Date.now())
      const summary = auto.state === 'off' || auto.state === 'no-scheduler' || auto.state === 'check-only' || auto.state === 'pending' || auto.state === 'up-to-date'
        ? autoRowWords({ ...auto, brief: plain }, plain)
        : autoRowWords(auto, plain)
      return {
        intervalMs,
        lastRunAt: checkedAt,
        ...upstreamSchedule(status, checkedAt, intervalMs),
        state: latest ? 'idle' : 'unknown',
        lastResult: latest ? 'ok' : status.status === 'error' ? 'error' : 'skipped',
        lastError: null,
        summary,
      }
    },
  }

  return [catalogSync, kernelUpstream, rtkVersion]
}

/* ────────────────────────── 进程内任务 ────────────────────────── */

export type SyncCenterDeps = {
  /** 丢掉 /api/monitor 的整页缓存后重新加载一次；上游请求仍受每账号 TTL/冷却约束。 */
  refreshAccountQuota: () => Promise<unknown>
  /** magpie + local: allowances come from the kernel's Magpie accounts (magpieAccounts.ts), not /api-call */
  magpieAccountQuota?: () => boolean
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
    // 本机控制面（magpie+local）没有 /api-call：额度读取整体不可用，而不是每个账号各报一次错。
    enabled: () => accountQuotaSupport().supported || Boolean(deps.magpieAccountQuota?.()),
    overlay: () => (accountQuotaSupport().supported || deps.magpieAccountQuota?.() ? {} : { summary: '本机控制面不支持读取账号额度', lastError: null }),
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

  // the external jobs are launchd agents on this Mac; a Linux host (the relay) has none to show
  if ((deps.externalJobs?.platform ?? process.platform) === 'darwin') {
    for (const job of createExternalJobs(deps.externalJobs)) registry.register(job)
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
