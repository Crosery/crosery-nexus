import type { ChannelView } from './channelView.js'
import { getModelPricing, type ModelPricing, getPricingSources, pricingSourceModelIds, type SourcePrice } from './pricing.js'
import { modelKind, type ModelKind } from './modelKind.js'

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
  /**
   * task-79：两个外部价格来源（models.dev / openrouter）各自的报价与抓取时间戳。
   * 与 `server/pricing.ts` 的 `getPricingSources()` 同源；缺失的来源**缺席**（不是 0）。
   */
  pricingSources?: Partial<Record<'models.dev' | 'openrouter', SourcePrice>>
  /** 任何来源都没有价格（本地/网关/两个外部来源都缺）⇒ true，前端显示「未收录」 */
  unpriced?: boolean
  /** 是否在网关上可用；只在价格来源里出现的模型 ⇒ false（并集里的"仅目录收录"） */
  availableOnGateway?: boolean
  /** 按输出分的模型类型（server/modelKind.ts：输出模态元数据优先，名字兜底）；buildModelIndex / 并集总会带上。 */
  kind?: ModelKind
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

/** task-79：把双源价格/未收录/是否在网关上可用拼给前端（与 ModelsPage 组件 props 对齐）。 */
function priceSourceFields(id: string, availableOnGateway: boolean): Pick<ModelEntry, 'pricingSources' | 'unpriced' | 'availableOnGateway'> {
  const { sources } = getPricingSources(id)
  const hasSourcePrice = Object.keys(sources).length > 0
  return {
    ...(hasSourcePrice ? { pricingSources: sources } : {}),
    availableOnGateway,
    unpriced: !getModelPricing(id) && !hasSourcePrice,
  }
}

/** 网关/渠道目录里已有的模型补齐双源字段（导出以便直接测字段契约）。 */
export function withPriceSourceFields(entry: ModelEntry): ModelEntry {
  return { ...entry, ...priceSourceFields(entry.id, true) }
}

/**
 * task-79 的「并集」：把两个价格来源里出现、但控制台目录里没有的模型补进来。
 * 只给**控制台自己的**视图用（不限可见范围）——按 Key 的视图不得调用它。
 */
export function mergePriceSourceEntries(models: ModelEntry[]): ModelEntry[] {
  const seen = new Set(models.map(entry => entry.id))
  const extra: ModelEntry[] = []
  for (const id of pricingSourceModelIds()) {
    if (seen.has(id)) continue
    extra.push({
      id,
      pricing: getModelPricing(id),
      sources: [],
      enabledSources: 0,
      contested: false,
      kind: modelKind(id),
      ...priceSourceFields(id, false),
    })
    seen.add(id)
  }
  return extra.length ? [...models, ...extra].sort((left, right) => left.id.localeCompare(right.id)) : models
}

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
        kind: modelKind(id),
      }
    })
    .map(withPriceSourceFields)
    .sort((a, b) => Number(b.contested) - Number(a.contested) || a.id.localeCompare(b.id))
}
