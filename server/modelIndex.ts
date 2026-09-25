import type { ChannelView } from './channelView.js'
import { getModelPricing, type ModelPricing } from './pricing.js'

export type ModelSource = {
  channel: string
  /** compat = openai-compatibility 渠道；oauth = 账号池渠道（codex/claude/xai）。 */
  kind: 'compat' | 'oauth'
  enabled: boolean
  /** 同一模型名在该渠道下的上游条目数，>1 表示渠道内部还在轮询。 */
  upstreams: number
  /** 渠道整体是否可用；渠道停用时其下模型不可单独启用。 */
  channelEnabled: boolean
}

export type ModelEntry = {
  id: string
  /** 来自 LiteLLM/ccusage 同源价格表；图片模型按 CPA 返回的图像 token 口径结算。 */
  pricing: ModelPricing | null
  sources: ModelSource[]
  enabledSources: number
  /** 同一模型名由多个渠道提供时为 true，是路由歧义的信号。 */
  contested: boolean
}

export type OAuthProviderModels = {
  provider: string
  models: string[]
  /** 未被 oauth-excluded-models 排除的才算启用。 */
  excluded: string[]
  activeAccounts: number
}

/**
 * 把「渠道 → 模型」翻转成「模型 → 渠道」。
 * 同名模型分散在多个渠道时最容易出事（裸名 gpt-5.6-sol 曾同时挂在 codex 和 qijichuangtan 上，
 * 请求被路由到没额度的那个渠道），所以这里显式标记 contested。
 */
/**
 * 静态价格表优先，网关价只作兜底——和 `applyGatewayPricing` 的口径必须一致，
 * 否则页面显示的单价会和实际入账的成本对不上。静态表是人工维护的权威价：
 * 促销价（minimax-m3 -50%）、图片模型的 image token 价卡（gpt-image-2）、
 * 以及各家渠道的刊例价（commandcode 那 8 个）都在里面；models.dev 给的是上游
 * 列表价，用它覆盖会把账单和页面一起算错。
 * 静态表没有的模型仍由网关补，`applyGatewayPricing` 也会把它们并进 HISTORY，
 * 所以这里保留 gatewayPricing 兜底只是为了覆盖「本轮刚拿到、还没合并」的窗口。
 */
export function buildModelIndex(channels: ChannelView[], oauth: OAuthProviderModels[], gatewayPricing?: Map<string, ModelPricing>): ModelEntry[] {
  const index = new Map<string, ModelSource[]>()

  const push = (id: string, source: ModelSource) => {
    if (!id) return
    const list = index.get(id)
    if (list) list.push(source)
    else index.set(id, [source])
  }

  for (const channel of channels) {
    // CPA 侧直接删除的残留快照不属于当前模型来源；保留历史数据不等于继续展示它。
    if (channel.stale) continue
    for (const model of channel.models) {
      push(model.id, {
        channel: channel.name,
        kind: 'compat',
        enabled: channel.enabled && model.enabled,
        upstreams: model.upstreams,
        channelEnabled: channel.enabled,
      })
    }
  }

  for (const provider of oauth) {
    const excluded = new Set(provider.excluded)
    for (const id of new Set([...provider.models, ...provider.excluded])) {
      push(id, {
        channel: provider.provider,
        kind: 'oauth',
        enabled: !excluded.has(id) && provider.activeAccounts > 0,
        upstreams: provider.activeAccounts,
        channelEnabled: provider.activeAccounts > 0,
      })
    }
  }

  return [...index]
    .map(([id, sources]) => {
      const ordered = [...sources].sort((a, b) => a.channel.localeCompare(b.channel))
      const enabledSources = ordered.filter((source) => source.enabled).length
      return {
        id,
        pricing: getModelPricing(id) ?? gatewayPricing?.get(id) ?? null,
        sources: ordered,
        enabledSources,
        // 只有多个「启用中」的来源才会真的分流；停用渠道仍列在 sources 里供恢复，但不算争用。
        contested: enabledSources > 1,
      }
    })
    .sort((a, b) => Number(b.contested) - Number(a.contested) || a.id.localeCompare(b.id))
}
