import Busboy from 'busboy'
import type { Request } from 'express'

export class MultipartUploadError extends Error {
  constructor(public readonly code: string, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'MultipartUploadError'
  }
}

export function receiveUploadFile(request: Request, maxBytes: number): Promise<{ filename: string; data: Buffer }> {
  return new Promise((resolve, reject) => {
    let settled = false
    let filename = ''
    let fileSeen = false
    let fileTooLarge = false
    const chunks: Buffer[] = []

    const finishError = (error: MultipartUploadError) => {
      if (settled) return
      settled = true
      reject(error)
    }

    let parser: Busboy.Busboy
    try {
      parser = Busboy({ headers: request.headers, limits: { files: 1, fileSize: maxBytes, fields: 0, parts: 1 } })
    } catch (error) {
      finishError(new MultipartUploadError('UPLOAD_MULTIPART_INVALID', '上传请求格式无效', error))
      return
    }

    parser.on('file', (_field, stream, info) => {
      fileSeen = true
      filename = info.filename
      stream.on('data', (chunk: Buffer) => chunks.push(chunk))
      stream.on('limit', () => { fileTooLarge = true })
      stream.on('error', (error) => finishError(new MultipartUploadError('UPLOAD_READ_FAILED', '读取上传文件失败', error)))
    })
    parser.on('filesLimit', () => finishError(new MultipartUploadError('UPLOAD_TOO_MANY_FILES', '每次只允许上传一个 JSON 或 ZIP')))
    parser.on('partsLimit', () => {
      if (!fileSeen) finishError(new MultipartUploadError('UPLOAD_FILE_MISSING', '请选择要上传的 JSON 或 ZIP'))
    })
    parser.on('error', (error) => finishError(new MultipartUploadError('UPLOAD_MULTIPART_INVALID', '上传请求格式无效', error)))
    parser.on('close', () => {
      if (settled) return
      if (!fileSeen) return finishError(new MultipartUploadError('UPLOAD_FILE_MISSING', '请选择要上传的 JSON 或 ZIP'))
      if (fileTooLarge) return finishError(new MultipartUploadError('UPLOAD_BODY_TOO_LARGE', `上传文件不能超过 ${Math.ceil(maxBytes / 1024 / 1024)} MB`))
      settled = true
      resolve({ filename, data: Buffer.concat(chunks) })
    })
    request.on('aborted', () => finishError(new MultipartUploadError('UPLOAD_ABORTED', '上传连接已中断')))
    request.pipe(parser)
  })
}
