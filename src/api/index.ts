import type { LoginResult, SessionInfo } from '../types'
import { request } from './http'
import { adminApi } from './admin'
import { meApi } from './me'
import { rtkGlobalApi, syncApi } from './sync'
import { accountsApi } from './accounts'
import { proxyApi } from './proxy'

export { ApiError, setAuthHooks } from './http'
export { RtkApiError } from './admin'

/** Session (C1): shared by both roles. A failed login rejects with ApiError (`code` + `retryAfterSec` on 429). */
const sessionApi = {
  session: () => request<SessionInfo>('/api/session'),
  login: (username: string, password: string) => request<LoginResult>('/api/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
  loginWithKey: (apiKey: string) => request<LoginResult>('/api/login', { method: 'POST', body: JSON.stringify({ apiKey }) }),
  logout: () => request<{ ok: boolean }>('/api/logout', { method: 'POST' }),
}

/** The one client object. Admin endpoints stay flat (existing callers), the newer areas are namespaced. */
export const api = {
  ...sessionApi,
  ...adminApi,
  me: meApi,
  sync: syncApi,
  rtkGlobal: rtkGlobalApi,
  accounts: accountsApi,
  proxies: proxyApi,
}
