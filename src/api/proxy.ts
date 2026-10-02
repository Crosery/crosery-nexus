import type {
  EgressData,
  EgressRead,
  ProxyAccountsData,
  ProxyAssignResult,
  ProxyAssignTarget,
  ProxyEntryView,
  ProxyImportResult,
  ProxyMigrationApplied,
  ProxyMigrationPreview,
  ProxyOptionsData,
  ProxyPoolData,
  ProxyPreview,
  ProxySubscriptionView,
} from '../types'
import { request } from './http'

const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) })

/**
 * /api/proxies (admin only). Errors are ApiError with `code`: `confirm_required` (body.accounts = how many accounts the
 * write touches), `proxy_in_use`, `proxy_scope_mismatch`, `kernel_unavailable`, `accounts_proxy_unavailable`, `cooldown`
 * (retryAfterSec), `preview_expired`, `unsupported_format` (body.hint), `pool_read_only`.
 * GETs read local state only; nothing here triggers a probe or a subscription fetch except parse/refresh/test.
 */
export const proxyApi = {
  pool: (signal?: AbortSignal) => request<ProxyPoolData>('/api/proxies', { signal, cache: 'no-cache' }),
  options: (signal?: AbortSignal) => request<ProxyOptionsData>('/api/proxies/options', { signal, cache: 'no-cache' }),
  accounts: (signal?: AbortSignal) => request<ProxyAccountsData>('/api/proxies/accounts', { signal, cache: 'no-cache' }),
  /** /accounts read model: local state only (no CPA, vendor or exit traffic) */
  egress: (signal?: AbortSignal) => request<EgressData>('/api/proxies/egress', { signal, cache: 'no-cache' }),
  /** one account's exit, read from its owner (CPA management API, coalesced 15 s server-side); never the URL */
  egressAccount: (ref: string, provider?: string) =>
    request<EgressRead>(`/api/proxies/egress/account?${new URLSearchParams({ ref, ...(provider ? { provider } : {}) })}`, { cache: 'no-cache' }),
  parse: (text: string) => request<ProxyPreview>('/api/proxies/parse', json('POST', { text })),
  import: (previewId: string, options: { keys?: string[]; tags?: string[]; subscriptions?: Array<{ key: string; include?: boolean; intervalH?: number; name?: string }> } = {}) =>
    request<ProxyImportResult>('/api/proxies/import', json('POST', { previewId, ...options })),
  update: (id: string, patch: { name?: string; tags?: string[]; enabled?: boolean; url?: string; confirm?: boolean; reassign?: ProxyAssignTarget | 'keep' }) =>
    request<{ entry: ProxyEntryView; reapplied: { updated: number; drifted: number; failed: number; readOnly: number } | null }>(`/api/proxies/${encodeURIComponent(id)}`, json('PATCH', patch)),
  remove: (id: string, options: { reassign?: ProxyAssignTarget | 'keep'; confirm?: boolean } = {}) => {
    const query = new URLSearchParams()
    if (options.reassign !== undefined) query.set('reassign', options.reassign)
    if (options.confirm) query.set('confirm', '1')
    const text = query.toString()
    const suffix = text ? `?${text}` : ''
    return request<{ ok: boolean; moved: number }>(`/api/proxies/${encodeURIComponent(id)}${suffix}`, { method: 'DELETE' })
  },
  test: (id: string) => request<unknown>(`/api/proxies/${encodeURIComponent(id)}/test`, { method: 'POST', body: '{}' }),
  testInUse: () => request<unknown>('/api/proxies/test', { method: 'POST', body: '{}' }),
  /** call only after the user confirmed (confirmSheet: N accounts, from → to) */
  assign: (target: ProxyAssignTarget, accounts: string[]) => request<ProxyAssignResult>('/api/proxies/assign', json('POST', { target, accounts, confirm: true })),
  unassign: (accounts: string[], restore = false) => request<ProxyAssignResult>('/api/proxies/unassign', json('POST', { accounts, restore, confirm: true })),
  setDefault: (target: ProxyAssignTarget) => request<ProxyAssignResult & { inheriting: number }>('/api/proxies/default', json('PUT', { target, confirm: true })),
  migratePreview: () => request<ProxyMigrationPreview>('/api/proxies/migrate', json('POST', { dryRun: true })),
  migrateApply: (scanId?: string | null) => request<ProxyMigrationApplied>('/api/proxies/migrate', json('POST', { dryRun: false, ...(scanId ? { scanId } : {}) })),
  unignoreAll: () => request<{ unignored: number }>('/api/proxies/migrate/unignore', json('POST', { all: true })),
  /** masked export (secrets → ***); the with-secrets export is CLI-only */
  exportMasked: () => request<Record<string, unknown>>('/api/proxies/export'),
  updateSubscription: (id: string, patch: { name?: string; intervalH?: number }) =>
    request<ProxySubscriptionView>(`/api/proxies/subscriptions/${encodeURIComponent(id)}`, json('PATCH', patch)),
  removeSubscription: (id: string, keepNodes = false) =>
    request<{ kept: number; removed: number }>(`/api/proxies/subscriptions/${encodeURIComponent(id)}${keepNodes ? '?keepNodes=1' : ''}`, { method: 'DELETE' }),
  refreshSubscription: (id: string) =>
    request<{ added: number; updated: number; removed: number; stale: number; nodeCount: number }>(`/api/proxies/subscriptions/${encodeURIComponent(id)}/refresh`, { method: 'POST', body: '{}' }),
  kernel: (action: 'start' | 'stop' | 'restart') => request<unknown>(`/api/proxies/kernel/${action}`, { method: 'POST', body: '{}' }),
}
