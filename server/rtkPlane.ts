import { existsSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { config } from './config.js'

/**
 * RTK 控制面平面解析。
 *
 * 设计口径（2026-10-01，task-3）：
 * - 读取（status/gain/agents）优先走权威平面：内核 socket → 中转站管理面 → 本地实现。
 * - 任何回退都如实上报，`planes[]` 里逐平面给 `configured/state/reason`，
 *   区分「未配置」（not_configured）与「配置了但不可达/401」（unreachable/unauthorized）。
 * - 写操作的目标平面由请求显式指定，默认 local（只有本机才有用户的 agent 配置），
 *   远端（relay/kernel）写入默认只读，必须同时满足配置开关 + 请求级确认。
 */

export type RtkPlaneId = 'kernel' | 'relay' | 'local'

/** 可用 / 可用但降级（本机没装 rtk）/ 未配置 / 配置了但不可达 / 未授权 / 路由不存在。 */
export type RtkPlaneState = 'available' | 'degraded' | 'not_configured' | 'unreachable' | 'unauthorized' | 'not_supported'

export type RtkPlaneProbe = {
  id: RtkPlaneId
  available: boolean
  /** 该平面的地址/凭据是否配置齐全；与 available 组合可区分「没配」和「配了但连不上」。 */
  configured: boolean
  state: RtkPlaneState
  /** 机器可读原因码；available=false 时必有值。 */
  reason: string
  /** 人类可读补充，已脱敏，不含密钥。 */
  detail?: string
}

export type RtkAgentView = {
  id: string
  name: string
  icon: string
  on: boolean
  supported: boolean
  plane: RtkPlaneId
  /** agent 配置目录/文件是否存在于目标机器（本机平面才有意义）。 */
  installed?: boolean
  blocked?: string
}

export class RtkPlaneError extends Error {
  /** 写失败时给调用方留下备份目录，便于一键回退。 */
  backup?: string
  constructor(
    readonly status: number,
    readonly plane: RtkPlaneId,
    readonly reason: string,
    message?: string,
  ) {
    super(message || reason)
    this.name = 'RtkPlaneError'
  }
}

export const RTK_URL = 'https://www.rtk-ai.app'

/** 只在错误信息里回显远端文本时使用；绝不回显请求头。 */
export function redact(text: string): string {
  return String(text)
    .replace(/(bearer\s+)[^\s"',}]+/gi, '$1***')
    .replace(/((?:"|')?(?:api[-_]?key|token|secret|password)(?:"|')?\s*[:=]\s*)(?:"|')?[^\s"',}]+/gi, '$1***')
    .slice(0, 200)
}

/**
 * rtk 支持的 agent 注册表。
 *
 * 依据：本机 `rtk --version` = 0.50.0，`rtk init --help` 与临时 HOME 实测（见
 * docs/qa/blue/rtk-control-plane.md「证据」节）。`initFlags` 为 null 表示该 agent
 * 在 0.50.0 只能按项目初始化（`-g` 被拒绝，或即使带 `-g` 也写进当前工作目录），
 * 因此不能做全局开关 —— 这类 agent 一律 `supported:false`，绝不假装切成功。
 */
export type RtkAgentSpec = {
  id: string
  name: string
  icon: string
  /** `rtk init -g` 的目标参数；null = 不支持全局钩子。 */
  initFlags: string[] | null
  /** 该 agent 的配置目录（相对 HOME）。 */
  dir: string
  /** 相对 HOME 的 hook 文件；null = 只检测目录。 */
  hookFile: string | null
  /** hook 文件里出现即视为已挂载的标记串。 */
  marker: string
  /** 除 hook 文件外，rtk 还会改动的说明文件（写前一起备份）。 */
  extraFiles?: string[]
  /** 项目级作用域时的原因（supported=false）。 */
  scopeReason?: string
}

export const RTK_AGENT_SPECS: readonly RtkAgentSpec[] = [
  // `--auto-patch` 是必需的非交互开关：缺它时 claude/gemini/vibe 等会在非交互下
  // 「defaulting to N」——exit 0 但 hook 根本没写进 settings.json（"点了不生效"的机制级原因）。
  { id: 'codex', name: 'Codex CLI', icon: 'openai', initFlags: ['--codex'], dir: '.codex', hookFile: '.codex/hooks.json', marker: 'rtk hook codex', extraFiles: ['.codex/RTK.md', '.codex/AGENTS.md'] },
  { id: 'claude', name: 'Claude Code', icon: 'anthropic', initFlags: ['--agent', 'claude', '--auto-patch'], dir: '.claude', hookFile: '.claude/settings.json', marker: 'rtk hook claude', extraFiles: ['.claude/RTK.md', '.claude/CLAUDE.md'] },
  { id: 'cursor', name: 'Cursor', icon: 'cursor', initFlags: ['--agent', 'cursor', '--auto-patch'], dir: '.cursor', hookFile: '.cursor/hooks.json', marker: 'rtk hook cursor', extraFiles: ['.claude/RTK.md', '.claude/CLAUDE.md'] },
  // gemini 的「已挂载」以 settings.json 注册为准；只有 hooks/*.sh 说明脚本还不算接通。
  { id: 'gemini', name: 'Gemini CLI', icon: 'google', initFlags: ['--gemini', '--auto-patch'], dir: '.gemini', hookFile: '.gemini/settings.json', marker: 'rtk-hook-gemini', extraFiles: ['.gemini/GEMINI.md', '.gemini/hooks/rtk-hook-gemini.sh'] },
  { id: 'copilot', name: 'GitHub Copilot', icon: 'github', initFlags: ['--copilot', '--auto-patch'], dir: '.copilot', hookFile: '.copilot/hooks/rtk-rewrite.json', marker: 'rtk hook copilot', extraFiles: ['.copilot/copilot-instructions.md'] },
  { id: 'trae', name: 'Trae IDE', icon: 'code', initFlags: ['--agent', 'trae', '--auto-patch'], dir: '.trae', hookFile: '.trae/hooks.json', marker: 'rtk hook trae' },
  { id: 'droid', name: 'Factory Droid', icon: 'code', initFlags: ['--agent', 'droid', '--auto-patch'], dir: '.factory', hookFile: '.factory/hooks.json', marker: 'rtk hook droid' },
  { id: 'omp', name: 'Oh My Pi', icon: 'pi', initFlags: ['--agent', 'omp', '--auto-patch'], dir: '.omp', hookFile: '.omp/agent/extensions/rtk.ts', marker: '' },
  { id: 'pi', name: 'Pi coding agent', icon: 'pi', initFlags: ['--agent', 'pi', '--auto-patch'], dir: '.pi', hookFile: '.pi/agent/extensions/rtk.ts', marker: '' },
  { id: 'hermes', name: 'Hermes CLI', icon: 'code', initFlags: ['--agent', 'hermes', '--auto-patch'], dir: '.hermes', hookFile: '.hermes/plugins/rtk-rewrite/plugin.yaml', marker: '' },
  // vibe 的钩子写在 hooks.toml；只有 prompts/rtk.md 说明文件时不算接通。
  { id: 'vibe', name: 'Mistral Vibe CLI', icon: 'code', initFlags: ['--agent', 'vibe', '--auto-patch'], dir: '.vibe', hookFile: '.vibe/hooks.toml', marker: 'rtk hook vibe', extraFiles: ['.vibe/prompts/rtk.md'] },
  { id: 'windsurf', name: 'Windsurf', icon: 'code', initFlags: null, dir: '.windsurf', hookFile: null, marker: '', scopeReason: 'project_scoped_only' },
  { id: 'cline', name: 'Cline / Roo Code', icon: 'code', initFlags: null, dir: '.cline', hookFile: null, marker: '', scopeReason: 'project_scoped_only' },
  { id: 'kilocode', name: 'Kilo Code', icon: 'code', initFlags: null, dir: '.kilocode', hookFile: null, marker: '', scopeReason: 'project_scoped_only' },
  { id: 'antigravity', name: 'Google Antigravity', icon: 'google', initFlags: null, dir: '.antigravity', hookFile: null, marker: '', scopeReason: 'project_scoped_only' },
  { id: 'kimi', name: 'Kimi AI', icon: 'code', initFlags: null, dir: '.kimi', hookFile: null, marker: '', scopeReason: 'project_scoped_only' },
]

export const rtkAgentSpec = (id: string): RtkAgentSpec | undefined => RTK_AGENT_SPECS.find(spec => spec.id === id)

/* ------------------------------------------------------------------ */
/* 写入策略                                                            */
/* ------------------------------------------------------------------ */

export type RtkWriteMode = 'local' | 'confirm' | 'off'

export type RtkWritePolicy = {
  /** local: 本机 agent 钩子可直接写；confirm: 需要请求带 confirm:true；off: 全只读。 */
  mode: RtkWriteMode
  /** 远端（中转站/内核）写入总开关，默认关闭。 */
  remoteWriteEnabled: boolean
  /** 内核写入开关：内核跑在沙箱 HOME，写它不影响本机 agent 配置，默认关闭。 */
  kernelWriteEnabled: boolean
  /** 本机安装/升级二进制总开关，默认关闭（当前实现一律 501，开关仅为将来的显式授权预留）。 */
  installEnabled: boolean
  source: 'default' | 'env'
}

const truthy = (value: string | undefined): boolean => ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase())

export function readRtkWritePolicy(env: NodeJS.ProcessEnv = process.env): RtkWritePolicy {
  const raw = String(env.RTK_WRITE_MODE || '').trim().toLowerCase()
  const mode: RtkWriteMode = raw === 'off' || raw === 'confirm' || raw === 'local' ? raw : 'local'
  return {
    mode,
    remoteWriteEnabled: truthy(env.RTK_ALLOW_REMOTE_WRITE),
    kernelWriteEnabled: truthy(env.RTK_ALLOW_KERNEL_WRITE),
    installEnabled: truthy(env.RTK_ALLOW_INSTALL),
    source: raw ? 'env' : 'default',
  }
}

export function assertLocalWrite(confirm: boolean, policy: RtkWritePolicy = readRtkWritePolicy()): void {
  if (policy.mode === 'off') throw new RtkPlaneError(403, 'local', 'write_disabled', 'RTK_WRITE_MODE=off：本机写入已关闭')
  if (policy.mode === 'confirm' && !confirm) {
    throw new RtkPlaneError(403, 'local', 'confirmation_required', 'RTK_WRITE_MODE=confirm：需要请求带 confirm:true')
  }
}

export function assertRemoteWrite(confirm: boolean, plane: RtkPlaneId, policy: RtkWritePolicy = readRtkWritePolicy()): void {
  // off 是全只读：远端/内核开关打开了也不能写（与 assertLocalWrite 一致）。
  if (policy.mode === 'off') throw new RtkPlaneError(403, plane, 'write_disabled', 'RTK_WRITE_MODE=off：RTK 写入已关闭')
  if (!policy.remoteWriteEnabled) {
    throw new RtkPlaneError(403, plane, 'remote_write_disabled', '远端写入默认关闭，需显式设置 RTK_ALLOW_REMOTE_WRITE=1')
  }
  if (!confirm) {
    throw new RtkPlaneError(403, plane, 'confirmation_required', '远端写入需要请求带 confirm:true')
  }
}

/* ------------------------------------------------------------------ */
/* HTTP 探测                                                           */
/* ------------------------------------------------------------------ */

export type PlaneHttpResult = { status: number; json: unknown; raw: string }

const MAX_BODY = 256 * 1024

function parseJson(raw: string): unknown {
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/** 内核控制面走 unix socket；HTTP 错误状态原样返回，调用方自己判定平面状态。 */
export function kernelRtkRequest(
  socket: string,
  route: string,
  method: 'GET' | 'POST' = 'GET',
  body?: unknown,
  timeoutMs = 5000,
): Promise<PlaneHttpResult> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const req = httpRequest({
      socketPath: socket,
      path: route,
      method,
      timeout: timeoutMs,
      headers: {
        'content-type': 'application/json',
        ...(payload ? { 'content-length': Buffer.byteLength(payload) } : {}),
      },
    }, res => {
      const chunks: Buffer[] = []
      let bytes = 0
      res.on('data', chunk => {
        bytes += chunk.length
        if (bytes <= MAX_BODY) chunks.push(Buffer.from(chunk))
      })
      res.once('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        resolve({ status: res.statusCode || 0, json: parseJson(raw), raw: redact(raw) })
      })
      res.once('error', reject)
    })
    req.once('timeout', () => req.destroy(new Error('kernel_rtk_timeout')))
    req.once('error', reject)
    req.end(payload)
  })
}

/** 中转站管理面：POST/GET `${base}${path}`，Bearer 管理密钥。target 仅用于测试注入。 */
export async function relayRtkRequest(
  path: string,
  method: 'GET' | 'POST' = 'GET',
  body?: unknown,
  options: RelayTarget & { timeoutMs?: number } = {},
): Promise<PlaneHttpResult> {
  const base = String(options.baseUrl ?? config.magpieSourceCpaBaseUrl ?? '').replace(/\/+$/, '')
  const key = String(options.key ?? config.magpieSourceCpaKey ?? '')
  if (!base || !key) throw new RtkPlaneError(503, 'relay', 'relay_not_configured')
  const response = await fetch(`${base}${path}`, {
    method,
    signal: AbortSignal.timeout(options.timeoutMs ?? 5000),
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const raw = await response.text().catch(() => '')
  return { status: response.status, json: parseJson(raw), raw: redact(raw) }
}

export const RELAY_RTK_PATHS = {
  view: '/api/library/rtk',
  install: '/api/library/rtk/install',
  upgrade: '/api/library/rtk/upgrade',
} as const

/* ------------------------------------------------------------------ */
/* 逐平面探测                                                          */
/* ------------------------------------------------------------------ */

function transportReason(error: unknown): { state: RtkPlaneState; reason: string; detail: string } {
  const code = (error as { code?: string } | null)?.code
  const message = error instanceof Error ? error.message : String(error)
  if (code === 'ENOENT' || code === 'ECONNREFUSED' || code === 'ENOTSOCK') {
    return { state: 'unreachable', reason: 'socket_unreachable', detail: code }
  }
  if (message === 'kernel_rtk_timeout') return { state: 'unreachable', reason: 'timeout', detail: message }
  return { state: 'unreachable', reason: 'transport_error', detail: redact(message) }
}

/** 探测目标可注入，便于在临时 socket / 临时 HTTP 服务上验证而不碰生产配置。 */
export type KernelTarget = { socket?: string; engine?: string }
export type RelayTarget = { baseUrl?: string; key?: string }

/** 内核平面：仅 magpie 引擎 + socket 存在时才探测。 */
export async function probeKernelPlane(target: KernelTarget = {}): Promise<RtkPlaneProbe> {
  const base = { id: 'kernel' as const }
  const socket = target.socket ?? config.magpieKernelSocket
  const engine = target.engine ?? config.gatewayEngine
  if (engine !== 'magpie') {
    return { ...base, available: false, configured: false, state: 'not_configured', reason: 'gateway_engine_not_magpie' }
  }
  // scripts/magpie-console.mjs starts the kernel with a sandbox HOME: its RTK view has none of this host's agents
  // and each read runs rtk / agent CLIs inside the sandbox. Only an injected probe target or RTK_KERNEL_PLANE=1 uses it.
  if (target.socket === undefined && !config.rtkKernelPlane) {
    return {
      ...base, available: false, configured: false, state: 'not_configured', reason: 'kernel_rtk_sandboxed',
      detail: '内核运行在隔离 HOME，RTK 以本机为准（设置 RTK_KERNEL_PLANE=1 改用内核）',
    }
  }
  if (!socket || !existsSync(socket)) {
    return { ...base, available: false, configured: false, state: 'not_configured', reason: 'kernel_socket_missing' }
  }
  try {
    const result = await kernelRtkRequest(socket, '/internal/rtk')
    if (result.status === 200 && result.json && typeof result.json === 'object') {
      return { ...base, available: true, configured: true, state: 'available', reason: 'kernel_rtk_ok' }
    }
    if (result.status === 400 || result.status === 404 || result.status === 405) {
      // 运行中的内核没有 overlay 的 /internal/rtk 缝，请求落到推理 handler 的兜底分支。
      return {
        ...base, available: false, configured: true, state: 'not_supported',
        reason: 'kernel_rtk_seam_missing',
        detail: `HTTP ${result.status}: 内核运行时未包含 /internal/rtk（可能为旧构建），需要重新构建内核`,
      }
    }
    return { ...base, available: false, configured: true, state: 'unreachable', reason: `kernel_http_${result.status}`, detail: result.raw }
  } catch (error) {
    return { ...base, available: false, configured: true, ...transportReason(error) }
  }
}

/** 中转站平面：管理面地址与密钥齐备才探测；401/403 与 404 分开上报。 */
export async function probeRelayPlane(target: RelayTarget = {}): Promise<RtkPlaneProbe> {
  const base = { id: 'relay' as const }
  const baseUrl = String(target.baseUrl ?? config.magpieSourceCpaBaseUrl ?? '')
  const key = String(target.key ?? config.magpieSourceCpaKey ?? '')
  const configured = Boolean(baseUrl) && Boolean(key)
  if (!configured) {
    return {
      ...base, available: false, configured: false, state: 'not_configured',
      reason: baseUrl ? 'relay_credential_missing' : 'relay_base_url_missing',
    }
  }
  try {
    const result = await relayRtkRequest(RELAY_RTK_PATHS.view, 'GET', undefined, target)
    if (result.status === 200 && result.json && typeof result.json === 'object') {
      return { ...base, available: true, configured: true, state: 'available', reason: 'relay_rtk_ok' }
    }
    if (result.status === 401 || result.status === 403) {
      return { ...base, available: false, configured: true, state: 'unauthorized', reason: `relay_http_${result.status}`, detail: '管理密钥被中转站拒绝' }
    }
    if (result.status === 404) {
      return { ...base, available: false, configured: true, state: 'not_supported', reason: 'relay_route_missing', detail: '中转站未暴露 /api/library/rtk（当前指向的可能是 CPA 主机）' }
    }
    return { ...base, available: false, configured: true, state: 'unreachable', reason: `relay_http_${result.status}`, detail: result.raw }
  } catch (error) {
    if (error instanceof RtkPlaneError) {
      return { ...base, available: false, configured: false, state: 'not_configured', reason: error.reason }
    }
    const message = error instanceof Error ? error.message : String(error)
    return { ...base, available: false, configured: true, state: 'unreachable', reason: 'relay_unreachable', detail: redact(message) }
  }
}

/**
 * RTK_BIN 一旦显式设置就以它为准：指向不存在的路径时返回 null，不再静默改用别的候选。
 * 放在 rtkPlane 里是因为平面探测需要它，而 rtkService 依赖 rtkPlane（反向会成环）。
 */
export function findRTKBinary(env: NodeJS.ProcessEnv = process.env): string | null {
  const custom = env.RTK_BIN
  if (custom) return existsSync(custom) ? custom : null

  const candidates = [
    join(homedir(), '.local/bin/rtk'),
    join(homedir(), '.cargo/bin/rtk'),
    '/usr/local/bin/rtk',
    '/opt/homebrew/bin/rtk',
  ]
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate
    } catch {
      // ignore
    }
  }
  return null
}

/**
 * 本机平面：控制台所在机器永远可达（本机实现就是回退面），但 rtk 未安装时必须如实降级，
 * 否则会出现「connected:false / path:null」与「本机 rtk 已安装」自相矛盾的响应。
 */
export function probeLocalPlane(binFound: boolean = findRTKBinary() !== null): RtkPlaneProbe {
  return {
    id: 'local',
    available: true,
    configured: true,
    state: binFound ? 'available' : 'degraded',
    reason: binFound ? 'local_host' : 'local_rtk_missing',
    detail: binFound
      ? '本机 rtk 可用'
      : '本机未安装 rtk：仍可读写 agent 配置，但无法执行 rtk CLI（安装后重试）',
  }
}

export type RtkPlaneResolution = {
  /** 权威读取平面：kernel → relay → local，第一个可用的。 */
  plane: RtkPlaneId
  planes: RtkPlaneProbe[]
  /** 是否有平面发生回退（用于 UI 如实提示）。 */
  fellBack: boolean
}

/** 探测有网络成本，且 /api/version 也会走这条链；30s 内复用结果。 */
const PLANE_CACHE_TTL_MS = 30_000
let planeCache: { at: number; value: RtkPlaneResolution } | null = null

export function resetRtkPlaneCache(): void {
  planeCache = null
}

export type RtkPlaneOptions = {
  fresh?: boolean
  kernel?: KernelTarget
  relay?: RelayTarget
  /** 仅测试/调用方已知 rtk 是否安装时注入，避免再次探测。 */
  localBinFound?: boolean
}

export async function resolveRtkPlane(options: RtkPlaneOptions = {}): Promise<RtkPlaneResolution> {
  // 显式注入了探测目标（测试 / 诊断）时不读也不写缓存，避免缓存串味。
  const injectable = Boolean(options.kernel || options.relay)
  if (!injectable && !options.fresh && planeCache && Date.now() - planeCache.at < PLANE_CACHE_TTL_MS) return planeCache.value
  // 内核优先但必须真的应答；任何失败都降级并保留原因，不假装成功。
  const [kernel, relay] = await Promise.all([probeKernelPlane(options.kernel), probeRelayPlane(options.relay)])
  const planes: RtkPlaneProbe[] = [kernel, relay, probeLocalPlane(options.localBinFound ?? findRTKBinary() !== null)]
  const authoritative = planes.find(probe => probe.available) || planes[planes.length - 1]
  const value: RtkPlaneResolution = { plane: authoritative.id, planes, fellBack: authoritative.id !== 'kernel' }
  if (!injectable) planeCache = { at: Date.now(), value }
  return value
}

/* ------------------------------------------------------------------ */
/* 响应归一化                                                          */
/* ------------------------------------------------------------------ */

export type RtkGain = { commands: number; input: number; saved: number; pct: number }
export type RtkDay = { date: string; commands: number; input: number; saved: number; pct: number }

export type RtkPlanePayload = {
  connected: boolean
  path: string | null
  version: string | null
  gain: RtkGain | null
  days: RtkDay[]
  latest: string | null
  install?: string
  url: string
  agents: RtkAgentView[]
}

const record = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {})
const num = (value: unknown): number => (Number.isFinite(Number(value)) ? Number(value) : 0)
const str = (value: unknown): string => (typeof value === 'string' ? value : '')

/**
 * 把内核/中转站的 `library.RTKView`（deploy/magpie/upstream/api.json）映射成契约形状。
 * 远端 agent 由远端自己决定机制，因此 `supported` 对远端平面默认为 true。
 */
export function normalizePlanePayload(payload: unknown, plane: RtkPlaneId): RtkPlanePayload {
  const view = record(payload)
  const gainRaw = record(view.gain)
  const gain: RtkGain | null = view.gain && typeof view.gain === 'object'
    ? { commands: num(gainRaw.commands), input: num(gainRaw.input), saved: num(gainRaw.saved), pct: num(gainRaw.pct) }
    : null
  const days: RtkDay[] = Array.isArray(view.days)
    ? view.days.map(item => {
      const day = record(item)
      return { date: str(day.date), commands: num(day.commands), input: num(day.input), saved: num(day.saved), pct: num(day.pct) }
    }).filter(day => Boolean(day.date)).sort((a, b) => a.date.localeCompare(b.date))
    : []
  const agents = Array.isArray(view.agents)
    ? view.agents.map(item => {
      const agent = record(item)
      const id = str(agent.id)
      const spec = rtkAgentSpec(id)
      return {
        id,
        name: str(agent.name) || spec?.name || id,
        icon: str(agent.icon) || spec?.icon || 'code',
        on: Boolean(agent.on),
        supported: plane === 'local' ? Boolean(spec?.initFlags) : true,
        plane,
        ...(typeof agent.blocked === 'string' && agent.blocked ? { blocked: agent.blocked } : {}),
      }
    }).filter(agent => Boolean(agent.id))
    : []
  return {
    connected: plane !== 'local' ? true : Boolean(view.connected),
    path: typeof view.path === 'string' && view.path ? view.path : null,
    version: typeof view.version === 'string' && view.version ? view.version : null,
    gain,
    days,
    latest: typeof view.latest === 'string' && view.latest ? view.latest : null,
    install: typeof view.install === 'string' && view.install ? view.install : undefined,
    url: typeof view.url === 'string' && view.url ? view.url : RTK_URL,
    agents,
  }
}
