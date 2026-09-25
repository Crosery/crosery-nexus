import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import test from 'node:test'
import type { Request } from 'express'
import { MultipartUploadError, receiveUploadFile } from './multipartUpload.js'

function multipartRequest(filename: string, data: Buffer, boundary = 'test-boundary') {
  const prefix = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`)
  const suffix = Buffer.from(`\r\n--${boundary}--\r\n`)
  const request = Readable.from(Buffer.concat([prefix, data, suffix])) as Request
  request.headers = { 'content-type': `multipart/form-data; boundary=${boundary}` }
  return request
}

test('receives one multipart file within the configured limit', async () => {
  const upload = await receiveUploadFile(multipartRequest('accounts.zip', Buffer.from('payload')), 1024)
  assert.equal(upload.filename, 'accounts.zip')
  assert.equal(upload.data.toString(), 'payload')
})

test('rejects uploads over the configured byte limit', async () => {
  await assert.rejects(
    () => receiveUploadFile(multipartRequest('large.zip', Buffer.alloc(32)), 8),
    (error: unknown) => error instanceof MultipartUploadError && error.code === 'UPLOAD_BODY_TOO_LARGE',
  )
})

test('rejects requests without a file', async () => {
  const boundary = 'empty-boundary'
  const request = Readable.from(Buffer.from(`--${boundary}--\r\n`)) as Request
  request.headers = { 'content-type': `multipart/form-data; boundary=${boundary}` }
  await assert.rejects(
    () => receiveUploadFile(request, 1024),
    (error: unknown) => error instanceof MultipartUploadError && error.code === 'UPLOAD_FILE_MISSING',
  )
})
