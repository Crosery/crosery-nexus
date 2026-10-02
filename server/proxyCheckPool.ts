import { ProxyChecker, ProxyHealthStore, type EntryHealth } from './proxyCheck.js'
import { probeCandidateFor, PROXY_HEALTH_JOB_ID, registerProxyHealthJob, type ProxyHealthCandidate } from './proxyCheckJob.js'
import { attachProxyChecker, kernelView, type ProxyCheckPort } from './proxyPoolHooks.js'
import { cpaSameHost, poolSecrets, proxyPoolStore, proxySettings, ProxyError, type PoolFile, type ProxyPoolStore } from './proxyPoolStore.js'
import { syncRegistry, upstreamLimiter, type SyncRegistry } from './syncRegistry.js'

/**
 * Plugs the reachability checks (proxyCheck*.ts) into the pool through `attachProxyChecker` (proxyPoolHooks.ts) and
 * registers the sync job 「代理巡检」. Results go to `DATA_DIR/proxy/health.json`, which the pool view reads.
 *
 * - 「立即检测」 (`testEntry`): one entry, single-flight, a repeat within 60 s returns the stored result;
 * - 「检测在用」 (`testInUse`): the job's manual run (10 min cooldown, in-use entries only);
 * - nothing here runs on page load.
 */

/** Entries in use: linked to an account / channel / key, or set as the default exit. */
export function inUseEntryIds(pool: PoolFile): Set<string> {
  const ids = new Set(Object.values(pool.links).map(link => link.entryId))
  if (pool.defaultEntryId) ids.add(pool.defaultEntryId)
  return ids
}

export function poolCandidates(pool: PoolFile, ids: Set<string>, context: { listenerAuth: boolean; coResident: boolean }): ProxyHealthCandidate[] {
  const listenerAuth = context.listenerAuth && pool.listenerAuth.username ? pool.listenerAuth : null
  return pool.entries
    .filter(entry => ids.has(entry.id))
    .map(entry => probeCandidateFor(entry, { listenerAuth, coResident: context.coResident }))
}

const kernelRunning = () => ['running', 'degraded'].includes(kernelView().state)

/** Auto-named entries become `host · US` once the exit country is known (PROXY-SPEC §6); hand-set names are never touched. */
export function autoNameFromExit(store: ProxyPoolStore, id: string, health: EntryHealth): boolean {
  const country = health.exit.country
  if (!country) return false
  const { pool, readOnly } = store.snapshot()
  const entry = pool.entries.find(item => item.id === id)
  if (readOnly || !entry || !entry.nameAuto) return false
  const host = String(entry.server || entry.name.replace(/ · [A-Z]{2}$/, '')).slice(0, 56)
  const name = `${host} · ${country}`
  if (entry.name === name) return false
  store.update((draft) => {
    const target = draft.entries.find(item => item.id === id)
    if (target?.nameAuto) target.name = name
  })
  return true
}

export type EntryTestResult = { id: string; health: EntryHealth | null; cached: boolean; skipped: string | null }

export type InstalledProxyChecks = { checker: ProxyChecker; port: ProxyCheckPort }

export function installProxyChecks(options: { registry?: SyncRegistry; store?: ProxyPoolStore; checker?: ProxyChecker } = {}): InstalledProxyChecks {
  const registry = options.registry ?? syncRegistry
  const store = options.store ?? proxyPoolStore()
  const checker = options.checker ?? new ProxyChecker({ store: new ProxyHealthStore(store.healthFile), limiter: upstreamLimiter })
  const context = () => ({ listenerAuth: proxySettings().listenerAuth, coResident: cpaSameHost() })
  checker.onChecked((id, health) => { autoNameFromExit(store, id, health) })

  registerProxyHealthJob(registry, {
    checker,
    inUse: () => {
      const { pool, readOnly } = store.snapshot()
      if (!readOnly) checker.healthStore.prune(pool.entries.map(entry => entry.id))
      return poolCandidates(pool, inUseEntryIds(pool), context())
    },
    kernelRunning,
    secrets: () => poolSecrets(store.read()),
  })

  const port: ProxyCheckPort = {
    async testEntry(id: string): Promise<EntryTestResult> {
      const pool = store.read()
      const entry = pool.entries.find(item => item.id === id)
      if (!entry) throw new ProxyError(404, 'entry_not_found')
      const [candidate] = poolCandidates(pool, new Set([id]), context())
      const stored = checker.healthStore.get(id)
      if (candidate.skip) return { id, health: stored, cached: true, skipped: candidate.skip }
      if (candidate.kind === 'mihomo' && !kernelRunning()) return { id, health: stored, cached: true, skipped: '内核未运行' }
      const outcome = await checker.check(candidate)
      if (outcome.requests) registry.countRequests(PROXY_HEALTH_JOB_ID, outcome.requests)
      return { id, health: outcome.health, cached: outcome.cached, skipped: null }
    },
    async testInUse() {
      const outcome = registry.requestRun(PROXY_HEALTH_JOB_ID)
      if (outcome.status === 202) return outcome.body
      // running / cooldown / backoff keep the sync center's codes and Retry-After (the route turns ProxyError into a status)
      const retryAfterSec = typeof outcome.body.retryAfterSec === 'number' ? { retryAfterSec: outcome.body.retryAfterSec } : {}
      throw new ProxyError(outcome.status, String(outcome.body.code ?? 'cooldown'), String(outcome.body.error ?? '') || undefined, retryAfterSec)
    },
  }
  attachProxyChecker(port)
  return { checker, port }
}
