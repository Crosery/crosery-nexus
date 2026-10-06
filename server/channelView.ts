import type { CompatChannel } from './cpa.js'
import { modelId } from './cpa.js'

export type ChannelProtocolView = 'openai' | 'claude' | 'responses'

export type ChannelView = {
  name: string
  baseUrl: string
  keyCount: number
  enabled: boolean
  /**
   * 上游协议：'responses' = 渠道配了 Responses 原生中继（CPA 的 relay-mode /
   * Magpie registry 的 protocol）；挂在 claude-api-key 等原生端点下的是 'claude'；
   * 其余兼容渠道是 'openai'。
   */
  protocol: ChannelProtocolView
  /**
   * 网关里已经没有、只剩本地快照的渠道。区分两种「停用」：
   * 通过面板停用的可以一键恢复；在 CPA 侧被直接删掉的只是残影，必须能清掉，
   * 否则面板会永远列出用户早已不存在的渠道。
   */
  stale: boolean
  /** upstreams：同一个对外模型名可能由多条上游条目轮询，开关按对外名生效。 */
  models: Array<{ id: string; enabled: boolean; upstreams: number }>
}

export type ChannelSnapshotRow = { name: string; enabled: number; snapshot_json: string }
export type ModelStateRow = { channel: string; model: string; enabled: number }

const parse = <T>(value: string, fallback: T): T => {
  try { return JSON.parse(value) as T } catch { return fallback }
}

/**
 * 停用的渠道已从网关摘除、只剩本地快照，停用的模型同理。
 * 合并两边才能得到完整视图：网关里存在 = 启用，只在本地快照里 = 停用。
 */
export function mergeChannelView(
  live: CompatChannel[],
  channelSnapshots: ChannelSnapshotRow[],
  modelStates: ModelStateRow[],
): ChannelView[] {
  const liveNames = new Set(live.map((channel) => String(channel.name || '')))
  // 快照里所有不在网关中的渠道都要露出来，包括「曾经启用、后来在 CPA 侧被删掉」的，
  // 否则它们会静默消失或长期以「停用」身份挂着，用户无从分辨也无从清理。
  const offlineSnapshots = channelSnapshots.filter((row) => !liveNames.has(row.name))
  const staleNames = new Set(offlineSnapshots.filter((row) => row.enabled).map((row) => row.name))
  // CPA 侧直接删除的渠道不再属于当前渠道管理视图；历史快照保留在本地，
  // 但不能让它们继续作为可见渠道、权限组或模型来源出现。
  const restorableSnapshots = offlineSnapshots.filter((row) => !row.enabled)
  const offlineChannels = restorableSnapshots.map((row) => parse<CompatChannel>(row.snapshot_json, { name: row.name }))

  return [...live, ...offlineChannels]
    .map((channel) => {
      const name = String(channel.name || '')
      const enabled = liveNames.has(name) && channel.disabled !== true
      // Responses 中继有两个内核词汇：CPA 的 relay-mode 与 Magpie registry 的 protocol。
      const relayMode = String(channel['relay-mode'] || '') === 'responses' || String(channel.protocol || '') === 'responses'
      const protocol: ChannelProtocolView = relayMode ? 'responses'
        : channel.__providerEndpoint === 'claude-api-key' ? 'claude'
        : 'openai'
      // 同一 alias 的多条上游折叠成一个开关，否则同名模型会重复出现。
      const upstreamCount = new Map<string, number>()
      for (const model of channel.models || []) {
        const id = modelId(model)
        if (id) upstreamCount.set(id, (upstreamCount.get(id) || 0) + 1)
      }
      const liveModels = [...upstreamCount].map(([id, upstreams]) => ({ id, enabled: true, upstreams }))
      const offModels = modelStates
        .filter((row) => row.channel === name && !row.enabled && !upstreamCount.has(row.model))
        .map((row) => ({ id: row.model, enabled: false, upstreams: 0 }))
      return {
        name,
        baseUrl: String(channel['base-url'] || ''),
        keyCount: (channel['api-key-entries'] || []).length,
        enabled,
        protocol,
        stale: staleNames.has(name),
        models: [...liveModels, ...offModels].sort((a, b) => a.id.localeCompare(b.id)),
      }
    })
    .sort((a, b) => Number(b.enabled) - Number(a.enabled) || Number(a.stale) - Number(b.stale) || a.name.localeCompare(b.name))
}
