/**
 * 「上游额度已恢复，CPA 还挂着旧冷却」的自动清冷却。
 *
 * 背景（2026-09-27、2026-10-11 两次事故）：上游 429 带 resets_at（Codex 的周窗口、Claude 的 7 天窗口），
 * CPA 按它排一条 credential_quota 冷却；用户在 ChatGPT/Claude 侧「重置额度」之后上游已经放行，
 * 但那条冷却是 CPA 的内存态、没有查询/清除端点 → 「重置了但用不了」一直持续到旧的 resets_at。
 * 手工做法是 disable_cooling 置 true→false（清空既有冷却，见 cpa.ts:clearAuthFileCooldown）。
 *
 * 这里把那个动作自动化，判定条件刻意收紧：
 * - 额度必须是**这一轮新鲜读回来的**（没有 error 兜底，也没有归一化 error）；失败回退的旧数据不算；
 * - 上游必须**明确说可以用**：codex `rate_limit.allowed && !limit_reached` 且各窗口 used_percent < 100；
 *   claude 每个窗口 usedPercent 都 < 100 且没有 critical；
 * - CPA 侧必须真的在冷却，且冷却**是额度类**（credential_quota / quota，或 http_status 429）；
 *   瞬时错误（5xx / 网络）的冷却很短，交给 CPA 自己退避，不在这里动；
 * - 凭据被停用（disabled）不动；同一凭据 5 分钟内只自动清一次，避免打转。
 *
 * 只处理 codex 与 claude：两者都有「窗口 + resets_at + 可主动重置」的形状；
 * antigravity 的 bundles/remainingFraction 语义不同，等有实测样例再接。
 */

export type CooldownFile = {
  name?: unknown
  type?: unknown
  status?: unknown
  status_message?: unknown
  unavailable?: unknown
  disabled?: unknown
  cooldowns?: unknown
}

export type NormalizedQuotaView = {
  error?: string | null
  windows?: Array<{ id?: unknown; usedPercent?: number; severity?: string | null }> | null
}

export type StaleCooldownInput = { file: CooldownFile; quota: unknown; normalizedQuota: NormalizedQuotaView | null }

export type StaleCooldownDecision = { clear: boolean; reason: string }

/** 同一凭据两次自动清冷却之间的最短间隔，防止「清了→又被排上→再清」打转。 */
export const AUTO_CLEAR_MIN_INTERVAL_MS = 5 * 60_000

const QUOTA_REASON = /credential_quota|(^|[^a-z])quota([^a-z]|$)/i
const QUOTA_STATUS_MESSAGE = /usage.?limit|rate.?limit|too many requests|quota|429/i

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function cooldownEntries(file: CooldownFile): Array<Record<string, unknown>> {
  if (!Array.isArray(file.cooldowns)) return []
  return file.cooldowns.map(asRecord).filter((entry): entry is Record<string, unknown> => entry !== null)
}

/** CPA 侧是否处在「额度类冷却」：冷却列表里有额度类条目，或（没有冷却明细时）状态文案就是额度/限流。 */
export function coolingOnQuota(file: CooldownFile): { cooling: boolean; detail: string } {
  const entries = cooldownEntries(file)
  const quotaEntries = entries.filter((entry) => {
    const reason = String(entry.reason ?? '')
    const status = Number(entry.http_status ?? 0)
    return QUOTA_REASON.test(reason) || status === 429
  })
  if (entries.length > 0) {
    return quotaEntries.length > 0
      ? { cooling: true, detail: `${quotaEntries.length}/${entries.length} 条额度类冷却` }
      : { cooling: false, detail: `${entries.length} 条非额度类冷却（交给 CPA 退避）` }
  }
  const unavailable = file.unavailable === true || String(file.status ?? '') === 'error'
  if (!unavailable) return { cooling: false, detail: '没有冷却' }
  const message = String(file.status_message ?? '')
  return QUOTA_STATUS_MESSAGE.test(message)
    ? { cooling: true, detail: '状态文案是额度/限流' }
    : { cooling: false, detail: `状态异常但不是额度类：${message.slice(0, 60) || '无文案'}` }
}

/** codex：wham/usage 明确放行，且（有窗口时）每个窗口都没用满。 */
function codexUsable(quota: Record<string, unknown>): { usable: boolean; detail: string } {
  const rateLimit = asRecord(quota.rate_limit)
  if (!rateLimit) return { usable: false, detail: '没有 rate_limit' }
  if (rateLimit.allowed !== true) return { usable: false, detail: `allowed=${String(rateLimit.allowed)}` }
  if (rateLimit.limit_reached === true) return { usable: false, detail: 'limit_reached' }
  for (const key of ['primary_window', 'secondary_window']) {
    const window = asRecord(rateLimit[key])
    if (!window) continue
    const used = Number(window.used_percent)
    if (Number.isFinite(used) && used >= 100) return { usable: false, detail: `${key} used=${used}%` }
  }
  // 模型级窗口（additional_rate_limits）同样要放行，避免「账号能用但目标模型不能用」被误清。
  const additional = Array.isArray(rateLimit.additional_rate_limits) ? rateLimit.additional_rate_limits : []
  for (const item of additional) {
    const entry = asRecord(item)
    if (!entry) continue
    const window = asRecord(entry.rate_limit) ?? entry
    const used = Number(window?.used_percent)
    if (Number.isFinite(used) && used >= 100) return { usable: false, detail: `additional ${String(entry.name ?? '')} used=${used}%` }
  }
  return { usable: true, detail: 'rate_limit.allowed' }
}

/** claude：归一化窗口每个都 < 100% 且没有 critical。没有窗口 ⇒ 无从判断，不清。 */
function claudeUsable(normalized: NormalizedQuotaView | null): { usable: boolean; detail: string } {
  const windows = Array.isArray(normalized?.windows) ? normalized!.windows! : []
  if (windows.length === 0) return { usable: false, detail: '没有额度窗口' }
  for (const window of windows) {
    const used = Number(window?.usedPercent)
    if (Number.isFinite(used) && used >= 100) return { usable: false, detail: `${window.id ?? '窗口'} used=${used}%` }
    if (String(window?.severity ?? '') === 'critical') return { usable: false, detail: `${window.id ?? '窗口'} critical` }
  }
  return { usable: true, detail: `${windows.length} 个窗口都有余量` }
}

/** 纯判定：要不要为该凭据清冷却。`clear=false` 时 reason 说明为什么不动。 */
export function decideStaleCooldownClear(input: StaleCooldownInput): StaleCooldownDecision {
  const { file, quota, normalizedQuota } = input
  const type = String(file.type ?? '')
  const name = String(file.name ?? '')
  if (!name) return { clear: false, reason: '凭据没有文件名' }
  if (type !== 'codex' && type !== 'claude') return { clear: false, reason: `不处理 ${type || '未知'} 类型` }
  if (file.disabled === true) return { clear: false, reason: '凭据已停用' }

  const cooling = coolingOnQuota(file)
  if (!cooling.cooling) return { clear: false, reason: cooling.detail }

  // 额度必须来自本轮真读；失败回退的旧值（带 error）不能拿来当「已恢复」的证据。
  const rawError = asRecord(quota)?.error
  if (rawError) return { clear: false, reason: `额度是冷却期旧值：${String(rawError).slice(0, 60)}` }
  if (normalizedQuota?.error) return { clear: false, reason: `额度归一化失败：${String(normalizedQuota.error).slice(0, 60)}` }

  if (type === 'codex') {
    const usable = codexUsable(asRecord(quota) ?? {})
    return usable.usable
      ? { clear: true, reason: `${usable.detail}（${cooling.detail}）` }
      : { clear: false, reason: `上游仍不可用：${usable.detail}` }
  }
  const usable = claudeUsable(normalizedQuota)
  return usable.usable
    ? { clear: true, reason: `${usable.detail}（${cooling.detail}）` }
    : { clear: false, reason: `上游仍不可用：${usable.detail}` }
}

/* ────────────────────────── 执行 ────────────────────────── */

const lastClearedAt = new Map<string, number>()

/** 测试用：清掉节流记忆。 */
export function resetAutoClearThrottle(): void {
  lastClearedAt.clear()
}

export type ReconcileDeps = {
  clear: (name: string) => Promise<unknown>
  audit: (action: string, target: string, details: string) => void
  log?: (message: string) => void
  now?: number
}

export type ReconcileOutcome = 'cleared' | 'clear-failed' | 'skipped' | 'throttled'

/**
 * 判定并在需要时清冷却。清失败不抛（读路径不能因为清冷却挂掉），失败也进节流窗口，
 * 免得每 60 秒对着同一个凭据重试。
 */
export async function reconcileStaleCooldown(input: StaleCooldownInput, deps: ReconcileDeps): Promise<ReconcileOutcome> {
  const decision = decideStaleCooldownClear(input)
  if (!decision.clear) return 'skipped'
  const name = String(input.file.name)
  const now = deps.now ?? Date.now()
  const last = lastClearedAt.get(name)
  if (last !== undefined && now - last < AUTO_CLEAR_MIN_INTERVAL_MS) return 'throttled'
  lastClearedAt.set(name, now)
  try {
    await deps.clear(name)
  } catch (error) {
    deps.log?.(`[cooldown-recovery] ${name} 清冷却失败：${error instanceof Error ? error.message : String(error)}`)
    deps.audit('auto-clear-cooldown', name, `failed: ${decision.reason}`.slice(0, 200))
    return 'clear-failed'
  }
  deps.audit('auto-clear-cooldown', name, decision.reason.slice(0, 200))
  deps.log?.(`[cooldown-recovery] ${name} 已清冷却：${decision.reason}`)
  return 'cleared'
}
