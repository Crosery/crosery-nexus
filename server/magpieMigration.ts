import { magpieCredentialReference, validateMagpieChannels, type MagpieChannel } from './magpieControl.js'

type MigrationReport = {
  channels: MagpieChannel[]
  pending: Array<{ channel: string; reason: string }>
}

/** Project control-plane metadata without copying any upstream credentials. */
export function projectMagpieChannels(sources: Record<string, Array<Record<string, unknown>>>): MigrationReport {
  const channels: MagpieChannel[] = []
  const pending: MigrationReport['pending'] = []
  for (const endpoint of ['openai-compatibility', 'claude-api-key', 'codex-api-key', 'gemini-api-key', 'vertex-api-key']) {
    for (const [index, entry] of (sources[endpoint] || []).entries()) {
      const name = String(entry.name || entry.prefix || `${endpoint}-${index + 1}`)
      if (['gemini-api-key', 'vertex-api-key'].includes(endpoint)) {
        pending.push({ channel: name, reason: 'Magpie has no native Gemini upstream slot' })
        continue
      }
      const base = String(entry['base-url'] || (endpoint === 'claude-api-key' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1'))
      const parsed = new URL(base)
      if (Object.keys(entry.headers as object || {}).length) {
        pending.push({ channel: name, reason: 'Custom headers need explicit secret references' })
        continue
      }
      const keys = endpoint === 'openai-compatibility'
        ? entry['api-key-entries'] as Array<Record<string, unknown>>
        : [{ 'api-key': entry['api-key'], 'proxy-url': entry['proxy-url'] }]
      const models = entry.models as MagpieChannel['models']
      if (!keys?.length || !models?.length) {
        pending.push({ channel: name, reason: 'Missing configured keys or explicit model mapping' })
        continue
      }
      const identity = endpoint === 'openai-compatibility' ? name : `${String(entry.prefix || '')}\0${String(entry['base-url'] || '')}`
      const local = ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)
      const channel: MagpieChannel = {
        name, 'base-url': base, models: models.map(model => ({ name: model.name, ...(model.alias ? { alias: model.alias } : {}) })),
        protocol: endpoint === 'claude-api-key' ? 'anthropic' : endpoint === 'codex-api-key' ? 'responses' : 'chat',
        disabled: entry.disabled === true || local,
        'api-key-entries': keys.map((key, slot) => ({
          'api-key': magpieCredentialReference(endpoint, identity, slot),
          ...(key['proxy-url'] ? { 'proxy-url': String(key['proxy-url']) } : {}),
        })),
        ...(entry['proxy-url'] ? { 'proxy-url': String(entry['proxy-url']) } : {}),
      }
      for (const proxy of [channel['proxy-url'], ...channel['api-key-entries'].map(key => key['proxy-url'])]) {
        if (proxy && proxy !== 'direct' && (new URL(proxy).username || new URL(proxy).password)) {
          throw new Error('Proxy credentials require a separate reference; migration stopped')
        }
      }
      validateMagpieChannels([channel])
      channels.push(channel)
      if (local) pending.push({ channel: name, reason: 'Source-host loopback is not this machine; imported disabled' })
    }
  }
  validateMagpieChannels(channels)
  return { channels, pending }
}
