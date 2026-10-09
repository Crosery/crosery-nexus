import { config } from './config.js'
import { apiCall, CLAUDE_PROFILE_URL, CLAUDE_USAGE_URL, claudeHeaders, CODEX_RESET_CREDITS_URL, codexHeaders, downloadAuthFile } from './cpa.js'
import { AccountQuotaCache, type ResetCreditsInput } from './accountQuota.js'
import { fetchAntigravityAccountQuota, type AntigravityAccountQuota } from './antigravityQuota.js'
import { ClaudeQuotaCache } from './claudeQuotaCache.js'
import { normalizeResetCredits, parseCodexResetCredits, parseCodexUsage, resolveChatgptAccountId } from './codexAccount.js'
import { sanitizeSyncError, syncRegistry, upstreamLimiter, type SyncOutcome } from './syncRegistry.js'

/**
 * 账号额度的每账号缓存（/api/monitor 的唯一上游出口）。
 *
 * 这些读取共用对外服务推理的 OAuth 凭据，打多了风险落在真账号上：
 * 每类账号各自 TTL + 失败冷却 + 在途去重，monitor 的整页缓存过期后也只会刷新真正到期的账号。
 */

/**
 * 每一次真正发出去的 /api-call 转发：在全局上游闸门里排队（与模型发现共享 globalUpstreamConcurrency），
 * 并按实际次数计入 requests24h（AntiGravity 一个账号可能是多个域名 + loadCodeAssist）。
 * 没配管理密钥时 cpaRequest 在发送前就抛错，不计数。
 */
const upstreamCall: typeof apiCall = (authIndex, url, options) => upstreamLimiter.run(() => {
  if (config.cpaManagementKey) syncRegistry.countRequests('account-quota')
  return apiCall(authIndex, url, options)
})

export const claudeQuotaCache = new ClaudeQuotaCache({
  usageTtlMs: config.claudeQuotaUsageTtlMs,
  profileTtlMs: config.claudeQuotaProfileTtlMs,
  rateLimitCooldownMs: config.claudeQuotaRateLimitCooldownMs,
  maxRateLimitCooldownMs: config.claudeQuotaMaxRateLimitCooldownMs,
})

export const codexUsageCache = new AccountQuotaCache<Record<string, unknown>>({
  ttlMs: 3 * 60_000,
  rateLimitCooldownMs: config.claudeQuotaRateLimitCooldownMs,
  maxCooldownMs: config.claudeQuotaMaxRateLimitCooldownMs,
  failureCooldownMs: 30_000,
})

/** 重置额度几乎不变（兑现后由重置路由主动清掉），比用量缓存得更久。 */
export const codexCreditsCache = new AccountQuotaCache<ReturnType<typeof normalizeResetCredits>>({
  ttlMs: 15 * 60_000,
  rateLimitCooldownMs: config.claudeQuotaRateLimitCooldownMs,
  maxCooldownMs: config.claudeQuotaMaxRateLimitCooldownMs,
  failureCooldownMs: 60_000,
})

export const antigravityQuotaCache = new AccountQuotaCache<AntigravityAccountQuota>({
  ttlMs: 5 * 60_000,
  rateLimitCooldownMs: config.claudeQuotaRateLimitCooldownMs,
  maxCooldownMs: config.claudeQuotaMaxRateLimitCooldownMs,
  failureCooldownMs: 60_000,
})

/* ────────────────────────── 冷却持久化（同步中心状态文件） ────────────────────────── */

const COOLDOWNS_KEY = 'cooldowns'
const cooldownCaches = {
  claude: claudeQuotaCache,
  codexUsage: codexUsageCache,
  codexCredits: codexCreditsCache,
  antigravity: antigravityQuotaCache,
} as const

/**
 * 错误文案可能来自 CPA 管理面的响应体（CPARequestError 带最多 240 字原文），里面可能回显凭据：
 * 落盘前、从盘上恢复时都按同步中心的规则去掉凭据。
 */
function redactCooldowns(entries: unknown): unknown {
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) return entries
  return Object.fromEntries(Object.entries(entries as Record<string, unknown>).map(([key, entry]) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [key, entry]
    const value = entry as Record<string, unknown>
    return [key, typeof value.lastError === 'string' ? { ...value, lastError: sanitizeSyncError(value.lastError) } : value]
  }))
}

/** 冷却（到期时间、失败档位、错误文案，按 auth_index 分键）随 sync-state.json 落盘；不含凭据和额度数据。 */
export function persistAccountQuotaCooldowns(): void {
  const data = syncRegistry.jobData('account-quota')
  data[COOLDOWNS_KEY] = Object.fromEntries(Object.entries(cooldownCaches).map(([name, cache]) => [name, redactCooldowns(cache.exportCooldowns())]))
  syncRegistry.saveSoon()
}

export function restoreAccountQuotaCooldowns(): void {
  const data = syncRegistry.jobData('account-quota')
  const saved = data[COOLDOWNS_KEY]
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return
  // 旧版本落过盘的明文也要换掉：否则下一次落盘会把它原样写回去。
  const redacted = Object.fromEntries(Object.entries(saved as Record<string, unknown>).map(([name, entries]) => [name, redactCooldowns(entries)]))
  data[COOLDOWNS_KEY] = redacted
  for (const [name, cache] of Object.entries(cooldownCaches)) cache.importCooldowns(redacted[name])
}

restoreAccountQuotaCooldowns()

const withError = <T extends object>(value: T | null, error: string | null): unknown =>
  value ? (error ? { ...value, error } : value) : { error: error || '读取失败' }

/** 单个账号的额度体 + Codex 重置额度（形状与旧的 /api/monitor 内联实现一致）。 */
export async function readAccountQuota(file: Record<string, any>): Promise<{ quota: unknown; resetCredits: ResetCreditsInput | null }> {
  try {
    return await readSupportedAccountQuota(file)
  } finally {
    persistAccountQuotaCooldowns()
  }
}

async function readSupportedAccountQuota(file: Record<string, any>): Promise<{ quota: unknown; resetCredits: ResetCreditsInput | null }> {
  const type = String(file.type)
  const authIndex = String(file.auth_index)
  if (type === 'claude') {
    const snapshot = await claudeQuotaCache.read(
      authIndex,
      {
        usage: () => upstreamCall(authIndex, CLAUDE_USAGE_URL, { header: claudeHeaders() }),
        profile: () => upstreamCall(authIndex, CLAUDE_PROFILE_URL, { header: claudeHeaders() }),
      },
      { usageNextRetryAfter: file.next_retry_after, usageUnavailable: file.unavailable === true },
    )
    return {
      quota: {
        ...(snapshot.usage ? { usage: snapshot.usage } : {}),
        ...(snapshot.profile ? { profile: snapshot.profile } : {}),
        error: [snapshot.usageError, snapshot.profileError].filter(Boolean).join('；') || undefined,
      },
      resetCredits: null,
    }
  }
  if (type === 'antigravity') {
    const read = await antigravityQuotaCache.read(authIndex, () => fetchAntigravityAccountQuota(file, { apiCall: upstreamCall, downloadAuthFile }))
    return { quota: withError(read.value, read.error), resetCredits: null }
  }
  const usage = await codexUsageCache.read(authIndex, async () => parseCodexUsage(await upstreamCall(authIndex, 'https://chatgpt.com/backend-api/wham/usage')))
  let resetCredits: ResetCreditsInput | null = null
  if (type === 'codex') {
    // 主动重置额度在单独的 wham 端点，usage 里只有计数没有过期时间
    const accountId = resolveChatgptAccountId(file) || undefined
    const credits = await codexCreditsCache.read(authIndex, async () =>
      parseCodexResetCredits(await upstreamCall(authIndex, CODEX_RESET_CREDITS_URL, { header: codexHeaders(accountId) })))
    resetCredits = credits.value
  }
  return { quota: withError(usage.value, usage.error), resetCredits }
}

/** 兑现重置后必须丢掉该账号的缓存，否则面板会在 TTL 内继续显示重置前的额度。 */
export function clearAccountQuota(authIndex: string): void {
  claudeQuotaCache.clear(authIndex)
  codexUsageCache.clear(authIndex)
  codexCreditsCache.clear(authIndex)
  antigravityQuotaCache.clear(authIndex)
  persistAccountQuotaCooldowns()
}

export function accountQuotaCooldowns(): number {
  return claudeQuotaCache.blockedCount() + codexUsageCache.blockedCount() + antigravityQuotaCache.blockedCount()
}

/** /api/monitor 一次刷新的同步中心记录：全失败才算 error，部分失败 partial。 */
export function summarizeAccountQuota(payload: {
  accounts?: Array<{ normalizedQuota?: { error?: string | null } }>
}): SyncOutcome {
  const accounts = payload.accounts ?? []
  const failing = accounts.filter(account => account.normalizedQuota?.error).length
  const cooling = accountQuotaCooldowns()
  const parts = [`${accounts.length} 账号`]
  if (failing) parts.push(`${failing} 异常`)
  if (cooling) parts.push(`${cooling} 冷却`)
  const result = !accounts.length ? 'skipped' : failing === 0 ? 'ok' : failing === accounts.length ? 'error' : 'partial'
  return { result, summary: parts.join(' · '), error: failing ? `${failing} 个账号额度读取异常` : null, skipBackoff: true }
}
