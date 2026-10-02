import { mergeChannelView } from './channelView.js'
import type { ChannelSnapshotRow, ModelStateRow } from './channelView.js'
import { apiCall, deleteAuthFile, deleteCompatChannel, getAuthFileModels, getCompatChannels, getExcludedModels, getProviderKeyEntries, listAuthFiles, modelId, providerChannelName, putCompatChannels, putExcludedModels, putProviderKeyEntries, setAuthFileDisabled, setAuthFileProxy, PROVIDER_KEY_ENDPOINTS, type ProviderKeyEndpoint, type ProviderKeyEntry } from './cpa.js'
import type { CompatChannel, CompatModel } from './cpa.js'
import { buildGroups } from './groups.js'
import { buildModelIndex } from './modelIndex.js'
import { gatewayPricingMap } from './modelCatalog.js'
import type { OAuthProviderModels } from './modelIndex.js'
import { db } from './db.js'
import { attachCredentialModels, summarizeCredentialFiles } from './credentials.js'
import { modelDiscoveryUrls, normalizeBaseUrl, normalizeDiscoveredModels, validateChannelName, validateSelectedModels, type ChannelProtocol, type DiscoveredModel } from './channelDiscovery.js'
import { RequestCoordinator } from './requestCoordinator.js'
import { ReportingGroupStore } from './reportingGroups.js'

const now = () => new Date().toISOString()
const reportingGroupStore = new ReportingGroupStore(db)

const parse = <T>(value: string, fallback: T): T => {
  try { return JSON.parse(value) as T } catch { return fallback }
}

type ChannelStateRow = ChannelSnapshotRow
type ModelSnapshotRow = ModelStateRow & { snapshot_json: string }

const readChannelStates = () =>
  new Map((db.prepare('SELECT * FROM channel_states').all() as ChannelStateRow[]).map((row) => [row.name, row]))

const readModelStates = () =>
  db.prepare('SELECT * FROM channel_model_states').all() as ModelSnapshotRow[]

/**
 * 把挂在原生协议端点（claude-api-key 等）下的第三方上游折成渠道形状，
 * 让它们和 openai-compatibility 渠道在面板里一视同仁。
 */
export async function getProviderChannels(): Promise<CompatChannel[]> {
  const groups = await Promise.all(PROVIDER_KEY_ENDPOINTS.map(async (endpoint) => {
    const entries = await getProviderKeyEntries(endpoint).catch(() => [] as ProviderKeyEntry[])
    return entries.map((entry, index) => ({
      name: providerChannelName(entry, endpoint, index),
      'base-url': String(entry['base-url'] || ''),
      'api-key-entries': entry['api-key'] ? [{ 'api-key': String(entry['api-key']) }] : [],
      models: entry.models || [],
      disabled: entry.disabled === true,
      __providerEndpoint: endpoint,
      __providerIndex: index,
      __providerEntry: entry,
    } satisfies CompatChannel))
  }))
  return groups.flat()
}

async function fetchChannels() {
  const [compat, providers] = await Promise.all([getCompatChannels(), getProviderChannels()])
  const live = [...compat, ...providers]
  // CPA can retain a channel as disabled instead of removing it. Persist that
  // state locally too, so refreshes never render it as an enabled channel.
  for (const channel of live) {
    const name = String(channel.name || '')
    if (!name) continue
    const enabled = channel.disabled === true ? 0 : 1
    db.prepare('INSERT INTO channel_states (name,enabled,snapshot_json,updated_at) VALUES (?,?,?,?) ON CONFLICT(name) DO UPDATE SET enabled=excluded.enabled,snapshot_json=excluded.snapshot_json,updated_at=excluded.updated_at')
      .run(name, enabled, JSON.stringify(channel), now())
  }
  return mergeChannelView(live, [...readChannelStates().values()], readModelStates())
}

async function setProviderChannelEnabled(name: string, enabled: boolean, snapshot?: CompatChannel | null) {
  for (const endpoint of PROVIDER_KEY_ENDPOINTS) {
    const entries = await getProviderKeyEntries(endpoint).catch(() => [] as ProviderKeyEntry[])
    const index = entries.findIndex((entry, position) => providerChannelName(entry, endpoint, position) === name)
    if (index >= 0 && !enabled) {
      const channel = {
        name,
        'base-url': String(entries[index]['base-url'] || ''),
        'api-key-entries': entries[index]['api-key'] ? [{ 'api-key': String(entries[index]['api-key']) }] : [],
        models: entries[index].models || [],
        __providerEndpoint: endpoint,
        __providerIndex: index,
        __providerEntry: entries[index],
      } satisfies CompatChannel
      db.prepare('INSERT INTO channel_states (name,enabled,snapshot_json,updated_at) VALUES (?,0,?,?) ON CONFLICT(name) DO UPDATE SET enabled=0,snapshot_json=excluded.snapshot_json,updated_at=excluded.updated_at')
        .run(name, JSON.stringify(channel), now())
      await putProviderKeyEntries(endpoint, entries.filter((_, position) => position !== index))
      return true
    }
  }

  if (!enabled || !snapshot) return false
  const endpoint = String(snapshot.__providerEndpoint || '') as (typeof PROVIDER_KEY_ENDPOINTS)[number]
  if (!PROVIDER_KEY_ENDPOINTS.includes(endpoint)) return false
  const entries = await getProviderKeyEntries(endpoint).catch(() => [] as ProviderKeyEntry[])
  const savedEntry = snapshot.__providerEntry
  const restored = savedEntry && typeof savedEntry === 'object'
    ? savedEntry as ProviderKeyEntry
    : {
        'api-key': String(snapshot['api-key-entries']?.[0]?.['api-key'] || ''),
        'base-url': String(snapshot['base-url'] || ''),
        models: snapshot.models || [],
      }
  if (!String(restored['api-key'] || '')) throw new Error('渠道快照缺少 API Key，无法恢复')
  await putProviderKeyEntries(endpoint, [...entries, restored])
  db.prepare('UPDATE channel_states SET enabled=1, updated_at=? WHERE name=?').run(now(), name)
  return true
}

export async function setChannelEnabled(name: string, enabled: boolean) {
  invalidateGatewaySnapshot()
  const live = await getCompatChannels()
  const existing = live.find((channel) => String(channel.name || '') === name)

  if (!enabled && existing) {
    db.prepare('INSERT INTO channel_states (name,enabled,snapshot_json,updated_at) VALUES (?,0,?,?) ON CONFLICT(name) DO UPDATE SET enabled=0,snapshot_json=excluded.snapshot_json,updated_at=excluded.updated_at')
      .run(name, JSON.stringify(existing), now())
    await deleteCompatChannel(name)
    return
  }

  if (enabled && existing) {
    if (existing.disabled === true) {
      const restored = { ...existing, disabled: false }
      const index = live.indexOf(existing)
      live[index] = restored
      await putCompatChannels(live)
      db.prepare('INSERT INTO channel_states (name,enabled,snapshot_json,updated_at) VALUES (?,1,?,?) ON CONFLICT(name) DO UPDATE SET enabled=1,snapshot_json=excluded.snapshot_json,updated_at=excluded.updated_at')
        .run(name, JSON.stringify(restored), now())
      return
    }
    db.prepare('INSERT INTO channel_states (name,enabled,snapshot_json,updated_at) VALUES (?,1,?,?) ON CONFLICT(name) DO UPDATE SET enabled=1,snapshot_json=excluded.snapshot_json,updated_at=excluded.updated_at')
      .run(name, JSON.stringify(existing), now())
    return
  }

  const row = db.prepare('SELECT * FROM channel_states WHERE name = ?').get(name) as ChannelStateRow | undefined
  const snapshot = row?.snapshot_json ? parse<CompatChannel | null>(row.snapshot_json, null) : null
  if (await setProviderChannelEnabled(name, enabled, snapshot)) return
  if (!enabled) throw new Error('渠道不存在或已停用')
  if (!snapshot) throw new Error('没有可恢复的渠道配置，请重新创建该渠道')
  await putCompatChannels([...live, snapshot])
  db.prepare('UPDATE channel_states SET enabled=1, updated_at=? WHERE name=?').run(now(), name)
}

/** 原生协议端点下的渠道要写回各自的端点，不能往 openai-compatibility 里写。 */
async function setProviderChannelModelEnabled(channelName: string, model: string, enabled: boolean) {
  for (const endpoint of PROVIDER_KEY_ENDPOINTS) {
    const entries = await getProviderKeyEntries(endpoint).catch(() => [] as ProviderKeyEntry[])
    const index = entries.findIndex((entry, position) => providerChannelName(entry, endpoint, position) === channelName)
    if (index < 0) continue

    const entry = entries[index]
    const models = [...(entry.models || [])]
    if (!enabled) {
      const targets = models.filter((item) => modelId(item) === model)
      if (!targets.length) throw new Error('模型不存在或已停用')
      db.prepare('INSERT INTO channel_model_states (channel,model,enabled,snapshot_json,updated_at) VALUES (?,?,0,?,?) ON CONFLICT(channel,model) DO UPDATE SET enabled=0,snapshot_json=excluded.snapshot_json,updated_at=excluded.updated_at')
        .run(channelName, model, JSON.stringify(targets), now())
      entry.models = models.filter((item) => modelId(item) !== model)
    } else {
      if (models.some((item) => modelId(item) === model)) return true
      const row = db.prepare('SELECT * FROM channel_model_states WHERE channel=? AND model=?').get(channelName, model) as ModelSnapshotRow | undefined
      const stored = row?.snapshot_json ? parse<CompatModel | CompatModel[] | null>(row.snapshot_json, null) : null
      const snapshot = Array.isArray(stored) ? stored : stored ? [stored] : []
      if (!snapshot.length) throw new Error('没有可恢复的模型配置')
      entry.models = [...models, ...snapshot]
      db.prepare('UPDATE channel_model_states SET enabled=1, updated_at=? WHERE channel=? AND model=?').run(now(), channelName, model)
    }
    entries[index] = entry
    await putProviderKeyEntries(endpoint, entries)
    return true
  }
  return false
}

export async function setChannelModelEnabled(channelName: string, model: string, enabled: boolean) {
  invalidateGatewaySnapshot()
  const live = await getCompatChannels()
  const index = live.findIndex((channel) => String(channel.name || '') === channelName)
  if (index < 0) {
    if (await setProviderChannelModelEnabled(channelName, model, enabled)) return
    throw new Error('渠道未启用，无法调整模型')
  }
  const channel = live[index]
  const models = [...(channel.models || [])]

  if (!enabled) {
    // 同一对外模型名可能有多条上游条目，必须整组摘除并整组存档。
    const targets = models.filter((item) => modelId(item) === model)
    if (!targets.length) throw new Error('模型不存在或已停用')
    db.prepare('INSERT INTO channel_model_states (channel,model,enabled,snapshot_json,updated_at) VALUES (?,?,0,?,?) ON CONFLICT(channel,model) DO UPDATE SET enabled=0,snapshot_json=excluded.snapshot_json,updated_at=excluded.updated_at')
      .run(channelName, model, JSON.stringify(targets), now())
    channel.models = models.filter((item) => modelId(item) !== model)
  } else {
    if (models.some((item) => modelId(item) === model)) return
    const row = db.prepare('SELECT * FROM channel_model_states WHERE channel=? AND model=?').get(channelName, model) as ModelSnapshotRow | undefined
    const stored = row?.snapshot_json ? parse<CompatModel | CompatModel[] | null>(row.snapshot_json, null) : null
    // 旧版本存的是单条对象，新版本存数组，两种都要能恢复。
    const snapshot = Array.isArray(stored) ? stored : stored ? [stored] : []
    if (!snapshot.length) throw new Error('没有可恢复的模型配置')
    channel.models = [...models, ...snapshot]
    db.prepare('UPDATE channel_model_states SET enabled=1, updated_at=? WHERE channel=? AND model=?').run(now(), channelName, model)
  }

  live[index] = channel
  await putCompatChannels(live)
}

export async function removeChannel(name: string) {
  invalidateGatewaySnapshot()
  const live = await getCompatChannels()
  if (live.some((channel) => String(channel.name || '') === name)) {
    await deleteCompatChannel(name)
  } else {
    // Kimi 这类渠道挂在 claude-api-key / codex-api-key 等原生端点下，不能只删兼容渠道。
    for (const endpoint of PROVIDER_KEY_ENDPOINTS) {
      const entries = await getProviderKeyEntries(endpoint).catch(() => [] as ProviderKeyEntry[])
      const index = entries.findIndex((entry, position) => providerChannelName(entry, endpoint, position) === name)
      if (index < 0) continue
      await putProviderKeyEntries(endpoint, entries.filter((_, position) => position !== index))
      break
    }
  }
  db.prepare('DELETE FROM channel_states WHERE name=?').run(name)
  db.prepare('DELETE FROM channel_model_states WHERE channel=?').run(name)
}

const discoveryHeaders = (protocol: ChannelProtocol, apiKey: string): Record<string, string> => protocol === 'claude'
  ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
  : { Authorization: `Bearer ${apiKey}` }

export async function discoverChannelModels(protocol: ChannelProtocol, baseUrl: string, apiKey: string): Promise<{
  models: DiscoveredModel[]
  endpoint: string
}> {
  if (!apiKey.trim()) throw new Error('请输入 API Key')
  const errors: string[] = []
  for (const endpoint of modelDiscoveryUrls(protocol, baseUrl)) {
    try {
      const result = await apiCall(undefined, endpoint, { header: discoveryHeaders(protocol, apiKey.trim()) })
      const status = Number(result.status_code ?? result.statusCode ?? 0)
      if (status < 200 || status >= 300) {
        errors.push(`${endpoint}: HTTP ${status || '未知'}`)
        continue
      }
      const models = normalizeDiscoveredModels(result.body ?? result.body_text)
      if (!models.length) {
        errors.push(`${endpoint}: 返回中没有模型`)
        continue
      }
      return { models, endpoint }
    } catch (error) {
      errors.push(`${endpoint}: ${error instanceof Error ? error.message : '请求失败'}`)
    }
  }
  throw new Error(`模型扫描失败。${errors.join('；').slice(0, 500)}`)
}

export async function createChannel(input: {
  name: string
  protocol: ChannelProtocol
  baseUrl: string
  apiKey: string
  models: unknown
}) {
  invalidateGatewaySnapshot()
  const name = validateChannelName(input.name)
  const baseUrl = normalizeBaseUrl(input.baseUrl)
  const apiKey = input.apiKey.trim()
  if (!apiKey) throw new Error('请输入 API Key')
  const models = validateSelectedModels(input.models)
  const existingNames = new Set((await fetchChannels()).map((channel) => channel.name))
  if (existingNames.has(name)) throw new Error(`渠道“${name}”已存在`)

  if (input.protocol === 'claude') {
    const endpoint: ProviderKeyEndpoint = 'claude-api-key'
    const entries = await getProviderKeyEntries(endpoint)
    await putProviderKeyEntries(endpoint, [...entries, {
      'api-key': apiKey,
      'base-url': baseUrl,
      models: models.map((model) => ({ name: model.id, alias: model.alias })),
    }])
  } else {
    const channels = await getCompatChannels()
    await putCompatChannels([...channels, {
      name,
      'base-url': baseUrl,
      'api-key-entries': [{ 'api-key': apiKey }],
      models: models.map((model) => ({ name: model.id, alias: model.alias })),
    }])
  }

  db.prepare('DELETE FROM channel_states WHERE name=?').run(name)
  db.prepare('DELETE FROM channel_model_states WHERE channel=?').run(name)
  return { name, baseUrl, models }
}

/**
 * 清理已经不在网关里、也不是面板主动停用的残留渠道快照。
 * 只删本地记录，不碰 CPA——它们在 CPA 侧本就已经不存在了。
 */
export async function pruneStaleChannels() {
  invalidateGatewaySnapshot()
  const live = new Set([...await getCompatChannels(), ...await getProviderChannels()].map((channel) => String(channel.name || '')))
  const rows = db.prepare('SELECT name, enabled FROM channel_states').all() as Array<{ name: string; enabled: number }>
  const stale = rows.filter((row) => row.enabled && !live.has(row.name)).map((row) => row.name)
  for (const name of stale) {
    db.prepare('DELETE FROM channel_states WHERE name=?').run(name)
    db.prepare('DELETE FROM channel_model_states WHERE channel=?').run(name)
  }
  return stale
}

/** 同步每 15s 跑一轮，模型目录变化远慢于此，缓存住避免重复回网关查。 */
const OAUTH_MODEL_CACHE_TTL_MS = 30_000
let oauthModelCache: { at: number; models: Map<string, string[]> } | null = null

const cachedAuthFileModels = async (name: string) => {
  if (!oauthModelCache || Date.now() - oauthModelCache.at >= OAUTH_MODEL_CACHE_TTL_MS) {
    oauthModelCache = { at: Date.now(), models: new Map() }
  }
  const hit = oauthModelCache.models.get(name)
  if (hit) return hit
  const models = await getAuthFileModels(name)
  oauthModelCache.models.set(name, models)
  return models
}

/** 上一次拿到的非空 OAuth 模型目录，落库以便重启后仍能兜底。 */
const OAUTH_MODELS_SETTING = 'oauth.models.lastKnown'

const readLastKnownOAuthModels = (): Record<string, string[]> => {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(OAUTH_MODELS_SETTING) as { value?: string } | undefined
  return parse(row?.value || '', {} as Record<string, string[]>)
}

const writeLastKnownOAuthModels = (models: Record<string, string[]>) => {
  const kept = Object.fromEntries(Object.entries(models).filter(([, list]) => list.length))
  if (!Object.keys(kept).length) return
  const merged = { ...readLastKnownOAuthModels(), ...kept }
  db.prepare('INSERT INTO app_settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(OAUTH_MODELS_SETTING, JSON.stringify(merged))
}

/** OAuth 凭据（codex/claude/xai…）由网关原生支持禁用，直接透传。 */
async function fetchCredentials() {
  const result = await listAuthFiles()
  const { credentials, models, degraded } = await attachCredentialModels(
    summarizeCredentialFiles(result.files || []),
    cachedAuthFileModels,
    { lastKnown: readLastKnownOAuthModels() },
  )
  if (degraded.length) console.warn(`[oauth-models] 网关未返回模型目录，沿用上一次结果: ${degraded.join(', ')}`)
  writeLastKnownOAuthModels(models)
  return credentials
}

export async function setCredentialEnabled(name: string, enabled: boolean) {
  invalidateGatewaySnapshot()
  await setAuthFileDisabled(name, !enabled)
}

/** 从网关彻底删除该 OAuth 凭据文件，不可恢复。 */
export async function removeCredential(name: string) {
  invalidateGatewaySnapshot()
  await deleteAuthFile(name)
}

/** 凭据级代理写入成功后的观察者（代理池用它维护「账号 → 出口」索引）；观察者出错不影响写入。 */
const credentialProxyListeners = new Set<(name: string, proxyUrl: string) => void>()

export function onCredentialProxyChanged(listener: (name: string, proxyUrl: string) => void) {
  credentialProxyListeners.add(listener)
  return () => credentialProxyListeners.delete(listener)
}

/** 凭据级代理。'' 继承全局，'direct' 强制直连，其余为代理地址。 */
export async function setCredentialProxy(name: string, proxyUrl: string) {
  invalidateGatewaySnapshot()
  await setAuthFileProxy(name, proxyUrl)
  for (const listener of credentialProxyListeners) {
    try { listener(name, proxyUrl) } catch { /* 索引可重建 */ }
  }
}

type CredentialEntry = Awaited<ReturnType<typeof listCredentials>>[number]

/** 把账号按 provider 聚合成 OAuth 渠道，供模型索引使用。 */
export function groupOAuthProviders(credentials: CredentialEntry[], excluded: Record<string, string[]>): OAuthProviderModels[] {
  const byProvider = new Map<string, { models: Set<string>; activeAccounts: number }>()
  for (const credential of credentials) {
    if (!credential.type) continue
    const entry = byProvider.get(credential.type) || { models: new Set<string>(), activeAccounts: 0 }
    if (!credential.disabled) {
      entry.activeAccounts += 1
      for (const model of credential.models) entry.models.add(model)
    }
    byProvider.set(credential.type, entry)
  }
  for (const provider of Object.keys(excluded)) {
    if (!byProvider.has(provider)) byProvider.set(provider, { models: new Set<string>(), activeAccounts: 0 })
  }
  return [...byProvider].map(([provider, entry]) => ({
    provider,
    models: [...entry.models],
    excluded: excluded[provider] || [],
    activeAccounts: entry.activeAccounts,
  }))
}

type GatewaySnapshot = {
  channels: Awaited<ReturnType<typeof fetchChannels>>
  credentials: Awaited<ReturnType<typeof fetchCredentials>>
  excluded: Record<string, string[]>
}

/**
 * 在 CPA 官方面板里改的渠道/账号要尽快反映到这里。15s 内直接复用；
 * 之后最多再沿用 30s 旧快照（同时后台刷新），不能像以前那样陈旧长达 5 分钟。
 * 页面上的「刷新」按钮会先 invalidateGatewaySnapshot() 强制重新拉取。
 */
const gatewaySnapshotCoordinator = new RequestCoordinator<GatewaySnapshot>({
  ttlMs: 15_000,
  staleWhileRevalidateMs: 30_000,
})

const loadGatewaySnapshot = async (): Promise<GatewaySnapshot> => {
  const [channels, credentials, excluded] = await Promise.all([
    fetchChannels(),
    fetchCredentials(),
    getExcludedModels(),
  ])
  const snapshot = { channels, credentials, excluded }
  try {
    reportingGroupStore.write(buildGroups(channels, groupOAuthProviders(credentials, excluded)))
  } catch {
    console.warn('[reporting-groups] 无法持久化最新渠道策略，继续沿用上次成功结果')
  }
  return snapshot
}

const gatewaySnapshot = () => gatewaySnapshotCoordinator.run('gateway', loadGatewaySnapshot)

export function invalidateGatewaySnapshot() {
  gatewaySnapshotCoordinator.clear('gateway')
}

export async function listChannels() {
  return (await gatewaySnapshot()).channels
}

export async function listCredentials() {
  return (await gatewaySnapshot()).credentials
}

export async function listModelIndex() {
  const { channels, credentials, excluded } = await gatewaySnapshot()
  // 价格取网关下发的 cost；控制面暂时取不到时不阻断页面，回落静态表。
  const gatewayPricing = await gatewayPricingMap().catch(() => undefined)
  return { models: buildModelIndex(channels, groupOAuthProviders(credentials, excluded), gatewayPricing), channels, credentials }
}

/** 分组直接由同一份网关快照推导，避免一次页面加载重复扇出控制面接口。 */
export async function listGroups() {
  const { channels, credentials, excluded } = await gatewaySnapshot()
  return buildGroups(channels, groupOAuthProviders(credentials, excluded))
}

/**
 * Reporting may use the last validated control-plane result while a refresh runs.
 * Authentication, mutations and quota enforcement continue to call listGroups().
 */
export async function listGroupsForReporting() {
  const stored = reportingGroupStore.read()
  if (!stored) return listGroups()
  void gatewaySnapshot().catch(() => undefined)
  return stored.groups
}

/** compat 渠道走本地快照增删，oauth 渠道走网关的 oauth-excluded-models。 */
export async function setModelSourceEnabled(model: string, channel: string, kind: 'compat' | 'oauth', enabled: boolean) {
  invalidateGatewaySnapshot()
  if (kind === 'compat') return setChannelModelEnabled(channel, model, enabled)
  const excluded = await getExcludedModels()
  const current = new Set(excluded[channel] || [])
  if (enabled) current.delete(model)
  else current.add(model)
  const next = { ...excluded, [channel]: [...current] }
  if (!next[channel].length) delete next[channel]
  await putExcludedModels(next)
}
