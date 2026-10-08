import './testDataDir.js'

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { testDataDir } from './testDataDir.js'
import {
  applyProbeRound, classifyProbe, parseAvailabilityFile, readAvailabilityFile, runModelAvailabilityRound, withModelAvailability, writeAvailabilityFile,
  type AvailabilityFile, type ModelAvailabilityDeps, type ProbeResponse, type ProbeVerdict, type ServiceRound,
} from './modelAvailability.js'
import type { ConsoleGroup } from './groups.js'

const http = (status: number, body: unknown): ProbeResponse => ({ kind: 'http', status, body: typeof body === 'string' ? body : JSON.stringify(body) })
const reply = { choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'length' }] }
const OK: ProbeVerdict = { outcome: 'ok', reason: 'HTTP 200' }
const FAIL: ProbeVerdict = { outcome: 'countable', reason: 'HTTP 404: model_not_found' }
const NEUTRAL: ProbeVerdict = { outcome: 'neutral', reason: 'HTTP 429' }
const T0 = Date.parse('2026-10-09T00:00:00.000Z')
const round = (n: number) => T0 + n * 30 * 60_000

test('判定：只有 400/404/422/500/501 与「200 没有可用回复」计数', () => {
  assert.equal(classifyProbe(http(200, reply)).outcome, 'ok')
  assert.equal(classifyProbe(http(200, { choices: [] })).outcome, 'countable')
  assert.equal(classifyProbe(http(200, 'not json')).outcome, 'countable')
  for (const status of [400, 404, 422, 500, 501]) {
    assert.equal(classifyProbe(http(status, { error: { message: 'The model `retired-1` does not exist', code: 'model_not_found' } })).outcome, 'countable', `HTTP ${status}`)
  }
})

test('判定：限流/额度/余额、上游 401/403、账号冷却、超时与网络错误、502/503/504 都是中性', () => {
  for (const status of [401, 403, 429, 502, 503, 504]) assert.equal(classifyProbe(http(status, { error: { message: 'whatever' } })).outcome, 'neutral', `HTTP ${status}`)
  assert.equal(classifyProbe({ kind: 'timeout' }).outcome, 'neutral')
  assert.equal(classifyProbe({ kind: 'network', message: 'connect ECONNREFUSED 127.0.0.1:8317' }).outcome, 'neutral')
  const neutralBodies = [
    [400, { error: { message: 'Your credit balance is too low to access the API' } }],
    [400, { error: { message: 'insufficient_quota' } }],
    [500, { error: { message: 'You exceeded your current quota' } }],
    [500, { error: { code: 'auth_not_found', message: 'no auth available' } }],
    [404, { error: { message: 'All credentials for model gpt-x are cooling down' } }],
    [400, { error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model" } }],
    [400, { error: { message: 'Thinking budget must be smaller than maxOutputTokens' } }],
    [400, { error: { message: 'max_tokens must be greater than thinking.budget_tokens' } }],
    [200, { error: { message: 'Rate limit reached for requests' } }],
  ] as const
  for (const [status, body] of neutralBodies) assert.equal(classifyProbe(http(status, body)).outcome, 'neutral', JSON.stringify(body))
})

test('判定原因里的系统 Key 与凭据被打码', () => {
  const key = `sk-probe-${'c'.repeat(64)}`
  const verdict = classifyProbe(http(404, { error: { message: `model not found for key ${key}` } }))
  assert.equal(verdict.outcome, 'countable')
  assert.ok(!verdict.reason.includes('c'.repeat(16)))
})

const svc = (service: string, models: Array<[string, ProbeVerdict | null]>): ServiceRound =>
  ({ service, models: models.map(([model, verdict]) => ({ model, chat: verdict !== null, verdict: verdict ?? undefined })) })

function play(rounds: Array<ServiceRound[]>, start: AvailabilityFile | null = null) {
  let file = start
  const applied = rounds.map((probed, index) => {
    const result = applyProbeRound(file, { probed, kept: [] }, round(index))
    file = result.file
    return result
  })
  return { file: file!, applied }
}

test('连续 3 次可计数失败才下线；中性结果不计数也不清零；一次成功立即上线', () => {
  const healthy: Array<[string, ProbeVerdict]> = [['keeper', OK]]
  const { file, applied } = play([
    [svc('codex', [...healthy, ['retired', FAIL]])],
    [svc('codex', [...healthy, ['retired', FAIL]])],
    [svc('codex', [...healthy, ['retired', NEUTRAL]])],
    [svc('codex', [...healthy, ['retired', FAIL]])],
  ])
  assert.deepEqual(applied.map((item) => item.file.services.codex.retired.state), ['online', 'online', 'online', 'offline'])
  assert.deepEqual(applied.map((item) => item.file.services.codex.retired.failures), [1, 2, 2, 3])
  assert.deepEqual(applied.map((item) => item.transitions.length), [0, 0, 0, 1])
  assert.deepEqual(applied[3].transitions[0], { service: 'codex', model: 'retired', from: 'online', to: 'offline', reason: '连续 3 次失败：HTTP 404: model_not_found' })
  assert.equal(file.services.codex.retired.since, new Date(round(3)).toISOString())

  const back = applyProbeRound(file, { probed: [svc('codex', [...healthy, ['retired', OK]])], kept: [] }, round(4))
  assert.equal(back.file.services.codex.retired.state, 'online')
  assert.equal(back.file.services.codex.retired.failures, 0)
  assert.deepEqual(back.transitions.map((item) => [item.from, item.to]), [['offline', 'online']])
})

test('一次成功清零计数：失败、失败、成功、失败不会下线', () => {
  const { applied } = play([
    [svc('kimi', [['a', OK], ['b', FAIL]])],
    [svc('kimi', [['a', OK], ['b', FAIL]])],
    [svc('kimi', [['a', OK], ['b', OK]])],
    [svc('kimi', [['a', OK], ['b', FAIL]])],
  ])
  assert.deepEqual(applied.map((item) => item.file.services.kimi.b.failures), [1, 2, 0, 1])
  assert.ok(applied.every((item) => item.file.services.kimi.b.state === 'online'))
})

test('非对话模型记为 unprobed，不计数也不下线', () => {
  const { file } = play([[svc('codex', [['gpt-5.6-sol', OK], ['gpt-image-2', null]])]])
  assert.equal(file.services.codex['gpt-image-2'].state, 'unprobed')
  assert.equal(file.services.codex['gpt-image-2'].failures, 0)
})

test('一轮之内不允许把服务全部下线：本轮下线不生效、保留原状态、记告警（持续故障只首轮进审计）', () => {
  const allFail = [svc('antigravity', [['gemini-3-pro', FAIL], ['gemini-3-flash', FAIL], ['imagen-4', null]])]
  const { file, applied } = play([allFail, allFail, allFail, allFail])
  const third = applied[2]
  assert.deepEqual(third.transitions, [])
  assert.equal(third.alarms.length, 1)
  assert.deepEqual(third.alarms[0].models, ['gemini-3-pro', 'gemini-3-flash'])
  assert.equal(third.freshAlarms.length, 1)
  assert.equal(file.services.antigravity['gemini-3-pro'].state, 'online')
  assert.equal(file.services.antigravity['gemini-3-pro'].failures, 4, '失败计数照记，留作证据')
  assert.equal(applied[3].freshAlarms.length, 0, '连续第二轮告警不再重复审计')
  assert.equal(file.alarms.length, 2)
})

test('逐个下线到只剩最后一个时，最后一个也不能下线', () => {
  const start = applyProbeRound(null, { probed: [svc('mox', [['a', OK], ['b', OK]])], kept: [] }, round(0)).file
  start.services.mox.a = { ...start.services.mox.a, state: 'offline', failures: 3 }
  start.services.mox.b = { ...start.services.mox.b, failures: 2 }
  const result = applyProbeRound(start, { probed: [svc('mox', [['a', FAIL], ['b', FAIL]])], kept: [] }, round(1))
  assert.equal(result.file.services.mox.b.state, 'online')
  assert.equal(result.alarms.length, 1)
  assert.deepEqual(result.transitions, [])
})

test('部分下线照常生效；未探测的服务原样保留，目录里没有的服务与模型被移除', () => {
  const start = play([[svc('codex', [['a', OK], ['b', FAIL]]), svc('claude', [['opus', OK]]), svc('gone', [['x', OK]])]]).file
  start.services.codex.b.failures = 2
  const result = applyProbeRound(start, { probed: [svc('codex', [['a', OK], ['b', FAIL]])], kept: ['claude'] }, round(1))
  assert.equal(result.file.services.codex.b.state, 'offline')
  assert.deepEqual(result.file.services.claude, start.services.claude)
  assert.ok(!('gone' in result.file.services))
  const pruned = applyProbeRound(result.file, { probed: [svc('codex', [['a', OK]])], kept: [] }, round(2))
  assert.deepEqual(Object.keys(pruned.file.services.codex), ['a'])
})

test('状态文件：原子写入 0600；坏内容不认、坏条目丢掉', () => {
  const file = path.join(testDataDir, 'availability', 'model-availability.json')
  const data = play([[svc('codex', [['a', OK]])]]).file
  writeAvailabilityFile(data, file)
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['model-availability.json'], '不留临时文件')
  assert.deepEqual(readAvailabilityFile(file), data)
  assert.equal(parseAvailabilityFile({ version: 2, updatedAt: data.updatedAt, services: {} }), null)
  assert.equal(parseAvailabilityFile('garbage'), null)
  const mixed = parseAvailabilityFile({ ...data, services: { codex: { a: data.services.codex.a, b: { state: 'gone' } } } })
  assert.deepEqual(Object.keys(mixed!.services.codex), ['a'])
})

const group = (id: string, models: string[], available = true): ConsoleGroup => ({ id, name: id, color: '#000', kind: 'oauth', models, available })

test('分组跟随可用性：只去掉下线模型，未探测和未知模型照留', () => {
  const data = play([[svc('codex', [['a', OK], ['b', OK], ['img', null]])]]).file
  data.services.codex.b.state = 'offline'
  const groups = [group('codex', ['a', 'b', 'img', 'brand-new']), group('kimi', ['b'])]
  const filtered = withModelAvailability(groups, data)
  assert.deepEqual(filtered[0].models, ['a', 'img', 'brand-new'])
  assert.equal(filtered[1], groups[1], '同名模型在别的服务里不受影响')
  assert.equal(withModelAvailability(groups, null), groups)
})

/* ────────────────────────── 整轮 ────────────────────────── */

function harness(overrides: Partial<ModelAvailabilityDeps> & { responses?: (key: string, model: string) => ProbeResponse } = {}) {
  let stored: AvailabilityFile | null = null
  const writes: AvailabilityFile[] = []
  const audits: Array<[string, string, string]> = []
  const probes: Array<[string, string]> = []
  let active = 0
  let maxActive = 0
  let reconciles = 0
  let requests = 0
  const deps: ModelAvailabilityDeps = {
    listCatalog: async () => [group('codex', ['gpt-5.6-sol', 'gpt-image-2']), group('kimi', ['kimi-k3']), group('antigravity', ['gemini-3-pro'], false)],
    ensureProbeKeys: async (services) => Object.fromEntries(services.map((service) => [service, `probe-key-for-${service}`])),
    probe: async (key, model) => {
      probes.push([key, model])
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise((resolve) => setTimeout(resolve, 2))
      active -= 1
      return overrides.responses?.(key, model) ?? http(200, reply)
    },
    audit: (action, target, details) => { audits.push([action, target, details]) },
    onTransitions: async () => { reconciles += 1 },
    modelKind: (model) => (model.includes('image') ? 'image' : 'chat'),
    read: () => stored,
    write: (data) => { stored = data; writes.push(data) },
    sleep: async () => undefined,
    random: () => 0,
    ...overrides,
  }
  let tick = 0
  const context = { now: () => round(tick++), countRequests: (n = 1) => { requests += n } }
  return { deps, context, writes, audits, probes, state: () => ({ maxActive, reconciles, requests, stored }) }
}

test('整轮：只探测在线服务的对话模型，每个服务用自己的探测 Key，并发不超过 2', async () => {
  const h = harness()
  const outcome = await runModelAvailabilityRound(h.deps, h.context)
  assert.equal(outcome.result, 'ok')
  assert.deepEqual(h.probes.sort(), [['probe-key-for-codex', 'gpt-5.6-sol'], ['probe-key-for-kimi', 'kimi-k3']])
  assert.ok(h.state().maxActive <= 2)
  assert.equal(h.state().requests, 2)
  const stored = h.state().stored!
  assert.equal(stored.services.codex['gpt-image-2'].state, 'unprobed')
  assert.ok(!('antigravity' in stored.services), '账号归零的服务不探测')
  assert.match(outcome.summary ?? '', /2 服务 · 在线 2 · 未探测 1 · 1 服务暂不探测/)
  assert.deepEqual(h.audits, [], '首轮没有状态变化，不写审计')
  assert.equal(h.state().reconciles, 0)
})

test('整轮：目录暂时为空的服务原样保留，已下线的模型不会因此被忘掉', async () => {
  let empty = false
  const h = harness({
    listCatalog: async () => [group('codex', empty ? [] : ['gpt-5.6-sol', 'gpt-retired'])],
    responses: (_key, model) => (model === 'gpt-retired' ? http(404, { error: { message: 'model_not_found' } }) : http(200, reply)),
  })
  for (let index = 0; index < 3; index += 1) await runModelAvailabilityRound(h.deps, h.context)
  empty = true
  await runModelAvailabilityRound(h.deps, h.context)
  assert.equal(h.state().stored!.services.codex['gpt-retired'].state, 'offline')
})

test('整轮：模型再多同时在途也只有 2 个探测', async () => {
  const models = Array.from({ length: 9 }, (_, index) => `chat-${index}`)
  const h = harness({ listCatalog: async () => [group('mox', models)] })
  await runModelAvailabilityRound(h.deps, h.context)
  assert.equal(h.probes.length, 9)
  assert.equal(h.state().maxActive, 2)
})

test('整轮：下线与恢复写审计（服务、模型、前后状态、原因）并立即对账', async () => {
  let broken = true
  const h = harness({
    listCatalog: async () => [group('codex', ['gpt-5.6-sol', 'gpt-retired'])],
    responses: (_key, model) => (model === 'gpt-retired' && broken ? http(404, { error: { message: 'model_not_found' } }) : http(200, reply)),
  })
  for (let index = 0; index < 3; index += 1) await runModelAvailabilityRound(h.deps, h.context)
  assert.equal(h.state().stored!.services.codex['gpt-retired'].state, 'offline')
  assert.equal(h.audits.length, 1)
  const [action, target, details] = h.audits[0]
  assert.equal(action, 'model_availability')
  assert.equal(target, 'codex/gpt-retired')
  assert.deepEqual(JSON.parse(details), { from: 'online', to: 'offline', reason: '连续 3 次失败：HTTP 404: model_not_found' })
  assert.equal(h.state().reconciles, 1)

  broken = false
  const outcome = await runModelAvailabilityRound(h.deps, h.context)
  assert.match(outcome.summary ?? '', /本轮 \+1/)
  assert.deepEqual(JSON.parse(h.audits[1][2]).to, 'online')
  assert.equal(h.state().reconciles, 2)
})

test('整轮：单模型服务连续失败只告警不下线，结果为 partial，告警只审计一次', async () => {
  const h = harness({ responses: (_key, model) => (model === 'kimi-k3' ? http(400, { error: { message: 'model is not supported' } }) : http(200, reply)) })
  const outcomes = []
  for (let index = 0; index < 4; index += 1) outcomes.push(await runModelAvailabilityRound(h.deps, h.context))
  assert.deepEqual(outcomes.map((outcome) => outcome.result), ['ok', 'ok', 'partial', 'partial'])
  assert.match(outcomes[2].error ?? '', /^kimi：本轮将使全部 1 个对话模型下线/)
  assert.equal(h.state().stored!.services.kimi['kimi-k3'].state, 'online')
  assert.deepEqual(h.audits.map(([action, target]) => `${action}:${target}`), ['model_availability_alarm:kimi'])
  assert.equal(h.state().reconciles, 0)
})

test('整轮作废时状态文件不动：网关整轮不可达、读不到目录、注册不了探测 Key', async () => {
  const down = harness({ responses: () => ({ kind: 'network', message: 'connect ECONNREFUSED 127.0.0.1:8317' }) })
  const outcome = await runModelAvailabilityRound(down.deps, down.context)
  assert.equal(outcome.result, 'error')
  assert.match(outcome.error ?? '', /网关不可达/)
  assert.equal(down.writes.length, 0)

  const noCatalog = harness({ listCatalog: async () => { throw new Error('CPA 503: upstream unavailable') } })
  await assert.rejects(runModelAvailabilityRound(noCatalog.deps, noCatalog.context), /CPA 503/)
  assert.equal(noCatalog.writes.length, 0)

  const noKeys = harness({ ensureProbeKeys: async () => { throw new Error('CPA 500: write failed') } })
  await assert.rejects(runModelAvailabilityRound(noKeys.deps, noKeys.context), /CPA 500/)
  assert.equal(noKeys.writes.length, 0)
  assert.equal(noKeys.probes.length, 0)
})
