/**
 * /models row model (DESIGN §6.6). Pure: joins the model index (mappings + prices), the 7-day usage overview
 * (tokens, the same query as /usage) and the optional insights evidence (success, spec, probes) into one row
 * per canonical model. Unknown stays null and renders `—`; a missing price is never `$0`.
 */
import { clockParts, dayKey, fmtTime } from '../../ui/fmt.js'
import type { ModelKind } from '../../lib/modelKind.js'

/*
 * Structural copies of the payload shapes this module reads (`src/types.ts` ModelEntry / UsageOverviewData /
 * SyncJob are assignable to them). Kept local so `server/modelsPageModel.test.ts` can import this file under the
 * server's NodeNext resolution without pulling the whole client type file.
 */
export type IndexSource = { channel: string; kind: 'compat' | 'oauth'; enabled: boolean; upstreams: number; channelEnabled: boolean }
export type PriceQuote = { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; unit?: string; sourceId?: string; fetchedAt?: number }
export type IndexPricing = { input: number; output: number; cacheRead: number; cacheWrite?: number }
export type IndexModel = {
  id: string
  pricing: IndexPricing | null
  sources: IndexSource[]
  enabledSources: number
  contested: boolean
  pricingSources?: Partial<Record<'models.dev' | 'openrouter', PriceQuote>>
  unpriced?: boolean
  availableOnGateway?: boolean
  /** by output (server/modelKind.ts); absent on servers before the field existed */
  kind?: ModelKind
}
export type UsageModels = { models: Array<{ model: string; requests: number; totalTokens: number; costUsd?: number | null }> }
export type SyncJobView = {
  id: string
  state: string
  lastRunAt: string | null
  lastFinishedAt: string | null
  nextRunAt: string | null
  lastResult: string | null
  lastError: string | null
  summary: string | null
  backoffUntil: string | null
}
/** same union as the kit's StatusKind (src/ui/types.ts) */
export type MarkState = 'run' | 'busy' | 'pause' | 'idle' | 'off' | 'cool' | 'warn' | 'bad' | 'stale'

/* ── /api/models/insights (CONTRACTS C7) ── */
export type InsightUsage = {
  model: string
  requests: number
  errors: number
  lastOkHour: string | null
  lastErrorHour: string | null
  topError: { status: number; category: string; requests: number } | null
  /** top error on the current channels only; absent on servers before the review fix (then no cause is named) */
  liveTopError?: { status: number; category: string; requests: number } | null
  /** `removed` = no longer a current channel (history, all-channel scope); absent on servers before 2026-10-02 */
  channels: Array<{ channel: string; requests: number; errors: number; removed?: boolean; lastOkHour?: string | null }>
}
export type InsightSpec = {
  model: string
  name: string | null
  contextWindow: number | null
  maxOutput: number | null
  reasoning: boolean | null
  efforts: string[]
  specSource: 'gateway' | 'catalog' | 'openrouter' | 'models.dev' | null
}
export type InsightProbe = {
  channel: string
  lastProbeAt: string | null
  nextProbeAt: string | null
  status: number | null
  error: string | null
  discovered: number | null
  backoffUntil: string | null
}
export type ModelInsights = {
  days: number
  from: string
  usage: InsightUsage[] | null
  specs: InsightSpec[]
  probes: InsightProbe[]
  degraded: string[]
  generatedAt: string
}

export type PriceSourceKey = 'models.dev' | 'openrouter'
export const PRICE_SOURCE_KEYS: PriceSourceKey[] = ['models.dev', 'openrouter']

/** One routable mapping: the exact gateway id on one channel (what the PATCH toggles). */
export type ModelMapping = IndexSource & { model: string }

export type PriceView = {
  /** billing = the price the ledger uses; reference = only a source quote; none = no price anywhere */
  kind: 'billing' | 'reference' | 'none'
  input: number | null
  output: number | null
  free: boolean
  /** billing: the source quoting the same price (null = static table / gateway); reference: the quote shown */
  source: PriceSourceKey | null
}

export type ModelRow = {
  key: string
  id: string
  aliases: string[]
  vendor: string
  vendorLabel: string
  /** 对话 / 图片 / 视频 / …; null = the server sent no kind (no tag, outside every type filter but 全部) */
  kind: ModelKind | null
  mappings: ModelMapping[]
  channels: number
  enabledChannels: number
  inUse: boolean
  multi: boolean
  /** one exact id served by ≥2 enabled channels (the gateway splits that id) */
  contested: boolean
  catalogOnly: boolean
  billing: IndexPricing | null
  sources: Partial<Record<PriceSourceKey, PriceQuote>>
  price: PriceView
  unbilled: boolean
  spec: InsightSpec | null
  /** 7-day usage from /api/usage-overview: null = not loaded, 0 = no calls */
  tokens: number | null
  requests: number | null
  cost: number | null
  evidence: InsightUsage | null
  /** null = no requests or no evidence */
  successRate: number | null
  status: MarkState
  statusLabel: string
  note: string
  bad: boolean
}

export type ModelView = 'inuse' | 'attn' | 'multi' | 'unpriced' | 'off' | 'all'
export type ModelSortKey = 'tokens' | 'id' | 'input' | 'output' | 'context' | 'success' | 'channels'
export const MODEL_SORT_KEYS: ModelSortKey[] = ['tokens', 'id', 'input', 'output', 'context', 'success', 'channels']
/** natural first direction per key: the busiest / largest / worst first, names A→Z, prices cheap first */
export const MODEL_SORT_DIR: Record<ModelSortKey, 'asc' | 'desc'> = {
  tokens: 'desc', id: 'asc', input: 'asc', output: 'asc', context: 'desc', success: 'asc', channels: 'desc',
}

/** Availability thresholds: all-failing with ≥3 calls is 不可用; success under 90% with ≥10 calls is 注意. */
export const MODEL_HEALTH = { badMinRequests: 3, warnMinRequests: 10, warnBelow: 0.9 }

/** Same identity as the server (`normalizeModelForPricing`): drop the first `vendor/` prefix and `[1m]`. */
export function canonicalModel(id: string): string {
  let name = String(id || '').trim()
  const slash = name.indexOf('/')
  if (slash !== -1) name = name.slice(slash + 1)
  if (name.endsWith('[1m]')) name = name.slice(0, -4)
  return name
}

const VENDOR_ALIAS: Record<string, string> = {
  'x-ai': 'xai', 'z-ai': 'zhipu', zhipuai: 'zhipu', thudm: 'zhipu', moonshotai: 'moonshot', 'meta-llama': 'meta',
  mistralai: 'mistral', alibaba: 'qwen', 'qwen-ai': 'qwen', google: 'google', 'google-ai': 'google', anthropic: 'anthropic', openai: 'openai',
}
const VENDOR_LABEL: Record<string, string> = {
  anthropic: 'Anthropic', openai: 'OpenAI', google: 'Google', xai: 'xAI', deepseek: 'DeepSeek', qwen: 'Qwen', zhipu: '智谱',
  moonshot: 'Moonshot', minimax: 'MiniMax', meta: 'Meta', mistral: 'Mistral', nvidia: 'NVIDIA', cohere: 'Cohere', openrouter: 'OpenRouter',
  other: '其他',
}
const VENDOR_KEYWORDS: Array<[RegExp, string]> = [
  [/claude|opus|sonnet|haiku/, 'anthropic'],
  [/^(gpt|o\d|codex|chatgpt|dall-e|whisper|sora|tts-)/, 'openai'],
  [/gemini|gemma|lyria|imagen|veo-/, 'google'],
  [/grok/, 'xai'],
  [/deepseek/, 'deepseek'],
  [/qwen|qwq/, 'qwen'],
  [/glm/, 'zhipu'],
  [/kimi|moonshot/, 'moonshot'],
  [/minimax|abab/, 'minimax'],
  [/llama/, 'meta'],
  [/mistral|codestral|devstral|magistral|ministral/, 'mistral'],
  [/nemotron/, 'nvidia'],
]

const vendorKey = (raw: string) => {
  const value = raw.trim().toLowerCase().replace(/^~/, '')
  return VENDOR_ALIAS[value] ?? value
}
export const vendorLabelOf = (key: string) => VENDOR_LABEL[key] ?? key

/** Vendor from the OpenRouter source id, else a `vendor/` prefix that is not the serving channel, else keywords. */
export function modelVendor(members: IndexModel[], channelNames: Set<string>): string {
  for (const member of members) {
    const sourceId = member.pricingSources?.openrouter?.sourceId
    if (sourceId && sourceId.includes('/')) return vendorKey(sourceId.slice(0, sourceId.indexOf('/')))
  }
  for (const member of members) {
    const slash = member.id.indexOf('/')
    if (slash <= 0) continue
    const prefix = member.id.slice(0, slash)
    const servedBy = new Set(member.sources.map((source) => source.channel.toLowerCase()))
    if (channelNames.has(prefix.toLowerCase()) && servedBy.has(prefix.toLowerCase())) continue
    return vendorKey(prefix)
  }
  const name = canonicalModel(members[0]?.id ?? '').toLowerCase()
  for (const [pattern, vendor] of VENDOR_KEYWORDS) if (pattern.test(name)) return vendor
  return 'other'
}

const finite = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)

export function priceView(billing: IndexPricing | null, sources: Partial<Record<PriceSourceKey, PriceQuote>>): PriceView {
  if (billing && finite(billing.input) !== null && finite(billing.output) !== null) {
    const source = PRICE_SOURCE_KEYS.find((key) => sources[key]?.input === billing.input && sources[key]?.output === billing.output) ?? null
    return { kind: 'billing', input: billing.input, output: billing.output, free: billing.input === 0 && billing.output === 0, source }
  }
  for (const key of PRICE_SOURCE_KEYS) {
    const quote = sources[key]
    const input = finite(quote?.input)
    const output = finite(quote?.output)
    if (input !== null && output !== null) return { kind: 'reference', input, output, free: input === 0 && output === 0, source: key }
  }
  return { kind: 'none', input: null, output: null, free: false, source: null }
}

/** `07 时` today, `10/01 07 时` otherwise (Asia/Shanghai). The rollup is hourly, so this never claims minutes. */
export function hourLabel(value: string | null | undefined, now = Date.now()): string {
  const parts = value ? clockParts(value) : null
  if (!parts) return '—'
  return dayKey(value) === dayKey(now) ? `${parts.hour} 时` : `${parts.month}/${parts.day} ${parts.hour} 时`
}

export const errorWord = (error: InsightUsage['topError']) => (error ? `${error.status || ''} ${error.category || ''}`.trim() || '错误' : '')

type Health = Pick<ModelRow, 'status' | 'statusLabel' | 'note' | 'bad'>

/**
 * Status and 成功率 judge the routes that exist now: traffic through channels removed since stays in the token /
 * request totals (reports count all traffic) but not in the verdict, so a dead channel's failures cannot mark a
 * model 不可用 and its old successes cannot vouch for it.
 */
export function liveEvidence(ev: InsightUsage | null): InsightUsage | null {
  if (!ev || !ev.channels.some((c) => c.removed)) return ev
  const live = ev.channels.filter((c) => !c.removed)
  const requests = live.reduce((sum, c) => sum + c.requests, 0)
  const errors = live.reduce((sum, c) => sum + c.errors, 0)
  const okTimes = live.map((c) => (c.lastOkHour ? Date.parse(c.lastOkHour) : Number.NaN)).filter(Number.isFinite)
  return {
    ...ev,
    requests,
    errors,
    lastOkHour: okTimes.length ? new Date(Math.max(...okTimes)).toISOString() : null,
    // the cause must come from the same current channels as the verdict; an older server without the
    // current-channel split names none rather than a removed channel's error
    topError: errors > 0 ? (ev.liveTopError ?? null) : null,
    channels: live,
  }
}

function healthOf(row: Omit<ModelRow, keyof Health>, probes: Map<string, InsightProbe>, now: number): Health {
  if (row.catalogOnly) return { status: 'idle', statusLabel: '仅目录', note: '价格源收录 · 网关未提供', bad: false }
  if (!row.inUse) return { status: 'off', statusLabel: '停用', note: `${row.channels} 个渠道映射均已停用`, bad: false }
  const ev = row.evidence
  if (ev && ev.requests >= MODEL_HEALTH.badMinRequests && ev.errors >= ev.requests) {
    return { status: 'bad', statusLabel: '不可用', note: [`近 7 天 ${ev.requests} 次全部失败`, errorWord(ev.topError)].filter(Boolean).join(' · '), bad: true }
  }
  if (ev && ev.requests >= MODEL_HEALTH.warnMinRequests && (ev.requests - ev.errors) / ev.requests < MODEL_HEALTH.warnBelow) {
    const pct = (((ev.requests - ev.errors) / ev.requests) * 100).toFixed(1)
    return { status: 'warn', statusLabel: '注意', note: [`成功 ${pct}%`, errorWord(ev.topError)].filter(Boolean).join(' · '), bad: true }
  }
  const enabled = [...new Set(row.mappings.filter((m) => m.enabled).map((m) => m.channel))]
  const probed = enabled.map((channel) => probes.get(channel)).filter((p): p is InsightProbe => Boolean(p?.lastProbeAt))
  const failing = (p: InsightProbe) => Boolean(p.error) || (p.status !== null && p.status >= 400)
  if (probed.length && probed.length === enabled.length && probed.every(failing)) {
    const first = probed[0]
    return { status: 'warn', statusLabel: '探测失败', note: `${first.channel} /models ${first.status ?? ''} ${first.error ?? ''}`.trim(), bad: true }
  }
  if (ev && ev.lastOkHour) return { status: 'run', statusLabel: '可用', note: `最近成功 ${hourLabel(ev.lastOkHour, now)}`, bad: false }
  const ok = probed.find((p) => !failing(p))
  if (ok?.lastProbeAt) return { status: 'run', statusLabel: '启用', note: `${ok.channel} 探测 ${fmtTime(ok.lastProbeAt, now)} ✓`, bad: false }
  return { status: 'run', statusLabel: '启用', note: '', bad: false }
}

export type ModelRowInput = {
  models: IndexModel[]
  channelNames: string[]
  usage: UsageModels | null
  insights: ModelInsights | null
  now?: number
}

/** Group index entries by canonical id; the routable entry with most enabled mappings becomes the row id. */
export function buildModelRows(input: ModelRowInput): ModelRow[] {
  const now = input.now ?? Date.now()
  const channelNames = new Set(input.channelNames.map((name) => name.toLowerCase()))
  const groups = new Map<string, IndexModel[]>()
  for (const entry of input.models) {
    const key = canonicalModel(entry.id)
    if (!key) continue
    const list = groups.get(key)
    if (list) list.push(entry)
    else groups.set(key, [entry])
  }

  const usage = new Map<string, { tokens: number; requests: number; cost: number | null }>()
  for (const row of input.usage?.models ?? []) {
    const key = canonicalModel(row.model)
    const current = usage.get(key) ?? { tokens: 0, requests: 0, cost: 0 }
    current.tokens += Number(row.totalTokens) || 0
    current.requests += Number(row.requests) || 0
    current.cost = current.cost !== null && typeof row.costUsd === 'number' && Number.isFinite(row.costUsd) ? current.cost + row.costUsd : null
    usage.set(key, current)
  }
  const evidence = new Map((input.insights?.usage ?? []).map((row) => [canonicalModel(row.model), row]))
  const specs = new Map((input.insights?.specs ?? []).map((row) => [canonicalModel(row.model), row]))
  const probes = new Map((input.insights?.probes ?? []).map((probe) => [probe.channel, probe]))
  const usageKnown = input.usage !== null

  const rows: ModelRow[] = []
  for (const [key, members] of groups) {
    const ranked = [...members].sort((a, b) => b.enabledSources - a.enabledSources || b.sources.length - a.sources.length || a.id.length - b.id.length || a.id.localeCompare(b.id))
    const primary = ranked[0]
    const mappings: ModelMapping[] = ranked.flatMap((member) => member.sources.map((source) => ({ ...source, model: member.id })))
      .sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.channel.localeCompare(b.channel) || a.model.localeCompare(b.model))
    const channels = new Set(mappings.map((m) => m.channel)).size
    const enabledChannels = new Set(mappings.filter((m) => m.enabled).map((m) => m.channel)).size
    const billing = ranked.find((member) => member.pricing)?.pricing ?? null
    const sources: Partial<Record<PriceSourceKey, PriceQuote>> = {}
    for (const member of ranked) {
      for (const sourceKey of PRICE_SOURCE_KEYS) {
        const quote = member.pricingSources?.[sourceKey]
        if (quote && !sources[sourceKey]) sources[sourceKey] = quote
      }
    }
    const used = usage.get(key)
    const ev = liveEvidence(evidence.get(key) ?? null)
    const inUse = enabledChannels > 0
    const vendor = modelVendor(ranked, channelNames)
    const base = {
      key,
      id: primary.id,
      aliases: ranked.slice(1).map((member) => member.id),
      vendor,
      vendorLabel: vendorLabelOf(vendor),
      kind: primary.kind ?? ranked.find((member) => member.kind)?.kind ?? null,
      mappings,
      channels,
      enabledChannels,
      inUse,
      multi: enabledChannels >= 2,
      contested: ranked.some((member) => member.enabledSources > 1),
      catalogOnly: mappings.length === 0,
      billing,
      sources,
      price: priceView(billing, sources),
      unbilled: inUse && !billing,
      spec: specs.get(key) ?? null,
      tokens: usageKnown ? used?.tokens ?? 0 : null,
      requests: usageKnown ? used?.requests ?? 0 : null,
      cost: used ? used.cost : null,
      evidence: ev,
      successRate: ev && ev.requests > 0 ? (ev.requests - ev.errors) / ev.requests : null,
    }
    rows.push({ ...base, ...healthOf(base, probes, now) })
  }
  return rows
}

export function rowInView(row: ModelRow, view: ModelView): boolean {
  switch (view) {
    case 'inuse': return row.inUse
    case 'attn': return row.bad
    case 'multi': return row.multi
    case 'unpriced': return row.unbilled
    case 'off': return !row.inUse && !row.catalogOnly
    default: return true
  }
}

export function viewCounts(rows: ModelRow[]): Record<ModelView, number> {
  const counts: Record<ModelView, number> = { inuse: 0, attn: 0, multi: 0, unpriced: 0, off: 0, all: rows.length }
  for (const row of rows) {
    if (row.inUse) counts.inuse += 1
    if (row.bad) counts.attn += 1
    if (row.multi) counts.multi += 1
    if (row.unbilled) counts.unpriced += 1
    if (!row.inUse && !row.catalogOnly) counts.off += 1
  }
  return counts
}

export function rowMatches(row: ModelRow, needle: string): boolean {
  const q = needle.trim().toLowerCase()
  if (!q) return true
  const hay = [row.id, ...row.aliases, row.vendorLabel, row.spec?.name ?? '', ...row.mappings.map((m) => m.channel)].join('\n').toLowerCase()
  return hay.includes(q)
}

const sortValue = (row: ModelRow, key: ModelSortKey): number | string | null => {
  switch (key) {
    case 'tokens': return row.tokens
    case 'id': return row.id
    case 'input': return row.price.input
    case 'output': return row.price.output
    case 'context': return row.spec?.contextWindow ?? null
    case 'success': return row.successRate
    case 'channels': return row.enabledChannels
  }
}

/**
 * Unknown is never "smallest": nulls sort last in both directions. Ties: failing models first (a model whose
 * calls all fail has 0 tokens and would otherwise sink), then more calls, in-use first, then the canonical id.
 */
export function sortModelRows(rows: ModelRow[], key: ModelSortKey, dir: 'asc' | 'desc'): ModelRow[] {
  const sign = dir === 'desc' ? -1 : 1
  return [...rows].sort((a, b) => {
    const va = sortValue(a, key)
    const vb = sortValue(b, key)
    if (va !== vb) {
      if (va === null) return 1
      if (vb === null) return -1
      const base = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb))
      if (base) return base * sign
    }
    return Number(b.bad) - Number(a.bad) || (b.requests ?? 0) - (a.requests ?? 0) || Number(b.inUse) - Number(a.inUse) || a.key.localeCompare(b.key) || a.id.localeCompare(b.id)
  })
}

/** `$3` · `$2.5` · `$0.075`; prices are per million tokens. */
export function fmtUnitPrice(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  if (value === 0) return '$0'
  return `$${Number(value.toPrecision(value >= 1 ? 4 : 2))}`
}

/** `200K` · `256K` · `1M` · `1.5M` (binary-sized windows read the way vendors label them). */
export function fmtWindow(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value) || value <= 0) return '—'
  if (value >= 1_000_000) {
    const m = value % 1_048_576 === 0 ? value / 1_048_576 : value / 1_000_000
    return `${Number(m.toFixed(1))}M`
  }
  if (value % 1024 === 0) return `${value / 1024}K`
  return `${Math.round(value / 1000)}K`
}

export type CatalogSyncFacts = {
  state: MarkState
  /** `目录 07:23 ✓ 503 模型` */
  text: string
  next: string | null
  detail: string | null
}

/** Head line for the model-discovery job; no job (old server / failed read) → null, the page shows only the link. */
export function catalogSyncFacts(job: SyncJobView | undefined, clock: (at: string) => string): CatalogSyncFacts | null {
  if (!job) return null
  const last = job.lastFinishedAt ?? job.lastRunAt
  const at = last ? clock(last) : '从未'
  const next = job.nextRunAt ? clock(job.nextRunAt) : null
  if (job.state === 'running') return { state: 'busy', text: '目录 同步中', next, detail: job.summary }
  if (job.state === 'backoff') return { state: 'warn', text: `目录 退避${job.backoffUntil ? ` → ${clock(job.backoffUntil)}` : ''}`, next: null, detail: job.lastError }
  if (job.state === 'disabled') return { state: 'off', text: '目录 已停用', next: null, detail: null }
  if (job.lastResult === 'error' || job.state === 'error') return { state: 'bad', text: `目录 ${at} 失败`, next, detail: job.lastError }
  if (job.lastResult === 'partial') return { state: 'warn', text: `目录 ${at} 部分成功`, next, detail: job.lastError ?? job.summary }
  if (!last) return { state: 'idle', text: '目录 尚未同步', next, detail: null }
  return { state: 'run', text: `目录 ${at} ✓`, next, detail: job.summary }
}

/* ── batch mapping switch (the old console's 批量启用 / 停用渠道映射) ── */

/**
 * The mappings a batch switch writes, by exact identity (indexed model id @ channel : kind — an alias row folds
 * several ids, each written as itself). Same rule as the per-mapping switch: a mapping on a disabled channel can
 * be switched off but not on; mappings already in the target state are skipped.
 */
export function batchTargets(rows: readonly ModelRow[], next: boolean): ModelMapping[] {
  const seen = new Set<string>()
  const out: ModelMapping[] = []
  for (const row of rows) {
    for (const m of row.mappings) {
      if (m.enabled === next || (next && !m.channelEnabled)) continue
      const id = `${m.model}@${m.channel}:${m.kind}`
      if (seen.has(id)) continue
      seen.add(id)
      out.push(m)
    }
  }
  return out
}

/* ── old /models links (the previous console's query) ── */

const LEGACY_MODEL_KEYS = ['filter', 'channel', 'kind', 'dir', 'size', 'cols', 'days', 'keyId'] as const
const LEGACY_VIEW: Record<string, ModelView> = { enabled: 'inuse', contested: 'multi', off: 'off', all: 'all' }
const LEGACY_SORT: Record<string, ModelSortKey> = { name: 'id', input: 'input', output: 'output', usage: 'tokens', sources: 'channels' }
const OLD_ONLY_SORTS = new Set(['name', 'usage', 'sources'])
const qs = (value: unknown): string => (Array.isArray(value) ? qs(value[0]) : value === null || value === undefined ? '' : String(value))

/**
 * An old bookmark (`/models?filter=off&channel=x&sort=usage&dir=desc&size=25&page=3&days=30&keyId=K`) as the
 * current scope: filter → view (none = the old default 全部), channel → search, sort + dir → `key:dir`, page re-based to the new page size;
 * days / keyId / kind / cols have no equivalent here (fixed 7 days, every Key) and are dropped so the URL never
 * shows a scope that is not applied. Null when the URL carries nothing old.
 */
export function legacyModelsQuery(query: Record<string, unknown>, pageSize = 50): Record<string, string> | null {
  const sort = qs(query.sort)
  const legacy = LEGACY_MODEL_KEYS.some((key) => key in query) || OLD_ONLY_SORTS.has(sort)
  if (!legacy) return null
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(query)) {
    if ((LEGACY_MODEL_KEYS as readonly string[]).includes(key)) continue
    const v = qs(value)
    if (v !== '') out[key] = v
  }
  // the old page's default filter was 全部 (not written to the URL), so an old link without one meant all models
  const view = LEGACY_VIEW[qs(query.filter) || 'all']
  if (view && !out.view && view !== 'inuse') out.view = view
  const channel = qs(query.channel).trim()
  if (channel && !out.q) out.q = channel
  if (sort && !sort.includes(':')) {
    const key = LEGACY_SORT[sort]
    if (key) out.sort = `${key}:${qs(query.dir) === 'desc' ? 'desc' : 'asc'}`
    else delete out.sort
  } else if (!sort && qs(query.dir) === 'desc') {
    out.sort = 'id:desc'
  }
  const size = Number(qs(query.size))
  const page = Number(out.page)
  if (Number.isFinite(size) && size > 0 && Number.isFinite(page) && page > 1) {
    const next = Math.floor(((page - 1) * size) / pageSize) + 1
    if (next > 1) out.page = String(next)
    else delete out.page
  }
  return out
}
