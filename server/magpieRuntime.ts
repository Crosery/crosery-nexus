import { config } from './config.js'
import { db } from './db.js'
import { getCompatChannels, getProviderKeyEntries, PROVIDER_KEY_ENDPOINTS, providerChannelName, type CompatChannel } from './cpa.js'
import { listGroups } from './channels.js'
import { persistUsageRecords } from './sync.js'
import { quotaStateFor, type KeyQuotaRow } from './quotaEnforcer.js'
import { readMagpieChannels, resolveMagpieCredential, resolveMagpieSecret } from './magpieControl.js'
import { createMagpieAdmission, mapMagpieRoutes, type AdmissionKey } from './magpieEngine.js'
import { accountPicks, pushAccountPicksAtBoot } from './magpieAccountProxies.js'

export async function magpieRoutes() {
  if (config.magpieControlPlane === 'local') {
    const rawChannels = readMagpieChannels().filter(channel => !channel.disabled)
    const resolvedChannels = await Promise.all(rawChannels.map(async channel => {
      try {
        const keys = await Promise.all(channel['api-key-entries'].map(async key => {
          try {
            const resolved = await resolveMagpieCredential(key['api-key'])
            return { ...key, 'api-key': resolved }
          } catch {
            return null
          }
        }))
        const validKeys = keys.filter((k): k is NonNullable<typeof k> => k !== null && Boolean(k['api-key']))
        if (!validKeys.length) return null
        return {
          ...channel,
          'api-key-entries': validKeys,
          headers: channel.headers && Object.fromEntries(Object.entries(channel.headers).map(([name, reference]) => [name, resolveMagpieSecret(reference)])),
        }
      } catch {
        return null
      }
    }))
    const channels = resolvedChannels.filter((c): c is NonNullable<typeof c> => c !== null) as unknown as CompatChannel[]

    const { listLocalAuthFiles, readExcludedModels, getLocalAuthFileModels, readLocalAuthFileCredential } = await import('./magpieControl.js')
    const oauthFiles = listLocalAuthFiles().filter(f => !f.disabled)
    const excluded = readExcludedModels()
    const oauthChannels: CompatChannel[] = []

    for (const file of oauthFiles) {
      const type = String(file.type || file.provider || '').toLowerCase()
      const rawModels = getLocalAuthFileModels(String(file.name || ''))
      const models = rawModels.filter(m => !(excluded[type] || []).includes(m))
      if (!models.length) continue

      // 列表只有白名单字段；凭据本身只在这里、在服务端按文件名读一次
      const credential = readLocalAuthFileCredential(String(file.name || ''))
      const token = credential.token || 'oauth-token'
      const proxy = String(file.proxy_url || '')

      const useBridge = Boolean(config.magpieSourceCpaBaseUrl && config.magpieSourceCpaKey)
      const effectiveProxy = useBridge ? 'direct' : (proxy && !proxy.includes('127.0.0.1:179') ? proxy : 'direct')
      const effectiveKey = useBridge ? config.magpieSourceCpaKey : token

      if (type === 'claude' || type === 'anthropic') {
        oauthChannels.push({
          name: 'claude',
          'base-url': useBridge ? `${config.magpieSourceCpaBaseUrl}/v1` : 'https://api.anthropic.com',
          protocol: 'anthropic',
          'api-key-entries': [{ 'api-key': effectiveKey, ...(effectiveProxy !== 'direct' ? { 'proxy-url': effectiveProxy } : {}) }],
          models: models.map(m => ({ name: m })),
          headers: { 'anthropic-beta': 'oauth-2025-04-20' },
        } as CompatChannel)
      } else if (type === 'codex' || type === 'openai') {
        oauthChannels.push({
          name: 'codex',
          'base-url': useBridge ? `${config.magpieSourceCpaBaseUrl}/v1` : 'https://api.openai.com/v1',
          protocol: 'responses',
          'api-key-entries': [{ 'api-key': effectiveKey, ...(effectiveProxy !== 'direct' ? { 'proxy-url': effectiveProxy } : {}) }],
          models: models.map(m => ({ name: m })),
          headers: credential.accountId ? { 'chatgpt-account-id': credential.accountId } : undefined,
        } as CompatChannel)
      } else if (type === 'antigravity' || type === 'gemini' || type === 'google') {
        oauthChannels.push({
          name: 'antigravity',
          'base-url': useBridge ? `${config.magpieSourceCpaBaseUrl}/v1` : 'https://generativelanguage.googleapis.com',
          protocol: 'chat',
          'api-key-entries': [{ 'api-key': effectiveKey, ...(effectiveProxy !== 'direct' ? { 'proxy-url': effectiveProxy } : {}) }],
          models: models.map(m => ({ name: m })),
        } as CompatChannel)
      } else if (type === 'xai' || type === 'grok') {
        oauthChannels.push({
          name: 'xai',
          'base-url': useBridge ? `${config.magpieSourceCpaBaseUrl}/v1` : 'https://api.x.ai/v1',
          protocol: 'chat',
          'api-key-entries': [{ 'api-key': effectiveKey, ...(effectiveProxy !== 'direct' ? { 'proxy-url': effectiveProxy } : {}) }],
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
    ...(config.magpieControlPlane === 'local' ? { extraProviders: () => accountPicks() } : {}),
  })
  server.requestTimeout = config.magpieTimeoutMs
  server.headersTimeout = 30_000
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(config.magpiePort, '127.0.0.1', resolve)
  })
  console.log(JSON.stringify({ event: 'gateway_started', engine: 'magpie', address: `http://127.0.0.1:${config.magpiePort}`, controlPlane: config.magpieControlPlane }))
  // per-account exits must reach the kernel before it reads any account's usage, not at the first inference request
  void pushAccountPicksAtBoot().catch(() => false)
  return server
}
