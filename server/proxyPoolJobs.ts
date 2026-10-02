/**
 * The pool's sync-registry jobs (PROXY-SPEC §10): shown in 同步中心 with last/next run, cooldown and errors.
 *
 * - `proxy-subscriptions` 代理订阅: ticks every 30 min, refreshes only due subscriptions (12 h ± 10 %, never
 *   under 6 h), one fetch at a time; per-subscription backoff 1 h → 24 h honouring Retry-After, so the job itself
 *   never backs off (`skipBackoff`). Nothing happens on page load.
 * - `proxy-migrate` 账号代理扫描: 2 min after boot it applies the first migration once (additive, no account
 *   writes), then scans weekly to maintain the link index and the banner's `pending`. Control-plane failures are
 *   job errors, so the registry backs off while CPA is down.
 * The `proxy-health` job belongs to the check module.
 */

import type { SyncRegistry } from './syncRegistry.js'
import { upstreamLimiter } from './syncRegistry.js'
import { refreshSubscription, subscriptionDue } from './proxyPoolImport.js'
import { migrationSummary, runMigration } from './proxyMigrate.js'
import { ProxyError, scrubProxySecrets } from './proxyPoolStore.js'
import type { ProxyService } from './proxyRoutes.js'

export const PROXY_JOB_IDS = { subscriptions: 'proxy-subscriptions', migrate: 'proxy-migrate' } as const

export function registerProxyPoolJobs(registry: SyncRegistry, service: ProxyService, options: { now?: () => number } = {}): void {
  const now = options.now ?? Date.now

  registry.register({
    id: PROXY_JOB_IDS.subscriptions,
    label: '代理订阅',
    kind: 'in-process',
    intervalMs: 12 * 60 * 60_000,
    tickMs: 30 * 60_000,
    initialDelayMs: 5 * 60_000,
    manualCooldownMs: 10 * 60_000,
    // per-subscription backoff lives in pool.json; the manual run still skips subscriptions in backoff
    manualBypassesBackoff: true,
    run: async (context) => {
      const store = service.store()
      if (store.snapshot().readOnly) return { result: 'skipped', summary: '代理池只读', skipBackoff: true }
      const pool = store.read()
      const current = now()
      const due = pool.subscriptions.filter(subscription => context.trigger === 'manual'
        ? !subscription.lastFetchAt || current - Date.parse(subscription.lastFetchAt) >= 10 * 60_000
        : subscriptionDue(subscription, current))
      if (!due.length) return { result: 'ok', summary: pool.subscriptions.length ? '没有到期的订阅' : '没有订阅', silent: context.trigger !== 'manual', skipBackoff: true }
      let ok = 0
      const errors: string[] = []
      const changed: string[] = []
      let removed = false
      for (const subscription of due) {
        if (context.trigger === 'manual' && subscription.nextAt && subscription.failures > 0 && Date.parse(subscription.nextAt) > current) continue
        try {
          const result = await refreshSubscription(store, subscription.id, {
            limit: task => upstreamLimiter.run(task),
            countRequest: () => context.countRequests(),
            now,
          })
          ok++
          changed.push(...result.added, ...result.updated)
          if (result.removed > 0) removed = true
        } catch (error) {
          errors.push(`${subscription.name}：${error instanceof ProxyError ? error.message : '订阅拉取失败'}`)
        }
      }
      if (changed.length || removed) await service.validateAndReload(changed, 'subscription', removed)
      const summary = `刷新 ${ok} 个订阅${errors.length ? `，${errors.length} 个失败` : ''}`
      return {
        result: errors.length ? (ok ? 'partial' : 'error') : 'ok',
        summary,
        error: errors.length ? scrubProxySecrets(errors.join('；'), store.read()) : null,
        skipBackoff: true,
      }
    },
    nextRunAt: () => {
      const next = service.store().read().subscriptions.map(subscription => (subscription.nextAt ? Date.parse(subscription.nextAt) : 0)).filter(Number.isFinite)
      return next.length ? Math.min(...next) : null
    },
  })

  registry.register({
    id: PROXY_JOB_IDS.migrate,
    label: '账号代理扫描',
    kind: 'in-process',
    intervalMs: 7 * 24 * 60 * 60_000,
    initialDelayMs: 2 * 60_000,
    manualCooldownMs: 10 * 60_000,
    // reads only the console's own control plane (management API), never a vendor
    manualBypassesBackoff: true,
    run: async (context) => {
      const store = service.store()
      if (store.snapshot().readOnly) return { result: 'skipped', summary: '代理池只读', skipBackoff: true }
      try {
        const result = await runMigration(store, service.control, { mode: 'auto', now, force: context.trigger === 'manual' || context.trigger === 'timer' })
        return {
          result: result.sources.readErrors || result.sources.channelError ? 'partial' : 'ok',
          summary: migrationSummary(result),
          error: result.sources.readErrors ? `${result.sources.readErrors} 个账号读取失败` : null,
          value: { created: result.applied.created.length },
        }
      } catch (error) {
        return { result: 'error', summary: '扫描失败', error: scrubProxySecrets(error instanceof Error ? error.message : error, store.read()) }
      }
    },
  })
}

/** Subscribe the pool's link index to credential proxy writes made anywhere (channels.ts `setCredentialProxy`). */
export async function installCredentialProxyHook(service: ProxyService): Promise<boolean> {
  const channels = await import('./channels.js') as { onCredentialProxyChanged?: (listener: (name: string, url: string) => void) => unknown }
  if (typeof channels.onCredentialProxyChanged !== 'function') return false
  channels.onCredentialProxyChanged((name, url) => service.noteCredentialProxy(name, url))
  return true
}
