import './testDataDir.js'

import assert from 'node:assert/strict'
import test, { beforeEach } from 'node:test'
import { extractUsageDiagnostics } from './usageDetails.js'
import { clientLabel as uiClientLabel } from '../src/clientLabels.js'
import { addBufferedClient, addClient, broadcast, clientCount, heartbeat, resetClients, toLiveEvent, type RawUsageInput } from './liveStream.js'

const raw = (partial: Partial<RawUsageInput> & { model: string }): RawUsageInput => ({
  requestId: 'r1',
  timestamp: '2026-08-10T12:00:00Z',
  endpoint: 'POST /v1/messages',
  keyName: '示例用户',
  source: 'crosery',
  success: true,
  latencyMs: 100,
  inputTokens: 0,
  outputTokens: 0,
  cachedTokens: 0,
  ...partial,
})

/** 最小 Response 替身：只需要 write，并可模拟写失败。 */
const fakeRes = (opts: { fail?: boolean } = {}) => {
  const frames: string[] = []
  return {
    frames,
    res: {
      write(chunk: string) {
        if (opts.fail) throw new Error('socket closed')
        frames.push(chunk)
        return true
      },
    } as never,
  }
}

beforeEach(() => resetClients())

test('实时事件保留 Agent 身份和原始输入输出 token', () => {
  const event = toLiveEvent(raw({
    model: 'claude-opus-5',
    provider: 'claude',
    clientType: 'claude-code',
    userAgent: 'claude-cli/2.1.250 (external, cli)',
    inputTokens: 12,
    cachedTokens: 100,
    outputTokens: 7,
    cacheWriteTokens: 30,
    reasoningTokens: 4,
    totalTokens: 149,
  }))
  assert.equal(event.provider, 'claude')
  assert.equal(event.clientType, 'claude-code')
  assert.equal(event.userAgent, 'claude-cli/2.1.250 (external, cli)')
  assert.equal(event.inputTokens, 12)
  assert.equal(event.outputTokens, 7)
  assert.equal(event.reasoningTokens, 4)
  assert.equal(event.totalTokens, 149)
})

test('anthropic 请求的单次命中率与成本', () => {
  // input 与 cached 并列：新输入 2，命中 379992
  const event = toLiveEvent(raw({ model: 'claude-opus-5', inputTokens: 2, cachedTokens: 379_992, outputTokens: 100 }))
  assert.equal(event.freshInputTokens, 2)
  assert.equal(event.cacheReadTokens, 379_992)
  assert.ok(event.hitRate! > 0.9999)
  // 2*5/1e6 + 379992*0.5/1e6 + 100*25/1e6
  assert.ok(Math.abs(event.costUsd! - 0.192506) < 1e-6)
})

test('openai 请求的 cached 内含于 input，不重复计费', () => {
  // 20 万输入低于 272K 长上下文阈值，走基础价（夹具时间 2026-08-10）
  const event = toLiveEvent(raw({ model: 'gpt-5.6-sol', inputTokens: 200_000, cachedTokens: 180_000 }))
  assert.equal(event.freshInputTokens, 20_000)
  assert.equal(event.promptTokens, 200_000)
  assert.equal(event.hitRate, 0.9)
  // 只有 2 万按 input 全价：20000*5/1e6 + 180000*0.5/1e6
  assert.equal(event.costUsd, 0.19)
})

test('未定价模型成本为 null 而不是 0', () => {
  const event = toLiveEvent(raw({ model: 'totally-unknown', inputTokens: 1000 }))
  assert.equal(event.costUsd, null)
  assert.equal(event.hitRate, 0)
})

test('空提示不产生除零', () => {
  const event = toLiveEvent(raw({ model: 'claude-opus-5' }))
  assert.equal(event.hitRate, null)
  assert.equal(event.promptTokens, 0)
})

test('超缓存写入上限的请求被标记', () => {
  const event = toLiveEvent(raw({ model: 'claude-opus-5', inputTokens: 737_583, cachedTokens: 1_902 }))
  assert.equal(event.overCeiling, true)
})

test('广播以 SSE 帧格式发给所有客户端', () => {
  const a = fakeRes()
  const b = fakeRes()
  addClient(a.res)
  addClient(b.res)
  assert.equal(clientCount(), 2)

  const delivered = broadcast([toLiveEvent(raw({ model: 'claude-opus-5', inputTokens: 2, cachedTokens: 100 }))])

  assert.equal(delivered, 2)
  assert.match(a.frames[0], /^event: usage\ndata: \[/)
  assert.match(a.frames[0], /\n\n$/)
  const payload = JSON.parse(a.frames[0].replace(/^event: usage\ndata: /, '').trim())
  assert.equal(payload[0].model, 'claude-opus-5')
  assert.equal(b.frames.length, 1)
})

test('失败请求不进入缓存命中率实时流', () => {
  const client = fakeRes()
  addClient(client.res)

  const delivered = broadcast([
    toLiveEvent(raw({ requestId: 'failed', success: false, model: 'claude-opus-5', inputTokens: 10, cachedTokens: 90 })),
    toLiveEvent(raw({ requestId: 'success', success: true, model: 'claude-opus-5', inputTokens: 10, cachedTokens: 90 })),
  ])

  assert.equal(delivered, 1)
  const payload = JSON.parse(client.frames[0].replace(/^event: usage\ndata: /, '').trim())
  assert.deepEqual(payload.map((item: { requestId: string }) => item.requestId), ['success'])
})

test('写失败的客户端被摘除，不影响其余客户端', () => {
  const good = fakeRes()
  const bad = fakeRes({ fail: true })
  addClient(bad.res)
  addClient(good.res)

  const delivered = broadcast([toLiveEvent(raw({ model: 'claude-opus-5', inputTokens: 1 }))])

  assert.equal(delivered, 1, '只有健康客户端收到')
  assert.equal(clientCount(), 1, '失败客户端已摘除')
})

test('取消订阅后不再收到广播', () => {
  const a = fakeRes()
  const unsubscribe = addClient(a.res)!
  unsubscribe!()
  assert.equal(clientCount(), 0)
  assert.equal(broadcast([toLiveEvent(raw({ model: 'claude-opus-5', inputTokens: 1 }))]), 0)
})

test('异步历史查询期间先缓冲广播并按 requestId 去重衔接', () => {
  const target = fakeRes()
  const client = addBufferedClient(target.res, 'gpt-5.6-sol')!
  const duplicate = toLiveEvent(raw({ requestId: 'duplicate', model: 'gpt-5.6-sol', inputTokens: 1 }))
  const gapEvent = toLiveEvent(raw({ requestId: 'during-history', model: 'gpt-5.6-sol', inputTokens: 2 }))

  assert.equal(broadcast([duplicate, gapEvent]), 1)
  assert.equal(target.frames.length, 0, 'history 完成前不能让 usage 帧抢在 history 前面')

  const replay = client.activate([duplicate])
  assert.deepEqual(replay.map((event) => event.requestId), ['duplicate', 'during-history'])

  broadcast([toLiveEvent(raw({ requestId: 'after-history', model: 'gpt-5.6-sol', inputTokens: 3 }))])
  assert.equal(target.frames.length, 1)
  assert.match(target.frames[0], /after-history/)
  client.remove()
})

test('无客户端或空事件时广播是空操作', () => {
  assert.equal(broadcast([]), 0)
  const a = fakeRes()
  addClient(a.res)
  assert.equal(broadcast([]), 0)
  assert.equal(a.frames.length, 0)
})

test('心跳发送注释帧并清理死连接', () => {
  const good = fakeRes()
  const bad = fakeRes({ fail: true })
  addClient(good.res)
  addClient(bad.res)

  heartbeat()

  assert.equal(good.frames[0], ': ping\n\n')
  assert.equal(clientCount(), 1)
})

test('按模型筛选的客户端只收到该模型的事件', () => {
  const all = fakeRes()
  const onlyOpus = fakeRes()
  addClient(all.res)              // 无筛选
  addClient(onlyOpus.res, 'claude-opus-5')

  const delivered = broadcast([
    toLiveEvent(raw({ model: 'claude-opus-5', inputTokens: 1, cachedTokens: 100 })),
    toLiveEvent(raw({ model: 'gpt-5.6-sol', inputTokens: 1, cachedTokens: 100 })),
  ])

  assert.equal(delivered, 2)
  const allPayload = JSON.parse(all.frames[0].replace(/^event: usage\ndata: /, '').trim())
  assert.equal(allPayload.length, 2, '无筛选客户端收到全部')

  const opusPayload = JSON.parse(onlyOpus.frames[0].replace(/^event: usage\ndata: /, '').trim())
  assert.equal(opusPayload.length, 1, '筛选客户端只收到匹配的')
  assert.equal(opusPayload[0].model, 'claude-opus-5')
})

test('筛选客户端在无匹配事件时完全不收帧', () => {
  const onlyOpus = fakeRes()
  addClient(onlyOpus.res, 'claude-opus-5')

  const delivered = broadcast([toLiveEvent(raw({ model: 'gpt-5.6-sol', inputTokens: 1 }))])

  assert.equal(delivered, 0)
  assert.equal(onlyOpus.frames.length, 0, '不应收到空数组帧')
})

test('不同客户端可以各自筛选不同模型', () => {
  const a = fakeRes()
  const b = fakeRes()
  addClient(a.res, 'claude-opus-5')
  addClient(b.res, 'gpt-5.6-sol')

  broadcast([
    toLiveEvent(raw({ model: 'claude-opus-5', inputTokens: 1, cachedTokens: 9 })),
    toLiveEvent(raw({ model: 'gpt-5.6-sol', inputTokens: 1, cachedTokens: 9 })),
  ])

  assert.equal(JSON.parse(a.frames[0].replace(/^event: usage\ndata: /, '').trim())[0].model, 'claude-opus-5')
  assert.equal(JSON.parse(b.frames[0].replace(/^event: usage\ndata: /, '').trim())[0].model, 'gpt-5.6-sol')
})

test('实时事件携带 keyHash，按 Key 与渠道筛选的客户端只收到匹配事件', () => {
  const byKey = fakeRes()
  const byProvider = fakeRes()
  const both = fakeRes()
  addClient(byKey.res, '', '', 'key-a')
  addClient(byProvider.res, '', '', '', 'openai-compatible-mox-aigw')
  addClient(both.res, '', '', 'key-a', 'claude')

  const delivered = broadcast([
    toLiveEvent(raw({ requestId: 'a-claude', model: 'claude-opus-5', provider: 'claude', keyHash: 'key-a', inputTokens: 1, cachedTokens: 9 })),
    toLiveEvent(raw({ requestId: 'b-mox', model: 'gpt-5.6-sol', provider: 'mox-aigw', keyHash: 'key-b', inputTokens: 1, cachedTokens: 9 })),
    toLiveEvent(raw({ requestId: 'a-mox', model: 'gpt-5.6-sol', provider: 'mox-aigw', keyHash: 'key-a', inputTokens: 1, cachedTokens: 9 })),
  ])

  assert.equal(delivered, 3)
  const ids = (frames: string[]) => JSON.parse(frames[0].replace(/^event: usage\ndata: /, '').trim()).map((item: { requestId: string }) => item.requestId)
  assert.deepEqual(ids(byKey.frames), ['a-claude', 'a-mox'])
  // 渠道筛选对 openai-compatible- 前缀不敏感
  assert.deepEqual(ids(byProvider.frames), ['b-mox', 'a-mox'])
  assert.deepEqual(ids(both.frames), ['a-claude'])
  const event = JSON.parse(byKey.frames[0].replace(/^event: usage\ndata: /, '').trim())[0]
  assert.equal(event.keyHash, 'key-a')
  assert.equal(toLiveEvent(raw({ model: 'claude-opus-5' })).keyHash, null)
})

test('缓冲客户端同样按 Key 筛选', () => {
  const target = fakeRes()
  const client = addBufferedClient(target.res, '', '', 'key-a')!
  broadcast([
    toLiveEvent(raw({ requestId: 'mine', model: 'claude-opus-5', keyHash: 'key-a', inputTokens: 1 })),
    toLiveEvent(raw({ requestId: 'theirs', model: 'claude-opus-5', keyHash: 'key-b', inputTokens: 1 })),
  ])
  assert.deepEqual(client.activate([]).map((event) => event.requestId), ['mine'])
  client.remove()
})


test('OMP ingestion reaches filtered SSE with its own UI label and never includes Pi', () => {
  const target = fakeRes()
  const pi = fakeRes()
  addClient(target.res, '', 'omp')
  addClient(pi.res, '', 'pi')
  broadcast(['omp/18.1.14', 'omp/18.1.15', 'pi (darwin 24.6.0; arm64)'].map((userAgent) => {
    const diagnostics = extractUsageDiagnostics({ provider: 'codex', user_agent: userAgent })
    return toLiveEvent(raw({ model: 'gpt-5.6-sol', requestId: userAgent, ...diagnostics }))
  }))
  const payload = (frames: string[]) => JSON.parse(frames[0].replace(/^event: usage\ndata: /, '').trim())
  assert.deepEqual(payload(target.frames).map((event: { requestId: string }) => event.requestId), ['omp/18.1.14', 'omp/18.1.15'])
  assert.deepEqual(payload(pi.frames).map((event: { requestId: string }) => event.requestId), ['pi (darwin 24.6.0; arm64)'])
  assert.equal(uiClientLabel(payload(target.frames)[0].clientType), 'OMP')
  assert.equal(uiClientLabel(payload(pi.frames)[0].clientType), 'Pi')
})

test('已移除渠道的新事件：默认订阅（全部渠道，与首帧回放同口径）照收并带 removed，只看当前渠道的订阅不收', () => {
  const all = fakeRes()
  const current = fakeRes()
  addClient(all.res)
  const buffered = addBufferedClient(current.res, '', '', '', '', true)!
  broadcast([
    { removed: true, ...toLiveEvent(raw({ requestId: 'retired', model: 'gpt-5.6-sol', provider: 'retired', inputTokens: 1, cachedTokens: 9 })) },
    { removed: false, ...toLiveEvent(raw({ requestId: 'live', model: 'gpt-5.6-sol', provider: 'codex', inputTokens: 1, cachedTokens: 9 })) },
  ])
  const events = JSON.parse(all.frames[0].replace(/^event: usage\ndata: /, '').trim()) as Array<{ requestId: string; removed: boolean }>
  assert.deepEqual(events.map((event) => [event.requestId, event.removed]), [['retired', true], ['live', false]])
  assert.deepEqual(buffered.activate([]).map((event) => event.requestId), ['live'])
  broadcast([{ removed: true, ...toLiveEvent(raw({ requestId: 'retired-2', model: 'gpt-5.6-sol', provider: 'retired', inputTokens: 1 })) }])
  assert.equal(current.frames.length, 0, 'a currentOnly subscriber gets no frame for removed-channel traffic')
  buffered.remove()
})
