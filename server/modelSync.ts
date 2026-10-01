import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { config } from './config.js'
import { getCompatChannels, putCompatChannels } from './cpa.js'
import { invalidateGatewaySnapshot } from './channels.js'
import { modelDiscoveryUrls, normalizeDiscoveredModels, defaultModelAlias, type DiscoveredModel } from './channelDiscovery.js'
import { readMagpieChannels, writeChannels, type MagpieChannel } from './magpieControl.js'
import { applySharedPricing, type PriceSourceId, type SourcePrice } from './pricing.js'

export type ModelSyncResult = {
  addedModels: string[]
  totalModels: number
  channelCount: number
  source: 'shared-catalog' | 'channel-probe' | 'merged' | 'none'
  syncedAt: string
}

export type SharedCatalogModel = {
  id: string
  name?: string
  contextWindow?: number
  maxTokens?: number
  input?: string[]
  output?: string[]
  supportsReasoning?: boolean
  efforts?: string[]
  cost?: {
    input?: number
    output?: number
    cacheRead?: number
    cacheWrite?: number
  }
}

/** task-78：共享产物里的 `pricing` 段（双源价格 + 各自时间戳）。 */
export type SharedPricingSection = {
  sources?: Record<string, { ok?: boolean; fetchedAt?: number; entries?: number; error?: string }>
  rows?: Array<{
    id: string
    source: PriceSourceId
    sourceId?: string
    name?: string
    contextWindow?: number
    maxTokens?: number
    prices?: Partial<Record<PriceSourceId, SourcePrice>>
  }>
}

export type SharedCatalog = {
  version: number
  generatedAt: number
  /** task-78：双源价格段（由共享同步实现写入；老产物没有这段 ⇒ adapter 如实降级） */
  pricing?: SharedPricingSection
  provider: string
  baseUrl: string
  models: SharedCatalogModel[]
}

export function sharedCatalogPath(): string {
  return process.env.CROSERY_SHARED_CATALOG || path.join(os.homedir(), '.agents/crosery/catalog.json')
}

export function readSharedCatalog(): SharedCatalog | null {
  const file = sharedCatalogPath()
  try {
    if (!fs.existsSync(file)) return null
    const raw = fs.readFileSync(file, 'utf8')
    const parsed = JSON.parse(raw) as SharedCatalog
    if (parsed && Array.isArray(parsed.models)) return parsed
  } catch {
    // ignore read/parse errors
  }
  return null
}

/**
 * 薄 adapter（task-78）：把共享产物里的 `pricing` 段灌进 `pricing.ts` 的来源价格表。
 *
 * **不联网**：唯一的联网实现是 `~/.agents/crosery/sync.mjs`，它把两个来源的价格写进
 * `catalog.json`；本仓库只读产物。取不到就如实返回 `degraded`（展示层要能看见，
 * 而不是把旧值冒充成新值）。
 */
export function loadSharedPricing(): { ok: boolean; models: number; rows: number; degraded: string[]; path: string } {
  const file = sharedCatalogPath()
  const catalog = readSharedCatalog()
  const pricing = catalog?.pricing
  if (!pricing || !Array.isArray(pricing.rows)) {
    const result = applySharedPricing(null)
    return { ok: false, models: 0, rows: 0, degraded: result.degraded, path: file }
  }
  const result = applySharedPricing({ rows: pricing.rows, sources: pricing.sources })
  return { ok: result.models > 0, models: result.models, rows: result.rows, degraded: result.degraded, path: file }
}

async function probeChannelModels(baseUrl: string, apiKey?: string): Promise<DiscoveredModel[]> {
  const urls = modelDiscoveryUrls('openai', baseUrl)
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`

  for (const url of urls) {
    try {
      const response = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(6000),
      })
      if (!response.ok) continue
      const data = await response.json()
      const models = normalizeDiscoveredModels(data)
      if (models.length > 0) return models
    } catch {
      // try next url
    }
  }
  return []
}

/**
 * 动态检测并同步上游模型：
 * 1. 优先读取跨 harness 共享的 ~/.agents/crosery/catalog.json（由 sync.mjs 从网关与 models.dev 自动维护）
 * 2. 结合各渠道 base-url 的 /models 接口在线探活
 * 3. 自动将新模型合入对应渠道，无需重启服务或手动配置
 */
export async function syncUpstreamModels(_options: { force?: boolean } = {}): Promise<ModelSyncResult> {
  const shared = readSharedCatalog()
  const addedModels: string[] = []
  const timestamp = new Date().toISOString()
  let channelCount = 0
  let totalModels = 0

  if (config.gatewayEngine === 'magpie' && config.magpieControlPlane === 'local') {
    let channels: MagpieChannel[] = []
    try {
      channels = readMagpieChannels()
    } catch {
      channels = []
    }
    channelCount = channels.length

    const seenModelKeys = new Set<string>()
    for (const ch of channels) {
      for (const m of ch.models) {
        seenModelKeys.add(`${ch.name}:${m.name.toLowerCase()}`)
        if (m.alias) seenModelKeys.add(`${ch.name}:${m.alias.toLowerCase()}`)
      }
    }

    let modified = false

    // 1. 如果存在跨 harness 共享的 catalog.json，把里面所有的最新模型同步进对应渠道
    if (shared && shared.models.length > 0) {
      // 如果只有一个主渠道或有名为 crosery / openai 的默认渠道，优先补入
      const targetChannel = channels.find(c => !c.disabled) || channels[0]
      if (targetChannel) {
        for (const model of shared.models) {
          const modelId = model.id.trim()
          if (!modelId) continue
          const key = `${targetChannel.name}:${modelId.toLowerCase()}`
          if (!seenModelKeys.has(key)) {
            targetChannel.models.push({
              name: modelId,
              alias: defaultModelAlias(modelId),
            })
            seenModelKeys.add(key)
            addedModels.push(modelId)
            modified = true
          }
        }
      }
    }

    // 2. 在线探测各渠道的 /models 端点
    for (const channel of channels) {
      if (channel.disabled || !channel['base-url']) continue
      const firstKey = channel['api-key-entries']?.[0]?.['api-key']
      let rawKey = ''
      if (firstKey && !firstKey.startsWith('env:') && !firstKey.startsWith('cpa:')) {
        rawKey = firstKey
      }
      try {
        const discovered = await probeChannelModels(channel['base-url'], rawKey)
        for (const item of discovered) {
          const key = `${channel.name}:${item.id.toLowerCase()}`
          if (!seenModelKeys.has(key)) {
            channel.models.push({
              name: item.id,
              alias: item.alias,
            })
            seenModelKeys.add(key)
            if (!addedModels.includes(item.id)) addedModels.push(item.id)
            modified = true
          }
        }
      } catch {
        // ignore probe failure for individual channel
      }
    }

    if (modified) {
      writeChannels(channels)
      invalidateGatewaySnapshot()

      // 如果 Magpie runtime 正在运行，动态通知内核刷新 provider
      try {
        const { magpieRoutes } = await import('./magpieRuntime.js')
        const { kernelJSON } = await import('./magpieEngine.js')
        const routes = await magpieRoutes()
        const providers = routes.map(r => r.provider)
        await kernelJSON(config.magpieKernelSocket, '/internal/providers', 'PUT', providers)
      } catch {
        // kernel might not be active, channels are saved for next request
      }
    }

    totalModels = channels.reduce((sum, c) => sum + c.models.length, 0)
    return {
      addedModels,
      totalModels,
      channelCount,
      source: shared ? (addedModels.length > 0 ? 'merged' : 'shared-catalog') : 'channel-probe',
      syncedAt: timestamp,
    }
  }

  // CPA 模式下同步
  try {
    const channels = await getCompatChannels()
    channelCount = channels.length
    let modified = false

    const seenModelKeys = new Set<string>()
    for (const ch of channels) {
      for (const m of (ch.models || [])) {
        const name = (m.name || m.alias || '').toLowerCase()
        if (name) seenModelKeys.add(`${ch.name}:${name}`)
      }
    }

    if (shared && shared.models.length > 0) {
      const targetChannel = channels.find(c => !c.disabled) || channels[0]
      if (targetChannel) {
        targetChannel.models = targetChannel.models || []
        for (const model of shared.models) {
          const modelId = model.id.trim()
          if (!modelId) continue
          const key = `${targetChannel.name}:${modelId.toLowerCase()}`
          if (!seenModelKeys.has(key)) {
            targetChannel.models.push({
              name: modelId,
              alias: defaultModelAlias(modelId),
            })
            seenModelKeys.add(key)
            addedModels.push(modelId)
            modified = true
          }
        }
      }
    }

    for (const channel of channels) {
      if (channel.disabled || !channel['base-url']) continue
      const firstKey = channel['api-key-entries']?.[0]?.['api-key']
      try {
        const discovered = await probeChannelModels(channel['base-url'], firstKey)
        channel.models = channel.models || []
        for (const item of discovered) {
          const key = `${channel.name}:${item.id.toLowerCase()}`
          if (!seenModelKeys.has(key)) {
            channel.models.push({
              name: item.id,
              alias: item.alias,
            })
            seenModelKeys.add(key)
            if (!addedModels.includes(item.id)) addedModels.push(item.id)
            modified = true
          }
        }
      } catch {
        // ignore
      }
    }

    if (modified) {
      await putCompatChannels(channels)
      invalidateGatewaySnapshot()
    }

    totalModels = channels.reduce((sum, c) => sum + (c.models?.length || 0), 0)
    return {
      addedModels,
      totalModels,
      channelCount,
      source: shared ? 'merged' : 'channel-probe',
      syncedAt: timestamp,
    }
  } catch {
    return {
      addedModels: [],
      totalModels: 0,
      channelCount: 0,
      source: 'none',
      syncedAt: timestamp,
    }
  }
}

let watcherActive = false
let watcherDebounce: NodeJS.Timeout | null = null

/**
 * 启动模型目录后台文件监听与定时同步守护：
 * 当 ~/.agents/crosery/catalog.json 更新时，第一时间自动同步最新模型
 */
export function startModelCatalogWatcher(options: { pollIntervalMs?: number } = {}) {
  if (watcherActive) return
  watcherActive = true

  const catalogFile = sharedCatalogPath()

  try {
    if (fs.existsSync(catalogFile)) {
      fs.watch(catalogFile, () => {
        if (watcherDebounce) clearTimeout(watcherDebounce)
        watcherDebounce = setTimeout(() => {
          void syncUpstreamModels().then((result) => {
            if (result.addedModels.length > 0) {
              console.log(JSON.stringify({
                event: 'upstream_models_auto_synced',
                addedCount: result.addedModels.length,
                models: result.addedModels,
                total: result.totalModels,
              }))
            }
          }).catch(() => {})
        }, 500)
      })
    }
  } catch {
    // watch may not be available on all environments
  }

  const pollInterval = options.pollIntervalMs || 300_000 // 5 minutes default
  const timer = setInterval(() => {
    void syncUpstreamModels().catch(() => {})
  }, pollInterval)
  timer.unref()
}
