import './testDataDir.js'

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

/* ────────────────── provider 白名单（task-61 F2/F4） ────────────────── */

test('provider 只接受注册表里的值：穿越型 provider 在入口就被拒（不再进文件名与 authUrl）', async () => {
  const fs = await import('node:fs')
  const path = await import('node:path')
  const { testDataDir } = await import('./testDataDir.js')

  for (const provider of ['../../../../tmp/cac-wp-oauth-canary', '..', 'a/b', '/abs', '', '   ', 'evil.com']) {
    assert.throws(() => startLocalOAuth(provider), /不支持的 OAuth 提供商/, `startLocalOAuth 应拒绝：${JSON.stringify(provider)}`)
    await assert.rejects(
      submitLocalOAuthCallback(provider, 'https://example.com/callback?code=abc', ''),
      /不支持的 OAuth 提供商/,
      `submitLocalOAuthCallback 应拒绝：${JSON.stringify(provider)}`,
    )
  }
  const stray = fs.readdirSync(path.join(path.dirname(path.resolve(testDataDir)), '..'))
    .filter(name => name.startsWith('cac-wp-oauth-canary'))
  assert.deepEqual(stray, [], '不得在 DATA_DIR 之外留下任何文件')

  // F4：authUrl 不再反射任意域名
  assert.throws(() => startLocalOAuth('evil.com'), /不支持的 OAuth 提供商/)

  // 合法 provider 仍然可用（本地平面：落盘在 auth-files 内）
  const ok = await submitLocalOAuthCallback('claude', 'https://example.com/callback?code=xyz', '')
  assert.deepEqual(ok, { ok: true })
  const created = listLocalAuthFiles().filter(file => String(file.name).startsWith('claude-'))
  assert.ok(created.length > 0, '合法回调必须仍然落盘')
  for (const file of created) {
    assert.doesNotMatch(String(file.name), /[\\/]/, '落盘文件名必须是单段')
    deleteLocalAuthFile(String(file.name))
  }
})
