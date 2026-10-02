import type {
  AccountLoginAction,
  AccountsCatalog,
  AccountsData,
  AccountsQuotaRefresh,
  MagpieAccountProvider,
  MagpieCodexReset,
  SignInView,
} from '../types'
import { request } from './http'

/**
 * /api/accounts (admin only). Errors are ApiError with `code` (e.g. `risk_unconfirmed`, `signin_gated`,
 * `callback_mismatch`, `account_active`, `kernel_outdated`, `cpa_backend`) and a zh `error` line.
 */
export const accountsApi = {
  list: (signal?: AbortSignal) => request<AccountsData>('/api/accounts', { signal, cache: 'no-cache' }),
  catalog: (signal?: AbortSignal) => request<AccountsCatalog>('/api/accounts/catalog', { signal }),
  signIn: (agent: string, options: { site?: string; confirmRisk?: boolean } = {}) =>
    request<SignInView>('/api/accounts/signin', { method: 'POST', body: JSON.stringify({ agent, ...options }) }),
  signInStatus: (id: string, signal?: AbortSignal) => request<SignInView>(`/api/accounts/signin/${encodeURIComponent(id)}`, { signal }),
  /** the browser's final localhost address; 202 with the sign-in view */
  submitCallback: (id: string, url: string) =>
    request<SignInView>(`/api/accounts/signin/${encodeURIComponent(id)}/callback`, { method: 'POST', body: JSON.stringify({ url }) }),
  cancelSignIn: (id: string) => request<SignInView>(`/api/accounts/signin/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: '{}' }),
  login: (action: AccountLoginAction, agent: string, id: string) =>
    request<{ ok: boolean; provider: MagpieAccountProvider | null }>(`/api/accounts/login/${action}`, { method: 'POST', body: JSON.stringify({ agent, id }) }),
  codexReset: (id: string) => request<MagpieCodexReset>('/api/accounts/codex-reset', { method: 'POST', body: JSON.stringify({ id }) }),
  refreshQuota: (agent?: string) => request<AccountsQuotaRefresh>('/api/accounts/quota/refresh', { method: 'POST', body: JSON.stringify(agent ? { agent } : {}) }),
}
