import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeAccountQuota } from './accountQuota.js'
import {
  buildAccounts,
  classifyResetError,
  classifyResetSuccess,
  countBy,
  fmtReset,
  groupAccounts,
  matches,
  mergeAccountsPayload,
  pickWindows,
  providerForType,
  PROXY_CUSTOM,
  PROXY_UNKNOWN,
  proxyChoice,
  proxyKeepsDraft,
  proxyLabel,
  proxyNeedsWrite,
  reasonWords,
  verifyOutcome,
  windowView,
  type CredentialLike,
  type MonitorAccount,
  type ProxyRead,
} from '../src/features/accounts/model.js'
import type { EgressData, EgressRead } from '../src/types.js'

/*
 * /accounts view model (DESIGN §6.5): the merge of /api/channels credentials with /api/monitor accounts, the
 * status words, the two headline windows, the reset outcome mapping. Shapes come from the real server code:
 * normalizeAccountQuota (server/accountQuota.ts) and the CPA auth-file fields (status_message,
 * next_retry_after, recent_requests, priority).
 */

const NOW = Date.parse('2026-10-02T06:00:00Z') // 14:00 Shanghai, a Friday

const codexRaw = {
  plan_type: 'pro',
  rate_limit: {
    primary_window: { used_percent: 88, limit_window_seconds: 18000, reset_at: Math.floor((NOW + 70 * 60_000) / 1000) },
    secondary_window: { used_percent: 64, limit_window_seconds: 604800, reset_at: Math.floor((NOW + 4 * 86_400_000) / 1000) },
  },
  additional_rate_limits: [
    { limit_name: 'GPT-5.3-Codex-Spark', rate_limit: { primary_window: { used_percent: 97, limit_window_seconds: 604800, reset_at: Math.floor((NOW + 86_400_000) / 1000) } } },
  ],
}

const credential = (name: string, type: string, extra: Partial<CredentialLike> = {}): CredentialLike => ({
  name, type, disabled: false, status: 'active', label: `${name}@example.com`, modelCount: 12, proxyUrl: '', ...extra,
})

const monitorAccount = (name: string, type: string, extra: Record<string, unknown> = {}, quota: unknown = null, credits: unknown = null): MonitorAccount => ({
  name,
  type,
  auth_index: `${name}-idx`,
  email: `${name}@example.com`,
  status: 'active',
  status_message: '',
  disabled: false,
  unavailable: false,
  quota,
  normalizedQuota: normalizeAccountQuota(type, quota, credits as never),
  ...extra,
})

test('provider catalog maps credential types onto the OAuth provider groups', () => {
  assert.equal(providerForType('codex')?.id, 'codex')
  assert.equal(providerForType('anthropic')?.id, 'claude')
  assert.equal(providerForType('GROK')?.id, 'xai')
  assert.equal(providerForType('qwen'), null)
  assert.equal(providerForType('claude')?.risk, true)
  assert.equal(providerForType('antigravity')?.risk, true)
  assert.equal(providerForType('codex')?.risk, false)
})

test('codex windows: 5H and 7D in the row, the per-model window goes to the expanded view', () => {
  const windows = normalizeAccountQuota('codex', codexRaw).windows.map(windowView)
  const { a, b, extra } = pickWindows(windows)
  assert.equal(a?.short, '5H')
  assert.equal(a?.used, 0.88)
  assert.equal(b?.short, '7D')
  assert.equal(b?.used, 0.64)
  assert.deepEqual(extra.map((w) => w.label), ['GPT-5.3-Codex-Spark'])
  assert.equal(extra[0].scoped, true)
})

test('antigravity family windows get a G·/C· prefix and the tightest per class wins', () => {
  const quota = normalizeAccountQuota('antigravity', {
    subscription: { plan: 'pro' },
    groups: [
      { displayName: 'Gemini Models', buckets: [{ bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.37 }, { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.8 }] },
      { displayName: 'Claude and GPT Models', buckets: [{ bucketId: 'cg-5h', window: '5h', remainingFraction: 0.1 }, { bucketId: 'cg-weekly', window: 'weekly', remainingFraction: 0.6 }] },
    ],
  })
  const { a, b } = pickWindows(quota.windows.map(windowView))
  assert.equal(a?.short, 'C·5H')
  assert.ok(Math.abs((a?.used ?? 0) - 0.9) < 1e-9)
  assert.equal(b?.short, 'C·7D')
})

test('claude: session + weekly_all headline, scoped Fable window stays out of the row', () => {
  const quota = normalizeAccountQuota('claude', {
    usage: {
      limits: [
        { kind: 'session', percent: 17, resets_at: '2026-10-02T09:00:00Z' },
        { kind: 'weekly_all', percent: 58, resets_at: '2026-10-04T13:00:00Z' },
        { kind: 'weekly_scoped', percent: 99, resets_at: '2026-10-04T13:00:00Z', scope: { model: { display_name: 'Fable' } } },
      ],
    },
    profile: { account: { has_claude_max: true }, organization: { rate_limit_tier: 'default_claude_max_20x' } },
  })
  const { a, b, extra } = pickWindows(quota.windows.map(windowView))
  assert.equal(a?.short, '5H')
  assert.equal(b?.short, '7D')
  assert.equal(b?.used, 0.58)
  assert.equal(extra.length, 1)
  assert.equal(extra[0].short, '7D*')
})

test('merge: every credential type is listed, quota comes from the monitor, disabled comes from the credential', () => {
  const rows = buildAccounts(
    [credential('a.json', 'codex', { disabled: true }), credential('b.json', 'xai')],
    [monitorAccount('a.json', 'codex', { disabled: false }, codexRaw)],
    NOW,
  )
  assert.equal(rows.length, 2)
  const a = rows.find((r) => r.name === 'a.json')!
  assert.equal(a.disabled, true)
  assert.equal(a.state, 'pause')
  assert.equal(a.quotaState, 'ok')
  assert.equal(a.plan, 'Pro')
  const b = rows.find((r) => r.name === 'b.json')!
  assert.equal(b.provider?.id, 'xai')
  assert.equal(b.quotaState, 'none')
})

test('merge: monitor-only accounts still render when /api/channels failed', () => {
  const rows = buildAccounts(null, [monitorAccount('m.json', 'claude', {}, { error: '上游返回 HTTP 429' })], NOW)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].quotaState, 'error')
  assert.equal(rows[0].quotaError, '上游返回 HTTP 429')
  assert.equal(rows[0].email, 'm.json@example.com')
})

test('merge: a monitored account the monitor did not answer for is "missing", not zero', () => {
  const rows = buildAccounts([credential('c.json', 'codex')], null, NOW)
  assert.equal(rows[0].quotaState, 'missing')
  assert.equal(rows[0].a, null)
})

test('status: cooldown from next_retry_after, lapsed from a 401, error with a reason', () => {
  const rows = buildAccounts(null, [
    monitorAccount('cool.json', 'codex', { unavailable: true, status: 'error', status_message: 'HTTP 429 rate limit exceeded', next_retry_after: new Date(NOW + 23 * 60_000).toISOString(), updated_at: new Date(NOW - 7 * 60_000).toISOString() }),
    monitorAccount('ok.json', 'codex'),
    monitorAccount('dead.json', 'claude', { status: 'error', status_message: '401 Unauthorized: token expired' }),
    monitorAccount('err.json', 'antigravity', { status: 'error', status_message: 'upstream 503 overloaded' }),
  ], NOW)
  const by = (n: string) => rows.find((r) => r.name === n)!
  assert.equal(by('cool.json').state, 'cool')
  assert.equal(by('cool.json').coolUntil, NOW + 23 * 60_000)
  assert.equal(by('cool.json').coolTotal, 30 * 60_000)
  assert.match(by('cool.json').leader ?? '', /429 限流/)
  assert.equal(by('cool.json').attention, null, 'another codex account still routes, so the cooldown is not a to-do')
  assert.equal(by('dead.json').state, 'bad')
  assert.equal(by('dead.json').lapsed, true)
  assert.equal(by('dead.json').attention, 'bad')
  assert.match(by('dead.json').leader ?? '', /401 · 授权失效/)
  assert.equal(by('err.json').state, 'warn')
  assert.equal(by('err.json').leader, '上游不可用 · 自动重试')
})

test('status: a past next_retry_after is not a cooldown', () => {
  const rows = buildAccounts(null, [monitorAccount('x.json', 'codex', { next_retry_after: new Date(NOW - 1000).toISOString() })], NOW)
  assert.equal(rows[0].state, 'run')
})

test('escalation: a cooldown on the last routable account of a provider becomes a to-do', () => {
  const rows = buildAccounts(null, [
    monitorAccount('only.json', 'claude', { status: 'error', status_message: '429', next_retry_after: new Date(NOW + 60_000).toISOString() }),
    monitorAccount('paused.json', 'claude', { disabled: true }),
  ], NOW)
  const only = rows.find((r) => r.name === 'only.json')!
  assert.equal(only.state, 'cool')
  assert.equal(only.attention, 'warn')
  assert.match(only.leader ?? '', /Claude 已无可用账号/)
})

test('首选 only when exactly one routable account has the highest priority', () => {
  const rows = buildAccounts(null, [
    monitorAccount('p1.json', 'codex', { priority: 10 }),
    monitorAccount('p2.json', 'codex', { priority: 0 }),
    monitorAccount('q1.json', 'claude', { priority: 5 }),
    monitorAccount('q2.json', 'claude', { priority: 5 }),
  ], NOW)
  assert.equal(rows.find((r) => r.name === 'p1.json')!.first, true)
  assert.equal(rows.find((r) => r.name === 'p2.json')!.first, false)
  assert.equal(rows.filter((r) => r.first).length, 1)
  const groups = groupAccounts(rows)
  assert.equal(groups.find((g) => g.key === 'codex')!.tiered, true)
  assert.equal(groups.find((g) => g.key === 'claude')!.tiered, false)
})

test('reset credits: count plus entries sorted by expiry; none stays null', () => {
  const rows = buildAccounts(null, [
    monitorAccount('r.json', 'codex', {}, codexRaw, { availableCount: 2, credits: [{ id: 'b', expiresAt: '2026-10-11T01:00:00Z' }, { id: 'a', expiresAt: '2026-10-04T14:30:00Z' }] }),
    monitorAccount('n.json', 'codex', {}, codexRaw),
  ], NOW)
  const r = rows.find((x) => x.name === 'r.json')!
  assert.equal(r.credits?.count, 2)
  assert.deepEqual(r.credits?.entries.map((e) => e.id), ['a', 'b'])
  assert.equal(rows.find((x) => x.name === 'n.json')!.credits, null)
})

test('recent activity: 10-minute buckets become a tick strip with failing buckets marked', () => {
  const buckets = Array.from({ length: 20 }, (_, i) => ({ time: `t${i}`, success: i === 19 ? 5 : 1, failed: i === 18 ? 2 : 0 }))
  const rows = buildAccounts(null, [monitorAccount('a.json', 'codex', { recent_requests: buckets })], NOW)
  const recent = rows[0].recent!
  assert.equal(recent.ticks.length, 20)
  assert.equal(recent.ok, 24)
  assert.equal(recent.failed, 2)
  assert.equal(recent.bad[18], true)
  assert.equal(recent.bad[19], false)
})

test('groups: catalog order, attention first inside a group, unknown types at the end', () => {
  const rows = buildAccounts(
    [credential('z.json', 'qwen'), credential('k.json', 'kimi'), credential('c2.json', 'codex', { label: 'b@x' }), credential('c1.json', 'codex', { label: 'a@x' })],
    [monitorAccount('c2.json', 'codex', { status: 'error', status_message: '401' })],
    NOW,
  )
  const groups = groupAccounts(rows)
  assert.deepEqual(groups.map((g) => g.key), ['codex', 'kimi', 'qwen'])
  assert.equal(groups[0].accounts[0].name, 'c2.json')
  assert.equal(groups[2].vendor, '其它凭据')
})

test('filters and counts use the same words as the status column', () => {
  const rows = buildAccounts(null, [
    monitorAccount('hot.json', 'codex', {}, codexRaw, { availableCount: 1, credits: [] }),
    monitorAccount('paused.json', 'codex', { disabled: true }),
    monitorAccount('dead.json', 'claude', { status: 'error', status_message: 'invalid_grant' }),
    monitorAccount('flaky.json', 'claude', { status: 'error', status_message: 'upstream 500' }),
  ], NOW)
  const c = countBy(rows)
  assert.equal(c.all, 4)
  assert.equal(c.run, 1)
  assert.equal(c.pause, 1)
  assert.equal(c.bad, 1, '失效 counts lapsed authorizations only')
  assert.equal(c.warn, 1, '异常 is its own count, never folded into 失效')
  assert.equal(rows.filter((r) => matches(r, 'bad', '')).map((r) => r.name).join(), 'dead.json')
  assert.equal(rows.filter((r) => matches(r, 'warn', '')).map((r) => r.name).join(), 'flaky.json')
  assert.equal(c.hot, 1, 'the 97% Spark window counts toward ≥90%')
  assert.equal(c.reset, 1)
  assert.equal(c.attention, 2)
  assert.equal(c.providers, 2)
  assert.equal(rows.filter((r) => matches(r, 'reset', '')).length, 1)
  assert.equal(rows.filter((r) => matches(r, 'all', 'DEAD')).length, 1)
  assert.equal(rows.filter((r) => matches(r, 'all', 'claude')).length, 2)
})

test('fmtReset: today, tomorrow, this week, later (Asia/Shanghai)', () => {
  assert.equal(fmtReset(NOW + 70 * 60_000, NOW), '15:10')
  assert.equal(fmtReset('2026-10-03T01:00:00Z', NOW), '明天 09:00')
  assert.equal(fmtReset('2026-10-05T01:00:00Z', NOW), '周一 09:00')
  assert.equal(fmtReset('2026-10-12T01:00:00Z', NOW), '10/12 09:00')
  assert.equal(fmtReset(null, NOW), '—')
  // 23:30 Shanghai on the 2nd is still "today" although it is the 2nd in UTC too; 00:30 on the 3rd is tomorrow
  assert.equal(fmtReset('2026-10-02T16:30:00Z', NOW), '明天 00:30')
})

test('proxy labels never show userinfo', () => {
  assert.equal(proxyLabel(''), '继承网关')
  assert.equal(proxyLabel('direct'), '直连')
  assert.equal(proxyLabel('socks5://user:secret@192.0.2.2:1080'), 'socks5://192.0.2.2:1080')
  assert.equal(proxyLabel('http://proxy.local:8080'), 'http://proxy.local:8080')
})

test('reason words: numbers first, plain words, raw text only as a short fallback', () => {
  assert.equal(reasonWords('HTTP 429 Too Many Requests'), '429 限流 · Retry-After')
  assert.equal(reasonWords('usage limit reached'), '额度用尽 · 到重置时刻恢复')
  assert.equal(reasonWords('x'.repeat(80)).length, 48)
})

test('reset success: ok, partial (cooldownCleared=false), already used', () => {
  assert.deepEqual(classifyResetSuccess({ ok: true, cooldownCleared: true, resetCredits: { availableCount: 1, credits: [] } }, { creditsBefore: 2, coolUntil: null }), { outcome: 'ok', remaining: 1 })
  // not reported → not guessed from creditsBefore (FF-16); the no-cache refresh shows the real count
  assert.deepEqual(classifyResetSuccess({ ok: true, cooldownCleared: true, result: 'reset' }, { creditsBefore: 2, coolUntil: null }), { outcome: 'ok', remaining: null })
  assert.deepEqual(classifyResetSuccess({ ok: true, cooldownCleared: false }, { creditsBefore: 1, coolUntil: NOW + 5000 }), { outcome: 'partial', remaining: null, recoverAt: NOW + 5000 })
  assert.deepEqual(classifyResetSuccess({ ok: true, cooldownCleared: true, result: 'already_used' }, { creditsBefore: 1, coolUntil: null }), { outcome: 'redeemed' })
  assert.deepEqual(classifyResetSuccess({}, { creditsBefore: 1, coolUntil: null }), { outcome: 'unknown' })
})

test('reset errors map onto all the distinct outcomes', () => {
  assert.equal(classifyResetError(400, { error: '只有 Codex 账号支持主动重置' }).outcome, 'unsupported')
  assert.equal(classifyResetError(404, { error: '凭据不存在' }).outcome, 'unavailable')
  assert.equal(classifyResetError(409, { error: '当前没有可用的主动重置', detail: 'no_grant' }).outcome, 'no_credit')
  assert.equal(classifyResetError(409, { error: '上游未执行重置（not_limited）', detail: '' }).outcome, 'no_window')
  const cd = classifyResetError(409, { error: '上游未执行重置（cooldown）', detail: new Date(NOW + 252_000).toISOString() }, NOW)
  assert.equal(cd.outcome, 'cooldown')
  assert.equal(cd.retryInMs, 252_000)
  assert.equal(classifyResetError(409, { error: '上游未执行重置（ineligible）' }).outcome, 'no_credit')
  assert.equal(classifyResetError(502, { error: '上游返回 HTTP 400', detail: '{"code":"already_redeemed"}' }).outcome, 'redeemed')
  assert.equal(classifyResetError(502, { error: '上游返回 HTTP 400', detail: '{"error":"no_credit"}' }).outcome, 'no_credit')
  assert.equal(classifyResetError(502, { error: '上游返回 HTTP 429', detail: '' }).outcome, 'cooldown')
  assert.equal(classifyResetError(502, { error: '上游返回 HTTP 500', detail: 'boom' }).outcome, 'unavailable')
  assert.equal(classifyResetError(409, { error: '凭据缺少 organization uuid，无法重置' }).outcome, 'unavailable')
  assert.equal(classifyResetError(null, null).outcome, 'unknown')
})

/* ── review removals-regressions ── */

test('RR-2: the exit picker shows the authoritative per-account value, unknown until it is read, and never skips a write it cannot rule out', () => {
  const egress = {
    backend: 'cpa', cpaSameHost: true, kernel: { state: 'unavailable' }, accountProxy: { supported: true, reason: null },
    default: { mode: 'inherit', entryId: null }, services: {}, signin: { via: 'cpa-global', exit: { mode: 'inherit', entryId: null }, perSignin: false, note: '' },
    entries: [{ id: 'px_aaaaaaaaaa', name: 'gate', kind: 'url', protocol: 'socks5', country: 'JP', exitState: null, checks: {}, checkedAt: null, assignable: true, reason: null, usedBy: 1 }],
    accounts: {}, presets: [{ label: '东京', entryId: 'px_aaaaaaaaaa' }, { label: '住宅', entryId: null }],
  } as unknown as EgressData
  const read = (over: Partial<EgressRead>): ProxyRead => ({ state: 'ready', value: { ref: 'cpa:a.json', mode: 'url', entryId: null, masked: null, at: null, entryName: null, preset: null, ...over } })
  // CPA mode: /api/channels says '' for every account; the per-account read says 'direct'
  assert.equal(proxyChoice(read({ mode: 'direct' }), egress), 'direct')
  assert.equal(proxyNeedsWrite(read({ mode: 'direct' }), '', egress), true, '直连 → 继承 must write the clear')
  assert.equal(proxyNeedsWrite(read({ mode: 'inherit' }), '', egress), false)
  assert.equal(proxyChoice(read({ mode: 'inherit' }), egress), '')
  // a pool entry is picked by id; a preset that is not in the pool by its index; anything else is custom
  assert.equal(proxyChoice(read({ entryId: 'px_aaaaaaaaaa', preset: 0 }), egress), 'px_aaaaaaaaaa')
  assert.equal(proxyNeedsWrite(read({ entryId: 'px_aaaaaaaaaa' }), 'px_aaaaaaaaaa', egress), false)
  assert.equal(proxyChoice(read({ preset: 1, masked: 'http://***@res:3128' }), egress), 'preset:1')
  assert.equal(proxyChoice(read({ masked: 'http://***@other:3128' }), egress), PROXY_CUSTOM)
  // the pool view not there (yet): an entry the account points at reads as custom, never as 继承
  assert.equal(proxyChoice(read({ entryId: 'px_aaaaaaaaaa' }), null), PROXY_CUSTOM)
  // not read yet / read failed: the picker says so instead of claiming 继承, and any pick is sent
  assert.equal(proxyChoice({ state: 'loading' }, egress), PROXY_UNKNOWN)
  assert.equal(proxyChoice({ state: 'error' }, egress), PROXY_UNKNOWN)
  assert.equal(proxyNeedsWrite({ state: 'error' }, '', egress), true)
  assert.equal(proxyNeedsWrite({ state: 'loading' }, 'direct', egress), true)
  assert.equal(proxyNeedsWrite({ state: 'error' }, PROXY_CUSTOM, egress), false)
  assert.equal(proxyNeedsWrite({ state: 'error' }, PROXY_UNKNOWN, egress), false)
  // a typed address is always sent (its masked form cannot be compared)
  assert.equal(proxyNeedsWrite(read({ masked: 'http://***@other:3128' }), 'http://u:p@other:3128', egress), true)
})

test('RR-2 follow-up: a read that lands while a custom address is being typed keeps it; the sent address is replaced', () => {
  // slow first GET: the admin picked 自定义 and is typing when the read settles → keep the field
  assert.equal(proxyKeepsDraft(PROXY_CUSTOM, 'socks5://192.0.2.9:1080', null), true)
  assert.equal(proxyKeepsDraft(PROXY_CUSTOM, '  socks5://192.0.2.9:1080 ', 'other'), true)
  // the address just saved: the PATCH answer (or the re-read after a failed PATCH) takes over
  assert.equal(proxyKeepsDraft(PROXY_CUSTOM, 'socks5://192.0.2.9:1080 ', 'socks5://192.0.2.9:1080'), false)
  // nothing typed, or another option picked: the read resets the picker as before
  assert.equal(proxyKeepsDraft(PROXY_CUSTOM, '   ', null), false)
  assert.equal(proxyKeepsDraft('direct', 'socks5://192.0.2.9:1080', null), false)
  assert.equal(proxyKeepsDraft(PROXY_UNKNOWN, 'socks5://192.0.2.9:1080', null), false)
})

test('RR-4: a renewal is only reported for a re-auth of that account; a plain add that is not listed yet is not success', () => {
  const baseline = new Set(['codex-a.json'])
  const mine = [{ key: 'codex-a.json', email: 'a@example.com' }]
  // second Codex account added, the list has not caught up: not "已续期"
  assert.equal(verifyOutcome(mine, baseline, null, true), null)
  // re-auth of a@: the same file is still there → renewed
  assert.deepEqual(verifyOutcome(mine, baseline, 'a@example.com', true), { renewed: true })
  // re-auth of someone else is not a renewal of a@
  assert.equal(verifyOutcome(mine, baseline, 'b@example.com', true), null)
  // a read that failed proves nothing
  assert.equal(verifyOutcome(mine, baseline, 'a@example.com', false), null)
  // a new file wins in both modes
  const added = [...mine, { key: 'codex-b.json', email: 'b@example.com' }]
  assert.deepEqual(verifyOutcome(added, baseline, null, true), { name: 'codex-b.json', email: 'b@example.com' })
  assert.deepEqual(verifyOutcome(added, baseline, 'a@example.com', true), { name: 'codex-b.json', email: 'b@example.com' })
})

test('RR-5: a refresh where one endpoint fails keeps that endpoint\'s last good data and marks it stale', () => {
  const first = { channels: { credentials: [1] }, monitor: { accounts: [1] }, channelsError: null, monitorError: null, at: 1000, channelsAt: 1000, monitorAt: 1000 }
  const boom = new Error('502')
  const monitorDown = mergeAccountsPayload(first, { channels: { credentials: [2] }, monitor: null, channelsError: null, monitorError: boom, at: 61_000, channelsAt: 61_000, monitorAt: null })
  assert.deepEqual(monitorDown.monitor, { accounts: [1] }, 'quota windows, reset credits and authIndex survive')
  assert.equal(monitorDown.monitorAt, 1000)
  assert.equal(monitorDown.monitorError, boom, 'the failure is still shown')
  assert.deepEqual(monitorDown.channels, { credentials: [2] })
  assert.equal(monitorDown.channelsAt, 61_000)

  const channelsDown = mergeAccountsPayload(monitorDown, { channels: null, monitor: { accounts: [3] }, channelsError: boom, monitorError: null, at: 121_000, channelsAt: null, monitorAt: 121_000 })
  assert.deepEqual(channelsDown.channels, { credentials: [2] })
  assert.equal(channelsDown.channelsAt, 61_000)
  assert.deepEqual(channelsDown.monitor, { accounts: [3] })
  assert.equal(channelsDown.monitorError, null)

  // nothing to keep on the first load: the failed side stays empty
  const cold = mergeAccountsPayload(undefined, { channels: null, monitor: { accounts: [1] }, channelsError: boom, monitorError: null, at: 5, channelsAt: null, monitorAt: 5 })
  assert.equal(cold.channels, null)
  assert.equal(cold.channelsAt, null)
})
