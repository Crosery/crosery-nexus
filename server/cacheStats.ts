import { cacheWritePrice, getModelPricing, normalizeModelForPricing, ratesFor, type PriceAt } from './pricing.js'

/**
 * 上游对 `cached_tokens` 的口径分两派，直接决定命中率和计费怎么算：
 *
 * - Anthropic：`input_tokens` 与 `cache_read_input_tokens` 是并列的两段，
 *   合起来才是完整提示。实测 7 天内 705/777 条 claude 记录满足 cached > input。
 * - OpenAI：`cached_tokens` 嵌套在 `prompt_tokens` 内部，是它的子集。
 *   实测 13613/13613 条 gpt-5.6-sol 记录满足 total = input + output（cached 不额外计入）。
 *
 * 用同一个公式套两家会同时产生三个错误：
 *   1. GPT 命中率被压低约一半（94.5% 被算成 48.6%）
 *   2. GPT 缓存段被重复计费（input 已含 cached，又按全价加了一次）
 *   3. Claude 新输入被 MAX(input-cached,0) 夹成 0（cached>input 时恒为 0）
 */
export type CacheDialect = 'anthropic' | 'openai'

export type CacheDialectContext = {
  /** CPA 记录里的实际 provider；`claude` 才代表原生 Anthropic 计费口径。 */
  provider?: string
  /** 兼容旧调用方：没有 provider 时仍可用 model_group 辅助判断。 */
  modelGroup?: string
}

/**
 * 判断缓存 token 口径。
 *
 * 不能只看模型名：线上同时存在原生 `provider=claude` 的
 * `claude-opus-5`，以及 DSH/兼容渠道 `provider=qijichuangtan` 的
 * `qiji/claude-opus-5`。后者的 cached_tokens 是 input_tokens 的子集，
 * 前者的 input/cache_read/cache_creation 是三段并列。
 *
 * provider 是 CPA 的实际执行来源，优先级高于 model 和 model_group；
 * 没有 provider 的纯函数旧调用才回退到模型名前缀。
 */
export function cacheDialectFor(model: string, context: CacheDialectContext = {}): CacheDialect {
  const provider = String(context.provider || '').trim().toLowerCase()
  if (provider) {
    // 只有原生 Anthropic 协议端点才有独立 cache_creation 段；
    // `openai-compatible-*` 即使模型名含 claude，也仍按兼容口径处理。
    return new Set(['claude', 'claude-api-key', 'anthropic', 'anthropic-api-key']).has(provider) ? 'anthropic' : 'openai'
  }
  const group = String(context.modelGroup || '').toLowerCase()
  if (group) return group === 'claude' ? 'anthropic' : 'openai'
  const bare = normalizeModelForPricing(model).toLowerCase()
  return bare.startsWith('claude') ? 'anthropic' : 'openai'
}

export type RawTokens = CacheDialectContext & {
  model: string
  /** 数据库原始 input_tokens，语义随 dialect 变化 */
  inputTokens: number
  outputTokens: number
  /** 数据库原始 cached_tokens */
  cachedTokens: number
  /**
   * Anthropic 的缓存写入段。CPA 一直在 `tokens.cache_creation_tokens` 里下发，
   * 但早期落库漏接，于是三段全部失真：
   *   1. 命中率恒等于 100%——分母只有 input(恒为 2) + cacheRead，写入段从未进入分母
   *   2. 成本系统性低估——写入按 1.25x 输入价计费，是最贵的一段，却完全没算
   *   3. 「新输入」列恒显示 2，用户无法看出真正读进去多少内容
   * 实测原生 claude 近 24h 有超过千万 write token 被丢弃；兼容渠道同名 claude 模型则不应反推写入段。
   */
  cacheWriteTokens?: number
  totalTokens?: number
}

/** 归一化后的三段 token，两家口径统一到「新输入 / 缓存读 / 输出」。 */
export type NormalizedTokens = {
  dialect: CacheDialect
  /** 真正需要全价计算的新输入 */
  freshInputTokens: number
  /** 命中缓存、按 cacheRead 单价计费的部分 */
  cacheReadTokens: number
  /** 写入缓存、按 1.25x 输入价计费的部分（仅 Anthropic 有） */
  cacheWriteTokens: number
  outputTokens: number
  /** 完整提示长度 = fresh + cacheRead + cacheWrite，用于上下文分档 */
  promptTokens: number
}

export function normalizeTokens(raw: RawTokens): NormalizedTokens {
  const dialect = cacheDialectFor(raw.model, raw)
  const cacheReadTokens = Math.max(raw.cachedTokens, 0)
  const outputTokens = Math.max(raw.outputTokens, 0)
  const input = Math.max(raw.inputTokens, 0)
  // OpenAI 没有独立的缓存写入计费段，任何值都不应参与该口径的计算。
  const cacheWriteTokens = dialect === 'anthropic' ? Math.max(raw.cacheWriteTokens || 0, 0) : 0

  // openai: input 已含 cached，扣掉才是新输入
  // anthropic: input / cacheRead / cacheWrite 三段并列，input 本身就是新输入
  const freshInputTokens = dialect === 'openai' ? Math.max(input - cacheReadTokens, 0) : input

  return {
    dialect,
    freshInputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    outputTokens,
    promptTokens: freshInputTokens + cacheReadTokens + cacheWriteTokens,
  }
}

/**
 * 命中率 = 缓存读 / 完整提示。
 *
 * 分母必须含缓存写入段，否则「首次写入缓存」这类零命中的请求会被算成 100%——
 * 这正是面板上 claude 系列恒显示 100.0% 的原因：写入段被排除在分母之外，
 * 而 Anthropic 的 input_tokens 恒为个位数，分子分母几乎相等。
 */
export function hitRate(tokens: Pick<NormalizedTokens, 'freshInputTokens' | 'cacheReadTokens' | 'cacheWriteTokens'>): number | null {
  const prompt = tokens.freshInputTokens + tokens.cacheReadTokens + (tokens.cacheWriteTokens || 0)
  return prompt > 0 ? tokens.cacheReadTokens / prompt : null
}

/**
 * 实测的缓存写入上限。同一前缀、同一模型 ID，仅在尾部追加 padding：
 *   663,063 tok → 第二次 cached=663,052（正常）
 *   737,583 tok → 第二次 cached=1,902（塌回仅 system prompt）
 *   回打 663k 仍然命中，证明不是 TTL、不是前缀改写、不是模型 ID 差异。
 * 超过此线的请求付全额新输入费用却写不进缓存，下一轮必然再次全额重传。
 */
export const CACHE_WRITE_CEILING = 663_000

/** 提示长度已越过缓存写入上限——这类请求的新输入是纯浪费。 */
export function isOverCacheCeiling(tokens: Pick<NormalizedTokens, 'promptTokens'>): boolean {
  return tokens.promptTokens > CACHE_WRITE_CEILING
}

export const CONTEXT_BANDS = [
  { key: 'a', label: '<50k', min: 0, max: 50_000 },
  { key: 'b', label: '50-150k', min: 50_000, max: 150_000 },
  { key: 'c', label: '150-250k', min: 150_000, max: 250_000 },
  { key: 'd', label: '250-400k', min: 250_000, max: 400_000 },
  { key: 'e', label: '400-663k', min: 400_000, max: CACHE_WRITE_CEILING },
  { key: 'f', label: '>663k 超缓存上限', min: CACHE_WRITE_CEILING, max: Number.POSITIVE_INFINITY },
] as const

export function bandFor(promptTokens: number): string {
  const band = CONTEXT_BANDS.find((b) => promptTokens >= b.min && promptTokens < b.max)
  return band?.label ?? CONTEXT_BANDS[CONTEXT_BANDS.length - 1].label
}

/**
 * 按归一化口径计算单条请求成本，缓存段永不重复计价。
 * 传入请求时刻可按当时生效的价格结算；分档按完整提示长度（promptTokens）自动选取。
 */
export function costForTokens(model: string, tokens: NormalizedTokens, at?: PriceAt): number | null {
  const pricing = getModelPricing(model, at)
  if (!pricing) return null
  const rates = ratesFor(pricing, tokens.promptTokens)
  return (
    (tokens.freshInputTokens * rates.input +
      tokens.outputTokens * rates.output +
      tokens.cacheReadTokens * rates.cacheRead +
      tokens.cacheWriteTokens * cacheWritePrice(rates)) /
    1_000_000
  )
}

/**
 * 若这条请求的缓存全部命中（fresh 与 write 归零），能省下多少钱。
 * 用来量化「超上限重传」到底浪费了多少，而不是只报一个百分比。
 * 缓存写入段同样是「本可避免的溢价」，必须计入，否则会低估浪费。
 */
export function wastedCostFor(model: string, tokens: NormalizedTokens, at?: PriceAt): number | null {
  const pricing = getModelPricing(model, at)
  if (!pricing) return null
  const rates = ratesFor(pricing, tokens.promptTokens)
  const freshWaste = tokens.freshInputTokens * (rates.input - rates.cacheRead)
  const writeWaste = tokens.cacheWriteTokens * (cacheWritePrice(rates) - rates.cacheRead)
  return (freshWaste + writeWaste) / 1_000_000
}
