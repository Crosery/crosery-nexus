import assert from 'node:assert/strict'
import test from 'node:test'
import {
  accountExit, accountGroups, assignFacts, defaultLine, exitView, firstRunNote, groupRows, healthCell, importRows, indexValue, kernelLine,
  maskIp, matchesQuery, migrationBanner, previewCountLine, restorePlan, summaryLine, tagOptions, toRows,
} from '../src/features/proxy/proxyModel.js'
import type { ProxyAccountRow, ProxyEntryView, ProxyPoolData, ProxyPreview, ProxyPreviewRow } from '../src/types.js'

/** 代理 section view model (src/features/proxy/proxyModel.ts): wording only, every value is already masked. */

const at = '2026-10-02T10:00:00.000Z'
function entry(over: Partial<ProxyEntryView> = {}): ProxyEntryView {
  return {
    id: 'px_aaaaaaaaaa', name: 'gate.example', nameAuto: true, kind: 'url', protocol: 'http', display: 'http://***@gate.example:7000',
    server: 'gate.example', serverPort: 7000, port: null, scope: 'anywhere', assignable: true, unassignableReason: null, source: 'migrated',
    subscriptionId: null, stale: false, external: false, tags: [], enabled: true, validity: 'ok', invalidReason: null,
    usedBy: { total: 0, byProvider: {} }, health: null, createdAt: at, updatedAt: at, ...over,
  }
}

function pool(over: Partial<ProxyPoolData> = {}): ProxyPoolData {
  return {
    backend: 'cpa', cpaSameHost: true, kernel: { state: 'running', version: '1.19.31' }, ports: { base: 27890, count: 1000, last: 28889, listenerAuth: true },
    readOnly: null, summary: { entries: 0, enabled: 0, mihomo: 0, needsKernel: 0, inUse: 0, accountsLinked: 0, invalid: 0, subscriptions: 0 },
    entries: [], subscriptions: [], migration: { firstRunAt: null, firstRunImported: null, lastScanAt: null, pending: null, ignored: 0 },
    default: { mode: 'inherit', entryId: null, masked: null, at: null }, signinNote: '', ...over,
  }
}

test('health cells: ✓ with latency, ✗ with the reason, — when never checked; hosts go to the title', () => {
  assert.deepEqual(healthCell(null), { ok: null, text: '', title: '还没有检测' })
  const ok = healthCell({ state: 'auth-expected', ms: 230, at, hosts: [{ host: 'api.anthropic.com', state: 'auth-expected', ms: 230, status: 401 }] })
  assert.equal(ok.ok, true)
  assert.equal(ok.text, '230ms')
  assert.equal(ok.title, 'api.anthropic.com · 正常 401 · 230ms')
  const bad = healthCell({ state: 'region-blocked', ms: null, at, hosts: [] })
  assert.deepEqual([bad.ok, bad.text], [false, '地区限制'])
  assert.equal(healthCell({ state: 'something-new', ms: null, at, hosts: [] }).text, 'something-new')
})

test('exit: ip + country, or the failure word; ips mask for screenshots', () => {
  assert.deepEqual(exitView({ exit: { ip: '203.0.113.7', country: 'US', state: 'ok', at }, services: {} }), { ip: '203.0.113.7', country: 'US', failure: null })
  assert.deepEqual(exitView({ exit: { state: 'timeout', at }, services: {} }), { ip: null, country: null, failure: '超时' })
  assert.deepEqual(exitView(null), { ip: null, country: null, failure: null })
  assert.equal(maskIp('203.0.113.7'), '203.0.•••')
  assert.equal(maskIp('2001:db8::1'), '2001:db8:•••')
})

test('rows: flags, local port, twins told apart, a subscription name is not repeated as a tag', () => {
  const rows = toRows([
    entry({ id: 'px_aaaaaaaaa1', name: 'gate.example' }),
    entry({ id: 'px_aaaaaaaaa2', name: 'gate.example', enabled: false, external: true }),
    entry({ id: 'px_bbbbbbbbbb', name: '香港', kind: 'mihomo', protocol: 'vmess', port: 27891, source: 'subscription', subscriptionId: 'sub_aaaaaaaaaa', tags: ['Air', '香港'], stale: true, validity: 'invalid' }),
  ], [{ id: 'sub_aaaaaaaaaa', name: 'Air', maskedUrl: 'https://sub/***', intervalH: 12, lastFetchAt: null, nextAt: null, failures: 0, error: null, info: null, nodeCount: 1 }])
  assert.deepEqual(rows.map(row => row.twin), ['#aaa1', '#aaa2', null])
  assert.deepEqual(rows[1].flags.map(flag => flag.label), ['已停用', '外部本机'])
  assert.deepEqual(rows[2].flags.map(flag => flag.label), ['配置无效', '订阅中已移除'])
  assert.equal(rows[2].portLabel, ':27891')
  assert.deepEqual(rows[2].shownTags, ['香港'])
  assert.deepEqual(rows[2].tags, ['Air', '香港'], 'filters still see every tag')
  const groups = groupRows(rows, [{ id: 'sub_aaaaaaaaaa', name: 'Air', maskedUrl: '', intervalH: 12, lastFetchAt: null, nextAt: null, failures: 0, error: null, info: null, nodeCount: 1 }])
  assert.deepEqual(groups.map(group => [group.head, group.rows.length]), [['从账号迁移', 2], ['订阅 · Air', 1]])
  assert.equal(matchesQuery(rows[2], '香港'), true)
  assert.equal(matchesQuery(rows[0], 'vmess'), false)
  assert.deepEqual(tagOptions([entry({ tags: ['a', 'b'] }), entry({ tags: ['b'] })]).map(item => [item.value, item.count]), [['b', 2], ['a', 1]])
})

test('head: summary, kernel words, banner, first-run note, default exit, settings index', () => {
  const data = pool({ summary: { entries: 12, enabled: 11, mihomo: 6, needsKernel: 0, inUse: 6, accountsLinked: 37, invalid: 0, subscriptions: 1 } })
  assert.equal(summaryLine(data), '12 个出口 · 37 个账号在用 · 1 个订阅')
  assert.deepEqual(kernelLine({ state: 'running', version: 'v1.19.31' }), { state: 'run', label: '运行中 v1.19.31', detail: '', action: null })
  assert.equal(kernelLine({ state: 'unavailable' }).label, '未安装')
  assert.match(kernelLine({ state: 'unavailable' }).detail, /MIHOMO_BIN/)
  assert.equal(kernelLine({ state: 'unavailable', reason: '未找到 mihomo（设置 MIHOMO_BIN 后重启控制台）' }).label, '未安装')
  // the relay runs the console as root: mihomo is installed but refused, and the page must say why instead of "install it"
  assert.deepEqual(kernelLine({ state: 'unavailable', reason: '控制台以 root 运行：拒绝以 root 启动 mihomo' }), {
    state: 'idle', label: '不可用', detail: '加密节点可保存但不可用 · 控制台以 root 运行：拒绝以 root 启动 mihomo', action: null,
  })
  assert.equal(kernelLine({ state: 'failed', reason: '内核反复退出' }).action, 'restart')
  assert.equal(kernelLine({ state: 'stopped' }).action, 'start')
  assert.equal(migrationBanner({ ...data.migration, pending: { exits: 4, accounts: 9, at } }), '发现 9 个账号的代理还没进代理池（4 个出口）')
  assert.equal(migrationBanner(data.migration), null)
  const now = Date.parse(at)
  assert.match(firstRunNote({ ...data.migration, firstRunAt: at, firstRunImported: 5 }, now + 3_600_000) ?? '', /已从现有账号导入 5 个出口/)
  assert.equal(firstRunNote({ ...data.migration, firstRunAt: at, firstRunImported: 5 }, now + 4 * 86_400_000), null)
  assert.equal(defaultLine(data), '未设置')
  assert.equal(defaultLine(pool({ default: { mode: 'unsupported', entryId: null, masked: null, at: null } })), null)
  assert.equal(defaultLine(pool({ entries: [entry({ id: 'px_cccccccccc', name: '东京' })], default: { mode: 'url', entryId: 'px_cccccccccc', masked: 'x', at } })), '东京')
  assert.deepEqual(indexValue(data), { value: '12 出口', hot: false })
  assert.deepEqual(indexValue(pool({ migration: { ...data.migration, pending: { exits: 2, accounts: 3, at } } })), { value: '◇ 2', hot: true })
  assert.deepEqual(indexValue(pool({ kernel: { state: 'degraded' } })), { value: '◆ 内核', hot: true })
})

test('preview: count line and the rows the primary button imports (excluded / failed subscriptions drop out)', () => {
  const row = (key: string, status: ProxyPreviewRow['status'], subscriptionKey: string | null = null): ProxyPreviewRow => ({
    key, name: key, type: 'trojan', protocol: 'trojan', kind: 'mihomo', server: 'h', serverPort: 443, external: false, status, reason: null, entryId: null, duplicateOf: null, subscriptionKey,
  })
  const preview: ProxyPreview = {
    previewId: 'p', expiresAt: at, format: 'clash', counts: { new: 3, update: 1, duplicate: 2, unsupported: 1, invalid: 0, info: 1 }, byProtocol: { trojan: 7 },
    needsKernel: 4, kernelAvailable: false, ignoredSections: [], notes: [],
    rows: [row('a', 'new'), row('b', 'update'), row('c', 'new', 's1'), row('d', 'new', 's2'), row('e', 'duplicate'), row('f', 'info')],
    subscriptions: [
      { key: 's1', name: 'one', maskedUrl: '', source: 'pasted', ok: true, error: null, nodeCount: 1, info: null, intervalH: 12, insecureHttp: false, existingId: null },
      { key: 's2', name: 'two', maskedUrl: '', source: 'provider', ok: false, error: 'x', nodeCount: 0, info: null, intervalH: 12, insecureHttp: false, existingId: null },
    ],
    assignments: 0,
  }
  assert.equal(previewCountLine(preview), '新 3 · 更新 1 · 已存在 2 · 不支持 1 · 提示行 1')
  assert.deepEqual(importRows(preview, new Set()).map(item => item.key), ['a', 'b', 'c'])
  assert.deepEqual(importRows(preview, new Set(['s1'])).map(item => item.key), ['a', 'b'])
})

test('assign: accounts by provider (global and other entries filtered), current exit in words, confirm facts', () => {
  const account = (over: Partial<ProxyAccountRow>): ProxyAccountRow => ({
    ref: 'cpa:a.json', kind: 'credential', provider: 'claude', name: 'a.json', label: 'a@example.test', disabled: false, mode: 'inherit',
    masked: null, entryId: null, entryName: null, observedAt: null, assignable: true, restorable: false, ...over,
  })
  const rows = [
    account({}),
    account({ ref: 'cpa:b.json', name: 'b.json', label: 'b@example.test', mode: 'url', masked: 'socks5://***@h:1', entryId: 'px_aaaaaaaaaa', entryName: '东京' }),
    account({ ref: 'cpa:c.json', provider: 'codex', name: 'c.json', label: 'c@example.test', mode: 'direct' }),
    account({ ref: 'cpa:global', kind: 'global', provider: 'global', name: 'CPA 全局' }),
  ]
  assert.deepEqual(accountGroups(rows).map(group => [group.label, group.rows.length]), [['Claude', 2], ['Codex', 1]])
  assert.deepEqual(accountGroups(rows, { entryId: 'px_aaaaaaaaaa' }).map(group => group.rows.map(row => row.ref)), [['cpa:b.json']])
  assert.deepEqual(accountGroups(rows, { query: 'c@' }).map(group => group.label), ['Codex'])
  assert.deepEqual(rows.slice(0, 3).map(accountExit), ['继承全局', '东京', '直连'])
  assert.deepEqual(assignFacts(rows.slice(0, 2), '首尔'), [{ k: '账号', v: '2 个' }, { k: '原出口', v: '继承全局 1 · 东京 1' }, { k: '新出口', v: '首尔' }])
})

test('export-file restore: pending accounts this console can write, one group per exit; missing / read-only / linked counted', () => {
  const account = (ref: string, assignable = true): ProxyAccountRow => ({
    ref, kind: 'credential', provider: 'claude', name: ref.slice(4), label: '', disabled: false, mode: 'inherit',
    masked: null, entryId: null, entryName: null, observedAt: null, assignable, restorable: false,
  })
  const item = (accountRef: string, entryId: string, status: 'linked' | 'pending' = 'pending') => ({ account: 'cpa:***', accountRef, entryId, status })
  const plan = restorePlan(
    [item('cpa:a.json', 'px_1'), item('cpa:b.json', 'px_2'), item('cpa:c.json', 'px_1'), item('cpa:gone.json', 'px_1'), item('cpa:ro.json', 'px_2'), item('cpa:d.json', 'px_1', 'linked')],
    [account('cpa:a.json'), account('cpa:b.json'), account('cpa:c.json'), account('cpa:ro.json', false), account('cpa:d.json')],
  )
  assert.deepEqual(plan, { groups: [{ entryId: 'px_1', refs: ['cpa:a.json', 'cpa:c.json'] }, { entryId: 'px_2', refs: ['cpa:b.json'] }], accounts: 3, missing: 2, linked: 1 })
})
