import type { DatabaseSync } from 'node:sqlite'

import { buildNginxUnlimitedPolicy } from './nginxUnlimitedPolicy.js'
import type { NginxUnlimitedSync } from './nginxUnlimitedSync.js'

export type NginxUnlimitedPolicyDatabase = Pick<DatabaseSync, 'prepare'>

export async function reconcileNginxUnlimitedPolicy(
  database: NginxUnlimitedPolicyDatabase,
  sync: Pick<NginxUnlimitedSync, 'apply'>,
) {
  const rows = database.prepare(`
    SELECT key_value keyValue, enabled, total_concurrency totalConcurrency
    FROM api_keys ORDER BY key_hash
  `).all() as Array<{ keyValue: string; enabled: number; totalConcurrency: number }>
  const policy = buildNginxUnlimitedPolicy(rows.map((row) => ({
    keyValue: row.keyValue,
    enabled: Boolean(row.enabled),
    totalConcurrency: Number(row.totalConcurrency),
  })))
  const result = await sync.apply(policy)
  return { ...result, unlimitedKeyCount: policy.unlimitedKeys.length }
}
