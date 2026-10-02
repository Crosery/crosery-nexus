import './testDataDir.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import { AccountsError } from './accountsError.js'
import { kernelCaller } from './magpieKernel.js'
import { MagpieAccounts, QUOTA_POLICY, type QuotaLimiter, type QuotaRegistry } from './magpieAccounts.js'
import type { SyncOutcome } from './syncRegistry.js'
import { FakeKernel, idOf, secretFindings } from './testing/fakeKernel.js'

const USER_A = 'alpha.one@example.test'
const USER_B = 'beta.two@example.test'

async function harness() {
  const kernel = await new FakeKernel().start()
  let now = Date.parse('2026-10-02T10:00:00Z')
  const audits: Array<[string, string, string]> = []
  const counted: Array<[string, number]> = []
  const observed: SyncOutcome[] = []
  let limiterRuns = 0
  const limiter: QuotaLimiter = { run: async task => { limiterRuns += 1; return task() } }
  const registry: QuotaRegistry = {
    async observe(_id, task, summarize) { const value = await task(); observed.push(summarize(value)); return value },
    countRequests: (id, n = 1) => { counted.push([id, n]) },
  }
  const accounts = new MagpieAccounts({
    call: kernelCaller(() => kernel.socket), now: () => now, limiter, registry,
    audit: (action, target, details) => audits.push([action, target, details]),
  })
  return {
    kernel, accounts, audits, counted, observed,
    limiterRuns: () => limiterRuns,
    advance: (ms: number) => { now += ms },
    close: () => kernel.stop(),
  }
}

const refused = (code: string, status?: number) => (error: unknown) => {
  assert.ok(error instanceof AccountsError, `expected AccountsError, got ${String(error)}`)
  assert.equal(error.code, code)
  if (status !== undefined) assert.equal(error.status, status)
  return true
}

test('listing: known fields only — a credential field from the kernel and Magpie\'s path-bearing text never pass', async () => {
  const h = await harness()
  try {
    h.kernel.logins = [{ agent: 'codex', user: USER_A, plan: 'Plus', active: true }, { agent: 'codex', user: USER_B, on: false, lapsed: 'Signed out' }]
    const listing = await h.accounts.list()
    const codex = listing.agents.find(agent => agent.agent === 'codex')!
    assert.deepEqual(codex.accounts.map(account => [account.user, account.active, account.on, account.needsRelogin]), [[USER_A, true, true, false], [USER_B, false, false, true]])
    assert.equal(codex.accounts[0].id, idOf('codex', USER_A))
    assert.deepEqual(secretFindings(listing, ['fixture-access-token-should-never-leave']), [])
    assert.ok(!JSON.stringify(listing).includes('/Users/someone'), 'Magpie\'s exclusion text (with a home path) is not forwarded')
    assert.deepEqual(listing.excluded, [
      { agent: 'claude', removed: true, signedOut: false, quiet: false },
      { agent: 'codex', removed: false, signedOut: true, quiet: false },
    ])
  } finally { await h.close() }
})

test('actions map to the kernel; turning off the active account is refused before the kernel; no-ops skip the write', async () => {
  const h = await harness()
  try {
    h.kernel.logins = [{ agent: 'codex', user: USER_A, active: true }, { agent: 'codex', user: USER_B, on: false }]
    const a = idOf('codex', USER_A)
    const b = idOf('codex', USER_B)
    await assert.rejects(h.accounts.action('off', 'codex', a), refused('account_active', 409))
    assert.equal(h.kernel.count('POST', '/internal/accounts/off'), 0)
    const on = await h.accounts.action('on', 'codex', b)
    assert.equal(on.accounts.find(account => account.id === b)?.on, true)
    assert.deepEqual(h.kernel.calls.find(call => call.path === '/internal/accounts/on')?.body, { agent: 'codex', user: USER_B })
    await h.accounts.action('first', 'codex', b)
    assert.equal(h.kernel.count('POST', '/internal/accounts/switch'), 1)
    await h.accounts.action('first', 'codex', b)
    assert.equal(h.kernel.count('POST', '/internal/accounts/switch'), 1, 'already first: no kernel write')
    // the kernel refuses forgetting the active Codex account → 409
    await assert.rejects(h.accounts.action('forget', 'codex', b), refused('account_active', 409))
    await h.accounts.action('forget', 'codex', a)
    assert.equal((await h.accounts.list(true)).agents.find(agent => agent.agent === 'codex')?.accounts.length, 1)
    await assert.rejects(h.accounts.action('on', 'codex', a), refused('account_not_found', 404))
    await assert.rejects(h.accounts.action('on', 'codex', 'not-an-id'), refused('invalid_request', 400))
    await assert.rejects(h.accounts.action('on', '../x', a), refused('invalid_request', 400))
    for (const [action, target] of h.audits.map(([name, who]) => [name, who])) {
      assert.match(action, /^account-(on|off|first|forget)$/)
      assert.ok(!target.includes('@example.test'), 'audit targets are masked')
    }
  } finally { await h.close() }
})

test('allowances: one read per agent per 5 min, inside the limiter, counted per account, never on page load twice', async () => {
  const h = await harness()
  try {
    h.kernel.logins = [{ agent: 'codex', user: USER_A, active: true }, { agent: 'codex', user: USER_B, on: true }, { agent: 'devin', user: USER_A, active: true }]
    h.kernel.usage.codex = { [USER_A]: { provider: 'codex', windows: [{ name: '5 hours', used: 62.5, resetsAt: '2026-10-02T12:00:00Z' }], resets: { count: 2 } } }
    const groups = (await h.accounts.list()).agents.filter(agent => agent.accounts.length)
    await h.accounts.quota.refresh(groups)
    await h.accounts.quota.refresh(groups)
    assert.equal(h.kernel.count('GET', '/internal/accounts/usage'), 1, 'devin is skipped, codex read once')
    assert.deepEqual(h.counted, [['account-quota', 2]], 'Magpie asks the vendor once per account')
    assert.equal(h.limiterRuns(), 1)
    assert.equal(h.observed.length, 1)
    const view = h.accounts.quota.view('codex', USER_A)!
    assert.deepEqual(view.windows.map(window => [window.label, window.usedPercent, window.severity]), [['5 hours', 62.5, 'normal']])
    assert.deepEqual(view.resets, { count: 2, until: null })
    assert.equal(h.accounts.quota.view('codex', USER_B)?.windows.length, 0, 'an account the vendor did not report has no windows')
    h.advance(QUOTA_POLICY.minTtlMs - 1)
    await h.accounts.quota.refresh(groups)
    assert.equal(h.kernel.count('GET', '/internal/accounts/usage'), 1, 'still inside the 5 min floor')
    h.advance(1)
    await h.accounts.quota.refresh(groups)
    assert.equal(h.kernel.count('GET', '/internal/accounts/usage'), 2)
  } finally { await h.close() }
})

test('allowances: a failed read cools down (2 min, doubling); a rate-limited read cools 10 min; values are kept', async () => {
  const h = await harness()
  try {
    h.kernel.logins = [{ agent: 'codex', user: USER_A, active: true }]
    h.kernel.usage.codex = { [USER_A]: { windows: [{ name: '7 days', used: 10 }] } }
    const groups = (await h.accounts.list()).agents.filter(agent => agent.accounts.length)
    await h.accounts.quota.refresh(groups)
    h.kernel.usageStatus = 504
    h.advance(QUOTA_POLICY.minTtlMs)
    await h.accounts.quota.refresh(groups)
    assert.equal(h.kernel.count('GET', '/internal/accounts/usage'), 2)
    const stale = h.accounts.quota.view('codex', USER_A)!
    assert.equal(stale.stale, true)
    assert.equal(stale.windows[0].usedPercent, 10, 'the last good numbers stay')
    // the next due slot falls inside the failure cooldown: no read
    h.kernel.usageStatus = 200
    h.advance(QUOTA_POLICY.minTtlMs)
    await h.accounts.quota.refresh(groups)
    assert.equal(h.kernel.count('GET', '/internal/accounts/usage'), 3, 'cooldown (2 min) is shorter than the 5 min floor, so the read proceeds')
    h.kernel.usage.codex = { [USER_A]: { error: 'HTTP 429 Too Many Requests', windows: [] } }
    h.advance(QUOTA_POLICY.minTtlMs)
    await h.accounts.quota.refresh(groups)
    assert.equal(h.kernel.count('GET', '/internal/accounts/usage'), 4)
    const runs = h.observed.length
    h.advance(QUOTA_POLICY.minTtlMs)
    await h.accounts.quota.refresh(groups)
    assert.equal(h.kernel.count('GET', '/internal/accounts/usage'), 4, 'rate-limited: 10 min cooldown holds the next slot')
    assert.equal(h.observed.length, runs, 'a cooling agent is not due: no sync-center run either')
    assert.deepEqual(h.accounts.quota.due(groups), [])
    // the 429 read ran at 10:15: its 10 min cooldown (10:25), not the 5 min slot (10:20), is the next chance
    assert.equal(h.accounts.quota.nextAllowedAt('codex'), Date.parse('2026-10-02T10:25:00Z'))
    h.advance(QUOTA_POLICY.rateLimitCooldownMs)
    await h.accounts.quota.refresh(groups)
    assert.equal(h.kernel.count('GET', '/internal/accounts/usage'), 5)
  } finally { await h.close() }
})

test('allowances: an agent whose accounts are all off is read at most hourly; expired sign-ins say so in zh', async () => {
  const h = await harness()
  try {
    h.kernel.logins = [{ agent: 'gemini', user: USER_A, on: false }]
    h.kernel.usage.gemini = { [USER_A]: { error: 'the sign-in has expired; sign in again', windows: [] } }
    const groups = (await h.accounts.list()).agents.filter(agent => agent.accounts.length)
    await h.accounts.quota.refresh(groups)
    assert.equal(h.accounts.quota.view('gemini', USER_A)?.error, '登录已失效，请重新添加')
    assert.equal(h.accounts.quota.view('gemini', USER_A)?.errorCode, 'signed_out')
    h.advance(QUOTA_POLICY.minTtlMs * 2)
    await h.accounts.quota.refresh(groups)
    assert.equal(h.kernel.count('GET', '/internal/accounts/usage'), 1)
    h.advance(QUOTA_POLICY.allOffIntervalMs)
    await h.accounts.quota.refresh(groups)
    assert.equal(h.kernel.count('GET', '/internal/accounts/usage'), 2)
  } finally { await h.close() }
})

test('codex reset: outcomes, no gateway cooldown claim, reset pending until the next read, audit masked', async () => {
  const h = await harness()
  try {
    h.kernel.logins = [{ agent: 'codex', user: USER_A, active: true }, { agent: 'claude', user: USER_B, active: true }]
    h.kernel.usage.codex = { [USER_A]: { windows: [{ name: '5 hours', used: 100 }], resets: { count: 1 } } }
    const groups = (await h.accounts.list()).agents.filter(agent => agent.agent === 'codex')
    await h.accounts.quota.refresh(groups)
    h.counted.length = 0
    const reset = await h.accounts.codexReset(idOf('codex', USER_A))
    assert.deepEqual(reset, { ok: true, outcome: 'reset', windows: 1, message: '已重新开始 1 个窗口', cooldownCleared: null })
    assert.deepEqual(h.kernel.calls.find(call => call.path === '/internal/accounts/codex-reset')?.body, { user: USER_A })
    assert.deepEqual(h.counted, [['account-quota', 1]])
    assert.equal(h.accounts.quota.view('codex', USER_A)?.resetPending, true, 'shown until the next allowed read')
    assert.equal(h.kernel.count('GET', '/internal/accounts/usage'), 1, 'a reset does not buy an extra usage read')
    h.kernel.usage.codex = { [USER_A]: { windows: [{ name: '5 hours', used: 0 }], resets: { count: 0 } } }
    h.advance(QUOTA_POLICY.minTtlMs)
    await h.accounts.quota.refresh(groups)
    assert.equal(h.accounts.quota.view('codex', USER_A)?.resetPending, false)
    h.counted.length = 0
    h.kernel.resetCode = 'no_credit'
    const none = await h.accounts.codexReset(idOf('codex', USER_A))
    assert.equal(none.ok, false)
    assert.equal(none.message, '这个账号没有可用的重置')
    await assert.rejects(h.accounts.codexReset(idOf('claude', USER_B)), refused('account_not_found', 404))
    assert.ok(h.audits.every(([, target]) => !target.includes('@example.test')))
    assert.deepEqual(h.audits.map(([action, , details]) => [action, details]), [['account-codex-reset', 'outcome=reset'], ['account-codex-reset', 'outcome=no_credit']])
  } finally { await h.close() }
})
