import yauzl from 'yauzl'
import { CredentialUploadError } from './credentialUpload.js'

export type ZipJSONEntry = {
  entryName: string
  uncompressedSize: number
  data: Buffer
}

function openZip(data: Buffer) {
  return new Promise<yauzl.ZipFile>((resolve, reject) => {
    yauzl.fromBuffer(data, { lazyEntries: true, decodeStrings: true, validateEntrySizes: true, strictFileNames: false }, (error, zip) => {
      if (error || !zip) return reject(new CredentialUploadError('UPLOAD_ZIP_INVALID', '压缩包无法读取', 'archive', error))
      resolve(zip)
    })
  })
}

function readEntry(zip: yauzl.ZipFile, entry: yauzl.Entry, maxEntryBytes: number) {
  return new Promise<Buffer>((resolve, reject) => {
    zip.openReadStream(entry, { decompress: true }, (error, stream) => {
      if (error || !stream) return reject(new CredentialUploadError('UPLOAD_ZIP_ENTRY_INVALID', `“${entry.fileName}”无法解压`, 'archive', error))
      const chunks: Buffer[] = []
      let total = 0
      stream.on('data', (chunk: Buffer) => {
        total += chunk.length
        if (total > maxEntryBytes) {
          stream.destroy(new CredentialUploadError('UPLOAD_ENTRY_TOO_LARGE', `“${entry.fileName}”超过单文件大小限制`, 'archive'))
          return
        }
        chunks.push(chunk)
      })
      stream.on('error', (cause) => reject(cause instanceof CredentialUploadError
        ? cause
        : new CredentialUploadError('UPLOAD_ZIP_ENTRY_INVALID', `“${entry.fileName}”无法解压`, 'archive', cause)))
      stream.on('end', () => {
        if (total !== entry.uncompressedSize) {
          reject(new CredentialUploadError('UPLOAD_ZIP_ENTRY_INVALID', `“${entry.fileName}”解压大小不一致`, 'archive'))
          return
        }
        resolve(Buffer.concat(chunks, total))
      })
    })
  })
}

export async function readZipJSONEntries(
  data: Buffer,
  limits: { maxEntries: number; maxEntryBytes: number; maxUncompressedBytes: number },
): Promise<ZipJSONEntry[]> {
  const zip = await openZip(data)
  return new Promise((resolve, reject) => {
    const entries: ZipJSONEntry[] = []
    let entryCount = 0
    let expandedBytes = 0
    let settled = false

    const fail = (error: unknown) => {
      if (settled) return
      settled = true
      zip.close()
      if (error instanceof CredentialUploadError) return reject(error)
      const message = error instanceof Error ? error.message.toLowerCase() : ''
      if (message.includes('absolute path') || message.includes('invalid relative path')) {
        return reject(new CredentialUploadError('UPLOAD_ZIP_PATH_INVALID', '压缩包包含不安全路径', 'archive', error))
      }
      reject(new CredentialUploadError('UPLOAD_ZIP_INVALID', '压缩包无法读取', 'archive', error))
    }

    zip.on('error', fail)
    zip.on('entry', (entry: yauzl.Entry) => {
      entryCount += 1
      if (entryCount > limits.maxEntries) return fail(new CredentialUploadError('UPLOAD_TOO_MANY_ENTRIES', `压缩包最多允许 ${limits.maxEntries} 个条目`, 'archive'))
      if (entry.fileName.endsWith('/')) return zip.readEntry()
      if (!entry.fileName.toLowerCase().endsWith('.json')) return zip.readEntry()
      if (entry.uncompressedSize > limits.maxEntryBytes) return fail(new CredentialUploadError('UPLOAD_ENTRY_TOO_LARGE', `“${entry.fileName}”超过单文件大小限制`, 'archive'))
      expandedBytes += entry.uncompressedSize
      if (expandedBytes > limits.maxUncompressedBytes) return fail(new CredentialUploadError('UPLOAD_EXPANDED_TOO_LARGE', '压缩包解压后的总大小超过限制', 'archive'))
      readEntry(zip, entry, limits.maxEntryBytes).then((entryData) => {
        entries.push({ entryName: entry.fileName, uncompressedSize: entry.uncompressedSize, data: entryData })
        zip.readEntry()
      }).catch(fail)
    })
    zip.on('end', () => {
      if (settled) return
      settled = true
      zip.close()
      resolve(entries)
    })
    zip.readEntry()
  })
}
