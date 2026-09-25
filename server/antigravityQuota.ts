import { apiCall, downloadAuthFile, type ApiCallResult } from './cpa.js'

export const ANTIGRAVITY_QUOTA_URLS = [
  'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary',
  'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:retrieveUserQuotaSummary',
  'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary',
] as const

export const ANTIGRAVITY_SUBSCRIPTION_URL = 'https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist'

const ANTIGRAVITY_HEADERS = {
  Authorization: 'Bearer $TOKEN$',
  'Content-Type': 'application/json',
  'User-Agent': 'antigravity/cli/1.0.13 (aidev_client; os_type=darwin; arch=arm64)',
}

type Dependencies = {
  apiCall: (authIndex: string | undefined, url: string, options?: { method?: string; header?: Record<string, string>; data?: string }) => Promise<ApiCallResult>
  downloadAuthFile: (name: string) => Promise<Record<string, unknown>>
}

export type AntigravitySubscription = {
  plan: 'free' | 'pro' | 'ultra' | 'ultra-lite' | 'unknown'
  tierId: string | null
  tierName: string | null
}

export type AntigravityAccountQuota = {
  groups: Array<Record<string, any>>
  subscription: AntigravitySubscription | null
}

const isRecord = (value: unknown): value is Record<string, any> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const stringValue = (value: unknown): string => typeof value === 'string' ? value.trim() : ''

function parseBody(result: ApiCallResult): Record<string, any> | null {
  const raw = result.body ?? result.body_text
  if (isRecord(raw)) return raw
  if (typeof raw !== 'string' || !raw.trim()) return null
  try {
    const parsed = JSON.parse(raw)
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

const field = (record: Record<string, any> | null, ...names: string[]): string => {
  if (!record) return ''
  for (const name of names) {
    const value = stringValue(record[name])
    if (value) return value
  }
  return ''
}

/** 兼容 CPA auth-file 摘要与 Google installed/web OAuth 文件的 project id 位置。 */
export function extractAntigravityProjectId(value: unknown): string {
  if (!isRecord(value)) return ''
  const direct = field(value, 'project_id', 'projectId')
  if (direct) return direct

  const metadata = isRecord(value.metadata) ? value.metadata : null
  const metadataId = field(metadata, 'project_id', 'projectId')
  if (metadataId) return metadataId

  const attributes = isRecord(value.attributes) ? value.attributes : null
  const attributeId = field(attributes, 'project_id', 'projectId', 'gemini_virtual_project')
  if (attributeId) return attributeId

  for (const key of ['installed', 'web']) {
    const nested = isRecord(value[key]) ? value[key] : null
    const nestedId = field(nested, 'project_id', 'projectId')
    if (nestedId) return nestedId
  }
  return ''
}

const statusCodeOf = (result: ApiCallResult) => Number(result.status_code ?? result.statusCode ?? 0)

function parseSubscription(result: ApiCallResult): AntigravitySubscription | null {
  const payload = parseBody(result)
  if (!payload) return null
  const current = isRecord(payload.currentTier ?? payload.current_tier) ? payload.currentTier ?? payload.current_tier : null
  const paid = isRecord(payload.paidTier ?? payload.paid_tier) ? payload.paidTier ?? payload.paid_tier : null
  const tier = field(paid, 'id') ? paid : current
  const tierId = field(tier, 'id') || null
  const tierName = field(tier, 'name') || null
  if (!tierId && !tierName) return null
  const plan = ({
    'free-tier': 'free',
    'g1-pro-tier': 'pro',
    'g1-ultra-tier': 'ultra',
    'g1-ultra-lite-tier': 'ultra-lite',
  } as const)[tierId as 'free-tier' | 'g1-pro-tier' | 'g1-ultra-tier' | 'g1-ultra-lite-tier'] ?? 'unknown'
  return { plan, tierId, tierName }
}

async function readSubscription(authIndex: string, call: Dependencies['apiCall']): Promise<AntigravitySubscription | null> {
  const result = await call(authIndex, ANTIGRAVITY_SUBSCRIPTION_URL, {
    method: 'POST',
    header: { ...ANTIGRAVITY_HEADERS },
    data: JSON.stringify({ metadata: { ideType: 'ANTIGRAVITY' } }),
  })
  const status = statusCodeOf(result)
  return status >= 200 && status < 300 ? parseSubscription(result) : null
}

/**
 * 通过 CPA 的 api-call 使用指定 OAuth 凭据读取 AntiGravity 额度。
 * 凭据原文只在内存中提取 project_id，不进入返回值与错误文本。
 */
export async function fetchAntigravityAccountQuota(
  file: Record<string, unknown>,
  dependencies: Dependencies = { apiCall, downloadAuthFile },
): Promise<AntigravityAccountQuota> {
  const authIndex = stringValue(file.auth_index ?? file.authIndex)
  if (!authIndex) throw new Error('AntiGravity 凭据缺少 auth_index')

  let projectId = extractAntigravityProjectId(file)
  if (!projectId) {
    const name = stringValue(file.name ?? file.filename)
    if (!name) throw new Error('AntiGravity 凭据缺少文件名')
    projectId = extractAntigravityProjectId(await dependencies.downloadAuthFile(name))
  }
  if (!projectId) throw new Error('AntiGravity 凭据缺少 project_id')

  const subscription = readSubscription(authIndex, dependencies.apiCall).catch(() => null)
  let lastStatus = 0
  for (const url of ANTIGRAVITY_QUOTA_URLS) {
    try {
      const result = await dependencies.apiCall(authIndex, url, {
        method: 'POST',
        header: { ...ANTIGRAVITY_HEADERS },
        data: JSON.stringify({ project: projectId }),
      })
      lastStatus = statusCodeOf(result)
      if (lastStatus < 200 || lastStatus >= 300) continue
      const payload = parseBody(result)
      const groups = Array.isArray(payload?.groups) ? payload.groups.filter(isRecord) : []
      if (!groups.length) continue
      return { groups, subscription: await subscription }
    } catch {
      // Google 同时提供 daily、sandbox 与正式 control-plane；单个域名的传输故障
      // 不应让整个账号卡片失效，继续尝试下一个等价只读端点。
    }
  }
  throw new Error(lastStatus ? `AntiGravity 额度接口返回 HTTP ${lastStatus}` : 'AntiGravity 额度接口未返回有效数据')
}
