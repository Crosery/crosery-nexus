import assert from 'node:assert/strict'
import test from 'node:test'
import AdmZip from 'adm-zip'
import { CredentialUploadError, prepareCredentialUpload } from './credentialUpload.js'

const credential = (overrides: Record<string, unknown> = {}) => Buffer.from(JSON.stringify({
  type: 'xai',
  email: 'owner@example.com',
  access_token: 'access-secret',
  refresh_token: 'refresh-secret',
  token_endpoint: 'https://auth.x.ai/oauth/token',
  ...overrides,
}))

test('prepares one xAI JSON without exposing credential secrets', async () => {
  const result = await prepareCredentialUpload({ filename: 'account.json', data: credential() })
  assert.equal(result.length, 1)
  assert.equal(result[0].name, 'account.json')
  assert.equal(result[0].provider, 'xai')
  assert.equal(result[0].label, 'owner@example.com')
  assert.equal(result[0].raw.includes('access-secret'), true)
  assert.equal('accessToken' in result[0], false)
  assert.equal('refreshToken' in result[0], false)
})

test('extracts JSON credentials from a ZIP and ignores directory entries', async () => {
  const zip = new AdmZip()
  zip.addFile('CPA/', Buffer.alloc(0))
  zip.addFile('CPA/xai-one.json', credential({ email: 'one@example.com' }))
  zip.addFile('CPA/xai-two.json', credential({ email: 'two@example.com' }))

  const result = await prepareCredentialUpload({ filename: 'accounts.zip', data: zip.toBuffer() })
  assert.deepEqual(result.map((item) => item.name), ['xai-one.json', 'xai-two.json'])
})

test('rejects ZIP path traversal before any credential can be uploaded', async () => {
  const zip = new AdmZip()
  zip.addFile('C:/escape.json', credential())

  await assert.rejects(
    () => prepareCredentialUpload({ filename: 'escape.zip', data: zip.toBuffer() }),
    (error: unknown) => error instanceof CredentialUploadError && error.code === 'UPLOAD_ZIP_PATH_INVALID',
  )
})

test('rejects duplicate basenames in one upload', async () => {
  const zip = new AdmZip()
  zip.addFile('a/xai-same.json', credential({ email: 'one@example.com' }))
  zip.addFile('b/xai-same.json', credential({ email: 'two@example.com' }))

  await assert.rejects(
    () => prepareCredentialUpload({ filename: 'duplicates.zip', data: zip.toBuffer() }),
    (error: unknown) => error instanceof CredentialUploadError && error.code === 'UPLOAD_DUPLICATE_NAME',
  )
})

test('rejects non-xAI JSON and missing refresh tokens', async () => {
  await assert.rejects(
    () => prepareCredentialUpload({ filename: 'codex.json', data: credential({ type: 'codex', token_endpoint: 'https://auth.x.ai/oauth/token', auth_kind: 'grok' }) }),
    (error: unknown) => error instanceof CredentialUploadError && error.code === 'UPLOAD_PROVIDER_NOT_ALLOWED',
  )
  await assert.rejects(
    () => prepareCredentialUpload({ filename: 'xai.json', data: credential({ refresh_token: '' }) }),
    (error: unknown) => error instanceof CredentialUploadError && error.code === 'UPLOAD_CREDENTIAL_INVALID',
  )
})

test('rejects JSON null and xAI lookalike endpoints', async () => {
  await assert.rejects(
    () => prepareCredentialUpload({ filename: 'null.json', data: Buffer.from('null') }),
    (error: unknown) => error instanceof CredentialUploadError && error.code === 'UPLOAD_JSON_INVALID',
  )
  await assert.rejects(
    () => prepareCredentialUpload({ filename: 'lookalike.json', data: credential({ token_endpoint: 'https://notx.ai/oauth/token' }) }),
    (error: unknown) => error instanceof CredentialUploadError && error.code === 'UPLOAD_PROVIDER_NOT_ALLOWED',
  )
})

test('counts directory entries toward the ZIP entry limit', async () => {
  const zip = new AdmZip()
  zip.addFile('one/', Buffer.alloc(0))
  zip.addFile('two/', Buffer.alloc(0))
  zip.addFile('CPA/xai-one.json', credential())
  await assert.rejects(
    () => prepareCredentialUpload({ filename: 'directories.zip', data: zip.toBuffer() }, { maxEntries: 2 }),
    (error: unknown) => error instanceof CredentialUploadError && error.code === 'UPLOAD_TOO_MANY_ENTRIES',
  )
})

test('rejects archives over the configured entry and uncompressed-size limits', async () => {
  const zip = new AdmZip()
  zip.addFile('CPA/xai-one.json', credential())
  zip.addFile('CPA/xai-two.json', credential({ email: 'two@example.com' }))

  await assert.rejects(
    () => prepareCredentialUpload({ filename: 'too-many.zip', data: zip.toBuffer() }, { maxEntries: 1 }),
    (error: unknown) => error instanceof CredentialUploadError && error.code === 'UPLOAD_TOO_MANY_ENTRIES',
  )
  await assert.rejects(
    () => prepareCredentialUpload({ filename: 'too-large.zip', data: zip.toBuffer() }, { maxUncompressedBytes: 100 }),
    (error: unknown) => error instanceof CredentialUploadError && error.code === 'UPLOAD_EXPANDED_TOO_LARGE',
  )
})
