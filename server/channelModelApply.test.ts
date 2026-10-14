import './testDataDir.js'

import assert from 'node:assert/strict'
import test from 'node:test'
import { startContractCpa } from './testing/contractFixture.js'
import { launchConsole } from './testing/consoleProcess.js'

/**
 * 渠道抽屉「拉取模型」第二步：勾选结果一次写进兼容渠道。锁死四件事：
 * 一次 PUT 完成增/停/恢复/摘；「不接入」与「停用」写墓碑（自动同步不会加回）；摘掉的不写墓碑；
 * 渠道的「自动同步」开关落库并随渠道列表返回。
 */
test('拉取模型的勾选结果一次写入；自动同步开关随渠道列表返回', { timeout: 120_000 }, async () => {
  const cpa = await startContractCpa()
  const base = cpa.extra
  let puts = 0
  cpa.extra = (method, route, url, raw) => {
    if (route === '/openai-compatibility' && method === 'PUT') {
      puts += 1
      cpa.compat = JSON.parse(raw || '[]') as typeof cpa.compat
      return { status: 200, body: { status: 'ok' } }
    }
    return base?.(method, route, url, raw)
  }
  const app = await launchConsole({ CPA_BASE_URL: cpa.base, CPA_MANAGEMENT_KEY: cpa.key })
  try {
    const apply = (body: unknown) => app.send('POST', '/api/channels/contract-relay/models/apply', { cookie: app.adminCookie, body })
    const relay = async () => {
      const reply = await app.send('GET', '/api/channels?fresh=1', { cookie: app.adminCookie })
      assert.equal(reply.status, 200, reply.text)
      return (reply.body.channels as Array<{ name: string; autoSync: boolean; models: Array<{ id: string; enabled: boolean }> }>).find(item => item.name === 'contract-relay')!
    }
    const liveNames = () => ((cpa.compat.find(channel => channel.name === 'contract-relay')?.models ?? []) as Array<{ name?: string }>).map(model => String(model.name))

    assert.equal((await relay()).autoSync, false, '默认不参与定时同步')
    const toggled = await app.send('PATCH', '/api/channels/contract-relay/auto-sync', { cookie: app.adminCookie, body: { enabled: true } })
    assert.equal(toggled.status, 200, toggled.text)
    assert.equal((await relay()).autoSync, true)
    assert.equal((await app.send('PATCH', '/api/channels/contract-relay/auto-sync', { cookie: app.adminCookie, body: { enabled: 'yes' } })).status, 400)

    const first = await apply({
      add: [{ id: 'fresh-model', enabled: true }, { id: 'paid-model', enabled: false }],
      disable: ['gpt-5.1'],
      remove: ['contract-model'],
    })
    assert.equal(first.status, 200, first.text)
    assert.deepEqual({ added: first.body.added, declined: first.body.declined, disabled: first.body.disabled, removed: first.body.removed }, { added: 1, declined: 1, disabled: 1, removed: 1 })
    assert.equal(puts, 1, '一次勾选只整表写一次')
    assert.deepEqual(liveNames(), ['fresh-model'])
    const after = (await relay()).models
    assert.deepEqual(after.map(model => `${model.id}:${model.enabled}`).sort(), ['fresh-model:true', 'gpt-5.1:false', 'paid-model:false'], '摘掉的 contract-model 不留墓碑')

    const restored = await apply({ enable: ['gpt-5.1', 'paid-model'] })
    assert.equal(restored.status, 200, restored.text)
    assert.equal(restored.body.enabled, 2)
    assert.deepEqual(liveNames().sort(), ['fresh-model', 'gpt-5.1', 'paid-model'])

    const empty = await apply({})
    assert.equal(empty.status, 400)
    assert.equal(empty.body.reason, 'no_changes')
    const missing = await app.send('POST', '/api/channels/nope/models/apply', { cookie: app.adminCookie, body: { remove: ['x'] } })
    assert.equal(missing.status, 404)
  } finally {
    await app.stop()
    await cpa.stop()
  }
})
