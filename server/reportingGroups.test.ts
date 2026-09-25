import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'

import { parseStoredReportingGroups, ReportingGroupStore } from './reportingGroups.js'

const groups = [{ id: 'codex', name: 'Codex', color: '#6ee7b7', kind: 'oauth' as const, models: ['gpt-5.6-sol'] }]

test('persists and validates the last successful reporting groups', () => {
  const database = new DatabaseSync(':memory:')
  database.exec('CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  const store = new ReportingGroupStore(database, () => Date.parse('2026-08-31T10:15:00.000Z'))
  assert.equal(store.read(), null)
  store.write(groups)
  assert.deepEqual(store.read(), { version: 1, generatedAt: '2026-08-31T10:15:00.000Z', groups })
  database.close()
})

test('rejects corrupt or unbounded stored group payloads', () => {
  assert.equal(parseStoredReportingGroups({ version: 1, generatedAt: 'bad', groups }), null)
  assert.equal(parseStoredReportingGroups({ version: 1, generatedAt: new Date().toISOString(), groups: [{ ...groups[0], models: [42] }] }), null)
  assert.equal(parseStoredReportingGroups({ version: 1, generatedAt: new Date().toISOString(), groups: Array.from({ length: 129 }, () => groups[0]) }), null)
})
