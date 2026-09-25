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
  auth_kind?: unknown
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
