import assert from 'node:assert/strict'
import test from 'node:test'

const originalFetch = globalThis.fetch
const cpaBaseUrl = 'https://cpa.example.test'

async function loadCPA() {
  process.env.CPA_BASE_URL = cpaBaseUrl
  process.env.CPA_MANAGEMENT_KEY = 'management-key'
  return import(`./cpa.ts?test=${Date.now()}-${Math.random()}`)
}

test('unwraps the management model access response and writes the complete map', async () => {
  const calls: Array<{ input: string; method: string; body: string }> = []
  globalThis.fetch = async (input, init) => {
    calls.push({ input: String(input), method: String(init?.method || 'GET'), body: String(init?.body || '') })
    if (init?.method === 'PUT') return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
    return new Response(JSON.stringify({ 'api-key-model-access': { 'sk-one': ['gpt-5.6-sol'] } }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  try {
    const { getModelAccess, putModelAccess } = await loadCPA()
    assert.deepEqual(await getModelAccess(), { 'sk-one': ['gpt-5.6-sol'] })
    assert.equal(await putModelAccess({ 'sk-new': ['gpt-5.6-terra'] }), true)
    assert.deepEqual(calls.map((call) => [call.input, call.method]), [
      [`${cpaBaseUrl}/v0/management/api-key-model-access`, 'GET'],
      [`${cpaBaseUrl}/v0/management/api-key-model-access`, 'PUT'],
    ])
    assert.equal(calls[1].body, JSON.stringify({ 'sk-new': ['gpt-5.6-terra'] }))
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('reads the unrestricted management model catalog rather than a user-key catalog', async () => {
  globalThis.fetch = async (input) => {
    assert.equal(String(input), `${cpaBaseUrl}/v0/management/available-models`)
    return new Response(JSON.stringify({ models: [{ id: 'kimi-k3' }, { id: 'gpt-5.6-sol' }, { id: 'kimi-k3' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  try {
    const { listModels } = await loadCPA()
    assert.deepEqual(await listModels(), ['gpt-5.6-sol', 'kimi-k3'])
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('marks unavailable management endpoints so callers can degrade without masking real failures', async () => {
  globalThis.fetch = async () => new Response('', { status: 404 })
  try {
    const { getModelAccess, isUnsupportedManagementEndpoint, listModels } = await loadCPA()
    await assert.rejects(() => getModelAccess(), (error: unknown) => isUnsupportedManagementEndpoint(error))
    await assert.rejects(() => listModels(), (error: unknown) => isUnsupportedManagementEndpoint(error))
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('surfaces CPA failures instead of silently accepting enforced access failures', async () => {
  globalThis.fetch = async () => new Response('upstream unavailable', { status: 503 })
  try {
    const { getModelAccess, putModelAccess } = await loadCPA()
    await assert.rejects(() => getModelAccess(), /CPA 503/)
    await assert.rejects(() => putModelAccess({}), /CPA 503/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('reads only the credential proxy field through the authenticated adapter', async () => {
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), `${cpaBaseUrl}/v0/management/auth-files/download?name=codex%20one.json`)
    const headers = init?.headers as Record<string, string> | undefined
    assert.equal(headers?.Authorization, 'Bearer management-key')
    return new Response(JSON.stringify({ proxy_url: 'socks5://127.0.0.1:1080', access_token: 'must-not-leak' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  try {
    const { getAuthFileProxy } = await loadCPA()
    assert.equal(await getAuthFileProxy('codex one.json'), 'socks5://127.0.0.1:1080')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('api-keys 永不写空：删光/停光时写入本机封锁 Key，读回时过滤掉它', async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpa-lockout-'))
  const { config } = await import('./config.js')
  const previousDataDir = config.dataDir
  config.dataDir = dir
  const puts: string[][] = []
  let stored: string[] = []
  let channels: Record<string, string[]> = { 'sk-other': ['codex'] }
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (url.endsWith('/api-key-channel-access')) {
      if (init?.method === 'PUT') channels = JSON.parse(String(init.body))
      return json({ 'api-key-channel-access': channels })
    }
    if (init?.method === 'PUT') {
      stored = JSON.parse(String(init.body))
      puts.push(stored)
      return json({})
    }
    return json({ 'api-keys': stored })
  }
  try {
    const { cpaLockoutKey, getCPAKeys, replaceCPAKeys } = await loadCPA()
    await replaceCPAKeys([])
    const lockout = cpaLockoutKey()
    assert.match(lockout, /^sk-lockout-[0-9a-f]{64}$/)
    assert.deepEqual(puts[0], [lockout], '空列表必须换成封锁 Key')
    const file = path.join(dir, 'system-keys.json')
    assert.equal(fs.statSync(file).mode & 0o777, 0o600)
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { version: 1, lockout, probes: {} })
    assert.deepEqual(channels, { 'sk-other': ['codex'], [lockout]: ['__console_no_channels_allowed__'] }, '封锁 Key 显式拒绝所有渠道，其它条目原样保留')
    assert.deepEqual(await getCPAKeys(), [], '封锁 Key 不算控制台的 Key')
    await replaceCPAKeys([...(await getCPAKeys()), 'sk-real'])
    assert.deepEqual(puts[1], ['sk-real'], '有真实 Key 时不再带封锁 Key')
    await replaceCPAKeys(['', 'sk-real'].filter((key) => key !== 'sk-real'))
    assert.deepEqual(puts[2], [lockout], '空字符串不算 Key')
    assert.equal(cpaLockoutKey(), lockout, '同一数据目录复用同一把')
  } finally {
    globalThis.fetch = originalFetch
    config.dataDir = previousDataDir
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('系统 Key：探测 Key 读时隐藏、写时保留，只钉在自己的服务上，封锁 Key 照旧', async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpa-system-keys-'))
  const { config } = await import('./config.js')
  const previousDataDir = config.dataDir
  config.dataDir = dir
  const userKey = `sk-probe-codex-${'a'.repeat(32)}`
  const orphan = `sk-probe-gone-${'b'.repeat(64)}`
  let stored: string[] = ['sk-real', userKey, orphan]
  const keyPuts: string[][] = []
  let channels: Record<string, string[]> = { 'sk-real': ['codex'] }
  let channelPuts = 0
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (url.endsWith('/api-key-channel-access')) {
      if (init?.method === 'PUT') {
        channels = JSON.parse(String(init.body))
        channelPuts += 1
      }
      return json({ 'api-key-channel-access': channels })
    }
    if (init?.method === 'PUT') {
      stored = JSON.parse(String(init.body))
      keyPuts.push(stored)
      return json({})
    }
    return json({ 'api-keys': stored })
  }
  try {
    const { cpaLockoutKey, getCPAKeys, pinProbeKeyChannels, registerProbeKeys, replaceCPAKeys } = await loadCPA()
    const { isSystemKey, maskSystemKeys, readSystemKeys } = await import('./systemKeys.js')
    assert.deepEqual(await getCPAKeys(), ['sk-real', userKey], '残留的系统 Key 按格式隐藏；控制台发放的 32 位随机段不受影响')

    const probes = await registerProbeKeys(['codex', 'Mox-AIGW'])
    assert.match(probes.codex, /^sk-probe-codex-[0-9a-f]{64}$/)
    assert.match(probes['Mox-AIGW'], /^sk-probe-mox-aigw-[0-9a-f]{64}$/)
    assert.equal(fs.statSync(path.join(dir, 'system-keys.json')).mode & 0o777, 0o600)
    assert.deepEqual(readSystemKeys(dir).probes, { codex: probes.codex, 'mox-aigw': probes['Mox-AIGW'] }, '文件里按规范渠道名存')
    assert.deepEqual(keyPuts.at(-1), ['sk-real', userKey, probes.codex, probes['Mox-AIGW']], '补上探测 Key，用户 Key 原样保留，没人持有的系统 Key 清掉')
    assert.deepEqual(await registerProbeKeys(['codex', 'Mox-AIGW']), probes, '同一数据目录复用同一把')
    assert.equal(keyPuts.length, 1, '已注册时不再写')
    assert.deepEqual(await getCPAKeys(), ['sk-real', userKey], '探测 Key 不算控制台的 Key')

    assert.equal(await pinProbeKeyChannels(probes), true)
    assert.deepEqual(channels, { 'sk-real': ['codex'], [probes.codex]: ['codex'], [probes['Mox-AIGW']]: ['mox-aigw'] }, '钉在 CPA 的规范渠道名上')
    assert.equal(await pinProbeKeyChannels(probes), false, '已钉住时不再写')
    assert.equal(channelPuts, 1)

    await replaceCPAKeys([...(await getCPAKeys()).filter((key: string) => key !== userKey), orphan])
    assert.deepEqual(stored, ['sk-real', probes.codex, probes['Mox-AIGW']], '用户 Key 整表写入时带上探测 Key，调用方误传的系统 Key 被剔除')

    await replaceCPAKeys([])
    const lockout = cpaLockoutKey()
    assert.deepEqual(stored, [lockout, probes.codex, probes['Mox-AIGW']], '没有用户 Key 时仍写封锁 Key，探测 Key 照旧保留')
    assert.equal(readSystemKeys(dir).lockout, lockout)
    assert.deepEqual(channels[lockout], ['__console_no_channels_allowed__'])
    assert.deepEqual(channels[probes.codex], ['codex'], '封锁 Key 的条目不影响探测 Key 的条目')
    assert.deepEqual(await getCPAKeys(), [])

    assert.equal(isSystemKey(lockout), true)
    assert.equal(isSystemKey(userKey), false)
    assert.equal(maskSystemKeys(`invalid key ${probes.codex} and ${lockout}`), 'invalid key sk-probe-*** and sk-lockout-***')
  } finally {
    globalThis.fetch = originalFetch
    config.dataDir = previousDataDir
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
