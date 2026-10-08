// 列表命令的树形视图：渲染器 + 各命令的节点组装（夹具只用占位名，不含真实主机、账号或 Key）。
import assert from 'node:assert/strict'
import test from 'node:test'
import { Readable } from 'node:stream'
import { main } from './cradmin.mjs'
import { publicAccount } from './lib/ops.mjs'
import {
  accountCreditsWords, accountQuotaWords, accountState, accountWindowsTree, accountsTree, channelClass, channelsTree, keyWindowsTree, keysTree,
  modelVendor, modelsTree, providerInfo, usageLedgerTree,
} from './lib/tree.mjs'
import { publicKey } from './lib/commands/keys.mjs'
import { modelRow } from './lib/commands/models.mjs'
import { displayWidth, renderTree } from './lib/ui.mjs'

process.env.TZ = 'Asia/Shanghai'
const NOW = Date.parse('2026-10-09T02:00:00Z')
const ASCII = { treeTee: '|- ', treeEnd: '`- ', treePipe: '|  ', ellipsis: '~' }
const render = (nodes, options) => renderTree(nodes, options)
const lines = text => text.replace(/^\n/, '')

/* ────────── 夹具 ────────── */

const channelRows = [
  { name: 'relay-a', kind: 'compat', state: '启用', enabled: true, stale: false, enabledModels: 12, totalModels: 15, keys: 1, accounts: null, baseUrl: 'https://api.example.com/v1' },
  { name: 'or-mirror', kind: 'compat', state: '启用', enabled: true, stale: false, enabledModels: 3, totalModels: 3, keys: 2, accounts: null, baseUrl: 'https://openrouter.ai/api/v1' },
  { name: 'empty-relay', kind: 'compat', state: '启用', enabled: true, stale: false, enabledModels: 0, totalModels: 2, keys: 1, accounts: null, baseUrl: 'https://api.example.com/v2' },
  { name: 'local-svc', kind: 'compat', state: '停用', enabled: false, stale: false, enabledModels: 0, totalModels: 3, keys: 1, accounts: null, baseUrl: 'http://127.0.0.1:9000/v1' },
  { name: 'gone-relay', kind: 'compat', state: '失效', enabled: false, stale: true, enabledModels: 0, totalModels: 0, keys: null, accounts: null, baseUrl: 'https://api.example.com/v2' },
  { name: 'antigravity', kind: 'oauth', state: '无可用账号', enabled: false, stale: false, enabledModels: 20, totalModels: 24, keys: null, accounts: 2, baseUrl: '' },
  { name: 'claude', kind: 'oauth', state: '启用', enabled: true, stale: false, enabledModels: 8, totalModels: 8, keys: null, accounts: 3, baseUrl: '' },
  { name: 'xai', kind: 'oauth', state: '启用', enabled: true, stale: false, enabledModels: null, totalModels: null, keys: null, accounts: 1, baseUrl: '' },
  { name: 'codex', kind: 'oauth', state: '启用', enabled: true, stale: false, enabledModels: 10, totalModels: 12, keys: null, accounts: 2, baseUrl: '' },
]

const credentials = [
  { name: 'codex-a.json', type: 'codex', label: 'user-a@example.com', disabled: false, status: 'active', modelCount: 12, proxyUrl: '' },
  { name: 'codex-b.json', type: 'codex', label: 'user-b@example.com', disabled: true, status: 'active', modelCount: 12, proxyUrl: 'direct' },
  { name: 'claude-c.json', type: 'claude', label: 'user-c@example.com', disabled: false, status: 'error', modelCount: 8, proxyUrl: '' },
  { name: 'claude-d.json', type: 'claude', label: 'user-d@example.com', disabled: false, status: 'active', modelCount: 8, proxyUrl: '' },
  { name: 'ag-e.json', type: 'antigravity', label: 'user-e@example.com', disabled: false, status: 'active', modelCount: 24, proxyUrl: '' },
  { name: 'ag-f.json', type: 'antigravity', label: 'user-f@example.com', disabled: false, status: 'active', modelCount: 24, proxyUrl: '' },
  { name: 'gem-g.json', type: 'gemini', label: 'user-g@example.com', disabled: false, status: 'refreshing', modelCount: 5, proxyUrl: '' },
]
const monitorAccounts = [
  { name: 'claude-c.json', status: 'error', status_message: '401 unauthorized', priority: 0, auth_index: '1' },
  { name: 'claude-d.json', status: 'active', status_message: '429 rate limit exceeded', next_retry_after: '2026-10-09T03:00:00Z', priority: 0, auth_index: '2',
    normalizedQuota: { windows: [{ id: 'five_hour', label: '5 小时额度', usedPercent: 98, resetsAt: null }, { id: 'seven_day', label: '7 天额度', usedPercent: 40, resetsAt: null }] } },
  { name: 'ag-e.json', status: 'active', priority: 10, auth_index: '3' },
  { name: 'ag-f.json', status: 'active', priority: 0, auth_index: '4' },
]

const src = (channel, enabled = true, kind = 'compat') => ({ channel, kind, enabled, upstreams: 1, channelEnabled: true })
const modelIndex = { models: [
  { id: 'claude-opus-5-5', kind: 'chat', sources: [src('claude', true, 'oauth'), src('antigravity', true, 'oauth')], pricing: { input: 5, output: 25 } },
  { id: 'claude-haiku-4-5', kind: 'chat', sources: [src('claude', false, 'oauth')], pricing: { input: 1, output: 5 } },
  { id: 'gpt-6-astra', kind: 'chat', sources: [src('codex', true, 'oauth')], pricing: { input: 2.5, output: 15 } },
  { id: 'gpt-image-2.5', kind: 'image', sources: [src('codex', true, 'oauth')], pricing: { input: 5, output: 40 } },
  { id: 'relay-a/house-model', kind: 'chat', sources: [src('relay-a')], pricing: null },
  { id: 'qcn-glm-5.3', kind: 'chat', sources: [src('relay-a')], pricing: { input: 0, output: 0 }, pricingSources: { openrouter: { sourceId: 'z-ai/glm-5.3' } } },
  { id: 'veo-3.1-generate-preview', kind: 'video', sources: [], pricing: null, availableOnGateway: false },
] }

const win = (limitUsd, spentUsd, extra = {}) => ({ limitUsd, spentUsd, ratio: limitUsd > 0 ? spentUsd / limitUsd : null, exceeded: limitUsd > 0 && spentUsd >= limitUsd, ...extra })
const unlimited = { limitUsd: 0, spentUsd: 0, ratio: null, exceeded: false }
const keyOf = (name, extra = {}) => ({
  id: name.padEnd(8, '0'), name, maskedKey: `sk-${name}-••••••••0000`, enabled: true, groups: ['codex', 'claude'], totalConcurrency: 0, groupConcurrency: {},
  lastUsedAt: null, blockedReason: null, quotaState: { daily: unlimited, weekly: unlimited, total: unlimited }, ...extra,
})
const keys = [
  keyOf('dave', { quotaState: { daily: win(0, 3.2), weekly: unlimited, total: unlimited }, lastUsedAt: '2026-10-09T01:30:00Z' }),
  keyOf('alice', { totalConcurrency: 4, quotaState: { daily: win(5, 4.6), weekly: win(20, 9), total: unlimited } }),
  keyOf('carol', { enabled: false }),
  keyOf('bob', { enabled: false, blockedReason: '周额度已用完', groups: ['codex'], quotaState: { daily: win(5, 1), weekly: win(20, 20.5), total: win(100, 60.25) } }),
  keyOf('erin', { groups: [] }),
]
const groups = [{ id: 'codex', name: 'codex' }, { id: 'claude', name: 'claude' }]

/* ────────── 渲染器 ────────── */

test('renderTree：两层、同深度按显示宽度对齐（中英混排）、右对齐列', () => {
  const nodes = [
    { cells: ['Anthropic', '2 个'], children: [{ cells: ['claude-opus', { text: '1M', align: 'right' }] }, { cells: ['claude-haiku-4-5', { text: '200K', align: 'right' }] }] },
    { cells: ['智谱', '1 个'], children: [{ cells: ['glm-5', { text: '128K', align: 'right' }] }] },
  ]
  assert.equal(render(nodes), lines(`
├─ Anthropic  2 个
│  ├─ claude-opus         1M
│  └─ claude-haiku-4-5  200K
└─ 智谱       1 个
   └─ glm-5             128K`))
})

test('renderTree：ASCII 字形；同层全空的列整列省掉；行尾空列不留空格；不同 kind 各自对齐', () => {
  const cases = [
    { nodes: [{ cells: ['a'], children: [{ cells: ['b'] }, { cells: ['c'] }] }, { cells: ['d'] }], options: { g: ASCII }, want: '|- a\n|  |- b\n|  `- c\n`- d' },
    { nodes: [{ cells: ['Codex', '', '启用'] }, { cells: ['Antigravity', '', '停用'] }], want: '├─ Codex        启用\n└─ Antigravity  停用' },
    { nodes: [{ cells: ['x', '', 'tail'] }, { cells: ['long-name', 'mid', ''] }], want: '├─ x               tail\n└─ long-name  mid' },
    { nodes: [{ cells: ['API 渠道', '2'], kind: 'a' }, { cells: ['订阅账号池', '3'], kind: 'b' }], want: '├─ API 渠道  2\n└─ 订阅账号池  3' },
    { nodes: [], want: '' },
  ]
  for (const { nodes, options, want } of cases) assert.equal(render(nodes, options), want)
})

test('renderTree：超过 maxWidth 时只截断最后一列', () => {
  const out = render([{ cells: ['relay-a', '启用', 'https://api.example.com/v1/a/very/long/path'] }], { maxWidth: 30 })
  assert.equal(out, '└─ relay-a  启用  https://api…')
  assert.equal(displayWidth(out), 30)
})

/* ────────── 各命令的树 ────────── */

test('channels ls：供应商 → API 渠道（服务端顺序）/ 订阅账号池（控制台 provider 顺序）；残留、降级带原因行，停用不带', () => {
  assert.equal(render(channelsTree(channelRows)), lines(`
├─ API 渠道    5
│  ├─ relay-a      启用  兼容渠道  模型 12/15  1 Key  https://api.example.com/v1
│  ├─ or-mirror    启用  中转网关  模型 3/3    2 Key  https://openrouter.ai/api/v1
│  ├─ empty-relay  降级  兼容渠道  模型 0/2    1 Key  https://api.example.com/v2
│  │  └─ 没有开着的模型
│  ├─ local-svc    停用  本机服务  模型 0/3    1 Key  http://127.0.0.1:9000/v1
│  └─ gone-relay   残留  兼容渠道  模型 0/0    - Key  https://api.example.com/v2
│     └─ 网关里已不存在 · 可清理：cradmin channels prune
└─ 订阅账号池  4
   ├─ Codex        启用        OpenAI · ChatGPT 订阅    模型 10/12  2 账号
   ├─ Claude       启用        Anthropic · Claude 订阅  模型 8/8    3 账号
   ├─ Antigravity  无可用账号  Google · 按模型家族计额  模型 20/24  2 账号
   └─ Grok（xai）  启用        xAI · SuperGrok          模型 -      1 账号`))
})

test('channelClass：残留 → 停用 → 降级（没有开着的模型）→ 启用，词同控制台 classifyChannel', () => {
  const view = row => { const cls = channelClass(row); return [cls.label, cls.reason] }
  assert.deepEqual(view({ stale: true, enabled: true, enabledModels: 3 }), ['残留', '网关里已不存在 · 可清理'])
  assert.deepEqual(view({ stale: false, enabled: false, enabledModels: 0 }), ['停用', '不参与路由'])
  assert.deepEqual(view({ stale: false, enabled: true, enabledModels: 0 }), ['降级', '没有开着的模型'])
  assert.deepEqual(view({ stale: false, enabled: true, enabledModels: 1 }), ['启用', null])
})

test('accounts ls：provider → 账号；没有监控数据时只按凭据分状态', () => {
  const items = credentials.map(credential => ({ row: publicAccount(credential), state: accountState(credential, undefined, NOW), quota: null }))
  assert.equal(render(accountsTree(items, { proxyLabel: value => value || '继承全局' })), lines(`
├─ Codex        OpenAI · ChatGPT 订阅    2 账号 · 1 参与路由
│  ├─ 运行    user-a@example.com  模型 12  继承全局
│  └─ 暂停    user-b@example.com  模型 12  direct
├─ Claude       Anthropic · Claude 订阅  2 账号 · 2 参与路由
│  ├─ 异常    user-c@example.com  模型 8   继承全局
│  └─ 运行    user-d@example.com  模型 8   继承全局
├─ Antigravity  Google · 按模型家族计额  2 账号 · 2 参与路由
│  ├─ 运行    user-e@example.com  模型 24  继承全局
│  └─ 运行    user-f@example.com  模型 24  继承全局
└─ Gemini       其它凭据                 1 账号 · 1 参与路由
   └─ 刷新中  user-g@example.com  模型 5   继承全局`))
})

test('accounts ls --quota：失效 / 冷却带原因行；冷却拿走最后一个可路由账号时升级；优先级领先的是首选', () => {
  const monitorFor = name => monitorAccounts.find(account => account.name === name)
  const items = credentials.filter(credential => credential.type !== 'codex' && credential.type !== 'gemini').map(credential => {
    const row = publicAccount(credential, monitorFor(credential.name) || {})
    const quota = row.quota?.windows?.length ? row.quota.windows.map(window => `${window.label} ${Math.round(window.usedPercent)}%`).join(' · ') : '-'
    return { row, state: accountState(credential, monitorFor(credential.name), NOW), quota }
  })
  assert.equal(render(accountsTree(items, { proxyLabel: value => value || '继承全局' })), lines(`
├─ Claude       Anthropic · Claude 订阅  2 账号 · 0 参与路由
│  ├─ 失效  user-c@example.com         模型 8   继承全局  -
│  │  └─ 401 · 授权失效 · 重新授权后恢复
│  └─ 冷却  user-d@example.com         模型 8   继承全局  5 小时额度 98% · 7 天额度 40%
│     └─ 网关休息中：429 限流 · Retry-After · 唯一可用时仍会被尝试 · Claude 已无可用账号
└─ Antigravity  Google · 按模型家族计额  2 账号 · 2 参与路由 · 按优先级选号
   ├─ 运行  user-e@example.com · 首选  模型 24  继承全局  -
   └─ 运行  user-f@example.com         模型 24  继承全局  -`))
})

test('providerInfo：type 别名归到控制台的 provider，目录外的排在后面', () => {
  assert.deepEqual(['openai', 'anthropic', 'grok', 'muse', 'gemini', ''].map(type => providerInfo(type).name), ['Codex', 'Claude', 'Grok', 'Meta AI', 'Gemini', '其它'])
  assert.equal(providerInfo('gemini').order, providerInfo('somethingelse').order)
})

test('models ls：厂商 → 模型（厂商识别同控制台；按模型数、再按名称；组内在用的在前）', () => {
  const rows = modelIndex.models.map(modelRow)
  const vendors = new Map(modelIndex.models.map(model => [model.id, modelVendor(model)]))
  assert.deepEqual([...vendors.values()], ['anthropic', 'anthropic', 'openai', 'openai', 'other', 'zhipu', 'google'])
  assert.equal(render(modelsTree(rows, vendors)), lines(`
├─ Anthropic  2 个
│  ├─ 启用    claude-opus-5-5                 $5.00 / $25.00  渠道 2/2  多渠道
│  └─ 停用    claude-haiku-4-5                 $1.00 / $5.00  渠道 0/1
├─ OpenAI     2 个
│  ├─ 启用    gpt-6-astra                     $2.50 / $15.00  渠道 1/1
│  └─ 启用    gpt-image-2.5             图片  $5.00 / $40.00  渠道 1/1
├─ Google     1 个
│  └─ 仅目录  veo-3.1-generate-preview  视频          未定价  渠道 0/0
├─ 其他       1 个
│  └─ 启用    relay-a/house-model                     未定价  渠道 1/1
└─ 智谱       1 个
   └─ 启用    qcn-glm-5.3                               免费  渠道 1/1`))
})

test('keys ls：按额度压力排序，状态与渠道范围用控制台的词', () => {
  assert.equal(render(keysTree(keys, groups)), lines(`
├─ 超额停用  bob    sk-bob-…0000    codex              今日 $1.00/$5.00  本周 $20.50/$20.00  累计 $60.25 / $100.00  从未
├─ 接近上限  alice  sk-alice-…0000  全部渠道 · 并发 4  今日 $4.60/$5.00  本周 $9.00/$20.00                          从未
├─ 启用      dave   sk-dave-…0000   全部渠道           今日 $3.20        本周 -                                     2026-10-09 09:30
├─ 停用      carol  sk-carol-…0000  全部渠道           今日 -            本周 -                                     从未
└─ 启用      erin   sk-erin-…0000   无渠道             今日 -            本周 -                                     从未`))
})

/* ────────── 命令级：默认输出是树，--json 不变 ────────── */

const sink = () => {
  const chunks = []
  return { isTTY: false, columns: 0, write: chunk => { chunks.push(String(chunk)); return true }, text: () => chunks.join('') }
}
const json = body => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

async function run(argv, routes) {
  const stdout = sink()
  const stderr = sink()
  const fetch = async (url, init) => {
    const path = new URL(url).pathname
    if (path === '/api/login') return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json', 'set-cookie': `crosery_console_session=${NOW + 3_600_000}.v2.admin.-.0123456789abcdef` } })
    if (path === '/api/logout') return json({ ok: true })
    const body = routes[`${init.method} ${path}`]
    return body ? json(body) : new Response('{"error":"接口不存在"}', { status: 404, headers: { 'content-type': 'application/json' } })
  }
  const code = await main(argv, {
    env: { CONSOLE_PASSWORD: 'unit-pass', CRADMIN_SESSION_CACHE: 'off', CRADMIN_KEYCHAIN: 'off', CRADMIN_HOME: '/nonexistent-cradmin-home', NO_COLOR: '1' },
    stdin: Readable.from([]), stdout, stderr, interactive: false, cwd: '/', home: '/nonexistent-cradmin-home', fetch, platform: 'linux', now: () => NOW,
  })
  return { code, stdout: stdout.text(), stderr: stderr.text() }
}

test('命令级：channels / accounts --quota / models / keys ls 输出树，--json 仍是原来的行数据', async () => {
  const channelsPayload = {
    channels: [{ name: 'relay-a', enabled: true, stale: false, keyCount: 1, baseUrl: 'https://api.example.com/v1', models: [{ id: 'relay-a/house-model', enabled: true }] }],
    credentials,
  }
  const routes = {
    'GET /api/channels': channelsPayload,
    'GET /api/model-index': modelIndex,
    'GET /api/monitor': { accounts: monitorAccounts },
    'GET /api/bootstrap': { keys, groups },
  }
  const cases = [
    { argv: ['channels', 'ls'], want: ['◆ 供应商  API 渠道 1 · 订阅账号池 4', '├─ API 渠道    1', '│  └─ relay-a  启用  兼容渠道', '└─ 订阅账号池  4', '   ├─ Codex'] },
    { argv: ['accounts', 'ls', '--quota'], want: ['◆ 订阅账号池  7 个账号', '├─ Codex', '│     └─ 网关休息中：429 限流', '└─ Gemini'] },
    { argv: ['models', 'ls'], want: ['◆ 模型目录  6 个模型 · 4 个厂商', '├─ Anthropic  2 个'] },
    { argv: ['keys', 'ls'], want: ['◆ 全部 Key  5 把 · 按额度压力排序', '├─ 超额停用  bob'] },
  ]
  for (const { argv, want } of cases) {
    const result = await run(argv, routes)
    assert.equal(result.code, 0, result.stderr)
    for (const text of want) assert.ok(result.stdout.includes(text), `${argv.join(' ')} 缺少 ${text}：\n${result.stdout}`)
    for (const line of result.stdout.split('\n')) assert.ok(!line.endsWith(' '), `行尾有空格：${JSON.stringify(line)}`)
  }

  const accounts = await run(['accounts', 'ls', '--quota', '--json'], routes)
  assert.deepEqual(JSON.parse(accounts.stdout), credentials.map(credential => publicAccount(credential, monitorAccounts.find(account => account.name === credential.name))))
  const models = await run(['models', 'ls', '--json'], routes)
  assert.deepEqual(JSON.parse(models.stdout), modelIndex.models.map(modelRow).filter(row => !row.catalogOnly))
  const listed = await run(['channels', 'ls', '--json'], routes)
  assert.deepEqual(JSON.parse(listed.stdout).map(row => [row.name, row.kind, row.state]), [['relay-a', 'compat', '启用'], ['antigravity', 'oauth', '启用'], ['claude', 'oauth', '启用'], ['codex', 'oauth', '启用'], ['gemini', 'oauth', '无可用账号']])
})

/* ────────── 详情与用量：词照控制台的详情页与「用量 · 总览」 ────────── */

const detailKeys = [
  keyOf('bob', {
    id: 'b0b0000000', enabled: false, groups: ['codex'], totalConcurrency: 4, groupConcurrency: { codex: 2 }, note: '占位备注',
    createdAt: '2026-10-01T04:00:00Z', lastUsedAt: '2026-10-09T01:30:00Z', blockedReason: '周额度已用 $20.50 / $20.00',
    quotaState: { daily: win(5, 1, { resetsAt: '2026-10-09T16:00:00Z' }), weekly: win(20, 20.5, { resetsAt: '2026-10-11T16:00:00Z' }), total: win(100, 60.25) },
  }),
  keyOf('erin', {
    id: 'e1e1000000', groups: [], createdAt: '2026-10-01T04:00:00Z',
    quotaState: { daily: { ...unlimited, spentUsd: 3.2, resetsAt: '2026-10-09T16:00:00Z' }, weekly: { ...unlimited, resetsAt: '2026-10-11T16:00:00Z' }, total: unlimited },
  }),
]
const detailMonitor = { accounts: [
  ...monitorAccounts.filter(account => account.name !== 'claude-d.json'),
  { name: 'claude-d.json', status: 'active', status_message: '429 rate limit exceeded', next_retry_after: '2026-10-09T03:00:00Z', priority: 0, auth_index: '2',
    normalizedQuota: { plan: 'max', resetCredits: { available: 1, applicable: true }, error: 'upstream 503', windows: [
      { id: 'five_hour', label: '5 小时额度', usedPercent: 98, resetsAt: '2026-10-09T07:10:00Z' },
      { id: 'seven_day', label: '7 天额度', usedPercent: 40, resetsAt: '2026-10-14T01:00:00Z' },
    ] } },
] }
const detailChannels = {
  channels: [
    { name: 'relay-a', enabled: true, stale: false, keyCount: 2, baseUrl: 'https://api.example.com/v1', models: [
      { id: 'model-a', enabled: true, upstreams: 2 }, { id: 'model-b', enabled: true, upstreams: 1 }, { id: 'model-c', enabled: false, upstreams: 0 },
    ] },
    { name: 'empty-relay', enabled: true, stale: false, keyCount: 1, baseUrl: 'https://api.example.com/v2', models: [{ id: 'model-c', enabled: false, upstreams: 0 }] },
    { name: 'local-svc', enabled: false, stale: false, keyCount: 1, baseUrl: 'http://127.0.0.1:9000/v1', models: [{ id: 'model-d', enabled: true, upstreams: 1 }] },
  ],
  credentials,
}
const rankRow = (id, label, requests, costUsd, extra = {}) => ({ id, label, requests, errors: Math.round(requests / 90), tokens: requests * 3000, costUsd, ...extra })
const usageReport = {
  window: { days: 7, from: '2026-10-02T02:00:00Z', to: '2026-10-09T02:00:00Z' }, filters: {},
  ledger: {
    requests: 12345, tokens: 35_400_000, costUsd: 123.456, costEstimated: false, hasPartialCost: true, unpricedModels: ['relay-a/house-model'], unpricedRequests: 12,
    errors: 148, errorRate: 0.012, cacheHitRate: 0.45, cacheIdleModels: 1, activeKeys: 3, totalKeys: 5, enabledKeys: 4,
  },
  previous: { requests: 11000, tokens: 36_000_000, costUsd: 100, errorRate: 0.004, cacheHitRate: 0.45, activeKeys: 2 },
  models: [rankRow('gpt-6-astra', 'gpt-6-astra', 9000, 120), rankRow('relay-a/house-model', 'relay-a/house-model', 3345, 0)],
  keys: [rankRow('b0b0000000', 'bob', 9000, 120, { enabled: false }), rankRow('__deleted__', '已删除的 Key', 3345, 0.004, { enabled: null })],
  channels: [rankRow('codex', 'Codex', 9000, 120), rankRow('old-relay', 'old-relay', 3345, 3.45, { removed: true })],
}
const detailRoutes = {
  'GET /api/bootstrap': { keys: detailKeys, groups },
  'GET /api/channels': detailChannels,
  'GET /api/monitor': detailMonitor,
  'GET /api/model-index': modelIndex,
  'GET /api/usage-overview': usageReport,
}

test('keys show 的额度：日 / 周 / 累计，金额与重置同 Key 详情；不限的累计不写金额', () => {
  assert.equal(render(keyWindowsTree(detailKeys[0], NOW)), lines(`
├─ 日     20%  $1 / $5 · ↻ 00:00
├─ 周    102%  $20.50 / $20 · ↻ 周一 00:00
└─ 累计   60%  $60.25 / $100 · 手动重置`))
  assert.equal(render(keyWindowsTree(detailKeys[1], NOW)), lines(`
├─ 日    不限  $3.20 · ↻ 00:00
├─ 周    不限  $0 · ↻ 周一 00:00
└─ 累计  不限`))
})

test('accounts show 的窗口与空状态：今天只写时刻，一周内写星期；不报告额度、没读到、读取失败各有一句', () => {
  assert.equal(render(accountWindowsTree(detailMonitor.accounts.at(-1).normalizedQuota.windows, NOW)), lines(`
├─ 5 小时额度  98%  ↻ 15:10
└─ 7 天额度    40%  ↻ 周三 09:00`))
  const claude = providerInfo('claude')
  const kimi = providerInfo('kimi')
  assert.equal(accountQuotaWords(null, kimi), '上游不报告这类账号的额度窗口')
  assert.equal(accountQuotaWords(null, claude), '额度这次没读到 · 下次刷新再试')
  assert.equal(accountQuotaWords({ error: 'upstream 503', windows: [] }, claude), '额度读取失败 · upstream 503')
  assert.equal(accountQuotaWords({ error: null, windows: [] }, claude), '上游没有返回额度窗口')
  assert.equal(accountCreditsWords({ resetCredits: { available: 2 }, windows: [] }, claude), '2 次')
  assert.equal(accountCreditsWords({ error: null, windows: [] }, claude), '没有可用的重置次数')
  assert.equal(accountCreditsWords(null, claude), '重置次数未读到')
  assert.equal(accountCreditsWords(null, kimi), '该服务没有主动重置')
})

test('usage 汇总：六格同「用量 · 总览」；没有上一个窗口时变化列整列省掉', () => {
  assert.equal(render(usageLedgerTree(usageReport.ledger, usageReport.previous, 7)), lines(`
├─ 请求       12,345  ▲ 12.2%  日均 1,764
├─ Token       35.4M  ▼ 1.7%   每次 2,868
├─ 花费 ≈    $123.46  ▲ 23.5%  未定价 1 个模型 · 12 次不计
├─ 失败率      1.20%  ▲ 0.8pp  148 次失败
├─ 缓存命中    45.0%  · 0.0pp  不支持缓存 1 个模型 · 不计入
└─ 活跃 Key    3 / 5  ▲ 1      已启用 4`))
  const quiet = { requests: 0, tokens: 0, costUsd: 0, errors: 0, errorRate: null, cacheHitRate: null, activeKeys: 0, totalKeys: 2, enabledKeys: 2 }
  assert.equal(render(usageLedgerTree(quiet, null, 1)), lines(`
├─ 请求          0
├─ Token         0
├─ 花费       免费
├─ 失败率        —  0 次失败
├─ 缓存命中      —  没有可缓存的请求
└─ 活跃 Key  0 / 2  已启用 2`))
})

test('命令级：keys / accounts / channels show 与 usage 用控制台的词，--json 不变', async () => {
  const cases = [
    { argv: ['keys', 'show', 'bob'], want: lines(`
  名称      bob
  id        b0b0000000
  Key       sk-bob-••••••••0000
  状态      超额停用
            周额度已用 $20.50 / $20.00 · 调高额度或重置后自动恢复
  渠道      codex
  并发      4 · codex=2
  创建      2026-10-01 周四
  最近使用  2026-10-09 09:30
  备注      占位备注

◆ 额度  花费按额度账本
├─ 日     20%  $1 / $5 · ↻ 00:00
├─ 周    102%  $20.50 / $20 · ↻ 周一 00:00
└─ 累计   60%  $60.25 / $100 · 手动重置
`) },
    { argv: ['accounts', 'show', 'claude-c.json'], want: lines(`
  账号      user-c@example.com
  凭据名    claude-c.json
  服务      Claude
  状态      失效
            401 · 授权失效 · 重新授权后恢复
  模型      8
  出口      继承全局
  重置次数  重置次数未读到

◆ 全部窗口
  额度这次没读到 · 下次刷新再试
`) },
    { argv: ['accounts', 'show', 'claude-d.json'], want: lines(`
  账号      user-d@example.com
  凭据名    claude-d.json
  服务      Claude
  状态      冷却
            网关休息中：429 限流 · Retry-After · 唯一可用时仍会被尝试
  模型      8
  出口      继承全局
  套餐      max
  重置次数  1 次

◆ 全部窗口
├─ 5 小时额度  98%  ↻ 15:10
└─ 7 天额度    40%  ↻ 周三 09:00
  ◇ 显示的是上次读到的额度 · upstream 503
`) },
    { argv: ['channels', 'show', 'relay-a'], want: lines(`
  渠道      relay-a
  类型      兼容渠道
  状态      启用
  地址      https://api.example.com/v1
  Key       2 个

◆ 模型  2 / 3 开着
├─ 开着      model-a  ×2
├─ 开着      model-b
└─ 人工停用  model-c
  改开关：cradmin channels models relay-a --enable <模型> / --disable <模型> / --only <模式>
`) },
    { argv: ['channels', 'show', 'empty-relay'], want: lines(`
  渠道      empty-relay
  类型      兼容渠道
  状态      降级
            没有开着的模型
  地址      https://api.example.com/v2
  Key       1 个

◆ 模型  0 / 1 开着
└─ 人工停用  model-c
  改开关：cradmin channels models empty-relay --enable <模型> / --disable <模型> / --only <模式>
`) },
    { argv: ['channels', 'models', 'local-svc'], want: `! 渠道停用中 · 启用后才能单独开关模型：cradmin channels enable local-svc

◆ local-svc 的模型  1 / 1 开着
└─ 开着  model-d
  改开关：cradmin channels models local-svc --enable <模型> / --disable <模型> / --only <模式>
` },
    { argv: ['channels', 'show', 'claude'], want: lines(`
  渠道      Claude
  类型      订阅账号池 · Anthropic · Claude 订阅
  状态      启用
  账号      2 个

◆ 模型  1 / 2 开着
├─ 人工停用  claude-haiku-4-5
└─ 开着      claude-opus-5-5
  改开关：cradmin channels models claude --enable <模型> / --disable <模型> / --only <模式>
`) },
    { argv: ['usage'], want: `
◆ 用量 · 近 7 天  vs 前 7 日
├─ 请求       12,345  ▲ 12.2%  日均 1,764
├─ Token       35.4M  ▼ 1.7%   每次 2,868
├─ 花费 ≈    $123.46  ▲ 23.5%  未定价 1 个模型 · 12 次不计
├─ 失败率      1.20%  ▲ 0.8pp  148 次失败
├─ 缓存命中    45.0%  · 0.0pp  不支持缓存 1 个模型 · 不计入
└─ 活跃 Key    3 / 5  ▲ 1      已启用 4

◆ 按模型  前 10
  ╭─────────────────────┬───────┬──────┬───────┬─────────╮
  │ 模型                │ 请求  │ 失败 │ Token │ 花费    │
  ├─────────────────────┼───────┼──────┼───────┼─────────┤
  │ gpt-6-astra         │ 9,000 │  100 │   27M │ $120.00 │
  │ relay-a/house-model │ 3,345 │   37 │   10M │       — │
  ╰─────────────────────┴───────┴──────┴───────┴─────────╯

◆ 按 Key  前 10
  ╭──────────────┬───────┬──────┬───────┬─────────╮
  │ Key          │ 请求  │ 失败 │ Token │ 花费    │
  ├──────────────┼───────┼──────┼───────┼─────────┤
  │ bob · 已停用 │ 9,000 │  100 │   27M │ $120.00 │
  │ 已删除的 Key │ 3,345 │   37 │   10M │  <$0.01 │
  ╰──────────────┴───────┴──────┴───────┴─────────╯

◆ 按渠道  前 10
  ╭────────────────────┬───────┬──────┬───────┬─────────╮
  │ 渠道               │ 请求  │ 失败 │ Token │ 花费    │
  ├────────────────────┼───────┼──────┼───────┼─────────┤
  │ Codex              │ 9,000 │  100 │   27M │ $120.00 │
  │ old-relay · 已移除 │ 3,345 │   37 │   10M │   $3.45 │
  ╰────────────────────┴───────┴──────┴───────┴─────────╯
` },
  ]
  for (const { argv, want } of cases) {
    const result = await run(argv, detailRoutes)
    assert.equal(result.code, 0, result.stderr)
    assert.equal(result.stdout, want, argv.join(' '))
  }

  const key = await run(['keys', 'show', 'bob', '--json'], detailRoutes)
  assert.deepEqual(JSON.parse(key.stdout), publicKey(detailKeys[0]))
  const account = await run(['accounts', 'show', 'claude-d.json', '--json'], detailRoutes)
  assert.deepEqual(JSON.parse(account.stdout), publicAccount(credentials.find(item => item.name === 'claude-d.json'), detailMonitor.accounts.at(-1)))
  const channel = await run(['channels', 'show', 'empty-relay', '--json'], detailRoutes)
  assert.deepEqual(JSON.parse(channel.stdout), {
    name: 'empty-relay', kind: 'compat', state: '启用', enabled: true, stale: false, baseUrl: 'https://api.example.com/v2', keyCount: 1, models: [{ id: 'model-c', enabled: false }],
  })
  const usage = await run(['usage', '--json'], detailRoutes)
  const rank = list => list.map(({ id, label, requests, errors, tokens, costUsd }) => ({ id, label, requests, errors, tokens, costUsd }))
  assert.deepEqual(JSON.parse(usage.stdout), {
    window: usageReport.window, filters: usageReport.filters, ledger: usageReport.ledger, previous: usageReport.previous,
    models: rank(usageReport.models), keys: rank(usageReport.keys), channels: rank(usageReport.channels),
  })
})
