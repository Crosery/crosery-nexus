import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import { reconcileNginxUnlimitedPolicy } from './nginxUnlimitedReconciler.js'

test('reconciles only enabled zero-concurrency keys from the database', async () => {
  const database = new DatabaseSync(':memory:')
  database.exec(`
    CREATE TABLE api_keys (
      key_hash TEXT PRIMARY KEY,
      key_value TEXT NOT NULL,
      enabled INTEGER NOT NULL,
      total_concurrency INTEGER NOT NULL
    );
    INSERT INTO api_keys VALUES
      ('a', 'sk-alpha-0123456789abcdef', 1, 0),
      ('b', 'sk-beta-0123456789abcdef', 1, 5),
      ('c', 'sk-disabled-0123456789abcdef', 0, 0);
  `)
  const policies: unknown[] = []
  const result = await reconcileNginxUnlimitedPolicy(database, {
    apply: async (policy) => { policies.push(policy); return { changed: true, applied: true } },
  })

  assert.deepEqual(policies, [{ version: 1, unlimitedKeys: ['sk-alpha-0123456789abcdef'] }])
  assert.deepEqual(result, { changed: true, applied: true, unlimitedKeyCount: 1 })
})
