/**
 * Codex 的 wham 接口要求带 `Chatgpt-Account-Id`，这个 id 藏在凭据的 id_token（JWT）载荷里。
 * CPA 的 auth-files 会把 id_token 透出来，但位置不固定（顶层 / metadata / attributes）。
 */

const normalize = (value: unknown): string | null => {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

export function parseIdTokenPayload(value: unknown): Record<string, unknown> | null {
  const token = normalize(value)
  if (!token) return null
  const segments = token.split('.')
  if (segments.length < 2) return null
  try {
    const decoded = Buffer.from(segments[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
    const parsed = JSON.parse(decoded)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function resolveChatgptAccountId(file: Record<string, any>): string | null {
  const metadata = file?.metadata && typeof file.metadata === 'object' ? file.metadata : null
  const attributes = file?.attributes && typeof file.attributes === 'object' ? file.attributes : null
  for (const candidate of [file?.id_token, metadata?.id_token, attributes?.id_token]) {
    const payload = parseIdTokenPayload(candidate)
    const id = normalize(payload?.chatgpt_account_id ?? payload?.chatgptAccountId)
    if (id) return id
  }
  return null
}

export type ResetCredit = { id: string; status: string; grantedAt: string; expiresAt: string }

/** 只保留 codex_rate_limits 类型且状态可用的额度，其余（已用、其他类型）不该出现在可重置计数里。 */
export function normalizeResetCredits(payload: unknown): { availableCount: number | null; credits: ResetCredit[] } {
  let parsed = payload
  if (typeof payload === 'string') {
    try {
      parsed = JSON.parse(payload)
    } catch {
      return { availableCount: null, credits: [] }
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { availableCount: null, credits: [] }
  const record = parsed as Record<string, any>
  const rawCount = record.available_count ?? record.availableCount
  const availableCount = Number.isFinite(Number(rawCount)) && rawCount !== null ? Number(rawCount) : null
  const credits: ResetCredit[] = Array.isArray(record.credits)
    ? record.credits
        .filter((item: any) => {
          const type = normalize(item?.reset_type ?? item?.resetType)
          return type === 'codex_rate_limits' && normalize(item?.status) === 'available'
        })
        .map((item: any) => ({
          id: normalize(item?.id) ?? '',
          status: normalize(item?.status) ?? '',
          grantedAt: normalize(item?.granted_at ?? item?.grantedAt) ?? '',
          expiresAt: normalize(item?.expires_at ?? item?.expiresAt) ?? '',
        }))
        .filter((credit: ResetCredit) => credit.expiresAt)
    : []
  return { availableCount, credits }
}
