import { listenerProxyUrl, type MihomoListenerAuth } from './mihomoConfig.js'
import { entryHealthy, scrubProbeText, type ProbeTarget, type ProxyChecker } from './proxyCheck.js'
import { mapWithConcurrency, type SyncRegistry, type SyncRunContext } from './syncRegistry.js'

/**
 * Sync-center job 「代理巡检」 (`proxy-health`, PROXY-SPEC §6 "Budget"):
 * - ticks every 15 min, but an entry is only due 6 h ± 10 % after its last check, at most 8 entries per tick;
 * - only entries in use (linked to an account or set as the default exit), never on page load;
 * - managed (mihomo) entries are skipped while the kernel is not running;
 * - probe failures are data (health.json), not job errors: no task-level backoff (`skipBackoff`);
 * - manual 「检测在用」 = run now with a 10 min cooldown; it re-checks only entries whose last result is older than 10 min.
 */

export const PROXY_HEALTH_JOB_ID = 'proxy-health'

export const PROXY_HEALTH_POLICY = {
  intervalMs: 6 * 60 * 60_000,
  tickMs: 15 * 60_000,
  initialDelayMs: 5 * 60_000,
  jitterPct: 10,
  maxPerTick: 8,
  manualCooldownMs: 10 * 60_000,
  manualFreshMs: 10 * 60_000,
  entryConcurrency: 4,
} as const

/** One in-use exit as the pool sees it: the probe target plus why it cannot be probed here, if so. */
export type ProxyHealthCandidate = ProbeTarget & { kind: 'url' | 'mihomo'; skip?: string | null }

export type ProxyHealthJobDeps = {
  checker: ProxyChecker
  /** Entries in use (linked or default), already resolved to the URL their accounts use. */
  inUse: () => ProxyHealthCandidate[] | Promise<ProxyHealthCandidate[]>
  kernelRunning: () => boolean
  /** Extra values to mask in job errors (listener credentials, subscription tokens …). */
  secrets?: () => string[]
  random?: () => number
}

type JobData = { next?: Record<string, number> }

/** Structural view of a pool entry (proxyPool*.ts owns the real type). */
export type PoolEntryLike = {
  id: string
  kind: 'url' | 'mihomo'
  url?: string | null
  port?: number | null
  external?: boolean
  enabled?: boolean
  validity?: string
}

/**
 * Turns a pool entry into a probe candidate. `url` entries are probed directly with their own URL; managed entries
 * through their local listener; `external` loopback entries (another tool's port on the consumer host) only when the
 * consumer is this host.
 */
export function probeCandidateFor(entry: PoolEntryLike, context: { listenerAuth: MihomoListenerAuth | null; coResident: boolean }): ProxyHealthCandidate {
  if (entry.enabled === false) return { id: entry.id, kind: entry.kind, proxyUrl: null, skip: '已停用' }
  if (entry.validity === 'invalid') return { id: entry.id, kind: entry.kind, proxyUrl: null, skip: '配置无效' }
  if (entry.kind === 'mihomo') {
    if (!Number.isSafeInteger(entry.port) || !entry.port) return { id: entry.id, kind: 'mihomo', proxyUrl: null, skip: '未分配本机端口' }
    return { id: entry.id, kind: 'mihomo', proxyUrl: listenerProxyUrl(entry.port, context.listenerAuth) }
  }
  if (!entry.url) return { id: entry.id, kind: 'url', proxyUrl: null, skip: '缺少代理地址' }
  if (entry.external && !context.coResident) return { id: entry.id, kind: 'url', proxyUrl: entry.url, skip: '此处无法检测' }
  return { id: entry.id, kind: 'url', proxyUrl: entry.url }
}

function sanitizeJobData(data: Record<string, unknown>, now: number) {
  const next = data.next
  const clean: Record<string, number> = {}
  if (next && typeof next === 'object' && !Array.isArray(next)) {
    for (const [id, at] of Object.entries(next as Record<string, unknown>)) {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || typeof at !== 'number' || !Number.isFinite(at) || at < 0) continue
      // Never further out than one jittered interval (a clock jump or a hand-edited file must not freeze an entry).
      clean[id] = Math.min(at, now + PROXY_HEALTH_POLICY.intervalMs * 1.2)
    }
  }
  for (const key of Object.keys(data)) delete data[key]
  data.next = clean
}

export type ProxyHealthPlan = { due: ProxyHealthCandidate[]; skippedKernel: number; skippedOther: number; fresh: number }

/** Which in-use entries this run checks (pure; exported for tests). */
export function planProxyHealth(input: {
  candidates: readonly ProxyHealthCandidate[]
  next: Record<string, number>
  lastAt: (id: string) => number | null
  now: number
  manual: boolean
  kernelRunning: boolean
}): ProxyHealthPlan {
  let skippedKernel = 0
  let skippedOther = 0
  let fresh = 0
  const eligible: Array<{ candidate: ProxyHealthCandidate; dueAt: number }> = []
  const seen = new Set<string>()
  for (const candidate of input.candidates) {
    if (seen.has(candidate.id)) continue
    seen.add(candidate.id)
    if (candidate.skip) { skippedOther += 1; continue }
    if (candidate.kind === 'mihomo' && !input.kernelRunning) { skippedKernel += 1; continue }
    const last = input.lastAt(candidate.id)
    if (input.manual) {
      if (last !== null && input.now - last < PROXY_HEALTH_POLICY.manualFreshMs) { fresh += 1; continue }
      eligible.push({ candidate, dueAt: last ?? 0 })
      continue
    }
    const dueAt = input.next[candidate.id] ?? (last !== null ? last + PROXY_HEALTH_POLICY.intervalMs : 0)
    if (dueAt <= input.now) eligible.push({ candidate, dueAt })
  }
  eligible.sort((a, b) => a.dueAt - b.dueAt)
  const due = (input.manual ? eligible : eligible.slice(0, PROXY_HEALTH_POLICY.maxPerTick)).map(item => item.candidate)
  return { due, skippedKernel, skippedOther, fresh }
}

export async function runProxyHealth(context: Pick<SyncRunContext, 'trigger' | 'now' | 'countRequests' | 'data'>, deps: ProxyHealthJobDeps) {
  const data = context.data as JobData
  data.next ??= {}
  const now = context.now()
  const random = deps.random ?? Math.random
  let candidates: ProxyHealthCandidate[]
  try {
    candidates = await deps.inUse()
  } catch (error) {
    return { result: 'error' as const, error: scrubProbeText(error instanceof Error ? error.message : error, deps.secrets?.() ?? []) }
  }
  const inUseIds = new Set(candidates.map(candidate => candidate.id))
  for (const id of Object.keys(data.next)) if (!inUseIds.has(id)) delete data.next[id]
  const store = deps.checker.healthStore
  const plan = planProxyHealth({
    candidates,
    next: data.next,
    lastAt: (id) => {
      const at = store.get(id)?.lastAt
      return at ? Date.parse(at) : null
    },
    now,
    manual: context.trigger === 'manual',
    kernelRunning: deps.kernelRunning(),
  })
  const skippedText = [
    plan.skippedKernel ? `跳过 ${plan.skippedKernel}（内核未运行）` : '',
    plan.skippedOther ? `跳过 ${plan.skippedOther}（此处无法检测）` : '',
  ].filter(Boolean)
  if (!plan.due.length) {
    if (context.trigger !== 'manual') return { result: 'skipped' as const, silent: true, skipBackoff: true }
    const reason = !candidates.length ? '没有在用的出口' : plan.fresh ? `在用出口均在 ${PROXY_HEALTH_POLICY.manualFreshMs / 60_000} 分钟内检测过` : '没有可检测的出口'
    return { result: 'skipped' as const, summary: [reason, ...skippedText].join(' · '), skipBackoff: true }
  }
  let requests = 0
  let healthy = 0
  let failures = 0
  const errors: string[] = []
  await mapWithConcurrency(plan.due, PROXY_HEALTH_POLICY.entryConcurrency, async (candidate) => {
    try {
      const outcome = await deps.checker.check(candidate, { maxAgeMs: context.trigger === 'manual' ? PROXY_HEALTH_POLICY.manualFreshMs : 0 })
      requests += outcome.requests
      if (entryHealthy(outcome.health)) healthy += 1
      else failures += 1
    } catch (error) {
      failures += 1
      errors.push(error instanceof Error ? error.message : String(error))
    } finally {
      const spread = PROXY_HEALTH_POLICY.intervalMs * (PROXY_HEALTH_POLICY.jitterPct / 100)
      data.next![candidate.id] = context.now() + Math.round(PROXY_HEALTH_POLICY.intervalMs + spread * (random() * 2 - 1))
    }
  })
  context.countRequests(requests)
  const summary = [`检测 ${plan.due.length} 个`, `正常 ${healthy}`, failures ? `异常 ${failures}` : '', ...skippedText].filter(Boolean).join(' · ')
  return {
    result: failures ? ('partial' as const) : ('ok' as const),
    summary,
    error: errors.length ? scrubProbeText(errors.join('；'), deps.secrets?.() ?? []) : null,
    skipBackoff: true,
  }
}

export function registerProxyHealthJob(registry: SyncRegistry, deps: ProxyHealthJobDeps): void {
  registry.register({
    id: PROXY_HEALTH_JOB_ID,
    label: '代理巡检',
    kind: 'in-process',
    intervalMs: PROXY_HEALTH_POLICY.intervalMs,
    tickMs: PROXY_HEALTH_POLICY.tickMs,
    initialDelayMs: PROXY_HEALTH_POLICY.initialDelayMs,
    manualCooldownMs: PROXY_HEALTH_POLICY.manualCooldownMs,
    // Per-entry schedule and per-entry results replace task-level backoff; a manual run still has its own cooldown.
    manualBypassesBackoff: true,
    sanitizeData: sanitizeJobData,
    run: (context) => runProxyHealth(context, deps),
    nextRunAt: (data) => {
      const values = Object.values((data as JobData).next ?? {}).filter(value => Number.isFinite(value))
      return values.length ? Math.min(...values) : null
    },
  })
}
