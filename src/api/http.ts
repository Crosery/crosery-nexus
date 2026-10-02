/**
 * One fetch wrapper for every console endpoint.
 *
 * Errors are `ApiError` (status + server `code` + Retry-After), so callers and `lib/errors.ts` read the status
 * from a field instead of parsing message text. Two responses are global concerns and go to the hooks the app
 * installs (`src/app/session.ts`):
 * - 401 on anything except the login/session probes → the session is gone (expired, revoked, key deleted or
 *   disabled) → back to /login.
 * - 403 with a role code (`forbidden_role`, `not_key_session`) → this role may not see the endpoint → role home.
 * Other 403s (RTK `confirmation_required`, `write_disabled` …) are ordinary errors for the page to show.
 */

export class ApiError extends Error {
  readonly status: number
  /** server error code, e.g. `key_invalid`, `rate_limited`, `cooldown` */
  readonly code: string | null
  /** seconds from the body (`retryAfterSec`) or the Retry-After header */
  readonly retryAfterSec: number | null
  readonly body: Record<string, unknown>

  constructor(status: number, message: string, body: Record<string, unknown> = {}, retryAfterSec: number | null = null) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = typeof body.code === 'string' ? body.code : null
    this.retryAfterSec = retryAfterSec
    this.body = body
  }
}

export const ROLE_DENIED_CODES = new Set(['forbidden_role', 'not_key_session'])

type AuthHooks = {
  onUnauthorized?: (error: ApiError, url: string) => void
  onRoleDenied?: (error: ApiError, url: string) => void
}
let hooks: AuthHooks = {}

export function setAuthHooks(next: AuthHooks) {
  hooks = next
}

/** Probes whose 401 is an answer, not an expired session. */
const AUTH_PROBES = ['/api/login', '/api/session', '/api/logout']

function pathOf(url: string): string {
  const q = url.indexOf('?')
  return (q === -1 ? url : url.slice(0, q)).toLowerCase()
}

function messageOf(body: Record<string, unknown>, status: number): string {
  const raw = body.error
  if (typeof raw === 'string' && raw.trim()) return raw
  if (raw && typeof raw === 'object' && typeof (raw as { message?: unknown }).message === 'string') {
    const nested = raw as { message: string; traceId?: string }
    return nested.traceId ? `${nested.message} · Trace ID ${nested.traceId}` : nested.message
  }
  return `请求失败 ${status}`
}

function retryAfterOf(body: Record<string, unknown>, response: Response): number | null {
  if (typeof body.retryAfterSec === 'number' && Number.isFinite(body.retryAfterSec)) return body.retryAfterSec
  const header = Number(response.headers.get('Retry-After'))
  return Number.isFinite(header) && header > 0 ? header : null
}

export type ErrorFactory = (status: number, message: string, body: Record<string, unknown>, retryAfterSec: number | null) => ApiError

export async function request<T>(url: string, init: RequestInit = {}, factory?: ErrorFactory): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
  })
  const data = (await response.json().catch(() => ({}))) as unknown
  if (response.ok) return data as T

  const body = data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : {}
  const message = messageOf(body, response.status)
  const retryAfterSec = retryAfterOf(body, response)
  const error = factory
    ? factory(response.status, message, body, retryAfterSec)
    : new ApiError(response.status, message, body, retryAfterSec)
  const path = pathOf(url)
  if (response.status === 401 && !AUTH_PROBES.includes(path)) hooks.onUnauthorized?.(error, url)
  else if (response.status === 403 && error.code && ROLE_DENIED_CODES.has(error.code)) hooks.onRoleDenied?.(error, url)
  throw error
}

export const json = (body: unknown): RequestInit => ({ body: JSON.stringify(body) })

/** `?a=1&b=x` from the defined, non-empty entries (order kept). */
export function qs(params: Record<string, string | number | boolean | null | undefined>): string {
  const parts: string[] = []
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
  }
  return parts.length ? `?${parts.join('&')}` : ''
}
