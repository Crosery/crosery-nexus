import assert from 'node:assert/strict'
import test from 'node:test'
import { validatePolicy as serverValidatePolicy } from '../server/policy.ts'
import { normalizeProxyUrl as serverNormalizeProxy } from '../server/proxyPresets.ts'
import { validateQuota as serverValidateQuota } from '../server/quota.ts'
import { globToRegExp, matchPatterns, planModelChanges, resolveAccount, resolveChannel, resolveGroups, resolveKey, validatePolicy, validateProxy, validateQuota } from './lib/resolve.mjs'

const KEYS = [
  { id: 'aaaaaaaa11112222333344445555666677778888999900001111222233334444', name: 'alpha' },
  { id: 'aaaaaaaa99990000000000000000000000000000000000000000000000000000', name: 'beta' },
  { id: 'bbbbbbbb00000000000000000000000000000000000000000000000000000000', name: 'dup' },
  { id: 'cccccccc00000000000000000000000000000000000000000000000000000000', name: 'dup' },
]

test('resolveKey：唯一名称、id 前缀、歧义与找不到都退出 2', () => {
  assert.equal(resolveKey(KEYS, 'alpha').name, 'alpha')
  assert.equal(resolveKey(KEYS, 'bbbbbbbb').name, 'dup')
  assert.equal(resolveKey(KEYS, 'aaaaaaaa9999').name, 'beta')
  assert.throws(() => resolveKey(KEYS, 'aaaaaaaa'), error => error.exitCode === 2 && /多把/.test(error.message))
  assert.throws(() => resolveKey(KEYS, 'dup'), error => error.exitCode === 2 && /id 前缀/.test(error.message))
  assert.throws(() => resolveKey(KEYS, 'nobody'), error => error.exitCode === 2)
  assert.throws(() => resolveKey(KEYS, 'aaaa'), error => error.exitCode === 2, '少于 8 位不按前缀匹配')
})

test('resolveChannel / resolveAccount', () => {
  const payload = { channels: [{ name: 'tch', models: [] }], credentials: [{ name: 'codex-a.json', type: 'codex', label: 'a@x' }, { name: 'codex-b.json', type: 'codex', label: 'b@x' }] }
  assert.equal(resolveChannel(payload, 'tch').kind, 'compat')
  assert.equal(resolveChannel(payload, 'codex').kind, 'oauth')
  assert.throws(() => resolveChannel(payload, 'nope'), error => error.exitCode === 2)
  assert.equal(resolveAccount(payload.credentials, 'b@x').name, 'codex-b.json')
  assert.throws(() => resolveAccount(payload.credentials, 'codex'), error => error.exitCode === 2 && /多个账号/.test(error.message))
})

test('glob：* ? 与正则字符转义；任何模式零匹配退出 2', () => {
  assert.ok(globToRegExp('gpt-5*').test('gpt-5.6-sol'))
  assert.ok(!globToRegExp('gpt-5*').test('xgpt-5'))
  assert.ok(globToRegExp('m?').test('m1'))
  assert.ok(!globToRegExp('a.b').test('axb'))
  assert.throws(() => matchPatterns(['zz*'], ['a', 'b']), error => error.exitCode === 2)
  assert.throws(() => matchPatterns(['a', 'zz'], ['a', 'b']), error => error.exitCode === 2)
})

test('planModelChanges：--only / --enable / --disable 只产生真正变化的项', () => {
  const models = [{ id: 'gpt-5', enabled: true }, { id: 'gpt-5-mini', enabled: false }, { id: 'o3', enabled: true }]
  assert.deepEqual(planModelChanges(models, { only: ['gpt-5*'] }), [
    { id: 'gpt-5-mini', from: false, to: true },
    { id: 'o3', from: true, to: false },
  ])
  assert.deepEqual(planModelChanges(models, { enable: ['gpt-5'] }), [])
  assert.deepEqual(planModelChanges(models, { disable: ['o3'], enable: ['gpt-5-mini'] }), [
    { id: 'gpt-5-mini', from: false, to: true },
    { id: 'o3', from: true, to: false },
  ])
  assert.equal(planModelChanges(models, {}), null)
  assert.throws(() => planModelChanges(models, { only: ['o3'], enable: ['gpt-5'] }), error => error.exitCode === 2)
  assert.throws(() => planModelChanges(models, { enable: ['o3'], disable: ['o*'] }), error => error.exitCode === 2 && /既启用又停用/.test(error.message))
})

test('resolveGroups：未知分组退出 2（服务端会静默丢弃），all 展开全部', () => {
  const groups = [{ id: 'codex' }, { id: 'tch' }]
  assert.deepEqual(resolveGroups(['all'], groups), ['codex', 'tch'])
  assert.deepEqual(resolveGroups(['tch', 'tch'], groups), ['tch'])
  assert.throws(() => resolveGroups(['nope'], groups), error => error.exitCode === 2 && /未知分组/.test(error.message))
})

const outcome = fn => {
  try { fn(); return 'ok' } catch (error) { return error.message }
}

test('本地 validatePolicy 与服务端 server/policy.ts 结论与文案一致', () => {
  const cases = [
    { groups: ['a'], totalConcurrency: 0, groupConcurrency: {} },
    { groups: [], totalConcurrency: 0, groupConcurrency: {} },
    { groups: ['a'], totalConcurrency: 501, groupConcurrency: {} },
    { groups: ['a'], totalConcurrency: -1, groupConcurrency: {} },
    { groups: ['a'], totalConcurrency: 1.5, groupConcurrency: {} },
    { groups: ['a'], totalConcurrency: 4, groupConcurrency: {} },
    { groups: ['a'], totalConcurrency: 4, groupConcurrency: { a: 5 } },
    { groups: ['a'], totalConcurrency: 4, groupConcurrency: { a: 0 } },
    { groups: ['a', 'b'], totalConcurrency: 4, groupConcurrency: { a: 2, b: 4 } },
    { groups: ['a', 'b'], totalConcurrency: 4, groupConcurrency: { a: 2 } },
  ]
  for (const policy of cases) {
    assert.equal(outcome(() => validatePolicy(policy)), outcome(() => serverValidatePolicy({ enabled: true, ...policy })), JSON.stringify(policy))
  }
})

test('本地 validateQuota 与服务端 server/quota.ts 结论与文案一致', () => {
  const cases = [
    [0, 0, 0], [10, 2, 5], [10, 20, 0], [10, 0, 20], [0, 6, 5], [0, 5, 5], [-1, 0, 0], [0, 0, 1_000_001], [5, 5, 5],
  ]
  for (const [totalUsd, dailyUsd, weeklyUsd] of cases) {
    const quota = { totalUsd, dailyUsd, weeklyUsd }
    assert.equal(outcome(() => validateQuota(quota)), outcome(() => serverValidateQuota(quota)), JSON.stringify(quota))
  }
})

test('validateProxy：inherit → 空串，direct 原样，其它必须是 http(s)/socks5', () => {
  assert.equal(validateProxy('inherit'), '')
  assert.equal(validateProxy('direct'), 'direct')
  assert.equal(validateProxy('socks5://127.0.0.1:1080'), 'socks5://127.0.0.1:1080')
  assert.throws(() => validateProxy('ftp://x'), error => error.exitCode === 2)
})

test('validateProxy 与服务端同规则：socks5h、none、大小写；redactUrl 打码 userinfo', async () => {
  const { redactUrl } = await import('./lib/resolve.mjs')
  assert.equal(validateProxy('socks5h://127.0.0.1:1080'), 'socks5h://127.0.0.1:1080')
  assert.equal(validateProxy('none'), 'direct')
  assert.equal(validateProxy('DIRECT'), 'direct')
  assert.throws(() => validateProxy('ftp://x'), error => error.exitCode === 2)
  for (const value of ['socks5h://h:1', 'SOCKS5://h:1', 'none', 'Direct', 'http://u:p@h:8080', 'ftp://h', 'http://', '']) {
    let cli
    try { cli = validateProxy(value) } catch { cli = null }
    assert.equal(cli, serverNormalizeProxy(value), JSON.stringify(value))
  }
  assert.equal(redactUrl('http://user:p%40ss@proxy.example:8080'), 'http://***@proxy.example:8080')
  assert.equal(redactUrl('socks5://127.0.0.1:1080'), 'socks5://127.0.0.1:1080')
  assert.equal(redactUrl(''), '')
})
