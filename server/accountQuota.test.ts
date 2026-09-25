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
