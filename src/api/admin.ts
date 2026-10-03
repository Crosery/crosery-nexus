import type {
  AutoupdateView,
  CredentialUploadResult,
  GatewaySettings,
  GatewaySettingValues,
  MagpieUpdateStatus,
  ModelSyncResult,
  OAuthStartResult,
  OAuthStatusResult,
  PulseData,
  RtkPlaneId,
  RtkPlaneProbe,
  RTKRollbackResponse,
  RTKStatusResponse,
  RTKToggleResponse,
  VersionsData,
} from '../types'
import { ApiError, request } from './http'

/** RTK 接口的错误带平面与原因码，UI 才能如实说明「哪个平面不支持、为什么」。 */
export class RtkApiError extends ApiError {
  readonly plane?: RtkPlaneId
  readonly reason?: string
  readonly backup?: string

  constructor(status: number, message: string, body: Record<string, unknown> = {}, retryAfterSec: number | null = null) {
    super(status, message, body, retryAfterSec)
    this.name = 'RtkApiError'
    this.plane = typeof body.plane === 'string' ? (body.plane as RtkPlaneId) : undefined
    this.reason = typeof body.reason === 'string' ? body.reason : undefined
    this.backup = typeof body.backup === 'string' ? body.backup : undefined
  }
}

const rtkRequest = <T>(url: string, init: RequestInit = {}) =>
  request<T>(url, init, (status, message, body, retryAfterSec) => new RtkApiError(status, message, body, retryAfterSec))

const scoped = (path: string, days: number, keyId = '') => `${path}?days=${days}${keyId ? `&keyId=${encodeURIComponent(keyId)}` : ''}`

/** Admin-only endpoints (a key session gets 403 `forbidden_role` on every one of them). */
export const adminApi = {
  bootstrap: <T>() => request<T>('/api/bootstrap'),
  dashboard: <T>(days: number, keyId = '') => request<T>(scoped('/api/dashboard', days, keyId)),
  analytics: <T>(days: number, keyId = '') => request<T>(scoped('/api/analytics', days, keyId)),
  charts: <T>(days: number, keyId = '') => request<T>(scoped('/api/charts', days, keyId)),
  chartsLatency: <T>(days: number, keyId = '') => request<T>(scoped('/api/charts-latency', days, keyId)),
  usagePage: <T>(days: number, keyId = '') => request<T>(scoped('/api/usage-page', days, keyId)),
  usageKeySummaries: <T>(days: number) => request<T>(`/api/usage-key-summaries?days=${days}`),
  usageOverview: <T>(days: number, keyId = '') => request<T>(scoped('/api/usage-overview', days, keyId)),
  monitor: <T>() => request<T>('/api/monitor'),
  resetCodexQuota: (authIndex: string) =>
    request<{ ok: boolean; cooldownCleared: boolean }>(`/api/accounts/${encodeURIComponent(authIndex)}/reset-codex-quota`, { method: 'POST' }),
  resetClaudeQuota: (authIndex: string) =>
    request<{ ok: boolean; cooldownCleared: boolean }>(`/api/accounts/${encodeURIComponent(authIndex)}/reset-claude-quota`, { method: 'POST' }),
  audit: <T>() => request<T>('/api/audit'),
  createKey: <T>(body: unknown) => request<T>('/api/keys', { method: 'POST', body: JSON.stringify(body) }),
  createRevealToken: (id: string) => request<{ token: string }>(`/api/keys/${id}/reveal-token`, { method: 'POST' }),
  revealKey: (id: string, token: string) => request<{ key: string }>(`/api/keys/${id}/reveal?token=${encodeURIComponent(token)}`),
  updateKey: <T>(id: string, body: unknown) => request<T>(`/api/keys/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteKey: (id: string) => request(`/api/keys/${id}`, { method: 'DELETE' }),
  updateQuota: <T>(id: string, body: { totalUsd: number; dailyUsd: number; weeklyUsd: number }) =>
    request<T>(`/api/keys/${id}/quota`, { method: 'PATCH', body: JSON.stringify(body) }),
  resetQuota: <T>(id: string, window: 'total' | 'daily' | 'weekly') =>
    request<T>(`/api/keys/${id}/quota/reset`, { method: 'POST', body: JSON.stringify({ window }) }),
  /** fresh=true 时服务端先丢掉网关快照（每端点每 60s 至多一次），让 CPA 官方面板里的改动立刻可见。 */
  channels: <T>(fresh = false) => request<T>(`/api/channels${fresh ? '?fresh=1' : ''}`),
  discoverChannelModels: (body: { protocol: 'openai' | 'claude'; baseUrl: string; apiKey: string }) =>
    request<{ models: Array<{ id: string; alias: string }>; endpoint: string }>('/api/channels/discover', { method: 'POST', body: JSON.stringify(body) }),
  createChannel: (body: { name: string; protocol: 'openai' | 'claude'; baseUrl: string; apiKey: string; models: Array<{ id: string; alias: string }> }) =>
    request('/api/channels', { method: 'POST', body: JSON.stringify(body) }),
  pruneStaleChannels: () => request<{ removed: string[] }>('/api/channels/prune-stale', { method: 'POST' }),
  setChannelEnabled: (name: string, enabled: boolean) =>
    request(`/api/channels/${encodeURIComponent(name)}`, { method: 'PATCH', body: JSON.stringify({ enabled }) }),
  deleteChannel: (name: string) => request(`/api/channels/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  setModelEnabled: (name: string, model: string, enabled: boolean) =>
    request(`/api/channels/${encodeURIComponent(name)}/models/${encodeURIComponent(model)}`, { method: 'PATCH', body: JSON.stringify({ enabled }) }),
  /** Account management on existing credentials (pause/resume, delete, proxy). Credential *import* is gone (C5). */
  setCredentialEnabled: (name: string, enabled: boolean) =>
    request(`/api/credentials/${encodeURIComponent(name)}`, { method: 'PATCH', body: JSON.stringify({ enabled }) }),
  deleteCredential: (name: string) => request(`/api/credentials/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  credentialProxy: (name: string) => request<{ proxyUrl: string }>(`/api/credentials/${encodeURIComponent(name)}/proxy`),
  setCredentialProxy: (name: string, proxyUrl: string) =>
    request<{ proxyUrl: string }>(`/api/credentials/${encodeURIComponent(name)}/proxy`, { method: 'PATCH', body: JSON.stringify({ proxyUrl }) }),
  modelIndex: <T>(fresh = false) => request<T>(`/api/model-index${fresh ? '?fresh=1' : ''}`),
  usageBreakdown: <T>(days: number, keyId = '') => request<T>(scoped('/api/usage-breakdown', days, keyId)),
  cacheAnalytics: <T>(days: number, model = '') => request<T>(`/api/cache-analytics?days=${days}${model ? `&model=${encodeURIComponent(model)}` : ''}`),
  cacheTrend: <T>(hours: number, model = '', client = '', keyId = '', provider = '') =>
    request<T>(`/api/cache-trend?hours=${hours}${model ? `&model=${encodeURIComponent(model)}` : ''}${client ? `&client=${encodeURIComponent(client)}` : ''}${keyId ? `&keyId=${encodeURIComponent(keyId)}` : ''}${provider ? `&provider=${encodeURIComponent(provider)}` : ''}`),
  /** 实时流 SSE 地址；与 cacheTrend 使用同一组筛选参数，保证趋势图与实时流同口径。 */
  cacheLiveUrl: (limit: number, model = '', client = '', keyId = '', provider = '') =>
    `/api/cache-live?limit=${limit}${model ? `&model=${encodeURIComponent(model)}` : ''}${client ? `&client=${encodeURIComponent(client)}` : ''}${keyId ? `&keyId=${encodeURIComponent(keyId)}` : ''}${provider ? `&provider=${encodeURIComponent(provider)}` : ''}`,
  setModelSourceEnabled: (model: string, channel: string, kind: 'compat' | 'oauth', enabled: boolean) =>
    request(`/api/model-index/${encodeURIComponent(model)}/sources/${encodeURIComponent(channel)}`, { method: 'PATCH', body: JSON.stringify({ kind, enabled }) }),
  /** fresh=true is honoured at most once per 60s per endpoint server-side. */
  version: (fresh = false) => request<VersionsData>(`/api/version${fresh ? '?fresh=1' : ''}`),
  syncUpstreamModels: () => request<ModelSyncResult>('/api/models/sync', { method: 'POST' }),
  /**
   * magpie 内核更新（task-79 端点）。状态只读；`apply` 必须显式 `confirm: true`，
   * 服务端缺确认会 403 `confirm_required` 且**一次脚本调用都不发生**。
   */
  getMagpieUpdateStatus: () => request<MagpieUpdateStatus>('/api/magpie/update-status'),
  runMagpieUpdate: (action: 'check' | 'rehearse' | 'apply', confirm = false) =>
    request<Record<string, unknown>>('/api/magpie/update', { method: 'POST', body: JSON.stringify({ action, confirm }) }),
  /** 「自动更新」开关与状态；只写开关，替换由 launchd 定时任务做（server/autoupdate.ts）。 */
  autoupdate: {
    get: () => request<AutoupdateView>('/api/autoupdate'),
    set: (patch: { magpie?: { enabled?: boolean; window?: { start: string; end: string } }; rtk?: { enabled?: boolean } }) =>
      request<AutoupdateView>('/api/autoupdate', { method: 'PUT', body: JSON.stringify(patch) }),
  },
  getRTKStatus: () => rtkRequest<RTKStatusResponse>('/api/rtk/status'),
  getRTKPlanes: () => rtkRequest<{ plane: RtkPlaneId; planes: RtkPlaneProbe[]; fellBack: boolean }>('/api/rtk/planes'),
  /** plane 默认 local：只有本机才有用户的 agent 配置；远端下发需显式指定并确认。 */
  toggleRTK: (agent: string, on: boolean, options: { plane?: RtkPlaneId; confirm?: boolean } = {}) =>
    rtkRequest<RTKToggleResponse>('/api/rtk/toggle', {
      method: 'POST',
      body: JSON.stringify({ agent, on, plane: options.plane || 'local', confirm: options.confirm === true }),
    }),
  installRTK: (options: { plane?: RtkPlaneId; confirm?: boolean } = {}) =>
    rtkRequest<RTKStatusResponse>('/api/rtk/install', { method: 'POST', body: JSON.stringify(options) }),
  upgradeRTK: (options: { plane?: RtkPlaneId; confirm?: boolean } = {}) =>
    rtkRequest<RTKStatusResponse>('/api/rtk/upgrade', { method: 'POST', body: JSON.stringify(options) }),
  rollbackRTK: (backup?: string) =>
    rtkRequest<RTKRollbackResponse>('/api/rtk/rollback', { method: 'POST', body: JSON.stringify({ backup, confirm: true }) }),
  startOAuth: (provider: string) => request<OAuthStartResult>('/api/cpa/oauth/start', { method: 'POST', body: JSON.stringify({ provider }) }),
  getOAuthStatus: (state: string) => request<OAuthStatusResult>(`/api/cpa/oauth/status?state=${encodeURIComponent(state)}`),
  submitOAuthCallback: (provider: string, redirectUrl: string, state?: string) =>
    request<{ ok: boolean }>('/api/cpa/oauth/callback', { method: 'POST', body: JSON.stringify({ provider, redirectUrl, state }) }),
  cancelOAuth: (state: string) => request<{ ok: boolean }>('/api/cpa/oauth/cancel', { method: 'POST', body: JSON.stringify({ state }) }),
  /**
   * Bulk import of CPA auth files (one JSON, or a ZIP of them); CPA engine only. Multipart, so not `request()`:
   * its JSON content type would replace the browser's boundary.
   */
  uploadCredentials: async (file: File): Promise<CredentialUploadResult> => {
    const form = new FormData()
    form.set('file', file, file.name)
    const response = await fetch('/api/credentials/upload', { method: 'POST', body: form })
    const data = (await response.json().catch(() => ({}))) as Record<string, unknown>
    if (response.ok) return data as CredentialUploadResult
    const error = (data.error && typeof data.error === 'object' ? data.error : {}) as { message?: string; code?: string }
    throw new ApiError(response.status, error.message || `导入失败（HTTP ${response.status}）`, { code: error.code })
  },
  addApiKey: (provider: string, apiKey: string) =>
    request<{ ok: boolean }>('/api/cpa/credentials/api-key', { method: 'POST', body: JSON.stringify({ provider, apiKey }) }),
  /** 网关功能：Magpie 内核的脱敏 / 识图 / 生图设置（CPA 模式 available:false）。PUT 只带要改的键。 */
  gatewaySettings: (signal?: AbortSignal) => request<GatewaySettings>('/api/gateway/settings', { signal }),
  setGatewaySettings: (patch: Partial<GatewaySettingValues>) =>
    request<GatewaySettings>('/api/gateway/settings', { method: 'PUT', body: JSON.stringify(patch) }),
  /** Header live edge + statusline gateway figures (see CONTRACTS "C6 gateway pulse"). */
  pulse: (signal?: AbortSignal) => request<PulseData>('/api/pulse', { signal }),
}
