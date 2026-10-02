/**
 * Where the managed-mihomo and reachability modules plug into the pool (they are separate modules; the pool
 * routes must work, read-only for those parts, before and without them).
 *
 * Kernel module: `attachProxyKernel({ status, requestReload, validate?, action? })` once at boot.
 *   - `status()` is synchronous and cheap (GET / calls it on every request).
 *   - `requestReload(reason)` is called after any change to mihomo entries (add, update, enable, delete); the
 *     kernel debounces, validates (`mihomo -t`), applies and verifies listeners.
 *   - `validate(entries)` runs `-t` (+ bisect) on candidate entries before they can reach the running config and
 *     returns `id → scrubbed reason` for the invalid ones, or null when there is no binary.
 * Check module: `attachProxyChecker({ testEntry, testInUse })`; both return the check module's own result shape.
 */

import type { ProxyEntry } from './proxyPoolStore.js'

export type ProxyKernelState = 'unavailable' | 'idle' | 'starting' | 'running' | 'degraded' | 'failed' | 'stopped'

export type ProxyKernelView = {
  state: ProxyKernelState
  version?: string | null
  /** zh, already scrubbed */
  reason?: string | null
  /** entry ids whose listener failed to bind */
  bindFailed?: string[]
  [key: string]: unknown
}

export type ProxyKernelPort = {
  status(): ProxyKernelView
  requestReload(reason: string): void
  validate?(entries: ProxyEntry[]): Promise<Map<string, string> | null>
  action?(action: 'start' | 'stop' | 'restart'): Promise<ProxyKernelView>
}

export type ProxyCheckPort = {
  testEntry(id: string): Promise<unknown>
  testInUse(): Promise<unknown>
}

let kernel: ProxyKernelPort | null = null
let checker: ProxyCheckPort | null = null

export function attachProxyKernel(port: ProxyKernelPort | null): void { kernel = port }
export function attachProxyChecker(port: ProxyCheckPort | null): void { checker = port }
export const proxyKernel = (): ProxyKernelPort | null => kernel
export const proxyChecker = (): ProxyCheckPort | null => checker

const NOT_ATTACHED: ProxyKernelView = { state: 'unavailable', version: null, reason: '内核未安装 — 加密节点可保存但不可用；设置 MIHOMO_BIN 后重启控制台' }

/** The kernel's view, or `unavailable` while no kernel module is attached (the production VPS without a binary). */
export function kernelView(): ProxyKernelView {
  if (!kernel) return NOT_ATTACHED
  try {
    const view = kernel.status()
    return view && typeof view.state === 'string' ? view : NOT_ATTACHED
  } catch {
    return { state: 'failed', reason: '内核状态读取失败' }
  }
}

/** Tell the kernel the set of mihomo entries changed. Never throws. */
export function notifyPoolChanged(reason: string): void {
  try { kernel?.requestReload(reason) } catch { /* the kernel reports its own failures */ }
}
