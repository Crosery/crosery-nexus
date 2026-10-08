import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import type { ConsoleGroup } from './groups.js'
import { ACTIVITY_HOURS, loadKeysActivity, registerKeysViewRoutes, RECENT_ERRORS } from './keysView.js'
import type { ReadOperation } from './sqliteReadWorker.js'

const HOUR = 3_600_000
const DAY = 24 * HOUR
const NOW = Date.UTC(2026, 9, 2, 6, 30, 0)
const CURRENT_HOUR = Math.floor(NOW / HOUR) * HOUR
const K1 = 'a'.repeat(64)
const K2 = 'b'.repeat(64)
const GONE = 'c'.repeat(64)

const groups: ConsoleGroup[] = [{ id: 'openrouter', name: 'openrouter', color: '#000', kind: 'compat', models: [] }]

function fixture() {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE api_keys (key_hash TEXT PRIMARY KEY, key_value TEXT NOT NULL, name TEXT NOT NULL);
    CREATE TABLE usage_hourly_rollup (
      hour_ms INTEGER NOT NULL, key_hash TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
      success INTEGER NOT NULL, status_code INTEGER NOT NULL, error_category TEXT NOT NULL,
      request_count INTEGER NOT NULL, total_tokens INTEGER NOT NULL
    );
    CREATE TABLE usage_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp_ms INTEGER NOT NULL, key_hash TEXT, provider TEXT NOT NULL,
      model TEXT NOT NULL, success INTEGER NOT NULL, status_code INTEGER NOT NULL, error_category TEXT NOT NULL DEFAULT '',
      error_detail TEXT NOT NULL DEFAULT '', client_ip TEXT NOT NULL DEFAULT ''
    );
  `)
  const key = db.prepare("INSERT INTO api_keys VALUES (?, 'sk-secret-value', ?)")
  key.run(K1, 'alpha')
  key.run(K2, 'beta')
  const rollup = db.prepare('INSERT INTO usage_hourly_rollup VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
  const event = db.prepare('INSERT INTO usage_events (timestamp_ms, key_hash, provider, model, success, status_code, error_category, error_detail, client_ip) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
  const reader = {
    calls: 0,
    async run(operations: readonly ReadOperation[]) {
      reader.calls += 1
      return operations.map((op) => {
        const statement = db.prepare(op.sql)
        const params = (op.params ?? []) as Array<string | number>
        return op.method === 'all' ? statement.all(...params) : statement.get(...params)
      })
    },
  }
  return {
    db,
    reader,
    roll: (hour: number, keyHash: string, opts: { provider?: string; model?: string; ok?: boolean; status?: number; category?: string; n?: number; tokens?: number } = {}) =>
      rollup.run(hour, keyHash, opts.provider ?? 'openrouter', opts.model ?? 'openrouter/gemma-4', opts.ok === false ? 0 : 1,
        opts.status ?? (opts.ok === false ? 429 : 200), opts.category ?? (opts.ok === false ? 'rate_limited' : ''), opts.n ?? 1, opts.tokens ?? 100),
    fail: (ms: number, keyHash: string, opts: { provider?: string; model?: string; status?: number; category?: string } = {}) =>
      event.run(ms, keyHash, opts.provider ?? 'openrouter', opts.model ?? 'openrouter/gemma-4', 0, opts.status ?? 429, opts.category ?? 'rate_limited', 'upstream said no', '192.0.2.1'),
  }
}

test('keys activity: every Key gets zero-filled 24h hourly buckets and 7 × 24h day buckets, oldest first', async () => {
  const { reader, roll } = fixture()
  roll(CURRENT_HOUR, K1, { n: 3 })
  roll(CURRENT_HOUR, K1, { ok: false, n: 2 })
  roll(CURRENT_HOUR - 23 * HOUR, K1, { n: 1 })
  roll(CURRENT_HOUR - 24 * HOUR, K1, { n: 5 }) // in the 7-day window, outside the 24h bars
  const payload = await loadKeysActivity(reader, groups, NOW)
  assert.equal(payload.scope, 'all')
  assert.equal((await loadKeysActivity(reader, groups, NOW, true)).scope, 'current_channels')
  assert.equal(payload.hours, ACTIVITY_HOURS)
  assert.equal(payload.hourStart, new Date(CURRENT_HOUR - 23 * HOUR).toISOString())
  assert.equal(payload.since, new Date(NOW - 7 * DAY).toISOString())
  assert.deepEqual(payload.keys.map((k) => k.id), [K1, K2])
  const [alpha, beta] = payload.keys
  assert.equal(alpha.h24.requests.length, 24)
  assert.equal(alpha.h24.requests.at(-1), 5)
  assert.equal(alpha.h24.errors.at(-1), 2)
  assert.equal(alpha.h24.requests[0], 1)
  assert.equal(alpha.h24.requests.reduce((a, b) => a + b, 0), 6)
  assert.equal(alpha.d7.requests, 11)
  assert.equal(alpha.d7.errors, 2)
  assert.equal(alpha.d7.daily.length, 7)
  assert.equal(alpha.d7.daily.reduce((a, d) => a + d.requests, 0), alpha.d7.requests, 'day bars sum to the 7-day total')
  assert.equal(alpha.d7.daily.at(-1)?.requests, 6)
  // a Key with no traffic is present with real zeros (the endpoint answered), never missing
  assert.deepEqual(beta.h24.requests, Array(24).fill(0))
  assert.equal(beta.d7.requests, 0)
  assert.deepEqual(beta.d7.topModels, [])
  assert.deepEqual(beta.recentErrors, [])
})

test('keys activity: same window and channel scope as the admin usage reports (all channels by default, hour_ms ≥ now − 7d)', async () => {
  const { reader, roll, fail } = fixture()
  roll(CURRENT_HOUR, K1, { provider: 'codex', n: 40 }) // channel no longer configured: history, counted by default
  roll(CURRENT_HOUR, K1, { provider: 'openai-compatible-openrouter', n: 2 }) // compat alias of the current channel
  const outside = Math.floor((NOW - 7 * DAY) / HOUR) * HOUR // starts before the cutoff: excluded (hour_ms >= cutoff)
  roll(outside, K1, { n: 9 })
  roll(outside + HOUR, K1, { n: 1 })
  fail(NOW - 60_000, K1, { provider: 'codex' })
  fail(NOW - 8 * DAY, K1)
  const alpha = (await loadKeysActivity(reader, groups, NOW)).keys[0]
  assert.equal(alpha.d7.requests, 43)
  assert.equal(alpha.d7.daily[0].requests, 1, 'the first hour inside the window lands in the oldest day bucket')
  assert.deepEqual(alpha.recentErrors.map((e) => e.status), [429], 'a failure on a removed channel is still the latest failure')
  // opt-in 只看当前渠道: the removed codex traffic is left out
  const current = (await loadKeysActivity(reader, groups, NOW, true)).keys[0]
  assert.equal(current.d7.requests, 3)
  assert.deepEqual(current.recentErrors, [])
})

test('keys activity: top models are canonical ids by requests; error kinds and the latest errors are per Key', async () => {
  const { reader, roll, fail } = fixture()
  roll(CURRENT_HOUR, K1, { model: 'openrouter/gemma-4', n: 4, tokens: 10 })
  roll(CURRENT_HOUR - HOUR, K1, { model: 'gemma-4', n: 3, tokens: 10 })
  roll(CURRENT_HOUR, K1, { model: 'openrouter/qwen-3', n: 5, tokens: 10 })
  roll(CURRENT_HOUR, K1, { model: 'a-model', n: 1 })
  roll(CURRENT_HOUR, K1, { model: 'z-model', n: 1 })
  roll(CURRENT_HOUR, K1, { ok: false, status: 429, category: 'rate_limited', n: 11 })
  roll(CURRENT_HOUR, K1, { ok: false, status: 403, category: 'auth_failed', n: 8 })
  roll(CURRENT_HOUR, K1, { ok: false, status: 502, category: 'upstream_5xx', n: 2 })
  roll(CURRENT_HOUR, K1, { ok: false, status: 400, category: 'other', n: 1 })
  for (let i = 0; i < RECENT_ERRORS + 2; i += 1) fail(NOW - i * 60_000, K1, { status: 400 + i })
  fail(NOW - 5_000, K2, { status: 401, category: 'auth_failed', model: 'openrouter/qwen-3' })
  fail(NOW - 5_000, GONE)
  const payload = await loadKeysActivity(reader, groups, NOW)
  const [alpha, beta] = payload.keys
  assert.deepEqual(alpha.d7.topModels.map((m) => [m.model, m.requests]), [['gemma-4', 7 + 22], ['qwen-3', 5], ['a-model', 1]])
  assert.deepEqual(alpha.d7.errorKinds, [
    { status: 429, category: 'rate_limited', count: 11 },
    { status: 403, category: 'auth_failed', count: 8 },
    { status: 502, category: 'upstream_5xx', count: 2 },
  ])
  assert.equal(alpha.recentErrors.length, RECENT_ERRORS)
  assert.deepEqual(alpha.recentErrors.map((e) => e.status), [400, 401, 402, 403, 404], 'newest first')
  assert.equal(alpha.recentErrors[0].at, new Date(NOW).toISOString())
  assert.deepEqual(beta.recentErrors, [{ at: new Date(NOW - 5_000).toISOString(), model: 'qwen-3', status: 401, category: 'auth_failed' }])
  assert.equal(payload.keys.length, 2, 'usage of a deleted Key is dropped')
})

test('keys activity: the payload carries no key values, names, error bodies, IPs or provider names', async () => {
  const { reader, roll, fail } = fixture()
  roll(CURRENT_HOUR, K1, { n: 2 })
  fail(NOW - 1_000, K1)
  const text = JSON.stringify(await loadKeysActivity(reader, groups, NOW))
  for (const leaked of ['sk-secret-value', 'alpha', 'upstream said no', '192.0.2.1', 'openrouter/']) assert.ok(!text.includes(leaked), `must not contain ${leaked}`)
})

test('keys activity: the default needs no channel list; 只看当前渠道 with no current channel means no rows (fail-closed)', async () => {
  const { reader, roll } = fixture()
  roll(CURRENT_HOUR, K1, { n: 2 })
  assert.equal((await loadKeysActivity(reader, [], NOW)).keys[0].d7.requests, 2)
  assert.equal((await loadKeysActivity(reader, [], NOW, true)).keys[0].d7.requests, 0)
})

type Handler = (req: unknown, res: FakeRes) => Promise<void>
type FakeRes = { statusCode: number; body: unknown; headers: Record<string, string>; status(code: number): FakeRes; json(body: unknown): FakeRes; setHeader(k: string, v: string): void }
const fakeRes = (): FakeRes => {
  const res: FakeRes = {
    statusCode: 200, body: undefined, headers: {},
    status(code) { res.statusCode = code; return res },
    json(body) { res.body = body; return res },
    setHeader(k, v) { res.headers[k] = v },
  }
  return res
}
function mount(deps: Parameters<typeof registerKeysViewRoutes>[1]) {
  const routes = new Map<string, Handler>()
  registerKeysViewRoutes({ get: ((path: string, handler: Handler) => routes.set(path, handler)) as never }, deps)
  return routes
}

test('GET /api/keys/activity: one computation per 15 s is shared; the default never needs channel groups, ?currentOnly=1 does', async () => {
  const { reader, roll } = fixture()
  roll(CURRENT_HOUR, K1, { n: 2 })
  let clock = NOW
  const handler = mount({ usageReader: reader, groups: async () => groups, now: () => clock }).get('/api/keys/activity')!
  const first = fakeRes()
  await handler({ query: {} }, first)
  assert.equal(first.statusCode, 200)
  assert.equal((first.body as { keys: unknown[]; scope: string }).keys.length, 2)
  assert.equal((first.body as { scope: string }).scope, 'all')
  assert.equal(first.headers['Cache-Control'], 'private, max-age=15')
  const second = fakeRes()
  await handler({ query: {} }, second)
  assert.equal(reader.calls, 1, 'second call within the TTL reuses the computation')
  clock += 16_000
  await handler({ query: {} }, fakeRes())
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(reader.calls, 2, 'past the TTL the value is refreshed (stale-while-revalidate)')
  const scoped = fakeRes()
  await handler({ query: { currentOnly: '1' } }, scoped)
  assert.equal((scoped.body as { scope: string }).scope, 'current_channels')

  const down = mount({ usageReader: reader, groups: async () => { throw new Error('cpa down') } }).get('/api/keys/activity')!
  const ok = fakeRes()
  await down({ query: {} }, ok)
  assert.equal(ok.statusCode, 200, 'all-channel default does not depend on the control plane')
  const res = fakeRes()
  await down({ query: { currentOnly: '1' } }, res)
  assert.equal(res.statusCode, 503)
  assert.deepEqual(res.body, { error: '渠道信息暂不可用 · 稍后再试', code: 'reporting_unavailable' })
})

/* ── the page's pure model (src/features/keys/keysModel.ts) ─────────────────────────────────────────── */

// Loaded by URL so tsconfig.server (NodeNext) does not pull the app's extension-less type modules into its program.
const {
  capMoney, failingBuckets, keyStatus, keyTail, resetLabel, shortUsd, sortKeys, validateEditor, validateQuotaDraft,
} = await import(new URL('../src/features/keys/keysModel.ts', import.meta.url).href)

type Win = { limitUsd: number; spentUsd: number; ratio: number | null; exceeded: boolean; startsAt: string; resetsAt: string | null }
type Item = Record<string, unknown> & { name: string }

const win = (limitUsd: number, spentUsd: number, exceeded = false): Win => ({
  limitUsd, spentUsd, ratio: limitUsd > 0 ? spentUsd / limitUsd : null, exceeded, startsAt: '2026-10-01T16:00:00.000Z', resetsAt: null,
})

function keyOf(over: Record<string, unknown> & { daily?: Win; weekly?: Win; total?: Win }): Item {
  const { daily = win(0, 0), weekly = win(0, 0), total = win(0, 0), ...rest } = over
  return {
    id: rest.name ?? 'k', name: 'k', note: '', maskedKey: 'sk-ab••••••••cd12', enabled: true, groups: ['g'], totalConcurrency: 0,
    groupConcurrency: {}, createdAt: '', updatedAt: '', quota: { totalUsd: 0, dailyUsd: 0, weeklyUsd: 0 }, blockedReason: '',
    quotaState: { daily, weekly, total }, ...rest,
  }
}

test('keysModel: status words follow enabled, blocked and the 90% line', () => {
  assert.equal(keyStatus(keyOf({})), 'run')
  assert.equal(keyStatus(keyOf({ daily: win(50, 46) })), 'near')
  assert.equal(keyStatus(keyOf({ weekly: win(200, 201, true), blockedReason: '周额度已用' })), 'blocked')
  assert.equal(keyStatus(keyOf({ enabled: false, daily: win(50, 49) })), 'off')
  assert.equal(keyTail('sk-ab••••••••cd12'), 'sk-ab…cd12')
})

test('keysModel: default order is pressure, then blocked, then today and week spend', () => {
  const keys = [
    keyOf({ name: 'idle' }),
    keyOf({ name: 'week-heavy', weekly: win(0, 519) }),
    keyOf({ name: 'today', daily: win(0, 3), weekly: win(0, 3) }),
    keyOf({ name: 'near', daily: win(50, 46) }),
  ]
  assert.deepEqual((sortKeys(keys, 'pressure', null) as Item[]).map((k) => k.name), ['near', 'today', 'week-heavy', 'idle'])
})

test('keysModel: quota draft mirrors the server window rules', () => {
  assert.deepEqual(validateQuotaDraft({ daily: '', weekly: ' 600 ', total: '3000' }).values, { dailyUsd: 0, weeklyUsd: 600, totalUsd: 3000 })
  assert.ok(validateQuotaDraft({ daily: '60', weekly: '50', total: '' }).errors.daily)
  assert.ok(validateQuotaDraft({ daily: '', weekly: '700', total: '600' }).errors.weekly)
  assert.ok(validateQuotaDraft({ daily: '1.234', weekly: '', total: '' }).errors.daily)
  assert.ok(validateQuotaDraft({ daily: '-1', weekly: '', total: '' }).errors.daily)
  assert.ok(validateQuotaDraft({ daily: '', weekly: '', total: '1000001' }).errors.total)
})

test('keysModel: editor needs a unique name, a channel and per-channel caps within the total', () => {
  const base = { name: 'bot', note: '', groups: ['a', 'b'], unlimited: false, totalConcurrency: '4', groupConcurrency: { a: '2', b: '4' } }
  assert.deepEqual(validateEditor(base, [{ name: 'other' }]), {})
  assert.ok(validateEditor(base, [{ name: 'bot' }]).name)
  assert.ok(validateEditor({ ...base, groups: [] }, []).groups)
  assert.ok(validateEditor({ ...base, groupConcurrency: { a: '2', b: '5' } }, [])['group:b'])
  assert.ok(validateEditor({ ...base, totalConcurrency: '501' }, []).totalConcurrency)
  assert.deepEqual(validateEditor({ ...base, unlimited: true, totalConcurrency: '', groupConcurrency: {} }, []), {})
})

test('keysModel: a bucket is marked failing only when a quarter of it failed', () => {
  assert.deepEqual(failingBuckets([0, 100, 100, 4], [0, 1, 25, 1]), [0, 0, 25, 1])
})

test('keysModel: short money and rollover labels', () => {
  assert.equal(shortUsd(50), '$50')
  assert.equal(shortUsd(1500), '$1.5k')
  assert.equal(shortUsd(5000), '$5k')
  const fmt = (v: number, o: { digits: number }) => `$${v.toFixed(o.digits)}`
  assert.equal(capMoney(46.12, fmt), '$46.12')
  assert.equal(capMoney(600, fmt), '$600')
  assert.equal(capMoney(1912.4, fmt), '$1912')
  const parts = (v: string | number) => {
    const d = new Date(v)
    return { hour: String(d.getUTCHours()).padStart(2, '0'), minute: String(d.getUTCMinutes()).padStart(2, '0'), weekday: d.getUTCDay() }
  }
  const now = Date.parse('2026-10-02T10:00:00Z')
  assert.equal(resetLabel('2026-10-03T00:00:00Z', now, parts), '↻ 00:00')
  assert.equal(resetLabel('2026-10-05T00:00:00Z', now, parts), '↻ 周一 00:00')
  assert.equal(resetLabel(null, now, parts), '')
})

test('GET /api/keys/activity: a read failure answers 503 with fixed text, never the DB / worker message', async () => {
  const failing = { run: async () => { throw new Error('SQLITE_BUSY: database is locked at /secret/path/console.db') } }
  const handler = mount({ usageReader: failing, groups: async () => groups }).get('/api/keys/activity')!
  const res = fakeRes()
  const warn = console.warn
  console.warn = () => {}
  try {
    await handler({ query: {} }, res)
  } finally {
    console.warn = warn
  }
  assert.equal(res.statusCode, 503)
  assert.deepEqual(res.body, { error: 'Key 用量暂不可用', code: 'activity_unavailable' })
})
