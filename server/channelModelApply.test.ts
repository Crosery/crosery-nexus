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

/** 账号池「拉取模型」弹窗没勾的新模型：一次读写 oauth-excluded-models，别的账号池的停用不受影响。 */
test('账号池批量停用新模型一次写 oauth-excluded-models', { timeout: 120_000 }, async () => {
  const cpa = await startContractCpa()
  const base = cpa.extra
  let excluded: Record<string, string[]> = { claude: ['claude-old'] }
  let puts = 0
  cpa.extra = (method, route, url, raw) => {
    if (route === '/oauth-excluded-models' && method === 'GET') return { status: 200, body: { 'oauth-excluded-models': excluded } }
    if (route === '/oauth-excluded-models' && method === 'PUT') {
      puts += 1
      excluded = JSON.parse(raw || '{}') as Record<string, string[]>
      return { status: 200, body: { status: 'ok' } }
    }
    return base?.(method, route, url, raw)
  }
  const app = await launchConsole({ CPA_BASE_URL: cpa.base, CPA_MANAGEMENT_KEY: cpa.key })
  try {
    const disable = (provider: string, body: unknown) => app.send('POST', `/api/credentials/models/${provider}/disable`, { cookie: app.adminCookie, body })

    const first = await disable('codex', { disable: ['gpt-5.1-codex', 'gpt-5.1-codex'] })
    assert.equal(first.status, 200, first.text)
    assert.equal(first.body.disabled, 1)
    assert.equal(puts, 1)
    assert.deepEqual(excluded, { claude: ['claude-old'], codex: ['gpt-5.1-codex'] })

    const index = await app.send('GET', '/api/model-index?fresh=1', { cookie: app.adminCookie })
    assert.equal(index.status, 200, index.text)
    const source = (index.body.models as Array<{ id: string; sources: Array<{ channel: string; kind: string; enabled: boolean }> }>)
      .find(model => model.id === 'gpt-5.1-codex')?.sources.find(item => item.channel === 'codex' && item.kind === 'oauth')
    assert.equal(source?.enabled, false)

    const again = await disable('codex', { disable: ['gpt-5.1-codex'] })
    assert.equal(again.body.disabled, 0, '已停用的不重复计')
    assert.equal((await disable('nope', { disable: ['x'] })).status, 404)
    assert.equal((await disable('codex', { disable: [] })).status, 400)
    assert.equal((await disable('codex', { disable: 'gpt-5.1' })).status, 400)
    assert.equal(puts, 2, '校验失败不写')
  } finally {
    await app.stop()
    await cpa.stop()
  }
})
