import assert from 'node:assert/strict'
import test from 'node:test'
import type { PreparedCredential } from './credentialUpload.js'
import { mergeCredentialUploadItems } from './credentialUploadMerge.js'

const credentials: PreparedCredential[] = [
  { name: 'existing.json', provider: 'xai', label: 'existing@example.com', raw: Buffer.from('{}') },
  { name: 'new.json', provider: 'xai', label: 'new@example.com', raw: Buffer.from('{}') },
]

test('preserves input order and marks existing names as skipped', () => {
  const result = mergeCredentialUploadItems(credentials, [
    { name: 'new.json', label: 'new@example.com', ok: true },
  ], new Set(['existing.json']))
  assert.deepEqual(result, [
    { name: 'existing.json', label: 'existing@example.com', ok: true, skipped: true, message: '同名凭据已存在，未重复写入' },
    { name: 'new.json', label: 'new@example.com', ok: true },
  ])
})
