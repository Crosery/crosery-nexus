import assert from 'node:assert/strict'
import test from 'node:test'
import {
  contractDiffCount, fmtSpan, gapMark, gatewayIndex, jobAction, jobMark, jobRow, lanePulses, policyFigures, rtkApplyNotice, rtkConfirmFacts,
  rtkDailySeries, rtkDirections, rtkTargets, rtkWords, shortRev, splitEmails, syncHeadline, syncTally, type SyncJobLike,
} from '../src/features/settings/settingsModel.js'

/** /settings page model (DESIGN §6.8): sync rows (C3), the RTK global switch (C4), the kernel diff count. */

const NOW = Date.parse('2026-10-02T06:00:00Z')
const iso = (ms: number) => new Date(NOW + ms).toISOString()
const M = 60_000

function job(over: Partial<SyncJobLike> = {}): SyncJobLike {
  return {
    id: 'model-discovery', label: '模型目录', kind: 'in-process', intervalMs: 30 * M,
    lastRunAt: iso(-10 * M), nextRunAt: iso(20 * M), state: 'idle', lastResult: 'ok', lastError: null, summary: '128 模型',
    backoffUntil: null, backoffLevel: 0, requests24h: 48, history: [], canRunNow: true, runCooldownUntil: null,
    ...over,
  }
}

const POLICY = { globalUpstreamConcurrency: 4, minIntervalPerHostMs: 60_000, backoff: { factor: 2, baseMs: 60_000, maxMs: 6 * 3_600_000 }, jitterPct: 10 }

test('fmtSpan picks the unit an operator reads', () => {
  assert.equal(fmtSpan(5_000), '5s')
  assert.equal(fmtSpan(60_000), '1m')
  assert.equal(fmtSpan(30 * M), '30m')
  assert.equal(fmtSpan(90 * M), '1h30m')
  assert.equal(fmtSpan(6 * 60 * M), '6h')
  assert.equal(fmtSpan(24 * 60 * M), '1d')
  assert.equal(fmtSpan(null), '—')
  assert.equal(fmtSpan(0), '—')
})

test('jobMark: failure ◆, backoff and degraded ◇, cooldown never orange, unknown is not "正常"', () => {
  assert.deepEqual(jobMark({ state: 'idle', lastResult: 'ok' }), { state: 'run', label: '正常', severity: null })
  assert.equal(jobMark({ state: 'backoff', lastResult: 'error' }).state, 'warn')
  assert.equal(jobMark({ state: 'error', lastResult: 'error' }).state, 'bad')
  assert.equal(jobMark({ state: 'idle', lastResult: 'error' }).state, 'bad')
  assert.equal(jobMark({ state: 'idle', lastResult: 'partial' }).label, '部分成功')
  assert.equal(jobMark({ state: 'running', lastResult: 'ok' }).state, 'busy')
  assert.equal(jobMark({ state: 'disabled', lastResult: null }).state, 'off')
  assert.equal(jobMark({ state: 'unknown', lastResult: null }).label, '未知')
  assert.equal(jobMark({ state: 'idle', lastResult: null }).label, '未运行')
  assert.equal(jobMark({ state: 'idle', lastResult: 'skipped' }).label, '跳过')
})

test('jobAction: server cooldown wins over canRunNow, running and read-only jobs get no live button', () => {
  assert.deepEqual(jobAction(job(), NOW), { kind: 'run', label: '立即同步', backoff: false })
  assert.equal(jobAction(job({ state: 'backoff' }), NOW).kind, 'run')
  assert.equal((jobAction(job({ state: 'backoff' }), NOW) as { backoff: boolean }).backoff, true)
  const cooling = jobAction(job({ canRunNow: false, runCooldownUntil: iso(4 * M) }), NOW)
  assert.equal(cooling.kind, 'cooldown')
  assert.equal((cooling as { until: number }).until, NOW + 4 * M)
  // an expired cooldown with canRunNow=false (e.g. stale payload) is not shown as cooling
  assert.equal(jobAction(job({ canRunNow: false, runCooldownUntil: iso(-M), kind: 'external' }), NOW).kind, 'none')
  assert.equal(jobAction(job({ state: 'running', canRunNow: false }), NOW).kind, 'running')
  assert.deepEqual(jobAction(job({ kind: 'external', canRunNow: false }), NOW), { kind: 'none', label: '外部 · 只读' })
  assert.deepEqual(jobAction(job({ id: 'data-plane', canRunNow: false, state: 'disabled' }), NOW), { kind: 'none', label: '未启用' })
  assert.deepEqual(jobAction(job({ id: 'data-plane', canRunNow: false }), NOW), { kind: 'none', label: '自有循环' })
})

test('jobRow: interval words, backoff target, overdue external jobs, uncounted calls', () => {
  const row = jobRow(job({ lastResult: 'partial', summary: '网关 60 · 双源 671' }), POLICY, NOW)
  assert.equal(row.every, '每 30m')
  assert.equal(row.jitter, '±10%')
  assert.equal(row.lastWords, '部分成功 · 网关 60 · 双源 671')
  assert.equal(row.calls, '48 次')
  assert.equal(row.source, '渠道 /models 探测')

  const quota = jobRow(job({ id: 'account-quota', intervalMs: null, nextRunAt: null }), POLICY, NOW)
  assert.equal(quota.every, '按需')
  assert.equal(quota.jitter, null)
  assert.equal(quota.next.word, '按需')

  const backoff = jobRow(job({ state: 'backoff', backoffUntil: iso(90 * M) }), POLICY, NOW)
  assert.equal(backoff.next.prefix, '退避至')
  assert.equal(backoff.next.at, NOW + 90 * M)

  const external = jobRow(job({ kind: 'external', intervalMs: 6 * 60 * M, nextRunAt: iso(-60 * M), requests24h: null }), POLICY, NOW)
  assert.equal(external.next.overdue, true)
  assert.equal(external.jitter, null)
  assert.equal(external.calls, '未计数')
  // a 5-minute scheduler tick is not "overdue"
  assert.equal(jobRow(job({ nextRunAt: iso(-3 * M) }), POLICY, NOW).next.overdue, false)

  const failed = jobRow(job({ state: 'error', lastResult: 'error', lastError: 'a.b@example.com → 401 unauthorized' }), POLICY, NOW)
  assert.equal(failed.error?.hot, true)
  assert.deepEqual(failed.error?.parts, [{ text: 'a.b@example.com', email: true }, { text: ' → 401 unauthorized', email: false }])
  assert.equal(jobRow(job({ state: 'disabled' }), POLICY, NOW).next.word, '已停用')
})

test('syncTally + policy figures come from the payload, external jobs are not counted as calls', () => {
  const jobs = [
    job({ requests24h: 3 }),
    job({ id: 'pricing', state: 'backoff', lastResult: 'error', requests24h: 0 }),
    job({ id: 'data-plane', state: 'error', lastResult: 'error', requests24h: 0 }),
    job({ id: 'account-quota', state: 'running', requests24h: 12 }),
    job({ id: 'catalog-sync', kind: 'external', requests24h: null }),
  ]
  const tally = syncTally(jobs)
  assert.deepEqual(tally, { total: 5, bad: 1, warn: 1, busy: 1, calls24h: 15, counted: 4 })
  assert.equal(syncHeadline(tally), '1 运行 · 1 失败 · 1 注意')
  assert.equal(syncHeadline(syncTally([job()])), '全部正常')
  const figures = policyFigures(POLICY, tally)
  assert.deepEqual(figures.map((f) => [f.k, f.v]), [['账号额度并发', '4'], ['单源最小间隔', '1m'], ['失败退避', '×2'], ['随机抖动', '±10%'], ['近 24h 上游请求', '15']])
  assert.equal(figures[2].sub, '1m 起 · ≤ 6h')
  assert.equal(policyFigures(POLICY, syncTally([job({ kind: 'external', requests24h: null })])).length, 4)
})

test('lanePulses: duration sets the width (min 2px), runs outside the window drop', () => {
  const from = NOW - 24 * 60 * M
  const to = NOW + 2 * 60 * M
  const pulses = lanePulses([
    { at: iso(-25 * 60 * M), result: 'ok', durationMs: 1000 },
    { at: iso(-13 * 60 * M), result: 'error', durationMs: 1000 },
    { at: iso(-60 * M), result: 'ok', durationMs: 60 * M },
    { at: 'not a date', result: 'ok', durationMs: null },
  ], from, to, 1040)
  assert.equal(pulses.length, 2)
  assert.equal(pulses[0].result, 'error')
  assert.equal(Math.round(pulses[0].x), 440)
  assert.equal(pulses[0].w, 2)
  assert.equal(Math.round(pulses[1].w), 40)
  assert.deepEqual(lanePulses([], from, to, 0), [])
})

test('rtkWords: mixed is not "on", savings percent is the server percent, blocked reasons are words', () => {
  const mixed = rtkWords({ on: null, plane: 'local', agents: { supported: 9, on: 4 }, savings: { pct: 58.2, tokens: 2_227_051 }, writable: true, reason: null })
  assert.equal(mixed.state, 'mixed')
  assert.equal(mixed.word, '部分开启')
  assert.equal(mixed.coverage, '4 / 9')
  assert.equal(mixed.plane, '本机')
  assert.equal(mixed.savings, '2.2M')
  assert.equal(mixed.savingsPct, '58.2%')
  assert.equal(mixed.blocked, null)
  const blocked = rtkWords({ on: true, plane: 'kernel', agents: { supported: 3, on: 3 }, savings: null, writable: false, reason: 'kernel_write_disabled' })
  assert.equal(blocked.state, 'on')
  assert.equal(blocked.savings, null)
  assert.equal(blocked.blocked, '内核平面写入未开启')
  assert.equal(rtkWords({ on: null, plane: null, agents: { supported: 0, on: 0 }, savings: null, writable: false, reason: 'no_supported_agents' }).state, 'unknown')
})

test('rtk confirm facts name exactly the clients the server will touch', () => {
  const agents = [
    { id: 'codex', name: 'Codex CLI', on: true, supported: true, installed: true },
    { id: 'cursor', name: 'Cursor', on: false, supported: true, installed: true },
    { id: 'trae', name: 'Trae IDE', on: false, supported: true, installed: false },
    { id: 'windsurf', name: 'Windsurf', on: false, supported: false, installed: false, blocked: 'project_scoped_only' },
  ]
  assert.deepEqual(rtkTargets(agents, 'local').map((a) => a.id), ['codex', 'cursor'])
  assert.deepEqual(rtkTargets(agents, 'kernel').map((a) => a.id), ['codex', 'cursor', 'trae'])
  const g = { on: null, plane: 'local' as const, agents: { supported: 2, on: 1 }, savings: null, writable: true, reason: null }
  const on = rtkConfirmFacts(g, true, agents)
  assert.deepEqual(on.map((f) => f.k), ['平面', '范围', '将挂载', '保护'])
  assert.equal(on[2].v, 'Cursor')
  assert.equal(rtkConfirmFacts(g, false, agents)[2].v, 'Codex CLI')
  assert.equal(rtkConfirmFacts({ ...g, on: true, agents: { supported: 2, on: 2 } }, true, agents.map((a) => ({ ...a, on: true })))[2].v, '无 · 已是目标状态')
  // without the diagnostics list the sheet still states counts, never a guess at names
  assert.equal(rtkConfirmFacts(g, true, null)[2].v, '1 个')
})

test('rtk apply notice never hides a partial failure', () => {
  assert.equal(rtkApplyNotice({ ok: true, on: true, results: [{ agent: 'codex', ok: true, error: null, unchanged: true }, { agent: 'cursor', ok: true, error: null }] }, true).title, '✓ RTK 已全部开启 · 改动 1 · 未变 1')
  const partial = rtkApplyNotice({ ok: false, on: null, results: [{ agent: 'codex', ok: true, error: null }, { agent: 'cursor', ok: false, error: 'EACCES' }] }, false)
  assert.equal(partial.tone, 'warn')
  assert.match(partial.title, /失败 1 · 成功 1/)
  assert.equal(partial.description, 'cursor：EACCES')
  assert.equal(rtkApplyNotice({ ok: false, on: false, results: [{ agent: 'cursor', ok: false, error: null }] }, true).tone, 'bad')
})

test('rtkDailySeries zero-fills days without rtk runs and stays inside the window', () => {
  const series = rtkDailySeries([
    { date: '2026-09-30', saved: 75, input: 200 },
    { date: '2026-10-01', saved: 2150, input: 3600 },
    { date: '2026-08-16', saved: 999, input: 999 },
  ], '2026-10-02', 3)
  assert.deepEqual(series.dates, ['2026-09-30', '2026-10-01', '2026-10-02'])
  assert.deepEqual(series.values, [75, 2150, 0])
  assert.equal(series.saved, 2225)
  assert.equal(series.input, 3800)
})

test('splitEmails and contractDiffCount', () => {
  assert.deepEqual(splitEmails('no email here'), [{ text: 'no email here', email: false }])
  assert.equal(splitEmails('x@y.io and z+1@w.example.com').filter((p) => p.email).length, 2)
  assert.equal(contractDiffCount(null), 0)
  assert.equal(contractDiffCount({ addedRoutes: ['a', 'b'], removedRoutes: [], changedRoutes: ['c'], addedLoginAgents: [], removedLoginAgents: ['d'] }), 4)
})

/* ── review removals-regressions ── */

test('RR-1: a mixed RTK switch offers both 全部开启 and 全部关闭; on/off keep the one switch', () => {
  const base = { plane: 'local' as const, savings: null, writable: true, reason: null }
  const mixed = rtkWords({ ...base, on: null, agents: { supported: 9, on: 4 } })
  assert.deepEqual(rtkDirections(mixed, true), [{ target: true, label: '全部开启' }, { target: false, label: '全部关闭' }])
  // nothing to offer when the plane is not writable: the switch is disabled with the reason
  assert.deepEqual(rtkDirections(mixed, false), [])
  assert.deepEqual(rtkDirections(rtkWords({ ...base, on: true, agents: { supported: 9, on: 9 } }), true), [])
  assert.deepEqual(rtkDirections(rtkWords({ ...base, on: false, agents: { supported: 9, on: 0 } }), true), [])
})

test('RR-3: every write ok but the re-read is not the target, or a collateral file was left alone → warn with the files', () => {
  const drift = rtkApplyNotice({
    ok: false,
    on: null,
    offTarget: ['claude'],
    results: [
      { agent: 'claude', ok: true, error: null },
      { agent: 'cursor', ok: true, error: null, collateralSkipped: [{ agent: 'claude', file: '.claude/settings.json', reason: 'unparsable_or_unknown_shape' }] },
    ],
  }, true)
  assert.equal(drift.tone, 'warn')
  assert.doesNotMatch(drift.title, /已全部开启/)
  assert.match(drift.title, /部分开启/)
  assert.match(drift.description ?? '', /未到位 claude/)
  assert.match(drift.description ?? '', /未自动还原（请人工确认）：\.claude\/settings\.json（claude）/)

  // the re-read reached the target, yet a file was not restored: still a warning, never ✓
  const skipped = rtkApplyNotice({ ok: true, on: true, results: [{ agent: 'cursor', ok: true, error: null, collateralSkipped: [{ agent: 'claude', file: '.claude/RTK.md', reason: 'concurrent_modification' }] }] }, true)
  assert.equal(skipped.tone, 'warn')
  assert.match(skipped.description ?? '', /\.claude\/RTK\.md/)

  // the re-read fell back to another plane: nothing was verified, so it is not called 部分开启
  const unverified = rtkApplyNotice({ ok: false, on: null, offTarget: [], degraded: 'verify_plane_unavailable', results: [{ agent: 'codex', ok: true, error: null }] }, true)
  assert.equal(unverified.tone, 'warn')
  assert.match(unverified.title, /没能复核/)
  assert.doesNotMatch(unverified.title, /部分开启|已全部开启/)
  assert.match(unverified.description ?? '', /不是写入的平面/)

  // an older server without offTarget: `on` alone still decides
  assert.equal(rtkApplyNotice({ ok: true, on: null, results: [{ agent: 'codex', ok: true, error: null }] }, true).tone, 'warn')
  // per-agent failures keep their own wording and also list the skipped files
  const failed = rtkApplyNotice({ ok: false, on: null, results: [{ agent: 'codex', ok: false, error: 'EACCES' }, { agent: 'cursor', ok: true, error: null, collateralSkipped: [{ agent: 'claude', file: '.claude/settings.json', reason: 'x' }] }] }, true)
  assert.match(failed.title, /失败 1 · 成功 1/)
  assert.match(failed.description ?? '', /codex：EACCES/)
  assert.match(failed.description ?? '', /\.claude\/settings\.json/)
})

test('RR-9: rtk_binary_missing carries the manual install command; other reasons do not', () => {
  const hint = 'curl -fsSL https://example.test/install.sh | sh'
  const missing = rtkWords({ on: null, plane: 'local', agents: { supported: 2, on: 0 }, savings: null, writable: false, reason: 'rtk_binary_missing', installHint: hint })
  assert.equal(missing.blocked, '找不到 rtk 程序')
  assert.equal(missing.install, hint)
  assert.equal(rtkWords({ on: true, plane: 'local', agents: { supported: 2, on: 2 }, savings: null, writable: false, reason: 'write_disabled', installHint: hint }).install, null)
  assert.equal(rtkWords({ on: true, plane: 'local', agents: { supported: 2, on: 2 }, savings: null, writable: true, reason: null }).install, null)
})

test('网关 Magpie: one name per build, behind is a calm to-do, only an offline kernel is hot', () => {
  assert.equal(shortRev('crosery-3fe2ff9'), '3fe2ff9')
  assert.equal(shortRev('3fe2ff99587e17dfe0ea707ffd0eccc088824433'), '3fe2ff9')
  assert.equal(shortRev(null), null)
  assert.deepEqual(gapMark({ state: 'latest', label: '已是最新' }), { state: 'run', label: '已是最新' })
  assert.deepEqual(gapMark({ state: 'behind', label: '落后 ≥66 个提交' }), { state: 'pause', label: '落后 ≥66 个提交' })
  assert.deepEqual(gapMark({ state: 'unknown', label: '未知' }), { state: 'stale', label: '差距未知' })
  assert.deepEqual(gatewayIndex({ current: { running: true }, gap: { state: 'behind', label: '落后 ≥66 个提交' } }), { value: '落后', hot: false })
  assert.deepEqual(gatewayIndex({ current: { running: false }, gap: { state: 'latest', label: '已是最新' } }), { value: '◆ 离线', hot: true })
})
