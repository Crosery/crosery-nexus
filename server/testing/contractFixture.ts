/**
 * A populated fake CPA for the front-end contract tests: one compat channel, a Codex and a Claude account, a
 * stateful `api-keys` list and access tables (so `POST /api/keys` works end to end), and a usage queue the
 * console's collector drains. Every value is a placeholder; nothing leaves 127.0.0.1.
 */
import type { UsageRecord } from '../cpa.js'
import { FakeCpa } from './proxyFakeCpa.js'

export type ContractCpa = FakeCpa & { usageQueue: UsageRecord[]; apiKeys: string[] }

export async function startContractCpa(): Promise<ContractCpa> {
  const fake = await new FakeCpa().start() as ContractCpa
  fake.usageQueue = []
  fake.apiKeys = []
  fake.credentials.set('codex-contract.json', { name: 'codex-contract.json', type: 'codex', email: 'codex.owner@example.test' })
  fake.credentials.set('claude-contract.json', { name: 'claude-contract.json', type: 'claude', email: 'claude.owner@example.test' })
  fake.compat = [{
    name: 'contract-relay',
    'base-url': 'https://relay.example.test/v1',
    'api-key-entries': [{ 'api-key': 'sk-placeholder-relay' }],
    models: [{ name: 'contract-model', alias: 'contract-model' }, { name: 'gpt-5.1', alias: 'gpt-5.1' }],
  }]
  const access: Record<string, Record<string, string[]>> = { 'api-key-model-access': {}, 'api-key-channel-access': {} }
  const oauthModels: Record<string, string[]> = { codex: ['gpt-5.1', 'gpt-5.1-codex'], claude: ['claude-sonnet-4-5'] }
  fake.extra = (method, route, url, raw) => {
    const body = () => JSON.parse(raw || 'null') as unknown
    if (route === '/api-keys' && method === 'GET') return { status: 200, body: { 'api-keys': fake.apiKeys } }
    if (route === '/api-keys' && method === 'PUT') { fake.apiKeys = (body() as string[]) ?? []; return { status: 200, body: { status: 'ok' } } }
    const table = route.slice(1)
    if (table in access && method === 'GET') return { status: 200, body: { [table]: access[table] } }
    if (table in access && method === 'PUT') { access[table] = (body() as Record<string, string[]>) ?? {}; return { status: 200, body: { status: 'ok' } } }
    if (route === '/oauth-excluded-models' && method === 'GET') return { status: 200, body: { 'oauth-excluded-models': {} } }
    if (route === '/auth-files/models' && method === 'GET') {
      const item = fake.credentials.get(url.searchParams.get('name') ?? '')
      return { status: 200, body: { models: (oauthModels[item?.type ?? ''] ?? []).map(id => ({ id })) } }
    }
    if (route === '/available-models' && method === 'GET') {
      const ids = [...new Set([...Object.values(oauthModels).flat(), 'contract-model'])]
      return { status: 200, body: { models: ids.map(id => ({ id })) } }
    }
    if (route === '/usage-queue' && method === 'GET') {
      const count = Number(url.searchParams.get('count') || 200)
      return { status: 200, body: fake.usageQueue.splice(0, count) }
    }
    return undefined
  }
  // the gateway's own model list for a key it knows (what /api/me/models and the public catalog read)
  fake.gateway = (method, url, authorization) => {
    if (method !== 'GET' || url.pathname !== '/v1/models') return undefined
    if (!fake.apiKeys.some(key => authorization === `Bearer ${key}`)) return { status: 401, body: { error: 'invalid api key' } }
    return { status: 200, body: { object: 'list', data: ['gpt-5.1', 'claude-sonnet-4-5', 'contract-model'].map(id => ({ id, object: 'model' })) } }
  }
  return fake
}

/** A few requests for `apiKey`: successes on two providers, one failure, cache tokens, a client UA. */
export function sampleUsage(apiKey: string, now = Date.now()): UsageRecord[] {
  const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString()
  const base = { api_key: apiKey, endpoint: '/v1/chat/completions', source: 'codex-contract.json', auth_index: 'codex-contract.json', user_agent: 'codex_cli_rs/0.50.0' }
  return [
    { ...base, request_id: 'contract-req-1', timestamp: at(5), provider: 'codex', model: 'gpt-5.1', latency_ms: 1200, ttft_ms: 300,
      tokens: { input_tokens: 1200, output_tokens: 300, cached_tokens: 800, total_tokens: 1500 } },
    { ...base, request_id: 'contract-req-2', timestamp: at(30), provider: 'contract-relay', model: 'contract-model', latency_ms: 900, ttft_ms: 200,
      source: 'contract-relay', auth_index: '', user_agent: 'claude-cli/2.0.0', tokens: { input_tokens: 400, output_tokens: 100, total_tokens: 500 } },
    { ...base, request_id: 'contract-req-3', timestamp: at(90), provider: 'claude', model: 'claude-sonnet-4-5', latency_ms: 2500, ttft_ms: 0,
      source: 'claude-contract.json', auth_index: 'claude-contract.json', failed: true, fail: { status_code: 429, body: 'rate limited' },
      tokens: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } },
  ]
}
