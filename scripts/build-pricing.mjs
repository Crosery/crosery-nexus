/**
 * 生成 server/pricing.data.json。
 *
 * 主数据源是 models.dev（含 release_date、上下文分档 tiers、cache_write），
 * LiteLLM 的 model_prices_and_context_window.json 只在 models.dev 缺条目时补位。
 *
 *   node scripts/build-pricing.mjs [models.dev 本地 JSON] [LiteLLM 本地 JSON]
 *
 * 输出结构：pricing[modelId] 是按 from 升序的价格区间数组，每段
 *   { from, until?, input, output, cacheRead, cacheWrite?, tiers?, note? }
 * 单位美元 / 百万 token。tiers[].above 表示「整条请求的 prompt token 超过该值时，
 * 整条请求按该档单价结算」（OpenAI / Google / MiniMax 的长上下文规则）。
 *
 * 网关自定义命名（gpt-5.6-sol、gemini-3.5-flash-low 等）在上游没有同名条目，
 * 用 UPSTREAM_ALIASES 指到等价的上游模型；确实查不到的留空，由页面显式提示未定价。
 */
import { readFileSync, writeFileSync } from 'node:fs'

const MODELS_DEV_SOURCE = 'https://models.dev/api.json'
const LITELLM_SOURCE = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json'
/** models.dev 没给发布日期时的兜底起算日；早于首段的时间一律按首段计价。 */
const DEFAULT_FROM = '2026-01-01'
/** 官方渠道优先；第三方转售商的价格可能含加价或缺缓存价。groq 只用于 gpt-oss 这类开放权重模型。 */
const FIRST_PARTY_PROVIDERS = ['anthropic', 'openai', 'google', 'minimax', 'moonshotai', 'zai', 'deepseek', 'alibaba', 'xai', 'groq']

// 网关对外提供的模型裸名。渠道前缀（qiji/、codex-static/）在服务端归一化时剥掉。
const GATEWAY_MODELS = [
  'claude-3-5-haiku-20241022', 'claude-3-7-sonnet-20250219', 'claude-fable-5', 'claude-fable-5-1',
  'claude-haiku-4-5-20251001', 'claude-opus-4-1-20250805', 'claude-opus-4-20250514',
  'claude-opus-4-5-20251101', 'claude-opus-4-6', 'claude-opus-4-6-thinking', 'claude-opus-4-7', 'claude-opus-4-8',
  'claude-opus-5', 'claude-sonnet-4-20250514', 'claude-sonnet-4-5-20250929',
  'claude-sonnet-4-6', 'claude-sonnet-5',
  'codex-auto-review',
  'deepseek-v4-flash', 'deepseek-v4-pro',
  'gemini-2.5-flash-nothinking', 'gemini-2.5-flash-thinking',
  'gemini-3-flash', 'gemini-3-flash-agent', 'gemini-3-flash-preview-nothinking',
  'gemini-3.1-flash-image', 'gemini-3.1-flash-lite', 'gemini-3.1-flash-lite-preview',
  'gemini-3.1-pro-low', 'gemini-3.1-pro-preview',
  'gemini-3.5-flash-extra-low', 'gemini-3.5-flash-low',
  'gemini-3.6-flash', 'gemini-3.6-flash-high', 'gemini-3.7-flash', 'gemini-3.7-flash-high',
  'gemini-pro-agent',
  'glm-5', 'glm-5.2',
  'gpt-5.3-codex-spark', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.4-pro', 'gpt-5.5',
  'gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6-sol-wm', 'gpt-5.6-terra',
  'gpt-image-1', 'gpt-image-1.5', 'gpt-image-2',
  'gpt-oss-120b-medium',
  'grok-4.20-0309-non-reasoning', 'grok-4.20-0309-reasoning',
  'grok-4.20-multi-agent-0309', 'grok-4.3', 'grok-4.5', 'grok-build-0.1',
  'kimi-k2.5', 'kimi-k2.7-code', 'kimi-k3',
  'MiniMax-M3', 'minimax-m2.5', 'minimax-m2.7', 'minimax-m3',
  'qwen3.6-plus', 'qwen3.7-max', 'qwen3.7-plus', 'qwen3.8-max',
  // Command Code（commandcode 渠道）只挂了廉价模型，别名即裸模型名。
  // 上游名带厂商标识，models.dev 的对应条目是别家转售价，不能直接用，走 MANUAL_PRICING。
  'mimo-v2.5', 'mimo-v2.5-pro', 'qwen3.7-flash',
  'longcat-2.0-free', 'ling-3.0-flash-sante-free',
]

/**
 * 明确不定价的模型。第三方站点的估算价不能冒充官方 API 价卡；
 * 页面会显式提示「单价未收录」，比用一个猜的数字静默计费更安全。
 */
const UNPRICED = {
  // OpenAI 官方价卡把 Codex Spark 标为 research preview，只对 ChatGPT Pro 订阅开放，没有公开 API 单价。
  'gpt-5.3-codex-spark': 'official rate card lists research preview only',
  // Codex 内置的自动评审是订阅内功能，没有按 token 的 API 价格。
  'codex-auto-review': 'subscription-only feature without a token price',
}

// 网关模型名 -> models.dev 的 provider/model（可给多个候选，按顺序取第一个有价的）。没列的按 defaultUpstream() 推导。
const UPSTREAM_ALIASES = {
  'claude-opus-4-6-thinking': 'anthropic/claude-opus-4-6',
  'gemini-2.5-flash-nothinking': 'google/gemini-2.5-flash',
  'gemini-2.5-flash-thinking': 'google/gemini-2.5-flash',
  'gemini-3-flash': 'google/gemini-3-flash-preview',
  'gemini-3-flash-agent': 'google/gemini-3-flash-preview',
  'gemini-3-flash-preview-nothinking': 'google/gemini-3-flash-preview',
  'gemini-3.1-pro-low': 'google/gemini-3.1-pro-preview',
  'gemini-pro-agent': 'google/gemini-3.1-pro-preview',
  'gemini-3.5-flash-extra-low': 'google/gemini-3.5-flash',
  'gemini-3.5-flash-low': 'google/gemini-3.5-flash',
  'gemini-3.6-flash-high': 'google/gemini-3.6-flash',
  'gemini-3.7-flash-high': 'google/gemini-3.7-flash',
  'gpt-5.6-sol': 'openai/gpt-5.6',
  'gpt-5.6-sol-wm': 'openai/gpt-5.6',
  // OpenAI 自己不托管 gpt-oss；官方条目缺席时用 groq 的官方托管价（OpenAI 公布的开放权重参考价）。
  'gpt-oss-120b-medium': ['openai/gpt-oss-120b', 'groq/openai/gpt-oss-120b'],
  'MiniMax-M3': 'minimax/MiniMax-M3',
  'minimax-m3': 'minimax/MiniMax-M3',
  'minimax-m2.5': 'minimax/MiniMax-M2.5',
  'minimax-m2.7': 'minimax/MiniMax-M2.7',
}

/**
 * models.dev 没有（或只有 null 价格）时改用 LiteLLM 条目。
 * imageTokens=true 表示按 *_per_image_token 价卡取值：CPA Usage Queue 对图片请求记录的
 * input/cached/output 都是图像 token（与下方 gpt-image-2 的口径一致），不能按文本单价结算。
 */
const LITELLM_FALLBACKS = {
  'claude-3-5-haiku-20241022': 'anthropic.claude-3-5-haiku-20241022-v1:0',
  'gpt-image-1': { key: 'gpt-image-1', imageTokens: true },
  'gpt-image-1.5': { key: 'gpt-image-1.5', imageTokens: true },
}

// 两个数据源都收录不到、但上游已公布标准 API 价格的模型。每个覆盖项必须有公开上游价格证据。
const MANUAL_PRICING = {
  // OpenAI 官方 API price card：GPT-Image-2 的 image 输入/缓存/输出为 8 / 2 / 30。
  // CPA Usage Queue 对图片请求记录的 input/cached/output 都是图像 token，故按 image 价卡结算；
  // models.dev / LiteLLM 给的是文本 token 单价，不能用。
  'gpt-image-2': [{ from: '2026-04-21', input: 8, output: 30, cacheRead: 2, note: 'OpenAI image token rate card' }],
  // Command Code 自家刊例价（https://commandcode.ai/docs/plans/goat）。上游是它自己的路由，
  // 转售价不等于它收的价，所以逐条写死；免费模型记 0，跑多少都不扣额度。
  'deepseek-v4-flash': [{ from: '2026-09-10', input: 0.15, output: 0.6, cacheRead: 0.003, note: 'Command Code 刊例价（09:00-01:00 UTC 平日档；峰值 01-04/06-10 UTC 为 $0.30/$1.20）' }],
  'deepseek-v4.1-flash': [{ from: '2026-09-10', input: 0.15, output: 0.6, cacheRead: 0.003, note: 'Command Code 刊例价，同 DeepSeek V4 Flash 档' }],
  'mimo-v2.5': [{ from: '2026-09-10', input: 0.14, output: 0.28, cacheRead: 0.0028, note: 'Command Code 刊例价' }],
  'mimo-v2.5-pro': [{ from: '2026-09-10', input: 0.435, output: 0.87, cacheRead: 0.0036, note: 'Command Code 刊例价' }],
  'qwen3.7-flash': [{ from: '2026-09-10', input: 0.03, output: 0.13, cacheRead: 0.006, note: 'Command Code 刊例价' }],
  'longcat-2.0-free': [{ from: '2026-09-10', input: 0.0, output: 0.0, cacheRead: 0.0, note: 'Command Code 免费模型，计费为 0' }],
  'ling-3.0-flash-sante-free': [{ from: '2026-09-10', input: 0.0, output: 0.0, cacheRead: 0.0, note: 'Command Code 免费模型（每天 100 次），计费为 0' }],
}

/**
 * 已知的历史价格区间，按 models.dev 的 provider/model 键控，所有映射到该上游的网关别名共用。
 * 数组直接给出全部区间；函数则基于当前上游价格改写。
 */
const PRICE_HISTORY = {
  // OpenAI GPT-5.6 发布价 5/30/0.5（>272k 档 10/45/1）；2026-08-21 起限时促销 4/20/0.4、缓存写 5
  // （>272k 档 8/30/0.8/10），促销至 2026-11-21，此后恢复发布价。
  'openai/gpt-5.6': [
    { from: '2026-07-09', until: '2026-08-20', input: 5, output: 30, cacheRead: 0.5, tiers: [{ above: 272_000, input: 10, output: 45, cacheRead: 1 }] },
    {
      from: '2026-08-21', until: '2026-11-21', input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5,
      tiers: [{ above: 272_000, input: 8, output: 30, cacheRead: 0.8, cacheWrite: 10 }],
      note: 'OpenAI 限时促销价，2026-11-21 到期',
    },
    { from: '2026-11-22', input: 5, output: 30, cacheRead: 0.5, tiers: [{ above: 272_000, input: 10, output: 45, cacheRead: 1 }], note: '促销结束恢复发布价' },
  ],
  // terra / luna 现价自 2026-07-31 确认；07-09 至 07-30 的价格无记录，按现价追溯（早于首段按首段计）。
  'openai/gpt-5.6-terra': (base) => [{ ...base, from: '2026-07-31', note: '2026-07-31 前价格无记录，按现价计' }],
  'openai/gpt-5.6-luna': (base) => [{ ...base, from: '2026-07-31', note: '2026-07-31 前价格无记录，按现价计' }],
  // Google 对 Gemini 3.7 Flash 的 0.75/3.75/0.075 是限时价，官方未公布到期后的标准价。
  'google/gemini-3.7-flash': [
    { from: '2026-08-13', until: '2026-12-31', input: 0.75, output: 3.75, cacheRead: 0.075, note: '促销价，到期后需核对' },
  ],
  // Anthropic Claude Sonnet 5 发布价 2/10/0.2，缓存写 2.5，长期有效。
  'anthropic/claude-sonnet-5': [{ from: '2026-06-29', input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 }],
}

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value)
const perMillion = (value) => (isNumber(value) ? Number((value * 1_000_000).toFixed(6)) : 0)
const round = (value) => Number(value.toFixed(6))

async function loadJson(localPath, url, label) {
  if (localPath) return JSON.parse(readFileSync(localPath, 'utf8'))
  const response = await fetch(url)
  if (!response.ok) throw new Error(`拉取 ${label} 失败：${response.status}`)
  return response.json()
}

const [modelsDevPath, litellmPath] = process.argv.slice(2)
const modelsDev = await loadJson(modelsDevPath, MODELS_DEV_SOURCE, 'models.dev')
let litellm = {}
try {
  litellm = await loadJson(litellmPath, LITELLM_SOURCE, 'LiteLLM')
} catch (error) {
  console.warn(`LiteLLM 价格表不可用，仅用 models.dev：${error instanceof Error ? error.message : error}`)
}

function defaultUpstream(id) {
  if (id.startsWith('claude-')) return `anthropic/${id}`
  if (id.startsWith('gpt-') || id.startsWith('codex-')) return `openai/${id}`
  if (id.startsWith('gemini-')) return `google/${id}`
  if (id.startsWith('qwen')) return `alibaba/${id}`
  if (id.startsWith('kimi-')) return `moonshotai/${id}`
  if (id.startsWith('glm-')) return `zai/${id}`
  if (id.startsWith('deepseek-')) return `deepseek/${id}`
  if (id.startsWith('grok-')) return `xai/${id}`
  if (/^minimax-/i.test(id)) return `minimax/MiniMax-${id.slice('minimax-'.length).toUpperCase()}`
  return null
}

const hasNumericCost = (entry) => isNumber(entry?.cost?.input) && isNumber(entry?.cost?.output)
/** 第三方托管方把免费额度写成 0/0；这不是价格，兜底时必须跳过。 */
const hasPositiveCost = (entry) => hasNumericCost(entry) && (entry.cost.input > 0 || entry.cost.output > 0)

function lookupModelsDev(upstream) {
  const [provider, ...rest] = upstream.split('/')
  const modelId = rest.join('/')
  const direct = modelsDev[provider]?.models?.[modelId]
  if (hasNumericCost(direct)) return { entry: direct, provider }
  for (const candidate of FIRST_PARTY_PROVIDERS) {
    const entry = modelsDev[candidate]?.models?.[modelId]
    if (hasNumericCost(entry)) return { entry, provider: candidate }
  }
  return null
}

/** 任一 provider 的 release_date，用于 LiteLLM 兜底条目的起算日。 */
function releaseDateFor(modelId) {
  const providers = [...FIRST_PARTY_PROVIDERS, ...Object.keys(modelsDev)]
  for (const provider of providers) {
    const date = modelsDev[provider]?.models?.[modelId]?.release_date
    if (date) return normalizeDate(date)
  }
  return DEFAULT_FROM
}

function normalizeDate(value) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value
  if (/^\d{4}-\d{2}$/.test(value)) return `${value}-01`
  return DEFAULT_FROM
}

function periodFromModelsDev(entry) {
  const cost = entry.cost
  const period = { from: normalizeDate(entry.release_date || ''), input: round(cost.input), output: round(cost.output), cacheRead: isNumber(cost.cache_read) ? round(cost.cache_read) : 0 }
  if (isNumber(cost.cache_write)) period.cacheWrite = round(cost.cache_write)
  const tiers = (cost.tiers || [])
    .filter((tier) => tier?.tier?.type === 'context' && isNumber(tier.tier.size) && isNumber(tier.input) && isNumber(tier.output))
    .map((tier) => {
      const mapped = { above: tier.tier.size, input: round(tier.input), output: round(tier.output), cacheRead: isNumber(tier.cache_read) ? round(tier.cache_read) : period.cacheRead }
      if (isNumber(tier.cache_write)) mapped.cacheWrite = round(tier.cache_write)
      return mapped
    })
    .sort((a, b) => a.above - b.above)
  if (tiers.length) period.tiers = tiers
  return period
}

function periodFromLiteLLM(entry, modelId, options = {}) {
  const input = options.imageTokens ? entry.input_cost_per_image_token ?? entry.input_cost_per_token : entry.input_cost_per_token
  const output = options.imageTokens ? entry.output_cost_per_image_token ?? entry.output_cost_per_token : entry.output_cost_per_token
  if (!isNumber(input) || !isNumber(output)) return null
  const period = { from: releaseDateFor(modelId), input: perMillion(input), output: perMillion(output), cacheRead: perMillion(entry.cache_read_input_token_cost) }
  if (isNumber(entry.cache_creation_input_token_cost)) period.cacheWrite = perMillion(entry.cache_creation_input_token_cost)
  const tiers = []
  for (const key of Object.keys(entry)) {
    const match = key.match(/^input_cost_per_token_above_(\d+)k_tokens$/)
    if (!match) continue
    const suffix = `above_${match[1]}k_tokens`
    const tierOutput = entry[`output_cost_per_token_${suffix}`]
    if (!isNumber(entry[key]) || !isNumber(tierOutput)) continue
    const tier = { above: Number(match[1]) * 1000, input: perMillion(entry[key]), output: perMillion(tierOutput), cacheRead: isNumber(entry[`cache_read_input_token_cost_${suffix}`]) ? perMillion(entry[`cache_read_input_token_cost_${suffix}`]) : period.cacheRead }
    if (isNumber(entry[`cache_creation_input_token_cost_${suffix}`])) tier.cacheWrite = perMillion(entry[`cache_creation_input_token_cost_${suffix}`])
    tiers.push(tier)
  }
  if (tiers.length) period.tiers = tiers.sort((a, b) => a.above - b.above)
  return period
}

function applyHistory(upstreamKey, base) {
  const history = PRICE_HISTORY[upstreamKey]
  if (!history) return [base]
  return typeof history === 'function' ? history(base) : history.map((period) => ({ ...period }))
}

const ORDER = ['from', 'until', 'input', 'output', 'cacheRead', 'cacheWrite', 'tiers', 'note']
const orderKeys = (period) => Object.fromEntries(ORDER.filter((key) => period[key] !== undefined).map((key) => [key, period[key]]))
const sortPeriods = (periods) => periods.map(orderKeys).sort((a, b) => a.from.localeCompare(b.from))

function resolve(model) {
  if (MANUAL_PRICING[model]) return { periods: sortPeriods(MANUAL_PRICING[model]), source: 'manual' }
  const candidates = [UPSTREAM_ALIASES[model] || defaultUpstream(model)].flat().filter(Boolean)
  const upstream = candidates[0] || null
  for (const candidate of candidates) {
    const found = lookupModelsDev(candidate)
    if (!found) continue
    const historyKey = found.provider === candidate.split('/')[0] ? candidate : `${found.provider}/${candidate.split('/').slice(1).join('/')}`
    return { periods: sortPeriods(applyHistory(PRICE_HISTORY[candidate] ? candidate : historyKey, periodFromModelsDev(found.entry))), source: `models.dev:${found.provider}` }
  }
  const fallback = LITELLM_FALLBACKS[model] || model
  const key = typeof fallback === 'string' ? fallback : fallback.key
  const entry = litellm[key]
  if (entry) {
    const period = periodFromLiteLLM(entry, model, typeof fallback === 'string' ? {} : fallback)
    if (period) return { periods: sortPeriods(applyHistory(upstream || '', period)), source: `litellm:${key}` }
  }
  if (upstream) {
    // 官方与 LiteLLM 都没有时，才接受任意托管方的报价（如开放权重模型）。
    const modelId = upstream.split('/').slice(1).join('/')
    for (const [provider, data] of Object.entries(modelsDev)) {
      const candidate = data?.models?.[modelId]
      if (hasPositiveCost(candidate)) return { periods: sortPeriods(applyHistory(`${provider}/${modelId}`, periodFromModelsDev(candidate))), source: `models.dev:${provider}` }
    }
  }
  return null
}

const pricing = {}
const missing = []
const sources = []
for (const model of [...new Set(GATEWAY_MODELS)]) {
  if (UNPRICED[model]) continue
  const resolved = resolve(model)
  if (!resolved) {
    missing.push(model)
    continue
  }
  pricing[model] = resolved.periods
  sources.push(`${model} <- ${resolved.source}`)
}

const payload = {
  source: `${MODELS_DEV_SOURCE} (fallback: ${LITELLM_SOURCE})`,
  generatedAt: new Date().toISOString().slice(0, 10),
  unit: 'USD per 1M tokens',
  pricing: Object.fromEntries(Object.entries(pricing).sort(([a], [b]) => a.localeCompare(b))),
}
writeFileSync(new URL('../server/pricing.data.json', import.meta.url), `${JSON.stringify(payload, null, 2)}\n`)
console.log(`已写入 ${Object.keys(pricing).length} 个模型价格`)
if (process.env.PRICING_VERBOSE) console.log(sources.join('\n'))
console.log(`明确不定价：${Object.keys(UNPRICED).join('、')}`)
if (missing.length) console.log(`仍无价格（页面会显式提示）：${missing.join('、')}`)
