import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/**
 * 重启 CPA / 控制台：控制台自己没有重启权限（unit 带沙箱），只把请求写成文件，
 * 由 root 的 crosery-service-restart.path 触发 scripts/service-restart.mjs 执行；结果写回 service-restart-status.json。
 */
export const RESTART_TARGETS = {
  cpa: { unit: 'cli-proxy-api.service', label: 'CPA 网关' },
  console: { unit: 'crosery-api-console.service', label: '控制台' },
} as const
export type RestartTarget = keyof typeof RESTART_TARGETS

export const isRestartTarget = (value: unknown): value is RestartTarget =>
  typeof value === 'string' && Object.prototype.hasOwnProperty.call(RESTART_TARGETS, value)

export type RestartStatus = {
  target: RestartTarget
  requestedAt: string
  finishedAt?: string
  result?: 'ok' | 'failed'
  message?: string
}

const requestDir = (dataDir: string) => path.join(dataDir, 'service-requests')
const statusFile = (dataDir: string) => path.join(dataDir, 'service-restart-status.json')

export function requestRestart(dataDir: string, target: RestartTarget, now = Date.now()): RestartStatus {
  const dir = requestDir(dataDir)
  // 同一目标已有未处理的请求就不再排第二个：连点不会连重启
  if (fs.existsSync(path.join(dir, `${target}.json`))) return pendingStatus(dataDir, target) ?? { target, requestedAt: new Date(now).toISOString() }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const requestedAt = new Date(now).toISOString()
  const file = path.join(dir, `${target}.json`)
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify({ target, requestedAt })}\n`, { flag: 'wx', mode: 0o600 })
  try { fs.renameSync(tmp, file) } finally { fs.rmSync(tmp, { force: true }) }
  return { target, requestedAt }
}

function pendingStatus(dataDir: string, target: RestartTarget): RestartStatus | null {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(requestDir(dataDir), `${target}.json`), 'utf8'))
    return typeof value?.requestedAt === 'string' ? { target, requestedAt: value.requestedAt } : null
  } catch { return null }
}

/** 每个目标最近一次的状态：有未处理的请求就是「排队中」，否则是执行器写回的结果。 */
export function readRestartStatus(dataDir: string): Partial<Record<RestartTarget, RestartStatus & { pending: boolean }>> {
  let results: Record<string, RestartStatus> = {}
  try {
    const parsed = JSON.parse(fs.readFileSync(statusFile(dataDir), 'utf8'))
    if (parsed && typeof parsed === 'object') results = parsed
  } catch { /* 还没重启过 */ }
  const out: Partial<Record<RestartTarget, RestartStatus & { pending: boolean }>> = {}
  for (const target of Object.keys(RESTART_TARGETS) as RestartTarget[]) {
    const pending = pendingStatus(dataDir, target)
    if (pending) out[target] = { ...pending, pending: true }
    else if (results[target]) out[target] = { ...results[target], pending: false }
  }
  return out
}
