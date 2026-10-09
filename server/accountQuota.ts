/**
 * Claude 与 Codex 的额度结构完全不同，且字段名容易看混：
 *   Claude  usage.five_hour.utilization   + resets_at（ISO 字符串）
 *   Codex   rate_limit.primary_window.used_percent + reset_at（unix 秒）
 * 页面只关心「用了多少、几时重置、要不要报警」，所以在服务端归一成同一个形状。
 */

export type QuotaSeverity = 'normal' | 'warning' | 'critical'

export const MONITORED_ACCOUNT_TYPES = ['antigravity', 'claude', 'codex'] as const

export function isMonitoredAccountType(type: unknown): boolean {
  return MONITORED_ACCOUNT_TYPES.includes(String(type) as (typeof MONITORED_ACCOUNT_TYPES)[number])
}

export type QuotaWindow = {
  id: string
  label: string
  usedPercent: number
  resetsAt: string | null
  windowSeconds: number | null
  severity: QuotaSeverity
  scope: string | null
}

export type AccountQuota = {
  plan: string
  /** 套餐档位，如 Max 20×、Pro；上游把倍率藏在 rate_limit_tier 里 */
  tier: string
  /** Codex 的主动重置额度，含每一次的过期时间 */
  resetCredits: {
    available: number
    applicable: number
    entries: Array<{ id: string; expiresAt: string }>
  } | null
  windows: QuotaWindow[]
  error: string | null
}

/** `default_claude_max_20x` → `Max 20×`，让金标签直接可读 */
export function formatClaudeTier(rateLimitTier: unknown): string {
  const raw = String(rateLimitTier || '')
  if (!raw) return ''
  const match = /(max|pro)(?:_(\d+)x)?/i.exec(raw)
  if (!match) return raw
  const plan = match[1].toLowerCase() === 'max' ? 'Max' : 'Pro'
  return match[2] ? `${plan} ${match[2]}\u00d7` : plan
}

const CLAUDE_WINDOW_LABELS: Record<string, string> = {
  session: '5 小时额度',
  weekly_all: '7 天额度',
  weekly_scoped: '7 天额度',
  five_hour: '5 小时额度',
  seven_day: '7 天额度',
  seven_day_opus: '7 天 Opus',
  seven_day_sonnet: '7 天 Sonnet',
}

/** 上游只在 Claude 侧给 severity，Codex 侧自己按同一档位算，避免两种卡片标准不一。 */
export function severityFor(usedPercent: number): QuotaSeverity {
  if (usedPercent >= 90) return 'critical'
  if (usedPercent >= 75) return 'warning'
  return 'normal'
}

const clampPercent = (value: unknown): number | null => {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return null
  return Math.max(0, Math.min(100, parsed))
}

const isoFromUnixSeconds = (value: unknown): string | null => {
  const seconds = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(seconds) || seconds <= 0) return null
  return new Date(seconds * 1000).toISOString()
}

function normalizeClaude(quota: Record<string, any>): AccountQuota {
  const usage = quota.usage || {}
  const error = typeof quota.error === 'string' ? quota.error : null
  const profile = quota.profile || {}
  const account = profile.account || {}
  const organization = profile.organization || {}
  const plan = account.has_claude_max ? 'Claude Max' : account.has_claude_pro ? 'Claude Pro' : organization.organization_type || ''
  const tier = formatClaudeTier(organization.rate_limit_tier)

  // limits[] 是较新的结构，带 severity 和作用域模型，比 five_hour/seven_day 更完整
  const limits = Array.isArray(usage.limits) ? usage.limits : []
  const windows: QuotaWindow[] = limits
    .map((limit: Record<string, any>, index: number): QuotaWindow | null => {
      const usedPercent = clampPercent(limit.percent)
      if (usedPercent === null) return null
      const scope = limit.scope?.model?.display_name || null
      const baseLabel = CLAUDE_WINDOW_LABELS[String(limit.kind)] || String(limit.kind || `额度 ${index + 1}`)
      return {
        id: `${limit.kind || 'limit'}-${index}`,
        label: scope ? `${baseLabel} · ${scope}` : baseLabel,
        usedPercent,
        resetsAt: typeof limit.resets_at === 'string' ? limit.resets_at : null,
        windowSeconds: null,
        severity: (['normal', 'warning', 'critical'] as const).includes(limit.severity) ? limit.severity : severityFor(usedPercent),
        scope,
      }
    })
    .filter((window: QuotaWindow | null): window is QuotaWindow => window !== null)

  if (windows.length) return { plan, tier, resetCredits: claudeResetCredits(usage), windows, error }

  // 旧结构回退：没有 limits[] 时仍能显示主要窗口
  const legacy: QuotaWindow[] = []
  for (const key of ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet']) {
    const entry = usage[key]
    const usedPercent = clampPercent(entry?.utilization)
    if (usedPercent === null) continue
    legacy.push({
      id: key,
      label: CLAUDE_WINDOW_LABELS[key] || key,
      usedPercent,
      resetsAt: typeof entry.resets_at === 'string' ? entry.resets_at : null,
      windowSeconds: null,
      severity: severityFor(usedPercent),
      scope: null,
    })
  }
  return { plan, tier, resetCredits: claudeResetCredits(usage), windows: legacy, error }
}

function codexWindow(id: string, label: string, window: Record<string, any> | null | undefined): QuotaWindow | null {
  const usedPercent = clampPercent(window?.used_percent)
  if (usedPercent === null) return null
  return {
    id,
    label,
    usedPercent,
    // Codex 给的是 unix 秒的 reset_at，不是 Claude 的 ISO resets_at——这里统一成 ISO
    resetsAt: isoFromUnixSeconds(window?.reset_at),
    windowSeconds: Number.isFinite(Number(window?.limit_window_seconds)) ? Number(window?.limit_window_seconds) : null,
    severity: severityFor(usedPercent),
    scope: null,
  }
}

function normalizeCodex(quota: Record<string, any>, extraCredits?: ResetCreditsInput | null): AccountQuota {
  const planType = String(quota.plan_type || '')
  const plan = planType ? `Codex ${planType.charAt(0).toUpperCase()}${planType.slice(1)}` : ''
  const tier = planType ? `${planType.charAt(0).toUpperCase()}${planType.slice(1)}` : ''
  const credits = quota.rate_limit_reset_credits
  // wham/usage 只给计数；过期时间来自单独的 rate-limit-reset-credits 端点
  const resetCredits = credits || extraCredits
    ? {
        available: extraCredits?.availableCount ?? (Number(credits?.available_count) || 0),
        applicable: Number(credits?.applicable_available_count) || 0,
        entries: (extraCredits?.credits ?? []).map((credit) => ({ id: credit.id, expiresAt: credit.expiresAt })),
      }
    : null
  const windows: QuotaWindow[] = []

  const primary = codexWindow('primary', '主要窗口', quota.rate_limit?.primary_window)
  if (primary) windows.push(primary)
  const secondary = codexWindow('secondary', '次要窗口', quota.rate_limit?.secondary_window)
  if (secondary) windows.push(secondary)

  // 按模型细分的额度（如 GPT-5.3-Codex-Spark）此前完全没展示
  const additional = Array.isArray(quota.additional_rate_limits) ? quota.additional_rate_limits : []
  additional.forEach((entry: Record<string, any>, index: number) => {
    const label = String(entry.limit_name || entry.metered_feature || `附加额度 ${index + 1}`)
    const window = codexWindow(`additional-${index}`, label, entry.rate_limit?.primary_window)
    if (window) windows.push({ ...window, scope: label })
  })

  return { plan, tier, resetCredits, windows, error: null }
}

const ANTIGRAVITY_GROUP_LABELS: Record<string, string> = {
  'gemini models': 'Gemini 模型',
  'claude and gpt models': 'Claude / GPT 模型',
}

const ANTIGRAVITY_WINDOW_LABELS: Record<string, string> = {
  '5h': '5 小时额度',
  'five-hour': '5 小时额度',
  five_hour: '5 小时额度',
  weekly: '7 天额度',
  week: '7 天额度',
}

const antigravityFraction = (value: unknown): number | null => {
  if (typeof value === 'string' && value.trim().endsWith('%')) {
    const percent = Number(value.trim().slice(0, -1))
    return Number.isFinite(percent) ? Math.max(0, Math.min(1, percent / 100)) : null
  }
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? Math.max(0, Math.min(1, parsed)) : null
}

function normalizeAntigravity(quota: Record<string, any>): AccountQuota {
  const error = typeof quota.error === 'string' ? quota.error : null
  // 冷却期间缓存会把上次成功的数据和原因一起给出：有数据就照常展示，再附上原因。
  if (error && !Array.isArray(quota.groups)) return { plan: '', tier: '', resetCredits: null, windows: [], error }

  const subscription = quota.subscription || {}
  const rawPlan = String(subscription.plan || '')
  const planName = rawPlan && rawPlan !== 'unknown'
    ? rawPlan.split('-').map((part: string) => part.charAt(0).toUpperCase() + part.slice(1)).join(' ')
    : ''
  const plan = planName ? `AntiGravity ${planName}` : 'AntiGravity'
  const tier = String(subscription.tierName || subscription.tierId || '')
  const windows: QuotaWindow[] = []

  const groups = Array.isArray(quota.groups) ? quota.groups : []
  groups.forEach((group: Record<string, any>, groupIndex: number) => {
    const rawGroupLabel = String(group.displayName || group.display_name || `额度组 ${groupIndex + 1}`)
    const scope = ANTIGRAVITY_GROUP_LABELS[rawGroupLabel.toLowerCase()] || rawGroupLabel
    const buckets = Array.isArray(group.buckets) ? group.buckets : []
    buckets.forEach((bucket: Record<string, any>, bucketIndex: number) => {
      const remaining = antigravityFraction(bucket.remainingFraction ?? bucket.remaining_fraction)
      if (remaining === null) return
      const rawWindow = String(bucket.window || '').toLowerCase()
      const rawBucketLabel = String(bucket.displayName || bucket.display_name || bucket.bucketId || bucket.bucket_id || `额度 ${bucketIndex + 1}`)
      const bucketLabel = ANTIGRAVITY_WINDOW_LABELS[rawWindow]
        || (/weekly/i.test(rawBucketLabel) ? '7 天额度' : /five.hour|5h/i.test(rawBucketLabel) ? '5 小时额度' : rawBucketLabel)
      const usedPercent = (1 - remaining) * 100
      windows.push({
        id: String(bucket.bucketId || bucket.bucket_id || `antigravity-${groupIndex}-${bucketIndex}`),
        label: `${scope} · ${bucketLabel}`,
        usedPercent,
        resetsAt: typeof (bucket.resetTime ?? bucket.reset_time) === 'string' ? bucket.resetTime ?? bucket.reset_time : null,
        windowSeconds: null,
        severity: severityFor(usedPercent),
        scope,
      })
    })
  })

  return { plan, tier, resetCredits: null, windows, error }
}

/**
 * Claude 的 banked reset（`cedar_ember` 程序）：只把「还能用、没被暂停」的 grant 算进主动重置次数，
 * 形状与 Codex 的 resetCredits 一致，前端的重置区块因此可以完全复用。
 */
export function normalizeClaudeResetCredits(usage: Record<string, any>): ResetCreditsInput | null {
  const program = usage?.cedar_ember
  if (!program || typeof program !== 'object') return null
  const grants = Array.isArray(program.grants) ? program.grants : []
  const usable = grants.filter((grant: any) => Number(grant?.resets_left) > 0 && grant?.paused !== true)
  const availableCount = usable.reduce((sum: number, grant: any) => sum + (Number(grant?.resets_left) || 0), 0)
  const credits = usable.map((grant: any) => ({
    id: typeof grant?.id === 'string' ? grant.id : '',
    status: 'available',
    grantedAt: typeof grant?.starts_at === 'string' ? grant.starts_at : '',
    expiresAt: typeof grant?.ends_at === 'string' ? grant.ends_at : '',
  }))
  return { availableCount, credits }
}

/** cedar_ember 的 grant → 卡片上的 resetCredits；没有该程序或没有可用 grant 时为 null。 */
function claudeResetCredits(usage: Record<string, any>) {
  const normalized = normalizeClaudeResetCredits(usage)
  if (!normalized || normalized.availableCount === null || normalized.availableCount <= 0) return null
  return {
    available: normalized.availableCount,
    applicable: normalized.availableCount,
    entries: normalized.credits.map((credit) => ({ id: credit.id, expiresAt: credit.expiresAt })),
  }
}

export type ResetCreditsInput = {
  availableCount: number | null
  credits: Array<{ id: string; expiresAt: string }>
}

export function normalizeAccountQuota(type: string, quota: unknown, resetCredits?: ResetCreditsInput | null): AccountQuota {
  const source = (quota || {}) as Record<string, any>
  if (type === 'claude') return normalizeClaude(source)
  if (type === 'antigravity') return normalizeAntigravity(source)
  const error = typeof source.error === 'string' ? source.error : null
  if (error && !source.rate_limit && !source.plan_type) return { plan: '', tier: '', resetCredits: null, windows: [], error }
  const normalized = normalizeCodex(source, resetCredits)
  return error ? { ...normalized, error } : normalized
}

/* ────────────────────────── 每账号额度缓存（Codex / AntiGravity） ────────────────────────── */

/**
 * 上游自己给出的等待时间（Retry-After）的合理上限：超过它多半是解析错误或异常值。
 * 本地指数冷却封顶 maxCooldownMs，但上游给的下限不受那个封顶约束——否则 2h 的限流会被打成每小时多试一次。
 */
export const PROVIDER_RETRY_AFTER_CAP_MS = 24 * 60 * 60_000

/**
 * CPA `/api-call` 的转发结果里如果带了上游响应头（`header` / `headers`，值为字符串或字符串数组），
 * 取出 Retry-After（秒数或 HTTP 日期）。CPA 不透传响应头时返回 null，冷却照常走本地指数档。
 */
export function apiCallRetryAfterMs(result: unknown, now = Date.now()): number | null {
  if (!result || typeof result !== 'object') return null
  const record = result as Record<string, unknown>
  const headers = record.header ?? record.headers
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return null
  for (const [name, raw] of Object.entries(headers as Record<string, unknown>)) {
    if (name.toLowerCase() !== 'retry-after') continue
    const value = Array.isArray(raw) ? raw[0] : raw
    if (typeof value !== 'string' && typeof value !== 'number') return null
    const text = String(value).trim()
    if (/^\d+$/.test(text)) return Number(text) * 1000
    const at = Date.parse(text)
    return Number.isFinite(at) ? Math.max(0, at - now) : null
  }
  return null
}

/** 本地冷却与上游下限合成：本地指数档封顶 localMaxMs；上游 Retry-After 只受 PROVIDER_RETRY_AFTER_CAP_MS 约束。 */
export function combineCooldown(localMs: number, localMaxMs: number, retryAfterMs: number | null): number {
  const local = Math.min(localMaxMs, localMs)
  return retryAfterMs === null ? local : Math.max(local, Math.min(retryAfterMs, PROVIDER_RETRY_AFTER_CAP_MS))
}

/** 落进同步中心状态文件的冷却（不含任何凭据或额度数据），重启后据此恢复，避免一重启就把冷却中的账号再打一遍。 */
export type PersistedCooldown = { blockedUntil: number; failures: number; lastError?: string | null; blockedBy?: string }

export function sanitizePersistedCooldowns(raw: unknown, now: number): Record<string, PersistedCooldown> {
  const result: Record<string, PersistedCooldown> = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return result
  for (const [key, entry] of Object.entries(raw as Record<string, unknown>).slice(0, 2000)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || key.length > 300) continue
    const value = entry as Record<string, unknown>
    const blockedUntil = typeof value.blockedUntil === 'number' && Number.isFinite(value.blockedUntil) ? Math.min(value.blockedUntil, now + PROVIDER_RETRY_AFTER_CAP_MS) : 0
    const failures = typeof value.failures === 'number' && Number.isInteger(value.failures) && value.failures >= 0 ? Math.min(value.failures, 32) : 0
    if (blockedUntil <= now && failures === 0) continue
    result[key] = {
      blockedUntil: Math.max(0, blockedUntil),
      failures,
      ...(typeof value.lastError === 'string' ? { lastError: value.lastError.slice(0, 200) } : {}),
      ...(typeof value.blockedBy === 'string' ? { blockedBy: value.blockedBy.slice(0, 20) } : {}),
    }
  }
  return result
}

/** 额度读取失败时带上游状态码，缓存据此区分「被限流」与「一时失败」。 */
export class AccountQuotaUpstreamError extends Error {
  constructor(readonly status: number, message: string, readonly retryAfterMs: number | null = null) {
    super(message)
    this.name = 'AccountQuotaUpstreamError'
  }
}

export type AccountQuotaCacheOptions = {
  ttlMs: number
  /** 429 / 401 / 403 的首档冷却，之后按 2 倍递增到 maxCooldownMs。 */
  rateLimitCooldownMs: number
  maxCooldownMs: number
  /** 其它失败（网络、5xx、解析）的首档冷却，同样指数递增。 */
  failureCooldownMs?: number
  /** 每个账号的 TTL 抖动比例，避免所有账号在同一刻集体过期再一起打上游。 */
  jitterPct?: number
  now?: () => number
  random?: () => number
  /** 每次真正打上游前回调（同步中心的 requests24h 计数）。 */
  onFetch?: () => void
}

export type AccountQuotaRead<T> = { value: T | null; error: string | null; blockedUntil: number | null }

type QuotaEntry<T> = { value: T | null; fetchedAt: number; expiresAt: number; blockedUntil: number; failures: number; lastError: string | null }

/**
 * 与 ClaudeQuotaCache 同一套语义，泛化给 Codex 与 AntiGravity：
 * 成功按账号缓存 TTL；失败进入冷却（429/401/403 用长冷却并指数递增，上游的 Retry-After 作为下限），
 * 冷却期间不打上游、返回上次成功数据 + 原因；同一账号同时只有一个在途请求。
 * 这样 /api/monitor 的 stale-while-revalidate 后台刷新最多只碰到「真正到期」的账号，不会整片扇出。
 */
export class AccountQuotaCache<T> {
  private readonly entries = new Map<string, QuotaEntry<T>>()
  private readonly inflight = new Map<string, Promise<AccountQuotaRead<T>>>()
  private readonly now: () => number
  private readonly random: () => number

  constructor(private readonly options: AccountQuotaCacheOptions) {
    this.now = options.now ?? Date.now
    this.random = options.random ?? Math.random
  }

  private ttl(): number {
    const spread = this.options.ttlMs * ((this.options.jitterPct ?? 10) / 100)
    return Math.round(this.options.ttlMs + spread * (this.random() * 2 - 1))
  }

  read(key: string, fetcher: () => Promise<T>): Promise<AccountQuotaRead<T>> {
    const pending = this.inflight.get(key)
    if (pending) return pending
    const operation: Promise<AccountQuotaRead<T>> = this.load(key, fetcher).finally(() => {
      if (this.inflight.get(key) === operation) this.inflight.delete(key)
    })
    this.inflight.set(key, operation)
    return operation
  }

  private async load(key: string, fetcher: () => Promise<T>): Promise<AccountQuotaRead<T>> {
    const now = this.now()
    const entry = this.entries.get(key)
    if (entry && entry.fetchedAt > 0 && entry.expiresAt > now) return { value: entry.value, error: null, blockedUntil: null }
    if (entry && entry.blockedUntil > now) {
      const reason = `${entry.lastError || '读取失败'}；冷却至 ${new Date(entry.blockedUntil).toISOString()}`
      return {
        value: entry.fetchedAt > 0 ? entry.value : null,
        error: entry.fetchedAt > 0 ? `${reason}，当前显示上次成功数据` : reason,
        blockedUntil: entry.blockedUntil,
      }
    }
    const current: QuotaEntry<T> = entry ?? { value: null, fetchedAt: 0, expiresAt: 0, blockedUntil: 0, failures: 0, lastError: null }
    this.entries.set(key, current)
    try {
      this.options.onFetch?.()
      const value = await fetcher()
      const finishedAt = this.now()
      Object.assign(current, { value, fetchedAt: finishedAt, expiresAt: finishedAt + this.ttl(), blockedUntil: 0, failures: 0, lastError: null })
      return { value, error: null, blockedUntil: null }
    } catch (error) {
      const finishedAt = this.now()
      const status = error instanceof AccountQuotaUpstreamError ? error.status : 0
      const limited = status === 429 || status === 401 || status === 403
      current.failures += 1
      const base = limited ? this.options.rateLimitCooldownMs : (this.options.failureCooldownMs ?? 30_000)
      const retryAfter = error instanceof AccountQuotaUpstreamError ? error.retryAfterMs : null
      const cooldown = combineCooldown(base * 2 ** Math.min(current.failures - 1, 32), this.options.maxCooldownMs, retryAfter)
      current.blockedUntil = finishedAt + cooldown
      current.lastError = error instanceof Error ? error.message : '读取失败'
      const reason = `${current.lastError}；冷却至 ${new Date(current.blockedUntil).toISOString()}`
      return {
        value: current.fetchedAt > 0 ? current.value : null,
        error: current.fetchedAt > 0 ? `${reason}，当前显示上次成功数据` : reason,
        blockedUntil: current.blockedUntil,
      }
    }
  }

  /** 正在冷却的账号数（同步中心摘要）。 */
  blockedCount(now = this.now()): number {
    let count = 0
    for (const entry of this.entries.values()) if (entry.blockedUntil > now) count += 1
    return count
  }

  /** 仍在冷却、或带着失败档位的条目（只有时间、次数和错误文案）。 */
  exportCooldowns(now = this.now()): Record<string, PersistedCooldown> {
    const result: Record<string, PersistedCooldown> = {}
    for (const [key, entry] of this.entries) {
      // 冷却结束超过一天的失败档位不再有参考意义，也不让已删除账号的记录永久留在状态文件里。
      if ((entry.blockedUntil <= now && entry.failures === 0) || entry.blockedUntil <= now - PROVIDER_RETRY_AFTER_CAP_MS) continue
      result[key] = { blockedUntil: entry.blockedUntil, failures: entry.failures, lastError: entry.lastError }
    }
    return result
  }

  /** 启动时恢复冷却：冷却未到期的账号不会因为重启被立刻再打一次，失败档位也接着递增。 */
  importCooldowns(raw: unknown, now = this.now()): void {
    for (const [key, entry] of Object.entries(sanitizePersistedCooldowns(raw, now))) {
      const existing = this.entries.get(key)
      if (existing && (existing.fetchedAt > 0 || existing.blockedUntil >= entry.blockedUntil)) continue
      this.entries.set(key, { value: null, fetchedAt: 0, expiresAt: 0, blockedUntil: entry.blockedUntil, failures: entry.failures, lastError: entry.lastError ?? null })
    }
  }

  clear(key?: string): void {
    if (key === undefined) {
      this.entries.clear()
      this.inflight.clear()
    } else {
      this.entries.delete(key)
      this.inflight.delete(key)
    }
  }
}
