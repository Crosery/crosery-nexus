/**
 * Helpers shared by the scheduled updaters (CPA kernel applier, RTK, and the retired Magpie scripts that re-export them).
 * No I/O here except hostEnv (one small file read): everything takes its inputs, so each updater stays testable with an
 * injected clock.
 */
import { readFileSync } from 'node:fs'

const BACKOFF_BASE_MS = 30 * 60_000
const BACKOFF_MAX_MS = 6 * 60 * 60_000
const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS

/** 被 GitHub 限流时它自己说的等待时间：Retry-After（秒数或 HTTP 日期），或配额耗尽时的 x-ratelimit-reset。 */
export function rateLimitDelay(headers, now = Date.now()) {
  const retryAfter = String(headers.get('retry-after') || '').trim()
  if (/^\d+$/.test(retryAfter)) return Number(retryAfter) * 1000
  if (retryAfter) {
    const at = Date.parse(retryAfter)
    if (Number.isFinite(at)) return Math.max(0, at - now)
  }
  if (headers.get('x-ratelimit-remaining') === '0') {
    const reset = Number(headers.get('x-ratelimit-reset'))
    if (Number.isFinite(reset) && reset > 0) return Math.max(0, reset * 1000 - now)
  }
  return null
}

/** 连续失败的退避：第一次失败照常等下一轮，之后 30 分钟起翻倍到 6 小时；上游给的等待时间是下限。 */
export function nextAttemptDelay(failures, retryAfterMs = null) {
  const exponential = failures <= 1 ? 0 : Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (failures - 2))
  return Math.max(retryAfterMs ?? 0, exponential)
}

/** Numeric dotted-version compare; `v` prefix and pre-release tails ignored. */
export function compareVersions(left, right) {
  const parts = value => String(value).replace(/^v/i, '').split(/[.+-]/).slice(0, 3).map(part => Number.parseInt(part, 10) || 0)
  const [a, b] = [parts(left), parts(right)]
  for (let index = 0; index < 3; index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0)
    if (diff) return diff
  }
  return 0
}

/**
 * Which half of the promotion pipeline this host is (`/etc/crosery/autoupdate.env` → AUTOUPDATE_ROLE).
 * Anything but an explicit `preview` is production: a host that forgot its env file must demand the promotion record,
 * never install the newest build straight away.
 */
export function updateRole(env = process.env) {
  return env.AUTOUPDATE_ROLE === 'preview' ? 'preview' : 'production'
}

/**
 * How long a candidate must run on preview, and how old its preview record may be when production installs it.
 * AUTOUPDATE_SOAK_HOURS (≥ 1, default 24) · AUTOUPDATE_RECORD_MAX_AGE_DAYS (1–30, default 7).
 */
export function promotionPolicy(env = process.env) {
  const number = (value, min, max, fallback) => {
    const parsed = Number(value)
    return value !== undefined && value !== '' && Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : fallback
  }
  return {
    soakMs: number(env.AUTOUPDATE_SOAK_HOURS, 1, 24 * 30, 24) * HOUR_MS,
    maxAgeMs: number(env.AUTOUPDATE_RECORD_MAX_AGE_DAYS, 1, 30, 7) * DAY_MS,
  }
}

export const HOST_ENV_FILE = '/etc/crosery/autoupdate.env'

/**
 * The units load /etc/crosery/autoupdate.env (EnvironmentFile=); run by hand from a root shell it is not loaded. Without
 * AUTOUPDATE_ROLE in the environment, read the file the same way: KEY=VALUE lines, `#`/`;` comments, optional quotes.
 * Variables already set win. No file → the environment as it is (no role = production, the strict default).
 */
export function hostEnv(env = process.env, file = env.AUTOUPDATE_ENV_FILE || HOST_ENV_FILE) {
  if (env.AUTOUPDATE_ROLE) return env
  let text
  try { text = readFileSync(file, 'utf8') } catch { return env }
  const out = { ...env }
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*[#;]/.test(line)) continue
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line)
    if (!match) continue
    const value = /^(["'])(.*)\1$/.exec(match[2])?.[2] ?? match[2]
    if (out[match[1]] === undefined) out[match[1]] = value
  }
  return out
}
