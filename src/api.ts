async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error || `请求失败 ${response.status}`)
  return data as T
}

export const api = {
  session: () => request<{ authenticated: boolean }>('/api/session'),
  login: (username: string, password: string) => request('/api/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
  logout: () => request('/api/logout', { method: 'POST' }),
  bootstrap: <T>() => request<T>('/api/bootstrap'),
  analytics: <T>(days: number, keyId = '') => request<T>(`/api/analytics?days=${days}${keyId ? `&keyId=${encodeURIComponent(keyId)}` : ''}`),
  monitor: <T>() => request<T>('/api/monitor'),
  audit: <T>() => request<T>('/api/audit'),
  createKey: <T>(body: unknown) => request<T>('/api/keys', { method: 'POST', body: JSON.stringify(body) }),
  createRevealToken: (id: string) => request<{ token: string }>(`/api/keys/${id}/reveal-token`, { method: 'POST' }),
  revealKey: (id: string, token: string) => request<{ key: string }>(`/api/keys/${id}/reveal?token=${encodeURIComponent(token)}`),
  updateKey: <T>(id: string, body: unknown) => request<T>(`/api/keys/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteKey: (id: string) => request(`/api/keys/${id}`, { method: 'DELETE' }),
}
