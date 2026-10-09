// 一次性控制台背后的假 CPA 管理面：在 server/testing/proxyFakeCpa.ts 之上补齐 CLI 写路径要的有状态端点。
// 只监听 127.0.0.1；OAuth 授权页、上游额度接口都由这里应答，测试不连任何外部服务。
import { FakeCpa } from '../../server/testing/proxyFakeCpa.ts'

const OAUTH_MODELS = { codex: ['gpt-5.1', 'gpt-5.1-codex'], claude: ['claude-sonnet-4-5'] }
const OAUTH_TYPES = { antigravity: 'antigravity', codex: 'codex', anthropic: 'claude', kimi: 'kimi', 'kimi-ai': 'kimi', devin: 'devin', meta: 'meta', xai: 'xai' }

export async function startFakeCpa() {
  const fake = await new FakeCpa().start()
  fake.apiKeys = []
  fake.excluded = {}
  /** state → { type, done }；轮询第一次读到 ok 时落一个凭据，同 CPA 授权完成 */
  fake.oauth = new Map()
  const access = { 'api-key-model-access': {}, 'api-key-channel-access': {} }
  const json = raw => JSON.parse(raw || 'null')
  const ok = { status: 200, body: { status: 'ok' } }
  fake.extra = (method, route, url, raw) => {
    const name = url.searchParams.get('name') ?? ''
    if (route === '/api-keys' && method === 'GET') return { status: 200, body: { 'api-keys': fake.apiKeys } }
    if (route === '/api-keys' && method === 'PUT') { fake.apiKeys = json(raw) ?? []; return ok }
    const table = route.slice(1)
    if (table in access && method === 'GET') return { status: 200, body: { [table]: access[table] } }
    if (table in access && method === 'PUT') { access[table] = json(raw) ?? {}; return ok }
    if (route === '/oauth-excluded-models' && method === 'GET') return { status: 200, body: { 'oauth-excluded-models': fake.excluded } }
    if (route === '/oauth-excluded-models' && method === 'PUT') { fake.excluded = json(raw) ?? {}; return ok }
    if (route === '/openai-compatibility' && method === 'PUT') { fake.compat = json(raw) ?? []; return ok }
    if (route === '/openai-compatibility' && method === 'DELETE') { fake.compat = fake.compat.filter(item => item.name !== name); return ok }
    const keyRoute = /^\/(claude|codex|gemini|vertex|xai)-api-key$/.exec(route)
    if (keyRoute && method === 'PUT') { fake.providerKeys[`${keyRoute[1]}-api-key`] = json(raw) ?? []; return ok }
    if (route === '/auth-files' && method === 'DELETE') return fake.credentials.delete(name) ? ok : { status: 404, body: { error: 'not found' } }
    if (route === '/auth-files/status' && method === 'PATCH') {
      const body = json(raw) ?? {}
      const item = fake.credentials.get(String(body.name))
      if (!item) return { status: 404, body: { error: 'not found' } }
      item.disabled = Boolean(body.disabled)
      return ok
    }
    if (route === '/auth-files/models' && method === 'GET') {
      return { status: 200, body: { models: (OAUTH_MODELS[fake.credentials.get(name)?.type] ?? []).map(id => ({ id })) } }
    }
    if (route === '/available-models' && method === 'GET') {
      const oauth = [...fake.credentials.values()].flatMap(item => OAUTH_MODELS[item.type] ?? [])
      const compat = fake.compat.flatMap(channel => (channel.models ?? []).map(model => model.alias || model.name))
      return { status: 200, body: { models: [...new Set([...oauth, ...compat])].map(id => ({ id })) } }
    }
    if (route === '/usage-queue' && method === 'GET') return { status: 200, body: [] }
    if (route === '/latest-version' && method === 'GET') return { status: 200, body: { 'latest-version': 'v0.0.0-fake' } }
    // 上游额度 / 重置都经 CPA 的 /api-call 代发：一律 200 空体，测试按记录断言发去了哪里
    if (route === '/api-call' && method === 'POST') return { status: 200, body: { status_code: 200, body: {} } }
    const authUrl = /^\/([a-z-]+)-auth-url$/.exec(route)
    if (authUrl && OAUTH_TYPES[authUrl[1]] && method === 'GET') {
      const state = `fake-state-${fake.oauth.size + 1}`
      fake.oauth.set(state, { type: OAUTH_TYPES[authUrl[1]], done: false })
      return { status: 200, body: { status: 'ok', url: `https://auth.example.test/authorize?state=${state}`, state } }
    }
    if (route === '/get-auth-status' && method === 'GET') {
      const session = fake.oauth.get(url.searchParams.get('state') ?? '')
      if (!session) return { status: 200, body: { status: 'error', error: 'unknown state' } }
      if (!session.done) {
        session.done = true
        const file = `${session.type}-oauth-${fake.credentials.size + 1}.json`
        fake.credentials.set(file, { name: file, type: session.type, email: `${session.type}.oauth@example.test` })
      }
      return { status: 200, body: { status: 'ok' } }
    }
    if (route === '/oauth-callback' && method === 'POST') {
      return fake.oauth.has(String(json(raw)?.state ?? '')) ? ok : { status: 404, body: { error: 'unknown or expired state' } }
    }
    if (route === '/oauth-session' && method === 'DELETE') { fake.oauth.delete(url.searchParams.get('state') ?? ''); return ok }
    return undefined
  }
  return fake
}
