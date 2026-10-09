import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileBackedSecret, positiveInteger } from './config.js'
import { CompatChannelsConflictError, compatChannelsFingerprint, getCompatChannels, getGlobalProxy, putCompatChannels, type CompatChannel } from './cpa.js'
import { invalidateGatewaySnapshot } from './channels.js'
import { modelDiscoveryUrls, normalizeDiscoveredModels, defaultModelAlias, type ChannelProtocol, type DiscoveredModel } from './channelDiscovery.js'
import { db } from './db.js'
import { applySharedPricing, type PriceSourceId, type SourcePrice } from './pricing.js'
import { SYNC_POLICY, upstreamLimiter } from './syncRegistry.js'

export type ModelSyncOutcome = 'ok' | 'partial' | 'error' | 'skipped'

export type ModelSyncResult = {
  addedModels: string[]
  /** 写入后**启用渠道**上的模型映射条数（每渠道各算一条；同一 id 挂在两个渠道上算 2）。 */
  totalModels: number
  channelCount: number
  source: 'shared-catalog' | 'channel-probe' | 'merged' | 'none'
  syncedAt: string
  result: ModelSyncOutcome
  summary: string
  /** 本轮真正发出 /models 探测的渠道数 / 成功数 / 失败数。 */
  probed: number
  succeeded: number
  failed: number
  /** 到期但因主机退避或最小间隔推迟的渠道数。 */
  deferred: number
  /** 凭据引用解析不了而跳过的渠道数（绝不匿名探测）。 */
  missingCredential: number
  /** 走代理的渠道数：控制台没有与推理一致的代理出口，不直连探测（推理走内核/CPA 的代理）。 */
  proxied: number
  /** 因单渠道 500 上限没写进去的模型数与 id（最多列 50 个）；>0 时 result 至少是 partial。 */
  capped: number
  cappedModels: string[]
  requests: number
  errors: string[]
  catalog: { mode: CatalogMergeMode; target: string | null; added: number; changed: boolean }
  /** 没有任何到期工作（同步中心不记历史）。 */
  silent: boolean
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

/* ────────────────────────── 探测节奏与退避 ────────────────────────── */

const MINUTE = 60_000

/**
 * 第三方 `/models` 探测的节奏。共享目录每 6h 才更新一次，渠道模型列表也很少变，
 * 所以每渠道至少 30 分钟才探一次（目录内容变了或手动触发例外），同主机两次**探测**至少隔 1 分钟
 * （一次探测在路径不对——404/405/400 或空列表——时会紧接着试第二个候选路径，找到后记住 workingUrl），
 * 429/5xx/网络错误按主机指数退避，401/403 只退避出错的那个渠道（只说明这把 key 不行），都服从 Retry-After——
 * 这些都是「别被上游当成扫描器」的底线。
 */
export const DISCOVERY_POLICY = {
  channelIntervalMs: positiveInteger('MODEL_DISCOVERY_INTERVAL_MS', process.env.MODEL_DISCOVERY_INTERVAL_MS, 30 * MINUTE, { min: 30 * MINUTE, max: 24 * 60 * MINUTE }),
  tickMs: 5 * MINUTE,
  jitterPct: SYNC_POLICY.jitterPct,
  hostMinIntervalMs: SYNC_POLICY.minIntervalPerHostMs,
  backoffBaseMs: 5 * MINUTE,
  authBackoffBaseMs: 30 * MINUTE,
  backoffMaxMs: SYNC_POLICY.backoff.maxMs,
  retryAfterCapMs: 24 * 60 * MINUTE,
  /** 一直拿不到模型列表的渠道：探测间隔逐次翻倍，最多 24h 一次。 */
  emptyMaxIntervalMs: 24 * 60 * MINUTE,
  timeoutMs: 6_000,
  /** applyAdditions 的单渠道默认上限：超出的不写入，如实报告。 */
  maxModelsPerChannel: 500,
}

export type DiscoveryChannelState = {
  lastProbeAt?: number
  nextProbeAt?: number
  workingUrl?: string
  lastStatus?: number | null
  lastError?: string | null
  discovered?: number
  /** 渠道自己的鉴权退避（401/403）：只说明这个渠道的 key 不行，不拖住同主机的其它渠道。 */
  backoffUntil?: number
  backoffLevel?: number
  /** 连续「没返回模型列表」的次数，决定下次探测间隔（翻倍，封顶 24h）；成功清零。 */
  emptyLevel?: number
  /** 渠道所属主机（同步中心判断「是否全部在退避」用）。 */
  host?: string
}

export type DiscoveryHostState = {
  lastRequestAt?: number
  backoffUntil?: number
  backoffLevel?: number
  lastStatus?: number | null
}

export type DiscoveryState = {
  /** 已成功合入的目录哈希（合入失败不推进，下轮重试合入）。 */
  catalogHash?: string
  /** 已触发过补探的目录哈希：与合入分开记，合入失败也不会让每轮都重探所有渠道。 */
  probedCatalogHash?: string
  channels?: Record<string, DiscoveryChannelState>
  hosts?: Record<string, DiscoveryHostState>
}

export type SyncChannel = {
  name: string
  baseUrl: string
  disabled: boolean
  keyRef: string | undefined
  models: Array<{ name: string; alias?: string }>
  /** 探测协议：`claude` 用 x-api-key + anthropic-version 与 /v1/models；其余按 OpenAI 兼容。 */
  protocol?: ChannelProtocol
  /** 推理实际走的代理（非 direct 时才有值）。 */
  proxy?: string | null
  /** 渠道自定义请求头：值是原文或 `env:NAME` 引用。 */
  headers?: Record<string, string>
}

/** 渠道名 → 管理员停用过的模型（小写 id 与别名），即 `channel_model_states` 里 enabled=0 的墓碑。 */
export type BlockedModels = Map<string, Set<string>>

export type CommitResult = {
  added: string[]
  capped: number
  /** 被单渠道上限挡掉的模型 id。 */
  cappedIds?: string[]
  /** 写入后启用渠道上的模型映射条数。 */
  total?: number
}

export type ChannelStore = {
  read: () => Promise<SyncChannel[]>
  /**
   * 在**写入前重新读取的**最新渠道表上追加模型（只加不删），返回真正写入的模型 id。
   * 探测期间管理员改过渠道也不会被这份旧快照覆盖；`blocked` 在写入那一刻重新读取停用墓碑。
   */
  commit: (additions: Map<string, DiscoveredModel[]>, guard?: { blocked?: () => BlockedModels }) => Promise<CommitResult>
}

export type ModelSyncDeps = {
  now?: () => number
  random?: () => number
  fetch?: (input: string, init?: RequestInit) => Promise<Response>
  resolveCredential?: (reference: string) => Promise<string>
  /** 自定义请求头里的 `env:NAME` 引用解析。 */
  resolveSecret?: (reference: string) => string
  countRequest?: () => void
  readCatalog?: () => SharedCatalog | null
  store?: ChannelStore
  /** 管理员停用过的模型（每次运行开始与写入前各读一次）。 */
  disabledModels?: () => BlockedModels
  /** 全局上游并发闸门（与账号额度共享）。 */
  limit?: <T>(task: () => Promise<T>) => Promise<T>
  afterWrite?: () => Promise<void>
  /** 目录合入目标：渠道名强制指定；`off` 关闭合入；空 = 自动（见 resolveCatalogTarget）。 */
  catalogTarget?: string
}

/** `legacy` 已不再产生（保留在类型里只为兼容旧的结果读者）。 */
export type CatalogMergeMode = 'matched' | 'pinned' | 'legacy' | 'off' | 'none'

const lower = (value: string) => value.trim().toLowerCase()

/** 只对模型 id 集合做哈希：生成时间、价格段每 6h 都会变，但那不需要重新探测渠道。 */
export function catalogModelsHash(catalog: SharedCatalog | null): string | null {
  if (!catalog?.models?.length) return null
  const ids = [...new Set(catalog.models.map(model => lower(String(model.id || ''))).filter(Boolean))].sort()
  return createHash('sha256').update(ids.join('\n')).digest('hex').slice(0, 32)
}

export function parseRetryAfter(value: string | null | undefined, now: number): number | null {
  if (!value) return null
  const trimmed = value.trim()
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000
  const at = Date.parse(trimmed)
  return Number.isFinite(at) ? Math.max(0, at - now) : null
}

function jittered(ms: number, random: () => number): number {
  const spread = ms * (DISCOVERY_POLICY.jitterPct / 100)
  return Math.round(ms + spread * (random() * 2 - 1))
}

type BackoffTarget = { backoffUntil?: number; backoffLevel?: number }

function applyBackoff(target: BackoffTarget, status: number, retryAfterMs: number | null, now: number): void {
  const level = (target.backoffLevel ?? 0) + 1
  const base = status === 401 || status === 403 ? DISCOVERY_POLICY.authBackoffBaseMs : DISCOVERY_POLICY.backoffBaseMs
  let delay = Math.min(DISCOVERY_POLICY.backoffMaxMs, base * 2 ** (level - 1))
  if (retryAfterMs !== null) delay = Math.max(delay, Math.min(retryAfterMs, DISCOVERY_POLICY.retryAfterCapMs))
  target.backoffLevel = level
  target.backoffUntil = now + delay
}

/* ────────────────────────── 状态文件校验 ────────────────────────── */

const MAX_LEVEL = 32
const plainObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/**
 * 持久化的发现状态来自磁盘（sync-state.json），手改、旧版本或时钟异常都可能让它带上 null 条目、
 * 非数字或离谱的时间。这里原地清洗：坏条目丢弃，时间夹到 [0, now + 最长合法等待]，
 * 「上次请求」不能在未来——否则一个渠道会被冻住，或同步中心状态接口在 toISOString 上抛错。
 */
export function sanitizeDiscoveryState(raw: Record<string, unknown>, now: number): DiscoveryState {
  const ceiling = now + DISCOVERY_POLICY.retryAfterCapMs
  const time = (value: unknown, max: number): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.min(value, max) : undefined
  const level = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isInteger(value) && value >= 0 ? Math.min(value, MAX_LEVEL) : undefined
  const status = (value: unknown): number | null | undefined =>
    value === null ? null : typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < 1000 ? value : undefined
  const text = (value: unknown, max: number): string | undefined => (typeof value === 'string' ? value.slice(0, max) : undefined)
  const assign = (target: Record<string, unknown>, key: string, value: unknown) => { if (value !== undefined) target[key] = value }

  for (const key of ['catalogHash', 'probedCatalogHash'] as const) {
    if (raw[key] !== undefined && (typeof raw[key] !== 'string' || (raw[key] as string).length > 128)) delete raw[key]
  }
  const channels: Record<string, DiscoveryChannelState> = {}
  if (plainObject(raw.channels)) {
    for (const [name, entry] of Object.entries(raw.channels).slice(0, 1000)) {
      if (!plainObject(entry)) continue
      const clean: Record<string, unknown> = {}
      assign(clean, 'lastProbeAt', time(entry.lastProbeAt, now))
      assign(clean, 'nextProbeAt', time(entry.nextProbeAt, ceiling))
      assign(clean, 'workingUrl', text(entry.workingUrl, 2048))
      assign(clean, 'lastStatus', status(entry.lastStatus))
      assign(clean, 'lastError', entry.lastError === null ? null : text(entry.lastError, 200))
      assign(clean, 'discovered', level(entry.discovered) === undefined ? undefined : Math.min(Number(entry.discovered), 100_000))
      assign(clean, 'backoffUntil', time(entry.backoffUntil, ceiling))
      assign(clean, 'backoffLevel', level(entry.backoffLevel))
      assign(clean, 'emptyLevel', level(entry.emptyLevel))
      assign(clean, 'host', text(entry.host, 255))
      channels[name] = clean as DiscoveryChannelState
    }
  }
  const hosts: Record<string, DiscoveryHostState> = {}
  if (plainObject(raw.hosts)) {
    for (const [host, entry] of Object.entries(raw.hosts).slice(0, 1000)) {
      if (!plainObject(entry)) continue
      const clean: Record<string, unknown> = {}
      assign(clean, 'lastRequestAt', time(entry.lastRequestAt, now))
      assign(clean, 'backoffUntil', time(entry.backoffUntil, ceiling))
      assign(clean, 'backoffLevel', level(entry.backoffLevel))
      assign(clean, 'lastStatus', status(entry.lastStatus))
      hosts[host] = clean as DiscoveryHostState
    }
  }
  raw.channels = channels
  raw.hosts = hosts
  return raw as DiscoveryState
}

/* ────────────────────────── 探测 ────────────────────────── */

type ProbeOutcome =
  | { kind: 'ok'; url: string; models: DiscoveredModel[] }
  | { kind: 'empty' }
  | { kind: 'blocked'; status: number; retryAfterMs: number | null }

/** 与建渠道时的扫描（channels.ts discoveryHeaders）同一套鉴权：Anthropic 原生上游不认 Bearer。 */
function probeHeaders(protocol: ChannelProtocol, key: string, custom: Record<string, string>): Record<string, string> {
  return {
    ...custom,
    Accept: 'application/json',
    ...(protocol === 'claude' ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' } : { Authorization: `Bearer ${key}` }),
  }
}

/**
 * 依次试候选地址；路径不对（404/405/400、空列表）才换下一个。
 * 401/403/429/5xx 与网络错误立刻停手——换个路径再打一次只会加重封禁风险。
 */
async function probeChannel(
  urls: string[],
  headers: Record<string, string>,
  deps: Required<Pick<ModelSyncDeps, 'fetch' | 'now' | 'limit'>> & { onRequest: () => void },
): Promise<ProbeOutcome> {
  for (const url of urls) {
    type Reply = { ok: true; models: DiscoveredModel[] } | { ok: false; status: number; retryAfter: string | null }
    let reply: Reply
    try {
      // 名额覆盖整个请求（含读完/丢弃响应体）：响应头到了就放名额，会让在途的上游请求超过 globalUpstreamConcurrency。
      // onRequest 在拿到名额、真正发出前调用：主机间隔按实际发送时刻记，排队等名额的时间不能把间隔「用掉」。
      reply = await deps.limit(async (): Promise<Reply> => {
        deps.onRequest()
        const response = await deps.fetch(url, { headers, signal: AbortSignal.timeout(DISCOVERY_POLICY.timeoutMs) })
        if (response.ok) {
          let models: DiscoveredModel[] = []
          try { models = normalizeDiscoveredModels(await response.json()) } catch { models = [] }
          return { ok: true, models }
        }
        await response.body?.cancel().catch(() => undefined)
        return { ok: false, status: response.status, retryAfter: response.headers.get('retry-after') }
      })
    } catch {
      return { kind: 'blocked', status: 0, retryAfterMs: null }
    }
    if (reply.ok) {
      if (reply.models.length > 0) return { kind: 'ok', url, models: reply.models }
      continue
    }
    if (reply.status === 401 || reply.status === 403 || reply.status === 429 || reply.status >= 500) {
      return { kind: 'blocked', status: reply.status, retryAfterMs: parseRetryAfter(reply.retryAfter, deps.now()) }
    }
  }
  return { kind: 'empty' }
}

function normalizeEndpoint(raw: string): string | null {
  try {
    const parsed = new URL(raw.trim())
    return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, '').replace(/\/v1$/i, '')}`.toLowerCase()
  } catch {
    return null
  }
}

/**
 * 共享目录（catalog.json）来自网关自己的 `/v1/models`。旧实现把它整份灌进「第一个启用渠道」：
 * 那个渠道往往是无关的第三方（实测 openrouter 被灌进 55 个网关别名并顶满 500 上限，
 * 之后它自己真正的新模型每轮都被上限挡掉），请求随之被路由到不提供这些模型的上游——这就是自反馈。
 *
 * 现在只有两种情况会合入（都只加不删，已有条目原样保留）：
 * - `matched`：有渠道就指向产出目录的网关本身 → 只合入它本轮 /models 自己也列出的 id（同一地址、不同 key 看到的模型可能不同）；
 * - `pinned`：`MODEL_SYNC_CATALOG_TARGET=<渠道名>` 显式指定；`off` 关闭合入。
 * 两者都不满足时是 `none`：不合入任何渠道。目录里只有网关才有的模型本来就不能由别的渠道提供，
 * 挂上去只会制造必然失败的路由，并占掉那个渠道自己的模型名额。
 */
export function resolveCatalogTarget(channels: SyncChannel[], catalog: SharedCatalog, override = ''): { mode: CatalogMergeMode; target: SyncChannel | null } {
  const enabled = channels.filter(channel => !channel.disabled)
  const pinned = override.trim()
  if (pinned.toLowerCase() === 'off') return { mode: 'off', target: null }
  if (pinned) {
    const target = enabled.find(channel => channel.name === pinned) ?? null
    return { mode: target ? 'pinned' : 'none', target }
  }
  const source = normalizeEndpoint(String(catalog.baseUrl || ''))
  const matched = source ? enabled.find(channel => normalizeEndpoint(channel.baseUrl) === source) : undefined
  return matched ? { mode: 'matched', target: matched } : { mode: 'none', target: null }
}

function modelKeys(models: Array<{ name: string; alias?: string }>): Set<string> {
  const keys = new Set<string>()
  for (const model of models) {
    if (model.name) keys.add(lower(model.name))
    if (model.alias) keys.add(lower(model.alias))
  }
  return keys
}

function isTombstoned(blocked: BlockedModels | undefined, channel: string, item: { id: string; alias?: string }): boolean {
  const set = blocked?.get(channel)
  if (!set?.size) return false
  return set.has(lower(item.id)) || (item.alias ? set.has(lower(item.alias)) : false)
}

/**
 * 管理员停用模型时，channels.ts 会摘掉映射并写一条 enabled=0 的墓碑（model 列是对外名，snapshot 里是原始条目）。
 * 发现只看当前映射去重的话，下一次成功探测就会把它加回来——墓碑里的 id 和别名都必须挡住。
 */
export function readDisabledModels(): BlockedModels {
  const blocked: BlockedModels = new Map()
  const rows = db.prepare('SELECT channel, model, snapshot_json FROM channel_model_states WHERE enabled=0').all() as Array<{ channel: string; model: string; snapshot_json: string | null }>
  for (const row of rows) {
    const set = blocked.get(String(row.channel)) ?? new Set<string>()
    blocked.set(String(row.channel), set)
    if (row.model) set.add(lower(String(row.model)))
    let snapshot: unknown = null
    try { snapshot = JSON.parse(row.snapshot_json || 'null') } catch { snapshot = null }
    for (const item of Array.isArray(snapshot) ? snapshot : snapshot ? [snapshot] : []) {
      if (!plainObject(item)) continue
      if (typeof item.name === 'string' && item.name) set.add(lower(item.name))
      if (typeof item.alias === 'string' && item.alias) set.add(lower(item.alias))
    }
  }
  return blocked
}

/**
 * 纯函数：把 additions 合进 channels（原地），尊重单渠道上限与停用墓碑；
 * 返回写入的 id、被上限挡掉的数量与 id、写入后启用渠道上的映射条数。
 */
export function applyAdditions<T extends { name?: string; disabled?: boolean; models?: Array<{ name?: string; alias?: string }> }>(
  channels: T[],
  additions: Map<string, DiscoveredModel[]>,
  maxPerChannel = DISCOVERY_POLICY.maxModelsPerChannel,
  blocked?: BlockedModels,
): { added: string[]; capped: number; cappedIds: string[]; total: number } {
  const added: string[] = []
  const cappedIds: string[] = []
  for (const channel of channels) {
    const pending = channel.name ? additions.get(channel.name) : undefined
    if (!pending?.length) continue
    channel.models = channel.models || []
    const keys = modelKeys(channel.models.map(model => ({ name: String(model.name || ''), alias: model.alias })))
    for (const item of pending) {
      if (keys.has(lower(item.id)) || isTombstoned(blocked, String(channel.name), item)) continue
      if (channel.models.length >= maxPerChannel) {
        cappedIds.push(item.id)
        keys.add(lower(item.id))
        continue
      }
      channel.models.push({ name: item.id, alias: item.alias })
      keys.add(lower(item.id))
      if (!added.includes(item.id)) added.push(item.id)
    }
  }
  const total = channels.reduce((sum, channel) => sum + (channel.disabled ? 0 : channel.models?.length ?? 0), 0)
  return { added, capped: cappedIds.length, cappedIds, total }
}

const effectiveProxy = (keyProxy: unknown, channelProxy: unknown): string | null => {
  // key 上的代理 > 渠道代理 > 直连。
  const value = String(keyProxy || channelProxy || '').trim()
  return value && value.toLowerCase() !== 'direct' ? value : null
}

const stringRecord = (value: unknown): Record<string, string> | undefined => {
  if (!plainObject(value)) return undefined
  const entries = Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  return entries.length ? Object.fromEntries(entries) : undefined
}

const CPA_COMMIT_ATTEMPTS = 3

/** 读不到 CPA 全局代理时的占位：出口未知，按「走代理」保守跳过，不直连探测。 */
export const UNKNOWN_PROXY = 'unknown'

/**
 * CPA 控制面的渠道：推理的出口是 key 代理 > 渠道代理 > **CPA 全局代理** > 直连。
 * `globalProxy` 为 null 表示全局代理读取失败：没有显式代理的渠道出口未知，标成 UNKNOWN_PROXY。
 */
export function cpaSyncChannel(channel: CompatChannel, globalProxy: string | null): SyncChannel {
  const entry = channel['api-key-entries']?.[0]
  const own = String(entry?.['proxy-url'] || channel['proxy-url'] || '').trim()
  return {
    name: String(channel.name || ''),
    baseUrl: String(channel['base-url'] || ''),
    disabled: Boolean(channel.disabled),
    keyRef: entry?.['api-key'],
    protocol: 'openai',
    proxy: own ? effectiveProxy(own, '') : globalProxy === null ? UNKNOWN_PROXY : effectiveProxy(globalProxy, ''),
    headers: stringRecord(channel.headers),
    models: (channel.models || []).map(model => ({ name: String(model.name || model.alias || ''), ...(model.alias ? { alias: model.alias } : {}) })),
  }
}

function cpaStore(): ChannelStore {
  return {
    read: async () => {
      const [channels, globalProxy] = await Promise.all([getCompatChannels(), getGlobalProxy({ required: true }).catch(() => null)])
      return channels.map(channel => cpaSyncChannel(channel, globalProxy)).filter(channel => channel.name)
    },
    /**
     * CPA 管理面没有 CAS：读 → 合并 → 写之间别人改了渠道表，整表 PUT 会把那次改动覆盖掉。
     * 所以写入前（在进程内渠道写入队列里）再读一次比对指纹，不一致就在最新表上重算，连续冲突就放弃本轮。
     * 剩余窗口只有「复读 → PUT」这一个往返，且只在确有新增时才写。
     */
    commit: async (additions, guard) => {
      for (let attempt = 0; attempt < CPA_COMMIT_ATTEMPTS; attempt += 1) {
        const channels = await getCompatChannels()
        const expected = compatChannelsFingerprint(channels)
        const result = applyAdditions(channels, additions, Number.POSITIVE_INFINITY, guard?.blocked?.())
        if (!result.added.length) return result
        try {
          await putCompatChannels(channels, { expected })
          return result
        } catch (error) {
          if (!(error instanceof CompatChannelsConflictError)) throw error
        }
      }
      throw new Error('渠道表在写入前反复被修改，本轮未写入（下轮重试）')
    },
  }
}

/** `env:NAME` → that variable (or the file named by NAME_FILE); throws when it is not a reference or not set. */
export function resolveEnvSecret(reference: string, env: NodeJS.ProcessEnv = process.env): string {
  const match = /^env:([A-Z_][A-Z0-9_]*)$/.exec(reference)
  if (!match) throw new Error('Channel credentials resolve only env:NAME references')
  const value = fileBackedSecret(match[1], env[match[1]], env[`${match[1]}_FILE`])
  if (!value || /[\r\n]/.test(value)) throw new Error('Referenced channel credential is unavailable')
  return value
}

function defaultDeps(): Required<ModelSyncDeps> {
  return {
    now: Date.now,
    random: Math.random,
    fetch: (input, init) => globalThis.fetch(input, init),
    resolveCredential: async (reference) => resolveEnvSecret(reference),
    resolveSecret: (reference) => resolveEnvSecret(reference),
    countRequest: () => undefined,
    readCatalog: readSharedCatalog,
    store: cpaStore(),
    disabledModels: readDisabledModels,
    limit: (task) => upstreamLimiter.run(task),
    afterWrite: async () => {
      invalidateGatewaySnapshot()
    },
    catalogTarget: process.env.MODEL_SYNC_CATALOG_TARGET || '',
  }
}

async function channelCredential(keyRef: string | undefined, resolve: (reference: string) => Promise<string>): Promise<string | null> {
  const value = String(keyRef || '').trim()
  if (!value) return null
  if (!value.startsWith('env:') && !value.startsWith('cpa:')) return value
  try {
    const resolved = await resolve(value)
    return resolved && !/[\r\n]/.test(resolved) ? resolved : null
  } catch {
    return null
  }
}

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/

/** 自定义请求头：引用解析不了、名字或值不合法都返回 null（整个渠道跳过，不带残缺的请求头去探测）。 */
function channelHeaders(headers: Record<string, string> | undefined, resolve: (reference: string) => string): Record<string, string> | null {
  const resolved: Record<string, string> = {}
  for (const [name, raw] of Object.entries(headers ?? {})) {
    if (!HEADER_NAME.test(name)) return null
    let value: string
    try {
      value = raw.startsWith('env:') ? resolve(raw) : raw
    } catch {
      return null
    }
    if (!value || /[\r\n]/.test(value) || value.includes('\0')) return null
    resolved[name] = value
  }
  return resolved
}

function summarize(result: Omit<ModelSyncResult, 'summary'>): string {
  const parts = [`${result.totalModels} 模型`]
  if (result.addedModels.length) parts.push(`+${result.addedModels.length}`)
  if (result.capped) parts.push(`上限丢弃 ${result.capped}`)
  if (result.probed) parts.push(`探测 ${result.succeeded}/${result.probed}`)
  if (result.deferred) parts.push(`退避 ${result.deferred}`)
  if (result.missingCredential) parts.push(`缺凭据 ${result.missingCredential}`)
  if (result.proxied) parts.push(`代理 ${result.proxied} 未探测`)
  if (!result.probed && !result.deferred && !result.missingCredential && !result.proxied && !result.addedModels.length) parts.push('无到期渠道')
  return parts.join(' · ')
}

const CAPPED_LIST_MAX = 50

async function runDiscovery(options: { force?: boolean; state?: DiscoveryState; deps?: ModelSyncDeps }): Promise<ModelSyncResult> {
  const deps = { ...defaultDeps(), ...options.deps }
  const startedAt = deps.now()
  const state = sanitizeDiscoveryState((options.state ?? memoryState) as Record<string, unknown>, startedAt)
  state.channels ??= {}
  state.hosts ??= {}
  const force = options.force === true
  const syncedAt = new Date(startedAt).toISOString()
  const errors: string[] = []
  let requests = 0
  const onRequest = () => {
    requests += 1
    deps.countRequest()
  }

  const fail = (message: string, summary: string): ModelSyncResult => ({
    addedModels: [], totalModels: 0, channelCount: 0, source: 'none', syncedAt, result: 'error',
    probed: 0, succeeded: 0, failed: 0, deferred: 0, missingCredential: 0, proxied: 0, capped: 0, cappedModels: [], requests: 0, errors: [message],
    catalog: { mode: 'none', target: null, added: 0, changed: false }, silent: false, summary,
  })

  let channels: SyncChannel[]
  try {
    channels = await deps.store.read()
  } catch (error) {
    return fail(`读取渠道失败：${error instanceof Error ? error.message : '未知错误'}`, '读取渠道失败')
  }
  // 停用墓碑读不到就不写：宁可这轮不加，也不能把管理员停用的模型加回去。
  let blocked: BlockedModels
  try {
    blocked = deps.disabledModels()
  } catch (error) {
    return fail(`读取模型停用记录失败：${error instanceof Error ? error.message : '未知错误'}`, '读取停用记录失败')
  }

  const discoveryUrls = (channel: SyncChannel) => modelDiscoveryUrls(channel.protocol ?? 'openai', channel.baseUrl)
  // 删掉/停用的渠道不再参与「下次到期」与「整体退避」的计算；主机只在仍有渠道用、或还在退避时保留。
  const liveChannels = new Set(channels.filter(item => !item.disabled && item.baseUrl).map(item => item.name))
  for (const name of Object.keys(state.channels)) if (!liveChannels.has(name)) delete state.channels[name]
  const liveHosts = new Set<string>()
  for (const item of channels) {
    if (item.disabled || !item.baseUrl) continue
    try { liveHosts.add(new URL(discoveryUrls(item)[0]).host) } catch { /* 无效地址在下面单独报错 */ }
  }
  for (const [host, hostState] of Object.entries(state.hosts)) {
    if (!liveHosts.has(host) && (hostState.backoffUntil ?? 0) <= startedAt) delete state.hosts[host]
  }

  const catalog = deps.readCatalog()
  const catalogHash = catalogModelsHash(catalog)
  const catalogChanged = Boolean(catalogHash) && catalogHash !== state.catalogHash
  const catalogNewForProbe = Boolean(catalogHash) && catalogHash !== state.probedCatalogHash
  const additions = new Map<string, DiscoveredModel[]>()
  const pending = (name: string) => {
    let list = additions.get(name)
    if (!list) {
      list = []
      additions.set(name, list)
    }
    return list
  }
  const knownKeys = new Map(channels.map(channel => [channel.name, modelKeys(channel.models)]))
  /** 本轮探测成功的渠道 → 它自己报出的模型（小写）。 */
  const listed = new Map<string, Set<string>>()

  let probed = 0
  let succeeded = 0
  let failed = 0
  let deferred = 0
  let missingCredential = 0
  let proxied = 0
  const interval = DISCOVERY_POLICY.channelIntervalMs

  for (const channel of channels) {
    if (channel.disabled || !channel.baseUrl) continue
    const channelState = state.channels[channel.name] ??= {}
    const now = deps.now()
    const due = force || catalogNewForProbe || !channelState.nextProbeAt || now >= channelState.nextProbeAt
    if (!due) continue

    let urls: string[]
    let host: string
    try {
      urls = discoveryUrls(channel)
      host = new URL(urls[0]).host
    } catch {
      errors.push(`${channel.name}: 地址无效`)
      channelState.lastError = 'invalid_base_url'
      channelState.nextProbeAt = now + jittered(interval, deps.random)
      failed += 1
      continue
    }
    channelState.host = host
    // 推理走代理的渠道，控制台直连探测会换一个出口（可能是被上游封禁或地区受限的那个 IP）：不探，如实报告。
    if (channel.proxy) {
      proxied += 1
      channelState.lastError = channel.proxy === UNKNOWN_PROXY ? 'proxy_unknown' : 'proxy_not_supported'
      channelState.lastStatus = null
      channelState.nextProbeAt = now + jittered(interval, deps.random)
      continue
    }
    const hostState = state.hosts[host] ??= {}
    const blockedUntil = Math.max(hostState.backoffUntil ?? 0, channelState.backoffUntil ?? 0)
    if (blockedUntil > now) {
      deferred += 1
      channelState.nextProbeAt = Math.max(channelState.nextProbeAt ?? 0, blockedUntil)
      continue
    }
    if (hostState.lastRequestAt && now - hostState.lastRequestAt < DISCOVERY_POLICY.hostMinIntervalMs) {
      deferred += 1
      channelState.nextProbeAt = hostState.lastRequestAt + DISCOVERY_POLICY.hostMinIntervalMs
      continue
    }

    const key = await channelCredential(channel.keyRef, deps.resolveCredential)
    const headers = key ? channelHeaders(channel.headers, deps.resolveSecret) : null
    if (!key || !headers) {
      missingCredential += 1
      errors.push(`${channel.name}: ${key ? '自定义请求头不可用' : '凭据不可用'}，未探测`)
      channelState.lastError = key ? 'header_unavailable' : 'credential_unavailable'
      channelState.lastStatus = null
      channelState.nextProbeAt = now + jittered(interval, deps.random)
      continue
    }

    const ordered = channelState.workingUrl && urls.includes(channelState.workingUrl)
      ? [channelState.workingUrl, ...urls.filter(url => url !== channelState.workingUrl)]
      : urls
    probed += 1
    const send = () => {
      hostState.lastRequestAt = deps.now()
      onRequest()
    }
    const outcome = await probeChannel(ordered, probeHeaders(channel.protocol ?? 'openai', key, headers), { fetch: deps.fetch, now: deps.now, limit: deps.limit, onRequest: send })
    const finishedAt = deps.now()
    channelState.lastProbeAt = finishedAt
    channelState.nextProbeAt = finishedAt + jittered(interval, deps.random)

    if (outcome.kind === 'ok') {
      succeeded += 1
      channelState.workingUrl = outcome.url
      channelState.lastStatus = 200
      channelState.lastError = null
      channelState.discovered = outcome.models.length
      channelState.backoffLevel = 0
      channelState.backoffUntil = 0
      channelState.emptyLevel = 0
      hostState.backoffLevel = 0
      hostState.backoffUntil = 0
      hostState.lastStatus = 200
      const keys = knownKeys.get(channel.name) ?? new Set<string>()
      const own = new Set<string>()
      for (const item of outcome.models) {
        own.add(lower(item.id))
        own.add(lower(item.alias))
        if (keys.has(lower(item.id)) || isTombstoned(blocked, channel.name, item)) continue
        keys.add(lower(item.id))
        pending(channel.name).push(item)
      }
      knownKeys.set(channel.name, keys)
      listed.set(channel.name, own)
    } else if (outcome.kind === 'empty') {
      failed += 1
      channelState.lastStatus = null
      channelState.lastError = 'no_models'
      // 一直不给模型列表的渠道（没有 /models、或总是空表）不该永远每 30 分钟打两次：逐次翻倍到 24h。
      channelState.emptyLevel = Math.min(MAX_LEVEL, (channelState.emptyLevel ?? 0) + 1)
      const stretched = Math.min(DISCOVERY_POLICY.emptyMaxIntervalMs, interval * 2 ** (channelState.emptyLevel - 1))
      channelState.nextProbeAt = finishedAt + jittered(stretched, deps.random)
      errors.push(`${channel.name}: 未返回模型列表`)
    } else if (outcome.status === 401 || outcome.status === 403) {
      failed += 1
      applyBackoff(channelState, outcome.status, outcome.retryAfterMs, finishedAt)
      channelState.lastStatus = outcome.status
      channelState.lastError = `http_${outcome.status}`
      channelState.nextProbeAt = Math.max(channelState.nextProbeAt, channelState.backoffUntil ?? 0)
      errors.push(`${channel.name}: HTTP ${outcome.status}，渠道退避`)
    } else {
      failed += 1
      applyBackoff(hostState, outcome.status, outcome.retryAfterMs, finishedAt)
      hostState.lastStatus = outcome.status || null
      channelState.lastStatus = outcome.status || null
      channelState.lastError = outcome.status ? `http_${outcome.status}` : 'network'
      channelState.nextProbeAt = Math.max(channelState.nextProbeAt, hostState.backoffUntil ?? 0)
      errors.push(`${channel.name}: ${outcome.status ? `HTTP ${outcome.status}` : '网络错误'}，主机退避`)
    }
  }

  if (catalogHash) state.probedCatalogHash = catalogHash

  // 目录合入放在探测之后：本轮刚被渠道自己报出来的模型优先归属那个渠道。
  let catalogMode: CatalogMergeMode = 'none'
  let catalogTarget: SyncChannel | null = null
  const catalogIds = new Set<string>()
  if (catalog && catalog.models.length && (catalogChanged || force)) {
    const resolved = resolveCatalogTarget(channels, catalog, deps.catalogTarget)
    catalogMode = resolved.mode
    catalogTarget = resolved.target
    // 目标渠道本轮自己报过模型表：它没列出的 id 它就不提供，不能靠目录挂上去占名额。
    const own = catalogTarget ? listed.get(catalogTarget.name) : undefined
    // matched 只说明地址相同，不说明这把 key 看得到同样的模型（网关可按 key 限制模型）：本轮没探测成功就不合入，
    // 等它下次探测成功时由探测本身补齐。pinned 是管理员显式指定，照常合入。
    const verified = catalogMode === 'pinned' || Boolean(own)
    if (catalogTarget && (catalogMode === 'matched' || catalogMode === 'pinned') && verified) {
      const targetKeys = knownKeys.get(catalogTarget.name) ?? new Set<string>()
      for (const model of catalog.models) {
        const id = String(model.id || '').trim()
        if (!id || targetKeys.has(lower(id))) continue
        const item = { id, alias: defaultModelAlias(id) }
        if ((own && !own.has(lower(id))) || isTombstoned(blocked, catalogTarget.name, item)) continue
        targetKeys.add(lower(id))
        pending(catalogTarget.name).push(item)
        catalogIds.add(id)
      }
      knownKeys.set(catalogTarget.name, targetKeys)
    }
  }

  let added: string[] = []
  let cappedIds: string[] = []
  let capped = 0
  let committedTotal: number | null = null
  let commitFailed = false
  if ([...additions.values()].some(list => list.length)) {
    try {
      const committed = await deps.store.commit(additions, { blocked: deps.disabledModels })
      added = committed.added
      cappedIds = committed.cappedIds ?? []
      capped = Math.max(committed.capped, cappedIds.length)
      // 只加不删、绝不自动腾位置：被上限挡掉的模型如实报出来（partial），由管理员决定清哪些旧映射。
      if (capped) {
        const preview = cappedIds.slice(0, 10).join(', ')
        errors.push(`${capped} 个模型因单渠道上限（${DISCOVERY_POLICY.maxModelsPerChannel}）未写入、不可路由${preview ? `：${preview}${capped > 10 ? ' …' : ''}` : ''}`)
      }
      if (typeof committed.total === 'number') committedTotal = committed.total
      if (added.length) await deps.afterWrite()
    } catch (error) {
      commitFailed = true
      capped = 0
      cappedIds = []
      errors.push(`写入渠道失败：${error instanceof Error ? error.message : '未知错误'}`)
    }
  }
  // 写失败时不推进目录哈希：下一轮会重新尝试合入。
  if (!commitFailed && catalogHash) state.catalogHash = catalogHash

  const catalogAdded = added.filter(id => catalogIds.has(id)).length
  const totalModels = committedTotal ?? channels.reduce((sum, channel) => sum + (channel.disabled ? 0 : channel.models.length), 0)
  const silent = !force && !catalogChanged && probed === 0 && failed === 0 && missingCredential === 0 && proxied === 0 && added.length === 0
  const degraded = failed > 0 || missingCredential > 0 || capped > 0
  const result: ModelSyncOutcome = commitFailed ? 'error'
    : !degraded ? (probed > 0 || added.length > 0 ? 'ok' : 'skipped')
      : succeeded > 0 || added.length > 0 || (failed === 0 && missingCredential === 0) ? 'partial' : 'error'

  const base: Omit<ModelSyncResult, 'summary'> = {
    addedModels: added,
    totalModels,
    channelCount: channels.length,
    source: catalog ? (catalogAdded > 0 ? 'merged' : 'shared-catalog') : 'channel-probe',
    syncedAt,
    result,
    probed,
    succeeded,
    failed,
    deferred,
    missingCredential,
    proxied,
    capped,
    cappedModels: cappedIds.slice(0, CAPPED_LIST_MAX),
    requests,
    errors,
    catalog: { mode: catalogMode, target: catalogTarget?.name ?? null, added: catalogAdded, changed: catalogChanged },
    silent,
  }
  if (added.length) {
    console.log(JSON.stringify({ event: 'upstream_models_auto_synced', addedCount: added.length, models: added.slice(0, 50), total: totalModels }))
  }
  return { ...base, summary: summarize(base) }
}

const memoryState: DiscoveryState = {}
let inflight: Promise<ModelSyncResult> | null = null

/**
 * 动态发现上游模型（单飞：定时器、目录监听、手动按钮同时触发时共用一次运行）：
 * 1. 到期的渠道用**解析出来的真实凭据**、按渠道协议探测 base-url 的 /models（解析不了就跳过，绝不匿名打；走代理的不直连）；
 * 2. 共享目录（~/.agents/crosery/catalog.json）只在内容变化或手动触发时合入，目标见 resolveCatalogTarget；
 * 3. 新模型只加不删，跳过管理员停用过的，在写入前重新读取的渠道表上落盘，然后通知内核刷新 provider。
 */
export function syncUpstreamModels(options: { force?: boolean; state?: DiscoveryState; deps?: ModelSyncDeps } = {}): Promise<ModelSyncResult> {
  if (inflight) return inflight
  inflight = runDiscovery(options).finally(() => { inflight = null })
  return inflight
}

const stateEntries = <T>(record: unknown): T[] =>
  plainObject(record) ? Object.values(record).filter((entry): entry is T => plainObject(entry)) : []

/** 同步中心展示用：最早一个渠道真正到期的时间。 */
export function nextDiscoveryAt(state: DiscoveryState, now: number): number | null {
  const times = stateEntries<DiscoveryChannelState>(state.channels).map(channel => channel.nextProbeAt)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
  if (!times.length) return null
  return Math.min(Math.max(now, Math.min(...times)), now + DISCOVERY_POLICY.retryAfterCapMs)
}

/**
 * 同步中心展示用：所有被探测过的渠道都被挡住（自己的鉴权退避或所在主机的退避）时，任务整体视为退避。
 */
export function discoveryBackoff(state: DiscoveryState, now: number): { backoffUntil: number; backoffLevel: number } | null {
  const hosts = plainObject(state.hosts) ? state.hosts as Record<string, DiscoveryHostState> : {}
  const channels = stateEntries<DiscoveryChannelState>(state.channels).filter(channel => channel.lastProbeAt)
  const blocks = channels.length
    ? channels.map((channel) => {
      const host = channel.host && plainObject(hosts[channel.host]) ? hosts[channel.host] : {}
      const hostUntil = host.backoffUntil ?? 0
      const ownUntil = channel.backoffUntil ?? 0
      return { until: Math.max(hostUntil, ownUntil), level: hostUntil >= ownUntil ? host.backoffLevel ?? 0 : channel.backoffLevel ?? 0 }
    })
    // 旧状态文件没有渠道 → 主机映射时退回按主机判断。
    : stateEntries<DiscoveryHostState>(hosts).filter(host => host.lastRequestAt).map(host => ({ until: host.backoffUntil ?? 0, level: host.backoffLevel ?? 0 }))
  if (!blocks.length || blocks.some(block => block.until <= now)) return null
  return {
    backoffUntil: Math.min(...blocks.map(block => block.until)),
    backoffLevel: Math.max(...blocks.map(block => block.level)),
  }
}

let watcher: fs.FSWatcher | null = null
let watcherDebounce: NodeJS.Timeout | null = null

/**
 * 监听共享目录所在**目录**：sync.mjs 用「临时文件 + rename」替换 catalog.json，
 * 绑在旧 inode 上的文件级 watch 第一次替换后就收不到事件了。
 * 节拍由同步中心负责，这里只负责「变了就尽快触发一次」（触发方自带单飞与节奏控制）。
 */
export function startModelCatalogWatcher(onChange: () => void = () => { void syncUpstreamModels().catch(() => undefined) }, file = sharedCatalogPath()): boolean {
  if (watcher) return true
  const directory = path.dirname(file)
  const base = path.basename(file)
  try {
    if (!fs.existsSync(directory)) return false
    watcher = fs.watch(directory, (_event, filename) => {
      if (filename && String(filename) !== base) return
      if (watcherDebounce) clearTimeout(watcherDebounce)
      watcherDebounce = setTimeout(() => {
        watcherDebounce = null
        onChange()
      }, 2_000)
      watcherDebounce.unref?.()
    })
    watcher.unref?.()
    watcher.on('error', () => stopModelCatalogWatcher())
    return true
  } catch {
    watcher = null
    return false
  }
}

export function stopModelCatalogWatcher(): void {
  if (watcherDebounce) clearTimeout(watcherDebounce)
  watcherDebounce = null
  watcher?.close()
  watcher = null
}
