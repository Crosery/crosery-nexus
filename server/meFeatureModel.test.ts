import assert from 'node:assert/strict'
import test from 'node:test'
import {
  callableCount, exhaustAt, explainFailure, failureBrief, fmtCtx, fmtLeft, fmtPerM, modelFilterCounts, pickExample, priceText, projectToday, quotaRows, resetPhrase, statusText, usageDayBounds, usedText, vendorOf, windowStart,
} from '../src/features/me/meModel.js'
import type { MeModel } from '../src/types.js'

/*
 * Key-user pages (src/features/me) — the pure parts: plain-word failures, quota pace and reset phrases
 * (Asia/Shanghai), vendor grouping and $/M formatting. Rendering is covered by the build + visual QA.
 */

const SH = (local: string) => Date.parse(`${local}+08:00`)

test('失败用人话：发生了什么 · 谁的问题 · 下一步；原始码只作后缀', () => {
  assert.deepEqual(explainFailure(429, 'rate_limited'), { title: '上游限流', whose: 'upstream', next: '不是你的问题 · 稍后重试', code: '429 rate_limited' })
  assert.equal(explainFailure(400, 'context_too_large').whose, 'client')
  assert.equal(explainFailure(499, 'client_cancelled').title, '客户端中途断开')
  assert.equal(explainFailure(429, 'quota_exceeded').whose, 'key', '网关的 Key 额度拒绝不是上游限流')
  assert.equal(explainFailure(503, 'upstream_5xx').title, '上游服务出错')
  assert.equal(explainFailure(502, '').title, '上游服务出错', '没有分类时按状态码')
  assert.equal(explainFailure(400, 'other').code, '400', '`other` 不当作代码后缀')
  assert.equal(explainFailure(null, null).code, '未知')
  assert.equal(explainFailure(418, 'other').whose, 'unknown')
  assert.equal(statusText({ success: true, status: 200 }), '✓ 200')
  assert.equal(statusText({ success: false, status: null }), '◆ 失败')
  assert.equal(failureBrief([{ status: 429, category: 'rate_limited', count: 2 }, { status: 400, category: 'other', count: 1 }, { status: 429, category: 'x', count: 1 }]), '429 ×3 · 400 ×1')
  assert.equal(failureBrief(undefined), '')
})

test('重置时间：次日 00:00 读作「今天 24:00」，一周内读周几，倒计时取整到分钟', () => {
  const now = SH('2026-10-02T07:52:00')
  assert.equal(resetPhrase('2026-10-02T16:00:00.000Z', now), '今天 24:00 重置 · 16h 8m 后')
  assert.equal(resetPhrase('2026-10-04T16:00:00.000Z', now), '周一 00:00 重置 · 2d 16h 后')
  assert.equal(resetPhrase('2026-10-20T16:00:00.000Z', now), '10/21 00:00 重置 · 18d 16h 后')
  assert.equal(resetPhrase(null, now), '不自动重置')
  assert.equal(fmtLeft(59_000), '<1m')
  assert.equal(fmtLeft(61 * 60_000), '1h 1m')
})

test('配速：按窗口起点以来的平均速度推算用尽时刻；不限额、已超、历史不足、撑得过重置都不报', () => {
  const now = SH('2026-10-02T12:00:00')
  const dayStart = SH('2026-10-02T00:00:00')
  const reset = '2026-10-02T16:00:00.000Z'
  // 12h 花了 $40，限额 $50：每小时 $3.33 → 再 3h 用尽
  assert.equal(exhaustAt({ limitUsd: 50, spentUsd: 40, resetsAt: reset }, dayStart, now), now + 3 * 3_600_000)
  assert.equal(exhaustAt({ limitUsd: 50, spentUsd: 10, resetsAt: reset }, dayStart, now), null, '按速度撑得过 24:00')
  assert.equal(exhaustAt({ limitUsd: null, spentUsd: 40, resetsAt: reset }, dayStart, now), null)
  assert.equal(exhaustAt({ limitUsd: 50, spentUsd: 50, resetsAt: reset, exceeded: true }, dayStart, now), null)
  assert.equal(exhaustAt({ limitUsd: 50, spentUsd: 40, resetsAt: reset }, now - 10 * 60_000, now), null, '不足 30 分钟的样本不推算')
  assert.equal(windowStart({ limitUsd: 50, spentUsd: 0, ratio: 0, resetsAt: reset, exceeded: false }, 'daily'), Date.parse(reset) - 86_400_000)
  assert.equal(windowStart({ limitUsd: 50, spentUsd: 0, ratio: 0, resetsAt: reset, exceeded: false, startsAt: '2026-10-02T01:00:00.000Z' }, 'daily'), Date.parse('2026-10-02T01:00:00.000Z'), '手动重置后的起点优先')

  const quota = {
    timeZone: 'Asia/Shanghai',
    daily: { limitUsd: 50, spentUsd: 40, ratio: 0.8, resetsAt: reset, exceeded: false, startsAt: new Date(dayStart).toISOString() },
    weekly: { limitUsd: null, spentUsd: 300, ratio: null, resetsAt: '2026-10-04T16:00:00.000Z', exceeded: false },
    total: { limitUsd: 1000, spentUsd: 900, ratio: 0.9, resetsAt: null, exceeded: false },
  }
  const rows = quotaRows(quota, now, 50 / 86_400_000)
  assert.deepEqual(rows.map((r) => [r.label, r.unlimited, r.pace]), [
    ['日', false, '按今天的速度，今天 15:00 前会用尽'],
    ['周', true, null],
    ['累计', false, '按近 7 天的速度，周日 12:00 前后用尽'],
  ])
  assert.equal(rows[2].reset, '不自动重置')

  // 本周按速度今天 23:00 用尽，但日额度剩 $5 < 周剩 $50：今天会先被日额度停住，不报周配速；日已超同理
  const weekStart = SH('2026-09-28T00:00:00')
  const tight = {
    timeZone: 'Asia/Shanghai',
    daily: { limitUsd: 50, spentUsd: 45, ratio: 0.9, resetsAt: reset, exceeded: false, startsAt: new Date(dayStart).toISOString() },
    weekly: { limitUsd: 600, spentUsd: 550, ratio: 0.92, resetsAt: '2026-10-04T16:00:00.000Z', exceeded: false, startsAt: new Date(weekStart).toISOString() },
    total: { limitUsd: null, spentUsd: 550, ratio: null, resetsAt: null, exceeded: false },
  }
  assert.equal(quotaRows(tight, now, null)[1].pace, null)
  assert.equal(quotaRows({ ...tight, daily: { ...tight.daily, spentUsd: 50.06, exceeded: true } }, now, null)[1].pace, null)
  assert.match(quotaRows({ ...tight, daily: { ...tight.daily, limitUsd: null } }, now, null)[1].pace ?? '', /^按本周的速度，今天 /)
  assert.equal(projectToday(10, 0.5), null, '不足 1 小时不外推')
  assert.equal(projectToday(12, 12), 24)
  assert.equal(projectToday(null, 12), null)
})

test('模型：按 id 归到厂商；价格每百万 token，未知是 —、真 0 是免费；上下文按二进制/十进制取整', () => {
  assert.equal(vendorOf('claude-sonnet-4-5').id, 'anthropic')
  assert.equal(vendorOf('o4-mini-deep-research').id, 'openai')
  assert.equal(vendorOf('gpt-6-sol').id, 'openai')
  assert.equal(vendorOf('google/gemma-4-26b-a4b-it:free').id, 'google')
  assert.equal(vendorOf('qcn-glm-5.3').id, 'zhipu', '分发前缀跳过一次')
  assert.equal(vendorOf('cline-deepseek-v4.1-flash').id, 'deepseek')
  assert.equal(vendorOf('qcn-qwen3.8-flash').id, 'qwen')
  assert.equal(vendorOf('deepseek-v4.1-flash').id, 'deepseek')
  assert.equal(vendorOf('nemotron-3.5-lightning:free').id, 'nvidia')
  assert.equal(vendorOf('space-bunny-alpha').id, 'other')
  assert.equal(fmtPerM(3), '$3.00')
  assert.equal(fmtPerM(15), '$15')
  assert.equal(fmtPerM(0.3), '$0.30')
  assert.equal(fmtPerM(0.075), '$0.075')
  assert.equal(fmtPerM(0), '免费')
  assert.equal(fmtPerM(null), '—')
  assert.equal(fmtCtx(131_072), '128K')
  assert.equal(fmtCtx(1_048_576), '1M')
  assert.equal(fmtCtx(200_000), '200K')
  assert.equal(fmtCtx(2_000_000), '2M')
  assert.equal(fmtCtx(null), '—')
  assert.equal(priceText({ pricing: null }), '—')
  assert.equal(priceText({ pricing: { inputPerM: 3, outputPerM: 15, cacheReadPerM: 0.3, cacheWritePerM: 3.75, source: null } }), '$3.00 / $15')
  assert.equal(usedText({ requests: 0, tokens: 0 }), '—')
  assert.equal(usedText({ requests: 1284, tokens: 41_200_000 }), '1,284 次 · 41.2M tok')
})

/* ── review-auth-isolation ── */

const model = (id: string, extra: Partial<MeModel> = {}): MeModel => ({
  id, name: null, family: null, contextWindow: null, maxOutput: null, reasoning: null,
  pricing: { inputPerM: 1, outputPerM: 2, cacheReadPerM: null, cacheWritePerM: null, source: null }, used7d: { requests: 0, tokens: 0 }, ...extra,
})

test('AI-05 可用模型数：网关读不到 = 未知（null），不是 0；真空列表与额度停用是 0', () => {
  assert.equal(callableCount({ models: [], reason: 'gateway_unavailable' }), null)
  assert.equal(callableCount(undefined), null)
  assert.equal(callableCount({ models: [], reason: 'key_blocked' }), 0)
  assert.equal(callableCount({ models: [], reason: null }), 0)
  assert.equal(callableCount({ models: [model('gpt-5.5')], reason: null }), 1)
  // /me/models 的筛选角标：未知时全部 null（不显示角标），不是四个 0
  assert.deepEqual(modelFilterCounts({ models: [], reason: 'gateway_unavailable' }), { all: null, used: null, priced: null, reasoning: null })
  assert.deepEqual(modelFilterCounts(undefined), { all: null, used: null, priced: null, reasoning: null })
  assert.deepEqual(modelFilterCounts({ models: [], reason: 'key_blocked' }), { all: 0, used: 0, priced: 0, reasoning: 0 })
  assert.deepEqual(modelFilterCounts({ models: [model('gpt-5.5', { used7d: { requests: 2, tokens: 10 }, reasoning: true }), model('o9', { pricing: null })], reason: null }), { all: 2, used: 1, priced: 1, reasoning: 1 })
})

test('AI-12 接入示例只用这把 Key 能调的模型：同族没有就是 null（页面省略该客户端），不编 gpt-5 / claude-sonnet-4-5', () => {
  const claudeOnly = [model('claude-opus-5'), model('claude-sonnet-5', { used7d: { requests: 3, tokens: 900 } })]
  assert.equal(pickExample(claudeOnly, /^(gpt|o\d)/i, /^gpt-\d/i), null)
  assert.deepEqual(pickExample(claudeOnly, /^claude/i, /^claude-[a-z]+-\d/i), { id: 'claude-sonnet-5', used: true }, '用过的优先')
  const unused = [model('gpt-5.4'), model('gpt-5.5'), model('gpt-5.5:free'), model('gpt-5.5-image')]
  assert.deepEqual(pickExample(unused, /^(gpt|o\d)/i, /^gpt-\d/i), { id: 'gpt-5.5', used: false }, '没用过：最新的普通款')
  assert.equal(pickExample([], /^claude/i, /^claude-[a-z]+-\d/i), null)
})

test('AI-13 某一天的 [起, 止)：按服务器日历（从 from 推出偏移），不写死 +08:00', () => {
  // 服务器在上海：窗口起点 = 本地 00:00 = 前一天 16:00Z
  const shanghai = { from: '2026-09-25T16:00:00.000Z', daily: [{ day: '2026-09-26' }] }
  assert.deepEqual(usageDayBounds('2026-10-01', shanghai as never), { start: Date.parse('2026-09-30T16:00:00.000Z'), end: Date.parse('2026-10-01T16:00:00.000Z') })
  // 服务器在纽约（-04:00）：同一天的起点是 04:00Z
  const newYork = { from: '2026-09-26T04:00:00.000Z', daily: [{ day: '2026-09-26' }] }
  assert.deepEqual(usageDayBounds('2026-10-01', newYork as never), { start: Date.parse('2026-10-01T04:00:00.000Z'), end: Date.parse('2026-10-02T04:00:00.000Z') })
  assert.equal(usageDayBounds('2026-10-01', { daily: [{ day: '2026-09-26' }] } as never), null, '旧服务没有 from：不猜')
  assert.equal(usageDayBounds('2026-10-01', undefined), null)
  // 夏令时那天（纽约 2026-03-08 是 23 小时）：服务器给的逐日 startsAt/endsAt 优先，不按固定偏移 + 24h 推
  const dst = {
    from: '2026-03-02T05:00:00.000Z',
    daily: [{ day: '2026-03-02' }, { day: '2026-03-08', startsAt: '2026-03-08T05:00:00.000Z', endsAt: '2026-03-09T04:00:00.000Z' }],
  }
  assert.deepEqual(usageDayBounds('2026-03-08', dst), { start: Date.parse('2026-03-08T05:00:00.000Z'), end: Date.parse('2026-03-09T04:00:00.000Z') })
})
