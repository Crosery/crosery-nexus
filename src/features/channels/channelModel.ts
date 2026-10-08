/**
 * /channels page model (DESIGN §6.4): the pure rules the page renders — health classification, plain-word
 * error and discovery lines, model counts, host shortening. No Vue, no fetch: unit-tested in
 * server/channelHealth.test.ts next to the endpoint that feeds it.
 */
import { NONE, fmtInt, fmtPct, fmtTime } from '../../ui/fmt.js'

/**
 * Same union as `ui/types` StatusKind (structural, so StatusMark accepts it). Declared here because the server test
 * program (NodeNext resolution) type-checks this file and must not pull `ui/types.ts` in.
 */
export type StatusKind = 'run' | 'busy' | 'pause' | 'idle' | 'off' | 'cool' | 'warn' | 'bad' | 'stale'

/* ── payload of GET /api/channel-health (server/channelHealth.ts, CONTRACTS «Change (channels)») ── */

export type ChannelDiscoveryView = {
  lastProbeAt: string | null
  nextProbeAt: string | null
  lastStatus: number | null
  lastError: string | null
  discovered: number | null
  hostBackoffUntil: string | null
}

export type ChannelHealthItem = {
  name: string
  enabled: boolean
  requests: number
  errors: number
  clientCancelled: number
  successRate: number | null
  p95Ms: number | null
  recent: { requests: number; errors: number; clientCancelled: number }
  slots: Array<{ n: number; bad: number }>
  lastRequestAt: string | null
  lastError: { at: string; status: number | null; category: string | null; detail: string | null } | null
  discovery: ChannelDiscoveryView | null
}

export type ChannelHealthPayload = {
  hours: number
  from: string
  to: string
  slotMs: number
  recentMs: number
  channels: ChannelHealthItem[]
  /** every request in the window, subscription accounts included; absent on a server that predates it */
  gateway?: { requests: number; errors: number }
  generatedAt: string
}

/** The fields of `/api/channels` rows this page reads (src/types.ts ChannelItem). */
export type ChannelLike = {
  name: string
  baseUrl: string
  keyCount: number
  enabled: boolean
  stale: boolean
  models: Array<{ id: string; enabled: boolean; upstreams: number }>
}

/* ── windows ── */

export const WINDOWS = [
  { value: '3', label: '3h' },
  { value: '24', label: '24h' },
  { value: '168', label: '7d' },
] as const
export const DEFAULT_WINDOW = '24'

export function windowLabel(hours: number | string): string {
  return WINDOWS.find((w) => w.value === String(hours))?.label ?? `${hours}h`
}

/* ── thresholds (one place; the head tooltip quotes them) ── */

export const HEALTH_RULES = {
  /** fewer requests than this in the window never flips a channel to 降级/异常 on rate alone */
  minRequests: 10,
  /** upstream failure share (client cancellations excluded) */
  warnRate: 0.05,
  badRate: 0.2,
  /** upstream failures in the last hour */
  warnRecent: 3,
} as const

export type ChannelHealthClass = {
  /** filter bucket */
  bucket: 'run' | 'warn' | 'off'
  state: StatusKind
  label: string
  /** one short plain-word reason, or null when there is nothing to say */
  reason: string | null
}

const upstreamErrors = (h: Pick<ChannelHealthItem, 'errors' | 'clientCancelled'>) => Math.max(0, h.errors - h.clientCancelled)

/** HTTP status / error category → plain words (DESIGN §6.0: what happened, not the code). */
const CATEGORY_WORDS: Record<string, string> = {
  rate_limited: '上游限流',
  quota_exhausted: '上游额度用尽',
  auth_failed: '上游鉴权失败',
  upstream_5xx: '上游服务出错',
  upstream_eof: '上游连接中断',
  client_cancelled: '客户端取消',
  context_too_large: '上下文超长',
  wrong_endpoint: '接口不匹配',
  other: '其他错误',
}

export function errorWords(category: string | null | undefined, status: number | null | undefined): string {
  if (category && CATEGORY_WORDS[category]) return CATEGORY_WORDS[category]
  if (status === 429) return CATEGORY_WORDS.rate_limited
  if (status === 401 || status === 403) return CATEGORY_WORDS.auth_failed
  if (status === 402) return CATEGORY_WORDS.quota_exhausted
  if (typeof status === 'number' && status >= 500) return CATEGORY_WORDS.upstream_5xx
  return '请求失败'
}

/** Discovery probe outcome codes written by modelSync (`DiscoveryChannelState.lastError`). */
export function discoveryErrorWords(code: string | null | undefined): string | null {
  if (!code) return null
  if (code === 'credential_unavailable') return '凭据不可用 · 未探测'
  if (code === 'invalid_base_url') return '地址无效'
  if (code === 'no_models') return '上游未返回模型'
  if (code === 'network') return '网络不通'
  const http = /^http_(\d{3})$/.exec(code)
  if (http) {
    const status = Number(http[1])
    if (status === 401 || status === 403) return `${status} · 上游 Key 可能失效`
    if (status === 429) return '429 · 上游限流'
    return `HTTP ${status}`
  }
  return code
}

const isAuthDiscovery = (code: string | null | undefined) => code === 'http_401' || code === 'http_403'

export function classifyChannel(channel: ChannelLike, health: ChannelHealthItem | null | undefined, now = Date.now()): ChannelHealthClass {
  if (channel.stale) return { bucket: 'warn', state: 'warn', label: '残留', reason: '网关里已不存在 · 可清理' }
  if (!channel.enabled) return { bucket: 'off', state: 'off', label: '停用', reason: '不参与路由' }
  const enabledModels = channel.models.filter((m) => m.enabled).length
  if (!enabledModels) return { bucket: 'warn', state: 'warn', label: '降级', reason: '没有开着的模型' }
  if (!health) return { bucket: 'run', state: 'run', label: '启用', reason: null }

  const failed = upstreamErrors(health)
  const rate = health.requests > 0 ? failed / health.requests : 0
  const recentFailed = upstreamErrors(health.recent)
  const top = health.lastError ? errorWords(health.lastError.category, health.lastError.status) : null
  const enough = health.requests >= HEALTH_RULES.minRequests

  if (isAuthDiscovery(health.discovery?.lastError)) {
    return { bucket: 'warn', state: 'bad', label: '异常', reason: `模型发现 ${discoveryErrorWords(health.discovery?.lastError)}` }
  }
  if (enough && rate >= HEALTH_RULES.badRate) {
    return { bucket: 'warn', state: 'bad', label: '异常', reason: `失败 ${fmtPct(rate, 0)}${top ? ` · ${top}` : ''}` }
  }
  if (enough && rate >= HEALTH_RULES.warnRate) {
    return { bucket: 'warn', state: 'warn', label: '降级', reason: `失败 ${fmtPct(rate, 1)}${top ? ` · ${top}` : ''}` }
  }
  if (recentFailed >= HEALTH_RULES.warnRecent) {
    return { bucket: 'warn', state: 'warn', label: '降级', reason: `近 1h 失败 ${fmtInt(recentFailed)}${top ? ` · ${top}` : ''}` }
  }
  const backoff = health.discovery?.hostBackoffUntil
  if (backoff && Date.parse(backoff) > now) {
    return { bucket: 'warn', state: 'warn', label: '降级', reason: `发现退避至 ${fmtTime(backoff, now)}` }
  }
  return { bucket: 'run', state: 'run', label: '启用', reason: null }
}

/* ── discovery cell ── */

export type DiscoveryCell = { main: string; sub: string; hot: boolean }

/**
 * `07:23 · 上游 464` / `下次 07:51`. Disabled channels are never probed (modelSync skips them), and a channel the
 * job has not reached yet says so instead of showing a blank.
 */
export function discoveryCell(channel: ChannelLike, d: ChannelDiscoveryView | null | undefined, now = Date.now()): DiscoveryCell {
  if (!channel.enabled) return { main: NONE, sub: '停用 · 不探测', hot: false }
  if (!d) return { main: NONE, sub: '等待首次探测', hot: false }
  const error = discoveryErrorWords(d.lastError)
  const main = d.lastProbeAt
    ? `${fmtTime(d.lastProbeAt, now)}${error ? '' : d.discovered !== null ? ` · 上游 ${fmtInt(d.discovered)}` : ''}`
    : '未探测'
  let sub: string
  if (d.hostBackoffUntil && Date.parse(d.hostBackoffUntil) > now) sub = `退避至 ${fmtTime(d.hostBackoffUntil, now)}`
  else if (error) sub = error
  else if (d.nextProbeAt) sub = Date.parse(d.nextProbeAt) <= now ? '下次 · 已到期' : `下次 ${fmtTime(d.nextProbeAt, now)}`
  else sub = NONE
  return { main, sub, hot: Boolean(error) && isAuthDiscovery(d.lastError) }
}

/* ── last error cell ── */

export type ErrorCell = { main: string; sub: string; hot: boolean } | null

/** Newest failure: time + status, then the plain words. Hot (signal-ink) only when recent and upstream-caused. */
export function lastErrorCell(health: ChannelHealthItem | null | undefined, now = Date.now(), hotWithinMs = 60 * 60_000): ErrorCell {
  const e = health?.lastError
  if (!e) return null
  const words = errorWords(e.category, e.status)
  const at = Date.parse(e.at)
  const upstream = e.category !== 'client_cancelled'
  return {
    main: `${fmtTime(e.at, now)}${e.status ? ` · ${e.status}` : ''}`,
    sub: words,
    hot: upstream && Number.isFinite(at) && now - at <= hotWithinMs,
  }
}

/* ── counts ── */

export type ChannelCounts = {
  total: number
  enabled: number
  warn: number
  off: number
  stale: number
  /** distinct model ids that are on in an enabled channel — what the gateway can route through channels */
  routable: number
  /** every channel → model mapping, on or off */
  mappings: number
}

export function countChannels(channels: readonly ChannelLike[], classes: ReadonlyMap<string, ChannelHealthClass>): ChannelCounts {
  const routable = new Set<string>()
  let mappings = 0
  let enabled = 0
  let warn = 0
  let off = 0
  let stale = 0
  for (const channel of channels) {
    mappings += channel.models.length
    if (channel.stale) stale += 1
    if (channel.enabled) {
      enabled += 1
      for (const model of channel.models) if (model.enabled) routable.add(model.id.toLowerCase())
    }
    const bucket = classes.get(channel.name)?.bucket
    if (bucket === 'warn') warn += 1
    if (bucket === 'off') off += 1
  }
  return { total: channels.length, enabled, warn, off, stale, routable: routable.size, mappings }
}

/** Models a person switched off stay off: the discovery job only adds, it never re-enables. */
export function modelCounts(channel: ChannelLike) {
  const on = channel.models.filter((m) => m.enabled).length
  return { on, total: channel.models.length, off: channel.models.length - on }
}

/* ── text helpers ── */

export function hostOf(baseUrl: string): string {
  try {
    const url = new URL(baseUrl)
    const path = url.pathname.replace(/\/+$/, '')
    return `${url.host}${path && path !== '/' ? path : ''}`
  } catch {
    return baseUrl || NONE
  }
}

/** Shorten in the middle so both the registrable domain and the path tail stay readable. */
export function middleEllipsis(text: string, max = 36): string {
  if (text.length <= max) return text
  const keep = max - 1
  const head = Math.ceil(keep / 2)
  return `${text.slice(0, head)}…${text.slice(text.length - (keep - head))}`
}

/**
 * Pool the server's 36 slots into `count` buckets (phones show 18 ticks). A bucket is active when any of its slots
 * saw traffic and bad when any saw an upstream failure.
 */
export function poolSlots(slots: ReadonlyArray<{ n: number; bad: number }>, count: number): { ticks: number[]; bad: boolean[] } {
  if (!slots.length || count <= 0) return { ticks: [], bad: [] }
  const size = Math.max(1, Math.round(slots.length / count))
  const ticks: number[] = []
  const bad: boolean[] = []
  for (let i = 0; i < slots.length; i += size) {
    const group = slots.slice(i, i + size)
    ticks.push(group.reduce((sum, s) => sum + s.n, 0))
    bad.push(group.some((s) => s.bad > 0))
  }
  return { ticks, bad }
}

/** Default channel name from a base URL host (`api.groq.com` → `groq`), valid for validateChannelName. */
export function suggestName(baseUrl: string): string {
  try {
    const host = new URL(baseUrl).hostname.replace(/^www\./, '')
    const label = host.split('.').filter((part) => !['com', 'cn', 'io', 'ai', 'net', 'org', 'api', 'dev', 'app'].includes(part))[0] || host
    return label.replace(/[^a-zA-Z0-9._-]/g, '').replace(/^[^a-zA-Z0-9]+/, '').slice(0, 48)
  } catch {
    return ''
  }
}

export const CHANNEL_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,47}$/

/* ── list filter (?status=) ── */

export const CHANNEL_STATUS_FILTERS = ['all', 'enabled', 'warn', 'off'] as const
export type ChannelStatusFilter = (typeof CHANNEL_STATUS_FILTERS)[number]

/** `?status=` as the page applies it: the old console's `disabled` is `off`; anything unknown is 全部 (and leaves the URL). */
export function channelStatusFilter(raw: string | null | undefined): ChannelStatusFilter {
  const value = String(raw ?? '').trim().toLowerCase()
  if (value === 'disabled') return 'off'
  return (CHANNEL_STATUS_FILTERS as readonly string[]).includes(value) ? (value as ChannelStatusFilter) : 'all'
}
