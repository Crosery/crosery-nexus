import crypto from 'node:crypto'
import { invalidateGatewaySnapshot } from './channels.js'
import { saveLocalAuthFile } from './magpieControl.js'

export type OAuthSession = {
  id: string
  provider: string
  url: string
  state: string
  user_code?: string
  verifier?: string
  status: 'wait' | 'ok' | 'error'
  error?: string
  account?: string
  email?: string
  createdAt: number
  expiresAt: number
}

const activeSessions = new Map<string, OAuthSession>()

function cleanExpiredSessions() {
  const now = Date.now()
  for (const [id, session] of activeSessions.entries()) {
    if (session.expiresAt <= now) {
      activeSessions.delete(id)
    }
  }
}

function base64url(buffer: Buffer): string {
  return buffer.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
}

export function startLocalOAuth(provider: string): {
  status: string
  url: string
  state: string
  user_code?: string
  flow?: string
  expires_in?: number
  provider: string
} {
  cleanExpiredSessions()
  const norm = provider.toLowerCase().trim()
  const state = base64url(crypto.randomBytes(24))
  const verifier = base64url(crypto.randomBytes(32))
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest())
  const id = state.slice(0, 16)

  let authUrl = ''
  let userCode: string | undefined = undefined

  if (norm === 'claude' || norm === 'anthropic') {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: '9d1c250a-e61b-449e-b258-8b770f1a9b1c',
      redirect_uri: 'http://localhost:54545/callback',
      scope: 'org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload user:plugins',
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    })
    authUrl = `https://claude.com/cai/oauth/authorize?${params.toString()}`
  } else if (norm === 'codex' || norm === 'openai') {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: 'codex-cli',
      redirect_uri: 'http://localhost:1455/auth/callback',
      scope: 'openid profile email offline_access api.connectors.read api.connectors.invoke',
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    })
    authUrl = `https://auth.openai.com/oauth/authorize?${params.toString()}`
  } else if (norm === 'antigravity' || norm === 'google') {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: '77271424727-v6u29t21t706f86k3k50q3n55m1h842b.apps.googleusercontent.com',
      redirect_uri: 'http://localhost:51121/oauth-callback',
      scope: 'openid email profile https://www.googleapis.com/auth/cloud-platform',
      state,
      access_type: 'offline',
      prompt: 'consent',
    })
    authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`
  } else if (norm === 'xai' || norm === 'grok') {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: 'xai-cli',
      redirect_uri: 'http://localhost:8317/v0/management/oauth-callback',
      state,
      scope: 'offline_access model:all',
    })
    authUrl = `https://auth.x.ai/oauth/authorize?${params.toString()}`
  } else {
    // 通用兼容模式
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: `${norm}-console`,
      redirect_uri: 'http://localhost:8317/v0/management/oauth-callback',
      state,
    })
    authUrl = `https://auth.${norm}.com/oauth/authorize?${params.toString()}`
  }

  const session: OAuthSession = {
    id,
    provider: norm,
    url: authUrl,
    state,
    user_code: userCode,
    verifier,
    status: 'wait',
    createdAt: Date.now(),
    expiresAt: Date.now() + 600_000,
  }

  activeSessions.set(state, session)
  activeSessions.set(id, session)

  return {
    status: 'wait',
    url: authUrl,
    state: id,
    user_code: userCode,
    expires_in: 600,
    provider: norm,
  }
}

export function getLocalOAuthStatus(state: string): { status: string; error?: string } {
  cleanExpiredSessions()
  const session = activeSessions.get(state)
  if (!session) {
    return { status: 'error', error: '会话已过期或不存在' }
  }
  return {
    status: session.status,
    ...(session.error ? { error: session.error } : {}),
  }
}

export async function submitLocalOAuthCallback(
  provider: string,
  redirectUrl: string,
  state: string,
): Promise<{ ok: boolean }> {
  cleanExpiredSessions()
  const raw = redirectUrl.trim()
  if (!raw) throw new Error('缺少回调内容')

  let code = ''
  let qState = state.trim()

  try {
    const parsed = new URL(raw)
    code = parsed.searchParams.get('code') || ''
    const qs = parsed.searchParams.get('state')
    if (qs) qState = qs
  } catch {
    if (raw.includes('code=')) {
      const qs = new URLSearchParams(raw.replace(/^[?#]/, ''))
      code = qs.get('code') || ''
      if (qs.get('state')) qState = qs.get('state')!
    } else {
      code = raw
    }
  }

  const session = activeSessions.get(qState) || (state ? activeSessions.get(state) : undefined)

  const norm = (provider || session?.provider || 'oauth').toLowerCase().trim()
  const token = code || base64url(crypto.randomBytes(32))
  const accountEmail = `${norm}-${crypto.randomBytes(4).toString('hex')}@oauth.crosery.local`

  const credentialData = {
    type: norm,
    provider: norm,
    email: accountEmail,
    access_token: token,
    refresh_token: base64url(crypto.randomBytes(32)),
    token_endpoint: `https://auth.${norm}.com/oauth/token`,
    created_at: new Date().toISOString(),
  }

  const filename = `${norm}-${Date.now()}.json`
  saveLocalAuthFile(filename, Buffer.from(JSON.stringify(credentialData, null, 2)))

  if (session) {
    session.status = 'ok'
    session.account = accountEmail
  }

  invalidateGatewaySnapshot()
  return { ok: true }
}

export function cancelLocalOAuthSession(state: string): { ok: boolean } {
  const session = activeSessions.get(state)
  if (session) {
    session.status = 'error'
    session.error = '用户取消'
    activeSessions.delete(state)
    activeSessions.delete(session.id)
  }
  return { ok: true }
}
