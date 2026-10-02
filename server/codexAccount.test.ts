import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeResetCredits, parseIdTokenPayload, resolveChatgptAccountId } from './codexAccount.js'

const makeIdToken = (payload: Record<string, unknown>) =>
  `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`

test('chatgpt account id is read from the id_token payload', () => {
  const token = makeIdToken({ chatgpt_account_id: 'acct-123' })
  assert.equal(resolveChatgptAccountId({ id_token: token }), 'acct-123')
  assert.equal(resolveChatgptAccountId({ metadata: { id_token: token } }), 'acct-123')
  assert.equal(resolveChatgptAccountId({ attributes: { id_token: token } }), 'acct-123')
})

test('missing or malformed id_token yields no account id rather than throwing', () => {
  assert.equal(resolveChatgptAccountId({}), null)
  assert.equal(resolveChatgptAccountId({ id_token: 'not-a-jwt' }), null)
  assert.equal(parseIdTokenPayload('a.!!!.c'), null)
})

test('only available codex_rate_limits credits count as resettable', () => {
  const result = normalizeResetCredits({
    available_count: 2,
    credits: [
      { id: 'a', reset_type: 'codex_rate_limits', status: 'available', expires_at: '2026-08-13T01:39:19Z' },
      { id: 'b', reset_type: 'codex_rate_limits', status: 'consumed', expires_at: '2026-08-13T01:39:19Z' },
      { id: 'c', reset_type: 'other_thing', status: 'available', expires_at: '2026-08-13T01:39:19Z' },
    ],
  })
  assert.equal(result.availableCount, 2)
  assert.deepEqual(result.credits.map((credit) => credit.id), ['a'])
})

test('a JSON string body is parsed like an object body', () => {
  const result = normalizeResetCredits(JSON.stringify({ available_count: 1, credits: [] }))
  assert.equal(result.availableCount, 1)
})

test('unparseable payloads report null instead of a fake zero', () => {
  assert.deepEqual(normalizeResetCredits('nonsense'), { availableCount: null, credits: [] })
  assert.deepEqual(normalizeResetCredits(null), { availableCount: null, credits: [] })
})

test('Codex 额度与重置额度的转发结果：非 2xx 抛带状态码的错误，交给缓存冷却', async () => {
  const { parseCodexResetCredits, parseCodexUsage } = await import('./codexAccount.js')
  const { AccountQuotaUpstreamError } = await import('./accountQuota.js')
  assert.deepEqual(parseCodexUsage({ status_code: 200, body: JSON.stringify({ plan_type: 'pro' }) }), { plan_type: 'pro' })
  assert.throws(() => parseCodexUsage({ status_code: 429, body: '{}' }), (error: unknown) => error instanceof AccountQuotaUpstreamError && error.status === 429)
  assert.throws(() => parseCodexResetCredits({ status_code: 403, body: '{}' }), (error: unknown) => error instanceof AccountQuotaUpstreamError && error.status === 403)
  assert.equal(parseCodexResetCredits({ status_code: 200, body: { available_count: 2, credits: [] } }).availableCount, 2)
})
