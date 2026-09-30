import { config } from './config.js'
import { db } from './db.js'
import { getCompatChannels, getProviderKeyEntries, PROVIDER_KEY_ENDPOINTS, providerChannelName, type CompatChannel } from './cpa.js'
import { listGroups } from './channels.js'
import { persistUsageRecords } from './sync.js'
import { quotaStateFor, type KeyQuotaRow } from './quotaEnforcer.js'
import { readMagpieChannels, resolveMagpieCredential, resolveMagpieSecret } from './magpieControl.js'
import { createMagpieAdmission, mapMagpieRoutes, type AdmissionKey } from './magpieEngine.js'

export async function magpieRoutes() {
  if (config.magpieControlPlane === 'local') {
    const channels = await Promise.all(readMagpieChannels().filter(channel => !channel.disabled).map(async channel => ({
      ...channel,
      'api-key-entries': await Promise.all(channel['api-key-entries'].map(async key => ({ ...key, 'api-key': await resolveMagpieCredential(key['api-key']) }))),
      headers: channel.headers && Object.fromEntries(Object.entries(channel.headers).map(([name, reference]) => [name, resolveMagpieSecret(reference)])),
    })))

    const { listLocalAuthFiles, readExcludedModels, getLocalAuthFileModels } = await import('./magpieControl.js')
    const oauthFiles = listLocalAuthFiles().filter(f => !f.disabled)
    const excluded = readExcludedModels()
    const oauthChannels: CompatChannel[] = []

    for (const file of oauthFiles) {
      const type = String(file.type || file.provider || '').toLowerCase()
      const rawModels = getLocalAuthFileModels(String(file.name || ''))
      const models = rawModels.filter(m => !(excluded[type] || []).includes(m))
      if (!models.length) continue

      const token = String(file.access_token || file['api-key'] || file.token || 'oauth-token')
      const proxy = String(file.proxy_url || '')

      if (type === 'claude' || type === 'anthropic') {
        oauthChannels.push({
          name: 'claude',
          'base-url': 'https://api.anthropic.com',
          protocol: 'anthropic',
          'api-key-entries': [{ 'api-key': token, ...(proxy ? { 'proxy-url': proxy } : {}) }],
          models: models.map(m => ({ name: m })),
          headers: { 'anthropic-beta': 'oauth-2025-04-20' },
        } as CompatChannel)
      } else if (type === 'codex' || type === 'openai') {
        oauthChannels.push({
          name: 'codex',
          'base-url': 'https://api.openai.com/v1',
          protocol: 'responses',
          'api-key-entries': [{ 'api-key': token, ...(proxy ? { 'proxy-url': proxy } : {}) }],
          models: models.map(m => ({ name: m })),
          headers: file.account_id ? { 'chatgpt-account-id': String(file.account_id) } : undefined,
        } as CompatChannel)
      } else if (type === 'xai' || type === 'grok') {
        oauthChannels.push({
          name: 'xai',
          'base-url': 'https://api.x.ai/v1',
          protocol: 'chat',
          'api-key-entries': [{ 'api-key': token, ...(proxy ? { 'proxy-url': proxy } : {}) }],
          models: models.map(m => ({ name: m })),
        } as CompatChannel)
      }
    }

    return mapMagpieRoutes([...channels, ...oauthChannels])
  }
  const [channels, native] = await Promise.all([
    getCompatChannels(),
    Promise.all(PROVIDER_KEY_ENDPOINTS.map(async endpoint => (await getProviderKeyEntries(endpoint)).map((entry, index) =>
      ({ endpoint, entry, name: providerChannelName(entry, endpoint, index) })))),
  ])
  const globalProxy = (await import('./cpa.js')).getGlobalProxy
  const proxy = await globalProxy({ required: true })
  const normalized = channels.map(channel => ({ ...channel, 'proxy-url': channel['proxy-url'] || proxy || 'direct' } satisfies CompatChannel))
  return mapMagpieRoutes(normalized, native.flat())
}

export async function startMagpieServer() {
  if (config.magpiePort === config.port || config.nativeResponsesEnabled) {
    throw new Error('Magpie requires a distinct port and NATIVE_RESPONSES_ENABLED=false')
  }
  await magpieRoutes()
  await listGroups()
  const server = createMagpieAdmission({
    port: config.magpiePort, socket: config.magpieKernelSocket, timeoutMs: config.magpieTimeoutMs,
    routes: magpieRoutes,
    key: token => db.prepare('SELECT * FROM api_keys WHERE key_value=?').get(token) as (AdmissionKey & KeyQuotaRow) | undefined,
    exceeded: key => quotaStateFor(key as AdmissionKey & KeyQuotaRow).exceeded,
    settle: records => persistUsageRecords(records, records.map(record => ({
      id: record.provider!, name: record.provider!, color: '', kind: 'compat' as const, models: [record.alias || record.model!],
    }))),
  })
  server.requestTimeout = config.magpieTimeoutMs
  server.headersTimeout = 30_000
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(config.magpiePort, '127.0.0.1', resolve)
  })
  console.log(JSON.stringify({ event: 'gateway_started', engine: 'magpie', address: `http://127.0.0.1:${config.magpiePort}`, controlPlane: config.magpieControlPlane }))
  return server
}
