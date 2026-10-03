import './testDataDir.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import { maskIdentity, maskProxyUserinfo, projectMonitorAccount } from './accountProjection.js'
import { secretFindings } from './testing/fakeKernel.js'

const SECRETS = ['fixture-access-0001', 'fixture-refresh-0002', 'fixture-id-0003', 'fixture-cookie-0004', 'fixture-key-0005', 'proxy-pass-0006']

/** A CPA /auth-files record as the remote gateway can return it, plus every credential shape a local file can hold. */
const gatewayRecord = {
  name: 'codex-alpha.json', type: 'codex', provider: 'codex', email: 'alpha.one@example.test', label: 'alpha', status: 'active',
  status_message: '', disabled: false, unavailable: false, next_retry_after: null, updated_at: '2026-10-01T08:00:00Z',
  auth_index: 'a1b2', priority: 3, plan: 'plus',
  proxy_url: 'http://user:proxy-pass-0006@proxy.example:7890',
  recent_requests: [{ time: '2026-10-01T08:00:00Z', success: 3, failed: 1, secret: 'fixture-key-0005' }],
  access_token: 'fixture-access-0001', refresh_token: 'fixture-refresh-0002', id_token: 'fixture-id-0003',
  cookie: 'fixture-cookie-0004', 'api-key': 'fixture-key-0005', account_id: 'acct-1',
  metadata: { access_token: 'fixture-access-0001' },
  quota: { usage: { token: 'fixture-access-0001' }, error: 'CPA 401: {"authorization":"Bearer fixture-access-0001"}' },
  normalizedQuota: { plan: 'plus', tier: '', resetCredits: null, windows: [{ id: 'w', label: '5h', usedPercent: 12, resetsAt: null, windowSeconds: 18000, severity: 'normal', scope: null, token: 'fixture-access-0001' }], error: 'api_key=fixture-key-0005' },
}

test('monitor projection: only allow-listed fields; tokens, cookies, keys and proxy passwords never pass', () => {
  const projected = projectMonitorAccount(gatewayRecord)
  assert.deepEqual(secretFindings(projected, SECRETS), [])
  // what the accounts and overview pages read is still there
  assert.deepEqual(
    [projected.name, projected.type, projected.email, projected.auth_index, projected.priority, projected.status, projected.disabled, projected.unavailable],
    ['codex-alpha.json', 'codex', 'alpha.one@example.test', 'a1b2', 3, 'active', false, false])
  assert.equal(projected.proxy_url, 'http://***@proxy.example:7890')
  assert.deepEqual(projected.recent_requests, [{ time: '2026-10-01T08:00:00Z', success: 3, failed: 1 }])
  assert.equal((projected.normalizedQuota as { windows: unknown[] }).windows.length, 1)
  assert.ok(String((projected.quota as { error: string }).error).startsWith('CPA 401'), 'the error stays readable, minus the credential')
})

test('monitor projection keeps the quota fields the external pollers read (status line, Pi footer), and nothing secret', () => {
  const claude = projectMonitorAccount({
    name: 'claude-a.json', type: 'claude', email: 'a@example.test', disabled: false, status: 'active',
    quota: {
      usage: {
        five_hour: { utilization: 23, resets_at: '2026-10-03T08:00:00Z' },
        seven_day: { utilization: 61.5, resets_at: '2026-10-07T00:00:00Z' },
        seven_day_sonnet: { utilization: 4, resets_at: null },
        seven_day_opus: null,
        limits: [{ kind: 'five_hour', percent: 23, token: 'fixture-access-0001' }],
      },
      profile: {
        account: { has_claude_max: true, has_claude_pro: false, email_address: 'a@example.test', uuid: 'fixture-id-0003' },
        organization: { organization_type: 'claude_max', rate_limit_tier: 'default_claude_max_20x', uuid: 'fixture-key-0005' },
      },
    },
  })
  assert.deepEqual(claude.quota, {
    usage: {
      five_hour: { utilization: 23, resets_at: '2026-10-03T08:00:00Z' },
      seven_day: { utilization: 61.5, resets_at: '2026-10-07T00:00:00Z' },
      seven_day_sonnet: { utilization: 4, resets_at: null },
    },
    profile: { account: { has_claude_max: true, has_claude_pro: false }, organization: { organization_type: 'claude_max', rate_limit_tier: 'default_claude_max_20x' } },
  })

  const codex = projectMonitorAccount({
    ...gatewayRecord,
    quota: {
      plan_type: 'plus',
      rate_limit: {
        allowed: true, limit_reached: false,
        primary_window: { used_percent: 12, limit_window_seconds: 18000, reset_after_seconds: 3600, reset_at: 1790990000 },
        secondary_window: { used_percent: 40, limit_window_seconds: 604800, reset_after_seconds: 86400, reset_at: 1791500000 },
      },
      credits: { token: 'fixture-access-0001' },
    },
  })
  assert.deepEqual(codex.quota, {
    plan_type: 'plus',
    rate_limit: {
      allowed: true, limit_reached: false,
      primary_window: { used_percent: 12, limit_window_seconds: 18000, reset_after_seconds: 3600, reset_at: 1790990000 },
      secondary_window: { used_percent: 40, limit_window_seconds: 604800, reset_after_seconds: 86400, reset_at: 1791500000 },
    },
  })
  assert.deepEqual(secretFindings([claude, codex], SECRETS), [])
  // no id_token in any form (the Pi footer falls back to quota.plan_type, which passes)
  assert.equal(codex.id_token, undefined)
})

test('proxy and identity masks', () => {
  assert.equal(maskProxyUserinfo('socks5://u:p@10.0.0.1:1080'), 'socks5://***@10.0.0.1:1080')
  assert.equal(maskProxyUserinfo('http://127.0.0.1:7890'), 'http://127.0.0.1:7890')
  assert.equal(maskProxyUserinfo('direct'), 'direct')
  assert.equal(maskProxyUserinfo(undefined), '')
  assert.equal(maskIdentity('zhang.wei.ops@company.example'), 'zh••••••s@•••')
  assert.equal(maskIdentity('ab@x.test'), 'a••@•••')
})

test('local credential store: the listing (and /auth-files) is allow-listed; the runtime reads the credential server-side', async () => {
  const { listLocalAuthFiles, saveLocalAuthFile, deleteLocalAuthFile, readLocalAuthFileCredential, magpieManagementRequest } = await import('./magpieControl.js')
  const name = `p0-${process.pid}.json`
  saveLocalAuthFile(name, JSON.stringify({ ...gatewayRecord, name: undefined }))
  try {
    const listed = listLocalAuthFiles().find(file => file.name === name)
    assert.ok(listed)
    assert.deepEqual(secretFindings(listed, SECRETS.filter(secret => secret !== 'proxy-pass-0006')), [])
    assert.equal(listed.email, 'alpha.one@example.test')
    const viaManagement = await magpieManagementRequest<{ files: Array<Record<string, unknown>> }>('/auth-files')
    assert.deepEqual(secretFindings(viaManagement.files.find(file => file.name === name), SECRETS.filter(secret => secret !== 'proxy-pass-0006')), [])
    assert.deepEqual(readLocalAuthFileCredential(name), { token: 'fixture-access-0001', accountId: 'acct-1' })
  } finally {
    deleteLocalAuthFile(name)
  }
})

test('local OAuth simulator is retired: start and callback are 410, status 404, nothing is written', async () => {
  const { listLocalAuthFiles, magpieManagementRequest } = await import('./magpieControl.js')
  const before = listLocalAuthFiles().length
  await assert.rejects(magpieManagementRequest('/codex-auth-url?is_webui=true'), (error: { status?: number; code?: string }) => error.status === 410 && error.code === 'use_accounts_signin')
  await assert.rejects(magpieManagementRequest('/oauth-callback', { method: 'POST', body: JSON.stringify({ provider: 'codex', redirect_url: 'http://localhost:1455/auth/callback?code=x', state: 's' }) }),
    (error: { status?: number }) => error.status === 410)
  await assert.rejects(magpieManagementRequest('/get-auth-status?state=s'), (error: { status?: number }) => error.status === 404)
  assert.deepEqual(await magpieManagementRequest('/oauth-session?state=s', { method: 'DELETE' }), { ok: true })
  assert.equal(listLocalAuthFiles().length, before, 'no fabricated credential file')
})
