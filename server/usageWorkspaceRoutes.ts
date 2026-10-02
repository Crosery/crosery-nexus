/**
 * 用量工作台（Console v3 DESIGN §6.7）的报表路由：总览、请求流水、共享筛选条的选项。
 *
 * - `GET /api/usage-overview?view=workspace&days&keyId&model&provider&client` → loadUsageWorkspaceOverview
 * - `GET /api/analytics?view=workspace&…&status&category&page&pageSize` → loadUsageWorkspaceRequests（AnalyticsData 超集）
 * - `GET /api/usage-facets?days&keyId&model&provider&client` → loadUsageWorkspaceFacets
 * - `GET /api/usage-daily?year=recent|YYYY&keyId&model&provider&client&currentOnly` → loadUsageWorkspaceDaily（热力图一年的日格）
 *
 * 共享窗口：`days`（24h / 7d / 30d / 90d），或自定义跨度 `from` + `to`（配置时区的 YYYY-MM-DD，含首尾，夹到保留期内；
 * 两者都合法时覆盖 `days`，否则忽略）。缓存 / 性能页签（cacheSummary.ts、perfReports.ts）用同一个解析。
 *
 * 前两个与旧接口同一路径：只有带 `view=workspace` 的请求由这里处理，其余 `next()` 交还 index.ts 里的旧处理器，
 * 旧客户端（发布期间仍开着的旧页面）拿到的响应逐字节不变。只读本地 SQLite，不访问任何上游；同一筛选的结果
 * 在进程内合并与短时缓存，多个标签页同时刷新只算一次。
 */
import type express from 'express'
import { parseCurrentOnly } from './currentChannels.js'
import type { ConsoleGroup } from './groups.js'
import { RequestCoordinator } from './requestCoordinator.js'
import {
  loadUsageWorkspaceDaily,
  loadUsageWorkspaceFacets,
  loadUsageWorkspaceOverview,
  loadUsageWorkspaceRequests,
  retainedFromDay,
  USAGE_ERROR_CATEGORIES,
  USAGE_WORKSPACE_DAYS,
  zoneDayKey,
  type UsageDailyYear,
  type UsageWorkspaceFilter,
  type UsageWorkspaceRequestQuery,
} from './usageReports.js'

type Reader = Parameters<typeof loadUsageWorkspaceOverview>[0]

export type UsageWorkspaceDeps = {
  /** 报表读线程池（rollup 聚合） */
  usageReader: Reader
  /** 独立的单线程读池（事件表流水），与 /api/analytics 相同，避免拖慢核心报表 */
  latencyReader: Reader
  reportingContext: () => Promise<{ groups: ConsoleGroup[]; policyHash: string }>
  retentionDays: number
  timeZone: string
  /** 测试用时钟；缺省 Date.now */
  now?: () => number
}

export const USAGE_WORKSPACE_PAGE_SIZES = [20, 50, 100] as const
const LIMITS = { keyId: 128, model: 256, provider: 128, client: 64 } as const

export class UsageFilterError extends Error {
  constructor(readonly field: string) {
    super(`筛选参数 ${field} 不合法`)
  }
}

const hasControlChar = (value: string) => {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

const one = (value: unknown): string => {
  const raw = Array.isArray(value) ? value[0] : value
  return typeof raw === 'string' ? raw.trim() : ''
}

export type UsageClock = { timeZone?: string; now?: number }

const DEFAULT_TIME_ZONE = 'Asia/Shanghai'
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/
/** 真实存在的日历日（2026-02-30 这类会被 Date 进位的写法不算）。 */
const isCalendarDay = (value: string) => {
  if (!DAY_KEY.test(value)) return false
  const ms = Date.parse(`${value}T00:00:00.000Z`)
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value
}

/**
 * 自定义跨度：`from` 与 `to` 都是真实的日历日才生效（反了就对调）；夹到 [保留期起点, 今天]（配置时区），夹完为空则忽略。
 * 返回 null = 用 `days` 的滚动窗口（旧链接照旧）。
 */
export function parseUsageWindowSpan(query: Record<string, unknown>, retentionDays: number, clock: UsageClock = {}): { from: string; to: string; days: number } | null {
  let from = one(query.from)
  let to = one(query.to)
  if (!isCalendarDay(from) || !isCalendarDay(to)) return null
  if (from > to) [from, to] = [to, from]
  const today = zoneDayKey(clock.now ?? Date.now(), clock.timeZone ?? DEFAULT_TIME_ZONE)
  const floor = retainedFromDay(today, Math.max(1, retentionDays))
  if (from < floor) from = floor
  if (to > today) to = today
  if (from > to) return null
  const days = Math.round((Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86_400_000) + 1
  return { from, to, days }
}

/**
 * 窗口只接受 24h / 7d / 30d / 90d，且不超过保留期；不认识的值回到默认 7 天（与页面默认一致）。`currentOnly` 只认 1 / true。
 * 带合法的 `from` + `to` 时窗口是那段日历日（`days` = 跨度天数），见 parseUsageWindowSpan。
 */
export function parseUsageWorkspaceFilter(query: Record<string, unknown>, retentionDays: number, clock: UsageClock = {}): UsageWorkspaceFilter {
  const allowed = USAGE_WORKSPACE_DAYS.filter((days) => days <= Math.max(1, retentionDays))
  const requested = Number(one(query.days))
  const span = parseUsageWindowSpan(query, retentionDays, clock)
  const days = span ? span.days : (allowed as readonly number[]).includes(requested) ? requested : allowed.includes(7) ? 7 : allowed[allowed.length - 1]
  // 渠道口径：缺省 = 全部渠道（含已移除渠道的历史）；`currentOnly=1` = 只看当前渠道
  const filter: UsageWorkspaceFilter = { days, keyId: '', model: '', provider: '', client: '', currentOnly: parseCurrentOnly(query.currentOnly) }
  if (span) {
    filter.from = span.from
    filter.to = span.to
  }
  for (const field of ['keyId', 'model', 'provider', 'client'] as const) {
    const value = one(query[field])
    // 控制字符与超长值直接拒绝：这些值只做 SQL 绑定参数，但缓存键与日志不该收下它们。
    if (value.length > LIMITS[field] || hasControlChar(value)) throw new UsageFilterError(field)
    filter[field] = value
  }
  return filter
}

export function parseUsageWorkspaceRequestQuery(query: Record<string, unknown>): UsageWorkspaceRequestQuery {
  const statusRaw = one(query.status)
  const status = statusRaw === 'ok' || statusRaw === 'error' ? statusRaw : ''
  const categoryRaw = one(query.category)
  const category = (USAGE_ERROR_CATEGORIES as readonly string[]).includes(categoryRaw) ? categoryRaw : ''
  const pageRaw = Number(one(query.page))
  const page = Number.isInteger(pageRaw) && pageRaw >= 1 && pageRaw <= 10_000 ? pageRaw : 1
  const sizeRaw = Number(one(query.pageSize))
  const pageSize = (USAGE_WORKSPACE_PAGE_SIZES as readonly number[]).includes(sizeRaw) ? sizeRaw : 50
  const dayRaw = one(query.day)
  const day = /^\d{4}-\d{2}-\d{2}$/.test(dayRaw) && Number.isFinite(Date.parse(`${dayRaw}T00:00:00.000Z`)) ? dayRaw : ''
  return { status, category, day, page, pageSize }
}

/** 热力图的年份：`recent`（缺省）或保留期内的某个日历年；其它值回到 `recent`。 */
export function parseUsageDailyYear(raw: unknown, retentionDays: number, clock: UsageClock = {}): UsageDailyYear {
  const value = one(raw)
  if (!/^\d{4}$/.test(value)) return 'recent'
  const today = zoneDayKey(clock.now ?? Date.now(), clock.timeZone ?? DEFAULT_TIME_ZONE)
  const year = Number(value)
  const first = Number(retainedFromDay(today, Math.max(1, retentionDays)).slice(0, 4))
  return year >= first && year <= Number(today.slice(0, 4)) ? year : 'recent'
}

const isWorkspaceView = (req: express.Request) => one(req.query.view) === 'workspace'

/**
 * Upper bound of cached report bodies. Keys carry every filter, page (≤ 10,000), day and page size, so without a
 * bound ordinary browsing would keep request-list pages (up to 100 rows each) in memory for the process lifetime.
 */
export const USAGE_REPORT_CACHE_ENTRIES = 200

export function registerUsageWorkspaceRoutes(app: express.Express, deps: UsageWorkspaceDeps) {
  const reports = new RequestCoordinator<unknown>({ ttlMs: 15_000, staleWhileRevalidateMs: 60_000, maxEntries: USAGE_REPORT_CACHE_ENTRIES })
  const options = () => ({ timeZone: deps.timeZone, retentionDays: deps.retentionDays, now: deps.now?.() })

  const handle = (
    kind: string,
    build: (req: express.Request, groups: ConsoleGroup[], filter: UsageWorkspaceFilter) => { key: string; load: () => Promise<unknown> },
  ) => async (req: express.Request, res: express.Response) => {
    let filter: UsageWorkspaceFilter
    try {
      filter = parseUsageWorkspaceFilter(req.query as Record<string, unknown>, deps.retentionDays, { timeZone: deps.timeZone, now: deps.now?.() })
    } catch (error) {
      if (error instanceof UsageFilterError) return void res.status(400).json({ error: error.message, code: 'invalid_filter', field: error.field })
      throw error
    }
    const reporting = await deps.reportingContext()
    const { key, load } = build(req, reporting.groups, filter)
    const payload = await reports.run(`${kind}:${key}:${JSON.stringify(filter)}:${reporting.policyHash}`, load)
    res.setHeader('Cache-Control', 'private, max-age=15, stale-while-revalidate=60')
    res.json(payload)
  }

  app.get('/api/usage-overview', (req, res, next) => {
    if (!isWorkspaceView(req)) return next()
    return handle('overview', (_req, groups, filter) => ({
      key: '',
      load: () => loadUsageWorkspaceOverview(deps.usageReader, groups, filter, options()),
    }))(req, res)
  })

  app.get('/api/analytics', (req, res, next) => {
    if (!isWorkspaceView(req)) return next()
    return handle('requests', (request, groups, filter) => {
      const query = parseUsageWorkspaceRequestQuery(request.query as Record<string, unknown>)
      return {
        key: JSON.stringify(query),
        load: () => loadUsageWorkspaceRequests(deps.usageReader, deps.latencyReader, groups, filter, query, options()),
      }
    })(req, res)
  })

  app.get('/api/usage-facets', handle('facets', (_req, groups, filter) => ({
    key: '',
    load: () => loadUsageWorkspaceFacets(deps.usageReader, groups, filter, options()),
  })))

  // 日序列与页面窗口无关：缓存键只带年份、今天（跨过 00:00 换一份）与 Key / 模型 / 渠道 / 客户端口径
  app.get('/api/usage-daily', handle('daily', (request, groups, filter) => {
    const clock = { timeZone: deps.timeZone, now: deps.now?.() }
    const year = parseUsageDailyYear(request.query.year, deps.retentionDays, clock)
    const scope: UsageWorkspaceFilter = { days: 1, keyId: filter.keyId, model: filter.model, provider: filter.provider, client: filter.client, currentOnly: filter.currentOnly }
    return {
      key: `${year}:${zoneDayKey(clock.now ?? Date.now(), deps.timeZone)}:${JSON.stringify(scope)}`,
      load: () => loadUsageWorkspaceDaily(deps.usageReader, groups, scope, { ...options(), year }),
    }
  }))
}
