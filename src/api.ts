import type { MagpieUpdateStatus, ModelSyncResult, OAuthStartResult, OAuthStatusResult, RtkPlaneId, RtkPlaneProbe, RTKRollbackResponse, RTKStatusResponse, RTKToggleResponse, VersionsData } from './types'

async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error || `请求失败 ${response.status}`)
  return data as T
}

/** RTK 接口的错误带平面与原因码，UI 才能如实说明「哪个平面不支持、为什么」。 */
export class RtkApiError extends Error {
  readonly status: number
  readonly plane?: RtkPlaneId
  readonly reason?: string
  readonly backup?: string

  constructor(status: number, message: string, plane?: RtkPlaneId, reason?: string, backup?: string) {
    super(message)
    this.name = 'RtkApiError'
    this.status = status
    this.plane = plane
    this.reason = reason
    this.backup = backup
  }
}

async function rtkRequest<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new RtkApiError(response.status, data.error || `请求失败 ${response.status}`, data.plane, data.reason, data.backup)
  }
  return data as T
}

export const api = {
  session: () => request<{ authenticated: boolean }>('/api/session'),
  login: (username: string, password: string) => request('/api/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
  logout: () => request('/api/logout', { method: 'POST' }),
  bootstrap: <T>() => request<T>('/api/bootstrap'),
  dashboard: <T>(days: number, keyId = '') => request<T>(`/api/dashboard?days=${days}${keyId ? `&keyId=${encodeURIComponent(keyId)}` : ''}`),
  analytics: <T>(days: number, keyId = '') => request<T>(`/api/analytics?days=${days}${keyId ? `&keyId=${encodeURIComponent(keyId)}` : ''}`),
  charts: <T>(days: number, keyId = '') => request<T>(`/api/charts?days=${days}${keyId ? `&keyId=${encodeURIComponent(keyId)}` : ''}`),
  chartsLatency: <T>(days: number, keyId = '') => request<T>(`/api/charts-latency?days=${days}${keyId ? `&keyId=${encodeURIComponent(keyId)}` : ''}`),
  usagePage: <T>(days: number, keyId = '') => request<T>(`/api/usage-page?days=${days}${keyId ? `&keyId=${encodeURIComponent(keyId)}` : ''}`),
  usageKeySummaries: <T>(days: number) => request<T>(`/api/usage-key-summaries?days=${days}`),
  usageOverview: <T>(days: number, keyId = '') => request<T>(`/api/usage-overview?days=${days}${keyId ? `&keyId=${encodeURIComponent(keyId)}` : ''}`),
  monitor: <T>() => request<T>('/api/monitor'),
  resetCodexQuota: (authIndex: string) => request<{ ok: boolean; cooldownCleared: boolean }>(`/api/accounts/${encodeURIComponent(authIndex)}/reset-codex-quota`, { method: 'POST' }),
  resetClaudeQuota: (authIndex: string) => request<{ ok: boolean; cooldownCleared: boolean }>(`/api/accounts/${encodeURIComponent(authIndex)}/reset-claude-quota`, { method: 'POST' }),
  audit: <T>() => request<T>('/api/audit'),
  createKey: <T>(body: unknown) => request<T>('/api/keys', { method: 'POST', body: JSON.stringify(body) }),
  createRevealToken: (id: string) => request<{ token: string }>(`/api/keys/${id}/reveal-token`, { method: 'POST' }),
  revealKey: (id: string, token: string) => request<{ key: string }>(`/api/keys/${id}/reveal?token=${encodeURIComponent(token)}`),
  updateKey: <T>(id: string, body: unknown) => request<T>(`/api/keys/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteKey: (id: string) => request(`/api/keys/${id}`, { method: 'DELETE' }),
  updateQuota: <T>(id: string, body: { totalUsd: number; dailyUsd: number; weeklyUsd: number }) => request<T>(`/api/keys/${id}/quota`, { method: 'PATCH', body: JSON.stringify(body) }),
  resetQuota: <T>(id: string, window: 'total' | 'daily' | 'weekly') => request<T>(`/api/keys/${id}/quota/reset`, { method: 'POST', body: JSON.stringify({ window }) }),
  /** fresh=true 时服务端先丢掉网关快照，让 CPA 官方面板里的改动立刻可见。 */
  channels: <T>(fresh = false) => request<T>(`/api/channels${fresh ? '?fresh=1' : ''}`),
  discoverChannelModels: (body: { protocol: 'openai' | 'claude'; baseUrl: string; apiKey: string }) =>
    request<{ models: Array<{ id: string; alias: string }>; endpoint: string }>('/api/channels/discover', { method: 'POST', body: JSON.stringify(body) }),
  createChannel: (body: { name: string; protocol: 'openai' | 'claude'; baseUrl: string; apiKey: string; models: Array<{ id: string; alias: string }> }) =>
    request('/api/channels', { method: 'POST', body: JSON.stringify(body) }),
  pruneStaleChannels: () => request<{ removed: string[] }>('/api/channels/prune-stale', { method: 'POST' }),
  setChannelEnabled: (name: string, enabled: boolean) => request(`/api/channels/${encodeURIComponent(name)}`, { method: 'PATCH', body: JSON.stringify({ enabled }) }),
  deleteChannel: (name: string) => request(`/api/channels/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  setModelEnabled: (name: string, model: string, enabled: boolean) => request(`/api/channels/${encodeURIComponent(name)}/models/${encodeURIComponent(model)}`, { method: 'PATCH', body: JSON.stringify({ enabled }) }),
  setCredentialEnabled: (name: string, enabled: boolean) => request(`/api/credentials/${encodeURIComponent(name)}`, { method: 'PATCH', body: JSON.stringify({ enabled }) }),
  deleteCredential: (name: string) => request(`/api/credentials/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  credentialProxy: (name: string) => request<{ proxyUrl: string }>(`/api/credentials/${encodeURIComponent(name)}/proxy`),
  setCredentialProxy: (name: string, proxyUrl: string) => request<{ proxyUrl: string }>(`/api/credentials/${encodeURIComponent(name)}/proxy`, { method: 'PATCH', body: JSON.stringify({ proxyUrl }) }),
  uploadCredentials: async <T>(file: File): Promise<T> => {
    const form = new FormData()
    form.set('file', file)
    const response = await fetch('/api/credentials/upload', { method: 'POST', body: form })
    const data = await response.json().catch(() => ({}))
    if (!response.ok && response.status !== 207) {
      const error = data?.error
      const message = error?.message || `上传失败 ${response.status}`
      throw new Error(`${message}${error?.traceId ? ` · Trace ID ${error.traceId}` : ''}`)
    }
    return data as T
  },
  modelIndex: <T>(fresh = false) => request<T>(`/api/model-index${fresh ? '?fresh=1' : ''}`),
  usageBreakdown: <T>(days: number, keyId = '') => request<T>(`/api/usage-breakdown?days=${days}${keyId ? `&keyId=${encodeURIComponent(keyId)}` : ''}`),
  cacheAnalytics: <T>(days: number, model = '') => request<T>(`/api/cache-analytics?days=${days}${model ? `&model=${encodeURIComponent(model)}` : ''}`),
  cacheTrend: <T>(hours: number, model = '', client = '', keyId = '', provider = '') => request<T>(`/api/cache-trend?hours=${hours}${model ? `&model=${encodeURIComponent(model)}` : ''}${client ? `&client=${encodeURIComponent(client)}` : ''}${keyId ? `&keyId=${encodeURIComponent(keyId)}` : ''}${provider ? `&provider=${encodeURIComponent(provider)}` : ''}`),
  /** 实时流 SSE 地址；与 cacheTrend 使用同一组筛选参数，保证趋势图与实时流同口径。 */
  cacheLiveUrl: (limit: number, model = '', client = '', keyId = '', provider = '') => `/api/cache-live?limit=${limit}${model ? `&model=${encodeURIComponent(model)}` : ''}${client ? `&client=${encodeURIComponent(client)}` : ''}${keyId ? `&keyId=${encodeURIComponent(keyId)}` : ''}${provider ? `&provider=${encodeURIComponent(provider)}` : ''}`,
  setModelSourceEnabled: (model: string, channel: string, kind: 'compat' | 'oauth', enabled: boolean) =>
    request(`/api/model-index/${encodeURIComponent(model)}/sources/${encodeURIComponent(channel)}`, { method: 'PATCH', body: JSON.stringify({ kind, enabled }) }),
  version: () => request<VersionsData>('/api/version'),
  syncUpstreamModels: () => request<ModelSyncResult>('/api/models/sync', { method: 'POST' }),
  /**
   * magpie 内核更新（task-79 端点）。状态只读；`apply` 必须显式 `confirm: true`，
   * 服务端缺确认会 403 `confirm_required` 且**一次脚本调用都不发生**。
   */
  getMagpieUpdateStatus: () => request<MagpieUpdateStatus>('/api/magpie/update-status'),
  runMagpieUpdate: (action: 'check' | 'rehearse' | 'apply', confirm = false) =>
    request<Record<string, unknown>>('/api/magpie/update', { method: 'POST', body: JSON.stringify({ action, confirm }) }),
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
  startOAuth: (provider: string) => request<OAuthStartResult>('/api/cpa/oauth/start', {
    method: 'POST',
    body: JSON.stringify({ provider }),
  }),
  getOAuthStatus: (state: string) => request<OAuthStatusResult>(`/api/cpa/oauth/status?state=${encodeURIComponent(state)}`),
  submitOAuthCallback: (provider: string, redirectUrl: string, state?: string) => request<{ ok: boolean }>('/api/cpa/oauth/callback', {
    method: 'POST',
    body: JSON.stringify({ provider, redirectUrl, state }),
  }),
  cancelOAuth: (state: string) => request<{ ok: boolean }>('/api/cpa/oauth/cancel', {
    method: 'POST',
    body: JSON.stringify({ state }),
  }),
  addApiKey: (provider: string, apiKey: string) => request<{ ok: boolean }>('/api/cpa/credentials/api-key', {
    method: 'POST',
    body: JSON.stringify({ provider, apiKey }),
  }),
}
