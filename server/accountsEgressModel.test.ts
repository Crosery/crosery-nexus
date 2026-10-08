import assert from 'node:assert/strict'
import test from 'node:test'
import {
  checkMark, choiceName, cpaRef, EGRESS_CUSTOM, EGRESS_UNKNOWN, egressBadge, egressChoice, egressOptions, egressWarning, egressWrite, exitLabel, magpieRef,
  readLabel, regionName, serviceOf, signinVia,
} from '../src/features/accounts/egressModel.js'
import { rowMenu } from '../src/features/accounts/magpieModel.js'
import type { EgressData, EgressEntry, EgressRead, MagpieAccount } from '../src/types.js'

/** /accounts exits (src/features/accounts/egressModel.ts): wording and pick → write mapping; values arrive masked. */

const AT = '2026-10-02T10:00:00.000Z'
const entry = (over: Partial<EgressEntry> = {}): EgressEntry => ({
  id: 'px_aaaaaaaaaa', name: '东京-01', kind: 'url', protocol: 'socks5', country: 'JP', exitState: null,
  checks: { claude: { state: 'ok', ms: 230, at: AT }, openai: { state: 'region-blocked', ms: 400, at: AT } },
  checkedAt: AT, assignable: true, reason: null, usedBy: 2, ...over,
})
const data = (over: Partial<EgressData> = {}): EgressData => ({
  backend: 'cpa', cpaSameHost: false, kernel: { state: 'unavailable' }, accountProxy: { supported: true, reason: null },
  default: { mode: 'inherit', entryId: null }, services: {},
  signin: { via: 'cpa-global', exit: { mode: 'inherit', entryId: null }, perSignin: false, note: '登录由 CPA 完成' },
  entries: [
    entry(),
    entry({ id: 'px_bbbbbbbbbb', name: 'node-ss', kind: 'mihomo', protocol: 'ss', country: null, checks: {}, checkedAt: null, assignable: false, reason: 'CPA 不在本机，本机端口对它不可用', usedBy: 0 }),
  ],
  accounts: {
    'cpa:c1.json': { mode: 'url', entryId: 'px_aaaaaaaaaa', masked: 'socks5://***@203.0.113.10:1080', at: AT },
    'cpa:c2.json': { mode: 'inherit', entryId: null, masked: null, at: AT },
    'cpa:c3.json': { mode: 'url', entryId: null, masked: 'http://***@198.51.100.9:3128', at: AT },
    'cpa:c4.json': { mode: 'direct', entryId: null, masked: null, at: AT },
    'cpa:c5.json': { mode: 'invalid', entryId: null, masked: null, at: AT },
  },
  presets: [{ label: '东京', entryId: 'px_aaaaaaaaaa' }, { label: '住宅', entryId: null }],
  ...over,
})

test('refs and services: a Claude account checks Claude, a Codex one OpenAI, Antigravity Google', () => {
  assert.equal(cpaRef('c1.json'), 'cpa:c1.json')
  assert.equal(magpieRef('codex', ' A@Example.test '), 'magpie:codex:a@example.test')
  assert.equal(serviceOf('claude'), 'claude')
  assert.equal(serviceOf('codex'), 'openai')
  assert.equal(serviceOf('antigravity'), 'google')
  assert.equal(serviceOf('qwen'), null)
})

test('an exit reads region first, then its name; an auto name\'s own country tail is not said twice', () => {
  assert.equal(regionName('US'), '美国')
  assert.equal(regionName('jp'), '日本')
  assert.equal(regionName('HK'), '香港')
  assert.equal(regionName(null), null)
  assert.equal(regionName(''), null)
  assert.equal(regionName('XX'), 'XX', 'a code Intl does not know stays as it is')
  assert.equal(regionName('EU-1'), 'EU-1')
  assert.equal(exitLabel({ name: '东京-01', country: 'JP' }), '日本 · 东京-01')
  assert.equal(exitLabel({ name: '203.0.113.7 · US', country: 'US' }), '美国 · 203.0.113.7')
  assert.equal(exitLabel({ name: 'node-ss', country: null }), 'node-ss')
  assert.equal(exitLabel({ name: '', country: 'SG' }), '新加坡')
})

test('check marks: ✓ with latency, ✗ with the reason, 未检测, and the exit itself down wins', () => {
  assert.deepEqual(checkMark(entry(), 'claude'), { ok: true, text: '✓ 230ms', title: '经这个出口可以访问 Claude' })
  assert.deepEqual(checkMark(entry(), 'openai'), { ok: false, text: '✗ 地区限制', title: '经这个出口访问 OpenAI：地区限制' })
  assert.equal(checkMark(entry(), 'google').text, '未检测')
  assert.equal(checkMark(entry(), null).text, '')
  assert.deepEqual(checkMark(entry({ exitState: 'proxy-down' }), 'claude'), { ok: false, text: '✗ 代理不可达', title: '出口本身不通：代理不可达' })
})

test('badges: own exit with country + this vendor\'s check; inherit names what it resolves to; nothing when unknown', () => {
  const d = data()
  const own = egressBadge(d, 'cpa:c1.json', 'claude')!
  assert.deepEqual([own.kind, own.label, own.country, own.mark.text], ['entry', '日本 · 东京-01', 'JP', '✓ 230ms'])
  assert.doesNotMatch(own.title, /:\/\//, 'never a proxy URL')
  assert.equal(egressBadge(d, 'cpa:c1.json', 'openai')!.mark.ok, false, 'the same exit, checked for the account\'s own vendor')
  assert.deepEqual(egressBadge(d, 'cpa:c2.json', 'claude')!.label, '全局 · 直连')
  const viaGlobal = egressBadge(data({ default: { mode: 'url', entryId: 'px_aaaaaaaaaa' } }), 'cpa:c2.json', 'claude')!
  assert.deepEqual([viaGlobal.kind, viaGlobal.label, viaGlobal.country, viaGlobal.mark.text], ['inherit', '全局 · 日本 · 东京-01', 'JP', '✓ 230ms'])
  assert.equal(egressBadge(data({ default: { mode: 'unknown', entryId: null } }), 'cpa:c2.json', 'claude')!.label, '继承全局')
  const custom = egressBadge(d, 'cpa:c3.json', 'claude')!
  assert.deepEqual([custom.kind, custom.label], ['custom', '自定义地址'])
  assert.match(custom.title, /198\.51\.100\.9/)
  assert.equal(egressBadge(d, 'cpa:c4.json', 'claude')!.label, '直连')
  assert.equal(egressBadge(d, 'cpa:c5.json', 'claude')!.kind, 'invalid')
  assert.equal(egressBadge(d, 'cpa:never-seen.json', 'claude'), null, 'CPA lists carry no proxy: unknown until read')
  assert.equal(egressBadge(null, 'cpa:c1.json', 'claude'), null)
  // a fresher per-account read wins over what the pool last saw
  const read: EgressRead = { ref: 'cpa:c2.json', mode: 'url', entryId: 'px_aaaaaaaaaa', masked: 'x', at: AT, entryName: '东京-01', preset: 0 }
  assert.equal(egressBadge(d, 'cpa:c2.json', 'claude', read)!.label, '日本 · 东京-01')
})

test('Magpie badges: an account without its own exit follows its service, else the kernel (direct)', () => {
  const d = data({ backend: 'magpie', accounts: { 'magpie:codex:a@x.test': { mode: 'url', entryId: 'px_aaaaaaaaaa', masked: 'x', at: null } }, services: { claude: { mode: 'url', entryId: 'px_aaaaaaaaaa', masked: 'x', at: null } } })
  assert.equal(egressBadge(d, 'magpie:codex:a@x.test', 'openai')!.mark.text, '✗ 地区限制')
  assert.equal(egressBadge(d, 'magpie:codex:b@x.test', 'openai')!.label, '服务 · 直连')
  assert.equal(egressBadge(d, 'magpie:claude:c@x.test', 'claude')!.label, '服务 · 日本 · 东京-01')
})

test('picker: 继承 · 直连 · exits (unassignable listed, disabled, with the reason) · presets not in the pool · 自定义', () => {
  const options = egressOptions(data({ default: { mode: 'url', entryId: 'px_aaaaaaaaaa' } }), 'cpa:c1.json', 'claude', { presets: [{ label: '东京', url: 'socks5://a:b@h:1' }, { label: '住宅', url: 'http://c:d@r:2' }], custom: true })
  assert.deepEqual(options, [
    { value: '', label: '继承全局 · 日本 · 东京-01' },
    { value: 'direct', label: '直连' },
    { value: 'px_aaaaaaaaaa', label: '日本 · 东京-01 · Claude ✓ 230ms', disabled: false },
    { value: 'px_bbbbbbbbbb', label: 'node-ss · CPA 不在本机，本机端口对它不可用', disabled: true },
    { value: 'preset:1', label: '住宅 · 预设' },
    { value: EGRESS_CUSTOM, label: '自定义地址…' },
  ])
  assert.equal(egressOptions(data(), 'cpa:c1.json', 'openai')[2].label, '日本 · 东京-01 · OpenAI ✗ 地区限制')
  assert.equal(egressOptions(data({ backend: 'magpie' }), 'magpie:codex:a@x.test', 'openai')[0].label, '不单独设置 · 直连')
  assert.equal(egressOptions(null, 'cpa:c1.json', 'claude').length, 2, 'no pool view: 继承 and 直连 only')
})

test('choice and write: entries by id through the pool, presets by address through the account route', () => {
  const d = data()
  const read = (over: Partial<EgressRead>): EgressRead => ({ ref: 'cpa:c1.json', mode: 'url', entryId: null, masked: null, at: AT, entryName: null, preset: null, ...over })
  assert.equal(egressChoice(read({ mode: 'inherit' }), d), '')
  assert.equal(egressChoice(read({ mode: 'direct' }), d), 'direct')
  assert.equal(egressChoice(read({ entryId: 'px_aaaaaaaaaa' }), d), 'px_aaaaaaaaaa')
  assert.equal(egressChoice(read({ preset: 1 }), d), 'preset:1')
  assert.equal(egressChoice(read({}), d), EGRESS_CUSTOM)
  assert.equal(egressChoice(null, d), EGRESS_UNKNOWN)
  const presets = [{ label: '东京', url: 'socks5://a:b@h:1' }, { label: '住宅', url: 'http://c:d@r:2' }]
  assert.deepEqual(egressWrite('', presets), { via: 'assign', target: 'inherit' })
  assert.deepEqual(egressWrite('direct', presets), { via: 'assign', target: 'direct' })
  assert.deepEqual(egressWrite('px_aaaaaaaaaa', presets), { via: 'assign', target: 'px_aaaaaaaaaa' })
  assert.deepEqual(egressWrite('preset:1', presets), { via: 'url', url: 'http://c:d@r:2' })
  assert.equal(egressWrite('preset:9', presets), null)
  assert.equal(egressWrite('socks5://typed:1', presets), null, 'a typed address is the caller\'s')
  assert.equal(choiceName(d, 'cpa:c1.json', 'preset:1', presets), '住宅')
  assert.equal(choiceName(d, 'cpa:c1.json', 'px_aaaaaaaaaa'), '日本 · 东京-01')
})

test('warning: only a pick whose last check failed for this account\'s vendor', () => {
  assert.equal(egressWarning(data(), 'px_aaaaaaaaaa', 'claude'), null)
  assert.equal(egressWarning(data(), 'px_aaaaaaaaaa', 'openai'), '经这个出口访问 OpenAI：地区限制')
  assert.equal(egressWarning(data(), 'direct', 'openai'), null)
  assert.equal(egressWarning(null, 'px_aaaaaaaaaa', 'openai'), null)
})

test('sign-in route is stated (no backend sends one sign-in through a chosen exit); toast words never show a URL', () => {
  assert.deepEqual(signinVia(data({ default: { mode: 'url', entryId: 'px_aaaaaaaaaa' }, signin: { via: 'cpa-global', exit: { mode: 'url', entryId: 'px_aaaaaaaaaa' }, perSignin: false, note: 'n' } })), { label: 'CPA 全局代理 · 日本 · 东京-01', note: 'n' })
  assert.equal(signinVia(data()).label, 'CPA 全局代理 · 直连')
  assert.equal(signinVia(data({ signin: { via: 'direct', exit: { mode: 'direct', entryId: null }, perSignin: false, note: 'k' } })).label, '本机直连')
  assert.equal(readLabel({ ref: 'r', mode: 'url', entryId: 'px_aaaaaaaaaa', masked: 'http://***@h:1', at: null, entryName: '东京-01', preset: null }), '东京-01')
  assert.equal(readLabel({ ref: 'r', mode: 'url', entryId: 'px_aaaaaaaaaa', masked: 'http://***@h:1', at: null, entryName: '东京-01', preset: null }, data()), '日本 · 东京-01', 'with the pool view: where it lands')
  assert.equal(readLabel({ ref: 'r', mode: 'url', entryId: null, masked: 'http://***@h:1', at: null, entryName: null, preset: null }), '自定义 · http://***@h:1')
})

test('Magpie ⋯: 出口… is listed when the pool is there, disabled with the kernel\'s reason when it cannot route', () => {
  const account = { id: 'i', agent: 'codex', user: 'a@x.test', userMasked: 'a•', plan: null, active: false, on: true, first: false, own: false, needsRelogin: false, seen: null, status: 'on', quota: null, canReset: false } as MagpieAccount
  assert.equal(rowMenu(account).some((item) => item.action === 'egress'), false)
  assert.deepEqual(rowMenu(account, { supported: true, reason: null }).find((item) => item.action === 'egress'), { action: 'egress', label: '出口…', danger: false, disabled: null })
  assert.equal(rowMenu(account, { supported: false, reason: '当前内核不会让账号走单独的出口，需要重新构建内核' }).find((item) => item.action === 'egress')?.disabled, '当前内核不会让账号走单独的出口，需要重新构建内核')
  assert.equal(rowMenu(account, { supported: true, reason: null }).at(-1)?.action, 'forget', '移除 stays last')
})
