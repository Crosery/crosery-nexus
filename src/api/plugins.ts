import { request } from './http'

/** CPA 管理接口 `/v8/management/plugins*` 的透传形状；字段缺失一律按未知处理。 */
export type InstalledPlugin = {
  id: string
  path?: string
  version?: string | null
  registered?: boolean
  enabled?: boolean
  effective_enabled?: boolean
}
export type PluginsInstalled = { plugins_enabled?: boolean; plugins_dir?: string; plugins?: InstalledPlugin[] }

export type StorePlugin = {
  id: string
  name?: string
  description?: string
  author?: string
  version?: string | null
  tags?: string[]
  homepage?: string
  repository?: string
  source_id?: string
  source_name?: string
  installed?: boolean
  installed_version?: string
  update_available?: boolean
}
export type PluginsStore = { sources?: Array<{ id: string; name?: string; url?: string }>; plugins?: StorePlugin[] }

/** 安装 / 卸载只改磁盘上的插件文件：CPA 进程重启后才会注册或完全卸载。 */
export const pluginsApi = {
  installed: (signal?: AbortSignal) => request<PluginsInstalled>('/api/plugins', { signal }),
  store: (signal?: AbortSignal) => request<PluginsStore>('/api/plugins/store', { signal }),
  install: (id: string, source?: string) =>
    request<Record<string, unknown>>(`/api/plugins/store/${encodeURIComponent(id)}/install`, { method: 'POST', body: JSON.stringify({ source: source ?? '' }) }),
  remove: (id: string) => request<Record<string, unknown>>(`/api/plugins/${encodeURIComponent(id)}`, { method: 'DELETE' }),
}
