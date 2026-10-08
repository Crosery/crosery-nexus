import type { ChannelView } from './channelView.js'
import type { OAuthProviderModels } from './modelIndex.js'

/**
 * 渠道分组 = 上游提供商，不是模型名关键词。
 * compat 渠道按 openai-compatibility 的渠道名（一个 base-url + 一组 key）成组，
 * oauth 渠道按凭据 type 成组。同一个裸名挂在两个渠道时，两个分组各自持有一份，
 * 互不影响——授权时按分组取并集。
 */
export type ConsoleGroup = {
  id: string
  name: string
  color: string
  kind: 'compat' | 'oauth'
  models: string[]
  /** false = 已知的 OAuth provider 暂时没有活跃账号；分组照留，模型为上次已知目录。缺省视为 true。 */
  available?: boolean
}

export type BuildGroupsOptions = {
  /** OAuth provider → 上次拿到的非空模型目录（channels.ts 落库的 oauth.models.lastKnown）。 */
  lastKnown?: Record<string, string[]>
  /** 即使一个凭据文件都不剩也要保留的 OAuth provider（仍被 Key 引用、或默认开放）；须在 lastKnown 里有目录。 */
  retain?: Iterable<string>
}

/**
 * 分组展示名。id 是渠道名或 OAuth provider，必须一一对应真实上游：
 * `codex` 是 OpenAI 官方 OAuth 凭据，`mox-aigw` 是第三方中转，
 * 两者都提供 gpt 系模型但归属不同，合并显示会让「只允许官方、不允许中转」无法表达。
 */
const presets: Record<string, { name: string; color: string }> = {
  claude: { name: 'Claude', color: '#d97757' },
  codex: { name: 'Codex', color: '#6ee7b7' },
  xai: { name: 'Grok', color: '#f472b6' },
  kimi: { name: 'Kimi', color: '#60a5fa' },
  minimax: { name: 'MiniMax', color: '#c084fc' },
  ollama: { name: 'Ollama', color: '#fbbf24' },
  'mox-aigw': { name: 'Mox 中转', color: '#38bdf8' },
  antigravity: { name: 'Antigravity', color: '#a3e635' },
}

const fallbackColors = ['#f472b6', '#38bdf8', '#a3e635', '#fb923c', '#818cf8', '#2dd4bf']

const colorFor = (id: string, position: number) =>
  presets[id]?.color || fallbackColors[position % fallbackColors.length]

export function buildGroups(channels: ChannelView[], oauth: OAuthProviderModels[], options: BuildGroupsOptions = {}): ConsoleGroup[] {
  const entries: Array<Omit<ConsoleGroup, 'color'>> = []
  const lastKnown = options.lastKnown || {}

  for (const channel of channels) {
    // 关闭、在 CPA 侧已删除或仅用于恢复的快照都不能继续成为可授权分组。
    if (!channel.name || !channel.enabled || channel.stale) continue
    entries.push({
      id: channel.name,
      name: presets[channel.name]?.name || channel.name,
      kind: 'compat',
      models: channel.models.filter((model) => model.enabled).map((model) => model.id),
      available: true,
    })
  }

  const retain = new Set(options.retain || [])
  const providers = new Map(oauth.filter((provider) => provider.provider).map((provider) => [provider.provider, provider]))
  for (const id of retain) {
    if (!providers.has(id)) providers.set(id, { provider: id, models: [], excluded: [], activeAccounts: 0, accounts: 0 })
  }

  /**
   * 账号临时归零（停用、迁走、刷新失败）不等于渠道下线（2026-10-09 403 事故）：
   * 以前这里直接丢掉该 provider，对账随即把它从所有 Key 的 groups_json 里永久删掉，账号回来也不会恢复。
   * 现在已知 provider 照留为 available:false 的分组、沿用上次已知目录，Key 的成员关系与模型/渠道权限都不变；
   * 只有管理员编辑 Key 才会去掉它。「已知」= 还有凭据文件（全部停用），或凭据已全部删除但仍被保留且有已知目录。
   */
  for (const provider of providers.values()) {
    const available = provider.activeAccounts > 0
    const known = available || (provider.accounts ?? 0) > 0 || (retain.has(provider.provider) && Boolean(lastKnown[provider.provider]?.length))
    if (!known) continue
    const models = provider.models.length ? provider.models : available ? [] : lastKnown[provider.provider] || []
    const excluded = new Set(provider.excluded)
    entries.push({
      id: provider.provider,
      name: presets[provider.provider]?.name || provider.provider,
      kind: 'oauth',
      models: models.filter((model) => !excluded.has(model)),
      available,
    })
  }

  return entries
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((entry, position) => ({
      ...entry,
      color: colorFor(entry.id, position),
      models: [...new Set(entry.models)].sort(),
    }))
}

/**
 * 用量归组。usage 记录带 provider，优先按它定位渠道，
 * 否则回落到「哪个分组提供了这个模型」。
 */
export function resolveGroupForModel(model: string, provider: string, groups: ConsoleGroup[]) {
  const direct = groups.find((group) => group.id === provider)
  if (direct) return direct.id
  return groups.find((group) => group.models.includes(model))?.id || 'other'
}

/** 选中分组能用的模型并集。同名模型出现在多个分组时只要勾中其一即可访问。 */
export function modelsForGroups(groups: ConsoleGroup[], selected: string[]) {
  const allowed = new Set(selected)
  const models = new Set<string>()
  for (const group of groups) {
    if (!allowed.has(group.id)) continue
    for (const model of group.models) models.add(model)
  }
  return [...models].sort()
}
