import assert from 'node:assert/strict'
import test from 'node:test'
import { cancelLocalOAuthSession, getLocalOAuthStatus, startLocalOAuth, submitLocalOAuthCallback } from './magpieOAuth.js'
import { listLocalAuthFiles, deleteLocalAuthFile } from './magpieControl.js'

test('startLocalOAuth generates valid authorization url and session state', () => {
  const result = startLocalOAuth('claude')
  assert.equal(result.status, 'wait')
  assert.equal(result.provider, 'claude')
  assert.ok(result.state)
  assert.match(result.url, /^https:\/\/claude\.com\/cai\/oauth\/authorize/)

  const codex = startLocalOAuth('codex')
  assert.equal(codex.provider, 'codex')
  assert.match(codex.url, /^https:\/\/auth\.openai\.com\/oauth\/authorize/)

  const agy = startLocalOAuth('antigravity')
  assert.equal(agy.provider, 'antigravity')
  assert.match(agy.url, /^https:\/\/accounts\.google\.com/)
})

test('getLocalOAuthStatus checks session state and handles expiration', () => {
  const session = startLocalOAuth('xai')
  const status = getLocalOAuthStatus(session.state)
  assert.equal(status.status, 'wait')

  const nonExistent = getLocalOAuthStatus('non-existent-state-123')
  assert.equal(nonExistent.status, 'error')
})

test('submitLocalOAuthCallback processes code and creates local auth-file', async () => {
  const session = startLocalOAuth('codex')
  const callbackUrl = `http://localhost:1455/auth/callback?code=test-code-xyz&state=${session.state}`

  const result = await submitLocalOAuthCallback('codex', callbackUrl, session.state)
  assert.equal(result.ok, true)

  const status = getLocalOAuthStatus(session.state)
  assert.equal(status.status, 'ok')

  const files = listLocalAuthFiles()
  const created = files.find(f => f.type === 'codex' && String(f.name).includes('codex-'))
  assert.ok(created)

  if (created?.name) {
    deleteLocalAuthFile(String(created.name))
  }
})

test('cancelLocalOAuthSession marks session as error', () => {
  const session = startLocalOAuth('claude')
  const res = cancelLocalOAuthSession(session.state)
  assert.equal(res.ok, true)

  const status = getLocalOAuthStatus(session.state)
  assert.equal(status.status, 'error')
})
