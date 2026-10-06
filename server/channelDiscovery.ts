export type ChannelProtocol = 'openai' | 'claude' | 'responses'

/** 路由层的入参解析：未知值一律按 openai，但三个合法值必须原样通过（静默强转会吞掉 responses）。 */
export const parseChannelProtocol = (value: unknown): ChannelProtocol =>
  value === 'claude' || value === 'responses' ? value : 'openai'

export type DiscoveredModel = {
  id: string
  alias: string
}

const stripResourcePrefix = (value: string) => value.replace(/^\/?models\//i, '')

export function normalizeBaseUrl(value: string) {
  const trimmed = value.trim().replace(/\/+$/, '')
  const parsed = new URL(trimmed)
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Base URL 只支持 http 或 https')
  return parsed.toString().replace(/\/+$/, '')
}

/**
 * 兼容用户填 host 根路径、/v1，以及完整 /models 地址。按常见程度依次探测，
 * 上游任一路径返回模型列表即停止。'responses'（OpenAI Responses 中继）的模型列表
 * 与 Bearer 鉴权都是 OpenAI 形状，只有转发端点不同（内核 relay-mode），所以走 openai 分支。
 */
export function modelDiscoveryUrls(protocol: ChannelProtocol, rawBaseUrl: string) {
  const base = normalizeBaseUrl(rawBaseUrl)
  if (/\/models$/i.test(base)) return [base]
  if (/\/v1$/i.test(base) || /\/v1beta$/i.test(base)) return [`${base}/models`]
  if (protocol === 'claude') return [`${base}/v1/models`, `${base}/models`]
  return [`${base}/models`, `${base}/v1/models`]
}

export function defaultModelAlias(id: string) {
  const clean = stripResourcePrefix(id.trim())
  return /[A-Z]/.test(clean) ? clean.toLowerCase() : clean
}

function modelId(value: unknown): string {
  if (typeof value === 'string') return stripResourcePrefix(value.trim())
  if (!value || typeof value !== 'object') return ''
  const row = value as Record<string, unknown>
  return stripResourcePrefix(String(row.id ?? row.name ?? row.model ?? '').trim())
}

/** 支持 OpenAI data[]、Anthropic data[]、Gemini models[] 和直接数组。 */
export function normalizeDiscoveredModels(payload: unknown): DiscoveredModel[] {
  let value = payload
  if (typeof value === 'string') {
    try { value = JSON.parse(value) } catch { return [] }
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const row = value as Record<string, unknown>
    value = row.data ?? row.models ?? row.items ?? []
  }
  if (!Array.isArray(value)) return []

  const seen = new Set<string>()
  const models: DiscoveredModel[] = []
  for (const item of value) {
    const id = modelId(item)
    if (!id) continue
    const key = id.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    models.push({ id, alias: defaultModelAlias(id) })
  }
  return models.sort((a, b) => a.alias.localeCompare(b.alias))
}

export function validateChannelName(value: string) {
  const name = value.trim()
  if (!name) throw new Error('请输入渠道名')
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,47}$/.test(name)) {
    throw new Error('渠道名只能包含字母、数字、点、短横线和下划线，最长 48 位')
  }
  return name
}

export function validateSelectedModels(input: unknown): DiscoveredModel[] {
  if (!Array.isArray(input) || input.length === 0) throw new Error('至少选择一个模型')
  const seen = new Set<string>()
  return input.map((item) => {
    const row = item && typeof item === 'object' ? item as Record<string, unknown> : {}
    const id = String(row.id || '').trim()
    const alias = String(row.alias || '').trim()
    if (!id || !alias) throw new Error('模型名和公开别名不能为空')
    const key = alias.toLowerCase()
    if (seen.has(key)) throw new Error(`公开别名重复：${alias}`)
    seen.add(key)
    return { id, alias }
  })
}
