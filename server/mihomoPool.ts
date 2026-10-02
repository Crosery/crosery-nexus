import { scrubMihomoText } from './mihomoConfig.js'
import { getMihomoKernel, type MihomoApplyResult, type MihomoDesired, type MihomoKernel, type MihomoKernelStatus } from './mihomoKernel.js'
import { attachProxyKernel, type ProxyKernelPort, type ProxyKernelView } from './proxyPoolHooks.js'
import { managedEntries, proxyPoolStore, proxySettings, scrubProxySecrets, type ProxyEntry, type ProxyPoolStore, type ProxySettings } from './proxyPoolStore.js'

/**
 * Plugs the managed mihomo (mihomoKernel.ts) into the pool through `attachProxyKernel` (proxyPoolHooks.ts):
 * - desired state = `managedEntries(pool)` (enabled, not invalid, with a port) + the pool's listener credential
 *   (unless `PROXY_LISTENER_AUTH=off`);
 * - after each apply, nodes mihomo rejected are marked `invalid` with the scrubbed reason, and nodes that came up on a
 *   verified port go from `unverified` to `ok` — one pool write, only when something changed;
 * - the pool never waits on the kernel: `requestReload` is fire-and-forget (the kernel debounces 500 ms).
 */

/**
 * The pool stores a node's whitelisted fields in `node` and its type on the entry (`protocol`; an http node with TLS is
 * `https`). mihomo needs `type` inside the node, so it is put back here, the one place nodes leave the pool for the kernel.
 */
export function kernelNode(entry: ProxyEntry): Record<string, unknown> {
  const node: Record<string, unknown> = { ...(entry.node as unknown as Record<string, unknown>) }
  if (typeof node.type !== 'string' || !node.type) node.type = entry.protocol === 'https' ? 'http' : entry.protocol
  if (entry.protocol === 'https' && node.tls === undefined) node.tls = true
  return node
}

/** `null` when the pool cannot be trusted (unknown version, unreadable): keep whatever runs instead of stopping CPA's exits. */
export function desiredFromPool(store: ProxyPoolStore, settings: ProxySettings = proxySettings()): MihomoDesired | null {
  const { pool, readOnly } = store.snapshot()
  if (readOnly) return null
  const entries = managedEntries(pool).map(entry => ({ id: entry.id, port: entry.port as number, node: kernelNode(entry) }))
  const listenerAuth = settings.listenerAuth && pool.listenerAuth.username && pool.listenerAuth.password ? { ...pool.listenerAuth } : null
  return { entries, listenerAuth }
}

export function kernelStatusView(status: MihomoKernelStatus): ProxyKernelView {
  return {
    state: status.state,
    version: status.version,
    reason: status.reason,
    bindFailed: status.bindFailed,
    binarySource: status.binarySource,
    pid: status.pid,
    adopted: status.adopted,
    startedAt: status.startedAt,
    entries: status.entries,
    ports: status.ports,
    invalidCount: status.invalid.length,
    crashes: status.crashes,
    nextRestartAt: status.nextRestartAt,
    keepalive: status.keepalive,
  }
}

/** Writes the apply outcome back into the pool (validity only). Returns how many entries changed. */
export function recordApplyOutcome(store: ProxyPoolStore, result: MihomoApplyResult): number {
  const invalid = new Map(result.invalid.map(item => [item.id, item.reason]))
  const verified = new Set(result.running)
  const needsChange = (entry: ProxyEntry) => entry.kind === 'mihomo'
    && ((invalid.has(entry.id) && entry.validity !== 'invalid') || (verified.has(entry.id) && entry.validity === 'unverified'))
  const { pool, readOnly } = store.snapshot()
  if (readOnly || !pool.entries.some(needsChange)) return 0
  return store.update((draft) => {
    let changed = 0
    const now = new Date().toISOString()
    for (const entry of draft.entries) {
      if (!needsChange(entry)) continue
      if (invalid.has(entry.id)) {
        entry.validity = 'invalid'
        entry.invalidReason = scrubProxySecrets(invalid.get(entry.id), draft).slice(0, 200)
      } else {
        entry.validity = 'ok'
        delete entry.invalidReason
      }
      entry.updatedAt = now
      changed++
    }
    return changed
  })
}

export function createKernelPort(kernel: MihomoKernel, store: ProxyPoolStore, log: (line: string) => void = (line) => console.log(line)): ProxyKernelPort {
  const settle = (result: MihomoApplyResult) => {
    try {
      recordApplyOutcome(store, result)
    } catch (error) {
      log(JSON.stringify({ category: '[PROXY]', event: 'mihomo.record_failed', error: scrubProxySecrets(error instanceof Error ? error.message : error, store.read()) }))
    }
    return result
  }
  return {
    status: () => kernelStatusView(kernel.status()),
    requestReload(reason: string) {
      let desired: MihomoDesired | null
      try {
        desired = desiredFromPool(store)
      } catch {
        desired = null
      }
      if (!desired) return // unreadable pool: keep whatever runs now
      void kernel.apply(desired).then(settle).catch((error: unknown) => {
        log(JSON.stringify({ category: '[PROXY]', event: 'mihomo.apply_failed', reason: String(reason).slice(0, 40), error: scrubProxySecrets(error instanceof Error ? error.message : error, store.read()) }))
      })
    },
    async validate(entries: ProxyEntry[]) {
      const candidates = entries.filter(entry => entry.kind === 'mihomo' && entry.node)
      if (!candidates.length) return new Map<string, string>()
      const result = await kernel.validate(candidates.map(entry => ({ id: entry.id, port: entry.port ?? 0, node: kernelNode(entry) })))
      return result.available ? new Map(result.invalid.map(item => [item.id, item.reason])) : null
    },
    async action(action: 'start' | 'stop' | 'restart') {
      if (action === 'stop') return kernelStatusView(await kernel.stop())
      const desired = desiredFromPool(store) ?? undefined
      settle(action === 'start' ? await kernel.start(desired) : await kernel.restart(desired))
      return kernelStatusView(kernel.status())
    },
  }
}

let installed: { kernel: MihomoKernel; port: ProxyKernelPort } | null = null

/**
 * Console boot: attach the kernel to the pool, adopt a kernel left running by the previous console (argv-verified),
 * then reconcile it with the pool (starts mihomo only if a managed entry exists). Never blocks the server start.
 */
export async function startManagedMihomo(options: { kernel?: MihomoKernel; store?: ProxyPoolStore; signals?: boolean } = {}): Promise<ProxyKernelPort> {
  if (installed && !options.kernel) return installed.port
  const kernel = options.kernel ?? getMihomoKernel()
  const store = options.store ?? proxyPoolStore()
  const port = createKernelPort(kernel, store)
  attachProxyKernel(port)
  installed = { kernel, port }
  if (options.signals !== false) {
    // Default keepalive: only timers are dropped (CPA keeps using the ports). PROXY_KERNEL_KEEPALIVE=0: SIGTERM our pid.
    // The console's own handler (index.ts) re-raises the signal; if it is the only one left we re-raise ourselves.
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
      process.once(signal, () => {
        try { kernel.shutdownNow() } catch { /* never block exit */ }
        if (process.listenerCount(signal) === 0) process.kill(process.pid, signal)
      })
    }
  }
  try {
    await kernel.boot()
    port.requestReload('boot')
  } catch (error) {
    // Never takes the console down: the pool keeps working read-only for managed entries (status shows the state).
    console.error(JSON.stringify({ category: '[PROXY]', event: 'mihomo.boot_failed', error: scrubMihomoText(error instanceof Error ? error.message : error) }))
  }
  return port
}
