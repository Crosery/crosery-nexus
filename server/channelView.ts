import type { CompatChannel } from './cpa.js'
import { hashKey, maskKey, modelId } from './cpa.js'
import { priorityToWeight } from './credentials.js'

export type ChannelProtocolView = 'openai' | 'claude' | 'responses'

/** 一把上游 Key 的可见形态： stable 引用 + 打码值。密文从不回传给浏览器或 CLI。 */
export type ChannelKeyView = { ref: string; masked: string }

/**
 * 同一把 Key 的稳定引用（sha256 前 12 位）。按下标删会互相串位——删掉一把之后，
 * 后面的 Key 下标全部前移， UI/CLI 手里那个旧下标就指到别人头上；引用不受增删影响。
 */
export const channelKeyRef = (apiKey: string) => hashKey(apiKey).slice(0, 12)

export const channelKeyViews = (entries: CompatChannel['api-key-entries']): ChannelKeyView[] =>
  (entries || [])
    .map((entry) => String(entry?.['api-key'] || ''))
    .filter((key) => key.length > 0)
    .map((key) => ({ ref: channelKeyRef(key), masked: maskKey(key) }))

export type ChannelView = {
  name: string
  baseUrl: string
  keyCount: number
  /** 渠道持有的上游 Key（打码）。同一个渠道可以有多把，内核按条目轮询。 */
  keys: ChannelKeyView[]
  enabled: boolean
  /**
   * 上游协议：'responses' = 渠道配了 Responses 原生中继（CPA 的 relay-mode）；
   * 挂在 claude-api-key 等原生端点下的是 'claude'；
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
  /** CPA `api-key-channel-access` 的真实渠道名（`claude-api-key` 挂載的条目在 CPA 里是 `claude`，`codex-api-key` 是 `codex`）。 */
  cpaChannel?: string
  /** 调度权重 = -CPA priority：越小越优先，默认 0；同名模型多个渠道时先用权重最小的那档。 */
  weight?: number
  /** 渠道绑定的出口代理（'direct' 强制直连，或代理地址；未设置则为空或 undefined 继承全局）。 */
  proxyUrl?: string
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
      const relayMode = String(channel['relay-mode'] || '') === 'responses'
      const endpoint = String(channel.__providerEndpoint || '')
      const protocol: ChannelProtocolView = relayMode ? 'responses'
        : endpoint === 'claude-api-key' ? 'claude'
        : 'openai'
      const cpaChannel = endpoint === 'claude-api-key' ? 'claude'
        : endpoint === 'codex-api-key' ? 'codex'
        : endpoint === 'gemini-api-key' ? 'gemini'
        : endpoint === 'vertex-api-key' ? 'vertex'
        : undefined
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
        weight: priorityToWeight(channel.priority),
        keys: channelKeyViews(channel['api-key-entries']),
        enabled,
        protocol,
        stale: staleNames.has(name),
        models: [...liveModels, ...offModels].sort((a, b) => a.id.localeCompare(b.id)),
        ...(cpaChannel ? { cpaChannel } : {}),
        ...(String(channel['api-key-entries']?.[0]?.['proxy-url'] || channel['proxy-url'] || '').trim() ? { proxyUrl: String(channel['api-key-entries']?.[0]?.['proxy-url'] || channel['proxy-url'] || '').trim() } : {}),
      }
    })
    .sort((a, b) => Number(b.enabled) - Number(a.enabled) || Number(a.stale) - Number(b.stale) || a.name.localeCompare(b.name))
}
