/**
 * 代理预设解析。
 *
 * CPA 的凭据级 proxy_url 有三种语义（sdk/proxyutil/proxy.go）：
 *   ''       继承 config.yaml 的全局 proxy-url
 *   direct   强制直连，忽略全局代理
 *   <url>    走该代理，优先级高于全局
 * 「继承」与「直连」由控制台内置，环境变量只需要列真实代理。
 */

export type ProxyPreset = { label: string; url: string }

export const PROXY_INHERIT = ''
export const PROXY_DIRECT = 'direct'

const SCHEMES = ['http://', 'https://', 'socks5://', 'socks5h://']

/** 规范化一个 proxy_url 取值，非法值返回 null。 */
export function normalizeProxyUrl(raw: string): string | null {
  const value = String(raw ?? '').trim()
  if (!value) return PROXY_INHERIT
  if (value.toLowerCase() === 'direct' || value.toLowerCase() === 'none') return PROXY_DIRECT
  const lower = value.toLowerCase()
  if (!SCHEMES.some((scheme) => lower.startsWith(scheme))) return null
  try {
    const parsed = new URL(value)
    if (!parsed.hostname) return null
  } catch {
    return null
  }
  return value
}

/**
 * 解析 PROXY_PRESETS。条目以换行、分号或逗号分隔，每条为 `标签=地址` 或裸地址。
 * 地址非法的条目直接丢弃，不能让一条笔误把整张预设表打掉。
 */
export function parseProxyPresets(raw: string | undefined): ProxyPreset[] {
  const presets: ProxyPreset[] = []
  const seen = new Set<string>()
  for (const entry of String(raw ?? '').split(/[\n;,]/)) {
    const text = entry.trim()
    if (!text || text.startsWith('#')) continue
    const separator = text.indexOf('=')
    const label = separator > 0 ? text.slice(0, separator).trim() : ''
    const url = normalizeProxyUrl(separator > 0 ? text.slice(separator + 1) : text)
    // 继承与直连是控制台内置选项，预设表只收真实代理地址，避免重复项。
    if (!url || url === PROXY_INHERIT || url === PROXY_DIRECT) continue
    if (seen.has(url)) continue
    seen.add(url)
    presets.push({ label: label || url, url })
  }
  return presets
}
