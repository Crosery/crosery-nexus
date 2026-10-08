import './testDataDir.js'

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { applyGatewayPricing, getModelPricing, getPriceHistory, priceRequest } from './pricing.js'
import { PriceWatcher, gatewayPriceRead, sharedPriceReads, type Rates, type SourceRead, type WatchSource } from './priceWatch.js'
import { testDataDir } from './testDataDir.js'

const HOUR = 3_600_000
const T0 = Date.parse('2026-10-09T00:00:00Z')
const at = (hours: number) => T0 + hours * HOUR
const iso = (ms: number) => new Date(ms).toISOString()

/** 价格表里只有网关价的模型（静态表没有）：每个测试用自己的 id，互不干扰。 */
const gatewayModel = (id: string, input: number, output: number, cacheRead: number) =>
  applyGatewayPricing(new Map([[id, { from: '1970-01-01', input, output, cacheRead }]]))

const ok = (prices: Record<string, Rates>, fetchedAt: number): SourceRead => ({ ok: true, fetchedAt, prices: new Map(Object.entries(prices)) })
const fail = (error: string): SourceRead => ({ ok: false, error })
const rates = (pricing: ReturnType<typeof getModelPricing>) => pricing && { input: pricing.input, output: pricing.output, cacheRead: pricing.cacheRead, cacheWrite: pricing.cacheWrite }

function watcher(name: string) {
  const dir = fs.mkdtempSync(path.join(testDataDir, `${name}-`))
  const files = { state: path.join(dir, 'pricing', 'price-watch.json'), log: path.join(dir, 'pricing', 'price-changes.jsonl') }
  const audits: string[][] = []
  const instance = new PriceWatcher(files)
  const run = (now: number, reads: Partial<Record<WatchSource, SourceRead>>) => instance.run({
    now,
    readOfficial: async () => reads.official ?? fail('fixture: official not read'),
    readShared: () => Object.fromEntries((['models.dev', 'openrouter'] as const).filter(source => reads[source]).map(source => [source, reads[source]!])),
    audit: (...entry) => { audits.push(entry) },
  })
  const log = () => (fs.existsSync(files.log) ? fs.readFileSync(files.log, 'utf8').trim().split('\n').map(line => JSON.parse(line) as Record<string, any>) : [])
  return { files, audits, run, log }
}

test('改价从观测时刻起生效：同一天更早的用量仍按旧价；按优先级只生效一次，记审计与改价记录', async () => {
  const id = 'watch-effective-model'
  gatewayModel(id, 4, 20, 0.4)
  const w = watcher('effective')
  const same = { input: 4, output: 20, cacheRead: 0.4 }
  await w.run(at(0), { official: ok({ [id]: same }, at(0)), 'models.dev': ok({ [id]: same }, at(0)) })
  const changed = { input: 5, output: 20, cacheRead: 0.4 }
  const outcome = await w.run(at(6), { official: ok({ [id]: changed }, at(6)), 'models.dev': ok({ [id]: changed }, at(6)) })
  assert.match(outcome.summary ?? '', /^改价生效 1 · /)

  assert.equal(getModelPricing(id, at(6) - 1)?.input, 4)
  assert.equal(getModelPricing(id, at(6))?.input, 5)
  assert.equal(getModelPricing(id, iso(at(7)))?.input, 5)
  assert.equal(getModelPricing(id, '2026-10-08')?.input, 4)
  assert.equal(priceRequest(id, { newInputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, at: iso(at(5)) }), 4)
  assert.equal(priceRequest(id, { newInputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, at: iso(at(6)) }), 5)
  assert.deepEqual(getPriceHistory(id).map(entry => [entry.from, entry.until, entry.input, entry.output, entry.cacheRead]), [
    ['1970-01-01', iso(at(6)), 4, 20, 0.4],
    [iso(at(6)), undefined, 5, 20, 0.4],
  ])

  assert.deepEqual(w.audits, [['price_change', id, `官方 · input 4→5 (+25%) · 生效 ${iso(at(6))}`]])
  const events = w.log()
  assert.equal(events.length, 1, 'models.dev 看到账单价已到位：只更新基线，不重复生效也不记 skipped')
  assert.deepEqual([events[0].type, events[0].source, events[0].components], ['applied', 'official', [{ component: 'input', before: 4, after: 5, changePct: 25 }]])
})

test('已入库的用量成本不随改价重算，改价后的新用量按新价入库', async () => {
  const { persistUsageRecords } = await import('./sync.js')
  const { db } = await import('./db.js')
  const id = 'watch-ledger-model'
  gatewayModel(id, 2, 8, 0.2)
  const w = watcher('ledger')
  const usage = (requestId: string, when: number) => ({ request_id: requestId, timestamp: iso(when), model: id, provider: 'fixture', tokens: { input_tokens: 1_000_000, output_tokens: 0 } })
  persistUsageRecords([usage('watch-ledger-1', at(1))], [])
  await w.run(at(2), { official: ok({ [id]: { input: 2, output: 8, cacheRead: 0.2 } }, at(2)) })
  await w.run(at(8), { official: ok({ [id]: { input: 2.5, output: 8, cacheRead: 0.2 } }, at(8)) })
  persistUsageRecords([usage('watch-ledger-2', at(9))], [])
  const cost = (requestId: string) => (db.prepare('SELECT cost_usd FROM usage_events WHERE request_id = ?').get(requestId) as { cost_usd: number }).cost_usd
  assert.equal(cost('watch-ledger-1'), 2)
  assert.equal(cost('watch-ledger-2'), 2.5)
})

test('超过 50% 的改价要连续两次读到同一组价才生效：一致 → 生效，不一致 → 从第二次重新等，≤50% → 立即生效', async () => {
  const id = 'watch-confirm-model'
  gatewayModel(id, 10, 40, 1)
  const w = watcher('confirm')
  const read = (hours: number, input: number, output = 40) => ({ official: ok({ [id]: { input, output, cacheRead: 1 } }, at(hours)) })
  await w.run(at(0), read(0, 10))

  const first = await w.run(at(6), read(6, 30))
  assert.match(first.summary ?? '', /待确认 1/)
  assert.equal(getModelPricing(id, at(7))?.input, 10, '第一次读到 +200%：只登记，不生效')
  await w.run(at(12), read(12, 25))
  assert.equal(getModelPricing(id, at(13))?.input, 10, '第二次读到不同的价：重新等')
  const confirmed = await w.run(at(18), read(18, 25))
  assert.doesNotMatch(confirmed.summary ?? '', /待确认/)
  assert.equal(getModelPricing(id, at(18) - 1)?.input, 10)
  assert.equal(getModelPricing(id, at(18))?.input, 25, '两次一致：从确认那次读取起生效')

  await w.run(at(24), read(24, 37.5))
  assert.equal(getModelPricing(id, at(24))?.input, 37.5, '正好 +50%：不需要等')
  await w.run(at(30), read(30, 37.5, 19))
  await w.run(at(36), read(36, 37.5, 40))
  assert.equal(getModelPricing(id, at(37))?.output, 40, '输出价 −52.5% 只出现一次就回到原价：作废')

  const events = w.log()
  assert.deepEqual(events.map(event => event.type), ['pending', 'pending', 'applied', 'applied', 'pending', 'discarded'])
  assert.deepEqual([events[0].restarted, events[1].restarted], [false, true])
  assert.equal(events[2].firstObservedAt, iso(at(12)), '两次观测都留痕')
  assert.equal(events[5].firstObservedAt, iso(at(30)))
  assert.match(w.audits[0][2], new RegExp(`input 10→25 \\(\\+150%\\) · 生效 ${iso(at(18))} · 首次观测 ${iso(at(12))}`))
  assert.equal(w.audits.length, 2)
})

test('价源失败或为空时价格不动；缺失的分项不当成降到 0；同一份共享快照不算新读取；12 小时没有新价格标为过期', async () => {
  const id = 'watch-failure-model'
  gatewayModel(id, 3, 15, 0.3)
  const w = watcher('failure')
  const official = (hours: number, prices: Rates = { input: 3, output: 15, cacheRead: 0.3 }) => ok({ [id]: prices }, at(hours))
  const shared = (fetchedAt: number, input: number) => sharedPriceReads({
    sources: { 'models.dev': { ok: true, fetchedAt }, openrouter: { ok: true, fetchedAt } },
    rows: [
      { id, source: 'models.dev', prices: { 'models.dev': { input, output: 15, cacheRead: 0.3, unit: 'usd-per-million-tokens' } } },
      { id: `vendor/${id}`, source: 'openrouter', prices: { openrouter: { input, output: 15, cacheRead: 0.3, unit: 'usd-per-million-tokens' } } },
      { id: 'per-image-model', source: 'openrouter', prices: { openrouter: { input: 1, output: 1, unit: 'usd-per-image' } } },
    ],
  })
  const healthy = await w.run(at(0), { official: official(0), ...shared(at(0), 3) })
  assert.deepEqual([healthy.result, healthy.summary, healthy.error], ['ok', '无改价生效 · 价格源 3/3', null])

  const down = await w.run(at(6), {
    official: fail('CPA 503'),
    ...sharedPriceReads({ rows: [], sources: { 'models.dev': { ok: true, fetchedAt: at(6) }, openrouter: { ok: false, error: 'HTTP 503' } } }),
  })
  assert.equal(down.result, 'error')
  assert.match(down.error ?? '', /官方 读取失败：CPA 503；models\.dev 读取失败：没有任何价格；OpenRouter 读取失败：上游失败：HTTP 503/)
  assert.equal(getModelPricing(id)?.input, 3)

  await w.run(at(7), { official: gatewayPriceRead(new Map([[id, { input: 0, output: 15, cacheRead: 0 }]]), [], at(7)), ...shared(at(0), 3) })
  assert.deepEqual(rates(getModelPricing(id)), { input: 3, output: 15, cacheRead: 0.3, cacheWrite: undefined }, '网关把缺失写成 0：不是降价')

  const stale = await w.run(at(13), { official: official(13), ...shared(at(0), 9) })
  assert.equal(getModelPricing(id)?.input, 3, '共享产物没刷新：同一份快照里的价不算新读数')
  assert.equal(stale.result, 'partial')
  assert.equal(stale.summary, '无改价生效 · 价格源 1/3')
  assert.match(stale.error ?? '', /models\.dev 超过 13 小时没有新价格（过期）；OpenRouter 超过 13 小时没有新价格（过期）/)
  assert.deepEqual(w.log(), [])

  const partialGateway = gatewayPriceRead(new Map([[id, { input: 3, output: 15, cacheRead: 0.3 }]]), ['gemini'], at(14))
  assert.deepEqual(partialGateway.ok && partialGateway.note, '缺 gemini')
  assert.deepEqual(gatewayPriceRead(new Map(), ['claude', 'codex'], at(14)), { ok: false, error: '网关价格来源全部失败：claude、codex' })
})

test('人工核定价不被来源改价覆盖：账单价与来源上次的价不同就只记 skipped', async () => {
  // 静态表里 deepseek-v4-flash 是转售渠道刊例价（0.15 / 0.6），与官方价本来就不同
  const id = 'deepseek-v4-flash'
  const billed = rates(getModelPricing(id, at(0)))
  const w = watcher('curated')
  await w.run(at(0), { official: ok({ [id]: { input: 0.14, output: 0.28 } }, at(0)) })
  await w.run(at(6), { official: ok({ [id]: { input: 0.2, output: 0.3 } }, at(6)) })
  assert.deepEqual(rates(getModelPricing(id, at(7))), billed)
  const [event, ...rest] = w.log()
  assert.equal(rest.length, 0)
  assert.equal(event.type, 'skipped')
  assert.deepEqual(event.components.map((item: { component: string }) => item.component), ['input', 'output'])
  assert.deepEqual(w.audits, [])
})

test('重启后重放：内存里生效的价段与按状态文件重建的一致；网关模型以第一次改价前的价为底；坏状态文件不覆盖', async () => {
  const id = 'watch-replay-model'
  gatewayModel(id, 1, 4, 0.1)
  const w = watcher('replay')
  await w.run(at(0), { official: ok({ [id]: { input: 1, output: 4, cacheRead: 0.1 } }, at(0)) })
  await w.run(at(6), { official: ok({ [id]: { input: 1.2, output: 4, cacheRead: 0.1 } }, at(6)) })
  const live = getPriceHistory(id)
  assert.equal(new PriceWatcher(w.files).restore(), 1)
  assert.deepEqual(getPriceHistory(id), live)

  // 网关快照存的是最新价：重启时它先以 1970 段装进来，重放必须把改价前那段恢复成旧价
  const gatewayOnly = 'watch-replay-gateway-only'
  gatewayModel(gatewayOnly, 1.2, 4, 0.1)
  const files = { state: path.join(path.dirname(w.files.state), 'restart.json'), log: w.files.log }
  fs.writeFileSync(files.state, JSON.stringify({
    version: 1, baselines: {}, pending: {}, sources: {},
    applied: { [gatewayOnly]: { base: { input: 1, output: 4, cacheRead: 0.1 }, changes: [{ at: iso(at(6)), changes: { input: 1.2 }, note: '官方 改价' }] } },
  }))
  assert.equal(new PriceWatcher(files).restore(), 1)
  assert.equal(getModelPricing(gatewayOnly, at(5))?.input, 1)
  assert.equal(getModelPricing(gatewayOnly, at(6))?.input, 1.2)

  fs.writeFileSync(files.state, '{broken')
  const broken = await new PriceWatcher(files).run({ now: at(12), readOfficial: async () => ok({}, at(12)), readShared: () => ({}) })
  assert.equal(broken.result, 'error')
  assert.match(broken.error ?? '', /状态文件损坏（restart\.json）/)
  assert.equal(fs.readFileSync(files.state, 'utf8'), '{broken')
})
