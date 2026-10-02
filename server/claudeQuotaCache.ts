import { apiCallRetryAfterMs, combineCooldown, PROVIDER_RETRY_AFTER_CAP_MS, sanitizePersistedCooldowns, type PersistedCooldown } from './accountQuota.js'
import type { ApiCallResult } from './cpa.js'

export type ClaudeQuotaEndpoint = 'usage' | 'profile'

type CacheEntry = {
  body: unknown
  fetchedAt: number
  blockedUntil: number
  failures: number
  /** 冷却来源：上游自己限流（429）还是 CPA 的账号级提示；决定面板文案 */
  blockedBy: 'rate-limit' | 'cpa-hint' | ''
}

type AccountCache = {
  usage?: CacheEntry
  profile?: CacheEntry
}

export type ClaudeQuotaSnapshot = {
  usage: unknown | null
  profile: unknown | null
  usageError: string | null
  profileError: string | null
  usageBlockedUntil: number | null
  profileBlockedUntil: number | null
}

export type ClaudeQuotaCacheOptions = {
  usageTtlMs: number
  profileTtlMs: number
  rateLimitCooldownMs: number
  maxRateLimitCooldownMs: number
  transientCooldownMs?: number
  now?: () => number
  /** 每次真正打上游前回调（同步中心的 requests24h 计数）。 */
  onFetch?: () => void
}

export class ClaudeQuotaUpstreamError extends Error {
  constructor(readonly status: number, readonly endpoint: ClaudeQuotaEndpoint, message: string, readonly retryAfterMs: number | null = null) {
    super(message)
    this.name = 'ClaudeQuotaUpstreamError'
  }
}

const parseBody = (response: ApiCallResult, endpoint: ClaudeQuotaEndpoint): unknown => {
  const status = Number(response.status_code ?? response.statusCode ?? 0)
  const raw = response.body ?? response.body_text
  if (status < 200 || status >= 300) {
    throw new ClaudeQuotaUpstreamError(status, endpoint, `上游 ${endpoint === 'usage' ? '额度' : '账号资料'} 接口返回 HTTP ${status || '未知'}`, apiCallRetryAfterMs(response))
  }
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) } catch { throw new ClaudeQuotaUpstreamError(status, endpoint, '上游返回了无法解析的 JSON') }
  }
  return raw ?? {}
}

const retryAt = (value: unknown): number | null => {
  if (typeof value !== 'string' || !value.trim()) return null
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? timestamp : null
}

const humanRetryAt = (timestamp: number): string => new Date(timestamp).toISOString()

export class ClaudeQuotaCache {
  private readonly entries = new Map<string, AccountCache>()
  private readonly inFlight = new Map<string, Promise<{ body: unknown | null; error: string | null; blockedUntil: number | null }>>()
  private readonly now: () => number
  private readonly transientCooldownMs: number

  constructor(private readonly options: ClaudeQuotaCacheOptions) {
    this.now = options.now || (() => Date.now())
    this.transientCooldownMs = options.transientCooldownMs ?? 30_000
  }

  private entry(authIndex: string, endpoint: ClaudeQuotaEndpoint): CacheEntry {
    const account = this.entries.get(authIndex) || {}
    const existing = account[endpoint]
    if (existing) return existing
    const created: CacheEntry = { body: null, fetchedAt: 0, blockedUntil: 0, failures: 0, blockedBy: '' }
    account[endpoint] = created
    this.entries.set(authIndex, account)
    return created
  }

  /**
   * CPA 的 unavailable/next_retry_after 是**账号级（inference 侧）**提示，不代表额度接口自己限流。
   * 额度接口有自己的限流信号（429 + Retry-After≈284s），下面按它做指数退避即可。
   * 所以只有「马上就会重试」的 hint（不超过 maxRateLimitCooldownMs）才被采信成冷却；
   * 那种一直指到周额度重置的 hint（实测 36h）如果照单全收，会把额度面板冻住一整天，
   * 还会让面板把原因写成「额度接口限流」。
   */
  prime(authIndex: string, endpoint: ClaudeQuotaEndpoint, nextRetryAfter?: unknown) {
    const hinted = retryAt(nextRetryAfter)
    if (hinted === null) return
    const entry = this.entry(authIndex, endpoint)
    if (hinted > this.now() + this.options.maxRateLimitCooldownMs) return
    if (hinted <= entry.blockedUntil) return
    entry.blockedUntil = hinted
    entry.blockedBy = 'cpa-hint'
  }

  private async readEndpoint(
    authIndex: string,
    endpoint: ClaudeQuotaEndpoint,
    fetcher: () => Promise<ApiCallResult>,
    ttlMs: number,
  ): Promise<{ body: unknown | null; error: string | null; blockedUntil: number | null }> {
    const key = `${authIndex}:${endpoint}`
    const pending = this.inFlight.get(key)
    if (pending) return pending

    const operation = this.fetchEndpoint(authIndex, endpoint, fetcher, ttlMs)
    this.inFlight.set(key, operation)
    try {
      return await operation
    } finally {
      this.inFlight.delete(key)
    }
  }

  private async fetchEndpoint(
    authIndex: string,
    endpoint: ClaudeQuotaEndpoint,
    fetcher: () => Promise<ApiCallResult>,
    ttlMs: number,
  ): Promise<{ body: unknown | null; error: string | null; blockedUntil: number | null }> {
    const entry = this.entry(authIndex, endpoint)
    const now = this.now()
    if (entry.fetchedAt > 0 && now - entry.fetchedAt < ttlMs) {
      return { body: entry.body, error: null, blockedUntil: entry.blockedUntil || null }
    }
    if (entry.blockedUntil > now) {
      const label = endpoint === 'usage' ? '额度' : '账号资料'
      const minutes = Math.max(1, Math.round((entry.blockedUntil - now) / 60_000))
      const reason = entry.blockedBy === 'cpa-hint'
        ? `账号在 CPA 侧冷却（${label}受限提示），至多 ${minutes} 分钟后自动刷新`
        : `上游 ${label} 接口暂时限流，已暂停重试至 ${humanRetryAt(entry.blockedUntil)}`
      return {
        body: entry.fetchedAt > 0 ? entry.body : null,
        error: entry.fetchedAt > 0 ? `${reason}，当前显示上次成功数据` : reason,
        blockedUntil: entry.blockedUntil,
      }
    }

    try {
      this.options.onFetch?.()
      const body = parseBody(await fetcher(), endpoint)
      entry.body = body
      entry.fetchedAt = now
      entry.blockedUntil = 0
      entry.blockedBy = ''
      entry.failures = 0
      return { body, error: null, blockedUntil: null }
    } catch (error) {
      const status = error instanceof ClaudeQuotaUpstreamError ? error.status : 0
      entry.failures += 1
      // 本地指数档封顶 maxRateLimitCooldownMs；上游 Retry-After 是下限，不被这个封顶截短。
      const retryAfter = error instanceof ClaudeQuotaUpstreamError ? error.retryAfterMs : null
      const cooldown = status === 429
        ? combineCooldown(this.options.rateLimitCooldownMs * 2 ** Math.min(entry.failures - 1, 32), this.options.maxRateLimitCooldownMs, retryAfter)
        : combineCooldown(this.transientCooldownMs, this.transientCooldownMs, retryAfter)
      // 从收到失败的时刻起算：fetcher 里有全局名额排队与请求本身，按开始时刻算会让上游的 Retry-After 提前到期。
      entry.blockedUntil = this.now() + cooldown
      entry.blockedBy = 'rate-limit'
      const reason = error instanceof Error ? error.message : '读取失败'
      const detail = status === 429
        ? `${reason}；已暂停重试至 ${humanRetryAt(entry.blockedUntil)}`
        : `${reason}；短暂失败冷却至 ${humanRetryAt(entry.blockedUntil)}`
      return {
        body: entry.fetchedAt > 0 ? entry.body : null,
        error: entry.fetchedAt > 0 ? `${detail}，当前显示上次成功数据` : detail,
        blockedUntil: entry.blockedUntil,
      }
    }
  }

  async read(
    authIndex: string,
    fetchers: { usage: () => Promise<ApiCallResult>; profile: () => Promise<ApiCallResult> },
    hints: { usageNextRetryAfter?: unknown; profileNextRetryAfter?: unknown; usageUnavailable?: boolean } = {},
  ): Promise<ClaudeQuotaSnapshot> {
    this.prime(authIndex, 'usage', hints.usageNextRetryAfter)
    if (hints.usageUnavailable && !hints.usageNextRetryAfter) {
      const entry = this.entry(authIndex, 'usage')
      // Seed the first local cooldown only. Do not extend it on every monitor
      // request, otherwise CPA's stale `unavailable=true` flag would make the
      // account permanently unprobeable even after the cooldown elapsed.
      if (entry.blockedUntil === 0) {
        entry.blockedUntil = this.now() + this.options.rateLimitCooldownMs
        entry.blockedBy = 'cpa-hint'
      }
    }
    this.prime(authIndex, 'profile', hints.profileNextRetryAfter)
    const [usage, profile] = await Promise.all([
      this.readEndpoint(authIndex, 'usage', fetchers.usage, this.options.usageTtlMs),
      this.readEndpoint(authIndex, 'profile', fetchers.profile, this.options.profileTtlMs),
    ])
    return {
      usage: usage.body,
      profile: profile.body,
      usageError: usage.error,
      profileError: profile.error,
      usageBlockedUntil: usage.blockedUntil,
      profileBlockedUntil: profile.blockedUntil,
    }
  }

  /** 至少有一个端点在冷却的账号数（同步中心摘要）。 */
  blockedCount(now = this.now()): number {
    let count = 0
    for (const account of this.entries.values()) {
      if ((account.usage?.blockedUntil ?? 0) > now || (account.profile?.blockedUntil ?? 0) > now) count += 1
    }
    return count
  }

  /** 冷却中或带失败档位的端点，键为 `authIndex:endpoint`（不含额度数据与凭据）。 */
  exportCooldowns(now = this.now()): Record<string, PersistedCooldown> {
    const result: Record<string, PersistedCooldown> = {}
    for (const [authIndex, account] of this.entries) {
      for (const endpoint of ['usage', 'profile'] as const) {
        const entry = account[endpoint]
        if (!entry || (entry.blockedUntil <= now && entry.failures === 0) || entry.blockedUntil <= now - PROVIDER_RETRY_AFTER_CAP_MS) continue
        result[`${authIndex}:${endpoint}`] = { blockedUntil: entry.blockedUntil, failures: entry.failures, blockedBy: entry.blockedBy }
      }
    }
    return result
  }

  /** 启动时恢复：冷却未到期的端点不会因重启被立刻再打一次，429 档位接着翻倍。 */
  importCooldowns(raw: unknown, now = this.now()): void {
    for (const [key, saved] of Object.entries(sanitizePersistedCooldowns(raw, now))) {
      const separator = key.lastIndexOf(':')
      const authIndex = key.slice(0, separator)
      const endpoint = key.slice(separator + 1)
      if (separator <= 0 || (endpoint !== 'usage' && endpoint !== 'profile')) continue
      const entry = this.entry(authIndex, endpoint)
      if (entry.fetchedAt > 0 || entry.blockedUntil >= saved.blockedUntil) continue
      entry.blockedUntil = saved.blockedUntil
      entry.failures = saved.failures
      entry.blockedBy = saved.blockedBy === 'cpa-hint' ? 'cpa-hint' : saved.blockedBy === 'rate-limit' ? 'rate-limit' : ''
    }
  }

  clear(authIndex?: string) {
    if (authIndex) {
      this.entries.delete(authIndex)
      for (const key of this.inFlight.keys()) if (key.startsWith(`${authIndex}:`)) this.inFlight.delete(key)
    } else {
      this.entries.clear()
      this.inFlight.clear()
    }
  }
}
