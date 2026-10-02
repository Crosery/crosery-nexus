import assert from 'node:assert/strict'
import test from 'node:test'
import {
  catalogTiles, findCatalogItem, findSignedIn, groupFacts, groupsOf, headSummary, quotaLine, resetIn, rowMenu,
  rowStatus, shortUrl, shortWindowLabel,
} from '../src/features/accounts/magpieModel.js'
import type { AccountsCatalog, AccountsData, MagpieAccount, MagpieAccountQuota, MagpieCatalogItem } from '../src/types.js'

/* /accounts in the magpie backend: the pure mapping behind MagpieAccountsPage / CatalogSheet. */

const NOW = Date.parse('2026-10-02T08:00:00Z')

function quota(patch: Partial<MagpieAccountQuota> = {}): MagpieAccountQuota {
  return {
    asOf: '2026-10-02T07:58:00.000Z', stale: false, error: null, errorCode: null, windows: [], balance: null, until: null,
    renew: null, resets: null, resetPending: false, ...patch,
  }
}

function account(patch: Partial<MagpieAccount> = {}): MagpieAccount {
  return {
    id: '0123456789abcdef', agent: 'codex', user: 'zhang.wei@example.com', userMasked: 'zh••••••i@•••', plan: 'Plus',
    active: false, on: false, first: false, own: false, needsRelogin: false, seen: null, status: 'off', quota: null, canReset: false,
    ...patch,
  }
}

const win = (label: string, usedPercent: number, resetsAt: string | null = null) => ({
  id: `0:${label}`, label, usedPercent, resetsAt, windowSeconds: null, severity: 'normal' as const, scope: null,
})

test('status words follow Magpie: 使用中 / 首选 / 已启用 / 已停用 / 需重新登录 / 已用尽', () => {
  assert.deepEqual(rowStatus(account({ active: true, on: true })), { kind: 'run', word: '使用中', attention: false })
  assert.deepEqual(rowStatus(account({ active: true, on: true, first: true })), { kind: 'run', word: '首选', attention: false })
  assert.deepEqual(rowStatus(account({ on: true })), { kind: 'pause', word: '已启用', attention: false })
  assert.deepEqual(rowStatus(account()), { kind: 'off', word: '已停用', attention: false })
  assert.deepEqual(rowStatus(account({ needsRelogin: true, active: true })), { kind: 'bad', word: '需重新登录', attention: true })
  assert.equal(rowStatus(account({ quota: quota({ errorCode: 'signed_out', error: '登录已失效，请重新添加' }) })).word, '需重新登录')
  assert.equal(rowStatus(account({ active: true, on: true, quota: quota({ windows: [win('5 hours', 100)] }) })).word, '已用尽')
  // an account that is off is 已停用 even with an empty window
  assert.equal(rowStatus(account({ quota: quota({ windows: [win('5 hours', 100)] }) })).word, '已停用')
})

test('window names shorten, the full name stays the title', () => {
  assert.equal(shortWindowLabel('5 hours'), '5h')
  assert.equal(shortWindowLabel('7 days'), '7d')
  assert.equal(shortWindowLabel('7 days · Opus'), '7d Opus')
  assert.equal(shortWindowLabel('1 day'), '1d')
  assert.equal(shortWindowLabel('Weekly'), '周')
  assert.equal(shortWindowLabel('Premium requests'), '高级请求')
  assert.equal(shortWindowLabel('gemini-2.5-pro'), 'gemini-2.5-pro')
})

test('reset hint: minutes, hours, days; only once a window is ≥ 80 %', () => {
  assert.equal(resetIn('2026-10-02T08:30:00Z', NOW), '30m 后重置')
  assert.equal(resetIn('2026-10-02T11:00:00Z', NOW), '3h 后重置')
  assert.equal(resetIn('2026-10-06T08:00:00Z', NOW), '4d 后重置')
  assert.equal(resetIn('2026-10-02T08:00:30Z', NOW), '即将重置')
  assert.equal(resetIn(null, NOW), null)
  const line = quotaLine(account({ on: true, quota: quota({ windows: [win('5 hours', 62, '2026-10-02T11:00:00Z'), win('7 days', 84, '2026-10-02T11:00:00Z'), win('7 days · Opus', 10)] }) }), NOW)
  assert.equal(line.kind, 'bars')
  if (line.kind !== 'bars') return
  assert.deepEqual(line.bars.map((b) => [b.short, b.pct, b.hot, b.reset]), [['5h', 62, false, null], ['7d', 84, true, '3h 后重置']])
  assert.deepEqual(line.more.map((b) => b.label), ['7 days · Opus'])
})

test('quota line: relogin beats bars; error, balance, devin and not-yet-read have their own text', () => {
  assert.deepEqual(quotaLine(account({ needsRelogin: true, quota: quota({ windows: [win('5 hours', 10)] }) }), NOW), { kind: 'relogin', text: '登录已失效' })
  assert.deepEqual(quotaLine(account({ quota: quota({ error: '暂时无法获取用量', errorCode: 'unavailable' }) }), NOW), { kind: 'error', text: '暂时无法获取用量', signedOut: false })
  assert.deepEqual(quotaLine(account({ quota: quota({ balance: '$12.00' }) }), NOW), { kind: 'text', text: '余额 $12.00' })
  assert.deepEqual(quotaLine(account({ agent: 'devin' }), NOW), { kind: 'text', text: '不报告用量' })
  assert.deepEqual(quotaLine(account(), NOW), { kind: 'text', text: '用量读取中' })
  assert.deepEqual(quotaLine(account({ quota: quota() }), NOW), { kind: 'text', text: '暂无用量数据' })
  // the previous numbers after a failed read are still bars, marked stale
  const stale = quotaLine(account({ quota: quota({ stale: true, windows: [win('5 hours', 40)] }) }), NOW)
  assert.equal(stale.kind === 'bars' && stale.stale, true)
})

test('⋯ menu: every action listed; what cannot run is disabled with its reason', () => {
  const menuOf = (a: MagpieAccount) => Object.fromEntries(rowMenu(a).map((item) => [item.action, item.disabled]))
  // the active codex account: already first, cannot be turned off or removed
  const active = menuOf(account({ active: true, on: true, first: true }))
  assert.deepEqual(active, { first: '已经是首选', off: '首选账号不能停用', reset: '用量还没读到', forget: '先把其它账号设为首选' })
  // a standby one: everything runs; reset only with a credit
  assert.deepEqual(menuOf(account({ on: true, quota: quota() })), { first: null, off: null, reset: '没有可用的重置', forget: null })
  assert.equal(menuOf(account({ on: true, canReset: true, quota: quota({ resets: { count: 2, until: null } }) })).reset, null)
  assert.equal(rowMenu(account({ on: true, canReset: true, quota: quota({ resets: { count: 2, until: null } }) })).find((i) => i.action === 'reset')?.label, '使用重置 · 剩 2 次')
  // off → 同时启用
  assert.deepEqual(menuOf(account({ agent: 'copilot' })), { first: null, on: null, forget: null })
  // lapsed: re-login is offered, using / first wait for it
  const lapsed = menuOf(account({ agent: 'copilot', needsRelogin: true }))
  assert.deepEqual(lapsed, { first: '先重新登录', on: '先重新登录', relogin: null, forget: null })
  // Magpie lets other agents forget the account they use (only claude / codex refuse)
  assert.equal(menuOf(account({ agent: 'zcode', active: true, on: true })).forget, null)
  assert.equal(rowMenu(account()).at(-1)?.danger, true)
})

const data = (patch: Partial<AccountsData> = {}): AccountsData => ({
  backend: 'magpie', available: true, reason: null, message: null, revision: '3fe2ff9', routing: false,
  routingNote: '已登录的账号暂不参与网关路由（下一轮接入）', excluded: [], signingIn: [], quotaAsOf: null,
  providers: [
    { agent: 'claude', name: 'Claude', icon: 'claude-color', single: false, counts: { total: 0, on: 0, attention: 0 }, accounts: [] },
    {
      agent: 'codex', name: 'ChatGPT', icon: 'openai', single: false, counts: { total: 2, on: 2, attention: 1 },
      accounts: [account({ id: 'a', on: true, plan: 'Plus' }), account({ id: 'b', user: 'Li.Na@example.com', active: true, on: true, plan: 'Pro', needsRelogin: true })],
    },
  ],
  counts: { accounts: 2, providers: 1, attention: 1 },
  ...patch,
})

test('page: groups only with accounts, active first; head line; the new account by agent + user', () => {
  const groups = groupsOf(data())
  assert.deepEqual(groups.map((g) => g.agent), ['codex'])
  assert.deepEqual(groups[0].accounts.map((a) => a.id), ['b', 'a'])
  assert.equal(groupFacts(groups[0]), 'Pro · Plus · 2 个 · 2 个启用')
  assert.deepEqual(headSummary(data()), { text: '2 个 · 来自 Magpie', attention: '1 个需重新登录' })
  assert.deepEqual(headSummary(data({ counts: { accounts: 0, providers: 0, attention: 0 } })), { text: '0 个 · 来自 Magpie', attention: null })
  assert.deepEqual(headSummary({ ...data(), backend: 'magpie-unavailable', counts: null }), { text: '来自 Magpie', attention: null })
  assert.deepEqual(groupsOf({ ...data(), backend: 'cpa' }), [])
  assert.equal(findSignedIn(data(), 'codex', 'li.na@EXAMPLE.com')?.id, 'b')
  assert.equal(findSignedIn(data(), 'claude', 'li.na@example.com'), null)
  assert.equal(findSignedIn(data(), 'codex', null), null)
})

const item = (patch: Partial<MagpieCatalogItem> = {}): MagpieCatalogItem => ({
  agent: 'codex', name: 'ChatGPT', shortName: 'ChatGPT', icon: 'openai', vendor: 'OpenAI', plans: 'Plus · Pro · Business', own: false,
  single: false, risk: null, sites: [], completion: 'relay', deviceCode: false, pasteCallback: true, gated: false, signedIn: 0, ...patch,
})

test('catalog tiles: gated agents disabled with the reason, risk / host-only / signed-in / signing-in marks', () => {
  const catalog: AccountsCatalog = {
    backend: 'magpie', available: true, reason: null, copy: {},
    items: [
      item({ signedIn: 2 }),
      item({ agent: 'cursor', name: 'Cursor', shortName: 'Cursor', completion: 'cli', gated: true }),
      item({ agent: 'antigravity', name: 'Antigravity', shortName: 'Antigravity', risk: { title: 'Antigravity 账号可能被封禁', note: 'x' } }),
      item({ agent: 'zed', name: 'Zed', shortName: 'Zed', completion: 'local' }),
    ],
  }
  const tiles = catalogTiles(catalog, [{ agent: 'zed' }])
  assert.deepEqual(tiles.map((t) => [t.item.agent, t.disabled, t.note, t.risk, t.signedIn, t.hostOnly, t.signingIn]), [
    ['codex', null, 'Plus · Pro · Business', false, 2, false, false],
    ['cursor', '需在服务器上开启', '需在服务器上开启', false, 0, false, false],
    ['antigravity', null, 'Plus · Pro · Business', true, 0, false, false],
    ['zed', null, '仅限本机 · Plus · Pro · Business', false, 0, true, true],
  ])
  assert.equal(findCatalogItem(catalog, 'zed')?.name, 'Zed')
  assert.equal(findCatalogItem(catalog, 'kimi'), null)
  // the CPA backend's catalog and an unavailable kernel offer nothing here
  assert.deepEqual(catalogTiles({ ...catalog, backend: 'cpa' }), [])
  assert.deepEqual(catalogTiles({ ...catalog, backend: 'magpie-unavailable', available: false }), [])
})

test('the login link shows host + path; the query (state, challenge) is never on screen', () => {
  const shown = shortUrl('https://auth.openai.com/oauth/authorize?client_id=app_x&state=SECRETSTATE&code_challenge=abc')
  assert.equal(shown, 'auth.openai.com/oauth/authorize?…')
  assert.doesNotMatch(shown, /SECRETSTATE|challenge/)
  assert.equal(shortUrl('https://github.com/login/device'), 'github.com/login/device')
  assert.equal(shortUrl('https://example.com/'), 'example.com')
})
