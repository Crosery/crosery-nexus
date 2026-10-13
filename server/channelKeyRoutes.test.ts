import './testDataDir.js'

import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import test from 'node:test'
import { startContractCpa } from './testing/contractFixture.js'
import { launchConsole, type ConsoleProcess } from './testing/consoleProcess.js'

/**
 * 一个渠道可以持有多把上游 Key（内核按 api-key-entries 轮询）。这里锁死三件事：
 * 加 Key 前必须真打一次上游（探测不过不落表）、对外只见打码值与 sha256 前 12 位引用、
 * 最后一 upstream Key 删不掉（没 Key 的渠道等于删渠道，那条路有单独的删除入口）。
 */

const keyRef = (key: string) => createHash('sha256').update(key).digest('hex').slice(0, 12)
const SECOND = 'sk-second-upstream-key-0001'

type KeyRow = { ref: string; masked: string }

const keysOf = async (app: ConsoleProcess, name: string) => {
  const reply = await app.send('GET', '/api/channels?fresh=1', { cookie: app.adminCookie })
  assert.equal(reply.status, 200, reply.text)
  const channel = (reply.body.channels as Array<{ name: string; keys: KeyRow[] }>).find(item => item.name === name)
  assert.ok(channel, `渠道 ${name} 不在列表里`)
  return channel.keys
}

const entriesOf = (cpa: Awaited<ReturnType<typeof startContractCpa>>) =>
  (cpa.compat.find(channel => channel.name === 'contract-relay')?.['api-key-entries'] ?? []) as Array<{ 'api-key': string }>

test('渠道上游 Key：探测通过才加、按引用删、最后一把删不掉', { timeout: 120_000 }, async () => {
  const cpa = await startContractCpa()
  /** 上游探测记录：加 Key 必须先打一次 /models，用的还得是这把新 Key */
  const probes: Array<{ url: string; authorization: string }> = []
  cpa.extra = (method, route, _url, raw) => {
    if (route === '/openai-compatibility' && method === 'PUT') {
      cpa.compat = JSON.parse(raw || '[]') as typeof cpa.compat
      return { status: 200, body: { status: 'ok' } }
    }
    if (route === '/api-call' && method === 'POST') {
      const body = JSON.parse(raw || '{}') as { url?: string; header?: Record<string, string> }
      const authorization = String(body.header?.Authorization ?? '')
      probes.push({ url: String(body.url ?? ''), authorization })
      if (authorization !== `Bearer ${SECOND}` && !authorization.endsWith('-relay')) {
        return { status: 200, body: { status_code: 401, body: { error: 'invalid api key' } } }
      }
      return { status: 200, body: { status_code: 200, body: { data: [{ id: 'probe-model' }] } } }
    }
    return undefined
  }
  const app = await launchConsole({ CPA_BASE_URL: cpa.base, CPA_MANAGEMENT_KEY: cpa.key })
  try {
    const post = (body: unknown) => app.send('POST', '/api/channels/contract-relay/keys', { cookie: app.adminCookie, body })
    const del = (ref: string) => app.send('DELETE', `/api/channels/contract-relay/keys/${ref}`, { cookie: app.adminCookie })

    // 列表只给打码值与引用，密文不出现在响应里
    const before = await keysOf(app, 'contract-relay')
    assert.deepEqual(before.map(row => row.masked), ['sk-plac••••••••relay'])
    assert.equal(before[0].ref, keyRef('sk-placeholder-relay'))
    assert.ok(!JSON.stringify(before).includes('sk-placeholder-relay'), '密文不能回流')

    // 加 Key：先探测（用新 Key 打上游），通过才写进内核表
    const added = await post({ apiKey: SECOND })
    assert.equal(added.status, 200, added.text)
    assert.deepEqual((added.body.keys as KeyRow[]).map(row => row.masked), ['sk-plac••••••••relay', 'sk-seco••••••••-0001'])
    assert.equal(probes.length, 1, '加 Key 只探测一次')
    assert.equal(probes[0].authorization, `Bearer ${SECOND}`)
    assert.deepEqual(entriesOf(cpa).map(entry => entry['api-key']), ['sk-placeholder-relay', SECOND])
    assert.deepEqual((await keysOf(app, 'contract-relay')).map(row => row.ref), [keyRef('sk-placeholder-relay'), keyRef(SECOND)])

    // 同一把 Key 重复添加：409，且不再探测（第二次探测会让计数变化）
    const again = await post({ apiKey: SECOND })
    assert.deepEqual([again.status, again.body.reason], [409, 'key_exists'])
    assert.equal(probes.length, 1, '重复 Key 在探测之前就被挡下')

    // 探测不过的 Key 不加：上游 401 → 502，内核表原样
    const rejected = await post({ apiKey: 'sk-unusable-upstream-key' })
    assert.equal(rejected.status, 502, rejected.text)
    assert.match(String(rejected.body.error), /模型扫描失败|HTTP 401/)
    assert.deepEqual(entriesOf(cpa).map(entry => entry['api-key']), ['sk-placeholder-relay', SECOND], '探测失败不落表')

    // 删：按引用定位，与下标无关（删掉第一把之后第二把的引用不变）
    const removed = await del(keyRef(SECOND))
    assert.equal(removed.status, 200, removed.text)
    assert.deepEqual(entriesOf(cpa).map(entry => entry['api-key']), ['sk-placeholder-relay'])
    assert.equal((await keysOf(app, 'contract-relay'))[0].ref, keyRef('sk-placeholder-relay'))

    // 删一把不存在的引用：404，表不动
    const missing = await del('f'.repeat(12))
    assert.deepEqual([missing.status, missing.body.reason], [404, 'key_not_found'])
    assert.equal(entriesOf(cpa).length, 1)

    // 最后一把删不掉：渠道没有 Key 时所有请求都会失败，那条路是删渠道
    const last = await del(keyRef('sk-placeholder-relay'))
    assert.deepEqual([last.status, last.body.reason], [409, 'last_key'])
    assert.equal(entriesOf(cpa).length, 1, '被拒的删除不落表')

    // 不存在的渠道：404
    const ghost = await app.send('POST', '/api/channels/ghost-relay/keys', { cookie: app.adminCookie, body: { apiKey: SECOND } })
    assert.deepEqual([ghost.status, ghost.body.reason], [404, 'channel_not_found'])
  } finally {
    await app.stop()
    await cpa.stop()
  }
})

test('原生端点下的渠道只能有一把上游 Key', { timeout: 120_000 }, async () => {
  const cpa = await startContractCpa()
  cpa.providerKeys['claude-api-key'] = [{ 'api-key': 'sk-claude-native', 'base-url': 'https://claude-relay.example.test', models: [{ name: 'claude-sonnet-4-5' }] }]
  cpa.extra = (method, route, _url, _raw) => {
    if (route === '/api-call' && method === 'POST') return { status: 200, body: { status_code: 200, body: { data: [{ id: 'probe-model' }] } } }
    if (route.startsWith('/claude-api-key') && method === 'PUT') return { status: 200, body: { status: 'ok' } }
    return undefined
  }
  const app = await launchConsole({ CPA_BASE_URL: cpa.base, CPA_MANAGEMENT_KEY: cpa.key })
  try {
    const listed = await keysOf(app, 'claude-relay')
    assert.deepEqual(listed.map(row => row.masked), ['sk-clau••••••••ative'], '原生端点的单把 Key 也要能看见')

    const added = await app.send('POST', '/api/channels/claude-relay/keys', { cookie: app.adminCookie, body: { apiKey: 'sk-extra-claude' } })
    assert.deepEqual([added.status, added.body.reason], [409, 'keys_unsupported'])
    assert.equal(cpa.providerKeys['claude-api-key'].length, 1, '结构上放不下第二把，一个都不加')

    const removed = await app.send('DELETE', '/api/channels/claude-relay/keys/' + keyRef('sk-claude-native'), { cookie: app.adminCookie })
    assert.deepEqual([removed.status, removed.body.reason], [409, 'keys_unsupported'])
  } finally {
    await app.stop()
    await cpa.stop()
  }
})
