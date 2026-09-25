import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { booleanSetting, choiceSetting, config, fileBackedSecret, internalHttpBaseUrl, internalToken, positiveInteger } from './config.js'

test('accepts bounded positive integer upload settings', () => {
  assert.equal(positiveInteger('UPLOAD_LIMIT', '4', 2, { min: 1, max: 8 }), 4)
  assert.equal(positiveInteger('UPLOAD_LIMIT', undefined, 2, { min: 1, max: 8 }), 2)
})

test('fails fast for invalid upload settings', () => {
  assert.throws(() => positiveInteger('UPLOAD_LIMIT', 'abc', 2, { min: 1, max: 8 }), /UPLOAD_LIMIT/)
  assert.throws(() => positiveInteger('UPLOAD_LIMIT', '0', 2, { min: 1, max: 8 }), /UPLOAD_LIMIT/)
  assert.throws(() => positiveInteger('UPLOAD_LIMIT', '9', 2, { min: 1, max: 8 }), /UPLOAD_LIMIT/)
})

test('parses strict boolean settings without treating arbitrary text as enabled', () => {
  assert.equal(booleanSetting('SYNC_ENABLED', undefined, false), false)
  assert.equal(booleanSetting('SYNC_ENABLED', 'true', false), true)
  assert.equal(booleanSetting('SYNC_ENABLED', 'false', true), false)
  assert.throws(() => booleanSetting('SYNC_ENABLED', '1', false), /SYNC_ENABLED/)
})

test('parses the dashboard read kill switch as a closed choice', () => {
  assert.equal(choiceSetting('READ_MODE', undefined, 'sqlite', ['sqlite', 'snapshot'] as const), 'sqlite')
  assert.equal(choiceSetting('READ_MODE', 'snapshot', 'sqlite', ['sqlite', 'snapshot'] as const), 'snapshot')
  assert.throws(() => choiceSetting('READ_MODE', 'automatic', 'sqlite', ['sqlite', 'snapshot'] as const), /READ_MODE/)
})

test('accepts the bounded CPA request timeout', () => {
  assert.equal(positiveInteger('CPA_REQUEST_TIMEOUT_MS', '10000', 5000, { min: 500, max: 60_000 }), 10_000)
  assert.throws(() => positiveInteger('CPA_REQUEST_TIMEOUT_MS', '100', 5000, { min: 500, max: 60_000 }), /CPA_REQUEST_TIMEOUT_MS/)
})

test('defaults the dedicated Usage Queue collector to one second', () => {
  assert.equal(config.usageCollectIntervalMs, 1_000)
  assert.equal(positiveInteger('USAGE_COLLECT_INTERVAL_MS', undefined, 1_000, { min: 250, max: 60_000 }), 1_000)
  assert.throws(() => positiveInteger('USAGE_COLLECT_INTERVAL_MS', '100', 1_000, { min: 250, max: 60_000 }), /USAGE_COLLECT_INTERVAL_MS/)
})

test('bounds the reporting read pool for memory-constrained edge hosts', () => {
  assert.equal(config.reportReadWorkers, 2)
  assert.equal(positiveInteger('REPORT_READ_WORKERS', '4', 2, { min: 1, max: 4 }), 4)
  assert.throws(() => positiveInteger('REPORT_READ_WORKERS', '5', 2, { min: 1, max: 4 }), /REPORT_READ_WORKERS/)
})

test('validates the private data plane base URL without embedded credentials', () => {
  assert.equal(internalHttpBaseUrl('DATA_PLANE_BASE_URL', 'http://100.64.0.8:8788/', true), 'http://100.64.0.8:8788')
  assert.equal(internalHttpBaseUrl('DATA_PLANE_BASE_URL', undefined, false), '')
  assert.throws(() => internalHttpBaseUrl('DATA_PLANE_BASE_URL', undefined, true), /不能为空/)
  assert.throws(() => internalHttpBaseUrl('DATA_PLANE_BASE_URL', 'ftp://100.64.0.8', true), /HTTP/)
  assert.throws(() => internalHttpBaseUrl('DATA_PLANE_BASE_URL', 'https://user:secret@example.com', true), /不含凭据/)
})

test('requires a shared data plane token with at least 32 characters', () => {
  assert.equal(internalToken('DATA_PLANE_TOKEN', 'a'.repeat(32), true), 'a'.repeat(32))
  assert.equal(internalToken('DATA_PLANE_TOKEN', undefined, false), '')
  assert.throws(() => internalToken('DATA_PLANE_TOKEN', undefined, true), /不能为空/)
  assert.throws(() => internalToken('DATA_PLANE_TOKEN', 'too-short', true), /至少包含 32 个字符/)
})

test('data-plane token can come from one private file without exposing file errors', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cpe-edge-secret-'))
  const filename = path.join(directory, 'token')
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  fs.writeFileSync(filename, `${'x'.repeat(32)}\n`, { mode: 0o600 })
  assert.equal(fileBackedSecret('DATA_PLANE_TOKEN', undefined, filename), 'x'.repeat(32))
  assert.throws(() => fileBackedSecret('DATA_PLANE_TOKEN', 'y'.repeat(32), filename), /不能同时设置/)
  fs.chmodSync(filename, 0o644)
  assert.throws(() => fileBackedSecret('DATA_PLANE_TOKEN', undefined, filename), /私有/)
})
