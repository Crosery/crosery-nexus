import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { config } from './config.js'
import {
  RELAY_RTK_PATHS,
  RTK_AGENT_SPECS,
  RTK_URL,
  RtkPlaneError,
  assertLocalWrite,
  assertRemoteWrite,
  findRTKBinary,
  kernelRtkRequest,
  probeRelayPlane,
  normalizePlanePayload,
  probeLocalPlane,
  readRtkWritePolicy,
  redact,
  relayRtkRequest,
  resolveRtkPlane,
  rtkAgentSpec,
  type KernelTarget,
  type RelayTarget,
  type RtkAgentSpec,
  type RtkAgentView,
  type RtkDay,
  type RtkGain,
  type RtkPlaneId,
  type RtkPlanePayload,
  type RtkPlaneProbe,
  type RtkWriteMode,
  type RtkWritePolicy,
} from './rtkPlane.js'

const execFileAsync = promisify(execFile)

export type { KernelTarget, RelayTarget, RtkAgentView, RtkDay, RtkGain, RtkPlaneId, RtkPlaneProbe, RtkWriteMode } from './rtkPlane.js'
export { RtkPlaneError, RTK_AGENT_SPECS, RTK_URL, findRTKBinary } from './rtkPlane.js'

const RTK_INSTALL_HINT = `curl -fsSL ${RTK_URL}/install.sh | sh`

/* ------------------------------------------------------------------ */
/* 契约类型                                                            */
/* ------------------------------------------------------------------ */

/** 备份摘要：只带必要信息，不回传完整文件清单（避免响应体随历史线性膨胀）。 */
export type RtkBackupSummary = { id: string; at: string; fileCount: number }

export type RTKStatusView = {
  plane: RtkPlaneId
  planes: RtkPlaneProbe[]
  connected: boolean
  path: string | null
  version: string | null
  gain: RtkGain | null
  days: RtkDay[]
  latest: string | null
  agents: RtkAgentView[]
  localAgents: RtkAgentView[]
  /** 控制台所在机器的 RTK 安装情况（与权威平面无关）。 */
  local: { connected: boolean; path: string | null; version: string | null }
  /** 最近的本机写入备份（紧凑摘要，供一键回退）。 */
  backups: RtkBackupSummary[]
  /** 备份保留份数（RTK_BACKUP_KEEP，默认 10），超出自动轮转。 */
  backupKeep: number
  /** 保护窗口（RTK_BACKUP_GRACE_MS，默认 120s）：窗口内的备份不轮转，避免删掉在飞请求的 backupId。 */
  backupGraceMs: number
  /** 没有 manifest 的孤儿备份目录数量（如实计数，过保护窗口后自动清）。 */
  backupOrphans: number
  install?: string
  url: string
  writeMode: RtkWriteMode
  remoteWriteEnabled: boolean
  /** 内核平面写入开关（默认关闭：内核跑在沙箱 HOME）。 */
  kernelWriteEnabled: boolean
  installEnabled: boolean
  error?: string
}

export type RtkCliAttempt = { command: string; exitCode: number | null; stderr: string; ok: boolean }

/** toggle 响应不回传备份历史（只给本次备份摘要），避免响应体随历史线性膨胀。 */
export type RTKToggleResult = Omit<RTKStatusView, 'backups'> & {
  ok: true
  plane: RtkPlaneId
  readPlane: RtkPlaneId
  mechanism?: 'rtk-cli' | 'hooks-json'
  /** 本次操作产生的备份目录。 */
  backup?: string
  backupId?: string
  backupFileCount?: number
  fallbackReason?: string
  cli?: RtkCliAttempt | null
  /** 被 rtk CLI 连带关掉、已按快照修回的其他 agent。 */
  collateralRestored?: string[]
  /** 被 rtk CLI 连带打开、已按快照撤回的其他 agent。 */
  collateralReverted?: string[]
  /** 本次连带动到的文件（相对 home）。 */
  collateralFiles?: string[]
  /** 连带改动的确定性最终态（每个 agent 只有一条，UI 与 audit 同一份数据）。 */
  collateral?: RtkCollateralEntry[]
  /** 检测到并发修改、未自动还原的文件（需人工确认）。 */
  collateralSkipped?: Array<{ agent: string; file: string; reason: string }>
  /** 被 rtk CLI 覆写后已还原回用户原件的 .bak。 */
  preservedBak?: string[]
}
export type RTKInstallResult = RTKStatusView & { ok: true; plane: RtkPlaneId; readPlane: RtkPlaneId }
export type RTKRollbackResult = RTKStatusView & { ok: true; plane: RtkPlaneId; backupId: string; restored: string[] }

/* 兼容旧引用（server/cpa.ts:369 仍按 RTKView 取类型），值形状是超集。 */
export type RTKView = RTKStatusView
export type RTKAgent = RtkAgentView
export type RTKGainStats = RtkGain
export type RTKDayStats = RtkDay

export type RtkToggleOptions = {
  /** 写入目标平面；默认 local —— 只有本机才有用户的 agent 配置。 */
  plane?: RtkPlaneId
  confirm?: boolean
  home?: string
  bin?: string | null
  timeoutMs?: number
  /** 仅测试注入：覆盖内核 / 中转站的探测与请求目标。 */
  kernel?: KernelTarget
  relay?: RelayTarget
}

export type RTKFailure = { status: number; error: string; plane?: RtkPlaneId; reason?: string; backup?: string }

/* ------------------------------------------------------------------ */
/* 本机平面基础                                                        */
/* ------------------------------------------------------------------ */

/** RTK_HOME 只用于测试与显式覆盖；默认仍是当前用户 home。 */
export function resolveHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = String(env.RTK_HOME || '').trim()
  return override ? path.resolve(override) : os.homedir()
}

/** passwd 里的真实 home，不受 $HOME 影响：用于拦住测试误写真实 agent 配置。 */
function realUserHome(): string {
  try {
    return path.resolve(os.userInfo().homedir)
  } catch {
    return path.resolve(os.homedir())
  }
}

/**
 * 测试上下文（node --test 的 NODE_TEST_CONTEXT）里，绝不允许写真实 home 的 agent 配置。
 * 这是硬闸门，不依赖测试自己记得设 RTK_HOME。
 */
export function assertNotRealHomeInTests(home: string, env: NodeJS.ProcessEnv = process.env): void {
  if (!env.NODE_TEST_CONTEXT) return
  if (['1', 'true', 'yes', 'on'].includes(String(env.RTK_ALLOW_REAL_AGENT_WRITE || '').toLowerCase())) return
  if (path.resolve(home) !== realUserHome()) return
  throw new RtkPlaneError(500, 'local', 'test_context_real_home_refused', '测试上下文拒绝对真实 home 写入 agent 配置')
}

function readFileIfExists(filePath: string): string | null {
  try {
    if (!fs.existsSync(filePath)) return null
    return fs.readFileSync(filePath, 'utf8')
  } catch {
    return null
  }
}

function fileContains(filePath: string, search: string): boolean {
  const content = readFileIfExists(filePath)
  return content !== null && content.includes(search)
}

/* ------------------------------------------------------------------ */
/* 写入锁（同一进程内的并发 toggle）                                   */
/* ------------------------------------------------------------------ */

const fileLocks = new Map<string, Promise<unknown>>()

export async function withFileLock<T>(key: string, run: () => Promise<T> | T): Promise<T> {
  const previous = fileLocks.get(key) || Promise.resolve()
  const next = previous.then(run, run)
  fileLocks.set(key, next.then(() => undefined, () => undefined))
  return next
}

/* ------------------------------------------------------------------ */
/* 备份与回退                                                          */
/* ------------------------------------------------------------------ */

export function rtkBackupRoot(home: string, env: NodeJS.ProcessEnv = process.env): string {
  const override = String(env.RTK_BACKUP_DIR || '').trim()
  return override ? path.resolve(override) : path.join(home, '.agents/crosery/magpie-console/backups')
}

const backupFileName = (rel: string) => rel.replace(/[\\/]/g, '__')

export type RtkBackupCreated = { id: string; at: string; dir: string; files: string[] }

/** 写之前先把原文件原样存一份；失败也必须留下可回退的原件。 */
export function createRtkBackup(home: string, rels: string[]): RtkBackupCreated {
  const at = new Date().toISOString()
  // 并发请求可能落在同一毫秒：加随机后缀，避免两次备份撞到同一个目录（互相覆盖）。
  const id = `${at.replace(/[:.]/g, '-')}-${randomBytes(3).toString('hex')}`
  const dir = path.join(rtkBackupRoot(home), id)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const files = [...new Set(rels)].filter(Boolean).map(rel => {
    const source = path.join(home, rel)
    const existed = fs.existsSync(source)
    if (existed) fs.copyFileSync(source, path.join(dir, backupFileName(rel)))
    return { rel, existed }
  })
  fs.writeFileSync(
    path.join(dir, 'manifest.json'),
    `${JSON.stringify({ id, at, home, files }, null, 2)}\n`,
    { mode: 0o600 },
  )
  return { id, at, dir, files: files.map(file => file.rel) }
}

/** 保留最近 N 份备份；N 可配（RTK_BACKUP_KEEP），默认 10。 */
export function rtkBackupKeep(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.RTK_BACKUP_KEEP)
  return Number.isFinite(raw) && raw >= 1 && raw <= 200 ? Math.floor(raw) : 10
}

/**
 * 保护窗口：比这个时间新的备份一律不轮转（RTK_BACKUP_GRACE_MS，默认 120s）。
 * 轮转在每个写请求里都会跑；并发下若立刻删旧目录，会把「已经返回给客户端的 backupId」
 * 一起删掉，用户拿这个 id 去 rollback 就 404（红队第三轮 P0-1）。
 */
export function rtkBackupGraceMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.RTK_BACKUP_GRACE_MS)
  return Number.isFinite(raw) && raw >= 0 && raw <= 3_600_000 ? Math.floor(raw) : 120_000
}

/** 进程内「正在处理中」的备份 id：轮转必须跳过它们（第二个保护条件）。 */
const inflightBackups = new Set<string>()

export function beginRtkBackupUse(id: string): void {
  inflightBackups.add(id)
}

export function endRtkBackupUse(id: string): void {
  inflightBackups.delete(id)
}

const BACKUP_ID_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z(-[0-9a-f]{6})?$/

type BackupEntry = { id: string; hasManifest: boolean }

/** 备份根目录下的条目（**含没有 manifest 的孤儿目录**），按 id 倒序。 */
function backupEntries(home: string): BackupEntry[] {
  const root = rtkBackupRoot(home)
  let names: string[]
  try {
    names = fs.readdirSync(root)
  } catch {
    return []
  }
  return names
    .filter(name => BACKUP_ID_PATTERN.test(name))
    .filter(name => {
      try {
        return fs.statSync(path.join(root, name)).isDirectory()
      } catch {
        return false
      }
    })
    .sort()
    .reverse()
    .map(id => ({ id, hasManifest: fs.existsSync(path.join(root, id, 'manifest.json')) }))
}

function backupAgeMs(root: string, id: string, now: number): number | null {
  const stamp = id.replace(/(-[0-9a-f]{6})?$/, '').replace(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, '$1T$2:$3:$4.$5Z')
  const parsed = Date.parse(stamp)
  if (Number.isFinite(parsed)) return Math.max(0, now - parsed)
  try {
    return Math.max(0, now - fs.statSync(path.join(root, id)).mtimeMs)
  } catch {
    return null
  }
}

/**
 * 轮转。双条件保护：①在飞 / 刚创建（< RTK_BACKUP_GRACE_MS）的一律不删；②其余按 id 倒序保留最新 keep 份。
 * 没有 manifest 的孤儿目录不受 keep 计数影响，但同样要过保护窗口才清。
 */
export function pruneRtkBackups(
  home: string = resolveHome(),
  keep: number = rtkBackupKeep(),
  options: { protect?: Iterable<string>; now?: number } = {},
): string[] {
  const root = rtkBackupRoot(home)
  const now = options.now ?? Date.now()
  const grace = rtkBackupGraceMs()
  const protectedIds = new Set<string>(inflightBackups)
  for (const id of options.protect || []) protectedIds.add(path.basename(id))
  const removed: string[] = []
  let kept = 0
  for (const entry of backupEntries(home)) {
    const age = backupAgeMs(root, entry.id, now)
    const isProtected = protectedIds.has(entry.id) || (age !== null && age < grace)
    if (!entry.hasManifest) {
      if (!isProtected) {
        try {
          fs.rmSync(path.join(root, entry.id), { recursive: true, force: true })
          removed.push(entry.id)
        } catch {
          // 清理失败不影响主流程
        }
      }
      continue
    }
    if (isProtected || kept < Math.max(1, keep)) {
      kept += 1
      continue
    }
    try {
      fs.rmSync(path.join(root, entry.id), { recursive: true, force: true })
      removed.push(entry.id)
    } catch {
      // 清理失败不影响主流程
    }
  }
  return removed
}

/** 无 manifest 的孤儿备份目录数量（status 如实计数）。 */
export function countRtkBackupOrphans(home: string = resolveHome()): number {
  return backupEntries(home).filter(entry => !entry.hasManifest).length
}

export function listRtkBackups(home: string = resolveHome(), limit = rtkBackupKeep()): RtkBackupSummary[] {
  return backupEntries(home).filter(entry => entry.hasManifest).slice(0, Math.max(1, limit)).map(entry => {
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(rtkBackupRoot(home), entry.id, 'manifest.json'), 'utf8')) as { at?: string; files?: unknown[] }
      return { id: entry.id, at: manifest.at || entry.id, fileCount: (manifest.files || []).length }
    } catch {
      return { id: entry.id, at: entry.id, fileCount: 0 }
    }
  })
}

/** 从备份原地恢复：写过的文件回滚，原本不存在的文件删掉。 */
export function restoreRtkBackup(home: string, backupId?: string): { id: string; restored: string[] } {
  const root = rtkBackupRoot(home)
  const id = backupId || listRtkBackups(home, 1)[0]?.id
  if (!id) throw new RtkPlaneError(404, 'local', 'backup_not_found', '没有可用的 RTK 备份')
  const dir = path.join(root, id)
  const manifestPath = path.join(dir, 'manifest.json')
  if (!fs.existsSync(manifestPath)) throw new RtkPlaneError(404, 'local', 'backup_not_found', `备份 ${id} 不存在`)
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { files?: Array<{ rel: string; existed: boolean }> }
  const restored: string[] = []
  for (const file of manifest.files || []) {
    const target = path.join(home, file.rel)
    const source = path.join(dir, backupFileName(file.rel))
    if (file.existed && fs.existsSync(source)) {
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.copyFileSync(source, target)
    } else if (!file.existed && fs.existsSync(target)) {
      fs.rmSync(target)
    }
    restored.push(file.rel)
  }
  return { id, restored }
}

/* ------------------------------------------------------------------ */
/* 本机 agent 检测                                                     */
/* ------------------------------------------------------------------ */

/**
 * 判定「是否已挂载」只看 rtk 自己的 hook 条目：
 * RTK.md / AGENTS.md 只是说明文件，拿它当已挂载会导致永远关不掉（红队 S5/T8）。
 */
export function detectAgentHooks(home: string = resolveHome()): RtkAgentView[] {
  return RTK_AGENT_SPECS.map(spec => {
    const dirPath = path.join(home, spec.dir)
    const hookPath = spec.hookFile ? path.join(home, spec.hookFile) : null
    const installed = fs.existsSync(dirPath) || Boolean(hookPath && fs.existsSync(hookPath))
    let on = false
    if (hookPath && fs.existsSync(hookPath)) {
      on = spec.marker ? fileContains(hookPath, spec.marker) : true
    }
    return {
      id: spec.id,
      name: spec.name,
      icon: spec.icon,
      on,
      supported: Boolean(spec.initFlags),
      plane: 'local' as const,
      installed,
      ...(spec.scopeReason ? { blocked: spec.scopeReason } : {}),
    }
  })
}

/* ------------------------------------------------------------------ */
/* 本机读取                                                            */
/* ------------------------------------------------------------------ */

export type RtkGainPayload = {
  summary?: { total_commands?: number; total_input?: number; total_saved?: number; avg_savings_pct?: number }
  daily?: Array<{ date?: string; commands?: number; input_tokens?: number; saved_tokens?: number; savings_pct?: number }>
}

/** 纯映射：`rtk gain --daily --format json` → 契约字段（T11 字段一致性回归用）。 */
export function parseGainPayload(parsed: RtkGainPayload): { gain: RtkGain | null; days: RtkDay[] } {
  const summary = parsed?.summary
  const gain: RtkGain | null = summary
    ? {
      commands: Number(summary.total_commands) || 0,
      input: Number(summary.total_input) || 0,
      saved: Number(summary.total_saved) || 0,
      pct: Number(summary.avg_savings_pct) || 0,
    }
    : null
  const days: RtkDay[] = []
  if (Array.isArray(parsed?.daily)) {
    for (const day of parsed.daily) {
      if (!day?.date) continue
      days.push({
        date: day.date,
        commands: Number(day.commands) || 0,
        input: Number(day.input_tokens) || 0,
        saved: Number(day.saved_tokens) || 0,
        pct: Number(day.savings_pct) || 0,
      })
    }
    days.sort((a, b) => a.date.localeCompare(b.date))
  }
  return { gain, days }
}

export async function getRTKStats(
  binPath: string,
  home: string = resolveHome(),
): Promise<{ version: string | null; gain: RtkGain | null; days: RtkDay[] }> {
  const env = { ...process.env, HOME: home }
  let version: string | null = null
  let gain: RtkGain | null = null
  let days: RtkDay[] = []

  try {
    const { stdout } = await execFileAsync(binPath, ['--version'], { timeout: 5000, env })
    const match = /rtk\s+([v0-9.]+)/i.exec(stdout.trim())
    version = match ? match[1] : stdout.trim()
  } catch {
    // 版本读不到就留 null，不编造
  }

  try {
    const { stdout } = await execFileAsync(binPath, ['gain', '--daily', '--format', 'json'], { timeout: 10_000, env })
    const mapped = parseGainPayload(JSON.parse(stdout) as RtkGainPayload)
    gain = mapped.gain
    days = mapped.days
  } catch {
    // 读不到统计就如实返回 null，不再用别的 HOME 重试造出「0 节省」的假数据。
    gain = null
    days = []
  }

  return { version, gain, days }
}

export async function readLocalPayload(binPath: string | null, home: string = resolveHome()): Promise<RtkPlanePayload> {
  const agents = detectAgentHooks(home)
  if (!binPath) {
    return {
      connected: false,
      path: null,
      version: null,
      gain: null,
      days: [],
      latest: null,
      install: RTK_INSTALL_HINT,
      url: RTK_URL,
      agents,
    }
  }
  const { version, gain, days } = await getRTKStats(binPath, home)
  return { connected: true, path: binPath, version, gain, days, latest: null, url: RTK_URL, agents }
}

/* ------------------------------------------------------------------ */
/* 权威平面读取（回退必须可见）                                        */
/* ------------------------------------------------------------------ */

function degradeProbe(probe: RtkPlaneProbe, reason: string, detail?: string): RtkPlaneProbe {
  return { ...probe, available: false, state: 'unreachable', reason, ...(detail ? { detail } : {}) }
}

export type AuthoritativeRead = {
  plane: RtkPlaneId
  planes: RtkPlaneProbe[]
  /** 权威平面（plane）的视图。 */
  payload: RtkPlanePayload
  /** 控制台所在机器的本机视图，独立于权威平面，供 C 层开关使用。 */
  local: RtkPlanePayload
  fellBack: boolean
  error?: string
}

export type AuthoritativeReadOptions = { home?: string; fresh?: boolean; kernel?: KernelTarget; relay?: RelayTarget }

export async function readAuthoritativeRtk(options: AuthoritativeReadOptions = {}): Promise<AuthoritativeRead> {
  const home = options.home || resolveHome()
  const bin = findRTKBinary()
  const local = await readLocalPayload(bin, home)
  const resolution = await resolveRtkPlane({ fresh: options.fresh, kernel: options.kernel, relay: options.relay })
  const planes = resolution.planes.map(probe => ({ ...probe }))
  const errors: string[] = []

  for (const plane of ['kernel', 'relay'] as const) {
    const probe = planes.find(item => item.id === plane)
    if (!probe?.available) continue
    try {
      const payload = plane === 'kernel'
        ? await kernelRtkRequest(options.kernel?.socket ?? config.magpieKernelSocket, '/internal/rtk')
        : await relayRtkRequest(RELAY_RTK_PATHS.view, 'GET', undefined, options.relay)
      if (payload.status < 200 || payload.status >= 300) throw new Error(`HTTP ${payload.status}`)
      return {
        plane,
        planes,
        payload: normalizePlanePayload(payload.json, plane),
        local,
        fellBack: plane !== 'kernel',
      }
    } catch (error) {
      const message = redact(error instanceof Error ? error.message : String(error))
      errors.push(`${plane}: ${message}`)
      Object.assign(probe, degradeProbe(probe, `${plane}_read_failed`, message))
    }
  }

  return {
    plane: 'local',
    planes,
    payload: local,
    local,
    fellBack: true,
    ...(errors.length ? { error: `权威平面读取失败，已回退本机：${errors.join('; ')}` } : {}),
  }
}

function policyFields(policy: RtkWritePolicy) {
  return {
    writeMode: policy.mode,
    remoteWriteEnabled: policy.remoteWriteEnabled,
    kernelWriteEnabled: policy.kernelWriteEnabled,
    installEnabled: policy.installEnabled,
  }
}

export function toStatusView(read: AuthoritativeRead, policy: RtkWritePolicy = readRtkWritePolicy(), home: string = resolveHome()): RTKStatusView {
  return {
    plane: read.plane,
    planes: read.planes,
    connected: read.payload.connected,
    path: read.payload.path,
    version: read.payload.version,
    gain: read.payload.gain,
    days: read.payload.days,
    latest: read.payload.latest,
    agents: read.payload.agents,
    localAgents: read.local.agents,
    local: { connected: read.local.connected, path: read.local.path, version: read.local.version },
    backups: listRtkBackups(home, Math.min(rtkBackupKeep(), 10)),
    backupKeep: rtkBackupKeep(),
    backupGraceMs: rtkBackupGraceMs(),
    backupOrphans: countRtkBackupOrphans(home),
    ...(read.payload.install ? { install: read.payload.install } : {}),
    url: read.payload.url,
    ...policyFields(policy),
    ...(read.error ? { error: read.error } : {}),
  }
}

export async function readRTKStatus(options: AuthoritativeReadOptions = {}): Promise<RTKStatusView> {
  const home = options.home || resolveHome()
  return toStatusView(await readAuthoritativeRtk({ ...options, home }), readRtkWritePolicy(), home)
}

/* ------------------------------------------------------------------ */
/* 本机写入（C 层：开关必须真的落到本机 agent 配置）                   */
/* ------------------------------------------------------------------ */

function writeFileAtomic(filePath: string, content: string): void {
  const dir = path.dirname(filePath)
  const temp = path.join(dir, `.rtk-${process.pid}-${Date.now()}-${randomBytes(4).toString('hex')}.tmp`)
  fs.writeFileSync(temp, content, { mode: 0o600 })
  fs.renameSync(temp, filePath)
}

/** 已核实的 hooks JSON schema（依据：rtk 0.50.0 在临时 HOME 的实测输出，见交付文档「证据」）。 */
type HookJsonSpec =
  | { kind: 'nested'; root: string[]; list: string; matcher: string; command: string; extra?: Record<string, unknown> }
  | { kind: 'flat'; root: string[]; list: string; command: string; entry: Record<string, unknown>; topLevel?: Record<string, unknown> }

const HOOK_JSON: Record<string, HookJsonSpec> = {
  codex: { kind: 'nested', root: ['hooks'], list: 'PreToolUse', matcher: 'Bash', command: 'rtk hook codex' },
  claude: { kind: 'nested', root: ['hooks'], list: 'PreToolUse', matcher: 'Bash', command: 'rtk hook claude' },
  trae: { kind: 'nested', root: ['hooks'], list: 'PreToolUse', matcher: 'RunCommand', command: 'rtk hook trae', extra: { timeout: 30 } },
  droid: { kind: 'nested', root: [], list: 'PreToolUse', matcher: 'Execute', command: 'rtk hook droid' },
  cursor: { kind: 'flat', root: ['hooks'], list: 'preToolUse', command: 'rtk hook cursor', entry: { command: 'rtk hook cursor', matcher: 'Shell' }, topLevel: { version: 1 } },
  copilot: { kind: 'flat', root: ['hooks'], list: 'PreToolUse', command: 'rtk hook copilot', entry: { type: 'command', command: 'rtk hook copilot', cwd: '.', timeout: 5 }, topLevel: { version: 1 } },
}

function nestedContainer(document: Record<string, unknown>, root: string[]): Record<string, unknown> {
  let cursor = document
  for (const key of root) {
    const next = cursor[key]
    if (next && typeof next === 'object' && !Array.isArray(next)) cursor = next as Record<string, unknown>
    else {
      const created: Record<string, unknown> = {}
      cursor[key] = created
      cursor = created
    }
  }
  return cursor
}

/**
 * 只摘掉「rtk 自己那一条」条目，其余第三方 hook 原样保留（红队 T7）。
 * 返回 value === undefined 表示该节点本身就是 rtk 条目，要从数组里删除。
 */
const containsCommand = (node: unknown, command: string): boolean => {
  if (Array.isArray(node)) return node.some(item => containsCommand(item, command))
  if (node && typeof node === 'object') {
    if ((node as { command?: unknown }).command === command) return true
    return Object.values(node as Record<string, unknown>).some(value => containsCommand(value, command))
  }
  return false
}

/** 是否还残留任何 command 字段（用于判断条目是否已被摘空）。 */
const containsAnyCommand = (node: unknown): boolean => {
  if (Array.isArray(node)) return node.some(containsAnyCommand)
  if (node && typeof node === 'object') {
    if (Object.prototype.hasOwnProperty.call(node, 'command')) return true
    return Object.values(node as Record<string, unknown>).some(containsAnyCommand)
  }
  return false
}

function stripCommand(node: unknown, command: string): { value: unknown; removed: number } {
  if (Array.isArray(node)) {
    const kept: unknown[] = []
    let removed = 0
    for (const item of node) {
      const hadTarget = containsCommand(item, command)
      const result = stripCommand(item, command)
      if (result.value === undefined) {
        removed += 1
        continue
      }
      // 摘完只剩空壳（例如 {"matcher":"Bash","hooks":[]}）时整条移除，不能留残骸。
      if (hadTarget && !containsCommand(result.value, command) && !containsAnyCommand(result.value)) {
        removed += 1
        continue
      }
      removed += result.removed
      kept.push(result.value)
    }
    return { value: kept, removed }
  }
  if (node && typeof node === 'object') {
    if ((node as { command?: unknown }).command === command) return { value: undefined, removed: 1 }
    const copy: Record<string, unknown> = {}
    let removed = 0
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      const result = stripCommand(value, command)
      removed += result.removed
      if (result.value !== undefined) copy[key] = result.value
    }
    return { value: copy, removed }
  }
  return { value: node, removed: 0 }
}

function applyHookJson(spec: RtkAgentSpec, jsonSpec: HookJsonSpec, filePath: string, on: boolean): void {
  const existing = readFileIfExists(filePath)
  let document: Record<string, unknown> = {}
  if (existing !== null && existing.trim()) {
    try {
      const parsed: unknown = JSON.parse(existing)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
      document = parsed as Record<string, unknown>
    } catch {
      throw new RtkPlaneError(409, 'local', 'hook_file_unparsable', `${spec.id} 的 ${spec.hookFile} 不是合法 JSON，拒绝覆盖`)
    }
  }

  const container = nestedContainer(document, jsonSpec.root)
  const current = Array.isArray(container[jsonSpec.list]) ? container[jsonSpec.list] as unknown[] : []
  const stripped = stripCommand(current, jsonSpec.command).value as unknown[]
  if (on) {
    // 幂等：先摘掉旧条目再追加唯一一条，连续 ON 产物字节级一致（T6）。
    const next = jsonSpec.kind === 'nested'
      ? [{ matcher: jsonSpec.matcher, hooks: [{ type: 'command', command: jsonSpec.command, ...(jsonSpec.extra || {}) }] }]
      : [jsonSpec.entry]
    container[jsonSpec.list] = [...stripped, ...next]
    if (jsonSpec.kind === 'flat' && jsonSpec.topLevel) {
      for (const [key, value] of Object.entries(jsonSpec.topLevel)) if (document[key] === undefined) document[key] = value
    }
  } else {
    container[jsonSpec.list] = stripped
  }
  writeFileAtomic(filePath, `${JSON.stringify(document, null, 2)}\n`)
}

export type RtkCollateralAction = 'reverted' | 'restored' | 'skipped'
/** 连带改动的确定性最终态：agent 唯一、action 唯一（UI 与 audit 用同一份数据）。 */
export type RtkCollateralEntry = { agent: string; action: RtkCollateralAction; files: string[]; reason?: string }

export type LocalHookResult = {
  mechanism: 'rtk-cli' | 'hooks-json'
  detail: string
  cli: RtkCliAttempt
  fallbackReason?: string
  backup: string
  backupId: string
  backupFileCount: number
  /** 连带改动明细（唯一真源）。 */
  collateral?: RtkCollateralEntry[]
  /** 兼容字段：被连带打开后已按最小差异撤回的 agent（与 collateralRestored 互斥）。 */
  collateralReverted?: string[]
  /** 兼容字段：被连带关掉后已修回的 agent（与 collateralReverted 互斥）。 */
  collateralRestored?: string[]
  /** 检测到并发修改、为不覆盖用户改动而未自动还原的文件。 */
  collateralSkipped?: Array<{ agent: string; file: string; reason: string }>
  collateralFiles?: string[]
  /** 操作前就存在、被 rtk CLI 覆写后已还原回用户原件的 .bak。 */
  preservedBak?: string[]
}

type GuardEntry = { rel: string; kind: 'hook' | 'extra' | 'bak'; owner: string }

/** 目标之外的 agent 文件：钩子文件、说明文件、以及 rtk CLI 会留下的同名 .bak。 */
function guardEntries(targetId: string): GuardEntry[] {
  return RTK_AGENT_SPECS.filter(spec => spec.id !== targetId).flatMap(spec => {
    const entries: GuardEntry[] = []
    if (spec.hookFile) {
      entries.push({ rel: spec.hookFile, kind: 'hook', owner: spec.id })
      entries.push({ rel: `${spec.hookFile}.bak`, kind: 'bak', owner: spec.id })
    }
    for (const rel of spec.extraFiles || []) entries.push({ rel, kind: 'extra', owner: spec.id })
    return entries
  })
}

const isAgentOn = (spec: RtkAgentSpec, content: string | null): boolean =>
  content !== null && (spec.marker ? content.includes(spec.marker) : true)

/** 必须保持合法 JSON 的钩子文件：写后校验与 ON/OFF 共用同一套判据。 */
const JSON_HOOK_FILES = new Set([
  '.codex/hooks.json', '.claude/settings.json', '.trae/hooks.json', '.factory/hooks.json',
  '.cursor/hooks.json', '.copilot/hooks/rtk-rewrite.json', '.gemini/settings.json',
])

/**
 * 写后完整性校验：文件不存在/空是合法终态，存在则必须是合法 JSON 对象。
 * 旧实现的 OFF 路径只看「标记不存在」就算成功，于是被 CLI 写坏的文件也能过（红队第三轮 P0-2）。
 */
export function hookFileIntegrity(spec: RtkAgentSpec, home: string): string | null {
  if (!spec.hookFile || !JSON_HOOK_FILES.has(spec.hookFile)) return null
  const content = readFileIfExists(path.join(home, spec.hookFile))
  if (content === null || !content.trim()) return null
  try {
    const parsed: unknown = JSON.parse(content)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'not_json_object'
  } catch {
    return 'invalid_json'
  }
  return null
}

function isValidJsonObject(content: string | null): boolean {
  if (content === null || !content.trim()) return true
  try {
    const parsed: unknown = JSON.parse(content)
    return Boolean(parsed) && typeof parsed === 'object' && !Array.isArray(parsed)
  } catch {
    return false
  }
}

function brokenHookFileError(spec: RtkAgentSpec, detail: string, backupDir: string): RtkPlaneError {
  const failure = new RtkPlaneError(409, 'local', 'hook_file_unparsable',
    `${spec.id} 的 ${spec.hookFile} 在操作后不是合法 JSON（${detail}），已拒绝并回填操作前原文；可用 /api/rtk/rollback 恢复`)
  failure.backup = backupDir
  return failure
}

function restoreToSnapshot(target: string, before: string | null, after: string | null): void {
  if (before !== null) {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    writeFileAtomic(target, before)
  } else if (after !== null) {
    fs.rmSync(target)
  }
}

/* ---------------- 条目级最小差异还原（P1-a） ---------------- */

/** 只读地取出钩子数组所在容器；不创建任何中间节点。 */
function readContainer(document: Record<string, unknown>, root: string[]): Record<string, unknown> | null {
  let cursor: unknown = document
  for (const key of root) {
    if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) return null
    cursor = (cursor as Record<string, unknown>)[key]
  }
  return cursor && typeof cursor === 'object' && !Array.isArray(cursor) ? cursor as Record<string, unknown> : null
}

function hookListOf(source: string | null, jsonSpec: HookJsonSpec): unknown[] | null {
  if (source === null || !source.trim()) return []
  try {
    const parsed: unknown = JSON.parse(source)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const container = readContainer(parsed as Record<string, unknown>, jsonSpec.root)
    const list = container?.[jsonSpec.list]
    return list === undefined ? [] : Array.isArray(list) ? list : null
  } catch {
    return null
  }
}

const jsonEqual = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/**
 * 条目级还原：只摘掉本次由 rtk 连带新增的条目、只补回被连带删掉的条目，
 * 用户在 CLI 执行窗口里对同一文件做的其它改动原样保留。
 * 返回 'unchanged'（无需动）、'applied'（已按最小差异改回）或 'skipped'（结构不认识，交给上层如实上报）。
 */
function minimalCollateralEdit(
  target: string,
  jsonSpec: HookJsonSpec,
  before: string | null,
  after: string | null,
): { applied: 'unchanged' | 'applied' | 'skipped'; removed: number; readded: number } {
  const current = readFileIfExists(target)
  if (current === null) return { applied: 'skipped', removed: 0, readded: 0 }
  let document: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(current)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { applied: 'skipped', removed: 0, readded: 0 }
    document = parsed as Record<string, unknown>
  } catch {
    return { applied: 'skipped', removed: 0, readded: 0 }
  }
  const container = readContainer(document, jsonSpec.root)
  if (!container) return { applied: 'skipped', removed: 0, readded: 0 }
  const currentList = container[jsonSpec.list]
  const list = currentList === undefined ? [] : Array.isArray(currentList) ? [...currentList] : null
  if (!list) return { applied: 'skipped', removed: 0, readded: 0 }
  const beforeList = hookListOf(before, jsonSpec)
  const afterList = hookListOf(after, jsonSpec)
  if (beforeList === null || afterList === null) return { applied: 'skipped', removed: 0, readded: 0 }

  // ① 撤销 rtk 本次新增的条目：只认 rtk 自己的 command，且只摘「操作前没有的」那几条。
  //    用户在 CLI 窗口里新增的条目（不含 rtk command）原样保留。
  const kept = list.filter(item => !(containsCommand(item, jsonSpec.command) && !beforeList.some(other => jsonEqual(other, item))))
  const removed = list.length - kept.length
  // ② 补回被 CLI 删掉的原条目（用户自己已经补过的不重复加）。
  const missing = beforeList.filter(item => !afterList.some(other => jsonEqual(other, item)) && !kept.some(other => jsonEqual(other, item)))
  const next = [...missing, ...kept]
  if (!removed && !missing.length) return { applied: 'unchanged', removed: 0, readded: 0 }
  container[jsonSpec.list] = next
  writeFileAtomic(target, `${JSON.stringify(document, null, 2)}\n`)
  return { applied: 'applied', removed, readded: missing.length }
}

type ReconcileOutcome = {
  entries: RtkCollateralEntry[]
  files: string[]
  skipped: Array<{ agent: string; file: string; reason: string }>
}

/**
 * rtk CLI 的连带效应是**双向**的：
 * - `--agent claude --uninstall` 会顺带删掉 `.cursor/hooks.json`（把别人关掉）；
 * - `--agent cursor --auto-patch` 会顺带在 `.claude/settings.json` 注册钩子并新建说明文件（把别人打开）。
 * 用户只点了 A：两个方向都要还原。还原策略：
 * - 文件自 CLI 之后没被别人改过 → 整文件按快照还原；
 * - 文件在窗口内被第三方改过（JSON 钩子文件）→ **条目级**最小差异还原，保留用户改动；
 * - 结构不认识 → **不还原**并如实上报 `collateralSkipped`，绝不覆盖用户改动。
 */
function reconcileCollateral(
  home: string,
  snapshot: Map<string, string | null>,
  entries: GuardEntry[],
): ReconcileOutcome {
  const byRel = new Map(entries.map(entry => [entry.rel, entry]))
  const perAgent = new Map<string, { action: RtkCollateralAction; files: string[]; reason?: string }>()
  const files: string[] = []
  const skipped: Array<{ agent: string; file: string; reason: string }> = []
  const rank: Record<RtkCollateralAction, number> = { skipped: 0, reverted: 1, restored: 2 }

  const mark = (agent: string, action: RtkCollateralAction, rel: string, reason?: string) => {
    const current = perAgent.get(agent)
    if (!current) {
      perAgent.set(agent, { action, files: [rel], ...(reason ? { reason } : {}) })
      return
    }
    if (!current.files.includes(rel)) current.files.push(rel)
    // 同一 agent 出现在两个方向时取确定性最终态（restored > reverted > skipped），保证集合互斥
    if (rank[action] > rank[current.action]) {
      current.action = action
      current.reason = reason
    }
  }

  for (const [rel, before] of snapshot) {
    const entry = byRel.get(rel)
    if (!entry || entry.kind === 'bak') continue
    const target = path.join(home, rel)
    const after = readFileIfExists(target)
    if (after === before) continue
    const spec = rtkAgentSpec(entry.owner)
    let action: RtkCollateralAction
    if (entry.kind === 'extra') {
      action = before === null ? 'reverted' : 'restored'
    } else {
      if (!spec) continue
      const wasOn = isAgentOn(spec, before)
      const isOn = isAgentOn(spec, after)
      // 钩子文件从「合法 JSON」变成「坏 JSON」：不管 on 状态有没有变，都必须处理（rtk 把用户配置写坏了）。
      const brokeJson = Boolean(spec.hookFile && JSON_HOOK_FILES.has(spec.hookFile))
        && isValidJsonObject(before) && !isValidJsonObject(after)
      if (wasOn === isOn && !brokeJson) continue // on 状态没变（只是内容重排）→ 不动用户的文件
      action = brokeJson ? 'restored' : isOn ? 'reverted' : 'restored'
    }

    const current = readFileIfExists(target)
    const concurrent = current !== after
    const jsonSpec = spec ? HOOK_JSON[spec.id] : undefined
    let applied: 'unchanged' | 'applied' | 'skipped'
    if (entry.kind === 'hook' && jsonSpec) {
      // 钩子文件一律走条目级还原：只撤销 rtk 自己的增删，窗口内的第三方改动保留（P1-a）。
      applied = minimalCollateralEdit(target, jsonSpec, before, after).applied
    } else if (!concurrent) {
      restoreToSnapshot(target, before, after)
      applied = 'applied'
    } else {
      // 说明文件等：CLI 之后又被改过 → 不覆盖，如实上报
      applied = 'skipped'
    }
    if (applied === 'skipped') {
      const reason = concurrent ? 'concurrent_modification' : 'unparsable_or_unknown_shape'
      skipped.push({ agent: entry.owner, file: rel, reason })
      mark(entry.owner, 'skipped', rel, reason)
      continue
    }
    if (applied === 'unchanged') continue
    files.push(rel)
    mark(entry.owner, action, rel)
  }

  // 被撤回/修回的文件若被 CLI 留了新 .bak，一并清掉（原本就有的 .bak 不动）
  for (const [agent, value] of perAgent) {
    if (value.action === 'skipped') continue
    const spec = rtkAgentSpec(agent)
    if (!spec?.hookFile) continue
    const bakRel = `${spec.hookFile}.bak`
    if (snapshot.get(bakRel)) continue
    const bakPath = path.join(home, bakRel)
    if (fs.existsSync(bakPath)) {
      fs.rmSync(bakPath)
      files.push(bakRel)
    }
  }

  return {
    entries: [...perAgent].map(([agent, value]) => ({
      agent, action: value.action, files: value.files, ...(value.reason ? { reason: value.reason } : {}),
    })),
    files,
    skipped,
  }
}

/** 互斥的兼容字段：同一 agent 只会出现在一个集合里。 */
const collateralFields = (outcome: ReconcileOutcome) => {
  const reverted = outcome.entries.filter(entry => entry.action === 'reverted').map(entry => entry.agent)
  const restored = outcome.entries.filter(entry => entry.action === 'restored').map(entry => entry.agent)
  return {
    ...(outcome.entries.length ? { collateral: outcome.entries } : {}),
    ...(reverted.length ? { collateralReverted: reverted } : {}),
    ...(restored.length ? { collateralRestored: restored } : {}),
    ...(outcome.skipped.length ? { collateralSkipped: outcome.skipped } : {}),
    ...(outcome.files.length ? { collateralFiles: outcome.files } : {}),
  }
}

/** 权限/磁盘等原生异常包成结构化错误：不泄漏服务端临时路径，带 plane/reason/backup。 */
function structuredWriteError(error: unknown, spec: RtkAgentSpec, backupDir: string): RtkPlaneError {
  const code = String((error as { code?: unknown } | null)?.code || 'unknown')
  const failure = new RtkPlaneError(500, 'local', 'hook_write_failed',
    `写入 ${spec.name} 的钩子配置失败（${code}）：原文件未改动，已备份，可用 /api/rtk/rollback 恢复`)
  failure.backup = backupDir
  return failure
}

/**
 * 跑 rtk CLI。用 spawn 而不是 execFile：stdin 必须是 /dev/null，
 * 否则非交互下的 `[y/N]` prompt 会在管道上把子进程挂到超时。
 * 显式采集 exitCode 与 stderr，禁止空 catch。
 */
function runRtkCli(bin: string, args: string[], home: string, timeoutMs: number): Promise<RtkCliAttempt> {
  const command = `rtk init -g ${args.join(' ')}`
  return new Promise(resolve => {
    const child = spawn(bin, ['init', '-g', ...args], {
      env: { ...process.env, HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr?.on('data', chunk => { stderr += String(chunk) })
    const timer = setTimeout(() => { child.kill('SIGKILL'); stderr += '\n[rtk-cli timeout]' }, timeoutMs)
    child.once('error', error => {
      clearTimeout(timer)
      resolve({ command, exitCode: null, stderr: redact(error.message).trim().slice(0, 300), ok: false })
    })
    child.once('close', code => {
      clearTimeout(timer)
      const text = redact(stderr).trim().slice(0, 300)
      resolve({ command, exitCode: code, stderr: text, ok: code === 0 })
    })
  })
}

function verifyLocalHook(spec: RtkAgentSpec, on: boolean, home: string): boolean {
  const agent = detectAgentHooks(home).find(item => item.id === spec.id)
  return Boolean(agent) && agent!.on === on
}

export async function applyLocalAgentHook(
  spec: RtkAgentSpec,
  on: boolean,
  options: { home?: string; bin?: string | null; timeoutMs?: number } = {},
): Promise<LocalHookResult> {
  if (!spec.initFlags) {
    throw new RtkPlaneError(501, 'local', spec.scopeReason || 'agent_project_scoped',
      `${spec.name} 在 rtk 0.50.0 只能按项目初始化，控制台不提供全局开关`)
  }
  const home = options.home || resolveHome()
  assertNotRealHomeInTests(home)
  const bin = options.bin === undefined ? findRTKBinary() : options.bin

  // T3：rtk 没装就明确报「未安装 + 安装指引」，绝不靠手写 JSON 假装成功。
  if (!bin) {
    throw new RtkPlaneError(503, 'local', 'rtk_binary_missing',
      `未找到 rtk 可执行文件，无法安全写入 ${spec.name} 钩子；请先安装：${RTK_INSTALL_HINT}`)
  }

  return withFileLock(path.join(home, spec.dir), async () => {
    // 目标文件自己的 .bak 也纳管：rtk CLI 会覆写 <file>.bak，用户原件不能被静默吞掉（P1）。
    const hookBak = spec.hookFile ? `${spec.hookFile}.bak` : null
    const targets = [spec.hookFile, hookBak, ...(spec.extraFiles || [])].filter((rel): rel is string => Boolean(rel))
    const guards = guardEntries(spec.id)
    const allFiles = [...new Set([...targets, ...guards.map(entry => entry.rel)])]
    // 备份与快照都必须发生在 CLI **之前**：CLI 可能把目标文件写坏，
    // 之后再读就等于把坏内容当原件（红队第二轮缺陷 3）。
    const backup = createRtkBackup(home, allFiles)
    beginRtkBackupUse(backup.id)
    const snapshot = new Map<string, string | null>()
    for (const rel of allFiles) snapshot.set(rel, readFileIfExists(path.join(home, rel)))
    pruneRtkBackups(home, rtkBackupKeep(), { protect: [backup.id] })

    const restoreTargets = () => {
      for (const rel of targets) {
        const target = path.join(home, rel)
        const before = snapshot.get(rel) ?? null
        const after = readFileIfExists(target)
        if (after !== before) restoreToSnapshot(target, before, after)
      }
    }
    /** 成功路径也把「用户原本就有的 .bak」还回去（rtk 会覆写它，属于静默数据丢失）。 */
    const preserveUserBaks = (): string[] => {
      if (!hookBak) return []
      const before = snapshot.get(hookBak) ?? null
      if (before === null) return []
      const target = path.join(home, hookBak)
      if (readFileIfExists(target) === before) return []
      restoreToSnapshot(target, before, readFileIfExists(target))
      return [hookBak]
    }

    // rtk init 需要目标目录已存在（cursor 还会写 .claude/RTK.md），否则它自己 exit 1。
    for (const rel of targets) fs.mkdirSync(path.dirname(path.join(home, rel)), { recursive: true })
    fs.mkdirSync(path.join(home, spec.dir), { recursive: true })

    const success = (mechanism: 'rtk-cli' | 'hooks-json', detail: string, cli: RtkCliAttempt, fallbackReason?: string): LocalHookResult => {
      const collateral = reconcileCollateral(home, snapshot, guards)
      const preservedBak = preserveUserBaks()
      return {
        mechanism, detail, cli,
        ...(fallbackReason ? { fallbackReason } : {}),
        backup: backup.dir, backupId: backup.id, backupFileCount: backup.files.length,
        ...collateralFields(collateral),
        ...(preservedBak.length ? { preservedBak } : {}),
      }
    }

    try {
      const args = on ? spec.initFlags! : [...spec.initFlags!, '--uninstall']
      let cli: RtkCliAttempt
      if (fs.existsSync(bin)) {
        cli = await runRtkCli(bin, args, home, options.timeoutMs ?? 20_000)
        // ON / OFF 共用同一套写后校验：目标状态 + 文件仍是合法 JSON（P0-2）
        const integrity = hookFileIntegrity(spec, home)
        if (integrity) {
          restoreTargets()
          reconcileCollateral(home, snapshot, guards)
          throw brokenHookFileError(spec, integrity, backup.dir)
        }
        if (cli.ok && verifyLocalHook(spec, on, home)) {
          return success('rtk-cli', `rtk init -g ${args.join(' ')}`, cli)
        }
        cli = cli.ok ? { ...cli, ok: false, stderr: 'rtk 执行成功但目标状态未生效' } : cli
      } else {
        cli = { command: `rtk init -g ${args.join(' ')}`, exitCode: null, stderr: `${bin} 不存在`, ok: false }
      }

      const jsonSpec = HOOK_JSON[spec.id]
      if (spec.hookFile && jsonSpec) {
        const filePath = path.join(home, spec.hookFile)
        fs.mkdirSync(path.dirname(filePath), { recursive: true })
        try {
          applyHookJson(spec, jsonSpec, filePath, on)
        } catch (error) {
          restoreTargets()
          if (error instanceof RtkPlaneError) {
            error.backup = backup.dir
            error.message = `${error.message}；原文件已按备份回填，也可用 /api/rtk/rollback 恢复`
            throw error
          }
          throw error
        }
        const integrity = hookFileIntegrity(spec, home)
        if (integrity) {
          restoreTargets()
          throw brokenHookFileError(spec, integrity, backup.dir)
        }
        if (verifyLocalHook(spec, on, home)) {
          return success('hooks-json', `${spec.hookFile}（已核实 schema）`, cli, cli.stderr)
        }
        restoreTargets()
        throw new RtkPlaneError(502, 'local', 'hook_write_unverified',
          `写入 ${spec.hookFile} 后仍检测不到目标状态（rtk CLI: ${cli.stderr}）；原文件已按备份回填，可用 /api/rtk/rollback 恢复`)
      }

      restoreTargets()
      const cliFailure = new RtkPlaneError(502, 'local', 'hook_cli_failed',
        `${spec.name} 的钩子文件形状未经验证，且 rtk CLI 失败：${cli.stderr}；原文件已按备份回填`)
      cliFailure.backup = backup.dir
      throw cliFailure
    } catch (error) {
      // 失败路径同样要把被连带改动的其他 agent 文件还原（CLI 可能已经动过它们）。
      reconcileCollateral(home, snapshot, guards)
      if (error instanceof RtkPlaneError) throw error
      throw structuredWriteError(error, spec, backup.dir)
    } finally {
      endRtkBackupUse(backup.id)
    }
  })
}



/* ------------------------------------------------------------------ */
/* 平面写入与编排                                                      */
/* ------------------------------------------------------------------ */

async function writeRelay(agent: string, on: boolean, target?: RelayTarget): Promise<void> {
  let result
  try {
    result = await relayRtkRequest(RELAY_RTK_PATHS.view, 'POST', { agent, on }, target)
  } catch (error) {
    if (error instanceof RtkPlaneError) throw error
    throw new RtkPlaneError(502, 'relay', 'relay_unreachable', redact(error instanceof Error ? error.message : String(error)))
  }
  if (result.status < 200 || result.status >= 300) {
    throw new RtkPlaneError(result.status, 'relay', `relay_http_${result.status}`, redact(result.raw))
  }
}

async function writeKernel(agent: string, on: boolean, target?: KernelTarget): Promise<void> {
  let result
  try {
    result = await kernelRtkRequest(target?.socket ?? config.magpieKernelSocket, '/internal/rtk', 'POST', { agent, on })
  } catch (error) {
    throw new RtkPlaneError(502, 'kernel', 'kernel_unreachable', redact(error instanceof Error ? error.message : String(error)))
  }
  if (result.status < 200 || result.status >= 300) {
    throw new RtkPlaneError(result.status || 502, 'kernel', `kernel_http_${result.status}`, redact(result.raw))
  }
}

/**
 * 开关 agent 钩子。
 *
 * `plane` 默认 `local`：只有控制台这台机器才有用户的 agent 配置；kernel 平面是
 * 「内核那台机器上的 RTK」，必须显式指定并满足远端写入闸门（默认只读）。
 * relay 平面按红队 T13 保持只读：本实现不对中转站发起任何写请求。
 */
export async function setRTKAgentHook(agent: string, on: boolean, options: RtkToggleOptions = {}): Promise<RTKToggleResult> {
  const policy = readRtkWritePolicy()
  const plane: RtkPlaneId = options.plane || 'local'
  const home = options.home || resolveHome()
  let mechanism: RTKToggleResult['mechanism']
  let backup: string | undefined
  let backupId: string | undefined
  let backupFileCount: number | undefined
  let fallbackReason: string | undefined
  let cli: RtkCliAttempt | undefined
  let collateralRestored: string[] | undefined
  let collateralReverted: string[] | undefined
  let collateralFiles: string[] | undefined
  let collateral: RtkCollateralEntry[] | undefined
  let collateralSkipped: Array<{ agent: string; file: string; reason: string }> | undefined
  let preservedBak: string[] | undefined

  if (plane === 'local') {
    const spec = rtkAgentSpec(agent)
    if (!spec) throw new RtkPlaneError(404, 'local', 'unknown_agent', `未知 agent: ${agent}`)
    assertLocalWrite(Boolean(options.confirm), policy)
    const result = await applyLocalAgentHook(spec, on, { home, bin: options.bin, timeoutMs: options.timeoutMs })
    mechanism = result.mechanism
    backup = result.backup
    backupId = result.backupId
    backupFileCount = result.backupFileCount
    fallbackReason = result.fallbackReason
    cli = result.cli
    collateralRestored = result.collateralRestored
    collateralReverted = result.collateralReverted
    collateralFiles = result.collateralFiles
    collateral = result.collateral
    collateralSkipped = result.collateralSkipped
    preservedBak = result.preservedBak
  } else if (plane === 'kernel') {
    // 内核由 scripts/magpie-console.mjs:91-93 以 HOME=<runtime>/home 启动，它的 agent
    // 配置在沙箱 HOME 里，写内核不会影响用户真实的 ~/.codex / ~/.claude。
    // 因此内核平面默认只读，只有运维显式打开 RTK_ALLOW_KERNEL_WRITE=1 才允许下发。
    if (!policy.kernelWriteEnabled) {
      throw new RtkPlaneError(501, 'kernel', 'kernel_write_not_supported',
        '内核运行在沙箱 HOME（不含本机 agent 配置），默认只读；确需下发请显式设置 RTK_ALLOW_KERNEL_WRITE=1')
    }
    assertRemoteWrite(Boolean(options.confirm), 'kernel', policy)
    await writeKernel(agent, on, options.kernel)
  } else if (plane === 'relay') {
    // 规则（与 install/upgrade 一致）：中转站根本没有 RTK 管理面 → 501（平面不支持）；
    // 有面但没开远程写 → 403（默认只读）；两者齐备才下发。
    // 当前 ai.crosery.com 实测 404，因此这里永远不会真的发出写请求（有测试断言）。
    const probe = await probeRelayPlane(options.relay)
    if (!probe.available) {
      throw new RtkPlaneError(501, 'relay', 'relay_write_not_supported',
        `中转站没有可用的 RTK 写入面（${probe.reason}），控制台不发起写请求`)
    }
    assertRemoteWrite(Boolean(options.confirm), 'relay', policy)
    await writeRelay(agent, on, options.relay)
  } else {
    throw new RtkPlaneError(400, 'local', 'unknown_plane', `未知平面: ${String(plane)}`)
  }

  const read = await readAuthoritativeRtk({ home, fresh: true, kernel: options.kernel, relay: options.relay })
  // 不回传备份历史：只有本次备份的必要摘要。
  const { backups: _history, ...status } = toStatusView(read, policy, home)
  void _history
  return {
    ...status,
    ok: true,
    plane,
    readPlane: read.plane,
    ...(mechanism ? { mechanism } : {}),
    ...(backup ? { backup } : {}),
    ...(backupId ? { backupId } : {}),
    ...(backupFileCount !== undefined ? { backupFileCount } : {}),
    ...(fallbackReason ? { fallbackReason } : {}),
    ...(cli ? { cli } : {}),
    ...(collateralRestored?.length ? { collateralRestored } : {}),
    ...(collateralReverted?.length ? { collateralReverted } : {}),
    ...(collateralFiles?.length ? { collateralFiles } : {}),
    ...(collateral?.length ? { collateral } : {}),
    ...(collateralSkipped?.length ? { collateralSkipped } : {}),
    ...(preservedBak?.length ? { preservedBak } : {}),
  }
}

export type RtkInstallOptions = { plane?: RtkPlaneId; confirm?: boolean; home?: string; kernel?: KernelTarget; relay?: RelayTarget }

async function installOrUpgrade(action: 'install' | 'upgrade', options: RtkInstallOptions): Promise<RTKInstallResult> {
  const policy = readRtkWritePolicy()
  const home = options.home || resolveHome()
  const read = await readAuthoritativeRtk({ home, fresh: true, kernel: options.kernel, relay: options.relay })
  const plane: RtkPlaneId = options.plane || read.plane

  // 本机：控制台不代为下载执行安装脚本，这是需要人工批准的可执行文件变更。
  if (plane === 'local') {
    throw new RtkPlaneError(501, 'local', `local_${action}_not_supported`,
      `控制台不代为${action === 'install' ? '安装' : '升级'}本机 rtk，请人工执行：${RTK_INSTALL_HINT}`)
  }
  if (plane === 'kernel') {
    throw new RtkPlaneError(501, 'kernel', `kernel_${action}_not_supported`,
      '内核 overlay 只暴露 GET/POST /internal/rtk，没有 install/upgrade 缝')
  }
  // 中转站：没有 RTK 管理面 → 501；有面但没开远程写 → 403；两者齐备才下发。
  const probe = await probeRelayPlane(options.relay)
  if (!probe.available) {
    throw new RtkPlaneError(501, 'relay', `relay_${action}_not_supported`,
      `中转站没有可用的 RTK 管理面（${probe.reason}），控制台不发起写请求`)
  }
  assertRemoteWrite(Boolean(options.confirm), 'relay', policy)
  let result
  try {
    result = await relayRtkRequest(RELAY_RTK_PATHS[action], 'POST', {}, options.relay)
  } catch (error) {
    if (error instanceof RtkPlaneError) throw error
    throw new RtkPlaneError(502, 'relay', 'relay_unreachable', redact(error instanceof Error ? error.message : String(error)))
  }
  if (result.status < 200 || result.status >= 300) {
    throw new RtkPlaneError(result.status, 'relay', `relay_http_${result.status}`, redact(result.raw))
  }
  const after = await readAuthoritativeRtk({ home, fresh: true, kernel: options.kernel, relay: options.relay })
  return { ...toStatusView(after, readRtkWritePolicy(), home), ok: true, plane, readPlane: after.plane }
}

export const installRTK = (options: RtkInstallOptions = {}) => installOrUpgrade('install', options)
export const upgradeRTK = (options: RtkInstallOptions = {}) => installOrUpgrade('upgrade', options)

export type RtkRollbackOptions = { backup?: string; confirm?: boolean; home?: string; kernel?: KernelTarget; relay?: RelayTarget }

/** 一键回退：把备份里的 agent 配置原地恢复。 */
export async function rollbackRTK(options: RtkRollbackOptions = {}): Promise<RTKRollbackResult> {
  const policy = readRtkWritePolicy()
  const home = options.home || resolveHome()
  if (!options.confirm) {
    throw new RtkPlaneError(403, 'local', 'confirmation_required', '回退会覆盖当前 agent 配置，需要请求带 confirm:true')
  }
  assertLocalWrite(true, policy)
  assertNotRealHomeInTests(home)
  const { id, restored } = await withFileLock(path.join(home, '.rtk-rollback'), () => restoreRtkBackup(home, options.backup))
  const read = await readAuthoritativeRtk({ home, fresh: true, kernel: options.kernel, relay: options.relay })
  return { ...toStatusView(read, policy, home), ok: true, plane: 'local', backupId: id, restored }
}

/* ------------------------------------------------------------------ */
/* 路由层用的错误归一化（绝不回显密钥）                                */
/* ------------------------------------------------------------------ */

export function rtkFailure(error: unknown): RTKFailure {
  if (error instanceof RtkPlaneError) {
    return {
      status: error.status,
      error: redact(error.message),
      plane: error.plane,
      reason: error.reason,
      ...(error.backup ? { backup: error.backup } : {}),
    }
  }
  const message = error instanceof Error ? error.message : 'RTK 操作失败'
  return { status: 500, error: redact(message) }
}

export { probeLocalPlane }
