import { ApiError } from '../../../api'
import { qs, request } from '../../../api/http'
import type { UsageFilter } from '../filters'
import type { UsageDailyData, UsageFacetsData } from './types'

/**
 * The usage workspace's reads. Same paths as before (`/api/usage-overview`, `/api/analytics`) with
 * `view=workspace` plus the shared filters; the server answers the old shape for callers without the marker.
 * A server that has not been restarted onto the new handlers still answers the old shape — that is reported as
 * an error ("待重启生效") instead of being rendered as an empty page.
 */
const marked = async <T>(url: string, signal?: AbortSignal): Promise<T> => {
  const data = await request<T & { view?: string }>(url, { signal })
  if (!data || data.view !== 'workspace') {
    throw new ApiError(503, '用量接口待重启生效：控制台服务还是旧版本', { code: 'usage_workspace_unavailable' })
  }
  return data
}

const filterParams = (filter: UsageFilter) => ({
  days: filter.from && filter.to ? undefined : filter.days,
  from: filter.from || undefined,
  to: filter.to || undefined,
  keyId: filter.keyId,
  model: filter.model,
  provider: filter.provider,
  client: filter.client,
  currentOnly: filter.currentOnly ? 1 : undefined,
})

export type RequestsQuery = { status: '' | 'ok' | 'error'; category: string; day: string; page: number; pageSize: number }

export const api = {
  /** 总览：账本、热力图、构成、排行、失败构成 —— 一次读完 */
  usageOverview: <T>(filter: UsageFilter, signal?: AbortSignal) =>
    marked<T>(`/api/usage-overview${qs({ view: 'workspace', ...filterParams(filter) })}`, signal),
  /** 请求：错误条、流水一页（AnalyticsData 超集） */
  analytics: <T>(filter: UsageFilter, query: RequestsQuery, signal?: AbortSignal) =>
    marked<T>(`/api/analytics${qs({ view: 'workspace', ...filterParams(filter), ...query, page: query.page > 1 ? query.page : undefined })}`, signal),
  /** 共享筛选条的选项（带计数）与页签上的数 */
  facets: (filter: UsageFilter, signal?: AbortSignal) =>
    marked<UsageFacetsData>(`/api/usage-facets${qs(filterParams(filter))}`, signal),
  /** 热力图一年的日格：只带 Key / 模型 / 渠道 / 客户端 / 渠道口径，与页面窗口无关 */
  daily: (filter: UsageFilter, year: 'recent' | number, signal?: AbortSignal) =>
    marked<UsageDailyData>(`/api/usage-daily${qs({
      year: year === 'recent' ? undefined : year,
      keyId: filter.keyId,
      model: filter.model,
      provider: filter.provider,
      client: filter.client,
      currentOnly: filter.currentOnly ? 1 : undefined,
    })}`, signal),
}
