import assert from 'node:assert/strict'
import test from 'node:test'
import {
  fmtSpan, jobAction, jobMark, jobRow, lanePulses, policyFigures, splitEmails, syncHeadline, syncTally, type SyncJobLike,
} from '../src/features/settings/settingsModel.js'

/** /settings page model (DESIGN §6.8): sync rows (C3). */

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

test('splitEmails', () => {
  assert.deepEqual(splitEmails('no email here'), [{ text: 'no email here', email: false }])
  assert.equal(splitEmails('x@example.com and z+1@w.example.com').filter((p) => p.email).length, 2)
})
