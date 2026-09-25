import assert from 'node:assert/strict'
import test from 'node:test'
import { ClaudeQuotaCache } from './claudeQuotaCache.js'

const ok = (body: unknown) => Promise.resolve({ status_code: 200, body: JSON.stringify(body) })
const tooMany = () => Promise.resolve({ status_code: 429, body: JSON.stringify({ error: { type: 'rate_limit_error' } }) })

function makeCache(now: { value: number }, overrides: Partial<ConstructorParameters<typeof ClaudeQuotaCache>[0]> = {}) {
  return new ClaudeQuotaCache({
    usageTtlMs: 5 * 60_000,
    profileTtlMs: 60 * 60_000,
    rateLimitCooldownMs: 10 * 60_000,
    maxRateLimitCooldownMs: 60 * 60_000,
    now: () => now.value,
    ...overrides,
  })
}

test('caches successful usage and profile independently', async () => {
  const now = { value: 1_000 }
  const cache = makeCache(now)
  let usageCalls = 0
  let profileCalls = 0
  const first = await cache.read('account-1', {
    usage: async () => { usageCalls += 1; return ok({ usage: 'fresh' }) },
    profile: async () => { profileCalls += 1; return ok({ profile: 'fresh' }) },
  })
  now.value += 30_000
  const second = await cache.read('account-1', {
    usage: async () => { usageCalls += 1; return ok({ usage: 'changed' }) },
    profile: async () => { profileCalls += 1; return ok({ profile: 'changed' }) },
  })

  assert.deepEqual(first, { usage: { usage: 'fresh' }, profile: { profile: 'fresh' }, usageError: null, profileError: null, usageBlockedUntil: null, profileBlockedUntil: null })
  assert.deepEqual(second, first)
  assert.equal(usageCalls, 1)
  assert.equal(profileCalls, 1)
})

test('backs off a 429 and does not retry on every monitor refresh', async () => {
  const now = { value: 1_000 }
  const cache = makeCache(now)
  let usageCalls = 0
  const fetchers = {
    usage: async () => { usageCalls += 1; return tooMany() },
    profile: async () => ok({ account: { has_claude_max: true } }),
  }

  const first = await cache.read('account-2', fetchers)
  const second = await cache.read('account-2', fetchers)
  assert.equal(usageCalls, 1)
  assert.match(first.usageError || '', /HTTP 429/)
  assert.match(second.usageError || '', /暂时限流/)
  assert.equal(second.usage, null)

  now.value += 10 * 60_000
  await cache.read('account-2', fetchers)
  assert.equal(usageCalls, 2)
})

test('keeps the last successful quota while usage is rate limited', async () => {
  const now = { value: 1_000 }
  const cache = makeCache(now)
  let limited = false
  const fetchers = {
    usage: async () => limited ? tooMany() : ok({ limits: [{ kind: 'session', percent: 22 }] }),
    profile: async () => ok({ account: { has_claude_max: true } }),
  }

  const first = await cache.read('account-3', fetchers)
  now.value += 5 * 60_000 + 1
  limited = true
  const second = await cache.read('account-3', fetchers)

  assert.deepEqual(second.usage, first.usage)
  assert.match(second.usageError || '', /当前显示上次成功数据/)
})

test('honors a near CPA next_retry_after hint and labels it as an account-level cooldown', async () => {
  const now = { value: Date.parse('2026-08-24T04:00:00Z') }
  const cache = makeCache(now)
  let usageCalls = 0
  const retryAt = '2026-08-24T04:10:00Z'
  const result = await cache.read('account-4', {
    usage: async () => { usageCalls += 1; return ok({ should: 'not happen' }) },
    profile: async () => ok({ account: { has_claude_max: true } }),
  }, { usageNextRetryAfter: retryAt })

  assert.equal(usageCalls, 0)
  assert.equal(result.usageBlockedUntil, Date.parse(retryAt))
  assert.match(result.usageError || '', /CPA 侧冷却/)
  assert.doesNotMatch(result.usageError || '', /接口暂时限流/)
})

test('ignores a CPA hint that reaches beyond the cooldown cap instead of freezing the panel', async () => {
  const now = { value: Date.parse('2026-08-24T04:00:00Z') }
  const cache = makeCache(now)
  let usageCalls = 0
  const fetchers = {
    usage: async () => { usageCalls += 1; return ok({ limits: [{ kind: 'session', percent: 5 }] }) },
    profile: async () => ok({ account: { has_claude_max: true } }),
  }
  // 周额度重置量级的 hint（8 小时后）：额度接口本身没限流，不该把面板冻住
  const result = await cache.read('account-8', fetchers, { usageNextRetryAfter: '2026-08-24T12:00:00Z' })

  assert.equal(usageCalls, 1)
  assert.deepEqual(result.usage, { limits: [{ kind: 'session', percent: 5 }] })
  assert.equal(result.usageError, null)
  assert.equal(result.usageBlockedUntil, null)
})

test('does not extend a stale CPA unavailable hint on every refresh', async () => {
  const now = { value: 1_000 }
  const cache = makeCache(now)
  let usageCalls = 0
  const fetchers = {
    usage: async () => { usageCalls += 1; return ok({ limits: [] }) },
    profile: async () => ok({ account: { has_claude_max: true } }),
  }

  await cache.read('account-6', fetchers, { usageUnavailable: true })
  now.value += 10 * 60_000
  await cache.read('account-6', fetchers, { usageUnavailable: true })
  assert.equal(usageCalls, 1)
})

test('deduplicates concurrent reads for the same endpoint', async () => {
  const cache = makeCache({ value: 1_000 })
  let calls = 0
  let release!: (value: ReturnType<typeof ok> extends Promise<infer T> ? T : never) => void
  const pending = new Promise<ReturnType<typeof ok> extends Promise<infer T> ? T : never>((resolve) => { release = resolve })
  const usage = async () => { calls += 1; return pending }
  const fetchers = { usage, profile: async () => ok({ account: { has_claude_max: true } }) }

  const first = cache.read('account-5', fetchers)
  const second = cache.read('account-5', fetchers)
  release({ status_code: 200, body: JSON.stringify({ limits: [] }) })
  await Promise.all([first, second])
  assert.equal(calls, 1)
})
