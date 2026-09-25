import assert from 'node:assert/strict'
import test from 'node:test'
import { UploadGate, UploadGateBusyError } from './uploadGate.js'

test('allows only one credential upload task at a time', async () => {
  const gate = new UploadGate()
  let release!: () => void
  const first = gate.run(() => new Promise<void>((resolve) => { release = resolve }))
  await assert.rejects(
    () => gate.run(async () => undefined),
    (error: unknown) => error instanceof UploadGateBusyError && error.code === 'UPLOAD_BUSY',
  )
  release()
  await first
  assert.equal(await gate.run(async () => 'ok'), 'ok')
})
