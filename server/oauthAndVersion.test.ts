import test from 'node:test'
import assert from 'node:assert/strict'
import {
  getConsoleVersion,
  OAUTH_PROVIDER_ENDPOINTS,
  startOAuthLogin,
  getOAuthStatus,
  submitOAuthCallback,
  cancelOAuthSession,
} from './cpa.js'

test('getConsoleVersion reads valid console version info', () => {
  const versionInfo = getConsoleVersion()
  assert.ok(typeof versionInfo.version === 'string')
  assert.ok(versionInfo.version.length > 0)
})

test('OAUTH_PROVIDER_ENDPOINTS contains required providers', () => {
  assert.equal(OAUTH_PROVIDER_ENDPOINTS['codex'], '/codex-auth-url')
  assert.equal(OAUTH_PROVIDER_ENDPOINTS['claude'], '/anthropic-auth-url')
  assert.equal(OAUTH_PROVIDER_ENDPOINTS['antigravity'], '/antigravity-auth-url')
  assert.equal(OAUTH_PROVIDER_ENDPOINTS['kimi'], '/kimi-auth-url')
  assert.equal(OAUTH_PROVIDER_ENDPOINTS['xai'], '/xai-auth-url')
  assert.equal(OAUTH_PROVIDER_ENDPOINTS['devin'], '/devin-auth-url')
  assert.equal(OAUTH_PROVIDER_ENDPOINTS['meta'], '/meta-auth-url')
})

test('startOAuthLogin rejects unsupported providers', async () => {
  await assert.rejects(
    async () => {
      await startOAuthLogin('unsupported_xyz')
    },
    { message: /不支持的 OAuth 提供商/ }
  )
})

test('getOAuthStatus requires non-empty state', async () => {
  await assert.rejects(
    async () => {
      await getOAuthStatus('')
    },
    { message: /缺少 state 参数/ }
  )
})

test('submitOAuthCallback requires redirectUrl', async () => {
  await assert.rejects(
    async () => {
      await submitOAuthCallback('codex', '')
    },
    { message: /缺少回调 URL 或授权码/ }
  )
})

test('cancelOAuthSession handles empty state gracefully', async () => {
  const result = await cancelOAuthSession('')
  assert.deepEqual(result, { ok: true })
})
