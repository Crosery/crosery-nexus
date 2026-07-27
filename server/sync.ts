import { config } from './config.js'
import { db, transaction } from './db.js'
import { getCPAKeys, groupForModel, hashKey, maskKey, popUsage } from './cpa.js'
import { extractKeySlug } from './keyNaming.js'

const insertUsage = db.prepare(`
  INSERT OR IGNORE INTO usage_events (
    request_id, timestamp, key_hash, provider, model, model_group, endpoint,
    success, status_code, latency_ms, ttft_ms, input_tokens, output_tokens,
    reasoning_tokens, cached_tokens, total_tokens, error_detail, upstream_request_id,
    source, auth_index, reasoning_effort, service_tier, response_headers_json
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`)

export async function syncKeysFromCPA() {
  const keys = await getCPAKeys()
  const now = new Date().toISOString()
  const known = new Set(keys.map(hashKey))
  const insert = db.prepare(`
    INSERT INTO api_keys (key_hash, key_value, name, note, enabled, groups_json, total_concurrency, group_concurrency_json, created_at, updated_at)
    VALUES (?, ?, ?, '', 1, '[]', 4, '{}', ?, ?)
    ON CONFLICT(key_hash) DO UPDATE SET key_value = excluded.key_value, enabled = 1, updated_at = excluded.updated_at
  `)
  transaction(() => {
    keys.forEach((key, index) => {
      const keyHash = hashKey(key)
      const existing = db.prepare('SELECT name FROM api_keys WHERE key_hash = ?').get(keyHash) as { name?: string } | undefined
      const slug = extractKeySlug(key)
      insert.run(keyHash, key, existing?.name || (slug ? slug : `API Key ${index + 1} · ${maskKey(key)}`), now, now)
    })
    const rows = db.prepare('SELECT key_hash FROM api_keys WHERE enabled = 1').all() as Array<{ key_hash: string }>
    for (const row of rows) {
      if (!known.has(row.key_hash)) db.prepare('UPDATE api_keys SET enabled = 0, updated_at = ? WHERE key_hash = ?').run(now, row.key_hash)
    }
  })
}

export async function collectUsage() {
  const records = await popUsage(500)
  if (!records.length) return 0
  const updateLastUsed = db.prepare('UPDATE api_keys SET last_used_at = ? WHERE key_hash = ?')
  transaction(() => {
    for (const record of records) {
      const keyHash = record.api_key ? hashKey(record.api_key) : null
      const timestamp = record.timestamp || new Date().toISOString()
      const tokens = record.tokens || {}
      const model = record.alias || record.model || 'unknown'
      const provider = record.provider || 'unknown'
      const responseHeaders = record.response_headers && typeof record.response_headers === 'object' ? record.response_headers : {}
      const upstreamRequestId = ['x-upstream-request-id', 'x-request-id', 'request-id', 'cf-ray']
        .flatMap((name) => Object.entries(responseHeaders).filter(([key]) => key.toLowerCase() === name).flatMap(([, value]) => Array.isArray(value) ? value : [value]))
        .map(String)[0] || ''
      insertUsage.run(
        record.request_id || `${timestamp}-${model}-${Math.random()}`,
        timestamp,
        keyHash,
        provider,
        model,
        groupForModel(model, provider),
        record.endpoint || '',
        record.failed ? 0 : 1,
        record.fail?.status_code || (record.failed ? 500 : 200),
        record.latency_ms || 0,
        record.ttft_ms || 0,
        tokens.input_tokens || 0,
        tokens.output_tokens || 0,
        tokens.reasoning_tokens || 0,
        tokens.cached_tokens || 0,
        tokens.total_tokens || 0,
        String(record.fail?.body || ''),
        upstreamRequestId,
        String(record.source || ''),
        String(record.auth_index || ''),
        String(record.reasoning_effort || ''),
        String(record.service_tier || ''),
        JSON.stringify(responseHeaders),
      )
      if (keyHash) updateLastUsed.run(timestamp, keyHash)
    }
  })
  return records.length
}

export function pruneUsage() {
  db.prepare(`DELETE FROM usage_events WHERE timestamp < datetime('now', ?)`)
    .run(`-${config.usageRetentionDays} days`)
}

let syncRunning = false
export async function runSyncCycle() {
  if (syncRunning) return
  syncRunning = true
  try {
    await syncKeysFromCPA()
    await collectUsage()
    pruneUsage()
  } catch (error) {
    console.error('[sync]', error instanceof Error ? error.message : error)
  } finally {
    syncRunning = false
  }
}

export function startSync() {
  void runSyncCycle()
  return setInterval(() => void runSyncCycle(), config.syncIntervalMs)
}
