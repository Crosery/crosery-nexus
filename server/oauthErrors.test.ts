import assert from 'node:assert/strict'
import test from 'node:test'
import { explainOAuthError, OAUTH_CODE_TEXT, OAUTH_REGION_TEXT } from './oauthErrors.js'

/** CPA's OAuth session errors, reworded once on the server (oauthErrors.ts) for the add-account sheet. */

const CODEX_400 = 'Failed to exchange authorization code for tokens: token exchange failed with status 400: {"error":{"message":"Invalid authorization code.","type":"invalid_request_error","param":null,"code":"invalid_grant"}}'

/** what preview CPA answered for a made-up Codex code, bare and as a full callback URL (2026-10-09) */
const CODEX_FAKE_CODE = 'Failed to exchange authorization code for tokens: token exchange failed with status 400: {\n  "error": {\n    "message": "Invalid request. Please try again later.",\n    "type": "invalid_request_error",\n    "param": null,\n    "code": "token_exchange_user_error"\n  }\n}'

test('a refused code exchange: 授权码无效、已用过或已过期, CPA text kept as detail', () => {
  assert.deepEqual(explainOAuthError(CODEX_400), { error: OAUTH_CODE_TEXT, detail: CODEX_400 })
  assert.deepEqual(explainOAuthError(CODEX_FAKE_CODE), { error: OAUTH_CODE_TEXT, detail: CODEX_FAKE_CODE })
  for (const raw of [
    'Failed to exchange authorization code for tokens',
    'Failed to exchange token',
    'Failed to exchange authorization code for tokens: token exchange failed with status 401: {"error":"invalid_grant"}',
    'token exchange failed with status 400: {"error":"invalid_request"}',
  ]) assert.deepEqual(explainOAuthError(raw), { error: OAUTH_CODE_TEXT, detail: raw }, raw)
})

test('a region refusal: the upstream turned the sign-in away by location', () => {
  for (const raw of [
    'Failed to exchange authorization code for tokens: token exchange failed with status 403: {"error":{"code":"unsupported_country_region_territory","message":"Country, region, or territory not supported"}}',
    'Country, region, or territory not supported',
    'token exchange failed with status 403: <html><title>auth.openai.com | 403 Forbidden</title></html>',
  ]) assert.deepEqual(explainOAuthError(raw), { error: OAUTH_REGION_TEXT, detail: raw }, raw)
})

test('anything else stays as CPA wrote it: network failures, 5xx, timeouts, state errors', () => {
  for (const raw of [
    'Failed to exchange authorization code for tokens: Post "https://auth.example.test/oauth/token": dial tcp: i/o timeout',
    'Failed to exchange authorization code for tokens: token exchange failed with status 502: bad gateway',
    'Failed to exchange token: proxyconnect tcp: connection refused',
    'token exchange failed with status 403: {"error":"forbidden"}',
    'Timeout waiting for OAuth callback',
    'State code error',
    'Authentication failed: state mismatch',
  ]) assert.deepEqual(explainOAuthError(raw), { error: raw }, raw)
  assert.deepEqual(explainOAuthError('  '), { error: '' })
  assert.deepEqual(explainOAuthError(undefined), { error: '' })
})

const originalFetch = globalThis.fetch

test('GET get-auth-status: the error is reworded in getOAuthStatus; ok / wait pass through untouched', async () => {
  process.env.CPA_BASE_URL = 'https://cpa.example.test'
  process.env.CPA_MANAGEMENT_KEY = 'management-key'
  const answers: Record<string, unknown> = {
    's-err': { status: 'error', error: CODEX_400 },
    's-other': { status: 'error', error: 'State code error' },
    's-wait': { status: 'wait' },
    's-ok': { status: 'ok' },
  }
  globalThis.fetch = async (input) => {
    const state = new URL(String(input)).searchParams.get('state') ?? ''
    return new Response(JSON.stringify(answers[state]), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  try {
    const { getOAuthStatus } = await import(`./cpa.ts?test=${Date.now()}`)
    assert.deepEqual(await getOAuthStatus('s-err'), { status: 'error', error: OAUTH_CODE_TEXT, detail: CODEX_400 })
    assert.deepEqual(await getOAuthStatus('s-other'), { status: 'error', error: 'State code error' })
    assert.deepEqual(await getOAuthStatus('s-wait'), { status: 'wait' })
    assert.deepEqual(await getOAuthStatus('s-ok'), { status: 'ok' })
  } finally {
    globalThis.fetch = originalFetch
  }
})
