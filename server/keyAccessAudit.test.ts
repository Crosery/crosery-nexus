import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { diffEffectiveAccess, recordKeyAccessChanges } from './keyAccessAudit.js'

function setup() {
  const database = new DatabaseSync(':memory:')
  database.exec('CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  const audits: Array<{ action: string; target: string; details: Record<string, unknown> }> = []
  const audit = (action: string, target: string, details: string) => { audits.push({ action, target, details: JSON.parse(details) }) }
  return { database, audits, audit }
}

const names = new Map([['hash-a', 'alpha'], ['hash-b', 'beta']])

test('首轮只建基线；之后只有真实变化才写审计，Key 名称作目标', () => {
  const { database, audits, audit } = setup()
  const first = { 'hash-a': { models: ['m2', 'm1'], channels: ['codex'] } }
  assert.deepEqual(recordKeyAccessChanges(database, first, names, audit), [])
  assert.deepEqual(recordKeyAccessChanges(database, { 'hash-a': { models: ['m1', 'm2', 'm1'], channels: ['codex'] } }, names, audit), [], '顺序和重复不算变化')
  assert.equal(audits.length, 0)

  recordKeyAccessChanges(database, { 'hash-a': { models: ['m1', 'm3'], channels: ['codex', 'kimi'] } }, names, audit)
  assert.deepEqual(audits, [{
    action: 'key_access_change',
    target: 'alpha',
    details: { models: { added: ['m3'], removed: ['m2'], before: 2, after: 2 }, channels: { added: ['kimi'], removed: [] } },
  }])
})

test('Key 停用记为全部移除；已删除的 Key 不再对比', () => {
  const { database, audits, audit } = setup()
  recordKeyAccessChanges(database, { 'hash-a': { models: ['m1'], channels: ['codex'] }, 'hash-b': { models: ['m1'], channels: ['codex'] } }, names, audit)
  recordKeyAccessChanges(database, {}, new Map([['hash-a', 'alpha']]), audit)
  assert.deepEqual(audits.map((item) => item.target), ['alpha'])
  assert.deepEqual(audits[0].details.models, { added: [], removed: ['m1'], before: 1, after: 0 })
})

test('明细列表有上限，计数照记', () => {
  const { database, audits, audit } = setup()
  recordKeyAccessChanges(database, { 'hash-a': { models: [], channels: [] } }, names, audit)
  const many = Array.from({ length: 130 }, (_, index) => `model-${String(index).padStart(3, '0')}`)
  recordKeyAccessChanges(database, { 'hash-a': { models: many, channels: [] } }, names, audit)
  const models = audits[0].details.models as { added: string[]; after: number }
  assert.equal(models.added.length, 101)
  assert.equal(models.added.at(-1), '…+30')
  assert.equal(models.after, 130)
})

test('diff 只看并集里仍存在的 Key', () => {
  const changes = diffEffectiveAccess({ gone: { models: ['m1'], channels: [] } }, { fresh: { models: ['m1'], channels: [] } }, new Set(['fresh']))
  assert.deepEqual(changes.map((change) => change.keyHash), ['fresh'])
})
