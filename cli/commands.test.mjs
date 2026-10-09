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
    const call = { method: init.method, path: new URL(url).pathname, cookie: init.headers.cookie || '', body: init.body ? JSON.parse(init.body) : undefined }
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
