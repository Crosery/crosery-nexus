import { createHash } from 'node:crypto'
import { config } from './config.js'

export type UsageRecord = {
  timestamp?: string
  provider?: string
  model?: string
  alias?: string
  endpoint?: string
  api_key?: string
  request_id?: string
  latency_ms?: number
  ttft_ms?: number
  failed?: boolean
  fail?: { status_code?: number }
  tokens?: {
    input_tokens?: number
    output_tokens?: number
    reasoning_tokens?: number
    cached_tokens?: number
    total_tokens?: number
  }
}

async function cpaRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!config.cpaManagementKey) throw new Error('CPA_MANAGEMENT_KEY 未配置')
  const response = await fetch(`${config.cpaBaseUrl}/v0/management${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${config.cpaManagementKey}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  })
  if (!response.ok) {
    const text = await response.text()
    throw new Error(`CPA ${response.status}: ${text.slice(0, 240)}`)
  }
  return response.json() as Promise<T>
}

export const hashKey = (key: string) => createHash('sha256').update(key).digest('hex')
export const maskKey = (key: string) => `${key.slice(0, 7)}••••••••${key.slice(-5)}`

export async function getCPAKeys(): Promise<string[]> {
  const result = await cpaRequest<{ 'api-keys': string[] }>('/api-keys')
  return result['api-keys'] || []
}

export async function replaceCPAKeys(keys: string[]) {
  return cpaRequest('/api-keys', { method: 'PUT', body: JSON.stringify(keys) })
}

export async function getModelAccess(): Promise<Record<string, string[]>> {
  try {
    return await cpaRequest<Record<string, string[]>>('/api-key-model-access')
  } catch {
    return {}
  }
}

export async function putModelAccess(access: Record<string, string[]>) {
  return cpaRequest('/api-key-model-access', { method: 'PUT', body: JSON.stringify(access) })
}

export async function listModels(): Promise<string[]> {
  const keys = await getCPAKeys()
  if (!keys.length) return []
  const response = await fetch(`${config.cpaBaseUrl}/v1/models`, {
    headers: { Authorization: `Bearer ${keys[0]}` },
  })
  if (!response.ok) return []
  const result = await response.json() as { data?: Array<{ id?: string }> }
  return [...new Set((result.data || []).map((item) => item.id || '').filter(Boolean))].sort()
}

export async function popUsage(count = 200): Promise<UsageRecord[]> {
  return cpaRequest<UsageRecord[]>(`/usage-queue?count=${count}`)
}

export async function listAuthFiles() {
  return cpaRequest<{ files: Array<Record<string, unknown>> }>('/auth-files')
}

export async function apiCall(authIndex: string, url: string) {
  return cpaRequest<{ status_code?: number; statusCode?: number; body?: unknown; body_text?: string }>('/api-call', {
    method: 'POST',
    body: JSON.stringify({
      auth_index: authIndex,
      method: 'GET',
      url,
      header: {
        Authorization: 'Bearer $TOKEN$',
        'Content-Type': 'application/json',
        'anthropic-beta': 'oauth-2025-04-20',
      },
    }),
  })
}

export async function getClaudeAccountMonitor(authIndex: string) {
  const [usage, profile] = await Promise.all([
    apiCall(authIndex, 'https://api.anthropic.com/api/oauth/usage'),
    apiCall(authIndex, 'https://api.anthropic.com/api/oauth/profile'),
  ])
  return { usage, profile }
}

export function groupForModel(model: string, provider = '') {
  const haystack = `${model} ${provider}`.toLowerCase()
  return config.groups.find((group) => group.match.some((term) => haystack.includes(term)))?.id || 'other'
}
