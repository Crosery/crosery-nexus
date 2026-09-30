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
    return mapMagpieRoutes(channels)
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
