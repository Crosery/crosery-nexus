import './testDataDir.js'

import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import test from 'node:test'
import cookieParser from 'cookie-parser'
import express from 'express'

import type { ConsoleGroup } from './groups.js'
import type { ReadOperation } from './sqliteReadWorker.js'

/*
 * One Key, one window, one number (orchestrator decision 2026-10-02: history is history, spend is spend).
 * Every report counts ALL traffic of a Key by default — including channels removed since — so the 概览,
 * /keys, /usage (four tabs) and the key user's own /me agree for the same Key. 「只看当前渠道」 is the explicit
 * `currentOnly=1` filter and narrows every admin report the same way.
 *
 * Traffic sits a few hours back so it lies inside every window at once: /me's calendar 7 days, the usage
 * workspace's whole-hour 7 days, /keys' rolling 7 × 24h and the dashboard's rolling 24h Key strip.
 */

const { config } = await import('./config.js')
config.sessionSecret = 'scope-parity-session-secret'
const { db } = await import('./db.js')
const { createSessionToken, setKeySessionLookup } = await import('./auth.js')
const { keySessionState } = await import('./keySession.js')
const { createMeRouter } = await import('./meRoutes.js')
const { registerKeysViewRoutes } = await import('./keysView.js')
const { registerOverviewRoutes } = await import('./overviewRoutes.js')
const { registerPerfRoutes } = await import('./perfReports.js')
const { registerUsageWorkspaceRoutes } = await import('./usageWorkspaceRoutes.js')
const { loadDashboardReport, loadAnalyticsReport, loadUsageOverviewReport } = await import('./usageReports.js')

const HOUR = 3_600_000
const KEY = 'f'.repeat(64)
const OTHER = 'e'.repeat(64)
const groups: ConsoleGroup[] = [{ id: 'codex', name: 'Codex', color: '#000', kind: 'oauth', models: ['gpt-5.6-sol'] }]
const reader = {
  async run(operations: readonly ReadOperation[]) {
    return operations.map((op) => {
      const statement = db.prepare(op.sql)
      return op.method === 'get' ? statement.get(...(op.params ?? [])) : statement.all(...(op.params ?? []))
    })
  },
}

let seq = 0
function insert(at: number, key: string, provider: string, ok = true) {
  seq += 1
  db.prepare(`INSERT INTO usage_events
    (request_id,timestamp,timestamp_ms,key_hash,provider,model,model_group,endpoint,success,status_code,latency_ms,ttft_ms,
     input_tokens,output_tokens,reasoning_tokens,cached_tokens,cache_write_tokens,total_tokens,user_agent,client_type,client_ip,
     error_detail,error_category,upstream_request_id,source,auth_index,cost_usd)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    `parity-${seq}`, new Date(at).toISOString(), at, key, provider, 'gpt-5.6-sol', 'g', 'POST /v1/chat/completions',
    ok ? 1 : 0, ok ? 200 : 429, 900, 200, 1_000, 100, 0, 0, 0, 1_100, 'ua', 'codex-cli', '127.0.0.1',
    ok ? '' : 'boom', ok ? '' : 'rate_limited', `up-${seq}`, '', 'auth-1', 0.01,
  )
}

const NOW = Date.now()
db.exec('DELETE FROM usage_events; DELETE FROM usage_hourly_rollup; DELETE FROM api_keys')
for (const [hash, name] of [[KEY, 'Parity'], [OTHER, 'Other']]) {
  db.prepare('INSERT INTO api_keys (key_hash,key_value,name,enabled,created_at,updated_at) VALUES (?,?,?,1,?,?)')
    .run(hash, `sk-parity-${hash.slice(0, 8)}`, name, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')
}
// the Key: 3 on the current channel (one failed), 3 on channels removed since
insert(NOW - 2 * HOUR, KEY, 'codex')
insert(NOW - 3 * HOUR, KEY, 'codex', false)
insert(NOW - 5 * HOUR, KEY, 'codex')
insert(NOW - 2 * HOUR, KEY, 'openai-compatible-retired')
insert(NOW - 4 * HOUR, KEY, 'retired')
insert(NOW - 3 * HOUR, KEY, 'antigravity')
// another Key's traffic must never leak into the count
insert(NOW - 2 * HOUR, OTHER, 'codex')
insert(NOW - 2 * HOUR, OTHER, 'antigravity')

const ALL = 6
const CURRENT = 3

async function withApp(run: (get: (path: string, cookie?: string) => Promise<Record<string, any>>) => Promise<void>) {
  setKeySessionLookup(keySessionState)
  const app = express()
  app.use(cookieParser())
  app.use('/api/me', createMeRouter({ usageReader: reader }))
  registerKeysViewRoutes(app, { usageReader: reader, groups: async () => groups })
  registerOverviewRoutes(app, { reader, groups: async () => groups })
  registerPerfRoutes(app, { reader, groups: async () => groups, timeZone: 'Asia/Shanghai', retentionDays: 90 })
  registerUsageWorkspaceRoutes(app, {
    usageReader: reader,
    latencyReader: reader,
    reportingContext: async () => ({ groups, policyHash: 'parity' }),
    retentionDays: 90,
    timeZone: 'Asia/Shanghai',
  })
  const server = app.listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  try {
    await run(async (path, cookie) => {
      const res = await fetch(`${base}${path}`, { headers: cookie ? { cookie } : {} })
      assert.equal(res.status, 200, `${path} → HTTP ${res.status}`)
      return await res.json() as Record<string, any>
    })
  } finally {
    await new Promise((resolve) => server.close(resolve))
    setKeySessionLookup(null)
  }
}

test('same Key, same window: /api/keys/activity = /usage (4 endpoints) = dashboard = /api/overview = /api/me/usage', async () => {
  const keyCookie = `crosery_console_session=${createSessionToken({ role: 'key', keyHash: KEY })}`
  await withApp(async (get) => {
    const activity = await get('/api/keys/activity')
    const row = activity.keys.find((k: { id: string }) => k.id === KEY)
    const me = await get('/api/me/usage?days=7', keyCookie)
    const overview = await get(`/api/usage-overview?view=workspace&days=7&keyId=${KEY}`)
    const requests = await get(`/api/analytics?view=workspace&days=7&keyId=${KEY}`)
    const facets = await get(`/api/usage-facets?days=7&keyId=${KEY}`)
    const perf = await get(`/api/usage-performance?days=7&keyId=${KEY}`)
    const gateway = await get('/api/overview?range=24h')
    const dashboard = await loadDashboardReport(reader, groups, 7, KEY)
    const legacy = await loadAnalyticsReport(reader, groups, 7, '')
    const legacyOverview = await loadUsageOverviewReport(reader, groups, 7, KEY)

    const counts: Record<string, number> = {
      'keys/activity d7': row.d7.requests,
      'keys/activity h24': row.h24.requests.reduce((a: number, b: number) => a + b, 0),
      'me/usage': me.totals.requests,
      'usage-overview workspace': overview.ledger.requests,
      'usage-overview keys rank': overview.keys.find((k: { id: string }) => k.id === KEY)?.requests,
      'analytics workspace total': requests.total,
      'usage-facets': facets.totals.requests,
      'usage-performance': perf.totals.requests,
      'overview 24h key strip': gateway.keys.rows.find((k: { id: string }) => k.id === KEY)?.total,
      'dashboard (legacy loader)': Number((dashboard.summary as unknown as { requests: number }).requests),
      'analytics (legacy) keyUsage': Number((legacy.keyUsage as Array<{ id: string; requests: number }>).find((k) => k.id === KEY)?.requests),
      'usage-overview (legacy)': (legacyOverview.models as Array<{ requests: number }>).reduce((a, m) => a + Number(m.requests), 0),
    }
    for (const [where, count] of Object.entries(counts)) assert.equal(count, ALL, `${where}: ${count} ≠ ${ALL}`)

    // the removed-channel part is reported, not hidden: counted (all) with its channels named and marked
    assert.equal(overview.scope.kind, 'all')
    assert.equal(overview.scope.removed.requests, 3)
    assert.equal(overview.scope.excluded.requests, 0)
    assert.deepEqual(overview.channels.map((c: { id: string; removed: boolean; requests: number }) => [c.id, c.removed, c.requests]).sort(),
      [['antigravity', true, 1], ['codex', false, 3], ['retired', true, 2]])
    assert.equal(activity.scope, 'all')
  })
})

test('只看当前渠道 is one explicit filter: every admin report narrows the same way; /me keeps counting everything', async () => {
  const keyCookie = `crosery_console_session=${createSessionToken({ role: 'key', keyHash: KEY })}`
  await withApp(async (get) => {
    const q = `days=7&keyId=${KEY}&currentOnly=1`
    const activity = await get('/api/keys/activity?currentOnly=1')
    const overview = await get(`/api/usage-overview?view=workspace&${q}`)
    const counts: Record<string, number> = {
      'keys/activity d7': activity.keys.find((k: { id: string }) => k.id === KEY).d7.requests,
      'usage-overview workspace': overview.ledger.requests,
      'analytics workspace total': (await get(`/api/analytics?view=workspace&${q}`)).total,
      'usage-facets': (await get(`/api/usage-facets?${q}`)).totals.requests,
      'usage-performance': (await get(`/api/usage-performance?${q}`)).totals.requests,
      'dashboard (legacy loader)': Number(((await loadDashboardReport(reader, groups, 7, KEY, Date.now(), true)).summary as unknown as { requests: number }).requests),
    }
    for (const [where, count] of Object.entries(counts)) assert.equal(count, CURRENT, `${where}: ${count} ≠ ${CURRENT}`)
    assert.equal(overview.scope.kind, 'current')
    assert.equal(overview.scope.excluded.requests, 3, 'what the filter left out is said, not silently dropped')
    assert.deepEqual(overview.channels.map((c: { id: string }) => c.id), ['codex'])
    assert.equal(activity.scope, 'current_channels')
    // the key user's own page has no channel filter: it is the Key's whole bill
    assert.equal((await get('/api/me/usage?days=7', keyCookie)).totals.requests, ALL)
  })
})

test('window boundary: /me "近 N 个自然日" is the calendar window, the admin 7d views are rolling 7 × 24h — documented, labelled apart', async () => {
  const { calendarWindowStart } = await import('./meRoutes.js')
  const { usageWorkspaceWindow } = await import('./usageReports.js')
  const EDGE = 'd'.repeat(64)
  db.prepare('INSERT INTO api_keys (key_hash,key_value,name,enabled,created_at,updated_at) VALUES (?,?,?,1,?,?)')
    .run(EDGE, 'sk-parity-edge', 'Edge', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')
  const now = Date.now()
  const meStart = calendarWindowStart(7, new Date(now))
  const adminStart = usageWorkspaceWindow(7, now).fromMs
  // inside both windows, and (when the local day is not in its last hour) one in the gap between the two starts
  insert(now - HOUR, EDGE, 'codex')
  const gap = meStart - adminStart >= HOUR
  if (gap) insert(adminStart + 60_000, EDGE, 'codex')
  const keyCookie = `crosery_console_session=${createSessionToken({ role: 'key', keyHash: EDGE })}`
  try {
    await withApp(async (get) => {
      const me = await get('/api/me/usage?days=7', keyCookie)
      const overview = await get(`/api/usage-overview?view=workspace&days=7&keyId=${EDGE}`)
      const activity = (await get('/api/keys/activity')).keys.find((k: { id: string }) => k.id === EDGE)
      assert.equal(me.from, new Date(meStart).toISOString(), '/me starts at local midnight 6 days back')
      assert.equal(me.totals.requests, 1, '/me counts its calendar window only')
      assert.equal(me.daily.reduce((total: number, day: { requests: number }) => total + day.requests, 0), me.totals.requests, 'cells sum to the total')
      assert.equal(overview.ledger.requests, gap ? 2 : 1, 'the admin window starts at the first whole hour after now − 7 × 24h')
      assert.equal(activity.d7.requests, overview.ledger.requests)
    })
  } finally {
    db.prepare('DELETE FROM usage_events WHERE key_hash = ?').run(EDGE)
    db.prepare('DELETE FROM usage_hourly_rollup WHERE key_hash = ?').run(EDGE)
    db.prepare('DELETE FROM api_keys WHERE key_hash = ?').run(EDGE)
  }
})
