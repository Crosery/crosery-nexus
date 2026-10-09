import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * RTK 控制面平面：只有本机（控制台所在机器的 rtk 与 agent 配置）。
 * `planes[]` 如实给出它的 `configured/state/reason`，区分「可用」与「本机没装 rtk」（degraded）。
 */

export type RtkPlaneId = 'local'

/** 可用 / 可用但降级（本机没装 rtk）。 */
export type RtkPlaneState = 'available' | 'degraded'

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
  /** agent 配置目录/文件是否存在于本机。 */
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

/* ------------------------------------------------------------------ */
/* 平面探测                                                            */
/* ------------------------------------------------------------------ */

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
 * 本机平面：控制台所在机器永远可达，但 rtk 未安装时必须如实降级，
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
  plane: RtkPlaneId
  planes: RtkPlaneProbe[]
  /** 恒为 false（只有本机平面），保留给读这个字段的客户端。 */
  fellBack: boolean
}

/** `localBinFound`：调用方已知 rtk 是否安装时注入，避免再次探测。 */
export function resolveRtkPlane(options: { localBinFound?: boolean } = {}): RtkPlaneResolution {
  return { plane: 'local', planes: [probeLocalPlane(options.localBinFound ?? findRTKBinary() !== null)], fellBack: false }
}

/* ------------------------------------------------------------------ */
/* 读取结果                                                            */
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
