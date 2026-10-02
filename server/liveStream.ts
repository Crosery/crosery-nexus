import type { Response } from 'express'
import { canonicalModelId } from './modelIdentity.js'
import { costForTokens, hitRate, isOverCacheCeiling, normalizeTokens } from './cacheStats.js'

/**
 * 实时用量推送。
 *
 * CPA 的 /v0/management/usage-queue 是消费型队列——取走即消失，所以前端不能直接读它，
 * 必须由同步循环落库后再广播。端到端延迟 = 同步轮询间隔 + 广播开销，做不到毫秒级，
 * 但把轮询间隔压到 1s 后可以稳定在 1-2 秒内。
 */
export type LiveUsageEvent = {
  requestId: string
  timestamp: string
  model: string
  endpoint: string
  keyName: string | null
  /** api_keys.key_hash；未关联 Key 的请求为 null。前端按 Key 筛选实时流时用它比对。 */
  keyHash: string | null
  source: string
  provider: string
  modelGroup?: string
  statusCode: number
  ttftMs: number
  /** 调用方分类（pi / claude-code / codex-cli …）与原始 UA */
  clientType: string
  userAgent: string
  success: boolean
  latencyMs: number
  /** CPA 原始 token 字段，便于点击详情时还原真实输入/输出。 */
  inputTokens: number
  cachedTokens: number
  reasoningTokens: number
  totalTokens: number
  /** 归一化后的四段 token，两家口径已统一 */
  freshInputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  outputTokens: number
  promptTokens: number
  /** 该次请求自己的命中率，未定价或空提示时为 null */
  hitRate: number | null
  /** 该次请求实际花费的美元，未定价模型为 null */
  costUsd: number | null
  overCeiling: boolean
  /**
   * The provider is no longer a current channel (set by the sync loop when it broadcasts). History replays all
   * channels by default, so the stream does too; a client that asked for `currentOnly` never receives these.
   */
  removed?: boolean
}

export type RawUsageInput = {
  requestId: string
  timestamp: string
  model: string
  endpoint: string
  keyName: string | null
  keyHash?: string | null
  source: string
  clientType?: string
  userAgent?: string
  statusCode?: number
  ttftMs?: number
  reasoningTokens?: number
  totalTokens?: number
  success: boolean
  latencyMs: number
  inputTokens: number
  outputTokens: number
  cachedTokens: number
  cacheWriteTokens?: number
  provider?: string
  modelGroup?: string
}

/** 把一条落库记录转成推送事件，命中率与成本复用统一的归一化口径。 */
export function toLiveEvent(raw: RawUsageInput): LiveUsageEvent {
  const tokens = normalizeTokens({
    model: raw.model,
    inputTokens: raw.inputTokens,
    outputTokens: raw.outputTokens,
    cachedTokens: raw.cachedTokens,
    cacheWriteTokens: raw.cacheWriteTokens,
    provider: raw.provider,
    modelGroup: raw.modelGroup,
  })
  return {
    requestId: raw.requestId,
    timestamp: raw.timestamp,
    model: canonicalModelId(raw.model),
    endpoint: raw.endpoint,
    keyName: raw.keyName,
    keyHash: raw.keyHash ?? null,
    source: raw.source,
    provider: raw.provider || '',
    modelGroup: raw.modelGroup,
    statusCode: raw.statusCode ?? (raw.success ? 200 : 500),
    ttftMs: raw.ttftMs ?? 0,
    clientType: raw.clientType || '',
    userAgent: raw.userAgent || '',
    success: raw.success,
    latencyMs: raw.latencyMs,
    inputTokens: raw.inputTokens,
    cachedTokens: raw.cachedTokens,
    reasoningTokens: raw.reasoningTokens || 0,
    totalTokens: raw.totalTokens ?? raw.inputTokens + raw.outputTokens,
    freshInputTokens: tokens.freshInputTokens,
    cacheReadTokens: tokens.cacheReadTokens,
    cacheWriteTokens: tokens.cacheWriteTokens,
    outputTokens: tokens.outputTokens,
    promptTokens: tokens.promptTokens,
    hitRate: hitRate(tokens),
    costUsd: costForTokens(raw.model, tokens, raw.timestamp),
    overCeiling: isOverCacheCeiling(tokens),
  }
}

/**
 * CPA 不同版本对兼容渠道的 provider 写法不同（`mox-aigw` / `openai-compatible-mox-aigw`），
 * 筛选与 SQL 白名单都要把两种写法视为同一渠道。
 */
export function providerAliases(provider: string): string[] {
  const id = String(provider || '').trim().toLowerCase()
  if (!id) return []
  const prefix = 'openai-compatible-'
  return id.startsWith(prefix) ? [id, id.slice(prefix.length)] : [id, `${prefix}${id}`]
}

/** 空筛选匹配全部；否则按渠道别名做大小写无关比较。 */
export function providerMatches(filter: string, provider: string): boolean {
  const aliases = providerAliases(filter)
  if (!aliases.length) return true
  return aliases.includes(String(provider || '').trim().toLowerCase())
}

/** 每个客户端各自持有筛选条件：不同标签页可以看不同模型 / Key / 渠道。 */
type Client = {
  id: number
  res: Response
  model: string
  clientType: string
  keyHash: string
  provider: string
  /** 只看当前渠道：已移除渠道的事件不推给它（与首帧回放的 currentOnly 同一口径） */
  currentOnly: boolean
  /** Non-null until the async history replay is ready. */
  buffered: LiveUsageEvent[] | null
}

const hasFilter = (client: Client) => Boolean(client.model || client.clientType || client.keyHash || client.provider || client.currentOnly)

const matchesClient = (client: Client, event: LiveUsageEvent) =>
  (!client.model || event.model === client.model)
  && (!client.clientType || event.clientType === client.clientType)
  && (!client.keyHash || event.keyHash === client.keyHash)
  && (!client.currentOnly || !event.removed)
  && providerMatches(client.provider, event.provider)

const clients = new Set<Client>()
let nextClientId = 1

/**
 * SSE 并发上限（task-76）。红队的句柄泄漏审计里，9 个长期结构有 8 个已有上界，
 * **只有这个 `clients` 集合是无界的**（只受 OS 句柄限制）：一个卡住的客户端、或一个反复连而
 * 不断开的脚本就能把句柄吃光。soak 实测没有泄漏（FD 平直），但**没有上限保护**。
 *
 * 默认 16 的理由：这是**单管理员**控制台，正常情况只有 1–2 个页面在订阅
 * （每个标签页一条 `/api/cache-live`）；16 给了 ~8–16 倍余量覆盖多标签/多设备/重连窗口，
 * 同时把"卡住的客户端把句柄吃光"封在 16 条以内。可用 `SSE_MAX_CLIENTS` 覆盖。
 */
const DEFAULT_MAX_CLIENTS = 16

export function sseClientLimit(): number {
  const raw = Number(process.env.SSE_MAX_CLIENTS)
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_MAX_CLIENTS
}

/** 还有余量吗（路由在写 SSE 头之前必须先问这个，满了就回 503 而不是静默丢弃）。 */
export function hasClientCapacity(limit = sseClientLimit()): boolean {
  return clients.size < limit
}

/** 已连接的 SSE 客户端数，供健康检查与测试断言使用。 */
export function clientCount(): number {
  return clients.size
}

/**
 * 注册客户端。**已达上限返回 null**（调用方必须回 503 + Retry-After；
 * 不要在这里静默丢弃，否则客户端以为连上了却收不到任何事件）。
 */
function registerClient(res: Response, model: string, clientType: string, keyHash: string, provider: string, buffered: boolean, currentOnly = false): Client | null {
  if (!hasClientCapacity()) return null
  const client: Client = { id: nextClientId++, res, model, clientType, keyHash, provider, currentOnly, buffered: buffered ? [] : null }
  clients.add(client)
  return client
}

export function addClient(res: Response, model = '', clientType = '', keyHash = '', provider = '', currentOnly = false): (() => void) | null {
  const client = registerClient(res, model, clientType, keyHash, provider, false, currentOnly)
  if (!client) return null
  // 释放计数：**必须**在断开（含异常断开）时调用；只加不减会变成另一个泄漏
  return () => { clients.delete(client) }
}

/**
 * Subscribes before the worker-backed history query starts. Broadcasts that
 * arrive while the query is pending are retained in memory, then merged with
 * the history by request id so the history/live hand-off has no event gap.
 */
export function addBufferedClient(res: Response, model = '', clientType = '', keyHash = '', provider = '', currentOnly = false) {
  const client = registerClient(res, model, clientType, keyHash, provider, true, currentOnly)
  if (!client) return null
  return {
    activate(history: LiveUsageEvent[]): LiveUsageEvent[] {
      const pending = client.buffered ?? []
      client.buffered = null
      const seen = new Set(history.map((event) => event.requestId).filter(Boolean))
      const merged = [...history]
      for (const event of pending) {
        if (event.requestId && seen.has(event.requestId)) continue
        if (event.requestId) seen.add(event.requestId)
        merged.push(event)
      }
      return merged.slice(-200)
    },
    remove() { clients.delete(client) },
  }
}

/**
 * 广播一批事件。单个客户端写失败（连接已断但 close 事件尚未触发）不能影响其余客户端，
 * 因此失败即摘除该客户端而不是抛出。
 */
export function broadcast(events: LiveUsageEvent[]): number {
  // 缓存命中率只统计请求成功后的真实 token 结果；失败请求没有可比较的缓存命中。
  const successful = events.filter((event) => event.success)
  if (!successful.length || !clients.size) return 0
  // 按客户端的筛选条件各自裁剪，未筛选的客户端复用同一份序列化结果
  const allFrame = `event: usage\ndata: ${JSON.stringify(successful)}\n\n`
  let delivered = 0
  for (const client of [...clients]) {
    const filtered = hasFilter(client)
    const matched = filtered ? successful.filter((e) => matchesClient(client, e)) : successful
    if (!matched.length) continue
    if (client.buffered) {
      client.buffered.push(...matched)
      if (client.buffered.length > 200) client.buffered.splice(0, client.buffered.length - 200)
      delivered++
      continue
    }
    const frame = filtered
      ? `event: usage\ndata: ${JSON.stringify(matched)}\n\n`
      : allFrame
    try {
      client.res.write(frame)
      delivered++
    } catch {
      clients.delete(client)
    }
  }
  return delivered
}

/** 心跳注释帧，防止反向代理在空闲时切断长连接。nginx 默认 60s，这里取 25s。 */
export function heartbeat(): void {
  for (const client of [...clients]) {
    try {
      client.res.write(': ping\n\n')
    } catch {
      clients.delete(client)
    }
  }
}

/** 仅供测试重置全局状态。 */
export function resetClients(): void {
  clients.clear()
}
