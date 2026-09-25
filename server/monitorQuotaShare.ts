import { providerAliases } from './liveStream.js'
import type { ReadOperation } from './sqliteReadWorker.js'

/**
 * 账号监控页的「本窗口各 Key 消耗占比」。
 *
 * 上游套餐额度（Codex 周窗口、Claude 5h/7d、AGY 各 bucket）不按美元计量，而且
 * 缓存读也会明显消耗额度；单看每个 Key 的美元花费会让人误以为「没人在用」。
 * 这里只按 token 体量算相对占比：promptTokens = input + cached + cache_write，
 * 分母是所有 Key 的 promptTokens + outputTokens 之和，回答「是谁把额度用掉了」。
 */
export const QUOTA_SHARE_PROVIDERS = ['codex', 'claude', 'antigravity'] as const
export type QuotaShareProvider = (typeof QUOTA_SHARE_PROVIDERS)[number]

export type QuotaShareKey = {
  /** api_keys.key_hash；未关联 Key 的请求为空字符串。 */
  keyId: string
  keyName: string
  requests: number
  promptTokens: number
  outputTokens: number
  /** 占本窗口全部 Key（promptTokens + outputTokens）的比例，0–1。 */
  share: number
}

export type QuotaShareWindow = {
  /** 窗口起点（epoch ms），由上游额度的重置时间反推；拿不到时取最近 7 天。 */
  windowStart: number
  keys: QuotaShareKey[]
}

export type MonitorQuotaShare = Record<QuotaShareProvider, QuotaShareWindow>

type Reader = {
  run(operations: readonly ReadOperation[]): Promise<unknown[]>
  runParallel?(operations: readonly ReadOperation[]): Promise<unknown[]>
}

type QuotaShareRow = {
  keyId?: string | null
  keyName?: string | null
  requests?: number
  promptTokens?: number
  outputTokens?: number
}

const DAY_MS = 86_400_000
export const WEEK_MS = 7 * DAY_MS

const parseTime = (value: unknown): number | null => {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null
  if (typeof value !== 'string' || !value.trim()) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

const asRecord = (value: unknown): Record<string, any> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : null

/** Codex：rate_limit.primary_window.reset_at（unix 秒）减去 limit_window_seconds。 */
export function codexWindowStart(quota: unknown): number | null {
  const window = asRecord(asRecord(asRecord(quota)?.rate_limit)?.primary_window)
  if (!window) return null
  const resetAt = Number(window.reset_at)
  const seconds = Number(window.limit_window_seconds)
  if (!Number.isFinite(resetAt) || resetAt <= 0 || !Number.isFinite(seconds) || seconds <= 0) return null
  return resetAt * 1000 - seconds * 1000
}

/** Claude：usage.seven_day.resets_at 往前推 7 天；新结构则找 limits[] 里的 weekly_all。 */
export function claudeWindowStart(quota: unknown): number | null {
  const usage = asRecord(asRecord(quota)?.usage)
  if (!usage) return null
  const legacy = parseTime(asRecord(usage.seven_day)?.resets_at)
  if (legacy !== null) return legacy - WEEK_MS
  const limits = Array.isArray(usage.limits) ? usage.limits : []
  const weekly = limits
    .map((limit: unknown) => asRecord(limit))
    .find((limit: Record<string, any> | null) => limit && String(limit.kind || '') === 'weekly_all')
  const resetsAt = parseTime(weekly?.resets_at)
  return resetsAt === null ? null : resetsAt - WEEK_MS
}

/** AGY：groups[].buckets[] 里 bucketId 为 gemini-weekly 的 resetTime 往前推 7 天；多个时取最早。 */
export function antigravityWindowStart(quota: unknown): number | null {
  const groups = asRecord(quota)?.groups
  if (!Array.isArray(groups)) return null
  const resets: Array<{ preferred: boolean; at: number }> = []
  for (const group of groups) {
    const buckets = asRecord(group)?.buckets
    if (!Array.isArray(buckets)) continue
    for (const bucket of buckets) {
      const entry = asRecord(bucket)
      if (!entry) continue
      const id = String(entry.bucketId || entry.bucket_id || '').toLowerCase()
      const window = String(entry.window || '').toLowerCase()
      if (!/weekly/.test(id) && !/week/.test(window)) continue
      const at = parseTime(entry.resetTime ?? entry.reset_time)
      if (at === null) continue
      resets.push({ preferred: id === 'gemini-weekly', at })
    }
  }
  if (!resets.length) return null
  const pool = resets.some((item) => item.preferred) ? resets.filter((item) => item.preferred) : resets
  return Math.min(...pool.map((item) => item.at)) - WEEK_MS
}

const WINDOW_START_BY_PROVIDER: Record<QuotaShareProvider, (quota: unknown) => number | null> = {
  codex: codexWindowStart,
  claude: claudeWindowStart,
  antigravity: antigravityWindowStart,
}

/**
 * 同一 provider 可能有多个账号，各自的窗口起点不同；取最早的那个，
 * 让占比覆盖所有账号的消耗，不会把某个账号的早期请求漏掉。
 */
export function quotaWindowStart(provider: string, quotas: unknown[], now = Date.now()): number {
  const resolve = WINDOW_START_BY_PROVIDER[provider as QuotaShareProvider]
  const starts = resolve ? quotas.map(resolve).filter((value): value is number => value !== null) : []
  const fallback = now - WEEK_MS
  if (!starts.length) return fallback
  return Math.min(Math.min(...starts), now)
}

export function quotaShareOperation(provider: string, windowStartMs: number, tableName = 'usage_events'): ReadOperation {
  const aliases = providerAliases(provider)
  const isRollup = tableName === 'usage_hourly_rollup'
  const timeCol = isRollup ? 'u.hour_ms' : 'u.timestamp_ms'
  const countExpr = isRollup ? 'SUM(u.request_count)' : 'COUNT(*)'
  const providerSql = aliases.length ? `lower(trim(u.provider)) IN (${aliases.map(() => '?').join(', ')})` : '0 = 1'
  return {
    method: 'all',
    sql: `
      SELECT u.key_hash keyId, a.name keyName, ${countExpr} requests,
        COALESCE(SUM(u.input_tokens + u.cached_tokens + u.cache_write_tokens), 0) promptTokens,
        COALESCE(SUM(u.output_tokens), 0) outputTokens
      FROM ${tableName} u LEFT JOIN api_keys a ON a.key_hash = u.key_hash
      WHERE u.success = 1 AND ${timeCol} >= ? AND ${providerSql}
      GROUP BY u.key_hash
    `,
    params: [Math.floor(windowStartMs), ...aliases],
  }
}

export function buildQuotaShare(rows: readonly QuotaShareRow[]): QuotaShareKey[] {
  const items = rows.map((row) => {
    const keyId = String(row.keyId || '')
    const promptTokens = Number(row.promptTokens) || 0
    const outputTokens = Number(row.outputTokens) || 0
    return {
      keyId,
      keyName: String(row.keyName || '') || (keyId ? `已删除 Key ${keyId.slice(0, 8)}` : '未关联 Key'),
      requests: Number(row.requests) || 0,
      promptTokens,
      outputTokens,
      share: 0,
    }
  })
  const total = items.reduce((sum, item) => sum + item.promptTokens + item.outputTokens, 0)
  return items
    .map((item) => ({ ...item, share: total > 0 ? (item.promptTokens + item.outputTokens) / total : 0 }))
    .sort((left, right) => right.share - left.share || right.requests - left.requests || left.keyName.localeCompare(right.keyName, 'zh-CN'))
}

/** 单个 provider 的占比；窗口起点由调用方按账号额度算好。 */
export async function loadQuotaShare(reader: Reader, provider: string, windowStartMs: number, tableName = 'usage_events'): Promise<QuotaShareWindow> {
  const [rows] = await reader.run([quotaShareOperation(provider, windowStartMs, tableName)])
  return { windowStart: Math.floor(windowStartMs), keys: buildQuotaShare((rows as QuotaShareRow[]) || []) }
}

type MonitoredAccount = { type?: unknown; quota?: unknown }

/** 三个 provider 一次并行查完，供 /api/monitor 附带返回。 */
export async function loadMonitorQuotaShare(reader: Reader, accounts: readonly MonitoredAccount[], now = Date.now(), tableName = 'usage_events'): Promise<MonitorQuotaShare> {
  const windowStarts = QUOTA_SHARE_PROVIDERS.map((provider) => quotaWindowStart(
    provider,
    accounts.filter((account) => String(account.type) === provider).map((account) => account.quota),
    now,
  ))
  const operations = QUOTA_SHARE_PROVIDERS.map((provider, index) => quotaShareOperation(provider, windowStarts[index], tableName))
  const values = await (reader.runParallel?.(operations) ?? reader.run(operations))
  return Object.fromEntries(QUOTA_SHARE_PROVIDERS.map((provider, index) => [provider, {
    windowStart: Math.floor(windowStarts[index]),
    keys: buildQuotaShare((values[index] as QuotaShareRow[]) || []),
  }])) as MonitorQuotaShare
}
