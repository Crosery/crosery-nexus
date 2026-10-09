/**
 * CPA's OAuth session error (get-auth-status `error`) in words the person can act on. CPA writes e.g.
 * `Failed to exchange authorization code for tokens: token exchange failed with status 400: {"error":{…
 * "type":"invalid_request_error"…}}` (Codex), the bare `Failed to exchange authorization code for tokens` (Claude)
 * or `Failed to exchange token` (Antigravity). Two cases get a sentence; the raw text rides along as `detail`.
 * Anything else stays as CPA wrote it.
 */

export const OAUTH_REGION_TEXT = '登录被上游按地区拒绝 · 浏览器需要用美国出口打开授权页'
export const OAUTH_CODE_TEXT = '授权码无效、已用过或已过期 · 重新点「打开授权页」登录后再粘贴'

/** OpenAI's region refusal (`unsupported_country_region_territory`, "Country, region, or territory not supported"), or a 403 from OpenAI's sign-in. */
function regionRefused(raw: string): boolean {
  if (/unsupported[_\s-]*(country|region|territory)|country,?\s*region,?\s*or\s*territory/i.test(raw)) return true
  return /\b403\b/.test(raw) && /openai/i.test(raw)
}

/** The provider refused the code (400 / 401, invalid_grant …), or CPA says only that the exchange failed; not a network failure. */
function codeRefused(raw: string): boolean {
  if (/invalid_grant|invalid_request|authorization code (is )?(invalid|expired|already used)/i.test(raw)) return true
  if (!/failed to exchange (authorization code|token)|token exchange failed/i.test(raw)) return false
  const status = /status (\d{3})/i.exec(raw)?.[1]
  if (status && status !== '400' && status !== '401') return false
  return !/dial tcp|i\/o timeout|deadline exceeded|timed out|connection (refused|reset)|\bEOF\b|no such host|\btls\b|x509|proxyconnect/i.test(raw)
}

export function explainOAuthError(raw: unknown): { error: string; detail?: string } {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (!text) return { error: '' }
  if (regionRefused(text)) return { error: OAUTH_REGION_TEXT, detail: text }
  if (codeRefused(text)) return { error: OAUTH_CODE_TEXT, detail: text }
  return { error: text }
}
