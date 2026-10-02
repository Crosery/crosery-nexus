import { sanitizeSyncError } from './syncRegistry.js'

/**
 * What account and credential listings may send to a browser. Every field is picked by name: a credential
 * file or a gateway record can carry access/refresh/id tokens, cookies or keys, and a spread (`...file`) would
 * hand them all over (2026-10-02: GET /api/monitor did, in local mode).
 */

/** `http://user:pass@host:port` → `http://***@host:port`; no userinfo → unchanged. */
export function maskProxyUserinfo(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!raw) return ''
  try {
    const url = new URL(raw)
    if (!url.username && !url.password) return raw
    return raw.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#]*@/i, '$1***@')
  } catch {
    return raw.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#]*@/i, '$1***@')
  }
}

/** The UI's privacy mask for an email (src/lib/privacy.ts maskEmail): audit targets and logs never hold the address. */
export function maskIdentity(value: unknown): string {
  const raw = String(value ?? '').trim()
  const dot = '•'
  const at = raw.lastIndexOf('@')
  const local = Array.from(at > 0 ? raw.slice(0, at) : raw)
  let masked = ''
  if (local.length > 3) masked = local.slice(0, 2).join('') + dot.repeat(Math.min(6, local.length - 3)) + local[local.length - 1]
  else if (local.length > 0) masked = local[0] + dot.repeat(2)
  return at > 0 ? `${masked}@${dot.repeat(3)}` : masked
}

const MONITOR_TEXT_FIELDS = ['name', 'filename', 'type', 'provider', 'email', 'account', 'label', 'status', 'status_message',
  'next_retry_after', 'updated_at', 'plan', 'account_type'] as const

const text = (value: unknown, max = 300): string | undefined =>
  typeof value === 'string' ? value.slice(0, max) : typeof value === 'number' && Number.isFinite(value) ? String(value) : undefined

function projectRecent(value: unknown): Array<{ time?: string; success: number; failed: number }> | undefined {
  if (!Array.isArray(value)) return undefined
  return value.slice(-64).map((bucket) => {
    const entry = bucket && typeof bucket === 'object' ? bucket as Record<string, unknown> : {}
    const count = (raw: unknown) => (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 0)
    const time = text(entry.time, 64)
    return { ...(time ? { time } : {}), success: count(entry.success), failed: count(entry.failed) }
  })
}

function projectQuotaError(quota: unknown): { error?: string; unsupported?: true } | null {
  if (!quota || typeof quota !== 'object' || Array.isArray(quota)) return null
  const source = quota as Record<string, unknown>
  const error = typeof source.error === 'string' && source.error ? sanitizeSyncError(source.error) : undefined
  if (!error && source.unsupported !== true) return null
  return { ...(error ? { error } : {}), ...(source.unsupported === true ? { unsupported: true as const } : {}) }
}

/** normalizeAccountQuota's own structure, rebuilt field by field (its error text can echo a gateway body). */
function projectNormalizedQuota(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const quota = value as Record<string, unknown>
  const windows = Array.isArray(quota.windows) ? quota.windows.slice(0, 32).map((raw) => {
    const window = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
    return {
      id: text(window.id, 120) ?? '', label: text(window.label, 120) ?? '',
      usedPercent: typeof window.usedPercent === 'number' && Number.isFinite(window.usedPercent) ? window.usedPercent : 0,
      resetsAt: text(window.resetsAt, 64) ?? null,
      windowSeconds: typeof window.windowSeconds === 'number' && Number.isFinite(window.windowSeconds) ? window.windowSeconds : null,
      severity: ['normal', 'warning', 'critical'].includes(String(window.severity)) ? window.severity : 'normal',
      scope: text(window.scope, 120) ?? null,
    }
  }) : []
  const credits = quota.resetCredits && typeof quota.resetCredits === 'object' ? quota.resetCredits as Record<string, unknown> : null
  return {
    plan: text(quota.plan, 120) ?? '',
    tier: text(quota.tier, 120) ?? '',
    resetCredits: credits ? {
      available: typeof credits.available === 'number' ? credits.available : 0,
      applicable: typeof credits.applicable === 'number' ? credits.applicable : 0,
      entries: Array.isArray(credits.entries) ? credits.entries.slice(0, 32).map((raw) => {
        const entry = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
        return { id: text(entry.id, 120) ?? '', expiresAt: text(entry.expiresAt, 64) ?? '' }
      }) : [],
    } : null,
    windows,
    error: typeof quota.error === 'string' && quota.error ? sanitizeSyncError(quota.error) : null,
    ...(quota.unsupported === true ? { unsupported: true } : {}),
  }
}

/**
 * One account of GET /api/monitor: the gateway fields the accounts and overview pages read, nothing else.
 * Raw `quota` (the vendor's usage bodies) is reduced to its error; tokens, cookies and keys never pass.
 */
export function projectMonitorAccount(file: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const field of MONITOR_TEXT_FIELDS) {
    const value = text(file[field])
    if (value !== undefined) out[field] = value
  }
  for (const field of ['disabled', 'unavailable'] as const) {
    if (typeof file[field] === 'boolean') out[field] = file[field]
  }
  if (typeof file.auth_index === 'string' || (typeof file.auth_index === 'number' && Number.isFinite(file.auth_index))) out.auth_index = file.auth_index
  if (typeof file.priority === 'number' && Number.isFinite(file.priority)) out.priority = file.priority
  if (typeof file.proxy_url === 'string') out.proxy_url = maskProxyUserinfo(file.proxy_url)
  const recent = projectRecent(file.recent_requests)
  if (recent) out.recent_requests = recent
  const quota = projectQuotaError(file.quota)
  if (quota) out.quota = quota
  if ('normalizedQuota' in file) out.normalizedQuota = projectNormalizedQuota(file.normalizedQuota)
  return out
}

/** Fields of a local credential file that may leave the credential store (everything else stays server-side). */
export const LOCAL_AUTH_FILE_FIELDS = ['type', 'provider', 'email', 'account', 'label', 'status', 'status_message', 'plan'] as const
