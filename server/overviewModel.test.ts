import assert from 'node:assert/strict'
import test from 'node:test'
// loaded by URL (the keysView.test.ts pattern) so the server tsc build does not pull src/ into NodeNext resolution
const {
  attention,
  burnRows,
  channelHealth,
  checks,
  fmtEvery,
  jobChip,
  keyTail,
  laneJobs,
  ledger,
  policyWords,
  pressureRows,
  rollingWindows,
  severityWords,
  statusWord,
  windowShort,
} = await import(new URL('../src/features/overview/model.ts', import.meta.url).href)

// payload shapes are the frontend's (src/types.ts); the server build cannot see them, so the fixtures stay loose
type Loose = any
type ApiKeyItem = Loose
type ChannelItem = Loose
type DashboardData = Loose
type SyncJob = Loose
type UsageOverviewData = Loose
type VersionsData = Loose
type MonitorAccount = Loose
type OverviewChannelRow = Loose

/*
 * 概览 page model (Console v3 DESIGN §6.2): attention rules, rolling 24h windows, Key burn ranking, account
 * pressure, channel health and sync lanes. Pure functions over the existing endpoints' payloads.
 */

const NOW = Date.UTC(2026, 9, 2, 6, 30, 0)
const H = 3_600_000
const iso = (ms: number) => new Date(ms).toISOString()

function win(limitUsd: number, spentUsd: number, resetsAt: string | null = iso(NOW + 8 * H)) {
  return { limitUsd, spentUsd, ratio: limitUsd > 0 ? spentUsd / limitUsd : null, exceeded: limitUsd > 0 && spentUsd >= limitUsd, startsAt: iso(NOW - H), resetsAt }
}
function key(id: string, opts: Partial<{ enabled: boolean; daily: [number, number]; weekly: [number, number]; blocked: string; lastUsedAt: string }> = {}): ApiKeyItem {
  const daily = win(...(opts.daily ?? [0, 0]))
  const weekly = win(...(opts.weekly ?? [0, 0]))
  const total = win(0, 0, null)
  const exceeded = daily.exceeded || weekly.exceeded
  return {
    id, name: `key-${id}`, note: '', maskedKey: `sk-api-••••••••${id.padStart(5, '0')}`, enabled: opts.enabled ?? true, groups: [], totalConcurrency: 0,
    groupConcurrency: {}, createdAt: iso(NOW - 100 * H), updatedAt: iso(NOW), lastUsedAt: opts.lastUsedAt,
    quota: { totalUsd: 0, dailyUsd: opts.daily?.[0] ?? 0, weeklyUsd: opts.weekly?.[0] ?? 0 }, blockedReason: opts.blocked ?? '',
    quotaState: { unlimited: !opts.daily && !opts.weekly, total, daily, weekly, exceeded, exceededWindow: daily.exceeded ? 'daily' : weekly.exceeded ? 'weekly' : null },
  }
}
function job(id: string, over: Partial<SyncJob> = {}): SyncJob {
  return {
    id, label: id, kind: 'in-process', intervalMs: 1_800_000, lastRunAt: iso(NOW - H), lastFinishedAt: iso(NOW - H), nextRunAt: iso(NOW + H),
    state: 'idle', lastResult: 'ok', lastError: null, summary: null, backoffUntil: null, backoffLevel: 0, requests24h: 3, history: [],
    canRunNow: true, runCooldownUntil: null, ...over,
  }
}
function account(email: string, over: Partial<MonitorAccount> & { pct?: number; secs?: number } = {}): MonitorAccount {
  const { pct, secs, ...rest } = over
  return {
    email, type: 'codex', auth_index: email, status: 'active',
    normalizedQuota: pct === undefined ? null : { plan: 'pro', tier: 'Pro', resetCredits: { available: 1, applicable: 1, entries: [] }, error: null,
      windows: [{ id: 'primary', label: '5 小时额度', usedPercent: pct, resetsAt: iso(NOW + 2 * H), windowSeconds: secs ?? 18_000, severity: 'normal', scope: null }] },
    ...rest,
  }
}

test('small formatters: key tail, interval words, window labels, status words', () => {
  assert.equal(keyTail('sk-api-••••••••bf2ee'), '…bf2ee')
  assert.equal(keyTail('sk-feiy••••••••a971d'), '…a971d')
  assert.equal(keyTail('plain'), 'plain')
  assert.equal(fmtEvery(1_800_000), '每 30M')
  assert.equal(fmtEvery(5_000), '每 5S')
  assert.equal(fmtEvery(21_600_000), '每 6H')
  assert.equal(fmtEvery(null), '按需')
  assert.equal(windowShort({ windowSeconds: 18_000, label: '5 小时额度', id: 'primary' }), '5H')
  assert.equal(windowShort({ windowSeconds: 604_800, label: '7 天额度', id: 'secondary' }), '7D')
  assert.equal(windowShort({ windowSeconds: null, label: '7 天 Opus', id: 'seven_day_opus' }), '7D·O')
  assert.equal(statusWord(429), '限流')
  assert.equal(statusWord(503), '上游错误')
  assert.equal(policyWords({ globalUpstreamConcurrency: 4, minIntervalPerHostMs: 60_000, backoff: { factor: 2, maxMs: 21_600_000 }, jitterPct: 10 }), '全局上游并发 4 · 单源间隔 ≥1m · 失败退避 ×2 ≤6h')
})

test('sync lanes: chips match the statusline reading; disabled jobs are 停用 with no ghost run', () => {
  assert.equal(jobChip({ state: 'backoff', lastResult: 'error' }), 'backoff')
  assert.equal(jobChip({ state: 'idle', lastResult: 'error' }), 'failed')
  assert.equal(jobChip({ state: 'disabled', lastResult: null }), 'off')
  assert.equal(jobChip({ state: 'idle', lastResult: null }), 'idle')
  const [ok, off, back] = laneJobs([
    job('a', { history: [{ at: iso(NOW - H), result: 'ok', durationMs: 1200 }] }),
    job('b', { state: 'disabled', lastResult: null, intervalMs: 5000 }),
    job('c', { state: 'backoff', backoffLevel: 2, backoffUntil: iso(NOW + H) }),
  ])
  assert.deepEqual([ok.state, ok.stateLabel, ok.every, ok.runs.length, ok.calls24h], ['run', '正常', '每 30M', 1, 3])
  assert.deepEqual([off.state, off.stateLabel, off.nextAt], ['off', '停用', null])
  assert.deepEqual([back.state, back.stateLabel], ['warn', '退避 ×4'])
})

test('rolling 24h windows partition the 8-day hour buckets with the same cut as days=1', () => {
  const bucket = (ms: number) => new Date(ms).toISOString().slice(0, 13)
  const trend: DashboardData['trend'] = [
    { bucket: bucket(NOW - H), requests: 10, tokens: 100, errors: 1 },
    { bucket: bucket(NOW - 23 * H), requests: 5, tokens: 50, errors: 0 },
    { bucket: bucket(NOW - 25 * H), requests: 7, tokens: 70, errors: 7 },
    { bucket: bucket(NOW - 7 * 24 * H - 2 * H), requests: 3, tokens: 30, errors: 0 },
    { bucket: bucket(NOW + 2 * H), requests: 99, tokens: 0, errors: 0 }, // future: ignored
  ]
  const w = rollingWindows(trend, NOW)
  assert.equal(w.length, 8)
  assert.deepEqual(w[0], { requests: 15, tokens: 150, errors: 1 })
  assert.deepEqual(w[1], { requests: 7, tokens: 70, errors: 7 })
  assert.deepEqual(w[7], { requests: 3, tokens: 30, errors: 0 })
})

test('ledger: deltas vs the 7-day mean, success-rate drop is the only bad direction, unpriced is never $0.00', () => {
  const bucket = (ms: number) => new Date(ms).toISOString().slice(0, 13)
  const trend = Array.from({ length: 8 }, (_, d) => ({ bucket: bucket(NOW - d * 24 * H - 2 * H), requests: d === 0 ? 20 : 10, tokens: 1000, errors: d === 0 ? 4 : 0 }))
  const d1 = { days: 1, summary: { requests: 20, tokens: 1000, avgLatency: 2000, errorRate: 0.2 }, trend: [], generatedAt: iso(NOW) } as DashboardData
  const d8 = { days: 8, summary: { requests: 90, tokens: 8000, avgLatency: 1000 * (70 / 90) + 2000 * (20 / 90), errorRate: 4 / 90 }, trend, generatedAt: iso(NOW) } as DashboardData
  const u1 = { requests: 20, estimatedCostUsd: 3, hasPartialCost: true, unpricedModels: ['x', 'y'] } as unknown as UsageOverviewData
  const u8 = { requests: 90, estimatedCostUsd: 10, hasPartialCost: true, unpricedModels: ['x'] } as unknown as UsageOverviewData
  const cells = Object.fromEntries(ledger({ now: NOW, d1, d8, u1, u8, charts: { statusCodes: [{ code: 429, count: 3 }] } as never }).map((c: Loose) => [c.key, c]))
  assert.equal(cells.requests.value, '20')
  assert.equal(cells.requests.delta?.value, 1) // 20 vs mean 10 → +100%
  assert.equal(cells.requests.history?.length, 7)
  assert.equal(cells.success.value, '80.00%')
  assert.equal(cells.success.delta?.bad, true)
  assert.ok(Math.abs((cells.success.delta?.value ?? 0) + 0.2) < 1e-9)
  assert.equal(cells.success.sub, '失败 4 · 主因 429 限流 ×3')
  assert.equal(cells.cost.value, '≈ $3.00')
  assert.equal(cells.cost.sub, '未定价 2 个模型 · 不计入')
  assert.equal(cells.cost.delta?.value, 3 / 1 - 1) // prior 7 days = (10 − 3) / 7 = $1/day
  assert.ok(Math.abs((cells.latency.delta?.value ?? 0) - 1) < 1e-9) // 2s vs 1s prior
  assert.equal(cells.latency.delta?.bad, true)
  assert.equal(cells.cache.value, '—')

  const allUnpriced = ledger({ now: NOW, d1, d8, u1: { ...u1, estimatedCostUsd: null } as UsageOverviewData })
  assert.equal(allUnpriced.find((c: Loose) => c.key === 'cost')?.value, '—')
  assert.equal(allUnpriced.find((c: Loose) => c.key === 'cost')?.sub, '未定价')
  const idle = ledger({ now: NOW, d1: { ...d1, summary: { requests: 0, tokens: 0, avgLatency: 0, errorRate: 0 } }, u1: { ...u1, requests: 0, estimatedCostUsd: 0 } as UsageOverviewData })
  assert.equal(idle.find((c: Loose) => c.key === 'cost')?.value, '—')
  assert.equal(idle.find((c: Loose) => c.key === 'success')?.value, '—') // no requests is not 100% or 0%
  assert.equal(idle.find((c: Loose) => c.key === 'latency')?.value, '—')
})

test('attention: Key over quota is ◆ with 调整额度, ≥90% is ◇, only manually stopped keys are not to-dos', () => {
  const r = attention({ now: NOW, keys: [
    key('1', { daily: [10, 12] }),
    key('2', { weekly: [100, 93] }),
    key('3', { daily: [10, 12], enabled: false }), // stopped by hand
    key('4', { daily: [10, 1] }),
    key('5', { daily: [10, 11], enabled: false, blocked: 'daily' }), // stopped by the quota gate
  ] })
  assert.deepEqual(r.items.map((it: Loose) => [it.id, it.severity]), [['key:1', 'bad'], ['key:5', 'bad'], ['key:2', 'warn']])
  assert.equal(r.items[0].reason, '日额度超出 · 已自动停用')
  assert.equal(r.items[0].metric, '$12.00 / $10.00')
  assert.deepEqual(r.items[0].action, { label: '调整额度', to: '/keys?q=key-1' })
  assert.equal(r.items[2].metric, '93%')
  assert.equal(r.items[1].reason, '日额度超出 · 已自动停用')
  assert.deepEqual(r.counts, { bad: 2, warn: 1, note: 0 })
  assert.deepEqual(severityWords(r.counts).map((s: Loose) => s.text), ['2 告警', '1 注意'])
})

test('attention: accounts — exhausted ◆, auth failure ◆ 重新授权, cooldown alone is not a to-do unless the pool is empty', () => {
  const later = iso(NOW + 5 * 60_000)
  const r = attention({
    now: NOW,
    accounts: [
      account('a@x.example', { pct: 100 }),
      account('b@x.example', { pct: 10, status: 'error', status_message: '401 unauthorized' }),
      account('c@x.example', { pct: 40, unavailable: true, next_retry_after: later }),
      account('d@x.example', { pct: 50 }),
      account('e@y.example', { type: 'claude', pct: 20, unavailable: true, next_retry_after: later }),
      account('f@x.example', { pct: 100, disabled: true }),
    ],
  })
  const ids = r.items.map((it: Loose) => it.id)
  assert.ok(ids.includes('acct:a@x.example'))
  assert.equal(r.items.find((it: Loose) => it.id === 'acct:a@x.example')?.action?.label, '去重置')
  assert.equal(r.items.find((it: Loose) => it.id === 'acct:b@x.example')?.action?.label, '重新授权')
  assert.ok(!ids.includes('acct:c@x.example'), 'codex still has d routable')
  assert.ok(ids.includes('acct-pool:claude'), 'the only claude account is cooling')
  assert.ok(!ids.some((id: Loose) => id.includes('f@x')), 'disabled accounts are not to-dos')
})

test('pressure rows: tightest window first, cooldown keeps its until, disabled last', () => {
  const rows = pressureRows([
    account('low@x', { pct: 20 }),
    account('off@x', { pct: 99, disabled: true }),
    account('cool@x', { pct: 60, unavailable: true, next_retry_after: iso(NOW + 60_000) }),
    account('high@x', { pct: 95 }),
  ], NOW)
  assert.deepEqual(rows.map((r: Loose) => r.email), ['high@x', 'cool@x', 'low@x', 'off@x'])
  assert.deepEqual([rows[0].state, rows[0].window?.short], ['warn', '5H'])
  assert.equal(rows[1].state, 'cool')
  assert.equal(rows[1].coolUntil, iso(NOW + 60_000))
  assert.deepEqual([rows[3].state, rows[3].stateLabel], ['pause', '暂停']) // the Accounts page word
})

test('channel health: traffic first, idle enabled next, disabled last; failing ticks need ≥20% errors', () => {
  const ticks = Array(36).fill(0)
  const bad = Array(36).fill(0)
  ticks[35] = 10
  bad[35] = 1
  ticks[34] = 4
  bad[34] = 4
  const rows: OverviewChannelRow[] = [{ provider: 'openai-compatible-openrouter', name: 'openrouter', requests: 14, errors: 5, p95Ms: 900, ticks, bad, lastAt: NOW }]
  const channels = [
    { name: 'zeta', enabled: false, stale: false, keyCount: 1, baseUrl: '', models: [] },
    { name: 'alpha', enabled: true, stale: false, keyCount: 1, baseUrl: '', models: [] },
    { name: 'openrouter', enabled: true, stale: false, keyCount: 1, baseUrl: '', models: [] },
  ] as ChannelItem[]
  const h = channelHealth(rows, channels)
  assert.deepEqual(h.map((r: Loose) => [r.name, r.state]), [['openrouter', 'warn'], ['alpha', 'idle'], ['zeta', 'off']])
  assert.equal(h[0].bad[35], false) // 1 error in 10
  assert.equal(h[0].bad[34], true)
  assert.equal(h[0].to, '/channels?q=openrouter')
  const att = attention({ now: NOW, channels, health: h })
  assert.deepEqual(att.items.map((it: Loose) => [it.id, it.severity]), [['chan:openai-compatible-openrouter', 'warn'], ['chan-off', 'note']])
  assert.equal(att.items[0].action?.to, '/usage/requests?days=1&provider=openrouter')
})

test('channel health: a removed channel keeps its traffic row, says 已移除 and links to its usage, never hot', () => {
  const ticks = Array(36).fill(0)
  ticks[35] = 6
  const bad = Array(36).fill(0)
  bad[35] = 6
  const rows: OverviewChannelRow[] = [{ provider: 'openai-compatible-retired', name: 'retired', requests: 6, errors: 6, p95Ms: null, ticks, bad, lastAt: NOW, removed: true }]
  const [row] = channelHealth(rows, [] as ChannelItem[])
  assert.deepEqual([row.name, row.state, row.stateLabel, row.hot, row.to], ['retired', 'off', '已移除', false, '/usage?provider=retired'])
})

test('Key burn: over-quota first, then pressure, then spend; state words are the Keys page words', () => {
  const keys = [
    key('a', { weekly: [0, 0], lastUsedAt: iso(NOW - 60_000) }),
    key('b', { daily: [10, 12], enabled: false, blocked: 'daily' }),
    key('c', { weekly: [100, 95] }),
    key('d', { enabled: false }),
  ]
  keys[0].quotaState.weekly.spentUsd = 500
  const rows = burnRows(keys, null, NOW)
  assert.deepEqual(rows.map((r: Loose) => r.id), ['b', 'c', 'a', 'd'])
  assert.deepEqual(rows.map((r: Loose) => [r.state, r.stateLabel]), [['bad', '超额停用'], ['warn', '接近上限'], ['run', '启用'], ['off', '停用']])
  assert.deepEqual(rows.map((r: Loose) => r.exceeded), [true, false, false, false])
  assert.equal(rows[2].live, true) // called 1 min ago
  assert.equal(rows[2].hours, null)
  const withHours = burnRows(keys, new Map([['a', { requests: Array(24).fill(1), errors: Array(24).fill(0), total: 24 }]]), NOW)
  assert.equal(withHours.find((r: Loose) => r.id === 'a')?.requests24h, 24)
  assert.equal(withHours.find((r: Loose) => r.id === 'c')?.requests24h, 0)
  assert.deepEqual(withHours.find((r: Loose) => r.id === 'c')?.hours, Array(24).fill(0))
})

test('kernel and sync to-dos; 巡检 marks follow the worst open item per domain', () => {
  const versions = { cpa: { engine: 'magpie', version: '3fe2ff9', commit: '3fe2ff99587e', buildDate: '', upstream: { status: 'review_required', latestRelease: 'v0.1.613', candidateRevision: 'abc', changes: { addedRoutes: ['a', 'b'], removedRoutes: [], changedRoutes: ['c'], addedLoginAgents: ['kimi'], removedLoginAgents: [] } } } } as unknown as VersionsData
  const jobs = [
    job('pricing', { state: 'backoff', backoffUntil: iso(NOW + H), backoffLevel: 1, lastError: '429' }),
    job('models', { history: [{ at: iso(NOW - 3 * H), result: 'error', durationMs: 10 }, { at: iso(NOW - H), result: 'ok', durationMs: 10 }] }),
  ]
  const r = attention({ now: NOW, versions, jobs })
  assert.deepEqual(r.items.map((it: Loose) => [it.kind, it.severity]), [['SYNC', 'warn'], ['KERN', 'note']])
  assert.equal(r.items[0].action?.to, '/settings#sync')
  // same count as /settings 内核与版本 (routes + login agents)
  assert.equal(r.items[1].reason, '内核上游有候选 · 契约变化 4 项')
  assert.equal(r.recovered.length, 1)
  const rows = checks({ attention: r, jobs, versions, keys: [key('1')], channels: [], accounts: [] })
  const by = Object.fromEntries(rows.map((row: Loose) => [row.key, row]))
  assert.equal(by.sync.mark, '◇')
  assert.equal(by.kern.mark, '○')
  assert.equal(by.key.mark, '✓')
  assert.equal(by.acct.text, '没有接入账号 · OAuth 额度为 0')
  assert.equal(by.gateway.mark, '—')
})
