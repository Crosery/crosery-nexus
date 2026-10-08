/**
 * 系统 Key = 控制台自己持有、从不发放的网关 Key：封锁 Key（api-keys 永不为空），
 * 以及每个服务一把的可用性探测 Key（钉在 CPA api-key-channel-access 的该服务上）。
 *
 * 落盘契约（其它包和服务外的脚本也读）：`DATA_DIR/system-keys.json`，0600，先写临时文件再改名，纯 JSON：
 *   { "version": 1, "lockout": "sk-lockout-<64 hex>", "probes": { "<service>": "sk-probe-<service>-<64 hex>" } }
 * `<service>` 是 CPA 渠道白名单用的规范渠道名（小写、去掉 openai-compatible- 前缀），例如 claude、codex、openrouter。
 *
 * 本模块只依赖 node 内置模块、只用可擦除的 TS 语法：Node 24 可以直接 import 这个 .ts 文件。
 */
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export type SystemKeys = { version: 1; lockout: string | null; probes: Record<string, string> }

export const SYSTEM_KEYS_FILE = 'system-keys.json'
/** 旧版只有封锁 Key 时的单独文件；首次读取时迁进 system-keys.json，旧文件原样留着。 */
const LEGACY_LOCKOUT_FILE = 'cpa-lockout-key'

export const LOCKOUT_KEY_PATTERN = /^sk-lockout-[0-9a-f]{64}$/
export const PROBE_KEY_PATTERN = /^sk-probe-[a-z0-9][a-z0-9._-]*-[0-9a-f]{64}$/

/**
 * 按格式识别：数据目录丢失后网关里残留的旧系统 Key 也不会被当成用户 Key 导入。
 * 控制台发放的 Key 随机段是 32 位十六进制（keyNaming.ts 的 buildNamedAPIKey），撞不上 64 位的格式。
 */
export const isSystemKey = (key: unknown): boolean =>
  typeof key === 'string' && (LOCKOUT_KEY_PATTERN.test(key) || PROBE_KEY_PATTERN.test(key))

/** 文本里出现的系统 Key 一律打码（探测错误原文、上游回显等进日志或状态文件之前）。 */
export const maskSystemKeys = (text: string) => text.replace(/sk-(lockout|probe)-[A-Za-z0-9._-]{8,}/g, 'sk-$1-***')

/** 与 CPA 的 CanonicalChannelName 同一规则。 */
export function canonicalChannelName(name: string): string {
  const value = String(name ?? '').trim().toLowerCase()
  return value.startsWith('openai-compatible-') ? value.slice('openai-compatible-'.length) : value
}

/** Key 里的服务段只留安全字符；服务本身以 probes 的键为准，不从 Key 反推。 */
const keySegment = (service: string) => service.replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+/, '') || 'service'

const object = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null

/** 宽松解析：格式不对的条目丢掉，整体不认识就当空表。 */
export function parseSystemKeys(raw: unknown): SystemKeys {
  const input = object(raw)
  const lockout = typeof input?.lockout === 'string' && LOCKOUT_KEY_PATTERN.test(input.lockout) ? input.lockout : null
  const probes: Record<string, string> = {}
  for (const [service, key] of Object.entries(object(input?.probes) || {})) {
    if (service && typeof key === 'string' && PROBE_KEY_PATTERN.test(key)) probes[service] = key
  }
  return { version: 1, lockout, probes }
}

function readLegacyLockout(dataDir: string): string | null {
  try {
    const value = fs.readFileSync(path.join(dataDir, LEGACY_LOCKOUT_FILE), 'utf8').trim()
    return LOCKOUT_KEY_PATTERN.test(value) ? value : null
  } catch {
    return null
  }
}

function writeSystemKeys(dataDir: string, keys: SystemKeys) {
  fs.mkdirSync(dataDir, { recursive: true })
  const file = path.join(dataDir, SYSTEM_KEYS_FILE)
  const temporary = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify({ version: 1, lockout: keys.lockout, probes: keys.probes }, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(temporary, file)
}

/**
 * 读系统 Key。新文件里没有封锁 Key 而旧的 cpa-lockout-key 有时，沿用旧值并写进新文件（同一把，不换）；
 * 迁移写入失败（例如只读环境里的脚本）不影响返回值。
 */
export function readSystemKeys(dataDir: string): SystemKeys {
  let keys: SystemKeys
  try {
    keys = parseSystemKeys(JSON.parse(fs.readFileSync(path.join(dataDir, SYSTEM_KEYS_FILE), 'utf8')))
  } catch {
    keys = parseSystemKeys(null)
  }
  if (!keys.lockout) {
    const legacy = readLegacyLockout(dataDir)
    if (legacy) {
      keys = { ...keys, lockout: legacy }
      try { writeSystemKeys(dataDir, keys) } catch { /* 下次读取再迁 */ }
    }
  }
  return keys
}

const newLockout = () => `sk-lockout-${randomBytes(32).toString('hex')}`

/** 封锁 Key：有就复用（含旧文件迁移），没有才生成并落盘。 */
export function ensureLockoutKey(dataDir: string): string {
  const keys = readSystemKeys(dataDir)
  if (keys.lockout) return keys.lockout
  const lockout = newLockout()
  writeSystemKeys(dataDir, { ...keys, lockout })
  return lockout
}

/**
 * 每个服务一把探测 Key，首次使用时生成并落盘；返回「调用方给的服务名 → Key」，
 * 文件里按规范渠道名存，大小写或前缀不同的同一渠道共用一把。写文件时顺带补齐封锁 Key，文件始终符合契约。
 */
export function ensureProbeKeys(dataDir: string, services: string[]): Record<string, string> {
  const keys = readSystemKeys(dataDir)
  const probes = { ...keys.probes }
  let created = false
  for (const service of services) {
    const canonical = canonicalChannelName(service)
    if (!canonical || probes[canonical]) continue
    probes[canonical] = `sk-probe-${keySegment(canonical)}-${randomBytes(32).toString('hex')}`
    created = true
  }
  if (created) writeSystemKeys(dataDir, { version: 1, lockout: keys.lockout || newLockout(), probes })
  return Object.fromEntries(services.filter((service) => probes[canonicalChannelName(service)]).map((service) => [service, probes[canonicalChannelName(service)]]))
}
