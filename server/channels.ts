import { channelKeyRef, channelKeyViews, mergeChannelView, type ChannelKeyView } from './channelView.js'
import type { ChannelSnapshotRow, ModelStateRow } from './channelView.js'
import { apiCall, deleteAuthFile, deleteCompatChannel, getAuthFileModels, getCompatChannels, getExcludedModels, getProviderKeyEntries, listAuthFiles, modelId, providerChannelName, putCompatChannels, putExcludedModels, putProviderKeyEntries, setAuthFileDisabled, setAuthFilePriority, setAuthFileProxy, PROVIDER_KEY_ENDPOINTS, type ProviderKeyEndpoint, type ProviderKeyEntry } from './cpa.js'
import type { CompatChannel, CompatModel } from './cpa.js'
import { buildGroups } from './groups.js'
import { buildModelIndex } from './modelIndex.js'
import { applyRoutes } from './modelRoutes.js'
import { gatewayPricingMap } from './modelCatalog.js'
import type { OAuthProviderModels } from './modelIndex.js'
import { db } from './db.js'
import { attachCredentialModels, summarizeCredentialFiles } from './credentials.js'
import { defaultModelAlias, discoveryFailure, freeAlias, isDirectPreferred, modelDiscoveryUrls, normalizeBaseUrl, normalizeDiscoveredModels, validateChannelName, validateSelectedModels, type ChannelProtocol, type DiscoveredModel } from './channelDiscovery.js'
import { RequestCoordinator } from './requestCoordinator.js'
import { ReportingGroupStore } from './reportingGroups.js'
import { DEFAULT_OPEN_CHANNELS } from './keyChannelAccess.js'
import { currentAvailability, modelAvailabilityEnabled, withModelAvailability } from './modelAvailability.js'

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
      'api-key-entries': entry['api-key'] ? [{ 'api-key': String(entry['api-key']), ...(entry['proxy-url'] ? { 'proxy-url': String(entry['proxy-url']) } : {}) }] : [],
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

export type ChannelModelChanges = {
  /** 上游有、渠道里没有的模型：enabled=true 接入；false 记成人工停用（自动同步不会再加回来）。 */
  add: Array<{ id: string; alias: string; enabled: boolean }>
  /** 对外名：从人工停用恢复。 */
  enable: string[]
  /** 对外名：人工停用（摘映射 + 写墓碑）。 */
  disable: string[]
  /** 上游 id（映射的 name）：直接摘掉，不写墓碑——上游以后又列出来时自动同步会照常加回。 */
  remove: string[]
}

const MAX_MODEL_CHANGES = 2000
const modelText = (value: unknown, field: string): string => {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text || text.length > 300 || /[\u0000-\u001f]/.test(text)) throw new ChannelKeyError(400, 'invalid_changes', `${field} 不合法`)
  return text
}

export function validateModelChanges(input: unknown): ChannelModelChanges {
  const body = input && typeof input === 'object' ? input as Record<string, unknown> : {}
  const list = (value: unknown, field: string): unknown[] => {
    if (value === undefined) return []
    if (!Array.isArray(value) || value.length > MAX_MODEL_CHANGES) throw new ChannelKeyError(400, 'invalid_changes', `${field} 必须是不超过 ${MAX_MODEL_CHANGES} 项的数组`)
    return value
  }
  const add = list(body.add, 'add').map((item) => {
    const row = item && typeof item === 'object' ? item as Record<string, unknown> : {}
    const id = modelText(row.id, 'add.id')
    return { id, alias: row.alias === undefined || row.alias === '' ? defaultModelAlias(id) : modelText(row.alias, 'add.alias'), enabled: row.enabled !== false }
  })
  const changes = {
    add,
    enable: list(body.enable, 'enable').map((value) => modelText(value, 'enable')),
    disable: list(body.disable, 'disable').map((value) => modelText(value, 'disable')),
    remove: list(body.remove, 'remove').map((value) => modelText(value, 'remove')),
  }
  if (!changes.add.length && !changes.enable.length && !changes.disable.length && !changes.remove.length) {
    throw new ChannelKeyError(400, 'no_changes', '没有要应用的变更')
  }
  return changes
}

/**
 * 「拉取模型」第二步：把抽屉里勾选的结果一次写进兼容渠道（一次 PUT，而不是逐个模型各写一次整表）。
 * 停用与「不接入」的墓碑在 PUT 之前写：并发的自动同步读到墓碑就不会把它们加回去；恢复在 PUT 成功后才翻墓碑。
 */
export async function applyChannelModelChanges(channelName: string, input: unknown) {
  const changes = validateModelChanges(input)
  invalidateGatewaySnapshot()
  const live = await getCompatChannels()
  const index = live.findIndex((channel) => String(channel.name || '') === channelName)
  if (index < 0) {
    if ((await getProviderChannels()).some((channel) => String(channel.name || '') === channelName)) {
      throw new ChannelKeyError(409, 'channel_not_supported', '原生协议渠道暂不支持按上游列表勾选模型')
    }
    if ((await listChannels()).some((channel) => channel.name === channelName)) {
      throw new ChannelKeyError(409, 'channel_disabled', '渠道停用中 · 先启用再调整模型')
    }
    throw new ChannelKeyError(404, 'channel_not_found', '渠道不存在')
  }

  const channel = live[index]
  let models = [...(channel.models || [])]
  const key = (value: string) => value.trim().toLowerCase()
  const has = (value: string) => models.some((item) => key(String(item.name || '')) === key(value) || key(modelId(item)) === key(value))
  const stamp = now()
  const tombstone = db.prepare('INSERT INTO channel_model_states (channel,model,enabled,snapshot_json,updated_at) VALUES (?,?,0,?,?) ON CONFLICT(channel,model) DO UPDATE SET enabled=0,snapshot_json=excluded.snapshot_json,updated_at=excluded.updated_at')
  const restored: string[] = []
  const done = { added: 0, declined: 0, enabled: 0, disabled: 0, removed: 0 }

  for (const exposed of changes.disable) {
    const targets = models.filter((item) => modelId(item) === exposed)
    if (!targets.length) continue
    tombstone.run(channelName, exposed, JSON.stringify(targets), stamp)
    models = models.filter((item) => modelId(item) !== exposed)
    done.disabled += 1
  }
  for (const id of changes.remove) {
    const before = models.length
    models = models.filter((item) => key(String(item.name || item.alias || '')) !== key(id))
    if (models.length < before) done.removed += 1
  }
  for (const exposed of changes.enable) {
    if (models.some((item) => modelId(item) === exposed)) continue
    const row = db.prepare('SELECT * FROM channel_model_states WHERE channel=? AND model=?').get(channelName, exposed) as ModelSnapshotRow | undefined
    const stored = row?.snapshot_json ? parse<CompatModel | CompatModel[] | null>(row.snapshot_json, null) : null
    const snapshot = Array.isArray(stored) ? stored : stored ? [stored] : []
    if (!snapshot.length) continue
    models = [...models, ...snapshot]
    restored.push(exposed)
    done.enabled += 1
  }
  for (const item of changes.add) {
    if (has(item.id)) continue
    const entry: CompatModel = { name: item.id, alias: has(item.alias) ? freeAlias(item.id, new Set(models.map((model) => modelId(model).toLowerCase()))) : item.alias }
    if (item.enabled) {
      models.push(entry)
      done.added += 1
    } else {
      tombstone.run(channelName, item.alias, JSON.stringify([entry]), stamp)
      done.declined += 1
    }
  }

  if (done.added || done.enabled || done.disabled || done.removed) {
    channel.models = models
    live[index] = channel
    await putCompatChannels(live)
  }
  const reopen = db.prepare('UPDATE channel_model_states SET enabled=1, updated_at=? WHERE channel=? AND model=?')
  for (const exposed of restored) reopen.run(now(), channelName, exposed)
  return done
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
  db.prepare('DELETE FROM channel_sync_policies WHERE channel=?').run(name)
}

/** 聚合渠道（上游列表里大多是付费模型）没有明确设置时默认不参与：OpenRouter 一次整表同步会接入几百个付费模型。 */
const AGGREGATOR_HOST = /(^|\.)openrouter\.ai$/i
export function autoSyncDefault(baseUrl: string | undefined): boolean {
  try {
    return !AGGREGATOR_HOST.test(new URL(String(baseUrl ?? '')).hostname)
  } catch {
    return true
  }
}

/** 渠道是否参与定时模型同步：显式设置优先，没有设置过的默认参与（聚合渠道除外）。读一次库，返回判断函数。 */
export function readAutoSyncPolicy(): (channel: { name: string; baseUrl?: string }) => boolean {
  const rows = db.prepare('SELECT channel, auto_sync FROM channel_sync_policies').all() as Array<{ channel: string; auto_sync: number }>
  const explicit = new Map(rows.map((row) => [String(row.channel), Number(row.auto_sync) === 1]))
  return (channel) => explicit.get(channel.name) ?? autoSyncDefault(channel.baseUrl)
}

export function setChannelAutoSync(name: string, enabled: boolean) {
  db.prepare(`
    INSERT INTO channel_sync_policies (channel, auto_sync, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(channel) DO UPDATE SET auto_sync=excluded.auto_sync, updated_at=excluded.updated_at
  `).run(name, enabled ? 1 : 0, now())
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
  const directFirst = isDirectPreferred(baseUrl)
  for (const endpoint of modelDiscoveryUrls(protocol, baseUrl)) {
    try {
      let result: Awaited<ReturnType<typeof apiCall>> | null = null
      const firstProxy = directFirst ? 'direct' : undefined
      const secondProxy = directFirst ? undefined : 'direct'
      try {
        result = await apiCall(undefined, endpoint, { header: discoveryHeaders(protocol, apiKey.trim()), proxyUrl: firstProxy })
        const status = Number(result?.status_code ?? result?.statusCode ?? 0)
        if (status === 502 || status === 504 || (status === 0 && !directFirst)) {
          result = await apiCall(undefined, endpoint, { header: discoveryHeaders(protocol, apiKey.trim()), proxyUrl: secondProxy })
        }
      } catch {
        result = await apiCall(undefined, endpoint, { header: discoveryHeaders(protocol, apiKey.trim()), proxyUrl: secondProxy })
      }
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
      errors.push(`${endpoint}: ${discoveryFailure(error)}`)
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
  proxyUrl?: string
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
    const pUrl = typeof input.proxyUrl === 'string' ? input.proxyUrl.trim() : ''
    // API 渠道默认直连（国内访问快，不走全局的国外出口）；要走国外出口的渠道在创建时或之后在出口里单独选。
    const effectiveProxy = pUrl || 'direct'
    await putCompatChannels([...channels, {
      name,
      'base-url': baseUrl,
      ...(effectiveProxy ? { 'proxy-url': effectiveProxy } : {}),
      'api-key-entries': [{ 'api-key': apiKey, ...(effectiveProxy ? { 'proxy-url': effectiveProxy } : {}) }],
      models: models.map((model) => ({ name: model.id, alias: model.alias })),
      // Responses 中继：CPA 内核（补丁 0008）按 relay-mode 把请求直发上游 /responses。
      ...(input.protocol === 'responses' ? { 'relay-mode': 'responses' } : {}),
    }])
  }

  db.prepare('DELETE FROM channel_states WHERE name=?').run(name)
  db.prepare('DELETE FROM channel_model_states WHERE channel=?').run(name)
  return { name, baseUrl, models }
}

/** 一个渠道最多几把上游 Key：够轮换与多上游分流，又不至于让渠道难读、探测成本失控。 */
export const MAX_CHANNEL_KEYS = 8

/** 上游 Key 增删的失败：status 给路由层映射 HTTP，reason 给前端与 CLI 分支。 */
export class ChannelKeyError extends Error {
  constructor(readonly status: number, readonly reason: string, message: string) {
    super(message)
    this.name = 'ChannelKeyError'
  }
}

/**
 * 找到兼容渠道在 CPA 表里的下标。找不到时分清三种「不存在」：
 * 挂在原生端点（每渠道只有一把 Key，结构上就不支持多把）、面板停用（先启用）、真的没有（404）。
 */
async function requireCompatChannel(live: CompatChannel[], name: string): Promise<number> {
  const index = live.findIndex((channel) => String(channel.name || '') === name)
  if (index >= 0) return index
  if ((await getProviderChannels()).some((channel) => String(channel.name || '') === name)) {
    throw new ChannelKeyError(409, 'keys_unsupported', '这个渠道挂在 Anthropic / Codex 等原生端点下，每渠道只能有一把上游 Key')
  }
  if ((await listChannels()).some((channel) => channel.name === name)) {
    throw new ChannelKeyError(409, 'channel_disabled', '渠道停用中 · 先启用再改上游 Key')
  }
  throw new ChannelKeyError(404, 'channel_not_found', '渠道不存在')
}

/**
 * 加一把上游 Key。**先拿这把 Key 真打一次上游 /models**，探测不过就不落表——
 * 加进去一把用不了的 Key，只会把渠道的失败率推高，还看不出是哪把坏的。
 * 内核按条目轮询，多把 Key 之间是并列关系，没有主备顺序。
 */
export async function addChannelApiKey(name: string, apiKey: string): Promise<ChannelKeyView[]> {
  const key = apiKey.trim()
  if (!key) throw new ChannelKeyError(400, 'empty_key', '请输入 API Key')
  invalidateGatewaySnapshot()
  const live = await getCompatChannels()
  const index = await requireCompatChannel(live, name)
  const channel = live[index]
  const entries = [...(channel['api-key-entries'] || [])]
  if (entries.some((entry) => String(entry['api-key'] || '') === key)) {
    throw new ChannelKeyError(409, 'key_exists', '这把 Key 已经在渠道里了')
  }
  if (entries.length >= MAX_CHANNEL_KEYS) {
    throw new ChannelKeyError(409, 'key_limit', `一个渠道最多 ${MAX_CHANNEL_KEYS} 把上游 Key`)
  }
  const protocol: ChannelProtocol = String(channel['relay-mode'] || '') === 'responses' ? 'responses' : 'openai'
  await discoverChannelModels(protocol, String(channel['base-url'] || ''), key)
  // 新加的 Key 跟渠道现有的出口走；渠道没设过 = 默认直连
  const inherited = String(channel['proxy-url'] || entries.find((entry) => entry['proxy-url'])?.['proxy-url'] || '') || 'direct'
  live[index] = { ...channel, 'api-key-entries': [...entries, { 'api-key': key, 'proxy-url': inherited }] }
  await putCompatChannels(live)
  return channelKeyViews(live[index]['api-key-entries'])
}

/**
 * 删一把上游 Key，按 sha256 前 12 位定位（见 channelKeyRef）。
 * 禁止删到最后一把：渠道没有 Key 时所有请求都会失败，而那等同于删渠道——
 * 要收掉整个渠道，走删除渠道，停用快照与模型开关一起清理干净。
 */
export async function removeChannelApiKey(name: string, ref: string): Promise<ChannelKeyView[]> {
  invalidateGatewaySnapshot()
  const live = await getCompatChannels()
  const index = await requireCompatChannel(live, name)
  const channel = live[index]
  const entries = [...(channel['api-key-entries'] || [])]
  const target = entries.findIndex((entry) => channelKeyRef(String(entry['api-key'] || '')) === ref)
  if (target < 0) throw new ChannelKeyError(404, 'key_not_found', '渠道里没有这把 Key')
  if (entries.length <= 1) {
    throw new ChannelKeyError(409, 'last_key', '不能删掉最后一把上游 Key · 先加新 Key 再删旧的；要收掉整个渠道请删除渠道')
  }
  entries.splice(target, 1)
  live[index] = { ...channel, 'api-key-entries': entries }
  await putCompatChannels(live)
  return channelKeyViews(live[index]['api-key-entries'])
}

/** 设置渠道的出口代理（'direct'、指定代理地址或空串继承全局）。 */
export async function setChannelProxy(channelName: string, proxyUrl: string) {
  invalidateGatewaySnapshot()
  const live = await getCompatChannels()
  const index = live.findIndex((channel) => String(channel.name || '') === channelName)
  if (index < 0) {
    // 原生协议渠道（claude-api-key 这类）：出口写在条目自己的 proxy-url 上
    for (const endpoint of PROVIDER_KEY_ENDPOINTS) {
      const entries = await getProviderKeyEntries(endpoint)
      const at = entries.findIndex((entry, i) => providerChannelName(entry, endpoint, i) === channelName)
      if (at < 0) continue
      const next = { ...entries[at] }
      if (proxyUrl.trim()) next['proxy-url'] = proxyUrl.trim()
      else delete next['proxy-url']
      entries[at] = next
      await putProviderKeyEntries(endpoint, entries)
      return
    }
    throw new Error('渠道不存在')
  }
  const p = proxyUrl.trim()
  const channel = live[index]
  const entries = (channel['api-key-entries'] || []).map((e) => {
    const updated = { ...e }
    if (p) updated['proxy-url'] = p
    else delete updated['proxy-url']
    return updated
  })
  const updated: CompatChannel = { ...channel, 'api-key-entries': entries }
  if (p) updated['proxy-url'] = p
  else delete updated['proxy-url']
  live[index] = updated
  await putCompatChannels(live)
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

/** 「拉取模型」的一次性读：不写也不读目录缓存，同一轮里同名的重复请求也会各打一次网关。 */
const authFileModelsUncached = (name: string) => getAuthFileModels(name)

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

/**
 * 账号池「拉取模型」的落点：**重读网关下发的目录**，不是向上游探测。
 * 订阅账号的模型由网关按凭据解析（/auth-files/models），控制台不持有 OAuth token，
 * 也无从构造上游 /models 请求——所以这里只丢开 30s 目录缓存与 15s 网关快照真打一次网关。
 * 人工停用的模型不受影响：目录只被读，停用走 oauth-excluded-models，与本函数无关。
 */
export async function refreshCredentialModels(): Promise<{
  credentials: Awaited<ReturnType<typeof listCredentials>>
  /** 有在线凭据却读到空目录、按规则沿用上次结果的 provider（网关抖动 / 凭据刚换） */
  degraded: string[]
  models: Record<string, string[]>
}> {
  invalidateGatewaySnapshot()
  oauthModelCache = null
  const credentials = await fetchCredentials({ force: true })
  return { credentials, degraded: lastDegradedProviders, models: lastFetchedProviderModels }
}

/** OAuth 凭据（codex/claude/xai…）由网关原生支持禁用，直接透传。 */
let lastDegradedProviders: string[] = []
let lastFetchedProviderModels: Record<string, string[]> = {}

async function fetchCredentials(options: { force?: boolean } = {}) {
  const result = await listAuthFiles()
  const { credentials, models, degraded } = await attachCredentialModels(
    summarizeCredentialFiles(result.files || []),
    options.force ? authFileModelsUncached : cachedAuthFileModels,
    { lastKnown: readLastKnownOAuthModels() },
  )
  lastDegradedProviders = degraded
  lastFetchedProviderModels = models
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
  const byProvider = new Map<string, { models: Set<string>; activeAccounts: number; accounts: number; weights: Set<number> }>()
  for (const credential of credentials) {
    if (!credential.type) continue
    const entry = byProvider.get(credential.type) || { models: new Set<string>(), activeAccounts: 0, accounts: 0, weights: new Set<number>() }
    entry.accounts += 1
    if (!credential.disabled) {
      entry.activeAccounts += 1
      entry.weights.add(credential.weight ?? 0)
      for (const model of credential.models) entry.models.add(model)
    }
    byProvider.set(credential.type, entry)
  }
  for (const provider of Object.keys(excluded)) {
    if (!byProvider.has(provider)) byProvider.set(provider, { models: new Set<string>(), activeAccounts: 0, accounts: 0, weights: new Set<number>() })
  }
  return [...byProvider].map(([provider, entry]) => ({
    provider,
    models: [...entry.models],
    excluded: excluded[provider] || [],
    activeAccounts: entry.activeAccounts,
    accounts: entry.accounts,
    weight: entry.weights.size ? Math.min(...entry.weights) : 0,
    ...(entry.weights.size > 1 ? { weightMixed: true } : {}),
  }))
}

/**
 * 凭据文件全部删掉（例如账号迁去别的环境）后仍要保留为分组的 OAuth provider：
 * 还被某把 Key 选着的（保住成员关系），以及默认对所有 Key 开放的渠道（保住默认开放模型）。
 */
function retainedOAuthProviders(): Set<string> {
  const retained = new Set<string>(DEFAULT_OPEN_CHANNELS)
  for (const row of db.prepare('SELECT groups_json FROM api_keys').all() as Array<{ groups_json: string }>) {
    const ids = parse<unknown>(row.groups_json, [])
    if (Array.isArray(ids)) for (const id of ids) if (typeof id === 'string' && id) retained.add(id)
  }
  return retained
}

const catalogGroups = ({ channels, credentials, excluded }: GatewaySnapshot) =>
  buildGroups(channels, groupOAuthProviders(credentials, excluded), { lastKnown: readLastKnownOAuthModels(), retain: retainedOAuthProviders() })

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
    reportingGroupStore.write(catalogGroups(snapshot))
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
  return { models: applyRoutes(buildModelIndex(channels, groupOAuthProviders(credentials, excluded), gatewayPricing), credentials), channels, credentials }
}

/** 渠道目录本身（不经可用性过滤）：可用性探测要靠它把下线模型继续测下去，报表按它归组。 */
export async function listGroupCatalog() {
  return catalogGroups(await gatewaySnapshot())
}

/**
 * 授权用的分组：同一份网关快照推导，避免一次页面加载重复扇出控制面接口；
 * 被可用性探测判为下线的模型不进 Key 白名单，重新上线后自动回来。
 */
export async function listGroups() {
  const groups = await listGroupCatalog()
  return modelAvailabilityEnabled() ? withModelAvailability(groups, currentAvailability()) : groups
}

/**
 * Reporting may use the last validated control-plane result while a refresh runs.
 * Authentication, mutations and quota enforcement continue to call listGroups().
 */
export async function listGroupsForReporting() {
  const stored = reportingGroupStore.read()
  if (!stored) return listGroupCatalog()
  void gatewaySnapshot().catch(() => undefined)
  return stored.groups
}

/** compat 渠道走本地快照增删，oauth 渠道走网关的 oauth-excluded-models。 */
export async function setModelSourceEnabled(model: string, channel: string, kind: 'compat' | 'oauth', enabled: boolean) {
  invalidateGatewaySnapshot()
  if (kind === 'compat') return setChannelModelEnabled(channel, model, enabled)
  await setOAuthModelsEnabled(channel, [model], enabled)
}

/** 一次读写 oauth-excluded-models 改一批模型（账号池「拉取模型」弹窗里没勾的新模型），不逐个模型各写一次整表。 */
async function setOAuthModelsEnabled(provider: string, models: string[], enabled: boolean) {
  const excluded = await getExcludedModels()
  const current = new Set(excluded[provider] || [])
  for (const model of models) {
    if (enabled) current.delete(model)
    else current.add(model)
  }
  const next = { ...excluded, [provider]: [...current] }
  if (!next[provider].length) delete next[provider]
  await putExcludedModels(next)
}

/** 账号池批量停用模型：provider 必须是现有凭据的 type；返回实际新停用的个数（已停用的不重复计）。 */
export async function disableOAuthModels(provider: string, input: unknown) {
  const body = input && typeof input === 'object' ? input as Record<string, unknown> : {}
  if (!Array.isArray(body.disable) || !body.disable.length || body.disable.length > MAX_MODEL_CHANGES) {
    throw new ChannelKeyError(400, 'invalid_changes', `disable 必须是 1~${MAX_MODEL_CHANGES} 项的数组`)
  }
  const models = [...new Set(body.disable.map((value) => modelText(value, 'disable')))]
  if (!(await listCredentials()).some((credential) => credential.type === provider)) {
    throw new ChannelKeyError(404, 'channel_not_found', '账号池不存在')
  }
  invalidateGatewaySnapshot()
  const before = new Set((await getExcludedModels())[provider] || [])
  await setOAuthModelsEnabled(provider, models, false)
  return { disabled: models.filter((model) => !before.has(model)).length }
}

/** 权重：整数，越小越优先，默认 0；范围宽到能容纳账号上手工设过的 CPA 优先级（取负）。 */
export const MAX_WEIGHT = 100_000
export function parseWeight(value: unknown): number {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  if (typeof n !== 'number' || !Number.isInteger(n) || Math.abs(n) > MAX_WEIGHT) {
    throw new ChannelKeyError(400, 'invalid_weight', `权重必须是 -${MAX_WEIGHT} 到 ${MAX_WEIGHT} 的整数`)
  }
  return n === 0 ? 0 : n
}
const weightToPriority = (weight: number): number => (weight === 0 ? 0 : -weight)

/** 单个订阅账号的权重 → auth 文件的 priority。 */
export async function setCredentialWeight(name: string, input: unknown) {
  const weight = parseWeight(input)
  invalidateGatewaySnapshot()
  await setAuthFilePriority(name, weightToPriority(weight))
  return { weight }
}
