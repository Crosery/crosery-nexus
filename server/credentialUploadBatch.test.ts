import assert from 'node:assert/strict'
import test from 'node:test'
import { uploadCredentialBatch } from './credentialUploadBatch.js'
import type { PreparedCredential } from './credentialUpload.js'

const item = (name: string): PreparedCredential => ({
  name,
  provider: 'xai',
  label: `${name}@example.com`,
  raw: Buffer.from(JSON.stringify({ type: 'xai', access_token: 'secret', refresh_token: 'secret' })),
})

test('uploads credentials with bounded concurrency and preserves input order', async () => {
  let active = 0
  let peak = 0
  const completed: string[] = []
  const result = await uploadCredentialBatch([item('one.json'), item('two.json'), item('three.json')], {
    concurrency: 2,
    upload: async (credential) => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, credential.name === 'one.json' ? 15 : 1))
      active -= 1
      completed.push(credential.name)
    },
  })

  assert.equal(peak, 2)
  assert.notDeepEqual(completed, result.items.map((entry) => entry.name))
  assert.deepEqual(result.items.map((entry) => entry.name), ['one.json', 'two.json', 'three.json'])
  assert.equal(result.uploaded, 3)
  assert.equal(result.failed, 0)
})

test('rejects invalid upload concurrency instead of returning a false success', async () => {
  await assert.rejects(
    () => uploadCredentialBatch([item('one.json')], { concurrency: Number.NaN, upload: async () => undefined }),
    /concurrency/,
  )
})

test('isolates failed uploads and never includes CPA response bodies or secrets', async () => {
  const result = await uploadCredentialBatch([item('ok.json'), item('bad.json')], {
    concurrency: 1,
    upload: async (credential) => {
      if (credential.name === 'bad.json') throw new Error('CPA 500: response contained access-secret')
    },
  })

  assert.equal(result.uploaded, 1)
  assert.equal(result.failed, 1)
  assert.deepEqual(result.items, [
    { name: 'ok.json', label: 'ok.json@example.com', ok: true },
    { name: 'bad.json', label: 'bad.json@example.com', ok: false, code: 'CPA_UPLOAD_FAILED', message: 'CPA 拒绝该凭据，请在服务日志中按 trace ID 排查' },
  ])
  assert.equal(JSON.stringify(result).includes('access-secret'), false)
})
