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
  if (error) return { plan: '', tier: '', resetCredits: null, windows: [], error }

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

  return { plan, tier, resetCredits: null, windows, error: null }
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
  if (typeof source.error === 'string') return { plan: '', tier: '', resetCredits: null, windows: [], error: source.error }
  return normalizeCodex(source, resetCredits)
}
