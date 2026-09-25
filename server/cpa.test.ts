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

test('uploads one auth file as multipart without changing the credential bytes', async () => {
  const raw = Buffer.from(JSON.stringify({ type: 'xai', access_token: 'access-secret', refresh_token: 'refresh-secret' }))
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), `${cpaBaseUrl}/v0/management/auth-files`)
    assert.equal(init?.method, 'POST')
    assert.ok(init)
    assert.equal((init.headers as Record<string, string>).Authorization, 'Bearer management-key')
    assert.equal(init.body instanceof FormData, true)
    const form = init.body as FormData
    const file = form.get('file')
    assert.equal(file instanceof Blob, true)
    assert.equal((file as File).name, 'xai-one.json')
    assert.deepEqual(Buffer.from(await (file as Blob).arrayBuffer()), raw)
    return new Response(JSON.stringify({ status: 'ok' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  try {
    const { uploadAuthFile } = await loadCPA()
    await uploadAuthFile('xai-one.json', raw)
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
