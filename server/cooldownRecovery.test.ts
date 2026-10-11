import test from 'node:test'
import assert from 'node:assert/strict'
import {
  AUTO_CLEAR_MIN_INTERVAL_MS,
  decideStaleCooldownClear,
  reconcileStaleCooldown,
  resetAutoClearThrottle,
  type NormalizedQuotaView,
  type StaleCooldownInput,
} from './cooldownRecovery.js'

const NOW = Date.UTC(2026, 9, 11, 6, 30)

type CodexQuota = {
  plan_type?: string
  error?: string
  rate_limit?: {
    allowed?: boolean
    limit_reached?: boolean
    primary_window?: { used_percent?: number; limit_window_seconds?: number; reset_after_seconds?: number; reset_at?: number } | null
    secondary_window?: null
    additional_rate_limits?: Array<{ name?: string; rate_limit?: { used_percent?: number } }>
  }
}

/** 真实形状：账号在 ChatGPT 侧重置后上游 allowed/0%（2026-10-11 实测）。 */
const codexQuota = (rateLimit: Partial<NonNullable<CodexQuota['rate_limit']>> = {}): CodexQuota => ({
  plan_type: 'prolite',
  rate_limit: {
    allowed: true,
    limit_reached: false,
    primary_window: { used_percent: 0, limit_window_seconds: 604800, reset_after_seconds: 604800, reset_at: 1792304441 },
    secondary_window: null,
    ...rateLimit,
  },
})

/** CPA 侧仍按旧 429 排着 credential_quota 冷却时的 auth-files 条目。 */
const coolingFile = (overrides: Record<string, unknown> = {}): StaleCooldownInput['file'] => ({
  name: 'codex-a.json',
  type: 'codex',
  status: 'error',
  status_message: JSON.stringify({ error: { type: 'usage_limit_reached', message: 'The usage limit has been reached', resets_at: 1791950490 } }),
  unavailable: true,
  cooldowns: [
    { scope: 'credential', reason: 'credential_quota', retry_at: '2026-10-14T04:01:30Z', remaining_seconds: 256099 },
    { scope: 'model', model_key: 'gpt-6.1-sol', reason: 'credential_quota', retry_at: '2026-10-14T04:01:30Z' },
  ],
  ...overrides,
})

const codexInput = (
  options: { quota?: unknown; file?: StaleCooldownInput['file']; normalizedQuota?: NormalizedQuotaView | null } = {},
): StaleCooldownInput => ({
  file: options.file ?? coolingFile(),
  quota: options.quota ?? codexQuota(),
  normalizedQuota: options.normalizedQuota ?? { error: null, windows: [{ id: 'primary', usedPercent: 0, severity: 'normal' }] },
})

test('codex：上游 allowed 且窗口 0%，CPA 挂着额度冷却 ⇒ 清', () => {
  assert.deepEqual(decideStaleCooldownClear(codexInput()), { clear: true, reason: 'rate_limit.allowed（2/2 条额度类冷却）' })
})

test('codex：上游仍满/仍限流/未放行 ⇒ 不动', () => {
  assert.equal(decideStaleCooldownClear(codexInput({ quota: codexQuota({ limit_reached: true }) })).clear, false)
  assert.equal(decideStaleCooldownClear(codexInput({ quota: codexQuota({ primary_window: { used_percent: 100 } }) })).clear, false)
  assert.equal(decideStaleCooldownClear(codexInput({ quota: codexQuota({ allowed: false }) })).clear, false)
})

test('codex：模型级窗口未放行（additional_rate_limits）⇒ 不动', () => {
  const quota = codexQuota({ additional_rate_limits: [{ name: 'gpt-6.1-sol', rate_limit: { used_percent: 100 } }] })
  assert.equal(decideStaleCooldownClear(codexInput({ quota })).clear, false)
})

test('额度是冷却期旧值（带 error）不能当「已恢复」的证据', () => {
  const stale = codexInput({ quota: { error: '上游返回 HTTP 429（冷却至 12:00）' } })
  assert.equal(decideStaleCooldownClear(stale).clear, false)
  assert.match(decideStaleCooldownClear(stale).reason, /旧值/)

  const normalizedFailed = codexInput({ normalizedQuota: { error: '读取失败', windows: [] } })
  assert.equal(decideStaleCooldownClear(normalizedFailed).clear, false)
})

test('只有瞬时错误的冷却（非额度类）⇒ 交给 CPA 退避，不清', () => {
  const file = coolingFile({ cooldowns: [{ scope: 'credential', reason: 'transient_error', http_status: 502, retry_at: '2026-10-11T06:31:00Z' }] })
  assert.equal(decideStaleCooldownClear(codexInput({ file })).clear, false)
  assert.match(decideStaleCooldownClear(codexInput({ file })).reason, /非额度类冷却/)
})

test('没有冷却明细时，状态文案必须真是额度/限流才算', () => {
  const quotaMessage = coolingFile({ cooldowns: [], status_message: 'HTTP 429 rate limit exceeded' })
  assert.equal(decideStaleCooldownClear(codexInput({ file: quotaMessage })).clear, true)

  const authMessage = coolingFile({ cooldowns: [], status_message: 'invalid refresh token' })
  assert.equal(decideStaleCooldownClear(codexInput({ file: authMessage })).clear, false)
})

test('claude：窗口都有余量 ⇒ 清；任一窗口满或 critical ⇒ 不动', () => {
  const file = coolingFile({
    name: 'claude-a.json',
    type: 'claude',
    cooldowns: [{ scope: 'credential', reason: 'credential_quota', retry_at: '2026-10-15T16:00:11Z' }],
  })
  const fresh: NormalizedQuotaView = {
    error: null,
    windows: [{ id: 'five_hour', usedPercent: 12, severity: 'normal' }, { id: 'seven_day', usedPercent: 40, severity: 'normal' }],
  }
  assert.equal(decideStaleCooldownClear(codexInput({ file, quota: {}, normalizedQuota: fresh })).clear, true)

  const sevenDayFull: NormalizedQuotaView = { error: null, windows: [{ id: 'seven_day', usedPercent: 100, severity: 'critical' }] }
  assert.equal(decideStaleCooldownClear(codexInput({ file, quota: {}, normalizedQuota: sevenDayFull })).clear, false)

  const noWindows: NormalizedQuotaView = { error: null, windows: [] }
  assert.equal(decideStaleCooldownClear(codexInput({ file, quota: {}, normalizedQuota: noWindows })).clear, false)
})

test('停用的凭据、未知类型、缺文件名：都不动', () => {
  assert.equal(decideStaleCooldownClear(codexInput({ file: coolingFile({ disabled: true }) })).clear, false)
  assert.equal(decideStaleCooldownClear(codexInput({ file: { name: 'x.json', type: 'xai' } })).clear, false)
  assert.equal(decideStaleCooldownClear(codexInput({ file: { type: 'codex' } })).clear, false)
})

test('执行：清一次并写审计；5 分钟内不重复清', async () => {
  resetAutoClearThrottle()
  const cleared: string[] = []
  const audits: string[] = []
  const deps = {
    clear: async (name: string) => { cleared.push(name) },
    audit: (action: string, target: string, details: string) => { audits.push(`${action}:${target}:${details}`) },
    now: NOW,
  }
  assert.equal(await reconcileStaleCooldown(codexInput(), deps), 'cleared')
  assert.deepEqual(cleared, ['codex-a.json'])
  assert.match(audits[0] ?? '', /^auto-clear-cooldown:codex-a\.json:rate_limit\.allowed/)

  assert.equal(await reconcileStaleCooldown(codexInput(), { ...deps, now: NOW + AUTO_CLEAR_MIN_INTERVAL_MS - 1 }), 'throttled')
  assert.equal(await reconcileStaleCooldown(codexInput(), { ...deps, now: NOW + AUTO_CLEAR_MIN_INTERVAL_MS }), 'cleared')
  assert.deepEqual(cleared, ['codex-a.json', 'codex-a.json'])
})

test('执行：清冷却失败不抛，记一条失败审计，并且同样进节流窗口', async () => {
  resetAutoClearThrottle()
  const audits: string[] = []
  const deps = {
    clear: async () => { throw new Error('CPA 502') },
    audit: (_action: string, _target: string, details: string) => { audits.push(details) },
    now: NOW,
  }
  assert.equal(await reconcileStaleCooldown(codexInput(), deps), 'clear-failed')
  assert.match(audits[0] ?? '', /^failed: /)
  assert.equal(await reconcileStaleCooldown(codexInput(), deps), 'throttled')
})

test('执行：不该清的输入直接 skipped，不产生任何调用', async () => {
  resetAutoClearThrottle()
  let calls = 0
  const file = coolingFile({ name: 'codex-b.json', status: 'active', unavailable: false, cooldowns: [] })
  const outcome = await reconcileStaleCooldown(codexInput({ file }), { clear: async () => { calls += 1 }, audit: () => {}, now: NOW })
  assert.equal(outcome, 'skipped')
  assert.equal(calls, 0)
})
