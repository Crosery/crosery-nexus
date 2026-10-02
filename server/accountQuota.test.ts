import assert from 'node:assert/strict'
import test from 'node:test'
import { formatClaudeTier, isMonitoredAccountType, normalizeAccountQuota, severityFor } from './accountQuota.js'

const codexQuota = {
  plan_type: 'pro',
  rate_limit: {
    primary_window: { used_percent: 1, limit_window_seconds: 604800, reset_at: 1786160124 },
    secondary_window: null,
  },
  additional_rate_limits: [
    {
      limit_name: 'GPT-5.3-Codex-Spark',
      rate_limit: { primary_window: { used_percent: 12, limit_window_seconds: 604800, reset_at: 1786160411 } },
    },
  ],
}

const claudeQuota = {
  usage: {
    five_hour: { utilization: 17, resets_at: '2026-08-02T19:09:59.736648+00:00' },
    seven_day: { utilization: 92, resets_at: '2026-08-03T00:59:59.736670+00:00' },
    limits: [
      { kind: 'session', percent: 17, severity: 'normal', resets_at: '2026-08-02T19:09:59.736648+00:00', scope: null },
      { kind: 'weekly_all', percent: 92, severity: 'critical', resets_at: '2026-08-03T00:59:59.736670+00:00', scope: null },
      {
        kind: 'weekly_scoped',
        percent: 23,
        severity: 'normal',
        resets_at: '2026-08-03T00:59:59.736919+00:00',
        scope: { model: { display_name: 'Fable' } },
      },
    ],
  },
  profile: { account: { has_claude_max: true } },
}

test('codex reset_at is unix seconds and must become a real timestamp', () => {
  const quota = normalizeAccountQuota('codex', codexQuota)
  const primary = quota.windows.find((window) => window.id === 'primary')
  assert.equal(primary?.resetsAt, new Date(1786160124 * 1000).toISOString())
  assert.equal(primary?.windowSeconds, 604800)
})

test('codex per-model limits surface as their own windows', () => {
  const quota = normalizeAccountQuota('codex', codexQuota)
  const spark = quota.windows.find((window) => window.label === 'GPT-5.3-Codex-Spark')
  assert.ok(spark)
  assert.equal(spark?.usedPercent, 12)
  assert.equal(spark?.resetsAt, new Date(1786160411 * 1000).toISOString())
})

test('codex plan type becomes a readable label', () => {
  assert.equal(normalizeAccountQuota('codex', codexQuota).plan, 'Codex Pro')
})

test('null windows are dropped rather than rendered as zero', () => {
  const quota = normalizeAccountQuota('codex', codexQuota)
  assert.equal(quota.windows.find((window) => window.id === 'secondary'), undefined)
})

test('claude limits carry upstream severity and scoped model names', () => {
  const quota = normalizeAccountQuota('claude', claudeQuota)
  assert.equal(quota.plan, 'Claude Max')
  const weekly = quota.windows.find((window) => window.id.startsWith('weekly_all'))
  assert.equal(weekly?.severity, 'critical')
  assert.equal(weekly?.usedPercent, 92)
  const scoped = quota.windows.find((window) => window.scope === 'Fable')
  assert.equal(scoped?.label, '7 天额度 · Fable')
})

test('claude falls back to legacy fields when limits[] is absent', () => {
  const quota = normalizeAccountQuota('claude', {
    usage: { five_hour: { utilization: 40, resets_at: '2026-08-02T19:09:59Z' } },
    profile: { account: { has_claude_pro: true } },
  })
  assert.equal(quota.plan, 'Claude Pro')
  assert.deepEqual(quota.windows.map((window) => window.label), ['5 小时额度'])
  assert.equal(quota.windows[0].usedPercent, 40)
})

test('upstream errors pass through instead of showing an empty card', () => {
  const quota = normalizeAccountQuota('claude', { error: '上游返回 HTTP 429' })
  assert.equal(quota.error, '上游返回 HTTP 429')
  assert.deepEqual(quota.windows, [])
})

test('severity thresholds match across both providers', () => {
  assert.equal(severityFor(10), 'normal')
  assert.equal(severityFor(75), 'warning')
  assert.equal(severityFor(90), 'critical')
  assert.equal(severityFor(100), 'critical')
})

test('claude rate_limit_tier becomes a readable multiplier badge', () => {
  assert.equal(formatClaudeTier('default_claude_max_20x'), 'Max 20×')
  assert.equal(formatClaudeTier('default_claude_max_5x'), 'Max 5×')
  assert.equal(formatClaudeTier('default_claude_pro'), 'Pro')
  assert.equal(formatClaudeTier(''), '')
  assert.equal(formatClaudeTier(null), '')
})

test('claude tier is read from the organization, not the account flags', () => {
  const quota = normalizeAccountQuota('claude', {
    ...claudeQuota,
    profile: { account: { has_claude_max: true }, organization: { rate_limit_tier: 'default_claude_max_20x' } },
  })
  assert.equal(quota.plan, 'Claude Max')
  assert.equal(quota.tier, 'Max 20×')
})

test('codex reset credits come from usage when the credits endpoint is unavailable', () => {
  const quota = normalizeAccountQuota('codex', {
    ...codexQuota,
    rate_limit_reset_credits: { available_count: 1, applicable_available_count: 0 },
  })
  assert.deepEqual(quota.resetCredits, { available: 1, applicable: 0, entries: [] })
  assert.equal(quota.tier, 'Pro')
})

test('the credits endpoint supplies expiry times that usage does not carry', () => {
  const quota = normalizeAccountQuota(
    'codex',
    { ...codexQuota, rate_limit_reset_credits: { available_count: 1, applicable_available_count: 0 } },
    { availableCount: 1, credits: [{ id: 'credit-1', expiresAt: '2026-08-13T01:39:19Z' }] },
  )
  assert.equal(quota.resetCredits?.available, 1)
  assert.deepEqual(quota.resetCredits?.entries, [{ id: 'credit-1', expiresAt: '2026-08-13T01:39:19Z' }])
})

test('missing reset credits stay null instead of showing zero', () => {
  const quota = normalizeAccountQuota('codex', { plan_type: 'pro', rate_limit: { primary_window: null } })
  assert.equal(quota.resetCredits, null)
})

test('AntiGravity remaining fractions become used-percent windows grouped by model family', () => {
  const quota = normalizeAccountQuota('antigravity', {
    subscription: { plan: 'ultra', tierId: 'g1-ultra-tier', tierName: 'Google AI Ultra' },
    groups: [
      {
        displayName: 'Gemini Models',
        buckets: [
          { bucketId: 'gemini-weekly', displayName: 'Weekly Limit Remaining', remainingFraction: 0.7, resetTime: '2026-09-03T07:28:21Z', window: 'weekly' },
          { bucketId: 'gemini-5h', displayName: 'Five Hour Limit Remaining', remainingFraction: 0.93, resetTime: '2026-09-01T18:18:30Z', window: '5h' },
        ],
      },
      {
        displayName: 'Claude and GPT models',
        buckets: [
          { bucketId: 'claude-gpt-weekly', displayName: 'Weekly Limit Remaining', remainingFraction: 0.35, resetTime: '2026-09-08T10:37:04Z', window: 'weekly' },
        ],
      },
    ],
  })

  assert.equal(quota.plan, 'AntiGravity Ultra')
  assert.equal(quota.tier, 'Google AI Ultra')
  assert.deepEqual(quota.windows.map((window) => ({ label: window.label, usedPercent: Math.round(window.usedPercent), scope: window.scope })), [
    { label: 'Gemini 模型 · 7 天额度', usedPercent: 30, scope: 'Gemini 模型' },
    { label: 'Gemini 模型 · 5 小时额度', usedPercent: 7, scope: 'Gemini 模型' },
    { label: 'Claude / GPT 模型 · 7 天额度', usedPercent: 65, scope: 'Claude / GPT 模型' },
  ])
  assert.equal(quota.windows[0].resetsAt, '2026-09-03T07:28:21Z')
  assert.equal(quota.resetCredits, null)
})

test('account monitor includes all three OAuth provider groups and excludes unrelated credential types', () => {
  assert.equal(isMonitoredAccountType('antigravity'), true)
  assert.equal(isMonitoredAccountType('claude'), true)
  assert.equal(isMonitoredAccountType('codex'), true)
  assert.equal(isMonitoredAccountType('xai'), false)
})

test('claude cedar_ember grants surface as resetCredits in the codex shape', () => {
  const quota = normalizeAccountQuota('claude', {
    usage: {
      limits: [{ kind: 'weekly_all', percent: 100, severity: 'critical', resets_at: '2026-09-24T16:00:00Z', scope: null }],
      cedar_ember: {
        eligible: true,
        grants: [{ id: 'opus55-launch-promax-20260921', resets_left: 1, paused: false, starts_at: '2026-09-22T16:00:00Z', ends_at: '2026-10-22T16:00:00Z' }],
        next_grant_id: 'opus55-launch-promax-20260921',
      },
    },
    profile: { account: { has_claude_max: true }, organization: { rate_limit_tier: 'default_claude_max_20x' } },
  })
  assert.equal(quota.resetCredits?.available, 1)
  assert.equal(quota.resetCredits?.entries[0]?.expiresAt, '2026-10-22T16:00:00Z')
  assert.equal(quota.windows[0]?.label, '7 天额度')
})

test('claude exposes no reset credits when the grant is missing, paused or spent', () => {
  const none = normalizeAccountQuota('claude', { usage: { limits: [], cedar_ember: { eligible: false, ineligible_reason: 'surface', grants: [] } } })
  assert.equal(none.resetCredits, null)
  const paused = normalizeAccountQuota('claude', { usage: { limits: [], cedar_ember: { eligible: true, grants: [{ id: 'g1', resets_left: 1, paused: true }] } } })
  assert.equal(paused.resetCredits, null)
  const spent = normalizeAccountQuota('claude', { usage: { limits: [], cedar_ember: { eligible: true, grants: [{ id: 'g1', resets_left: 0, paused: false }] } } })
  assert.equal(spent.resetCredits, null)
})

/* ────────────────────────── 每账号额度缓存（Codex / AntiGravity） ────────────────────────── */

const { AccountQuotaCache, AccountQuotaUpstreamError } = await import('./accountQuota.js')

function quotaCache(clock: { now: number }, fetches: { count: number }) {
  return new AccountQuotaCache<{ v: number }>({
    ttlMs: 3 * 60_000, rateLimitCooldownMs: 10 * 60_000, maxCooldownMs: 60 * 60_000, failureCooldownMs: 30_000,
    jitterPct: 0, now: () => clock.now, onFetch: () => { fetches.count += 1 },
  })
}

test('额度缓存：TTL 内不重复打上游，过期后才刷新', async () => {
  const clock = { now: 1_000 }
  const fetches = { count: 0 }
  const cache = quotaCache(clock, fetches)
  let value = 1
  const fetcher = async () => ({ v: value++ })
  assert.deepEqual((await cache.read('a', fetcher)).value, { v: 1 })
  clock.now += 2 * 60_000
  assert.deepEqual((await cache.read('a', fetcher)).value, { v: 1 })
  assert.equal(fetches.count, 1)
  clock.now += 2 * 60_000
  assert.deepEqual((await cache.read('a', fetcher)).value, { v: 2 })
  assert.equal(fetches.count, 2)
})

test('额度缓存：429 进入长冷却并指数递增，冷却期间返回上次成功数据 + 原因', async () => {
  const clock = { now: 1_000 }
  const fetches = { count: 0 }
  const cache = quotaCache(clock, fetches)
  await cache.read('a', async () => ({ v: 1 }))
  clock.now += 4 * 60_000
  const limited = async (): Promise<{ v: number }> => { throw new AccountQuotaUpstreamError(429, '上游返回 HTTP 429') }
  const first = await cache.read('a', limited)
  assert.deepEqual(first.value, { v: 1 })
  assert.match(first.error || '', /HTTP 429.*当前显示上次成功数据/)
  assert.equal(first.blockedUntil, clock.now + 10 * 60_000)

  clock.now += 5 * 60_000
  await cache.read('a', limited)
  assert.equal(fetches.count, 2, '冷却期间不打上游')
  assert.equal(cache.blockedCount(), 1)

  clock.now += 5 * 60_000
  const second = await cache.read('a', limited)
  assert.equal(fetches.count, 3)
  assert.equal(second.blockedUntil, clock.now + 20 * 60_000, '第二次 429 冷却翻倍')
})

test('额度缓存：一般失败短冷却；Retry-After 作为冷却下限；同账号并发只打一次', async () => {
  const clock = { now: 1_000 }
  const fetches = { count: 0 }
  const cache = quotaCache(clock, fetches)
  const failed = await cache.read('a', async () => { throw new Error('socket hang up') })
  assert.equal(failed.value, null)
  assert.equal(failed.blockedUntil, clock.now + 30_000)

  const hinted = await cache.read('b', async () => { throw new AccountQuotaUpstreamError(503, 'busy', 15 * 60_000) })
  assert.equal(hinted.blockedUntil, clock.now + 15 * 60_000)

  let release: () => void = () => undefined
  const gate = new Promise<void>((resolve) => { release = resolve })
  const pending = [cache.read('c', async () => { await gate; return { v: 9 } }), cache.read('c', async () => ({ v: 10 }))]
  release()
  const results = await Promise.all(pending)
  assert.deepEqual(results.map(result => result.value), [{ v: 9 }, { v: 9 }])
  assert.equal(fetches.count, 3)
})

test('冷却中带旧数据的额度体：Codex / AntiGravity 照常展示窗口并附原因', () => {
  const codex = normalizeAccountQuota('codex', { ...codexQuota, error: '上游返回 HTTP 429；冷却至 …' })
  assert.ok(codex.windows.length > 0)
  assert.match(codex.error || '', /429/)
  assert.equal(normalizeAccountQuota('codex', { error: '读取失败' }).windows.length, 0)

  const antigravity = normalizeAccountQuota('antigravity', {
    groups: [{ displayName: 'Gemini Models', buckets: [{ remainingFraction: 0.5 }] }], subscription: null, error: '冷却中',
  })
  assert.equal(antigravity.windows.length, 1)
  assert.equal(antigravity.error, '冷却中')
})
