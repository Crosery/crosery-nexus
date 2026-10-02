import assert from 'node:assert/strict'
import test from 'node:test'
import { buildExport, planApply } from './lib/commands/config.mjs'

const KEY_ID = 'abcdef0123456789'.repeat(4)

function state() {
  return {
    channels: {
      channels: [
        { name: 'tch', enabled: true, stale: false, models: [{ id: 'm1', enabled: true }, { id: 'm2', enabled: false }] },
        { name: 'off', enabled: false, stale: false, models: [{ id: 'x1', enabled: true }] },
        { name: 'gone', enabled: true, stale: true, models: [] },
      ],
      credentials: [{ name: 'codex-a.json', type: 'codex', disabled: false, status: 'active', proxyUrl: '' }],
    },
    modelIndex: {
      models: [
        { id: 'gpt-5', sources: [{ channel: 'codex', kind: 'oauth', enabled: true }] },
        { id: 'gpt-5-mini', sources: [{ channel: 'codex', kind: 'oauth', enabled: false }] },
        { id: 'm1', sources: [{ channel: 'tch', kind: 'compat', enabled: true }] },
      ],
    },
    bootstrap: {
      groups: [{ id: 'tch' }, { id: 'codex' }],
      keys: [{
        id: KEY_ID, name: 'k1', note: '', enabled: false, blockedReason: 'quota', groups: ['tch'], totalConcurrency: 0, groupConcurrency: {},
        quota: { totalUsd: 0, dailyUsd: 5, weeklyUsd: 0 },
      }],
    },
    rtk: { on: false, writable: true },
  }
}

const summary = items => items.map(item => `${item.method} ${item.path} ${JSON.stringify(item.body ?? null)}`)

test('导出：无秘密、排除失效渠道、额度封禁的 Key 记为人工启用', () => {
  const exported = buildExport(state(), { source: 'http://127.0.0.1:8791', now: 0 })
  assert.equal(exported.cradmin, 1)
  assert.deepEqual(Object.keys(exported.channels), ['tch', 'off'])
  assert.deepEqual(exported.channels.tch, { enabled: true, models: { m1: true, m2: false } })
  assert.deepEqual(exported.providers, { codex: { models: { 'gpt-5': true, 'gpt-5-mini': false } } })
  assert.deepEqual(exported.accounts, { 'codex-a.json': { enabled: true, proxyUrl: '' } })
  assert.equal(exported.keys[0].id, KEY_ID.slice(0, 12))
  assert.equal(exported.keys[0].enabled, true)
  assert.deepEqual(exported.rtk, { on: false })
  assert.doesNotMatch(JSON.stringify(exported), /sk-|password|token/i)
})

test('导出后立即应用 = 空计划（幂等）', () => {
  const current = state()
  const plan = planApply(buildExport(current, { source: 'x' }), current)
  assert.deepEqual(plan.items, [])
  assert.deepEqual(plan.warnings, [])
})

test('执行顺序：启用渠道 → 渠道模型 → 账号池模型 → 账号 → Key → 停用渠道 → RTK', () => {
  const current = state()
  const file = buildExport(current, { source: 'x' })
  file.rtk.on = true
  file.channels.tch.enabled = false
  file.channels.off.enabled = true
  file.channels.off.models.x1 = false
  file.providers.codex.models['gpt-5-mini'] = true
  file.accounts['codex-a.json'] = { enabled: false, proxyUrl: 'direct' }
  file.keys[0].quota.dailyUsd = 7
  file.keys[0].groups = ['tch', 'codex']
  const plan = planApply(file, current)
  assert.deepEqual(summary(plan.items), [
    'PATCH /api/channels/off {"enabled":true}',
    'PATCH /api/channels/off/models/x1 {"enabled":false}',
    'PATCH /api/model-index/gpt-5-mini/sources/codex {"kind":"oauth","enabled":true}',
    'PATCH /api/credentials/codex-a.json {"enabled":false}',
    'PATCH /api/credentials/codex-a.json/proxy {"proxyUrl":"direct"}',
    `PATCH /api/keys/${KEY_ID} {"groups":["tch","codex"],"totalConcurrency":0,"groupConcurrency":{}}`,
    `PATCH /api/keys/${KEY_ID}/quota {"dailyUsd":7}`,
    'PATCH /api/channels/tch {"enabled":false}',
    'POST /api/rtk/global {"on":true,"confirm":true}',
  ])
})

test('只调和文件里出现的条目；不存在的对象跳过并警告；从不删除', () => {
  const plan = planApply({
    cradmin: 1,
    channels: { ghost: { enabled: true }, tch: { models: { nope: true, m2: true } } },
    providers: { claude: { models: {} } },
    accounts: { 'missing.json': { enabled: true } },
    keys: [{ name: 'k-missing', groups: ['tch'] }, { name: 'k-bad', groups: ['nope'] }],
  }, state())
  assert.deepEqual(summary(plan.items), ['PATCH /api/channels/tch/models/m2 {"enabled":true}'])
  assert.equal(plan.warnings.length, 6)
  assert.ok(plan.items.every(item => item.method !== 'DELETE'))
})

test('停用中的渠道：模型开关跳过并警告', () => {
  const plan = planApply({ cradmin: 1, channels: { off: { models: { x1: false } } } }, state())
  assert.deepEqual(plan.items, [])
  assert.match(plan.warnings[0], /停用/)
})

test('--create-keys：匹配不到的 Key 新建；没有该参数时只警告', () => {
  const file = { cradmin: 1, keys: [{ name: 'k-new', groups: ['codex'], quota: { dailyUsd: 2 } }] }
  assert.equal(planApply(file, state()).items.length, 0)
  const plan = planApply(file, state(), { createKeys: true })
  assert.deepEqual(summary(plan.items), ['POST /api/keys {"name":"k-new","note":"","groups":["codex"],"totalConcurrency":0,"groupConcurrency":{}}'])
})

test('Key 按 id 前缀匹配优先于名称；改名会被识别', () => {
  const plan = planApply({ cradmin: 1, keys: [{ id: KEY_ID.slice(0, 12), name: 'renamed' }] }, state())
  assert.deepEqual(summary(plan.items), [`PATCH /api/keys/${KEY_ID} {"name":"renamed"}`])
})

test('非 cradmin 文件、非布尔 enabled → 用法错误', () => {
  assert.throws(() => planApply({}, state()), error => error.exitCode === 2)
  assert.throws(() => planApply({ cradmin: 1, channels: { tch: { enabled: 'false' } } }, state()), error => error.exitCode === 2)
})

test('RTK 不可写时跳过并警告', () => {
  const current = state()
  current.rtk = { on: null, writable: false, reason: 'no_supported_agents' }
  const plan = planApply({ cradmin: 1, rtk: { on: true } }, current)
  assert.deepEqual(plan.items, [])
  assert.match(plan.warnings[0], /no_supported_agents/)
})

const fakeCtx = handler => {
  const calls = []
  const ctx = {
    target: { base: 'http://127.0.0.1:8791' }, userAgent: 'cradmin/test', dryRun: false,
    session: { cookie: async () => 'c=1', invalidate: async () => false, tierLabel: () => '' },
    fetch: async (url, init) => {
      const call = { method: init.method, path: new URL(url).pathname, body: init.body ? JSON.parse(init.body) : undefined }
      calls.push(call)
      const [status, body] = handler(call)
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    },
  }
  return { ctx, calls }
}

test('额度封禁的 Key 在文件里写 enabled:false → 显式发 enabled:false（清掉封禁，对账不再自动恢复）', () => {
  const file = buildExport(state(), { source: 'x' })
  file.keys[0].enabled = false
  assert.deepEqual(summary(planApply(file, state()).items), [`PATCH /api/keys/${KEY_ID} {"enabled":false}`])
})

test('Key 条目类型校验："true" 这类字符串不会被推导成布尔值', () => {
  for (const bad of [{ enabled: 'true' }, { groups: 'tch' }, { totalConcurrency: '2' }, { quota: { dailyUsd: '5' } }, { id: 'zz' }]) {
    assert.throws(() => planApply({ cradmin: 1, keys: [{ name: 'k1', ...bad }] }, state()), error => error.exitCode === 2, JSON.stringify(bad))
  }
})

test('跨控制台：id 前缀匹配不到时按名称匹配，--create-keys 重跑不会重复新建', () => {
  const plan = planApply({ cradmin: 1, keys: [{ id: '0123456789ab', name: 'k1', note: 'n', groups: ['tch'] }] }, state(), { createKeys: true })
  assert.deepEqual(summary(plan.items), [`PATCH /api/keys/${KEY_ID} {"note":"n"}`])
  assert.match(plan.warnings[0], /按名称匹配/)
})

test('轮换前的导出：按 id 匹配到旧 Key，但名称已被新 Key 占用 → 跳过并警告，不改名不启用', () => {
  const current = state()
  current.bootstrap.keys = [
    { ...current.bootstrap.keys[0], name: 'k1（已轮换 2026-10-01）', enabled: false, blockedReason: '' },
    { ...current.bootstrap.keys[0], id: 'fedcba9876543210'.repeat(4), name: 'k1', enabled: true },
  ]
  const plan = planApply({ cradmin: 1, keys: [{ id: KEY_ID.slice(0, 12), name: 'k1', enabled: true }] }, current)
  assert.deepEqual(plan.items, [])
  assert.match(plan.warnings[0], /已被另一把 Key 使用/)
})

test('引用了已删除分组的 Key：其它字段（停用）照常应用，只跳过分组改动', () => {
  const current = state()
  current.bootstrap.keys[0] = { ...current.bootstrap.keys[0], enabled: true, blockedReason: '', groups: ['tch', 'gone'] }
  const plan = planApply({ cradmin: 1, keys: [{ id: KEY_ID.slice(0, 12), groups: ['tch', 'gone'], enabled: false }] }, current)
  assert.deepEqual(summary(plan.items), [`PATCH /api/keys/${KEY_ID} {"enabled":false}`])
  assert.deepEqual(plan.warnings, [])
})

test('同一文件既改模型又停用渠道：先改模型再停用（停用快照里是新的模型开关）', () => {
  const file = buildExport(state(), { source: 'x' })
  file.channels.tch.enabled = false
  file.channels.tch.models.m2 = true
  assert.deepEqual(summary(planApply(file, state()).items), ['PATCH /api/channels/tch/models/m2 {"enabled":true}', 'PATCH /api/channels/tch {"enabled":false}'])
})

test('代理地址里的 user:pass@：导出打码；原样应用 = 无改动；改了打码地址 → 跳过并警告；计划与摘要不含密码', async () => {
  const { summarizeBody } = await import('./lib/plan.mjs')
  const current = state()
  current.channels.credentials[0].proxyUrl = 'http://bob:hunter2-secret@proxy.example:8080'
  const file = buildExport(current, { source: 'x' })
  assert.equal(file.accounts['codex-a.json'].proxyUrl, 'http://***@proxy.example:8080')
  assert.doesNotMatch(JSON.stringify(file), /hunter2-secret/)
  assert.deepEqual(planApply(file, current).items, [])
  file.accounts['codex-a.json'].proxyUrl = 'http://***@other.example:8080'
  const skipped = planApply(file, current)
  assert.deepEqual(skipped.items, [])
  assert.match(skipped.warnings[0], /已打码/)
  file.accounts['codex-a.json'].proxyUrl = 'socks5h://alice:other-secret@127.0.0.1:1080'
  const [item] = planApply(file, current).items
  assert.equal(item.body.proxyUrl, 'socks5h://alice:other-secret@127.0.0.1:1080')
  assert.doesNotMatch(`${item.from} ${item.to} ${summarizeBody(item.body)}`, /hunter2-secret|other-secret/)
})

test('--create-keys 新建 enabled:false 的 Key：建完再显式停用', async () => {
  const { ctx, calls } = fakeCtx(call => {
    if (call.method === 'POST') return [201, { key: 'sk-k-new-0123', item: { id: 'f'.repeat(64), name: 'k-new', enabled: true } }]
    return [200, { item: { id: 'f'.repeat(64), name: 'k-new', enabled: false } }]
  })
  const plan = planApply({ cradmin: 1, keys: [{ name: 'k-new', groups: ['codex'], enabled: false }] }, state(), { ctx, createKeys: true })
  assert.match(plan.items[0].to, /停用/)
  await plan.items[0].run()
  assert.deepEqual(calls.map(call => `${call.method} ${call.path} ${JSON.stringify(call.body)}`).slice(1), [`PATCH /api/keys/${'f'.repeat(64)} {"enabled":false}`])
  assert.deepEqual(plan.created, [{ name: 'k-new', key: 'sk-k-new-0123', id: 'f'.repeat(64) }])
})

test('--create-keys：Key 建出来但额度没设上 → 完整 Key 仍记进 created（不会丢）', async () => {
  const { ctx } = fakeCtx(call => (call.method === 'POST'
    ? [201, { key: 'sk-k-new-0123', item: { id: 'f'.repeat(64), name: 'k-new', enabled: true } }]
    : [400, { error: '额度保存失败' }]))
  const plan = planApply({ cradmin: 1, keys: [{ name: 'k-new', groups: ['codex'], quota: { dailyUsd: 2 } }] }, state(), { ctx, createKeys: true })
  await assert.rejects(plan.items[0].run(), error => error.exitCode === 1)
  assert.deepEqual(plan.created, [{ name: 'k-new', key: 'sk-k-new-0123', id: 'f'.repeat(64), incomplete: true }])
})

test('RTK：HTTP 200 但 ok:false → 这一步算失败', async () => {
  const { ctx } = fakeCtx(() => [200, { ok: false, results: [{ agent: 'codex', ok: false }, { agent: 'claude', ok: true }] }])
  const plan = planApply({ cradmin: 1, rtk: { on: true } }, state(), { ctx })
  await assert.rejects(plan.items[0].run(), error => error.exitCode === 1 && /codex/.test(error.message))
})

test('文件里 Key 的并发不合法：报出是哪把 Key，提示改文件而不是命令行参数', () => {
  const current = state()
  const file = buildExport(current, { source: 'x' })
  file.keys[0].totalConcurrency = 2
  assert.throws(() => planApply(file, current), error => error.exitCode === 2
    && /^Key k1：tch 分组并发必须在 1 到总并发之间$/.test(error.message)
    && /groupConcurrency/.test(error.hint) && !/--group-concurrency/.test(error.hint))
})
