import type { PreparedCredential } from './credentialUpload.js'
import type { CredentialUploadItemResult } from './credentialUploadBatch.js'

export type MergedCredentialUploadItem = CredentialUploadItemResult & {
  skipped?: boolean
}

export function mergeCredentialUploadItems(
  credentials: PreparedCredential[],
  uploadedItems: CredentialUploadItemResult[],
  existingNames: Set<string>,
): MergedCredentialUploadItem[] {
  const uploadedByName = new Map(uploadedItems.map((item) => [item.name, item]))
  return credentials.map((credential) => {
    if (existingNames.has(credential.name)) {
      return { name: credential.name, label: credential.label, ok: true, skipped: true, message: '同名凭据已存在，未重复写入' }
    }
    const uploaded = uploadedByName.get(credential.name)
    if (!uploaded) {
      return { name: credential.name, label: credential.label, ok: false, code: 'CPA_UPLOAD_FAILED', message: '上传结果缺失，请按 trace ID 排查' }
    }
    return uploaded
  })
}
