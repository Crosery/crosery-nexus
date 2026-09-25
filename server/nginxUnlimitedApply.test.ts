import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  buildNginxUnlimitedPolicyRequest,
  renderNginxUnlimitedInclude,
} from './nginxUnlimitedPolicy.js'
import { applyNginxUnlimitedPolicy } from './nginxUnlimitedApply.js'

const keyA = 'sk-alpha-0123456789abcdef'

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nginx-apply-'))
  const policyPath = path.join(directory, 'data', 'nginx-unlimited-policy.json')
  const statusPath = path.join(directory, 'data', 'nginx-unlimited-status.json')
  const includePath = path.join(directory, 'etc', 'console-unlimited.conf')
  const backupRoot = path.join(directory, 'backup')
  fs.mkdirSync(path.dirname(policyPath), { recursive: true, mode: 0o700 })
  const request = buildNginxUnlimitedPolicyRequest(
    { version: 1, unlimitedKeys: [keyA] },
    'request-12345678',
  )
  fs.writeFileSync(policyPath, `${JSON.stringify(request)}\n`, { mode: 0o600 })
  fs.chmodSync(policyPath, 0o600)
  return { directory, policyPath, statusPath, includePath, backupRoot, request }
}

test('applies a valid fixed-path request with test-before-reload and writes status', async () => {
  const files = fixture()
  const order: string[] = []
  const uid = process.getuid?.() ?? 0
  const gid = process.getgid?.() ?? 0
  const result = await applyNginxUnlimitedPolicy({
    ...files,
    requiredPolicyUid: uid,
    outputUid: uid,
    outputGid: gid,
    now: () => new Date('2026-08-21T07:00:00.000Z'),
    runNginxTest: async () => { order.push('test') },
    reloadNginx: async () => { order.push('reload') },
  })

  assert.deepEqual(order, ['test', 'reload'])
  assert.equal(fs.readFileSync(files.includePath, 'utf8'), renderNginxUnlimitedInclude(files.request))
  assert.equal(fs.statSync(files.includePath).mode & 0o777, 0o600)
  assert.equal(result.changed, true)
  assert.equal(result.status.outcome, 'ok')
  assert.equal(result.status.requestId, files.request.requestId)
  assert.deepEqual(JSON.parse(fs.readFileSync(files.statusPath, 'utf8')), result.status)
  assert.equal(fs.statSync(files.statusPath).mode & 0o777, 0o600)
  assert.equal(result.backupDirectory === null, false)
})

test('is idempotent when the generated include already matches', async () => {
  const files = fixture()
  fs.mkdirSync(path.dirname(files.includePath), { recursive: true })
  fs.writeFileSync(files.includePath, renderNginxUnlimitedInclude(files.request), { mode: 0o600 })
  let tests = 0
  let reloads = 0
  const result = await applyNginxUnlimitedPolicy({
    ...files,
    requiredPolicyUid: process.getuid?.() ?? 0,
    outputUid: process.getuid?.() ?? 0,
    outputGid: process.getgid?.() ?? 0,
    runNginxTest: async () => { tests += 1 },
    reloadNginx: async () => { reloads += 1 },
  })
  assert.equal(result.changed, false)
  assert.equal(result.backupDirectory, null)
  assert.equal(tests, 0)
  assert.equal(reloads, 0)
  assert.equal(result.status.outcome, 'ok')
})

test('restores the previous include when nginx validation fails', async () => {
  const files = fixture()
  const previous = '# previous\n'
  fs.mkdirSync(path.dirname(files.includePath), { recursive: true })
  fs.writeFileSync(files.includePath, previous, { mode: 0o600 })
  let tests = 0
  let reloads = 0
  await assert.rejects(
    () => applyNginxUnlimitedPolicy({
      ...files,
      requiredPolicyUid: process.getuid?.() ?? 0,
      outputUid: process.getuid?.() ?? 0,
      outputGid: process.getgid?.() ?? 0,
      runNginxTest: async () => { tests += 1; if (tests === 1) throw new Error('invalid') },
      reloadNginx: async () => { reloads += 1 },
    }),
    /NGINX_UNLIMITED_APPLY_FAILED/,
  )
  assert.equal(fs.readFileSync(files.includePath, 'utf8'), previous)
  assert.equal(tests, 2)
  assert.equal(reloads, 1)
  const status = JSON.parse(fs.readFileSync(files.statusPath, 'utf8')) as { outcome: string; errorCode: string }
  assert.equal(status.outcome, 'error')
  assert.equal(status.errorCode, 'NGINX_UNLIMITED_APPLY_FAILED')
})

test('rejects insecure, tampered or symlink policy files before touching nginx', async () => {
  const insecure = fixture()
  fs.chmodSync(insecure.policyPath, 0o644)
  await assert.rejects(
    () => applyNginxUnlimitedPolicy({ ...insecure, requiredPolicyUid: process.getuid?.() ?? 0 }),
    /权限/,
  )

  const tampered = fixture()
  const value = JSON.parse(fs.readFileSync(tampered.policyPath, 'utf8')) as { policyHash: string }
  value.policyHash = '0'.repeat(64)
  fs.writeFileSync(tampered.policyPath, `${JSON.stringify(value)}\n`, { mode: 0o600 })
  await assert.rejects(
    () => applyNginxUnlimitedPolicy({ ...tampered, requiredPolicyUid: process.getuid?.() ?? 0 }),
    /哈希/,
  )

  const linked = fixture()
  const real = `${linked.policyPath}.real`
  fs.renameSync(linked.policyPath, real)
  fs.symlinkSync(real, linked.policyPath)
  await assert.rejects(
    () => applyNginxUnlimitedPolicy({ ...linked, requiredPolicyUid: process.getuid?.() ?? 0 }),
    /普通文件/,
  )
})
