import assert from 'node:assert/strict'
import test from 'node:test'
import { startContractCpa } from './testing/contractFixture.js'
import { launchConsole } from './testing/consoleProcess.js'

/**
 * 停用一把 Key 不受它当前分组的约束：对账会把在 CPA 侧下线的渠道从 Key 的分组里去掉，分组可能因此变空，
 * 这时停用必须照样成功，库里的分组原样不动。启用、或请求里带了分组时照常校验（启用的 Key 至少要有一个分组）。
 */

test('停用不被对账清空的分组挡住，分组原样保留；启用与改分组照常校验', { timeout: 120_000 }, async () => {
  const cpa = await startContractCpa()
  cpa.compat.push({
    name: 'second-relay',
    'base-url': 'https://second.example.test/v1',
    'api-key-entries': [{ 'api-key': 'sk-placeholder-second' }],
    models: [{ name: 'second-model', alias: 'second-model' }],
  })
  const app = await launchConsole({ CPA_BASE_URL: cpa.base, CPA_MANAGEMENT_KEY: cpa.key })
  try {
    const admin = { cookie: app.adminCookie }
    const create = async (name: string, groups: string[]) => {
      const created = await app.send('POST', '/api/keys', { ...admin, body: { name, groups, totalConcurrency: 4, groupConcurrency: Object.fromEntries(groups.map(id => [id, 2])) } })
      assert.equal(created.status, 201, created.text)
      return String(created.body.item.id)
    }
    const patch = (id: string, body: unknown) => app.send('PATCH', `/api/keys/${id}`, { ...admin, body })
    const item = async (id: string) => {
      const boot = await app.send('GET', '/api/bootstrap', admin)
      return (boot.body.keys as Array<{ id: string; enabled: boolean; groups: string[] }>).find(key => key.id === id)!
    }
    const only = await create('only-second', ['second-relay'])
    const both = await create('both-relays', ['contract-relay', 'second-relay'])

    // second-relay 在 CPA 侧下线；下一轮对账（任一次 Key 保存都会触发）把它从分组里去掉
    cpa.compat = cpa.compat.filter(channel => channel.name !== 'second-relay')
    assert.equal((await app.send('GET', '/api/channels?fresh=1', admin)).status, 200)
    assert.equal((await patch(both, { note: 'reconcile' })).status, 200)
    assert.deepEqual((await item(only)).groups, [])
    assert.deepEqual((await item(both)).groups, ['contract-relay'])

    const disabled = await patch(only, { enabled: false })
    assert.equal(disabled.status, 200, `空分组不能挡住停用：${disabled.text}`)
    assert.deepEqual([disabled.body.item.enabled, disabled.body.item.groups], [false, []])
    const disabledBoth = await patch(both, { enabled: false })
    assert.equal(disabledBoth.status, 200, disabledBoth.text)
    assert.deepEqual([disabledBoth.body.item.enabled, disabledBoth.body.item.groups], [false, ['contract-relay']], '停用不动分组')
    assert.equal((await patch(only, { name: 'only-second-renamed' })).status, 200, '已停用的 Key 改名也不被空分组挡住')

    const enable = await patch(only, { enabled: true })
    assert.deepEqual([enable.status, enable.body.error], [400, '至少选择一个渠道分组'], '启用照常校验')
    const emptied = await patch(both, { enabled: false, groups: [] })
    assert.deepEqual([emptied.status, emptied.body.error], [400, '至少选择一个渠道分组'], '请求里带了分组照常校验')
    assert.deepEqual([(await item(only)).enabled, (await item(both)).groups], [false, ['contract-relay']], '被拒的请求不落库')
  } finally {
    await app.stop()
    await cpa.stop()
  }
})
