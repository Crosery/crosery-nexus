import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { config } from './config.js'
import {
  applyGatewayPricing, getModelPricing, getPriceHistory, getPricingSources, normalizeModelForPricing,
  pricingSourceModelIds, pricingSourceStatus, type ModelPricing, type PriceEntry, type PriceSourceId, type SourcePrice,
} from './pricing.js'

export type ModelDefinition = {
  id?: string
  name?: string
  alias?: string
  context_length?: number
  max_context_length?: number
  max_completion_tokens?: number
  inputTokenLimit?: number
  outputTokenLimit?: number
  thinking?: {
    levels?: string[]
    min?: number
    max?: number
    zero_allowed?: boolean
    dynamic_allowed?: boolean
  }
  providers?: string[]
  provider?: string
  /** 网关按 models.dev 动态富化后下发的字段。 */
  total_context_length?: number
  cost?: {
    input?: number
    output?: number
    cache_read?: number
    cache_write?: number
    tiers?: Array<{ min_context_tokens?: number; input?: number; output?: number; cache_read?: number; cache_write?: number }>
  }
  [key: string]: unknown
}

export type CatalogModel = {
  id: string
  providers: string[]
  context_length: number | null
  total_context_length: number | null
  max_completion_tokens: number | null
  thinking: {
    levels?: string[]
    min?: number
    max?: number
    zero_allowed?: boolean
    dynamic_allowed?: boolean
  } | null
  pricing: ModelPricing | null
  /**
   * task-78：两个外部价格来源各自的报价（models.dev / openrouter），带各自抓取时间戳。
   * 缺失的来源**不出现**在这里；两个都缺 + 本地/网关也没有价格 ⇒ `unpriced === true`，
   * 前端必须显示「未收录」而**不是** 0（0 会被读成"免费"）。
   */
  pricingSources?: Partial<Record<PriceSourceId, SourcePrice>>
  /** 是否在网关上可用；价格来源里有、但网关没有的模型 ⇒ false（并集里的"目录已知"部分） */
  availableOnGateway?: boolean
  /** 任何来源都没有价格 ⇒ true（前端显示「未收录」） */
  unpriced?: boolean
  priceHistory: PriceEntry[]
}

// xai 也有目录定义（含价格）。凭据被移除后模型不再出现在 available-models，
// 但历史用量仍需按当时的价结算，所以定义照拉。
const definitionChannels = ['claude', 'codex', 'gemini', 'antigravity', 'xai'] as const

const numberOrNull = (...values: unknown[]) => {
  for (const value of values) {
    const number = Number(value)
    if (Number.isFinite(number) && number > 0) return number
  }
  return null
}

const normalizeDefinitionId = (definition: ModelDefinition) => String(definition.alias || definition.id || definition.name || '').trim()

/**
 * 把网关下发的 cost 转成本地计价结构。网关的 cost 由 CPA 在运行时从 models.dev
 * 拉取，随上游改价自动跟随；本地 pricing.data.json 只在网关没有该模型价格时兜底
 * （例如 models.dev 未收录的 muse-spark）。
 */
function pricingFromGateway(definition: ModelDefinition): ModelPricing | null {
  const cost = definition.cost
  if (!cost) return null
  const input = Number(cost.input)
  const output = Number(cost.output)
  if (!Number.isFinite(input) || !Number.isFinite(output)) return null
  const tiers = (cost.tiers || [])
    .map((tier) => ({
      above: Number(tier.min_context_tokens) || 0,
      input: Number(tier.input) || 0,
      output: Number(tier.output) || 0,
      cacheRead: Number(tier.cache_read) || 0,
      ...(Number.isFinite(Number(tier.cache_write)) ? { cacheWrite: Number(tier.cache_write) } : {}),
    }))
    .filter((tier) => tier.above > 0)
  return {
    from: '1970-01-01',
    input,
    output,
    cacheRead: Number(cost.cache_read) || 0,
    ...(Number.isFinite(Number(cost.cache_write)) ? { cacheWrite: Number(cost.cache_write) } : {}),
    ...(tiers.length ? { tiers } : {}),
    note: '来自网关 /v1/models（models.dev 运行时富化）',
    unit: 'token',
  }
}

/** 与网关 lookupEnrichment 同一套后缀规则，保证两侧对同一模型给出同一价格。 */
const reasoningEffortSuffixes = ['-minimal', '-medium', '-xhigh', '-high', '-low', '-max']

function pricingKeysFor(id: string): string[] {
  const keys = new Set<string>()
  const add = (value: string) => {
    const trimmed = value.trim()
    if (!trimmed) return
    keys.add(trimmed)
    const canonical = normalizeModelForPricing(trimmed)
    if (canonical) keys.add(canonical)
  }
  add(id)
  const lower = id.toLowerCase()
  const undated = lower.replace(/-20\d{6}$/, '')
  if (undated !== lower) add(undated)
  for (const suffix of reasoningEffortSuffixes) {
    if (undated.endsWith(suffix)) add(undated.slice(0, -suffix.length))
  }
  return [...keys]
}

/**
 * 网关价格表：id -> 单价，取自 CPA 下发的 cost（由 CPA 在运行时从 models.dev 拉取）。
 * 模型总览用它优先于本地 pricing.data.json，这样上游改价后面板自动跟随，
 * 不需要重新构建 console。网关没有该模型价格时（models.dev 未收录，例如
 * muse-spark）调用方回落静态表。
 */
/** `failures`（可选）收集本轮没取到的网关价格来源名，供同步中心如实报 partial。 */
export async function gatewayPricingMap(failures?: string[]): Promise<Map<string, ModelPricing>> {
  const map = new Map<string, ModelPricing>()
  if (config.gatewayEngine === 'magpie' && config.magpieControlPlane === 'local') {
    const { readSharedCatalog } = await import('./modelSync.js')
    const shared = readSharedCatalog()
    if (shared?.models) {
      for (const m of shared.models) {
        const pricing = getModelPricing(m.id) ?? (m.cost && typeof m.cost.input === 'number' && typeof m.cost.output === 'number' ? {
          from: '1970-01-01',
          input: Number(m.cost.input) || 0,
          output: Number(m.cost.output) || 0,
          cacheRead: Number(m.cost.cacheRead) || 0,
          unit: 'token' as const,
        } : null)
        if (pricing) {
          for (const key of pricingKeysFor(m.id)) {
            if (!map.has(key)) map.set(key, pricing)
          }
        }
      }
    }
    return map
  }
  // available-models is the only view covering every registered model, including
  // the channels declared in config (openai-compatibility, codex-api-key) whose
  // own endpoints return raw configuration without capability metadata. Without
  // it muse-spark-1.3-contributor and grok-4.6 stay unpriced.
  const sources: Array<{ models: ModelDefinition[] }> = [...(await loadDefinitions(failures))]
  try {
    const headers = { Authorization: `Bearer ${config.cpaManagementKey}` }
    const all = await fetchJson<{ models?: ModelDefinition[] }>(`${config.cpaBaseUrl}/v0/management/available-models`, headers, config.cpaRequestTimeoutMs)
    if (all.models?.length) sources.push({ models: all.models })
  } catch {
    // 取不到就只用按渠道拉到的那份，价格表仍可用。
    failures?.push('available-models')
  }
  for (const source of sources) {
    for (const definition of source.models) {
      const pricing = pricingFromGateway(definition)
      if (!pricing) continue
      const id = normalizeDefinitionId(definition)
      if (!id) continue
      // 目录里的条目名带思考档后缀（gemini-3.8-flash-high），页面显示的是
      // oauth-model-alias 映射出的公开名（gemini-3.8-flash）。两个都登记，
      // 否则公开名查不到价格。与网关侧 lookupEnrichment 的回退规则保持一致：
      // -preview / -pro / -fast 是不同 SKU，不做剥离。
      for (const key of pricingKeysFor(id)) {
        if (!map.has(key)) map.set(key, pricing)
      }
    }
  }
  return map
}

/**
 * 面向 agent 的保守上下文上限。写成配置而不是常量，是因为这类建议值会随模型和
 * 用法变化；留空即直接采用网关下发的真实上限。
 * 形如 CONSOLE_CONTEXT_CAPS="gpt-5.6-sol=372000,gpt-5.6-terra=372000"
 */
const contextCaps: Map<string, number> = (() => {
  const raw = process.env.CONSOLE_CONTEXT_CAPS ?? 'gpt-5.6-sol=372000,gpt-5.6-terra=372000'
  const caps = new Map<string, number>()
  for (const item of raw.split(',')) {
    const [id, value] = item.split('=')
    const cap = Number(value)
    if (id?.trim() && Number.isFinite(cap) && cap > 0) caps.set(normalizeModelForPricing(id.trim()), cap)
  }
  return caps
})()

/** Merge CPA's provider model definitions, keeping the largest declared limits and all sources. */
export function buildModelCatalog(definitions: Array<{ provider: string; models: ModelDefinition[] }>, allowedIds?: Iterable<string>): CatalogModel[] {
  const allowed = allowedIds ? new Set([...allowedIds].map((id) => normalizeModelForPricing(String(id)))) : null
  const merged = new Map<string, CatalogModel>()
  for (const source of definitions) {
    for (const definition of source.models) {
      const id = normalizeDefinitionId(definition)
      const canonical = normalizeModelForPricing(id)
      if (!canonical || (allowed && !allowed.has(canonical) && !allowed.has(id))) continue
      const current = merged.get(canonical)
      const declaredContext = numberOrNull(definition.context_length, definition.max_context_length, definition.inputTokenLimit)
      const context = contextCaps.get(canonical) ?? declaredContext
      const output = numberOrNull(definition.max_completion_tokens, definition.outputTokenLimit)
      const thinking = definition.thinking && typeof definition.thinking === 'object' ? {
        ...(definition.thinking.levels?.length ? { levels: [...new Set(definition.thinking.levels)] } : {}),
        ...(numberOrNull(definition.thinking.min) !== null ? { min: numberOrNull(definition.thinking.min)! } : {}),
        ...(numberOrNull(definition.thinking.max) !== null ? { max: numberOrNull(definition.thinking.max)! } : {}),
        ...(typeof definition.thinking.zero_allowed === 'boolean' ? { zero_allowed: definition.thinking.zero_allowed } : {}),
        ...(typeof definition.thinking.dynamic_allowed === 'boolean' ? { dynamic_allowed: definition.thinking.dynamic_allowed } : {}),
      } : null
      if (!current) {
        merged.set(canonical, {
          id: canonical,
          providers: [...new Set([source.provider, ...(definition.providers || []), ...(definition.provider ? [definition.provider] : [])])].filter(Boolean),
          context_length: context,
          total_context_length: numberOrNull(definition.total_context_length),
          max_completion_tokens: output,
          thinking,
          // 与入账同一口径：价格表（静态核定价 + 已并入的网关价）优先，网关价只兜底本轮刚出现的模型
          pricing: getModelPricing(canonical) ?? pricingFromGateway(definition),
          priceHistory: getPriceHistory(canonical),
          ...pricingSourceFields(canonical, true),
        })
        continue
      }
      current.providers = [...new Set([...current.providers, source.provider, ...(definition.providers || []), ...(definition.provider ? [definition.provider] : [])])].filter(Boolean)
      current.context_length = Math.max(current.context_length || 0, context || 0) || null
      current.total_context_length = Math.max(current.total_context_length || 0, numberOrNull(definition.total_context_length) || 0) || null
      current.pricing = current.pricing ?? getModelPricing(canonical) ?? pricingFromGateway(definition)
      Object.assign(current, pricingSourceFields(canonical, true))
      current.max_completion_tokens = Math.max(current.max_completion_tokens || 0, output || 0) || null
      if (thinking) {
        current.thinking = {
          ...(current.thinking || {}),
          ...(thinking.levels ? { levels: [...new Set([...(current.thinking?.levels || []), ...thinking.levels])] } : {}),
          ...(thinking.min !== undefined ? { min: Math.min(current.thinking?.min ?? thinking.min, thinking.min) } : {}),
          ...(thinking.max !== undefined ? { max: Math.max(current.thinking?.max ?? thinking.max, thinking.max) } : {}),
          ...(thinking.zero_allowed !== undefined ? { zero_allowed: current.thinking?.zero_allowed || thinking.zero_allowed } : {}),
          ...(thinking.dynamic_allowed !== undefined ? { dynamic_allowed: current.thinking?.dynamic_allowed || thinking.dynamic_allowed } : {}),
        }
      }
    }
  }
  for (const model of merged.values()) {
    const cap = contextCaps.get(model.id)
    if (cap) model.context_length = cap
  }
  return [...merged.values()].sort((a, b) => a.id.localeCompare(b.id))
}

async function fetchJson<T>(url: string, headers: Record<string, string>, timeoutMs: number): Promise<T> {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) })
  if (!response.ok) throw new Error(`CPA ${response.status}: ${url}`)
  return response.json() as Promise<T>
}

async function loadDefinitions(failures?: string[]): Promise<Array<{ provider: string; models: ModelDefinition[] }>> {
  if (config.gatewayEngine === 'magpie' && config.magpieControlPlane === 'local') {
    const { readMagpieChannels } = await import('./magpieControl.js')
    const { readSharedCatalog } = await import('./modelSync.js')
    const shared = readSharedCatalog()
    const sharedById = new Map((shared?.models || []).map(m => [m.id.toLowerCase(), m]))
    return readMagpieChannels().filter(channel => !channel.disabled).map(channel => ({
      provider: channel.name,
      models: channel.models.map(m => {
        const s = sharedById.get(m.name.toLowerCase()) || (m.alias ? sharedById.get(m.alias.toLowerCase()) : undefined)
        return {
          id: m.name,
          alias: m.alias,
          context_length: s?.contextWindow,
          max_completion_tokens: s?.maxTokens,
          thinking: s?.efforts ? { levels: s.efforts } : undefined,
          cost: s?.cost,
        }
      }),
    }))
  }
  const headers = { Authorization: `Bearer ${config.cpaManagementKey}`, 'Content-Type': 'application/json' }
  const result: Array<{ provider: string; models: ModelDefinition[] }> = await Promise.all(definitionChannels.map(async (provider) => {
    try {
      const response = await fetchJson<{ models?: ModelDefinition[] }>(`${config.cpaBaseUrl}/v0/management/model-definitions/${provider}`, headers, config.cpaRequestTimeoutMs)
      return { provider, models: response.models || [] }
    } catch {
      failures?.push(provider)
      return { provider, models: [] }
    }
  }))
  try {
    const response = await fetchJson<{ 'openai-compatibility'?: Array<{ name?: string; models?: ModelDefinition[] }> }>(`${config.cpaBaseUrl}/v0/management/openai-compatibility`, headers, config.cpaRequestTimeoutMs)
    for (const provider of response['openai-compatibility'] || []) {
      if (provider.name) result.push({ provider: provider.name, models: provider.models || [] })
    }
  } catch {
    // The catalog remains useful when an older CPA lacks the compatibility endpoint.
    failures?.push('openai-compatibility')
  }
  return result
}

const keyValidationCache = new Map<string, { expiresAt: number; ids: string[] }>()

/** Validate a public gateway key and return exactly the models visible to that key. */
export async function visibleModelIds(apiKey: string): Promise<string[] | null> {
  if (config.gatewayEngine === 'magpie') {
    const { db } = await import('./db.js')
    const engine = await import('./magpieEngine.js')
    const runtime = await import('./magpieRuntime.js')
    const key = db.prepare('SELECT * FROM api_keys WHERE key_value=?').get(apiKey) as import('./magpieEngine.js').AdmissionKey | undefined
    return key?.enabled ? [...new Set(engine.allowedMagpieRoutes(await runtime.magpieRoutes(), key).map(route => route.alias))] : null
  }
  const hash = crypto.createHash('sha256').update(apiKey).digest('hex')
  const cached = keyValidationCache.get(hash)
  if (cached && cached.expiresAt > Date.now()) return cached.ids
  try {
    const response = await fetchJson<{ data?: Array<{ id?: string }> }>(`${config.cpaBaseUrl}/v1/models`, { Authorization: `Bearer ${apiKey}` }, config.cpaRequestTimeoutMs)
    const ids = [...new Set((response.data || []).map((item) => String(item.id || '').trim()).filter(Boolean))]
    if (!ids.length) return null
    keyValidationCache.set(hash, { expiresAt: Date.now() + 60_000, ids })
    return ids
  } catch {
    return null
  }
}

/** task-78：把一个模型的「双源价格 + 是否在网关可用 + 是否完全无价」拼成展示字段。 */
function pricingSourceFields(id: string, availableOnGateway: boolean): Pick<CatalogModel, 'pricingSources' | 'availableOnGateway' | 'unpriced'> {
  const { sources } = getPricingSources(id)
  const hasSourcePrice = Object.keys(sources).length > 0
  const local = getModelPricing(id)
  return {
    ...(hasSourcePrice ? { pricingSources: sources } : {}),
    availableOnGateway,
    unpriced: !local && !hasSourcePrice,
  }
}

/**
 * task-78 的「并集」：把两个价格来源里出现、但网关目录里没有的模型补进总览。
 *
 * 为什么只补进"全量视图"：`allowedIds` 是**按 Key 的可见范围**，把范围外的模型补进来等于越权展示，
 * 所以只有不限范围的调用（控制台自己的总览）才做并集。
 */
export function mergePricingSourceModels(catalog: CatalogModel[]): CatalogModel[] {
  const seen = new Set(catalog.map((model) => model.id))
  const extra: CatalogModel[] = []
  for (const id of pricingSourceModelIds()) {
    if (seen.has(id)) continue
    extra.push({
      id,
      providers: [],
      context_length: null,
      total_context_length: null,
      max_completion_tokens: null,
      thinking: null,
      pricing: getModelPricing(id),
      priceHistory: getPriceHistory(id),
      ...pricingSourceFields(id, false),
    })
    seen.add(id)
  }
  if (!extra.length) return catalog
  return [...catalog, ...extra].sort((left, right) => left.id.localeCompare(right.id))
}

/**
 * task-78：把共享产物里的双源价格懒加载进来（TTL 10 分钟）。
 * 失败/缺失一律**不影响目录本身**，只把降级原因记在 `pricingSourceStatus()` 里由展示层如实标注。
 */
let sharedPricingLoadedAt = 0

export async function refreshSharedPricingIfStale(ttlMs = 10 * 60 * 1000): Promise<number> {
  if (Date.now() - sharedPricingLoadedAt >= ttlMs) {
    try {
      const { loadSharedPricing } = await import('./modelSync.js')
      loadSharedPricing()
    } catch { /* 读不到就保持上一次状态（degraded 会说明） */ }
    sharedPricingLoadedAt = Date.now()
  }
  return pricingSourceStatus().models
}

export async function loadModelCatalog(allowedIds?: Iterable<string>): Promise<CatalogModel[]> {
  await refreshSharedPricingIfStale()
  const catalog = buildModelCatalog(await loadDefinitions(), allowedIds)
  if (!allowedIds) return mergePricingSourceModels(catalog)
  const seen = new Set(catalog.map((model) => model.id))
  for (const rawId of allowedIds) {
    const id = normalizeModelForPricing(String(rawId))
    if (!id || seen.has(id)) continue
    catalog.push({ id, providers: [], context_length: null, total_context_length: null, max_completion_tokens: null, thinking: null, pricing: getModelPricing(id), priceHistory: getPriceHistory(id) })
    seen.add(id)
  }
  return catalog.sort((a, b) => a.id.localeCompare(b.id))
}

export function clearModelCatalogValidationCache() {
  keyValidationCache.clear()
}

/**
 * 网关价不能只活在内存里：静态表没有的模型（gemini-3.8-flash、gpt-6-astra、
 * deepseek-flash 这类）价格全部来自网关，而 `applyGatewayPricing` 是内存合并。
 * 只要 console 重启、或网关一时报不出 cost（例如换成没带 models.dev 富化的
 * 官方版二进制），这些模型就会在入库时静默记成 cost_usd = NULL，而且入库后
 * 永不重算——2026-09-09 夜间丢掉的正是这几个模型的整段计费。
 * 因此把最近一次成功的网关价落盘，进程启动先读回来，网络再抖也不会掉价。
 */
const gatewayPricingFile = path.join(config.dataDir, 'gateway-pricing.json')

/** 读磁盘上的快照。首次启动没有文件返回空对象，交给首次网关刷新写出来。 */
function readGatewayPriceSnapshot(): Record<string, PriceEntry> {
  try {
    const raw = JSON.parse(fs.readFileSync(gatewayPricingFile, 'utf8')) as Record<string, PriceEntry>
    return raw && typeof raw === 'object' ? raw : {}
  } catch {
    return {}
  }
}

/** 只保留计价需要的字段，顺便丢掉 ModelPricing 上的 unit。 */
function priceEntryFields(entry: ModelPricing): PriceEntry {
  return {
    from: entry.from,
    ...(entry.until ? { until: entry.until } : {}),
    input: entry.input,
    output: entry.output,
    cacheRead: entry.cacheRead,
    ...(entry.cacheWrite !== undefined ? { cacheWrite: entry.cacheWrite } : {}),
    ...(entry.tiers?.length ? { tiers: entry.tiers } : {}),
    ...(entry.note ? { note: entry.note } : {}),
  }
}

/**
 * 把本轮网关价并进磁盘快照。
 *
 * 必须合并，不能整份覆盖：`available-models` 与各渠道的 model-definitions 是分开
 * 拉的几次请求，任何一次超时、或 models.dev 富化还没跑完，`gatewayPricingMap()`
 * 就会少一部分模型。整份覆盖会把上一轮已经拿到的价抹掉，下次重启这些模型就真的
 * 没价了——正是这次要根治的那类丢失。合并只增不减；要删模型得人工改快照。
 */
export function mergeGatewayPriceSnapshot(
  existing: Record<string, PriceEntry>,
  incoming: Map<string, ModelPricing>,
): Record<string, PriceEntry> {
  const merged: Record<string, PriceEntry> = { ...existing }
  for (const [id, entry] of incoming) {
    if (!id || !Number.isFinite(entry.input) || !Number.isFinite(entry.output)) continue
    merged[id] = priceEntryFields(entry)
  }
  return merged
}

/** 启动时把上次落盘的网关价读回来。读不到就返回 0，交给首次刷新补。 */
export function restoreGatewayPricing(): number {
  const map = new Map<string, PriceEntry>()
  for (const [id, entry] of Object.entries(readGatewayPriceSnapshot())) {
    if (entry && Number.isFinite(entry.input) && Number.isFinite(entry.output)) map.set(id, entry)
  }
  return map.size ? applyGatewayPricing(map) : 0
}

/** 落盘失败不影响服务：内存里的价仍然可用，下次刷新再试。 */
function persistGatewayPricing(map: Map<string, ModelPricing>): void {
  try {
    fs.mkdirSync(config.dataDir, { recursive: true })
    const payload = mergeGatewayPriceSnapshot(readGatewayPriceSnapshot(), map)
    const tmp = `${gatewayPricingFile}.tmp`
    fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`)
    fs.renameSync(tmp, gatewayPricingFile)
  } catch {
    // 冷启动没有网关价可用时才需要落盘，写不进去不阻塞任何请求
  }
}

/**
 * 定期把网关价格补进本地价格表，让用量入库时也能给这些模型结算成本。
 * 拉取失败不抛出：价格表保持原样（含落盘回读的内容），服务照常。
 */
export async function refreshGatewayPricing(): Promise<number> {
  return (await refreshGatewayPricingDetailed()).added
}

/**
 * 同步中心用的同一次刷新，带上可观测字段。本机控制面只读共享目录（0 次上游请求）；
 * CPA 控制面是每个原生渠道一次 model-definitions + openai-compatibility + available-models。
 */
export async function refreshGatewayPricingDetailed(): Promise<{
  ok: boolean; added: number; priced: number; requests: number; error: string | null
  /** 本轮失败的价格来源（这些来源的旧价格仍保留在快照里）；非空时同步中心报 partial。 */
  failedSources: string[]
}> {
  const local = config.gatewayEngine === 'magpie' && config.magpieControlPlane === 'local'
  const requests = local ? 0 : definitionChannels.length + 2
  const failedSources: string[] = []
  try {
    const map = await gatewayPricingMap(failedSources)
    persistGatewayPricing(map)
    const added = applyGatewayPricing(map as unknown as Map<string, PriceEntry>)
    return { ok: map.size > 0, added, priced: map.size, requests, error: map.size > 0 ? null : '网关未返回任何价格', failedSources }
  } catch (error) {
    return { ok: false, added: 0, priced: 0, requests, error: error instanceof Error ? error.message : '刷新失败', failedSources }
  }
}

// 进程一起来就先把上次落盘的网关价装回去，避免首次刷新完成前的用量被记成未定价。
restoreGatewayPricing()
