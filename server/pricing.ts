import table from './pricing.data.json' with { type: 'json' }

/**
 * 分层价：完整提示（新输入 + 缓存读 + 缓存写）超过 `above` 后，整单按该档计价。
 * 这是 OpenAI（272k）、Google（200k）、MiniMax（512k）公开价卡的规则，不是按超出部分累进。
 */
export type PriceTier = { above: number; input: number; output: number; cacheRead: number; cacheWrite?: number }

/** 一段生效期内的单价，美元 / 百万 token。`until` 缺省表示至今有效。 */
export type PriceEntry = {
  from: string
  until?: string
  input: number
  output: number
  cacheRead: number
  cacheWrite?: number
  tiers?: PriceTier[]
  note?: string
}

/**
 * 某一时刻生效的单价。`unit` 沿用历史字段名，实际单位是美元 / 百万 token。
 * `cacheWrite` 可选：价源缺失时由 `cacheWritePrice()` 按官方 1.25x 输入价推导，而不是当成免费。
 */
export type ModelPricing = PriceEntry & { unit: 'token' }

export type PriceAt = Date | number | string | undefined

const DAY = /^\d{4}-\d{2}-\d{2}$/

/** 兼容旧的单对象条目：没有 from 的视为自 1970 起一直有效。 */
function toEntries(value: unknown): PriceEntry[] {
  const list = Array.isArray(value) ? value : value && typeof value === 'object' ? [value] : []
  return list
    .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object')
    .map((entry) => {
      const input = Number(entry.input)
      const cacheRead = Number(entry.cacheRead)
      return {
        ...(entry as unknown as PriceEntry),
        from: typeof entry.from === 'string' && DAY.test(entry.from) ? entry.from : '1970-01-01',
        input,
        output: Number(entry.output),
        // 没有缓存折扣信息时按全价计，宁可高估也不把缓存段算成免费
        cacheRead: Number.isFinite(cacheRead) ? cacheRead : input,
      }
    })
    .filter((entry) => Number.isFinite(entry.input) && Number.isFinite(entry.output))
    .sort((a, b) => a.from.localeCompare(b.from))
}

const HISTORY = new Map<string, PriceEntry[]>()
for (const [id, value] of Object.entries((table as { pricing: Record<string, unknown> }).pricing)) {
  const entries = toEntries(value)
  if (entries.length) HISTORY.set(id, entries)
}
const LOWER = new Map<string, string>([...HISTORY.keys()].map((id) => [id.toLowerCase(), id]))

/**
 * 与 `modelIdentity.canonicalModelSql` 同语义：只剥掉第一个 `/` 之前的渠道前缀
 * （`qiji/claude-opus-5` → `claude-opus-5`，`a/b/c` → `b/c`），再去掉 Claude Code 的 `[1m]` 上下文后缀。
 * 两条口径必须一致，否则同一模型会在 SQL 聚合与 JS 计价里被拆成两条。
 */
export function normalizeModelForPricing(model: string): string {
  let name = String(model || '').trim()
  const slash = name.indexOf('/')
  if (slash !== -1) name = name.slice(slash + 1)
  if (name.endsWith('[1m]')) name = name.slice(0, -4)
  return name
}

/**
 * 用网关下发的单价补齐静态表缺失的模型。
 *
 * 只补空缺，不覆盖已有条目：静态表带 from/until 分段，历史用量要按请求当时的
 * 价格结算（见 sync.ts 的入库结算说明），拿当前单价整段覆盖会把促销期前后的
 * 账单混在一起。而缺失的模型（例如静态表未收录的 gemini-3.8-flash）此前一律
 * 记成本 NULL，前端显示「尚无公开定价」——那才是要修的。
 *
 * 返回本次新补的模型数。
 */
export function applyGatewayPricing(pricing: Map<string, PriceEntry>): number {
  let added = 0
  for (const [rawId, entry] of pricing) {
    const id = normalizeModelForPricing(rawId)
    if (!id || HISTORY.has(id)) continue
    if (!Number.isFinite(entry.input) || !Number.isFinite(entry.output)) continue
    HISTORY.set(id, [{ ...entry, from: entry.from || '1970-01-01' }])
    LOWER.set(id.toLowerCase(), id)
    added += 1
  }
  // 新补进来的模型可能是更好的近似目标，旧的近似结果作废
  if (added) APPROXIMATE.clear()
  return added
}

/** 精确查找：大小写、点/横线版本号变体、多级前缀都尝试一遍。 */
function exactId(name: string): string | null {
  const candidates = [name]
  const last = name.lastIndexOf('/')
  if (last !== -1) candidates.push(name.slice(last + 1))
  for (const candidate of [...candidates]) candidates.push(candidate.replace(/(\d)\.(\d)/g, '$1-$2'))
  for (const candidate of candidates) {
    if (HISTORY.has(candidate)) return candidate
    const lowered = LOWER.get(candidate.toLowerCase())
    if (lowered) return lowered
  }
  return null
}

const VERSION = /\d+(?:\.\d+)*/g

/**
 * 除版本号外完全相同的已定价模型里，取版本最接近的一个：`qwen3.8-flash` → `qwen3.7-flash`、
 * `glm-5.3` → `glm-5.2`。骨架必须一致，所以 flash 不会借 max 的价、预览版不会借正式版的价。
 */
function nearestVersion(base: string): string | null {
  const lower = base.toLowerCase()
  const skeleton = lower.replace(VERSION, '#')
  if (!/^[a-z]/.test(lower) || skeleton === lower) return null
  const want = (lower.match(VERSION) || []).map(Number)
  let best: string | null = null
  let bestDistance = Number.POSITIVE_INFINITY
  for (const id of HISTORY.keys()) {
    const candidate = id.toLowerCase()
    if (candidate.replace(VERSION, '#') !== skeleton) continue
    const got = (candidate.match(VERSION) || []).map(Number)
    const distance = got.reduce((sum, value, index) => sum + Math.abs(value - want[index]), 0)
    if (distance < bestDistance || (distance === bestDistance && best !== null && id < best)) {
      best = id
      bestDistance = distance
    }
  }
  return best
}

/**
 * 精确查不到时的近似匹配：宁可按同款模型估算，也不让整条用量记成「尚无定价」。
 * 1. 去掉末尾的档位括号：`deepseek-v4.1-flash(high)` → `deepseek-v4.1-flash`；
 * 2. 逐段剥掉渠道前缀再精确查：`cline-deepseek-v4.1-flash` → `deepseek-v4.1-flash`；
 * 3. 仍查不到，按「除版本号外相同」取版本最接近的模型（见 `nearestVersion`）。
 * 结果按模型名缓存；网关补进新模型时清空。
 */
const APPROXIMATE = new Map<string, string | null>()
function approximateId(name: string): string | null {
  const cached = APPROXIMATE.get(name)
  if (cached !== undefined) return cached
  const bases: string[] = []
  let rest = name.replace(/\s*\([^)]*\)\s*$/, '')
  while (rest) {
    bases.push(rest)
    const dash = rest.indexOf('-')
    rest = dash === -1 ? '' : rest.slice(dash + 1)
  }
  let resolved: string | null = null
  for (const base of bases) {
    resolved = exactId(base)
    if (resolved) break
  }
  for (const base of bases) {
    if (resolved) break
    resolved = nearestVersion(base)
  }
  APPROXIMATE.set(name, resolved)
  return resolved
}

function resolveId(model: string): string | null {
  const name = normalizeModelForPricing(model)
  if (!name) return null
  return exactId(name) ?? approximateId(name)
}

function dayOf(at: PriceAt): string {
  if (at === undefined || at === null) return new Date().toISOString().slice(0, 10)
  if (typeof at === 'string' && DAY.test(at)) return at
  const ms = at instanceof Date ? at.getTime() : typeof at === 'number' ? at : Date.parse(at)
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10)
}

/** 取生效日不晚于当天的最后一条；早于首条生效日时用首条（历史用量按最早已知价计）。 */
function entryAt(entries: PriceEntry[], day: string): PriceEntry {
  let chosen = entries[0]
  for (const entry of entries) {
    if (entry.from <= day) chosen = entry
    else break
  }
  return chosen
}

export function getPriceHistory(model: string): PriceEntry[] {
  const id = resolveId(model)
  return id ? HISTORY.get(id)!.map((entry) => ({ ...entry })) : []
}

/** `at` 缺省为当前时刻；传入用量时间戳可按当时生效的价格计价。 */
export function getModelPricing(model: string, at?: PriceAt): ModelPricing | null {
  const id = resolveId(model)
  if (!id) return null
  return { ...entryAt(HISTORY.get(id)!, dayOf(at)), unit: 'token' }
}

export function pricedModelIds(): string[] {
  return [...HISTORY.keys()].sort()
}

export type PriceRates = { input: number; output: number; cacheRead: number; cacheWrite?: number }

/** 按完整提示长度选档；没有分档或没给提示长度时用基础价。 */
export function ratesFor(pricing: ModelPricing, promptTokens?: number): PriceRates {
  if (!pricing.tiers?.length || promptTokens === undefined || !Number.isFinite(promptTokens)) return pricing
  let chosen: PriceRates = pricing
  let best = -1
  for (const tier of pricing.tiers) {
    if (promptTokens > tier.above && tier.above > best) {
      best = tier.above
      chosen = tier
    }
  }
  return chosen
}

/** Anthropic 官方缓存写入倍率（5 分钟 TTL）。 */
export const CACHE_WRITE_MULTIPLIER = 1.25

export function cacheWritePrice(pricing: Pick<PriceRates, 'input' | 'cacheWrite'>): number {
  return pricing.cacheWrite ?? pricing.input * CACHE_WRITE_MULTIPLIER
}

export type CostOptions = {
  /** 用量发生时刻，用来选生效价；缺省按当前价 */
  at?: PriceAt
  /** 完整提示长度（新输入 + 缓存读 + 缓存写），用来选上下文分档；缺省不分档 */
  promptTokens?: number
}

/**
 * 计价用的输入 token 拆成「新输入」、「缓存命中」和「缓存写入」三段。
 * 写入段最贵（1.25x 输入），漏算它会系统性低估账单。
 */
export function estimateCost(
  model: string,
  newInputTokens: number,
  outputTokens: number,
  cacheTokens: number,
  cacheWriteTokens = 0,
  options: CostOptions = {},
): number | null {
  const pricing = getModelPricing(model, options.at)
  if (!pricing) return null
  const rates = ratesFor(pricing, options.promptTokens)
  // CPA Usage Queue 会把上游返回的图片 token 落进 input/output/cached 字段；
  // 该映射依赖网关实际记录的字段口径，不能自行把图像调用伪造成按张计价。
  return (
    (newInputTokens * rates.input +
      outputTokens * rates.output +
      cacheTokens * rates.cacheRead +
      cacheWriteTokens * cacheWritePrice(rates)) / 1_000_000
  )
}

export type RequestTokens = {
  newInputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens?: number
  /** 缺省按三段之和推导 */
  promptTokens?: number
  at?: PriceAt
}

/** 单条请求的成本：按请求时刻的生效价，并按完整提示长度选档。 */
export function priceRequest(model: string, tokens: RequestTokens): number | null {
  const cacheWriteTokens = tokens.cacheWriteTokens || 0
  const promptTokens = tokens.promptTokens ?? tokens.newInputTokens + tokens.cacheReadTokens + cacheWriteTokens
  return estimateCost(model, tokens.newInputTokens, tokens.outputTokens, tokens.cacheReadTokens, cacheWriteTokens, { at: tokens.at, promptTokens })
}

/* ────────────────────────── task-78：双源外部价格（models.dev / openrouter） ──────────────────────────
 *
 * 数据来自**共享产物** `~/.agents/crosery/catalog.json` 的 `pricing` 段（由唯一的同步实现
 * `~/.agents/crosery/sync.mjs` 联网抓取并原子写入）。本文件只做**落地与查询**，**不联网**——
 * 跨 harness 的"一个实现 + 一个产物 + 每 host 一个薄 adapter"契约见 `~/.agents/crosery/README.md`。
 *
 * 两条硬规则：
 * 1. 两个来源**各自**保存（能看出是否一致、差多少），并带上该来源的抓取时间戳；
 * 2. **缺失就是缺失**：取不到写 `undefined`，绝不用 0 冒充"免费"（展示层据此写"未收录"）。
 */
export type PriceSourceId = 'models.dev' | 'openrouter'

/** 某个来源对某个模型的报价；字段缺省表示该来源**没给这一项**（不是 0）。 */
export type SourcePrice = {
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
  unit?: string
  /** 来源里的原始 id（例如 openrouter 的 `vendor/model`） */
  sourceId?: string
  /** 该来源本次抓取时间（毫秒）；来自产物 `pricing.sources[].fetchedAt` */
  fetchedAt?: number
}

export type PricingSourceStatus = { ok?: boolean; fetchedAt?: number; entries?: number; error?: string }

/** 产物 `pricing.rows` 的一行（一个模型 × 一个来源）。 */
export type SharedPricingRow = {
  id: string
  source: PriceSourceId
  sourceId?: string
  name?: string
  contextWindow?: number
  maxTokens?: number
  prices?: Partial<Record<PriceSourceId, SourcePrice>>
}

export type SharedPricingSnapshot = {
  rows?: SharedPricingRow[]
  sources?: Partial<Record<PriceSourceId, PricingSourceStatus>>
  degraded?: string[]
}

const SOURCE_PRICES = new Map<string, Partial<Record<PriceSourceId, SourcePrice>>>()
let SOURCE_STATUS: Partial<Record<PriceSourceId, PricingSourceStatus>> = {}
let SOURCE_LOADED_AT: number | null = null
let SOURCE_DEGRADED: string[] = ['shared-pricing-not-loaded']

/**
 * 灌入一份共享产物快照（幂等：同一份快照重复调用结果相同）。
 * `degraded` 明确列出降级原因（产物缺失 / 段缺失 / 某来源 ok=false / 空），供展示层如实标注。
 */
export function applySharedPricing(snapshot: SharedPricingSnapshot | null | undefined, now = Date.now()): { models: number; rows: number; degraded: string[] } {
  const degraded: string[] = []
  const rows = Array.isArray(snapshot?.rows) ? snapshot!.rows! : []
  if (!snapshot || !Array.isArray(snapshot.rows)) degraded.push('shared-pricing-missing')
  SOURCE_PRICES.clear()
  let applied = 0
  for (const row of rows) {
    const id = normalizeModelForPricing(String(row?.id || ''))
    const source = row?.source
    const price = row?.prices?.[source]
    if (!id || (source !== 'models.dev' && source !== 'openrouter') || !price || typeof price !== 'object') continue
    const bucket = SOURCE_PRICES.get(id) || {}
    const fetchedAt = snapshot?.sources?.[source]?.fetchedAt
    bucket[source] = { ...price, ...(row.sourceId ? { sourceId: row.sourceId } : {}), ...(fetchedAt ? { fetchedAt } : {}) }
    SOURCE_PRICES.set(id, bucket)
    applied += 1
  }
  SOURCE_STATUS = snapshot?.sources && typeof snapshot.sources === 'object' ? snapshot.sources : {}
  for (const [source, status] of Object.entries(SOURCE_STATUS)) {
    if (status && status.ok === false) degraded.push(`source-unavailable:${source}`)
  }
  if (!rows.length) degraded.push('shared-pricing-empty')
  SOURCE_LOADED_AT = now
  SOURCE_DEGRADED = degraded
  return { models: SOURCE_PRICES.size, rows: applied, degraded }
}

/** 某模型在两个来源各自的报价（顺序稳定，缺失的来源不出现）。 */
export function getPricingSources(model: string): { sources: Partial<Record<PriceSourceId, SourcePrice>>; degraded: string[] } {
  const id = normalizeModelForPricing(String(model || ''))
  return { sources: (id && SOURCE_PRICES.get(id)) || {}, degraded: [...SOURCE_DEGRADED] }
}

/** 供展示层使用的整体状态：每个来源的 ok / 抓取时间 / 条目数 + 降级原因。 */
export function pricingSourceStatus(): {
  sources: Partial<Record<PriceSourceId, PricingSourceStatus>>
  loadedAt: number | null
  degraded: string[]
  models: number
} {
  return { sources: { ...SOURCE_STATUS }, loadedAt: SOURCE_LOADED_AT, degraded: [...SOURCE_DEGRADED], models: SOURCE_PRICES.size }
}

/** 两个来源里出现过的全部模型 id（已归一化）——"并集"用。 */
export function pricingSourceModelIds(): string[] {
  return [...SOURCE_PRICES.keys()].sort()
}

/** 仅供测试：清空来源价格表。 */
export function resetSharedPricing(): void {
  SOURCE_PRICES.clear()
  SOURCE_STATUS = {}
  SOURCE_LOADED_AT = null
  SOURCE_DEGRADED = ['shared-pricing-not-loaded']
}
