// 命令层：main() + 假 fetch（不起服务端），覆盖只靠路由形状就能验证的分支。
import assert from 'node:assert/strict'
import test from 'node:test'
import { Readable } from 'node:stream'
import { main } from './cradmin.mjs'

const NOW = Date.now()
const token = (ms = 3_600_000) => `${NOW + ms}.v2.admin.-.0123456789abcdef`
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
const sink = () => {
  const chunks = []
  return { isTTY: false, columns: 0, write: chunk => { chunks.push(String(chunk)); return true }, text: () => chunks.join('') }
}

async function run(argv, routes, { platform = 'linux', execute, extra = {} } = {}) {
  const calls = []
  const stdout = sink()
  const stderr = sink()
  const fetch = async (url, init) => {
    const parsedUrl = new URL(url)
    const call = { method: init.method, path: parsedUrl.pathname, search: parsedUrl.search, cookie: init.headers.cookie || '', body: init.body ? JSON.parse(init.body) : undefined }
    calls.push(call)
    if (call.path === '/api/login') return json(200, { ok: true }, { 'set-cookie': `crosery_console_session=${routes.loginToken?.() ?? token()}` })
    if (call.path === '/api/logout') return json(200, { ok: true })
    const handler = routes[`${call.method} ${call.path}`]
    if (!handler) return json(404, { error: '接口不存在' })
    const [status, body] = handler(call)
    return json(status, body)
  }
  const code = await main(argv, {
    env: { CONSOLE_PASSWORD: 'unit-pass', CRADMIN_SESSION_CACHE: 'off', CRADMIN_KEYCHAIN: 'off', CRADMIN_HOME: '/nonexistent-cradmin-home', NO_COLOR: '1' },
    stdin: Readable.from([]), stdout, stderr, interactive: false, cwd: '/', home: '/nonexistent-cradmin-home', fetch, platform,
    ...(execute ? { execute } : {}), ...extra,
  })
  return { code, stdout: stdout.text(), stderr: stderr.text(), calls }
}

test('rtk on：已经是 on 时不确认、不发请求', async () => {
  const result = await run(['rtk', 'on'], { 'GET /api/rtk/global': () => [200, { on: true, writable: true }] })
  assert.equal(result.code, 0, result.stderr)
  assert.match(result.stdout, /RTK 已是 on/)
  assert.ok(!result.calls.some(call => call.method === 'POST' && call.path === '/api/rtk/global'))
})

test('keys create --json：额度没设上时 stdout 仍给出完整 Key（JSON），退出非 0', async () => {
  const id = 'a'.repeat(64)
  const result = await run(['keys', 'create', '--name', 'k', '--groups', 'g', '--daily-usd', '5', '--json'], {
    'GET /api/bootstrap': () => [200, { keys: [], groups: [{ id: 'g' }] }],
    'POST /api/keys': () => [201, { key: 'sk-k-0123456789abcdef0123456789abcdef', item: { id, name: 'k', enabled: true } }],
    [`PATCH /api/keys/${id}/quota`]: () => [400, { error: '额度保存失败' }],
  })
  assert.equal(result.code, 1)
  const parsed = JSON.parse(result.stdout)
  assert.equal(parsed.key, 'sk-k-0123456789abcdef0123456789abcdef')
  assert.equal(parsed.incomplete, true)
})

test('login：钥匙串里的会话已失效（/api/session 回 200 authenticated:false）→ 删缓存、重新登录一次', async () => {
  const stale = token()
  const renewed = token(7_200_000)
  const runs = []
  const execute = (_file, args) => {
    runs.push(args[0] === '-i' ? 'write' : args[0])
    if (args[0] === 'find-generic-password' && args.includes('com.crosery.cradmin.session')) return `${stale}\n`
    if (args[0] === 'find-generic-password') { const error = new Error('x'); error.status = 44; throw error }
    return ''
  }
  const result = await run(['login', '--json'], {
    loginToken: () => renewed,
    'GET /api/session': call => [200, call.cookie.includes(renewed) ? { authenticated: true, role: 'admin' } : { authenticated: false }],
  }, { platform: 'darwin', execute, extra: { env: { CONSOLE_PASSWORD: 'unit-pass', CRADMIN_HOME: '/nonexistent-cradmin-home', NO_COLOR: '1' } } })
  assert.equal(result.code, 0, result.stderr)
  assert.equal(result.calls.filter(call => call.path === '/api/login').length, 1)
  assert.ok(runs.includes('delete-generic-password'), '失效的缓存条目被删除')
  assert.equal(JSON.parse(result.stdout).cached, true)
})

test('login --save --dry-run：不写钥匙串', async () => {
  let spawned = 0
  const result = await run(['login', '--save', '--dry-run'], {}, {
    platform: 'darwin', extra: { spawnSync: () => { spawned += 1; return { status: 0 } } },
    execute: () => { const error = new Error('x'); error.status = 44; throw error },
  })
  assert.equal(result.code, 0, result.stderr)
  assert.equal(spawned, 0)
  assert.match(result.stdout, /不会写钥匙串/)
})

test('keys rotate：停用的旧 Key 轮换出的新 Key 也是停用；同一天再轮换，旧名不重复', async () => {
  const oldId = 'b'.repeat(64)
  const newId = 'c'.repeat(64)
  const today = new Date(NOW)
  const day = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  const result = await run(['keys', 'rotate', 'k', '--yes', '--json'], {
    'GET /api/bootstrap': () => [200, {
      groups: [{ id: 'g' }],
      keys: [
        { id: oldId, name: 'k', note: '', enabled: false, blockedReason: '', groups: ['g'], totalConcurrency: 0, groupConcurrency: {}, quota: { totalUsd: 0, dailyUsd: 0, weeklyUsd: 0 } },
        { id: 'd'.repeat(64), name: `k（已轮换 ${day}）`, note: '', enabled: false, blockedReason: '', groups: ['g'], totalConcurrency: 0, groupConcurrency: {}, quota: {} },
      ],
    }],
    'POST /api/keys': () => [201, { key: 'sk-k-0123456789abcdef0123456789abcdef', item: { id: newId, name: 'k', enabled: true } }],
    [`PATCH /api/keys/${newId}`]: call => [200, { item: { id: newId, name: 'k', enabled: call.body.enabled } }],
    [`PATCH /api/keys/${oldId}`]: call => [200, { item: { id: oldId, ...call.body } }],
  })
  assert.equal(result.code, 0, result.stderr)
  const patches = result.calls.filter(call => call.method === 'PATCH').map(call => [call.path.slice(-4), call.body])
  assert.deepEqual(patches, [['cccc', { enabled: false }], ['bbbb', { name: `k（已轮换 ${day} #2）`, enabled: false }]])
})

test('cradmin … | head：读端提前关闭时安静退出 0，不打 EPIPE 栈', async () => {
  const { spawn } = await import('node:child_process')
  const entry = new URL('./cradmin.mjs', import.meta.url).pathname
  const child = spawn(process.execPath, [entry, '--help'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NO_COLOR: '1' } })
  child.stdout.destroy()
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += chunk })
  const code = await new Promise(resolve => child.on('close', resolve))
  assert.equal(code, 0, stderr)
  assert.doesNotMatch(stderr, /EPIPE|Unhandled 'error'/)
})

test('models ls --type：按服务端给的类型筛选，树里非对话模型带类型标签；未知类型退出 2；旧服务端没有类型时不假装筛选', async () => {
  const src = (channel, enabled = true) => ({ channel, kind: 'compat', enabled, upstreams: 1, channelEnabled: true })
  const index = { models: [
    { id: 'gemini-3.1-flash-image', kind: 'image', sources: [src('or')], enabledSources: 1, contested: false, pricing: { input: 0.5, output: 3 } },
    { id: 'gemini-3.8-flash', kind: 'chat', sources: [src('or')], enabledSources: 1, contested: false, pricing: { input: 0.3, output: 2.5 } },
    { id: 'gpt-image-2.5', kind: 'image', sources: [], enabledSources: 0, contested: false, pricing: null, availableOnGateway: false },
    { id: 'veo-3.1-generate-preview', kind: 'video', sources: [src('or')], enabledSources: 1, contested: false, pricing: null },
  ] }
  const routes = { 'GET /api/model-index': () => [200, index] }

  const images = await run(['models', 'ls', '--type', 'image', '--json'], routes)
  assert.equal(images.code, 0, images.stderr)
  assert.deepEqual(JSON.parse(images.stdout).map(row => [row.id, row.kind]), [['gemini-3.1-flash-image', 'image']], '默认不含仅价目的模型')
  const all = await run(['models', 'ls', '--type', 'IMAGE', '--all', '--json'], routes)
  assert.deepEqual(JSON.parse(all.stdout).map(row => row.id), ['gemini-3.1-flash-image', 'gpt-image-2.5'])

  const table = await run(['models', 'ls'], routes)
  assert.equal(table.code, 0, table.stderr)
  assert.match(table.stdout, /└─ Google  3 个/)
  assert.match(table.stdout, /gemini-3\.1-flash-image\s+图片/)
  assert.match(table.stdout, /gemini-3\.8-flash\s+\$0\.30/, '对话模型不标类型（同控制台 kindTag）')
  assert.match(table.stdout, /veo-3\.1-generate-preview\s+视频/)
  const narrowed = await run(['models', 'ls', '--type', 'image'], routes)
  assert.doesNotMatch(narrowed.stdout, /图片/, '按类型筛选后每行都同一类，不再标')

  const shown = await run(['models', 'show', 'veo-3.1-generate-preview'], routes)
  assert.match(shown.stdout, /类型\s+视频/)

  const bad = await run(['models', 'ls', '--type', 'constructor'], routes)
  assert.equal(bad.code, 2)
  assert.match(bad.stderr, /未知类型/)
  assert.ok(!bad.calls.some(call => call.path === '/api/model-index'), '参数错不发请求')

  const legacy = await run(['models', 'ls', '--type', 'image'], { 'GET /api/model-index': () => [200, { models: index.models.map(({ kind: _kind, ...rest }) => rest) }] })
  assert.equal(legacy.code, 1)
  assert.match(legacy.stderr, /没有返回模型类型/)
  const legacyTable = await run(['models', 'ls', '--json'], { 'GET /api/model-index': () => [200, { models: index.models.map(({ kind: _kind, ...rest }) => rest) }] })
  assert.equal(JSON.parse(legacyTable.stdout)[0].kind, null)
})

test('models upstream：表格与 --json 输出上游实际模型、次数与账号；缺少模型或非法 --days 退出 2', async () => {
  const payload = {
    requested: 'gemini-3.8-flash-high',
    days: 14,
    total: 5,
    served: [
      { model: 'gemini-3.8-flash-exp-a', requests: 3, accounts: [{ authIndex: 'ag-1', requests: 2 }, { authIndex: 'ag-2', requests: 1 }] },
      { model: 'gemini-3.8-flash-n', requests: 2, accounts: [{ authIndex: 'ag-1', requests: 2 }] },
    ],
  }
  const routes = {
    'GET /api/models/gemini-3.8-flash-high/upstream-models': () => [200, payload],
  }

  const table = await run(['models', 'upstream', 'gemini-3.8-flash-high', '--days', '14'], routes)
  assert.equal(table.code, 0, table.stderr)
  const getCall = table.calls.find(call => call.path === '/api/models/gemini-3.8-flash-high/upstream-models')
  assert.equal(getCall?.search, '?days=14')
  assert.match(table.stdout, /gemini-3\.8-flash-exp-a/)
  assert.match(table.stdout, /gemini-3\.8-flash-n/)
  assert.match(table.stdout, /ag-1 \(2\), ag-2 \(1\)/)

  const jsonRes = await run(['model', 'upstream', 'gemini-3.8-flash-high', '--json'], routes)
  assert.equal(jsonRes.code, 0, jsonRes.stderr)
  assert.equal(jsonRes.calls.find(call => call.path.endsWith('/upstream-models'))?.search, '?days=7')
  assert.deepEqual(JSON.parse(jsonRes.stdout), payload)

  const missing = await run(['models', 'upstream'], routes)
  assert.equal(missing.code, 2)
  assert.match(missing.stderr, /缺少 <模型>/)

  const badDays = await run(['models', 'upstream', 'gemini-3.8-flash-high', '--days', '0'], routes)
  assert.equal(badDays.code, 2)
  assert.match(badDays.stderr, /--days/)
})

test('models weight：查询与修改调度权重，参数校验与 --yes 要求', async () => {
  const modelIndex = {
    models: [{
      id: 'gpt-5.6-luna',
      sources: [
        { channel: 'codex', kind: 'oauth', weight: 0 },
        { channel: 'openrouter', kind: 'compat', weight: 5 },
      ],
    }],
  }
  const routes = {
    'GET /api/model-index': () => [200, modelIndex],
    'PUT /api/model-routes/gpt-5.6-luna': () => [200, { ok: true }],
  }

  // 1. 查询
  const getRes = await run(['models', 'weight', 'gpt-5.6-luna', 'codex'], routes)
  assert.equal(getRes.code, 0, getRes.stderr)
  assert.match(getRes.stdout, /权重\s+0/)

  // 2. 修改：缺少 --yes 退出 2
  const noYes = await run(['models', 'weight', 'gpt-5.6-luna', 'codex', '2'], routes)
  assert.equal(noYes.code, 2)

  // 3. 修改：带 --yes 成功
  const patchRes = await run(['models', 'weight', 'gpt-5.6-luna', 'codex', '2', '--yes'], routes)
  assert.equal(patchRes.code, 0, patchRes.stderr)
  const put = patchRes.calls.find(call => call.method === 'PUT' && call.path.includes('gpt-5.6-luna'))
  assert.deepEqual(put?.body?.order, [{ channel: 'codex', kind: 'oauth', weight: 2 }, { channel: 'openrouter', kind: 'compat', weight: 5 }], '改完权重整份顺序写回')

  const rr = await run(['models', 'round-robin', 'gpt-5.6-luna', 'on', '--yes'], routes)
  assert.equal(rr.code, 0, rr.stderr)
  assert.equal(rr.calls.find(call => call.method === 'PUT')?.body?.roundRobin, true)

  // 4. 缺少参数
  const missing = await run(['models', 'weight', 'gpt-5.6-luna'], routes)
  assert.equal(missing.code, 2)
})

/* ── 自动升级：rtk auto / rtk upgrade ── */

test('rtk auto：只读 /api/autoupdate 的 rtk 一项', async () => {
  const view = { rtk: { available: true, enabled: true, line: '停在待复核：v0.51.0 声明了破坏性变更', reasons: [] } }
  const result = await run(['rtk', 'auto'], { 'GET /api/autoupdate': () => [200, view] })
  assert.equal(result.code, 0, result.stderr)
  assert.match(result.stdout, /开关\s+开/)
  assert.match(result.stdout, /v0\.51\.0 声明了破坏性变更/)
  assert.deepEqual(result.calls.filter(call => call.path.startsWith('/api/autoupdate')).map(call => call.method), ['GET'])
})

test('rtk upgrade --dry-run 显示下载与校验；rtk upgrade 需确认，确认后才发 confirm:true', async () => {
  const plan = { action: 'hold', why: 'breaking', local: '0.50.0', latest: 'v0.51.0', binary: '/x/rtk', reasons: [{ code: 'breaking', text: 'v0.51.0 声明了破坏性变更 · 看过发布说明再用 cradmin rtk upgrade --accept-breaking', items: ['v0.51.0: cli: callers must pass the script explicitly'] }],
    plan: { asset: 'rtk-aarch64-apple-darwin.tar.gz', size: 4143723, sha256: 'a'.repeat(64), verifiedBy: ['checksums.txt', 'GitHub asset digest'], signature: 'none published', target: '/x/rtk', backupDir: '/b' } }
  const dry = await run(['rtk', 'upgrade', '--dry-run'], { 'POST /api/autoupdate/run': call => [200, { target: 'rtk', dryRun: call.body.dryRun, result: plan }] })
  assert.equal(dry.code, 0, dry.stderr)
  assert.deepEqual(dry.calls.find(call => call.path === '/api/autoupdate/run')?.body, { target: 'rtk', dryRun: true })
  assert.match(dry.stdout, /checksums\.txt \+ GitHub asset digest/)
  assert.match(dry.stdout, /会停住/)
  assert.match(dry.stdout, /v0\.51\.0: cli: callers must pass the script explicitly/)
  const refused = await run(['rtk', 'upgrade'], {})
  assert.equal(refused.code, 2)
  assert.ok(!refused.calls.some(call => call.path === '/api/autoupdate/run'))
  const done = await run(['rtk', 'upgrade', '--yes', '--accept-breaking'], { 'POST /api/autoupdate/run': () => [200, { target: 'rtk', dryRun: false, result: { why: 'upgraded', local: '0.51.0', latest: 'v0.51.0', reasons: [] } }] })
  assert.equal(done.code, 0, done.stderr)
  assert.deepEqual(done.calls.find(call => call.path === '/api/autoupdate/run')?.body, { target: 'rtk', dryRun: false, confirm: true, acceptBreaking: true })
  const held = await run(['rtk', 'upgrade', '--yes'], { 'POST /api/autoupdate/run': () => [409, { target: 'rtk', dryRun: false, code: 'upgrade_held', error: 'v0.51.0 声明了破坏性变更', result: { why: 'breaking', reasons: [] } }] })
  assert.notEqual(held.code, 0)
  assert.match(held.stdout + held.stderr, /v0\.51\.0 声明了破坏性变更/)
  assert.match(done.stdout, /✓ RTK  升级本机 rtk/)
  assert.doesNotMatch(held.stdout + held.stderr, /✓ RTK  升级本机 rtk/, 'a held upgrade is not shown as a done step')
  assert.match(held.stderr, /✗ RTK  升级本机 rtk.*409：v0\.51\.0 声明了破坏性变更/)
})

/* ── CPA 插件管理：plugins ls / store / install / rm ── */

test('plugins ls 与 store：展示已装插件、商店来源与已装标记', async () => {
  const routes = {
    'GET /api/plugins': () => [200, {
      plugins_enabled: true,
      plugins_dir: 'plugins',
      plugins: [
        { id: 'opencode-session-mapper', path: 'plugins/opencode-session-mapper.so', registered: true, enabled: true, effective_enabled: true, metadata: { version: 'v0.3.2' } },
        { id: 'pending-plugin', path: 'plugins/pending-plugin.so', registered: false, enabled: true, effective_enabled: false },
      ],
    }],
    'GET /api/plugins/store': () => [200, {
      plugins_enabled: true,
      plugins_dir: 'plugins',
      sources: [
        { id: 'official', name: 'CLIProxyAPI Store', url: 'https://example.test/official/registry.json' },
        { id: 'mirror', name: 'Community Mirror', url: 'https://example.test/mirror/registry.json' },
      ],
      plugins: [
        { id: 'opencode-session-mapper', source_id: 'official', version: 'v0.3.2' },
        { id: 'quota-guard', source_id: 'mirror', version: 'v1.0.0', installed: false },
      ],
    }],
  }

  const ls = await run(['plugins', 'ls'], routes)
  assert.equal(ls.code, 0, ls.stderr)
  assert.match(ls.stdout, /opencode-session-mapper/)
  assert.match(ls.stdout, /v0\.3\.2/)
  assert.match(ls.stdout, /plugins\/opencode-session-mapper\.so/)
  assert.match(ls.stdout, /pending-plugin/)

  const lsJson = await run(['plugin', 'ls', '--json'], routes)
  assert.equal(lsJson.code, 0, lsJson.stderr)
  const parsedLs = JSON.parse(lsJson.stdout)
  assert.equal(parsedLs.plugins_enabled, true)
  assert.equal(parsedLs.plugins.length, 2)
  assert.equal(parsedLs.plugins[0].effective_enabled, true)

  const store = await run(['plugins', 'store'], routes)
  assert.equal(store.code, 0, store.stderr)
  assert.match(store.stdout, /CLIProxyAPI Store/)
  assert.match(store.stdout, /opencode-session-mapper.*已装/)
  assert.match(store.stdout, /quota-guard.*未装/)
})

test('plugins install 与 rm：多来源冲突时报错列候选；带 --source 走 runPlan；rm 需确认', async () => {
  const multiStore = {
    sources: [
      { id: 'official', name: 'Official' },
      { id: 'community', name: 'Community' },
    ],
    plugins: [
      { id: 'dup-plugin', source_id: 'official', version: '1.0.0' },
      { id: 'dup-plugin', source_id: 'community', version: '1.0.0' },
      { id: 'single-plugin', source_id: 'official', version: '2.0.0' },
    ],
  }
  const routes = {
    'GET /api/plugins/store': () => [200, multiStore],
    'POST /api/plugins/store/dup-plugin/install': call => [200, { status: 'installed', id: 'dup-plugin', source_id: call.body?.source || '' }],
    'POST /api/plugins/store/single-plugin/install': () => [200, { status: 'installed', id: 'single-plugin', source_id: 'official' }],
    'DELETE /api/plugins/dup-plugin': () => [200, { status: 'deleted', id: 'dup-plugin' }],
  }

  const conflict = await run(['plugins', 'install', 'dup-plugin'], routes)
  assert.equal(conflict.code, 2)
  assert.match(conflict.stderr, /official.*community/)
  assert.match(conflict.stderr, /--source/)
  assert.ok(!conflict.calls.some(call => call.method === 'POST' && call.path.includes('/install')), '多来源未指定 --source 时不发安装请求')

  const dry = await run(['plugins', 'install', 'dup-plugin', '--source', 'community', '--dry-run'], routes)
  assert.equal(dry.code, 0, dry.stderr)
  assert.ok(!dry.calls.some(call => call.method === 'POST' && call.path.includes('/install')))

  const installed = await run(['plugins', 'install', 'dup-plugin', '--source', 'community'], routes)
  assert.equal(installed.code, 0, installed.stderr)
  const postCall = installed.calls.find(call => call.method === 'POST' && call.path === '/api/plugins/store/dup-plugin/install')
  assert.deepEqual(postCall?.body, { source: 'community' })

  const refusedRm = await run(['plugins', 'rm', 'dup-plugin'], routes)
  assert.equal(refusedRm.code, 2)
  assert.ok(!refusedRm.calls.some(call => call.method === 'DELETE'))

  const removed = await run(['plugins', 'rm', 'dup-plugin', '--yes'], routes)
  assert.equal(removed.code, 0, removed.stderr)
  assert.ok(removed.calls.some(call => call.method === 'DELETE' && call.path === '/api/plugins/dup-plugin'))
})

test('models order / shared、channels auto-sync / pull、accounts weight：读写都走对应接口', async () => {
  const modelIndex = { models: [{ id: 'm1', roundRobin: false, sources: [
    { channel: 'a', kind: 'compat', weight: 0, enabled: true, channelEnabled: true },
    { channel: 'b', kind: 'oauth', weight: 1, enabled: true, channelEnabled: true },
  ] }] }
  const channelsPayload = { channels: [{ name: 'a', enabled: true, autoSync: true, models: [] }], credentials: [{ name: 'acc.json', type: 'codex', label: 'acc', weight: 0 }] }
  const routes = {
    'GET /api/model-index': () => [200, modelIndex],
    'GET /api/channels': () => [200, channelsPayload],
    'PUT /api/model-routes/m1': () => [200, { ok: true }],
    'GET /api/shared-models': () => [200, { defaultModels: ['x'], customModels: ['y'], activeModels: ['x', 'y'] }],
    'POST /api/shared-models': () => [200, { ok: true }],
    'DELETE /api/shared-models/y': () => [200, { ok: true }],
    'PATCH /api/channels/a/auto-sync': () => [200, { ok: true }],
    'POST /api/channels/a/models/preview': () => [200, { rows: [{ id: 'n1', model: 'n1', state: 'new' }, { id: 'old', model: 'old', state: 'gone' }, { id: 'k', model: 'k', state: 'on' }], endpoint: 'x', probedAt: 't' }],
    'POST /api/channels/a/models/apply': () => [200, { ok: true }],
    'PATCH /api/credentials/acc.json/weight': () => [200, { ok: true }],
  }
  const order = await run(['models', 'order', 'm1', 'b', '--yes'], routes)
  assert.equal(order.code, 0, order.stderr)
  assert.deepEqual(order.calls.find(call => call.method === 'PUT')?.body?.order, [{ channel: 'b', kind: 'oauth', weight: 0 }, { channel: 'a', kind: 'compat', weight: 1 }])
  assert.equal((await run(['models', 'order', 'm1'], routes)).code, 0)

  assert.equal((await run(['models', 'shared'], routes)).code, 0)
  const add = await run(['models', 'shared', 'add', 'p', 'q', '--yes'], routes)
  assert.deepEqual(add.calls.find(call => call.path === '/api/shared-models' && call.method === 'POST')?.body, { modelIds: ['p', 'q'] })
  assert.equal((await run(['models', 'shared', 'rm', 'y', '--yes'], routes)).code, 0)

  const sync = await run(['channels', 'auto-sync', 'a', 'off', '--yes'], routes)
  assert.equal(sync.calls.find(call => call.method === 'PATCH')?.body?.enabled, false)

  assert.equal((await run(['channels', 'pull', 'a'], routes)).code, 0)
  const pull = await run(['channels', 'pull', 'a', '--add-all', '--remove-gone', '--yes'], routes)
  assert.deepEqual(pull.calls.find(call => call.path.endsWith('/apply'))?.body, { add: [{ id: 'n1', enabled: true }], remove: ['old'] })

  const weight = await run(['accounts', 'weight', 'acc.json', '3', '--yes'], routes)
  assert.equal(weight.calls.find(call => call.method === 'PATCH')?.body?.weight, 3)
})
