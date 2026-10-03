import path from 'node:path'
import { readZipJSONEntries } from './zipEntries.js'

type UploadLimits = {
  maxEntries: number
  maxEntryBytes: number
  maxUncompressedBytes: number
}

export const DEFAULT_CREDENTIAL_UPLOAD_LIMITS: Readonly<UploadLimits> = {
  maxEntries: 500,
  maxEntryBytes: 256 * 1024,
  maxUncompressedBytes: 32 * 1024 * 1024,
}

type UploadLimitOverrides = Partial<UploadLimits>

type CredentialRecord = {
  type?: unknown
  provider?: unknown
  email?: unknown
  sub?: unknown
  access_token?: unknown
  refresh_token?: unknown
  token_endpoint?: unknown
  base_url?: unknown
  auth_kind?: unknown
}

const XAI_PROVIDERS = new Set(['xai', 'grok'])
const XAI_AUTH_KINDS = new Set(['', 'oauth', 'grok'])

/**
 * 通用导入（2026-09-25）只放开了渠道类型，端点仍必须按渠道收口：网关会原样信任凭据文件里的端点——
 * xAI 刷新时把 refresh_token POST 到 `token_endpoint`、请求发往 `base_url`，Antigravity 请求发往
 * `base_url`。放任不管，一个伪造文件就能把 token 和用户请求转去任意域名。
 * Codex/Claude 的 base_url 只来自网关配置、Kimi 固定官方地址，不读文件，这里不设限。
 */
const OFFICIAL_ENDPOINT_HOSTS: Record<string, string> = {
  xai: 'x.ai',
  grok: 'x.ai',
  antigravity: 'googleapis.com',
}

/** 仅接受 https 且主机为官方域名或其子域；`notx.ai` 这类后缀相似的域名不算。 */
function onOfficialHost(raw: unknown, domain: string) {
  if (typeof raw !== 'string') return false
  let parsed: URL
  try {
    parsed = new URL(raw.trim())
  } catch {
    return false
  }
  const host = parsed.hostname.toLowerCase()
  return parsed.protocol === 'https:' && (host === domain || host.endsWith(`.${domain}`))
}

const present = (value: unknown) => value !== undefined && value !== null && value !== ''

function assertTrustedCredential(name: string, provider: string, record: CredentialRecord) {
  // 带 token_endpoint 的只有 xAI 凭据；类型对不上说明文件被拼接过，按伪造处理。
  const claimsXai = XAI_PROVIDERS.has(provider) || present(record.token_endpoint)
  if (claimsXai) {
    const authKind = String(record.auth_kind || '').trim().toLowerCase()
    if (!XAI_PROVIDERS.has(provider) || !XAI_AUTH_KINDS.has(authKind)) {
      throw new CredentialUploadError('UPLOAD_PROVIDER_NOT_ALLOWED', `“${name}”的凭据类型与 xAI 端点不一致`)
    }
    // 留空时网关走 OIDC discovery，discovery 结果网关自己会校验域名。
    for (const field of ['token_endpoint', 'base_url'] as const) {
      if (present(record[field]) && !onOfficialHost(record[field], 'x.ai')) {
        throw new CredentialUploadError('UPLOAD_PROVIDER_NOT_ALLOWED', `“${name}”的 ${field} 不是 xAI 官方 https 地址`)
      }
    }
    if (typeof record.access_token !== 'string' || !record.access_token.trim() || typeof record.refresh_token !== 'string' || !record.refresh_token.trim()) {
      throw new CredentialUploadError('UPLOAD_CREDENTIAL_INVALID', `“${name}”缺少 access_token 或 refresh_token`)
    }
    return
  }
  const domain = OFFICIAL_ENDPOINT_HOSTS[provider]
  if (domain && present(record.base_url) && !onOfficialHost(record.base_url, domain)) {
    throw new CredentialUploadError('UPLOAD_PROVIDER_NOT_ALLOWED', `“${name}”的 base_url 不是 ${provider} 官方 https 地址`)
  }
}

export type PreparedCredential = {
  name: string
  provider: string
  label: string
  raw: Buffer
}

export class CredentialUploadError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly stage: 'receive' | 'archive' | 'validate' | 'upload' = 'validate',
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'CredentialUploadError'
  }
}

function resolvedLimits(limits: UploadLimitOverrides) {
  return { ...DEFAULT_CREDENTIAL_UPLOAD_LIMITS, ...limits }
}

function safeEntryName(entryName: string) {
  const normalized = entryName.replaceAll('\\', '/')
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) return false
  const parts = normalized.split('/')
  return !parts.some((part) => part === '..' || part === '')
}

function parseCredential(name: string, raw: Buffer): PreparedCredential {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.toString('utf8'))
  } catch (error) {
    throw new CredentialUploadError('UPLOAD_JSON_INVALID', `“${name}”不是有效 JSON`, 'validate', error)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CredentialUploadError('UPLOAD_JSON_INVALID', `“${name}”必须是 JSON 对象`, 'validate')
  }
  const record = parsed as CredentialRecord
  const provider = String(record.type || record.provider || '').trim().toLowerCase()
  assertTrustedCredential(name, provider, record)
  const label = typeof record.email === 'string' && record.email.trim()
    ? record.email.trim()
    : typeof record.sub === 'string' && record.sub.trim()
      ? record.sub.trim()
      : name

  return {
    name,
    provider: provider || 'oauth',
    label,
    raw,
  }
}

async function fromZip(data: Buffer, limits: ReturnType<typeof resolvedLimits>) {
  const jsonEntries = await readZipJSONEntries(data, limits)
  if (!jsonEntries.length) throw new CredentialUploadError('UPLOAD_NO_JSON', '压缩包中没有 JSON 凭据', 'archive')

  const seen = new Set<string>()
  const prepared: PreparedCredential[] = []
  for (const entry of jsonEntries) {
    if (!safeEntryName(entry.entryName)) throw new CredentialUploadError('UPLOAD_ZIP_PATH_INVALID', '压缩包包含不安全路径', 'archive')
    const name = path.posix.basename(entry.entryName.replaceAll('\\', '/'))
    if (seen.has(name)) throw new CredentialUploadError('UPLOAD_DUPLICATE_NAME', `压缩包内存在重名凭据“${name}”`, 'archive')
    seen.add(name)
    prepared.push(parseCredential(name, entry.data))
  }
  return prepared
}

export async function prepareCredentialUpload(file: { filename: string; data: Buffer }, uploadLimits: UploadLimitOverrides = {}): Promise<PreparedCredential[]> {
  const limits = resolvedLimits(uploadLimits)
  const name = path.basename(file.filename.trim())
  if (!name) throw new CredentialUploadError('UPLOAD_FILENAME_INVALID', '上传文件名无效', 'receive')
  const lower = name.toLowerCase()
  if (lower.endsWith('.zip')) return fromZip(file.data, limits)
  if (!lower.endsWith('.json')) throw new CredentialUploadError('UPLOAD_FILE_TYPE_INVALID', '只允许上传 .json 或 .zip', 'receive')
  if (file.data.length > limits.maxEntryBytes) throw new CredentialUploadError('UPLOAD_ENTRY_TOO_LARGE', 'JSON 文件超过大小限制', 'receive')
  return [parseCredential(name, file.data)]
}
