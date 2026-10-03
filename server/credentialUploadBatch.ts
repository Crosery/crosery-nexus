import type { PreparedCredential } from './credentialUpload.js'

export type CredentialUploadItemResult = {
  name: string
  label: string
  ok: boolean
  code?: 'CPA_UPLOAD_FAILED'
  message?: string
}

export type CredentialUploadBatchResult = {
  total: number
  uploaded: number
  failed: number
  items: CredentialUploadItemResult[]
}

export async function uploadCredentialBatch(
  credentials: PreparedCredential[],
  options: { concurrency: number; upload: (credential: PreparedCredential) => Promise<void> },
): Promise<CredentialUploadBatchResult> {
  if (!Number.isSafeInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 8) {
    throw new Error('credential upload concurrency must be an integer from 1 to 8')
  }
  const concurrency = options.concurrency
  const items = new Array<CredentialUploadItemResult>(credentials.length)
  let cursor = 0

  const worker = async () => {
    while (true) {
      const index = cursor
      cursor += 1
      if (index >= credentials.length) return
      const credential = credentials[index]
      try {
        await options.upload(credential)
        items[index] = { name: credential.name, label: credential.label, ok: true }
      } catch {
        items[index] = {
          name: credential.name,
          label: credential.label,
          ok: false,
          code: 'CPA_UPLOAD_FAILED',
          message: 'CPA 拒绝该凭据，请在服务日志中按 trace ID 排查',
        }
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, credentials.length) }, () => worker()))
  const uploaded = items.filter((item) => item.ok).length
  return { total: items.length, uploaded, failed: items.length - uploaded, items }
}
