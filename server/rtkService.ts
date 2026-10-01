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
export { RtkPlaneError, RTK_AGENT_SPECS, RTK_URL } from './rtkPlane.js'

const RTK_INSTALL_HINT = `curl -fsSL ${RTK_URL}/install.sh | sh`

/* ------------------------------------------------------------------ */
/* 契约类型                                                            */
/* ------------------------------------------------------------------ */

export type RtkBackupSummary = { id: string; at: string; files: string[] }

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
  /** 最近的本机写入备份，供一键回退。 */
  backups: RtkBackupSummary[]
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

export type RTKToggleResult = RTKStatusView & {
  ok: true
  plane: RtkPlaneId
  readPlane: RtkPlaneId
  mechanism?: 'rtk-cli' | 'hooks-json'
  backup?: string
  fallbackReason?: string
  cli?: RtkCliAttempt | null
  /** 被 rtk CLI 连带关掉、已修复回来的其他 agent。 */
  collateralRestored?: string[]
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

/** RTK_BIN 一旦显式设置就以它为准：指向不存在的路径时返回 null，不再静默改用别的候选。 */
export function findRTKBinary(env: NodeJS.ProcessEnv = process.env): string | null {
  const custom = env.RTK_BIN
  if (custom) return fs.existsSync(custom) ? custom : null

  const candidates = [
    path.join(os.homedir(), '.local/bin/rtk'),
    path.join(os.homedir(), '.cargo/bin/rtk'),
    '/usr/local/bin/rtk',
    '/opt/homebrew/bin/rtk',
  ]
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate
    } catch {
      // ignore
    }
  }
  return null
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

export type RtkBackupCreated = RtkBackupSummary & { dir: string }

/** 写之前先把原文件原样存一份；失败也必须留下可回退的原件。 */
export function createRtkBackup(home: string, rels: string[]): RtkBackupCreated {
  const at = new Date().toISOString()
  const id = at.replace(/[:.]/g, '-')
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

export function listRtkBackups(home: string = resolveHome(), limit = 10): RtkBackupSummary[] {
  const root = rtkBackupRoot(home)
  let entries: string[]
  try {
    entries = fs.readdirSync(root)
  } catch {
    return []
  }
  return entries
    .filter(name => fs.existsSync(path.join(root, name, 'manifest.json')))
    .sort()
    .reverse()
    .slice(0, limit)
    .map(id => {
      try {
        const manifest = JSON.parse(fs.readFileSync(path.join(root, id, 'manifest.json'), 'utf8')) as { at?: string; files?: Array<{ rel: string }> }
        return { id, at: manifest.at || id, files: (manifest.files || []).map(file => file.rel) }
      } catch {
        return { id, at: id, files: [] }
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
    backups: listRtkBackups(home),
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

export type LocalHookResult = {
  mechanism: 'rtk-cli' | 'hooks-json'
  detail: string
  cli: RtkCliAttempt
  fallbackReason?: string
  backup: string
  /** 被 rtk CLI 连带关掉、已从备份修复回来的其他 agent（实测 claude/cursor 互相牵连）。 */
  collateralRestored?: string[]
}

/** 除目标外，其它 agent 的钩子文件也纳入备份/比对：rtk CLI 存在跨 agent 连带改动。 */
const otherHookFiles = (targetId: string): string[] =>
  RTK_AGENT_SPECS.filter(spec => spec.id !== targetId && spec.hookFile).map(spec => spec.hookFile as string)

const isAgentOn = (spec: RtkAgentSpec, content: string | null): boolean =>
  content !== null && (spec.marker ? content.includes(spec.marker) : true)

/**
 * rtk CLI 的实测连带效应：`--agent claude --uninstall` 会顺带删掉 `.cursor/hooks.json`。
 * 用户点的是「关掉 A」，不能悄悄把 B 也关了——把被连带改动的其他 agent 文件从备份恢复。
 */
function repairCollateral(home: string, snapshots: Map<string, string | null>): string[] {
  const restored: string[] = []
  for (const [rel, before] of snapshots) {
    const owner = RTK_AGENT_SPECS.find(spec => spec.hookFile === rel)
    if (!owner) continue
    const after = readFileIfExists(path.join(home, rel))
    if (after === before) continue
    if (isAgentOn(owner, before) && !isAgentOn(owner, after)) {
      if (before !== null) writeFileAtomic(path.join(home, rel), before)
      else if (after !== null) fs.rmSync(path.join(home, rel))
      restored.push(owner.id)
    }
  }
  return restored
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
    // 备份先做：失败也必须留下可回退的原件（T9）；连同其他 agent 的钩子文件一起存，
    // 因为 rtk CLI 有跨 agent 连带改动（实测 claude/cursor），需要能修回来。
    const guardFiles = otherHookFiles(spec.id)
    const backup = createRtkBackup(home, [spec.hookFile, ...(spec.extraFiles || []), ...guardFiles].filter((rel): rel is string => Boolean(rel)))
    const guardSnapshot = new Map(guardFiles.map(rel => [rel, readFileIfExists(path.join(home, rel))]))
    // rtk init 需要目标目录已存在（cursor 还会写 .claude/RTK.md），否则它自己 exit 1。
    for (const rel of [spec.hookFile, ...(spec.extraFiles || [])]) {
      if (rel) fs.mkdirSync(path.dirname(path.join(home, rel)), { recursive: true })
    }
    fs.mkdirSync(path.join(home, spec.dir), { recursive: true })

    const args = on ? spec.initFlags! : [...spec.initFlags!, '--uninstall']
    let cli: RtkCliAttempt
    if (fs.existsSync(bin)) {
      cli = await runRtkCli(bin, args, home, options.timeoutMs ?? 20_000)
      const collateralRestored = repairCollateral(home, guardSnapshot)
      if (cli.ok && verifyLocalHook(spec, on, home)) {
        return {
          mechanism: 'rtk-cli', detail: `rtk init -g ${args.join(' ')}`, cli, backup: backup.dir,
          ...(collateralRestored.length ? { collateralRestored } : {}),
        }
      }
      cli = cli.ok ? { ...cli, ok: false, stderr: 'rtk 执行成功但目标状态未生效' } : cli
    } else {
      cli = { command: `rtk init -g ${args.join(' ')}`, exitCode: null, stderr: `${bin} 不存在`, ok: false }
    }

    const jsonSpec = HOOK_JSON[spec.id]
    if (spec.hookFile && jsonSpec) {
      const filePath = path.join(home, spec.hookFile)
      const existedBefore = readFileIfExists(filePath)
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      try {
        applyHookJson(spec, jsonSpec, filePath, on)
      } catch (error) {
        if (existedBefore !== null) writeFileAtomic(filePath, existedBefore)
        if (error instanceof RtkPlaneError) {
          error.backup = backup.dir
          throw error
        }
        throw error
      }
      if (verifyLocalHook(spec, on, home)) {
        const collateralRestored = repairCollateral(home, guardSnapshot)
        return {
          mechanism: 'hooks-json',
          detail: `${spec.hookFile}（已核实 schema）`,
          cli,
          fallbackReason: cli.stderr,
          backup: backup.dir,
          ...(collateralRestored.length ? { collateralRestored } : {}),
        }
      }
      if (existedBefore !== null) writeFileAtomic(filePath, existedBefore)
      throw new RtkPlaneError(502, 'local', 'hook_write_unverified',
        `写入 ${spec.hookFile} 后仍检测不到目标状态（rtk CLI: ${cli.stderr}）`)
    }

    throw new RtkPlaneError(502, 'local', 'hook_cli_failed',
      `${spec.name} 的钩子文件形状未经验证，且 rtk CLI 失败：${cli.stderr}`)
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
  let fallbackReason: string | undefined
  let cli: RtkCliAttempt | undefined
  let collateralRestored: string[] | undefined

  if (plane === 'local') {
    const spec = rtkAgentSpec(agent)
    if (!spec) throw new RtkPlaneError(404, 'local', 'unknown_agent', `未知 agent: ${agent}`)
    assertLocalWrite(Boolean(options.confirm), policy)
    const result = await applyLocalAgentHook(spec, on, { home, bin: options.bin, timeoutMs: options.timeoutMs })
    mechanism = result.mechanism
    backup = result.backup
    fallbackReason = result.fallbackReason
    cli = result.cli
    collateralRestored = result.collateralRestored
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
  return {
    ...toStatusView(read, policy, home),
    ok: true,
    plane,
    readPlane: read.plane,
    ...(mechanism ? { mechanism } : {}),
    ...(backup ? { backup } : {}),
    ...(fallbackReason ? { fallbackReason } : {}),
    ...(cli ? { cli } : {}),
    ...(collateralRestored?.length ? { collateralRestored } : {}),
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
