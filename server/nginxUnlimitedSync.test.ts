import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { buildNginxUnlimitedPolicy } from './nginxUnlimitedPolicy.js'
import {
  NginxUnlimitedSync,
  NginxUnlimitedSyncError,
  type NginxUnlimitedApplyStatus,
} from './nginxUnlimitedSync.js'

const keyA = 'sk-alpha-0123456789abcdef'

function tempPaths() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nginx-sync-'))
  return {
    policyPath: path.join(directory, 'nginx-unlimited-policy.json'),
    statusPath: path.join(directory, 'nginx-unlimited-status.json'),
  }
}

const okStatus = (requestId: string, policyHash: string): NginxUnlimitedApplyStatus => ({
  version: 1,
  requestId,
  policyHash,
  outcome: 'ok',
  unlimitedKeyCount: 1,
  appliedAt: new Date().toISOString(),
})

test('writes a changed policy request, confirms it once, then skips an identical policy', async () => {
  const { policyPath, statusPath } = tempPaths()
  const hashes: string[] = []
  const sync = new NginxUnlimitedSync({
    enabled: true,
    policyPath,
    statusPath,
    waitUntilApplied: async (_requestId, policyHash) => { hashes.push(policyHash); return okStatus(_requestId, policyHash) },
  })
  const policy = buildNginxUnlimitedPolicy([{ keyValue: keyA, enabled: true, totalConcurrency: 0 }])

  assert.deepEqual(await sync.apply(policy), { changed: true, applied: true })
  assert.deepEqual(await sync.apply(policy), { changed: false, applied: false })
  assert.equal(hashes.length, 1)
  const request = JSON.parse(fs.readFileSync(policyPath, 'utf8')) as { policyHash: string; requestId: string; unlimitedKeys: string[] }
  assert.equal(request.policyHash, hashes[0])
  assert.match(request.requestId, /^[A-Za-z0-9-]{8,128}$/)
  assert.deepEqual(request.unlimitedKeys, [keyA])
})

test('coalesces concurrent applies for the same policy', async () => {
  const { policyPath, statusPath } = tempPaths()
  let calls = 0
  let release: (() => void) | undefined
  const wait = new Promise<void>((resolve) => { release = resolve })
  const sync = new NginxUnlimitedSync({
    enabled: true,
    policyPath,
    statusPath,
    waitUntilApplied: async (requestId, policyHash) => { calls += 1; await wait; return okStatus(requestId, policyHash) },
  })
  const policy = buildNginxUnlimitedPolicy([{ keyValue: keyA, enabled: true, totalConcurrency: 0 }])
  const a = sync.apply(policy)
  const b = sync.apply(policy)
  release?.()
  assert.deepEqual(await Promise.all([a, b]), [
    { changed: true, applied: true },
    { changed: true, applied: true },
  ])
  assert.equal(calls, 1)
})

test('serializes a newer request that returns to the previously applied policy', async () => {
  const { policyPath, statusPath } = tempPaths()
  const policyA = buildNginxUnlimitedPolicy([{ keyValue: keyA, enabled: true, totalConcurrency: 0 }])
  const policyB = buildNginxUnlimitedPolicy([])
  const appliedKeys: string[][] = []
  let releaseB: (() => void) | undefined
  let signalBStarted: (() => void) | undefined
  const bStarted = new Promise<void>((resolve) => { signalBStarted = resolve })
  const waitForB = new Promise<void>((resolve) => { releaseB = resolve })
  const sync = new NginxUnlimitedSync({
    enabled: true,
    policyPath,
    statusPath,
    waitUntilApplied: async (requestId, policyHash) => {
      const request = JSON.parse(fs.readFileSync(policyPath, 'utf8')) as { unlimitedKeys: string[] }
      appliedKeys.push(request.unlimitedKeys)
      if (request.unlimitedKeys.length === 0) {
        signalBStarted?.()
        await waitForB
      }
      return okStatus(requestId, policyHash)
    },
  })

  assert.deepEqual(await sync.apply(policyA), { changed: true, applied: true })
  const applyB = sync.apply(policyB)
  await bStarted
  const applyLatestA = sync.apply(policyA)
  releaseB?.()

  assert.deepEqual(await Promise.all([applyB, applyLatestA]), [
    { changed: true, applied: true },
    { changed: true, applied: true },
  ])
  assert.deepEqual(appliedKeys, [[keyA], [], [keyA]])
  const finalRequest = JSON.parse(fs.readFileSync(policyPath, 'utf8')) as { unlimitedKeys: string[] }
  assert.deepEqual(finalRequest.unlimitedKeys, [keyA])
})

test('disabled sync never writes a snapshot or waits for the worker', async () => {
  const { policyPath, statusPath } = tempPaths()
  let calls = 0
  const sync = new NginxUnlimitedSync({
    enabled: false,
    policyPath,
    statusPath,
    waitUntilApplied: async (requestId, policyHash) => { calls += 1; return okStatus(requestId, policyHash) },
  })
  const policy = buildNginxUnlimitedPolicy([{ keyValue: keyA, enabled: true, totalConcurrency: 0 }])
  assert.deepEqual(await sync.apply(policy), { changed: false, applied: false })
  assert.equal(calls, 0)
  assert.equal(fs.existsSync(policyPath), false)
})

test('surfaces a stable redacted error when the worker reports failure', async () => {
  const { policyPath, statusPath } = tempPaths()
  const sync = new NginxUnlimitedSync({
    enabled: true,
    policyPath,
    statusPath,
    waitUntilApplied: async (requestId, policyHash) => ({
      ...okStatus(requestId, policyHash),
      outcome: 'error',
      errorCode: `failed-for-${keyA}`,
    }),
  })
  const policy = buildNginxUnlimitedPolicy([{ keyValue: keyA, enabled: true, totalConcurrency: 0 }])

  await assert.rejects(
    () => sync.apply(policy),
    (error: unknown) => {
      assert.equal(error instanceof NginxUnlimitedSyncError, true)
      assert.equal((error as Error).message.includes(keyA), false)
      assert.match((error as Error).message, /NGINX_UNLIMITED_SYNC_FAILED/)
      return true
    },
  )
})

test('rejects non-absolute policy and status paths', () => {
  assert.throws(
    () => new NginxUnlimitedSync({ enabled: true, policyPath: 'policy.json', statusPath: '/tmp/status.json' }),
    /绝对路径/,
  )
  assert.throws(
    () => new NginxUnlimitedSync({ enabled: true, policyPath: '/tmp/policy.json', statusPath: 'status.json' }),
    /绝对路径/,
  )
})
