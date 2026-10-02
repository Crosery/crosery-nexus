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
  /** 备份根目录里不认识的目录数量（只计数不删，避免误删用户的东西）。 */
  backupForeign: number
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
  /** 跨进程写入锁：等锁时长（毫秒，0 = 一次拿到；远端平面恒为 0）。 */
  lockWaitMs: number
  /** 本次接管了陈旧锁（持锁进程已死或超时）。 */
  lockStolen?: boolean
  /** 跨进程写入锁被 RTK_LOCK_DISABLED 旁路（生产不得设置）。 */
  lockDisabled?: boolean
  /** 释放时锁已被别人接管（如实上报）。 */
  lockLost?: boolean
  /** 失去锁的原因（token_mismatch / renew_failed / lock_file_unreadable …）。 */
  lockLostReason?: string
  /** 心跳续期失败次数（首次失败即 > 0）。 */
  lockRenewFailures?: number
  /** 最近一次心跳失败的脱敏错误。 */
  lockRenewLastError?: string
  lock?: RtkLockInfo
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

export type RTKFailure = {
  status: number
  error: string
  plane?: RtkPlaneId
  reason?: string
  backup?: string
  /** 锁在操作期间被接管（只读该字段的客户端不能漏判；与 reason='lock_lost_during_write' 同时出现）。 */
  lockLost?: boolean
  lockLostReason?: string
}

/** 承载 fencing 信息的 RtkPlaneError（不改 rtkPlane.ts 的类型也能挂上诊断字段）。 */
type RtkFencingPlaneError = RtkPlaneError & { lockLost?: boolean; lockLostReason?: string }

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
/* 写入锁                                                              */
/*                                                                     */
/* 两层锁，**固定顺序：先进程内闸，再跨进程文件锁**，释放顺序相反。    */
/* 死锁论证：任何路径都按同一顺序获取；文件锁的持有者只做本地写入，    */
/* 从不等待别的进程的内存锁，因此不可能形成等待环。                    */
/* 为什么不是「先文件锁」：同进程的两个 toggle 会先抢文件锁，而文件锁  */
/* 被本进程另一个请求长时间持有（每个请求的临界区包含 rtk CLI 调用）， */
/* 白白消耗跨进程锁的等待预算；先过进程内闸能让同进程请求自然排队。    */
/* ------------------------------------------------------------------ */

const fileLocks = new Map<string, Promise<unknown>>()

export async function withFileLock<T>(key: string, run: () => Promise<T> | T): Promise<T> {
  const previous = fileLocks.get(key) || Promise.resolve()
  const next = previous.then(run, run)
  fileLocks.set(key, next.then(() => undefined, () => undefined))
  return next
}

export type RtkLockInfo = {
  path: string
  /** 是否走了 RTK_LOCK_DISABLED 旁路（此时没有创建任何锁文件，必须能观测到）。 */
  disabled: boolean
  /** RTK_TEST_LOCK_HOLD_MS 生效时的额外持锁毫秒数（不设置时该字段不存在）。 */
  testHoldMs?: number
  /** 为了拿到锁等了多久（毫秒）；0 表示一次就拿到 */
  waitedMs: number
  /** 本次是否接管了一个陈旧锁 */
  stolen: boolean
  /** 释放时发现锁已不属于自己（被接管/被删），此时不会去删别人的锁 */
  lost: boolean
  /** 失去锁或被判定不再持锁的原因（token_mismatch / renew_failed / lock_file_missing 等）。 */
  lostReason?: string
  /** 心跳续期失败次数（首次失败就会 > 0，见 R10-B）。 */
  renewFailures?: number
  /** 最近一次心跳失败的脱敏错误码/信息。 */
  renewLastError?: string
  stolenFromPid?: number
  stolenFromAgeMs?: number
}

export type RtkFileLock = {
  info: RtkLockInfo
  /** 幂等；异常路径也必须在 finally 里调用 */
  release: () => void
  readonly lost: boolean
  /**
   * 主动读盘校验「这把锁还是不是我的」（token + inode），**不依赖心跳是否已经跑过**。
   * 用于提交点 fencing（R11-C）：锁被接管后，已经开始的写入必须在提交前放弃。
   */
  isOwned: () => boolean
  /** 提交点 fence：不持有就抛 409 lock_lost_during_write（带 plane/reason/backup）。 */
  assertOwned: () => void
}

// 注意：这里**不能** unref。unref 掉的定时器不会让事件循环保持存活：短命进程/脚本在
// 锁被占用时会「既不拿锁也不报错」地静默退出（红队 R9-B 的验证脚本就卡在这里）。
const sleep = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms) })

/** 跨进程写入锁超时（默认 15s，可配 0–300s）。 */
export function rtkLockTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.RTK_LOCK_TIMEOUT_MS)
  return Number.isFinite(raw) && raw >= 0 && raw <= 300_000 ? Math.floor(raw) : 15_000
}

let lockBypassWarned = false

/** 旁路必须可观测：响应里有 disabled，日志里有这条一次性告警。 */
function warnLockBypass(lockPath: string): void {
  if (lockBypassWarned) return
  lockBypassWarned = true
  console.warn('[rtk] RTK_LOCK_DISABLED 已启用：跨进程写入锁被旁路，**同时关闭提交点 fencing**（isOwned() 恒为 true，'
    + '锁被接管也不会阻断写入）。仅供「修前语义」对照实验，生产环境不得设置。'
    + `锁文件：${lockPath}`)
}

/**
 * **测试专用**同步点（方案 A）：在「锁已创建、但 acquire 还没返回」之间插入一段等待，
 * 让 harness 能把「篡改锁」确定性地排在「获取锁」与「提交点校验」之间 —— 不再靠睡一会儿赌窗口。
 * 默认 0（读取即 0，不产生任何等待）；生产环境不得设置。与 RTK_LOCK_DISABLED 同类，
 * 登记在 docs/qa/blue/rtk-flake-fix.md。
 */
export function rtkTestLockHoldMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.RTK_TEST_LOCK_HOLD_MS)
  return Number.isFinite(raw) && raw > 0 && raw <= 10_000 ? Math.floor(raw) : 0
}

let testHoldWarned = false

/** 测试专用同步点生效必须可观测：与 RTK_LOCK_DISABLED 对称，一次性告警 + info.testHoldMs。 */
function warnTestHold(lockPath: string, holdMs: number): void {
  if (testHoldWarned) return
  testHoldWarned = true
  console.warn(`[rtk] RTK_TEST_LOCK_HOLD_MS 已生效：每次获取写入锁后会额外持锁 ${holdMs}ms`
    + '（测试专用同步点，生产环境不得设置；上界 10000ms）。排障提示：写入变慢可能来自这里。'
    + `锁文件：${lockPath}`)
}

/** 陈旧锁判定阈值（默认 60s，可配 1s–3600s）：持锁进程还活着但超过这个时间也算陈旧。 */
export function rtkLockStaleMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.RTK_LOCK_STALE_MS)
  return Number.isFinite(raw) && raw >= 1_000 && raw <= 3_600_000 ? Math.floor(raw) : 60_000
}

/** 锁文件与备份目录同源：尊重 RTK_BACKUP_DIR / RTK_HOME 覆盖，跨进程共享的就是这个状态目录。 */
export function rtkLockPath(home: string = resolveHome(), env: NodeJS.ProcessEnv = process.env): string {
  return path.join(path.dirname(rtkBackupRoot(home, env)), 'rtk-write.lock')
}

type LockPayload = { token: string; pid: number; at: string; purpose: string; home: string }

function readLockPayload(lockPath: string): LockPayload | null {
  const content = readFileIfExists(lockPath)
  if (content === null) return null
  try {
    const parsed = JSON.parse(content) as Partial<LockPayload>
    return typeof parsed?.token === 'string' && typeof parsed?.pid === 'number'
      ? parsed as LockPayload
      : null
  } catch {
    return null
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM = 进程存在但不属于我们；ESRCH = 已不存在
    return (error as { code?: string }).code === 'EPERM'
  }
}

export type RtkLockProbe = {
  stale: boolean
  reason?: string
  pid?: number
  ageMs?: number
  /** 载荷里的 at 与文件 mtime 明显分歧（时钟偏移/被外部改动）时为 true —— 此时**不**基于超时接管。 */
  suspicious?: boolean
  /** 载荷记录的 home 与本次不同（两个 home 共用同一个 RTK_BACKUP_DIR 的情形）。 */
  foreignHome?: boolean
  /** 给诊断/测试看的补充说明。 */
  note?: string
}

/** at 与 mtime 允许的最大分歧（超过就认为时钟/文件被改动，而不是「持有者卡死」）。 */
const LOCK_AT_MTIME_TOLERANCE_MS = 5_000

/**
 * 陈旧判定。
 *
 * 时钟假设（红队 R9-C，写进契约）：
 * - 判定只使用**本机时钟**与文件 mtime；载荷里的 `at` 只用于**交叉校验**。
 * - 参与互斥的两个实例必须共享同一时钟（同机/同一 VPS 容器）。跨主机、或时钟偏移超过
 *   `LOCK_AT_MTIME_TOLERANCE_MS` 的场景**不支持**：此时 `at` 与 mtime 分歧，我们宁可
 *   不接管（返回 suspicious），也不冒险夺走一个活着的持有者。
 * - 因此「只改 mtime」不再能夺锁（活着 + at 新鲜 → suspicious，不接管）。
 *   ⚠️ 措辞收紧：at×mtime 是**时钟偏移探测器，不是防篡改机制**——同时改掉 at 与 mtime 仍然会被
 *   判为超时并可接管；它防的是「时钟不同步」这类误判，不防恶意改写本地文件（本机同用户本来就能改）。
 *
 * 判据：① pid 已不存在 → holder_dead；② 内容不可解析且超过 5s → unreadable_lock；
 * ③ pid 活着、at 与 mtime 一致、且都超过 staleMs → holder_timeout（**跨 home 共用备份目录时不接管**）。
 */
export function inspectRtkLock(lockPath: string, now = Date.now(), staleMs = rtkLockStaleMs(), home?: string): RtkLockProbe {
  if (!fs.existsSync(lockPath)) return { stale: false }
  const payload = readLockPayload(lockPath)
  let ageMs: number | undefined
  let mtimeMs: number | undefined
  try {
    mtimeMs = fs.statSync(lockPath).mtimeMs
    ageMs = Math.max(0, now - mtimeMs)
  } catch {
    ageMs = undefined
  }
  if (!payload) {
    // 只有 mkdir/open 成功、内容还没写完就被杀，或者文件被外部改坏
    const age = ageMs ?? 0
    return age > 5_000
      ? { stale: true, reason: 'unreadable_lock', ageMs: age }
      : { stale: false, ageMs: age }
  }
  const foreignHome = Boolean(home) && typeof payload.home === 'string' && payload.home !== home
  if (!pidAlive(payload.pid)) {
    return { stale: true, reason: 'holder_dead', pid: payload.pid, ageMs: ageMs ?? 0, ...(foreignHome ? { foreignHome } : {}) }
  }
  // at 与 mtime 交叉校验：分歧说明时钟不可信（或文件被改），不基于超时接管
  const atMs = Date.parse(String(payload.at))
  const divergence = Number.isFinite(atMs) && mtimeMs !== undefined ? Math.abs(atMs - mtimeMs) : 0
  const suspicious = divergence > LOCK_AT_MTIME_TOLERANCE_MS
  if (suspicious) {
    return {
      stale: false, pid: payload.pid, ageMs: ageMs ?? 0, suspicious,
      ...(foreignHome ? { foreignHome } : {}),
      note: `载荷 at 与文件 mtime 相差 ${Math.round(divergence)}ms（超过 ${LOCK_AT_MTIME_TOLERANCE_MS}ms）：按「时钟不可信」处理，不接管；需要时请人工确认持有者 pid=${payload.pid}`,
    }
  }
  if ((ageMs ?? 0) > staleMs) {
    if (foreignHome) {
      return {
        stale: false, pid: payload.pid, ageMs: ageMs ?? 0, foreignHome,
        note: `锁属于另一个 home（${payload.home}）：共用同一个备份目录时只接管已死进程的锁，不基于超时接管`,
      }
    }
    return { stale: true, reason: 'holder_timeout', pid: payload.pid, ageMs: ageMs ?? 0 }
  }
  return { stale: false, pid: payload.pid, ageMs: ageMs ?? 0, ...(foreignHome ? { foreignHome } : {}) }
}

/**
 * 续期（心跳）：重写载荷里的 at 并刷新 mtime，token 不变。
 * 目的：临界区超过 `staleMs` 时（rtk CLI 卡住、慢盘、被杀毒扫描阻塞）也不会被误判陈旧夺锁。
 * 心跳定时器自身 unref（它不需要把进程留活；真正持锁的是调用方的临界区）。
 */
/**
 * 心跳周期：既要远小于 staleMs（否则活锁会被误判陈旧），也不能小到空转。
 * 不变量：`interval ≤ staleMs` 对任意 staleMs ≥ 10 成立（R11-A：旧式子在 staleMs < 200 时
 * 会返回 200 > staleMs，心跳比阈值还慢，自相矛盾）。下限 10ms 只用于兜底，实际由
 * rtkLockStaleMs() 把 env 钳在 ≥1000。
 */
export function rtkLockHeartbeatMs(staleMs: number): number {
  const safeStale = Math.max(10, Math.floor(staleMs))
  return Math.max(10, Math.min(Math.max(200, Math.floor(safeStale / 3)), safeStale))
}

const renewTempName = (lockPath: string) => `${lockPath}.renew-${process.pid}-${randomBytes(3).toString('hex')}`

/** 清理崩溃残留的 *.renew-*（同一个锁目录、够老的才算，避免误删正在进行中的续期）。 */
export function sweepStaleRenewTemps(lockPath: string, olderThanMs = 30_000, now = Date.now()): string[] {
  const dir = path.dirname(lockPath)
  const prefix = `${path.basename(lockPath)}.renew-`
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return []
  }
  const removed: string[] = []
  for (const name of names) {
    if (!name.startsWith(prefix)) continue
    const file = path.join(dir, name)
    try {
      if (now - fs.statSync(file).mtimeMs < olderThanMs) continue
      fs.rmSync(file)
      removed.push(name)
    } catch {
      // 清理失败不影响主流程
    }
  }
  return removed
}

type HeartbeatOptions = {
  lockPath: string
  token: string
  payload: LockPayload
  staleMs: number
  /** 由 acquire 提供的持有权校验（token + inode），与 assertOwned 共用同一实现。 */
  owns: () => 'yes' | 'stolen' | 'unreadable'
  /** 每次成功续期后告诉我们新的 inode（rename 会换 inode）。 */
  onRenewed: (ino: number) => void
  onLost: (reason: string) => void
  onFailure: (error: unknown, failures: number) => void
}

/**
 * 心跳续期。
 *
 * R10-A（高）：续期**必须先校验锁还是自己的**（token + inode 双校验），不匹配就**不续期**、
 * 停表并置 lost —— 否则被接管之后，原持有者会按计划周期性地把锁「抢回来」，又变回两个持有者。
 * 写回采用「校验 → 写临时文件 → 再校验 → rename」，残余窗口只有两次校验之间的微秒级；
 * 即使撞上，下一次 tick 的校验会立刻发现（`token_mismatch` → lost），且 `release()` 的
 * token 守卫也保证不会删掉接管者的锁。
 *
 * R10-B（中）：续期失败不再静默吞掉 —— 计数 + 记录脱敏错误码，首次失败即可见；
 * 连续 N 次失败后主动置 lost（假活锁会让人以为还持锁，实际 mtime 不前进、随时被夺）。
 */
function startLockHeartbeat(options: HeartbeatOptions): { stop: () => void } {
  const { lockPath, payload, staleMs, owns: ownsLock } = options
  const intervalMs = rtkLockHeartbeatMs(staleMs)
  let failures = 0
  const MAX_RENEW_FAILURES = 3

  const timer = setInterval(() => {
    const state = ownsLock()
    if (state !== 'yes') {
      clearInterval(timer)
      options.onLost(state === 'unreadable' ? 'lock_file_unreadable' : 'token_mismatch')
      return
    }
    const temp = renewTempName(lockPath)
    try {
      fs.writeFileSync(temp, JSON.stringify({ ...payload, at: new Date().toISOString() }), { mode: 0o600 })
      const tempIno = fs.statSync(temp).ino
      // 第二次校验：确认这期间锁没有被别人接管，才允许 rename 覆盖
      if (ownsLock() !== 'yes') {
        fs.rmSync(temp, { force: true })
        clearInterval(timer)
        options.onLost('token_mismatch')
        return
      }
      fs.renameSync(temp, lockPath)
      failures = 0
      options.onRenewed(tempIno)
    } catch (error) {
      try {
        fs.rmSync(temp, { force: true })
      } catch {
        // 清理失败不影响判定
      }
      failures += 1
      options.onFailure(error, failures)
      if (failures >= MAX_RENEW_FAILURES) {
        // 连续失败：锁的 mtime 已经不再前进，随时会被判陈旧夺走 —— 如实降级
        clearInterval(timer)
        options.onLost('renew_failed')
      }
    }
  }, intervalMs)
  timer.unref?.()
  return { stop: () => clearInterval(timer) }
}

export async function acquireRtkFileLock(options: {
  home?: string
  purpose?: string
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  staleMs?: number
} = {}): Promise<RtkFileLock> {
  const env = options.env ?? process.env
  const home = options.home ?? resolveHome()
  const lockPath = rtkLockPath(home, env)
  const timeoutMs = options.timeoutMs ?? rtkLockTimeoutMs(env)
  const staleMs = options.staleMs ?? rtkLockStaleMs(env)
  const token = randomBytes(8).toString('hex')
  const purpose = String(options.purpose || 'rtk local write').slice(0, 80)
  // RTK_LOCK_DISABLED 只用于「去掉锁」的对照实验，正常部署不要设。
  // ⚠️ 它同时关闭 fencing：isOwned() 恒为 true、assertOwned() 不抛（R12-C）。
  const disabled = ['1', 'true', 'yes', 'on'].includes(String(env.RTK_LOCK_DISABLED || '').toLowerCase())
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 })
  const startedAt = Date.now()
  let stolen = false
  let stolenFromPid: number | undefined
  let stolenFromAgeMs: number | undefined
  let lost = false

  const info: RtkLockInfo = { path: lockPath, disabled, waitedMs: 0, stolen: false, lost: false }
  // 当前锁文件的 inode：rename 会换 inode，「被别人删掉重建」据此立刻可见
  let lockIno: number | undefined
  try {
    lockIno = fs.existsSync(lockPath) ? fs.statSync(lockPath).ino : undefined
  } catch {
    lockIno = undefined
  }
  const ownsLock = (): 'yes' | 'stolen' | 'unreadable' => {
    let currentIno: number | undefined
    try {
      currentIno = fs.statSync(lockPath).ino
    } catch {
      return 'stolen' // 文件都没了：被接管/被删
    }
    if (lockIno !== undefined && currentIno !== lockIno) return 'stolen' // 换过 inode = 被别人重建过
    const current = readLockPayload(lockPath)
    if (!current) return 'unreadable'
    return current.token === token ? 'yes' : 'stolen'
  }
  const markLost = (reason: string) => {
    lost = true
    info.lost = true
    info.lostReason = reason
  }
  /**
   * 提交点 fence（R11-C）：主动读盘确认锁仍属于自己。不匹配就抛结构化错误，
   * 让调用方**放弃这次写入**并如实上报「这次没生效，请重试」。
   */
  // 措辞（R12-A）：这是「每个写入前校验一次」，不是「写入与校验原子」。
  // 校验与写入之间存在 ≤1 个系统调用的窗口（无原生 CAS 无法消除）；要打进去必须在 H 校验通过后的
  // 一个系统调用内完成 T 的「判陈旧 → unlink → 新建 → 写入」，而此刻 H 的锁是新鲜的（心跳还在续期），
  // 因此该窗口在现实的调度/IO 时延下不可达；即便撞上，下一次校验（或心跳）也会立刻把 lost 标出来。
  const assertOwned = () => {
    const state = disabled ? 'yes' : ownsLock()
    if (state === 'yes') return
    markLost(state === 'unreadable' ? 'lock_file_unreadable' : 'token_mismatch')
    const failure = new RtkPlaneError(409, 'local', 'lock_lost_during_write',
      `写入锁在操作期间被接管（${info.lostReason}）：已放弃本次提交，改动可能未生效，请重试`
      + `（可用 /api/rtk/rollback 恢复；锁：${lockPath}）`) as RtkFencingPlaneError
    // 供只读 lockLost 的客户端判断（R12-B）；HTTP 层需在响应里一并透出
    failure.lockLost = true
    failure.lockLostReason = info.lostReason
    throw failure
  }
  // 旁路（RTK_LOCK_DISABLED=1）时恒为 true：**该开关同时关闭 fencing**（R12-C）
  const isOwned = () => (disabled ? true : ownsLock() === 'yes')
  const release = () => {
    try {
      const payload = readLockPayload(lockPath)
      if (!payload) {
        // 读不出载荷时**一律不删**（红队 R9-A）：
        // 比我们更晚出现的空文件/坏文件，更可能是「接管者刚 open('wx') 还没 write」的半成品；
        // 删掉它会让接管者往已 unlink 的 inode 上写、路径却空着 —— 两个持有者同时写。
        // 回收交给陈旧判据：不可解析 + 阈值之后自然可接管。这里只如实告诉调用方我们已不再持锁。
        lost = true
        info.lost = true
        return
      }
      if (payload.token !== token) {
        // 锁已经被别人接管（例如我们卡住超过 staleMs），绝不删别人的锁
        lost = true
        info.lost = true
        return
      }
      fs.rmSync(lockPath)
    } catch {
      lost = true
      info.lost = true
    }
  }

  if (disabled) {
    // RTK_LOCK_DISABLED 只用于「去掉锁」的对照实验：这里明确标记旁路 + 打一条一次性告警，
    // 生产环境不得设置（launchd 当前未设）。注意：**该开关同时关闭 fencing**（isOwned() 恒为 true）。
    warnLockBypass(lockPath)
    info.waitedMs = 0
    return { info, release: () => {}, get lost() { return lost }, isOwned, assertOwned }
  }


  while (true) {
    try {
      const payload: LockPayload = { token, pid: process.pid, at: new Date().toISOString(), purpose, home }
      const fd = fs.openSync(lockPath, 'wx', 0o600)
      try {
        fs.writeSync(fd, JSON.stringify(payload))
      } finally {
        fs.closeSync(fd)
      }
      // 崩溃残留的续期临时文件：只清够老的，避免误删正在进行的续期
      sweepStaleRenewTemps(lockPath, Math.max(30_000, staleMs))
      lockIno = fs.statSync(lockPath).ino
      const heartbeat = startLockHeartbeat({
        lockPath, token, payload, staleMs, owns: ownsLock,
        onRenewed: (nextIno: number) => {
          lockIno = nextIno
          info.renewFailures = 0
          delete info.renewLastError
        },
        onFailure: (error, failures) => {
          info.renewFailures = failures
          info.renewLastError = redact(String((error as { code?: string } | null)?.code || (error instanceof Error ? error.message : String(error)))).slice(0, 120)
          console.warn(`[rtk] 写入锁心跳续期失败（第 ${failures} 次）：${info.renewLastError}（锁：${lockPath}）`)
        },
        onLost: (reason) => {
          markLost(reason)
          console.warn(`[rtk] 写入锁已不再属于本进程（${reason}），后续不再续期、也不删除他人的锁（锁：${lockPath}）`)
        },
      })
      // 测试专用同步点（默认 0，不生效）：见 rtkTestLockHoldMs()。生产路径无业务分支。
      const testHoldMs = rtkTestLockHoldMs(env)
      if (testHoldMs > 0) {
        info.testHoldMs = testHoldMs       // 透出：响应里的 lock.testHoldMs 能看到
        warnTestHold(lockPath, testHoldMs) // 一次性告警：静默变慢必须能被排障发现
        await sleep(testHoldMs)
      }
      info.waitedMs = Date.now() - startedAt
      info.stolen = stolen
      if (stolenFromPid !== undefined) info.stolenFromPid = stolenFromPid
      if (stolenFromAgeMs !== undefined) info.stolenFromAgeMs = stolenFromAgeMs
      const releaseWithHeartbeat = () => {
        heartbeat.stop()
        release()
      }
      return { info, release: releaseWithHeartbeat, get lost() { return lost }, isOwned, assertOwned }
    } catch (error) {
      const code = (error as { code?: string }).code
      if (code !== 'EEXIST') {
        // 目录不可写等：如实报错，不假装拿到锁
        const failure = new RtkPlaneError(500, 'local', 'rtk_lock_unavailable', `无法创建写入锁（${code || 'unknown'}）：${lockPath}`)
        throw failure
      }
    }

    const state = inspectRtkLock(lockPath, Date.now(), staleMs, home)
    if (state.stale) {
      try {
        fs.rmSync(lockPath)
        stolen = true
        stolenFromPid = state.pid
        stolenFromAgeMs = state.ageMs
        continue
      } catch {
        // 别人先接管了：继续重试
      }
    }
    if (Date.now() - startedAt >= timeoutMs) {
      throw new RtkPlaneError(503, 'local', 'rtk_lock_timeout',
        `等待跨进程写入锁超时（${timeoutMs}ms，锁：${lockPath}，持有者 pid=${state.pid ?? '?'}`
        + `${state.suspicious ? '；时钟疑似不一致：两个实例必须共享同一时钟，请检查时钟偏移' : ''}`
        + `${state.note ? `；${state.note}` : ''}）`)
    }
    await sleep(8 + Math.floor(Math.random() * 22))
  }
}

/* ------------------------------------------------------------------ */
/* 路径收口（安全，task-56）                                            */
/*                                                                     */
/* 红队第十五轮在 POST /api/rtk/rollback 上做出路径穿越：backupId 没校验就      */
/* path.join(备份根, id)、manifest.files[].rel 没校验就 path.join(home, rel)，   */
/* 结果可以越界删除 home 内文件、并在 home 之外写任意内容。                      */
/* 现在所有吃 rel / 路径的地方**统一走下面这组校验器**（单点实现）：              */
/*   - assertRelShape：形状白名单（非空、相对、无 NUL、无空段/./..、无反斜杠）    */
/*   - assertInsideDir：解析后必须落在允许目录内，并对已存在部分做 realpath，     */
/*     防「软链接逃逸」（已存在的文件/目录被换成指向外部的符号链接）              */
/*   - homeRelPath：home 下的 rel → 绝对路径（所有消费 rel 的地方都用它）         */
/* 任一处不合法一律抛 RtkPlaneError(400)，整单拒绝，不做部分还原。               */
/* ------------------------------------------------------------------ */

const RtkPathError = (reason: string, detail: string) => new RtkPlaneError(400, 'local', reason, detail)

/** 解析「真实」路径：已存在就 realpath；不存在则把最近的已存在祖先 realpath 后再接回剩余段。 */
function realPathOf(target: string): string {
  const resolved = path.resolve(target)
  let current = resolved
  const tail: string[] = []
  for (;;) {
    try {
      const real = fs.realpathSync(current)
      return tail.length ? path.join(real, ...tail.reverse()) : real
    } catch {
      const parent = path.dirname(current)
      if (parent === current) return resolved
      tail.push(path.basename(current))
      current = parent
    }
  }
}

const isInsideDir = (parent: string, child: string): boolean => child === parent || child.startsWith(parent + path.sep)

/** 相对路径形状校验：非空、相对、无 NUL、无空段 / `.` / `..`、无反斜杠。 */
export function assertRelShape(rel: unknown, reason = 'rel_path_invalid'): string {
  if (typeof rel !== 'string' || !rel.trim()) throw RtkPathError(reason, '文件路径必须是非空字符串')
  const value = rel.trim()
  if (value.includes('\0')) throw RtkPathError(reason, '文件路径含 NUL 字节')
  if (path.isAbsolute(value)) throw RtkPathError(reason, `文件路径必须是相对路径：${value}`)
  if (value.includes('\\')) throw RtkPathError(reason, `文件路径不得包含反斜杠：${value}`)
  for (const segment of value.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw RtkPathError(reason, `文件路径含非法片段（空 / . / ..）：${value}`)
    }
  }
  return value
}

/** 断言 child（绝对路径，或相对 parent 的相对路径）解析后位于 parent 之内；含 realpath 防软链接逃逸。 */
export function assertInsideDir(parent: string, child: string, reason = 'path_escape', what = '路径'): string {
  const resolvedParent = path.resolve(parent)
  const resolved = path.resolve(resolvedParent, child)
  if (!isInsideDir(resolvedParent, resolved)) {
    throw RtkPathError(reason, `${what} 解析后落在允许目录之外：${child}`)
  }
  const realParent = realPathOf(resolvedParent)
  const real = realPathOf(resolved)
  if (!isInsideDir(realParent, real)) {
    throw RtkPathError(reason, `${what} 经符号链接解析后落在允许目录之外：${child}`)
  }
  return resolved
}

/** `home` 下的相对路径 → 绝对路径。**所有消费 rel 的地方都必须走这里**（含 registry 里的 rel）。 */
export function homeRelPath(home: string, rel: unknown, reason = 'rel_path_invalid'): string {
  const safe = assertRelShape(rel, reason)
  return assertInsideDir(home, safe, reason, `home 下的文件路径 ${safe}`)
}

/** 两个路径是否指向同一处（先按解析结果比，再按 realpath 比，兼容软链接过的 home）。 */
function samePath(left: string, right: string): boolean {
  return path.resolve(left) === path.resolve(right) || realPathOf(left) === realPathOf(right)
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
    // 备份也 fail closed：rel 不合法就整单拒绝，绝不写出一个能越界的清单
    const safeRel = assertRelShape(rel, 'backup_rel_invalid')
    const source = assertInsideDir(home, safeRel, 'backup_rel_invalid', `备份源文件 ${safeRel}`)
    const existed = fs.existsSync(source)
    if (existed) fs.copyFileSync(source, path.join(dir, backupFileName(safeRel)))
    return { rel: safeRel, existed }
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

type BackupEntry = { id: string; hasManifest: boolean; recognized: boolean; empty: boolean }

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
    .filter(name => {
      try {
        return fs.statSync(path.join(root, name)).isDirectory()
      } catch {
        return false
      }
    })
    .sort()
    .reverse()
    .map(id => {
      let empty = false
      try {
        empty = fs.readdirSync(path.join(root, id)).length === 0
      } catch {
        // 读不到就当非空，保守不删
      }
      return {
        id,
        hasManifest: fs.existsSync(path.join(root, id, 'manifest.json')),
        recognized: BACKUP_ID_PATTERN.test(id),
        empty,
      }
    })
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
    // 不认识的目录（既不是备份 id 形状、也不空）只保留并计数：宁可留垃圾，也不删用户的东西
    if (!entry.recognized && !entry.empty) continue
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

/** 无 manifest 的孤儿备份目录数量（过保护窗口后会被清理）。 */
export function countRtkBackupOrphans(home: string = resolveHome()): number {
  return backupEntries(home).filter(entry => !entry.hasManifest && (entry.recognized || entry.empty)).length
}

/** 备份根目录里「不认识的目录」数量：只计数、不删除（避免误删用户的东西）。 */
export function countRtkBackupForeign(home: string = resolveHome()): number {
  return backupEntries(home).filter(entry => !entry.recognized && !entry.empty).length
}

export function listRtkBackups(home: string = resolveHome(), limit = rtkBackupKeep()): RtkBackupSummary[] {
  // 只列白名单 id：备份根里其它名字的目录（含 `..`/rogue）不能被当成「可用备份」
  return backupEntries(home).filter(entry => entry.hasManifest && entry.recognized).slice(0, Math.max(1, limit)).map(entry => {
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(rtkBackupRoot(home), entry.id, 'manifest.json'), 'utf8')) as { at?: string; files?: unknown[] }
      return { id: entry.id, at: manifest.at || entry.id, fileCount: (manifest.files || []).length }
    } catch {
      return { id: entry.id, at: entry.id, fileCount: 0 }
    }
  })
}

/**
 * 从备份原地恢复：写过的文件回滚，原本不存在的文件删掉。
 *
 * 安全（task-56，fail closed）：
 * - `backupId` 必须匹配 `BACKUP_ID_PATTERN`（白名单），且解析后落在备份根内（含 realpath 防软链接逃逸）；
 * - manifest 必须是合法结构、`id` 与请求一致、`home` 与当前 home 一致、`files` 非空；
 * - 每个 `files[].rel` 必须是相对路径、无 `..`，解析（含 realpath）后落在 `home` 内；
 * - **先全量校验出一个计划，再动手写**：任何一条不合法就整体拒绝，绝不部分还原。
 */
export function restoreRtkBackup(home: string, backupId?: string): { id: string; restored: string[] } {
  const root = rtkBackupRoot(home)
  const requested = typeof backupId === 'string' ? backupId.trim() : ''
  const id = requested || listRtkBackups(home, 1)[0]?.id || ''
  if (!id) throw new RtkPlaneError(404, 'local', 'backup_not_found', '没有可用的 RTK 备份')

  // ① backupId：白名单 + 必须落在备份根内
  if (!BACKUP_ID_PATTERN.test(id) || id.includes('/') || id.includes('\\') || id.includes('..')) {
    throw RtkPathError('backup_id_invalid', `备份 id 不合法（只接受备份根下形如 2026-10-01T01-10-10-661Z 的 id）：${redact(id).slice(0, 60)}`)
  }
  const dir = assertInsideDir(root, id, 'backup_path_escape', '备份目录')
  const manifestPath = path.join(dir, 'manifest.json')
  if (!fs.existsSync(manifestPath)) {
    throw new RtkPlaneError(404, 'local', 'backup_not_found', `备份 ${id} 不存在`)
  }

  // ② manifest：结构 / id / home / files 全量校验
  let raw: unknown
  try {
    raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  } catch {
    throw RtkPathError('manifest_invalid', `备份 ${id} 的 manifest.json 不是合法 JSON，拒绝还原`)
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw RtkPathError('manifest_invalid', `备份 ${id} 的 manifest 结构非法，拒绝还原`)
  }
  const manifest = raw as { id?: unknown; home?: unknown; files?: unknown }
  if (manifest.id !== id) {
    throw RtkPathError('manifest_invalid', `备份 ${id} 的 manifest.id（${String(manifest.id)}）与请求不一致，拒绝还原`)
  }
  if (typeof manifest.home !== 'string' || !samePath(manifest.home, home)) {
    throw RtkPathError('manifest_invalid', `备份 ${id} 属于另一个 home（${String(manifest.home)}），拒绝还原`)
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw RtkPathError('manifest_invalid', `备份 ${id} 的清单为空或结构非法，拒绝还原`)
  }
  const plan = manifest.files.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw RtkPathError('manifest_invalid', `备份 ${id} 的清单第 ${index + 1} 项结构非法，拒绝还原`)
    }
    const { rel, existed } = entry as { rel?: unknown; existed?: unknown }
    if (typeof rel !== 'string' || typeof existed !== 'boolean') {
      throw RtkPathError('manifest_invalid', `备份 ${id} 的清单第 ${index + 1} 项必须是 { rel: string, existed: boolean }，拒绝还原`)
    }
    const safeRel = assertRelShape(rel, 'manifest_rel_invalid')
    return {
      rel: safeRel,
      existed,
      target: assertInsideDir(home, safeRel, 'manifest_rel_outside_home', `清单文件路径 ${safeRel}`),
      source: assertInsideDir(dir, backupFileName(safeRel), 'backup_path_escape', `备份文件 ${safeRel}`),
    }
  })

  // ③ 全部校验通过后才提交
  const restored: string[] = []
  for (const item of plan) {
    if (item.existed && fs.existsSync(item.source)) {
      fs.mkdirSync(path.dirname(item.target), { recursive: true })
      fs.copyFileSync(item.source, item.target)
    } else if (!item.existed && fs.existsSync(item.target)) {
      fs.rmSync(item.target)
    }
    restored.push(item.rel)
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
    const dirPath = homeRelPath(home, spec.dir)
    const hookPath = spec.hookFile ? homeRelPath(home, spec.hookFile) : null
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

/**
 * `rtk --version` / `rtk gain` 每次都是两个子进程；版本小组件、状态页、/api/version 会在同一次
 * 页面加载里各读一遍。按 (二进制, HOME) 缓存 30s（缓存的是 Promise，并发读取共用一次执行）；
 * `fresh` 读取（写入后的复核、测试）直接跳过缓存。agent 钩子状态是文件读取，不进这层缓存。
 */
const LOCAL_STATS_TTL_MS = 30_000
const localStatsCache = new Map<string, { at: number; value: Promise<{ version: string | null; gain: RtkGain | null; days: RtkDay[] }> }>()

function cachedRTKStats(binPath: string, home: string, fresh: boolean) {
  const key = `${binPath}\0${home}`
  const hit = localStatsCache.get(key)
  if (!fresh && hit && Date.now() - hit.at < LOCAL_STATS_TTL_MS) return hit.value
  const value = getRTKStats(binPath, home)
  localStatsCache.set(key, { at: Date.now(), value })
  return value
}

export function resetRtkStatsCache(): void {
  localStatsCache.clear()
}

export async function readLocalPayload(binPath: string | null, home: string = resolveHome(), options: { fresh?: boolean } = {}): Promise<RtkPlanePayload> {
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
  const { version, gain, days } = await cachedRTKStats(binPath, home, options.fresh === true)
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
  const local = await readLocalPayload(bin, home, { fresh: options.fresh })
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
    backupForeign: countRtkBackupForeign(home),
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
  /** 跨进程写入锁的可观测信息（等锁时长 / 是否接管陈旧锁 / 释放时是否已失去锁）。 */
  lock?: RtkLockInfo
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
  const content = readFileIfExists(homeRelPath(home, spec.hookFile))
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
  options: { fence?: () => void } = {},
): ReconcileOutcome {
  // R11-C 提交点 fencing：锁一旦被接管，就不再写任何「连带还原」文件（否则可能盖掉接管者的写入）
  if (options.fence) {
    try {
      options.fence()
    } catch {
      return {
        entries: entries.map(entry => ({ agent: entry.owner, action: 'skipped' as const, files: [entry.rel], reason: 'lock_lost' })),
        files: [],
        skipped: entries.map(entry => ({ agent: entry.owner, file: entry.rel, reason: 'lock_lost' })),
      }
    }
  }
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
    const target = homeRelPath(home, rel)
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
    const bakPath = homeRelPath(home, bakRel)
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

/**
 * rtk CLI 在同一 HOME 上并发跑会互相干扰（红队第三轮 ⑥：宽并发下某个 agent 稳定
 * 「exit 0 但目标状态未生效」）。per-agent 文件锁只序列化同一 agent，这里再加一个
 * 进程级串行闸，让所有 `rtk init -g` 一次只跑一个。
 */
const RTK_CLI_GATE = 'rtk-cli-gate'

function runRtkCliSerialized(bin: string, args: string[], home: string, timeoutMs: number): Promise<RtkCliAttempt> {
  return withFileLock(RTK_CLI_GATE, () => runRtkCli(bin, args, home, timeoutMs))
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

  // 关键：整个「快照 → CLI → 连带还原 → 校验」必须相对本进程内其它本机写操作原子。
  // 否则并发 toggle 时，A 的合法写入会被 B 当成「rtk 的连带改动」还原掉：红队第三轮
  // 复现是 12 路并发全部返回 200，但最终只有最后一个 agent 还是挂载状态。
  // 进程内全局闸（按 home 区分）；跨进程并发仍不安全，见交付文档「未验证」。
  return withFileLock(`rtk-local-write:${home}`, async () => {
    // 固定顺序：① 进程内闸（上一行）→ ② 跨进程文件锁（下面这行）。见文件顶部死锁论证。
    const lock = await acquireRtkFileLock({ home, purpose: `toggle ${spec.id} ${on ? 'on' : 'off'}` })
    const runLocked = async (): Promise<LocalHookResult> => {
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
      for (const rel of allFiles) snapshot.set(rel, readFileIfExists(homeRelPath(home, rel)))
      pruneRtkBackups(home, rtkBackupKeep(), { protect: [backup.id] })

      const restoreTargetsRaw = () => {
        for (const rel of targets) {
          const target = homeRelPath(home, rel)
          const before = snapshot.get(rel) ?? null
          const after = readFileIfExists(target)
          if (after !== before) restoreToSnapshot(target, before, after)
        }
      }
      /** 成功路径也把「用户原本就有的 .bak」还回去（rtk 会覆写它，属于静默数据丢失）。 */
      const preserveUserBaksRaw = (): string[] => {
        if (!hookBak) return []
        const before = snapshot.get(hookBak) ?? null
        if (before === null) return []
        const target = homeRelPath(home, hookBak)
        if (readFileIfExists(target) === before) return []
        restoreToSnapshot(target, before, readFileIfExists(target))
        return [hookBak]
      }

      const preserveUserBaks = (): string[] => {
        // 失去锁就不再写用户的 .bak（可能盖掉接管者的写入）
        if (!lock.isOwned()) return []
        return preserveUserBaksRaw()
      }

      // TODO(fencing): 若 rtk CLI 的写入必须可回滚/可撤销，请改为「CLI 只产出计划 + 控制台统一提交」。
      // 现状（红队 R11-C 方案 A）：CLI 是外部进程、它自己的写入无法 fence；我们在 CLI 返回后、
      // 任何后续写入与「报成功」之前校验锁，失去锁就放弃提交并报 409 lock_lost_during_write。
      // 触发条件见 docs/qa/blue/rtk-fencing-and-heartbeat.md §3。
      // rtk init 需要目标目录已存在（cursor 还会写 .claude/RTK.md），否则它自己 exit 1。
      for (const rel of targets) fs.mkdirSync(path.dirname(homeRelPath(home, rel)), { recursive: true })
      fs.mkdirSync(path.join(home, spec.dir), { recursive: true })

      const restoreTargets = () => {
        // 失败回填同样要 fence：锁被接管后回填会盖掉接管者的写入，宁可留着让用户重试
        if (!lock.isOwned()) return
        restoreTargetsRaw()
      }

      const success = (mechanism: 'rtk-cli' | 'hooks-json', detail: string, cli: RtkCliAttempt, fallbackReason?: string): LocalHookResult => {
        // 最终提交点：确认锁仍属于自己，否则放弃「连带还原 + .bak 还原」并如实报错
        lock.assertOwned()
        const collateral = reconcileCollateral(home, snapshot, guards, { fence: () => lock.assertOwned() })
        const preservedBak = preserveUserBaks()
        // 提交块结束时再校验一次：如果丢锁是在连带还原阶段被发现的（reconcile 返回 skipped 而不抛），
        // 这里必须把「本次没生效」如实报出去，绝不能返回 ok（R12-A 同族的诚实性要求）。
        lock.assertOwned()
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
          const runOnce = () => runRtkCliSerialized(bin, args, home, options.timeoutMs ?? 20_000)
          cli = await runOnce()
          // ON / OFF 共用同一套写后校验：目标状态 + 文件仍是合法 JSON（P0-2）
          let integrity = hookFileIntegrity(spec, home)
          if (!integrity && cli.ok && !verifyLocalHook(spec, on, home)) {
            // 「exit 0 但状态没生效」是并发干扰的典型症状：串行重试一次再判定（红队 ⑥）
            cli = await runOnce()
            integrity = hookFileIntegrity(spec, home)
          }
          if (integrity) {
            restoreTargets()
            reconcileCollateral(home, snapshot, guards)
            throw brokenHookFileError(spec, integrity, backup.dir)
          }
          if (cli.ok && verifyLocalHook(spec, on, home)) {
            // 提交点：CLI 自己写过盘，但只要我们已失去锁就不能声称成功（R11-C）
            lock.assertOwned()
            return success('rtk-cli', `rtk init -g ${args.join(' ')}`, cli)
          }
          cli = cli.ok ? { ...cli, ok: false, stderr: 'rtk 执行成功但目标状态未生效' } : cli
        } else {
          cli = { command: `rtk init -g ${args.join(' ')}`, exitCode: null, stderr: `${bin} 不存在`, ok: false }
        }

        const jsonSpec = HOOK_JSON[spec.id]
        if (spec.hookFile && jsonSpec) {
          const filePath = homeRelPath(home, spec.hookFile)
          fs.mkdirSync(path.dirname(filePath), { recursive: true })
          // 提交点：兜底写入前确认锁还是自己的（R11-C）
          lock.assertOwned()
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
        // 失败路径同样要把被连带改动的其他 agent 文件还原（CLI 可能已经动过它们）；
        // 但如果我们已经失去锁，就不要再写别人的文件（R11-C）。
        reconcileCollateral(home, snapshot, guards, { fence: () => lock.assertOwned() })
        if (error instanceof RtkPlaneError) throw error
        throw structuredWriteError(error, spec, backup.dir)
      } finally {
        endRtkBackupUse(backup.id)
      }
    }
    try {
      const result = await runLocked()
      // 传活对象：release()/心跳在 finally 里对 lost/lostReason/renewFailures 的更新也要进响应
      return { ...result, lock: lock.info }
    } finally {
      lock.release()
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
  let lockInfo: RtkLockInfo | undefined

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
    lockInfo = result.lock
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
    lockWaitMs: lockInfo?.waitedMs ?? 0,
    ...(lockInfo?.disabled ? { lockDisabled: true } : {}),
    ...(lockInfo?.stolen ? { lockStolen: true } : {}),
    ...(lockInfo?.lost ? { lockLost: true } : {}),
    ...(lockInfo?.lostReason ? { lockLostReason: lockInfo.lostReason } : {}),
    ...(lockInfo?.renewFailures ? { lockRenewFailures: lockInfo.renewFailures } : {}),
    ...(lockInfo?.renewLastError ? { lockRenewLastError: lockInfo.renewLastError } : {}),
    ...(lockInfo ? { lock: lockInfo } : {}),
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
  // 与 toggle 用同一把进程内闸（此前 rollback 用的是另一把 key，和 toggle 并不互斥），再拿跨进程锁
  return withFileLock(`rtk-local-write:${home}`, async () => {
    const lock = await acquireRtkFileLock({ home, purpose: `rollback ${options.backup || 'latest'}` })
    try {
      // 提交点 fencing（R11-C）：回滚也是一次写入，锁被接管就不能再动文件
      lock.assertOwned()
      const { id, restored } = restoreRtkBackup(home, options.backup)
      const read = await readAuthoritativeRtk({ home, fresh: true, kernel: options.kernel, relay: options.relay })
      return {
        ...toStatusView(read, policy, home),
        ok: true as const, plane: 'local' as const, backupId: id, restored,
        lockWaitMs: lock.info.waitedMs,
        ...(lock.info.stolen ? { lockStolen: true } : {}),
        ...(lock.info.lost ? { lockLost: true } : {}),
        ...(lock.info.lostReason ? { lockLostReason: lock.info.lostReason } : {}),
        ...(lock.info.renewFailures ? { lockRenewFailures: lock.info.renewFailures } : {}),
        lock: lock.info,
      }
    } finally {
      lock.release()
    }
  })
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
      ...((error as RtkFencingPlaneError).lockLost ? { lockLost: true } : {}),
      ...((error as RtkFencingPlaneError).lockLostReason ? { lockLostReason: (error as RtkFencingPlaneError).lockLostReason } : {}),
    }
  }
  const message = error instanceof Error ? error.message : 'RTK 操作失败'
  return { status: 500, error: redact(message) }
}

export { probeLocalPlane }

/* ------------------------------------------------------------------ */
/* 全局开关（CONTRACTS C4）：在权威平面上批量套用逐 agent 开关          */
/* ------------------------------------------------------------------ */

export type RtkGlobalView = {
  /** true = 全部开；false = 全部关；null = 混合或没有可控 agent。 */
  on: boolean | null
  plane: RtkPlaneId | null
  agents: { supported: number; on: number }
  savings: { pct: number | null; tokens: number | null } | null
  writable: boolean
  reason: string | null
  /** 只在 reason=rtk_binary_missing 时给出：人工安装命令（控制台不代装本机 rtk）。 */
  installHint?: string
}

export type RtkGlobalResult = {
  /** 每个 agent 都写成功，且写后复核的 on 等于目标；任一不满足即 false。 */
  ok: boolean
  on: boolean | null
  plane: RtkPlaneId
  /** 写后复核实际读到的平面；与 plane 不同时 on=null、degraded 说明原因（不拿别的平面的状态冒充写入结果）。 */
  readPlane?: RtkPlaneId
  degraded?: 'verify_plane_unavailable'
  /** 写后复核仍不在目标状态的 agent（可能是被别的 agent 的 rtk CLI 连带改坏，或并发改动）。 */
  offTarget: string[]
  results: Array<{
    agent: string
    ok: boolean
    error: string | null
    reason?: string
    unchanged?: boolean
    /** 逐 agent 开关原样带回的备份与连带改动明细：未自动还原的文件需要人工确认，绝不吞掉。 */
    backupId?: string
    collateral?: RtkCollateralEntry[]
    collateralSkipped?: Array<{ agent: string; file: string; reason: string }>
  }>
}

/**
 * 全局开关只作用于「权威平面上可控的 agent」：远端平面取远端视图；本机平面只取已安装且支持全局钩子的
 * agent——给没装的工具建配置目录不是「打开 RTK」，而是凭空改用户的 HOME。
 */
function globalTargets(status: RTKStatusView): RtkAgentView[] {
  const agents = status.plane === 'local' ? status.localAgents : status.agents
  return agents.filter(agent => agent.supported && !agent.blocked && (status.plane !== 'local' || agent.installed))
}

function globalWriteBlocker(status: RTKStatusView, policy: RtkWritePolicy, supported: number): { status: number; reason: string; message: string } | null {
  if (!supported) return { status: 409, reason: 'no_supported_agents', message: '权威平面上没有可统一开关的 agent' }
  // RTK_WRITE_MODE=off 是「全只读」：先于任何平面的远端/内核开关判定。
  if (policy.mode === 'off') return { status: 403, reason: 'write_disabled', message: 'RTK_WRITE_MODE=off：RTK 写入已关闭' }
  if (status.plane === 'local') {
    if (!status.local.connected) return { status: 503, reason: 'rtk_binary_missing', message: `本机未安装 rtk：${RTK_INSTALL_HINT}` }
    return null
  }
  if (status.plane === 'kernel') {
    return policy.kernelWriteEnabled && policy.remoteWriteEnabled ? null
      : { status: 403, reason: 'kernel_write_disabled', message: '内核平面写入默认关闭（RTK_ALLOW_KERNEL_WRITE + RTK_ALLOW_REMOTE_WRITE）' }
  }
  return policy.remoteWriteEnabled ? null
    : { status: 403, reason: 'remote_write_disabled', message: '远端写入默认关闭，需显式设置 RTK_ALLOW_REMOTE_WRITE=1' }
}

export function rtkGlobalView(status: RTKStatusView, policy: RtkWritePolicy = readRtkWritePolicy()): RtkGlobalView {
  const targets = globalTargets(status)
  const onCount = targets.filter(agent => agent.on).length
  const blocker = globalWriteBlocker(status, policy, targets.length)
  return {
    on: !targets.length ? null : onCount === targets.length ? true : onCount === 0 ? false : null,
    plane: status.plane,
    agents: { supported: targets.length, on: onCount },
    savings: status.gain
      ? { pct: Number.isFinite(status.gain.pct) ? status.gain.pct : null, tokens: Number.isFinite(status.gain.saved) ? status.gain.saved : null }
      : null,
    writable: !blocker,
    reason: blocker?.reason ?? null,
    ...(blocker?.reason === 'rtk_binary_missing' ? { installHint: RTK_INSTALL_HINT } : {}),
  }
}

export async function readRTKGlobal(options: AuthoritativeReadOptions = {}): Promise<RtkGlobalView> {
  return rtkGlobalView(await readRTKStatus(options))
}

let globalApplying = false

/**
 * 逐个调用现有的 setRTKAgentHook（同一套写闸门、备份、复核与回滚），已是目标状态的 agent 不动。
 * 永远要求 confirm:true（即使 RTK_WRITE_MODE=local）：一次点击会改多个 agent 的配置。
 * 部分失败如实逐条返回，不回滚已成功的 agent——每个 agent 的写入本身是原子且可单独回退的。
 */
export async function setRTKGlobal(on: boolean, options: Omit<RtkToggleOptions, 'plane'> = {}): Promise<RtkGlobalResult> {
  if (options.confirm !== true) {
    throw new RtkPlaneError(403, 'local', 'confirmation_required', '全局开关会改动多个 agent 的配置，需要请求带 confirm:true')
  }
  if (globalApplying) throw new RtkPlaneError(409, 'local', 'global_apply_running', '全局开关正在应用中')
  globalApplying = true
  try {
    const home = options.home || resolveHome()
    const readOptions = { home, fresh: true, kernel: options.kernel, relay: options.relay }
    const status = await readRTKStatus(readOptions)
    const targets = globalTargets(status)
    const blocker = globalWriteBlocker(status, readRtkWritePolicy(), targets.length)
    if (blocker) throw new RtkPlaneError(blocker.status, status.plane, blocker.reason, blocker.message)
    const results: RtkGlobalResult['results'] = []
    for (const agent of targets) {
      if (agent.on === on) {
        results.push({ agent: agent.id, ok: true, error: null, unchanged: true })
        continue
      }
      try {
        const applied = await setRTKAgentHook(agent.id, on, { ...options, plane: status.plane, home, confirm: true })
        results.push({
          agent: agent.id,
          ok: true,
          error: null,
          ...(applied.backupId ? { backupId: applied.backupId } : {}),
          ...(applied.collateral?.length ? { collateral: applied.collateral } : {}),
          ...(applied.collateralSkipped?.length ? { collateralSkipped: applied.collateralSkipped } : {}),
        })
      } catch (error) {
        const failure = rtkFailure(error)
        results.push({ agent: agent.id, ok: false, error: failure.error, ...(failure.reason ? { reason: failure.reason } : {}) })
      }
    }
    const afterStatus = await readRTKStatus(readOptions)
    // 复核必须读写入的那个平面：权威读取回落到别的平面时，它的开关状态不能冒充写入结果。
    if (afterStatus.plane !== status.plane) {
      return { ok: false, on: null, plane: status.plane, readPlane: afterStatus.plane, degraded: 'verify_plane_unavailable', offTarget: [], results }
    }
    const after = rtkGlobalView(afterStatus)
    // 复核以写后的真实文件为准：别的 agent 的 CLI 可能把先写好的 agent 连带改坏（结果仍是 ok:true）
    const offTarget = globalTargets(afterStatus).filter(agent => agent.on !== on).map(agent => agent.id)
    return { ok: results.every(result => result.ok) && after.on === on, on: after.on, plane: status.plane, offTarget, results }
  } finally {
    globalApplying = false
  }
}
