import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type express from 'express'
import type { MagpieUpstreamStatus } from '../packages/contracts/magpie-upstream.js'
import type { ConsoleVersionInfo, CpaVersionInfo } from './cpa.js'
import { readMagpieUpstreamStatus } from './magpieUpstream.js'
import { readAutoConfig, readScheduler } from './autoupdate.js'

/**
 * 「网关 Magpie」：运行中的内核版本、上游最新、差距、跟随策略、待评审，一份模型。
 *
 * 只读本机已有的状态，**GET 不联网、不跑 git**：
 * - 运行版本：内核 `/internal/health` 的 revision（getCpaVersion 已读）；离线时退回 console-manifest.json 的 revision。
 * - 上游：`scripts/magpie-upstream.mjs`（launchd 每 30 分钟）写的 status.json 与 candidates/。
 * - 安装时间：内核二进制的 mtime。
 * - 跟随策略：上游检查的 LaunchAgent plist（StartInterval）+ 两个脚本的固定行为（只出候选、不自动替换；替换前备份、失败回滚）。
 *
 * 内核按上游**源码提交**构建（`-X main.revision=<sha>`），上游发布在另一个仓库（yetone/magpie-releases），
 * 本机没有提交 ↔ 发布版本的对应记录，所以 `release` 永远如实为 null，不猜。
 */

export type MagpieGatewayInfo = {
  current: {
    /** 人读的版本：短提交；不知道就是「未知」 */
    label: string
    commit: string | null
    /** 对应的发布版本；本机推不出来时为 null（见 releaseNote） */
    release: string | null
    releaseNote: string | null
    /** 内核二进制写入时间（mtime，ISO） */
    buildTime: string | null
    running: boolean
  }
  upstream: {
    status: MagpieUpstreamStatus['status']
    latestRelease: string | null
    latestCommit: string | null
    checkedAt: string | null
    nextCheckAt: string | null
    /** 定时检查错过了整整一轮（机器睡眠、任务没在跑） */
    overdue: boolean
    /** 上次检查失败；上游字段是上一次成功的结果 */
    failed: boolean
  }
  gap: {
    state: 'latest' | 'behind' | 'unknown'
    label: string
    /** 落后的提交数下限（检查器见到的不同上游提交）；null = 不知道 */
    commitsAtLeast: number | null
    note: string | null
  }
  /** autoApply: the scheduled job rehearses new candidates and replaces compatible ones in the quiet window (server/autoupdate.ts) */
  policy: { scheduled: boolean; intervalMs: number | null; autoApply: boolean; text: string }
  review: { pending: boolean; changes: number; schemaCount: number; implementationFileCount: number }
}

export type MagpieGatewayFacts = {
  kernelCommit: string | null
  running: boolean
  upstream: MagpieUpstreamStatus
  schedule: { nextAttemptAt: number | null; retryNotBefore: number | null }
  buildTime: number | null
  intervalMs: number | null
  observedRevisions: number | null
  /** 「自动更新」: switched on, and in effect (the installed job runs `scheduled`); window label `03:00–06:00` */
  auto?: { enabled: boolean; effective: boolean; window: string } | null
}

const SHA = /^[a-f0-9]{40}$/
const MAX_STATUS_BYTES = 1024 * 1024
const MAX_CANDIDATES = 5000
export const UPSTREAM_CHECK_LABEL = 'com.crosery.magpie-upstream-check'

const iso = (ms: number | null): string | null => (ms === null || !Number.isFinite(ms) ? null : new Date(ms).toISOString())
const parseTime = (value: unknown): number | null => {
  if (typeof value !== 'string') return null
  const at = Date.parse(value)
  return Number.isFinite(at) ? at : null
}

/** `crosery-3fe2ff9` / 40 位 sha / `3fe2ff9` → `3fe2ff9`；认不出来原样返回。 */
export function shortRevision(value: string | null | undefined): string | null {
  if (!value) return null
  const match = /(?:^|crosery-)([a-f0-9]{7,40})$/.exec(value.trim())
  return match ? match[1].slice(0, 7) : value
}

/** 两处 UI（设置、概览提醒）共用的契约变化计数：路由 + 登录方式。 */
export function contractChanges(changes: MagpieUpstreamStatus['changes']): number {
  return changes.addedRoutes.length + changes.removedRoutes.length + changes.changedRoutes.length
    + changes.addedLoginAgents.length + changes.removedLoginAgents.length
}

const minutes = (ms: number) => {
  const m = Math.round(ms / 60_000)
  return m % 60 === 0 && m >= 60 ? `${m / 60} 小时` : `${m} 分钟`
}

/** 纯函数：事实 → 模型。所有字句在这里定，设置页、概览、状态栏读同一份，不会互相矛盾。 */
export function buildMagpieGateway(facts: MagpieGatewayFacts, now = Date.now()): MagpieGatewayInfo {
  const commit = facts.kernelCommit && SHA.test(facts.kernelCommit) ? facts.kernelCommit : null
  const up = facts.upstream
  const checkedAt = parseTime(up.checkedAt)
  const interval = facts.intervalMs
  const nextCheck = checkedAt === null
    ? null
    : Math.max(interval ? checkedAt + interval : 0, facts.schedule.nextAttemptAt ?? 0, facts.schedule.retryNotBefore ?? 0) || null
  const overdue = Boolean(interval && nextCheck !== null && now > nextCheck + interval)
  const candidate = up.candidateRevision && SHA.test(up.candidateRevision) ? up.candidateRevision : null

  let gap: MagpieGatewayInfo['gap']
  if (!commit) gap = { state: 'unknown', label: '未知', commitsAtLeast: null, note: '读不到运行中的内核版本' }
  else if (up.status === 'baseline_mismatch') gap = { state: 'unknown', label: '未知', commitsAtLeast: null, note: '运行中的内核与契约基线不是同一个提交，需人工核对' }
  else if (!candidate) {
    gap = { state: 'unknown', label: '未知', commitsAtLeast: null, note: up.status === 'error' ? '上游检查失败，还没有可对比的结果' : '还没检查过上游' }
  } else if (candidate === commit) {
    gap = { state: 'latest', label: '已是最新', commitsAtLeast: 0, note: '与上游 main 是同一个提交' }
  } else {
    const n = Math.max(1, facts.observedRevisions ?? 1)
    gap = {
      state: 'behind',
      label: `落后 ≥${n} 个提交`,
      commitsAtLeast: n,
      note: interval
        ? `安装后检查器见到的上游新提交 · 每 ${minutes(interval)}取样，实际可能更多`
        : '安装后检查器见到的上游新提交，实际可能更多',
    }
  }
  if (gap.state !== 'unknown' && up.status === 'error') gap.note = `上次检查失败，按上一次成功的结果 · ${gap.note}`

  const flow = '新版本先评审契约变化 → 临时目录演练 → 确认后替换 · 替换前备份，失败自动回滚'
  const auto = facts.auto
  const policy: MagpieGatewayInfo['policy'] = !interval
    ? { scheduled: false, intervalMs: null, autoApply: false, text: `没有安装定时检查任务 · 不自动替换 · ${flow}` }
    : auto?.effective
      ? { scheduled: true, intervalMs: interval, autoApply: true, text: `每 ${minutes(interval)}检查上游 · 新候选自动演练，契约兼容才在 ${auto.window} 自动替换 · 替换前备份，失败自动回滚` }
      : auto?.enabled
        ? { scheduled: true, intervalMs: interval, autoApply: false, text: `每 ${minutes(interval)}自动检查上游 · 自动更新已开，定时任务重装后才生效 · 现在只出候选，不自动替换` }
        : { scheduled: true, intervalMs: interval, autoApply: false, text: `每 ${minutes(interval)}自动检查上游 · 只出候选，不自动替换 · ${flow}` }

  return {
    current: {
      label: commit ? commit.slice(0, 7) : '未知',
      commit,
      release: null,
      releaseNote: commit ? '按上游源码提交构建，本机没有提交与发布版本的对应记录' : null,
      buildTime: iso(facts.buildTime),
      running: facts.running,
    },
    upstream: {
      status: up.status,
      latestRelease: up.latestRelease,
      latestCommit: candidate,
      checkedAt: iso(checkedAt),
      nextCheckAt: iso(nextCheck),
      overdue,
      failed: up.status === 'error',
    },
    gap,
    policy,
    review: {
      pending: up.status === 'review_required' && Boolean(candidate) && candidate !== commit,
      changes: contractChanges(up.changes),
      schemaCount: up.changes.schemaCount,
      implementationFileCount: up.changes.implementationFileCount,
    },
  }
}

/* ────────────────────────── 只读取证（本机文件，无网络、无子进程） ────────────────────────── */

export type MagpiePaths = { upstreamDir: string; updateRoot: string; launchAgentsDir: string; binary: string }

export function magpiePaths(env: NodeJS.ProcessEnv = process.env): MagpiePaths {
  return {
    upstreamDir: env.MAGPIE_UPSTREAM_RUNTIME || path.join(os.homedir(), '.agents/crosery/magpie-upstream'),
    updateRoot: env.MAGPIE_UPDATE_ROOT || path.join(os.homedir(), '.agents/crosery/magpie-console/bin'),
    launchAgentsDir: path.join(os.homedir(), 'Library/LaunchAgents'),
    binary: 'magpie-kernel',
  }
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    const stat = fs.lstatSync(file)
    if (!stat.isFile() || stat.size > MAX_STATUS_BYTES) return null
    const value = JSON.parse(fs.readFileSync(file, 'utf8'))
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
  } catch {
    return null
  }
}

/** 检查脚本持久化的退避（nextAttemptAt / retryNotBefore）——下次真正会检查的时间要算上它。 */
export function readUpstreamSchedule(upstreamDir: string): MagpieGatewayFacts['schedule'] {
  const status = readJson(path.join(upstreamDir, 'status.json'))
  return { nextAttemptAt: parseTime(status?.nextAttemptAt), retryNotBefore: parseTime(status?.retryNotBefore) }
}

/** LaunchAgent 的 StartInterval（毫秒）；plist 不存在 = 没有定时检查 → null。只读，不碰 launchctl。 */
export function readLaunchdInterval(label: string, directory: string): number | null {
  try {
    const xml = fs.readFileSync(path.join(directory, `${label}.plist`), 'utf8')
    const match = /<key>StartInterval<\/key>\s*<integer>(\d+)<\/integer>/.exec(xml)
    const seconds = match ? Number(match[1]) : NaN
    return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null
  } catch {
    return null
  }
}

let observedCache: { key: string; value: number | null } | null = null

/**
 * 内核安装之后检查器见到的不同上游 main 提交数（落后提交数的下限）。
 * candidates/ 下每个目录是 `<sha40>-<digest16>`，在检查器第一次见到那个 main 提交时生成；同一提交换了提取器会多一个目录，按 sha 去重。
 * 本机的上游检出是浅克隆、没有历史，精确提交数只能联网比对——这里不做。
 */
export function countObservedRevisions(upstreamDir: string, sinceMs: number | null, exclude: string | null): number | null {
  if (sinceMs === null) return null
  const directory = path.join(upstreamDir, 'candidates')
  try {
    const stat = fs.lstatSync(directory)
    if (!stat.isDirectory()) return null
    const key = `${directory}|${stat.mtimeMs}|${sinceMs}|${exclude}`
    if (observedCache?.key === key) return observedCache.value
    const seen = new Set<string>()
    const names = fs.readdirSync(directory)
    for (const name of names.slice(0, MAX_CANDIDATES)) {
      const match = /^([a-f0-9]{40})-[a-f0-9]{16}$/.exec(name)
      if (!match || match[1] === exclude || seen.has(match[1])) continue
      const entry = fs.lstatSync(path.join(directory, name))
      if (entry.isDirectory() && entry.mtimeMs >= sinceMs) seen.add(match[1])
    }
    observedCache = { key, value: seen.size }
    return seen.size
  } catch {
    return null
  }
}

/** 内核二进制的 mtime 与 console-manifest 的 revision（内核离线时的版本来源）。 */
export function readKernelInstall(paths: MagpiePaths): { buildTime: number | null; manifestRevision: string | null } {
  let buildTime: number | null = null
  try {
    const stat = fs.statSync(path.join(paths.updateRoot, paths.binary))
    if (stat.isFile()) buildTime = stat.mtimeMs
  } catch { /* 没有二进制：安装时间未知 */ }
  const revision = readJson(path.join(path.dirname(paths.updateRoot), 'console-manifest.json'))?.revision
  return { buildTime, manifestRevision: typeof revision === 'string' && SHA.test(revision) ? revision : null }
}

/** 合成模型。`cpa` 是 getCpaVersion 的结果（magpie 引擎）；只读文件，绝不发请求。 */
export function readMagpieGateway(cpa: CpaVersionInfo, paths = magpiePaths(), now = Date.now()): MagpieGatewayInfo {
  const running = cpa.version !== 'offline' && Boolean(cpa.commit && SHA.test(cpa.commit))
  const install = readKernelInstall(paths)
  const kernelCommit = running ? cpa.commit : install.manifestRevision
  const upstream = cpa.upstream ?? readMagpieUpstreamStatus(kernelCommit ?? '', path.join(paths.upstreamDir, 'status.json'))
  return buildMagpieGateway({
    kernelCommit,
    running,
    upstream,
    schedule: readUpstreamSchedule(paths.upstreamDir),
    buildTime: install.buildTime,
    intervalMs: readLaunchdInterval(UPSTREAM_CHECK_LABEL, paths.launchAgentsDir),
    observedRevisions: countObservedRevisions(paths.upstreamDir, install.buildTime, kernelCommit),
    auto: (() => {
      const config = readAutoConfig(path.join(paths.upstreamDir, 'autoupdate.json'))
      return { enabled: config.magpie.enabled, effective: config.magpie.enabled && readScheduler(paths.launchAgentsDir) === 'auto', window: `${config.magpie.window.start}–${config.magpie.window.end}` }
    })(),
  }, now)
}

/** 更新面板的回退：更新脚本自己没检查过时，「上游最新 / 上次检查」用上游检查器的结果。 */
export function readTracker(upstreamDir: string): { checkedAt: string | null; latestRelease: string | null; latestCommit: string | null } | null {
  const status = readJson(path.join(upstreamDir, 'status.json'))
  if (!status) return null
  const checkedAt = parseTime(status.checkedAt)
  const release = typeof status.latestRelease === 'string' && /^v?\d+\.\d+\.\d+[-.a-zA-Z0-9]*$/.test(status.latestRelease) ? status.latestRelease : null
  const commit = typeof status.candidateRevision === 'string' && SHA.test(status.candidateRevision) ? status.candidateRevision : null
  return { checkedAt: iso(checkedAt), latestRelease: release, latestCommit: commit }
}

/* ────────────────────────── 路由：/api/version · /api/magpie/update-status · /api/magpie/update ────────────────────────── */

export type MagpieRouteDeps = {
  getCpaVersion: (force?: boolean) => Promise<CpaVersionInfo>
  getConsoleVersion: () => ConsoleVersionInfo
  wantsFresh: (req: express.Request) => boolean
  addAudit: (action: string, target: string, detail?: string) => void
  /** 仓库根（server/ 的上一级），默认更新脚本在 `<repo>/scripts/magpie-update.mjs` */
  repoRoot: string
  paths?: () => MagpiePaths
}

export function registerMagpieVersionRoutes(app: express.Express, deps: MagpieRouteDeps): void {
  const paths = deps.paths ?? (() => magpiePaths())
  /**
   * 更新脚本与安装根都可注入（测试用替身；生产用默认值）。**绝不碰 launchd、不重启服务**：
   * 本端点只跑 `scripts/magpie-update.mjs`，它自己只做"校验 → 备份 → 原子替换 → 失败回滚"。
   */
  const updateScript = () => process.env.MAGPIE_UPDATE_SCRIPT || path.join(deps.repoRoot, 'scripts/magpie-update.mjs')

  /** 能力探测：脚本存在且能被 node 读；装不上就如实说"不可用"，不假装有。 */
  const capability = (): { capability: boolean; reason?: string; script: string; root: string } => {
    const script = updateScript()
    const updateRoot = paths().updateRoot
    if (!fs.existsSync(script)) return { capability: false, reason: `找不到更新脚本：${script}`, script, root: updateRoot }
    if (!fs.existsSync(updateRoot)) return { capability: false, reason: `找不到安装目录：${updateRoot}`, script, root: updateRoot }
    return { capability: true, script, root: updateRoot }
  }

  /** 跑一次更新脚本（status 只读 / check 只读 / rehearse 临时目录 / apply 需显式确认）。 */
  const runUpdate = (args: string[], timeoutMs = 180_000) => new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(process.execPath, [updateScript(), ...args], { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error && typeof (error as { code?: unknown }).code === 'number' ? Number((error as { code: number }).code) : error ? 1 : 0
      resolve({ code, stdout: String(stdout || ''), stderr: String(stderr || '') })
    })
  })

  const parseJson = (stdout: string): Record<string, unknown> | null => {
    const line = stdout.trim().split('\n').filter(Boolean).pop()
    if (!line) return null
    try { return JSON.parse(line) as Record<string, unknown> } catch { return null }
  }

  app.get('/api/version', async (req, res) => {
    try {
      const [cpa, consoleVersion] = await Promise.all([deps.getCpaVersion(deps.wantsFresh(req)), Promise.resolve(deps.getConsoleVersion())])
      // 附加字段：旧客户端只读 version/commit/upstream，照旧可用
      const gateway = cpa.engine === 'magpie' ? readMagpieGateway(cpa, paths()) : undefined
      res.json({ cpa: gateway ? { ...cpa, gateway } : cpa, console: consoleVersion })
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : '获取版本失败' })
    }
  })

  app.get('/api/magpie/update-status', async (_req, res) => {
    const cap = capability()
    const tracker = readTracker(paths().upstreamDir)
    if (!cap.capability) {
      return res.json({
        capability: false, reason: cap.reason, script: cap.script, root: cap.root,
        currentVersion: null, latestVersion: null, lastCheckedAt: null, lastResult: null, backupPath: null, error: null, tracker,
      })
    }
    try {
      const result = await runUpdate(['status', '--root', cap.root])
      const parsed = parseJson(result.stdout) || {}
      return res.json({ capability: true, script: cap.script, root: cap.root, ...parsed, tracker })
    } catch (error) {
      return res.status(502).json({ capability: true, error: error instanceof Error ? error.message : '读取更新状态失败', tracker })
    }
  })

  app.post('/api/magpie/update', async (req, res) => {
    const action = String(req.body?.action || 'check')
    const cap = capability()
    if (!cap.capability) {
      deps.addAudit('magpie_update', action, `refused:no-capability（${cap.reason}）`)
      return res.status(503).json({ error: cap.reason, reason: 'update_capability_unavailable' })
    }
    if (!['check', 'rehearse', 'apply'].includes(action)) {
      return res.status(400).json({ error: 'action 只能是 check / rehearse / apply', reason: 'invalid_action' })
    }
    // **确认门**：真替换必须显式确认；缺确认一律拒绝，且**不执行任何命令**（零副作用）
    if (action === 'apply' && req.body?.confirm !== true) {
      deps.addAudit('magpie_update', 'apply', 'refused:missing-confirm')
      return res.status(403).json({ error: '替换内核需要显式确认（body 需要 {"confirm": true}）', reason: 'confirm_required' })
    }
    const args = action === 'apply'
      ? ['apply', '--confirm-apply', '--root', cap.root]
      : action === 'rehearse'
        ? ['rehearse', '--root', cap.root, ...(req.body?.from ? ['--from', String(req.body.from)] : [])]
        : ['check', '--root', cap.root, ...(req.body?.from ? ['--from', String(req.body.from)] : [])]
    const result = await runUpdate(args)
    const parsed = parseJson(result.stdout)
    deps.addAudit('magpie_update', action, `exit=${result.code}${parsed?.status ? `, status=${String(parsed.status)}` : ''}${result.code !== 0 ? `, stderr=${result.stderr.trim().slice(0, 200)}` : ''}`)
    if (result.code !== 0) {
      return res.status(500).json({
        error: result.stderr.trim() || `更新脚本以退出码 ${result.code} 结束`, reason: 'update_failed',
        ...(parsed ? { result: parsed } : {}),
      })
    }
    return res.json({ ok: true, action, ...(parsed ? { result: parsed } : {}) })
  })
}
