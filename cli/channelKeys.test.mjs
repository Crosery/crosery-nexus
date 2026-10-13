// channels keys：API 渠道多上游 Key 管理命令测试。
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

const sampleChannels = {
  channels: [
    {
      name: 'minimax',
      baseUrl: 'https://api.minimaxi.com/v1',
      enabled: true,
      stale: false,
      keyCount: 2,
      keys: [
        { ref: 'a1b2c3d4e5f6', masked: 'sk-mm-12••••••••abcd' },
        { ref: '9876543210ab', masked: 'sk-mm-34••••••••wxyz' },
      ],
      models: [{ id: 'MiniMax-Text-01', enabled: true, upstreams: 1 }],
    },
    {
      name: 'empty-ch',
      baseUrl: 'https://api.example.com/v1',
      enabled: true,
      stale: false,
      keyCount: 0,
      keys: [],
      models: [],
    },
  ],
  credentials: [
    { type: 'codex', name: 'codex-1' },
  ],
}

test('channels keys：列表树形渲染、提示命令与 --json 输出；账号池 provider 给出可读错误', async () => {
  const routes = {
    'GET /api/channels': () => [200, sampleChannels],
    'GET /api/model-index': () => [200, { models: [] }],
  }

  // 1. 人类可读输出
  const listRes = await run(['channels', 'keys', 'minimax'], routes)
  assert.equal(listRes.code, 0, listRes.stderr)
  assert.match(listRes.stdout, /minimax 的上游 Key/)
  assert.match(listRes.stdout, /sk-mm-12••••••••abcd（a1b2c3d4）/)
  assert.match(listRes.stdout, /sk-mm-34••••••••wxyz（98765432）/)
  assert.match(listRes.stdout, /添加：cradmin channels keys add minimax --api-key-stdin/)
  assert.match(listRes.stdout, /删除：cradmin channels keys rm minimax <ref>/)

  // 2. 结构化 JSON
  const jsonRes = await run(['channels', 'keys', 'minimax', '--json'], routes)
  assert.equal(jsonRes.code, 0, jsonRes.stderr)
  const parsed = JSON.parse(jsonRes.stdout)
  assert.deepEqual(parsed, {
    channel: 'minimax',
    keys: [
      { ref: 'a1b2c3d4e5f6', masked: 'sk-mm-12••••••••abcd' },
      { ref: '9876543210ab', masked: 'sk-mm-34••••••••wxyz' },
    ],
  })

  // 3. 没 Key 的渠道
  const emptyRes = await run(['channels', 'keys', 'empty-ch'], routes)
  assert.equal(emptyRes.code, 0, emptyRes.stderr)
  assert.match(emptyRes.stdout, /这个渠道没有上游 Key/)

  // 4. 账号池 provider
  const oauthRes = await run(['channels', 'keys', 'codex'], routes)
  assert.equal(oauthRes.code, 2)
  assert.match(oauthRes.stderr, /codex 是账号池，没有上游 Key 概念/)

  // 5. channels show 中的 Key 行逐把列出
  const showRes = await run(['channels', 'show', 'minimax'], routes)
  assert.equal(showRes.code, 0, showRes.stderr)
  assert.match(showRes.stdout, /Key\s+sk-mm-12••••••••abcd（a1b2c3d4）、sk-mm-34••••••••wxyz（98765432）/)

  // 6. channels show --json 带 keys 数组
  const showJson = await run(['channels', 'show', 'minimax', '--json'], routes)
  assert.equal(showJson.code, 0, showJson.stderr)
  const showParsed = JSON.parse(showJson.stdout)
  assert.deepEqual(showParsed.keys, sampleChannels.channels[0].keys)
})

test('channels keys add：成功时发出 POST 请求体（含 apiKey 从 stdin 来）', async () => {
  const routes = {
    'GET /api/channels': () => [200, sampleChannels],
    'POST /api/channels/minimax/keys': () => [200, {
      ok: true,
      keys: [
        ...sampleChannels.channels[0].keys,
        { ref: '112233445566', masked: 'sk-new••••••••9999' },
      ],
    }],
  }

  const result = await run(['channels', 'keys', 'add', 'minimax', '--api-key-stdin'], routes, {
    extra: { stdin: Readable.from(['sk-new-secret-api-key\n']) },
  })
  assert.equal(result.code, 0, result.stderr)
  const postCall = result.calls.find(call => call.method === 'POST' && call.path === '/api/channels/minimax/keys')
  assert.ok(postCall, '发出了 POST /api/channels/minimax/keys')
  assert.deepEqual(postCall.body, { apiKey: 'sk-new-secret-api-key' })
})

test('channels keys add / rm：命中 409 key_exists / 409 last_key / 502 时的中文提示与退出码', async () => {
  const routes = {
    'GET /api/channels': () => [200, sampleChannels],
    'POST /api/channels/minimax/keys': () => [409, { error: '这把 Key 已经在渠道里了', reason: 'key_exists' }],
    'DELETE /api/channels/minimax/keys/a1b2c3d4e5f6': () => [409, { error: '不能删掉最后一把上游 Key · 先加新 Key 再删旧的', reason: 'last_key' }],
  }

  // add 命中 409 key_exists
  const existsRes = await run(['channels', 'keys', 'add', 'minimax', '--api-key-stdin'], routes, {
    extra: { stdin: Readable.from(['sk-existing\n']) },
  })
  assert.equal(existsRes.code, 1)
  assert.match(existsRes.stderr, /这把 Key 已经在渠道里了/)
  assert.match(existsRes.stderr, /重复 Key/)

  // rm 命中 409 last_key
  const lastKeyRes = await run(['channels', 'keys', 'rm', 'minimax', 'a1b2c3d4e5f6', '--yes'], routes)
  assert.equal(lastKeyRes.code, 1)
  assert.match(lastKeyRes.stderr, /先加新 Key 再删旧的/)

  // add 命中 409 last_key
  const addLastKeyRoutes = {
    'GET /api/channels': () => [200, sampleChannels],
    'POST /api/channels/minimax/keys': () => [409, { error: '不能删掉最后一把上游 Key', reason: 'last_key' }],
  }
  const addLastKeyRes = await run(['channels', 'keys', 'add', 'minimax', '--api-key-stdin'], addLastKeyRoutes, {
    extra: { stdin: Readable.from(['sk-any\n']) },
  })
  assert.equal(addLastKeyRes.code, 1)
  assert.match(addLastKeyRes.stderr, /先加新 Key 再删旧的/)

  // 502 上游探测失败
  const probeFailedRoutes = {
    'GET /api/channels': () => [200, sampleChannels],
    'POST /api/channels/minimax/keys': () => [502, { error: '连接上游超时' }],
  }
  const probeRes = await run(['channels', 'keys', 'add', 'minimax', '--api-key-stdin'], probeFailedRoutes, {
    extra: { stdin: Readable.from(['sk-bad\n']) },
  })
  assert.equal(probeRes.code, 1)
  assert.match(probeRes.stderr, /上游探测失败：连接上游超时/)
})

test('channels keys rm：请求路径、前缀解析与非交互确认要求', async () => {
  const routes = {
    'GET /api/channels': () => [200, sampleChannels],
    'DELETE /api/channels/minimax/keys/a1b2c3d4e5f6': () => [200, { ok: true, keys: [sampleChannels.channels[0].keys[1]] }],
  }

  // 非交互环境不加 --yes：退出码 2，不发请求
  const refused = await run(['channels', 'keys', 'rm', 'minimax', 'a1b2c3d4e5f6'], routes)
  assert.equal(refused.code, 2)
  assert.match(refused.stderr, /--yes/)
  assert.ok(!refused.calls.some(call => call.method === 'DELETE'))

  // 加 --yes 完整 ref：发出 DELETE /api/channels/minimax/keys/a1b2c3d4e5f6
  const fullRef = await run(['channels', 'keys', 'rm', 'minimax', 'a1b2c3d4e5f6', '--yes'], routes)
  assert.equal(fullRef.code, 0, fullRef.stderr)
  const delCall1 = fullRef.calls.find(call => call.method === 'DELETE')
  assert.ok(delCall1)
  assert.equal(delCall1.path, '/api/channels/minimax/keys/a1b2c3d4e5f6')

  // 前缀命中唯一 Key：自动补全完整 ref 发请求
  const prefixRef = await run(['channels', 'keys', 'rm', 'minimax', 'a1b2c3d4', '--yes'], routes)
  assert.equal(prefixRef.code, 0, prefixRef.stderr)
  const delCall2 = prefixRef.calls.find(call => call.method === 'DELETE')
  assert.ok(delCall2)
  assert.equal(delCall2.path, '/api/channels/minimax/keys/a1b2c3d4e5f6')
})

test('channels keys：--dry-run 不发出写请求', async () => {
  const routes = {
    'GET /api/channels': () => [200, sampleChannels],
  }

  // add --dry-run
  const dryAdd = await run(['channels', 'keys', 'add', 'minimax', '--api-key-stdin', '--dry-run'], routes, {
    extra: { stdin: Readable.from(['sk-dry\n']) },
  })
  assert.equal(dryAdd.code, 0, dryAdd.stderr)
  assert.ok(!dryAdd.calls.some(call => call.method === 'POST' && call.path.includes('/keys')))
  assert.match(dryAdd.stdout, /--dry-run/)

  // rm --dry-run
  const dryRm = await run(['channels', 'keys', 'rm', 'minimax', 'a1b2c3d4e5f6', '--dry-run'], routes)
  assert.equal(dryRm.code, 0, dryRm.stderr)
  assert.ok(!dryRm.calls.some(call => call.method === 'DELETE' && call.path.includes('/keys')))
  assert.match(dryRm.stdout, /--dry-run/)
})

test('channels keys：参数校验', async () => {
  const routes = {
    'GET /api/channels': () => [200, sampleChannels],
  }

  // 缺少渠道
  const noChan = await run(['channels', 'keys'], routes)
  assert.equal(noChan.code, 2)
  assert.match(noChan.stderr, /缺少 <渠道>/)

  // keys add 缺少渠道
  const noAddChan = await run(['channels', 'keys', 'add'], routes)
  assert.equal(noAddChan.code, 2)
  assert.match(noAddChan.stderr, /缺少 <渠道>/)

  // keys add 缺少 --api-key-stdin
  const noStdinOpt = await run(['channels', 'keys', 'add', 'minimax'], routes)
  assert.equal(noStdinOpt.code, 2)
  assert.match(noStdinOpt.stderr, /--api-key-stdin/)

  // keys rm 缺少 ref
  const noRef = await run(['channels', 'keys', 'rm', 'minimax'], routes)
  assert.equal(noRef.code, 2)
  assert.match(noRef.stderr, /缺少 <ref>/)
})
