import { AlertTriangle, Coins, Cpu, Database, RefreshCw, Search, ShieldCheck } from 'lucide-react'
import { useMemo, useState } from 'react'
import { api } from '../api'
import { Select } from '../components/Select'
import type { ApiKeyItem, ModelCost, ModelEntry, ModelIndexData, ModelPricing, ModelSource, UsageBreakdownData } from '../types'

const kindLabel: Record<string, string> = { compat: '兼容渠道', oauth: '账号池' }

type Filter = 'all' | 'contested' | 'off'

const compact = (value: number) => new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 }).format(value || 0)
const money = (value: number | null) => value === null ? '未定价' : value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`
const publicModelId = (model: string) => model.includes('/') ? model.slice(model.lastIndexOf('/') + 1) : model

function aggregateModelCosts(rows: ModelCost[]) {
  const result = new Map<string, ModelCost>()
  for (const row of rows) {
    const id = publicModelId(row.model)
    const current = result.get(id)
    if (!current) {
      result.set(id, { ...row, model: id })
      continue
    }
    result.set(id, {
      model: id,
      pricing: current.pricing || row.pricing,
      requests: current.requests + row.requests,
      newInputTokens: current.newInputTokens + row.newInputTokens,
      outputTokens: current.outputTokens + row.outputTokens,
      cacheTokens: current.cacheTokens + row.cacheTokens,
      cacheWriteTokens: current.cacheWriteTokens + row.cacheWriteTokens,
      reasoningTokens: current.reasoningTokens + row.reasoningTokens,
      totalTokens: current.totalTokens + row.totalTokens,
      inputCostUsd: current.inputCostUsd === null || row.inputCostUsd === null ? null : current.inputCostUsd + row.inputCostUsd,
      outputCostUsd: current.outputCostUsd === null || row.outputCostUsd === null ? null : current.outputCostUsd + row.outputCostUsd,
      cacheCostUsd: current.cacheCostUsd === null || row.cacheCostUsd === null ? null : current.cacheCostUsd + row.cacheCostUsd,
      cacheWriteCostUsd: current.cacheWriteCostUsd === null || row.cacheWriteCostUsd === null ? null : current.cacheWriteCostUsd + row.cacheWriteCostUsd,
      totalCostUsd: current.totalCostUsd === null || row.totalCostUsd === null ? null : current.totalCostUsd + row.totalCostUsd,
      priced: current.priced && row.priced,
    })
  }
  return result
}

function price(value: number | null | undefined) {
  if (value === null || value === undefined) return '—'
  return `$${value.toLocaleString('en-US', { maximumFractionDigits: 4 })}`
}

function PriceLine({ pricing }: { pricing: ModelPricing | null }) {
  if (!pricing) return <span className="model-price-line unpriced">单价未收录</span>
  const tier = pricing.tiers?.[pricing.tiers.length - 1]
  return <span className="model-price-line">
    单价 / 1M：输入 {price(pricing.input)} · 输出 {price(pricing.output)} · 缓存读 {price(pricing.cacheRead)}{pricing.cacheWrite !== undefined ? ` · 缓存写 ${price(pricing.cacheWrite)}` : ''}
    {tier ? ` · >${Math.round(tier.above / 1000)}k 后 输入 ${price(tier.input)} · 输出 ${price(tier.output)}` : ''}
    {pricing.until ? ` · 促销至 ${pricing.until}` : ''}
  </span>
}

function ModelCostCell({ usage, pricing, days }: { usage?: ModelCost; pricing: ModelPricing | null; days: number }) {
  const effectivePricing = usage?.pricing ?? pricing
  if (!usage || usage.requests === 0) return <div className="model-cost-cell empty"><PriceLine pricing={effectivePricing} /><span>近 {days} 天无用量</span></div>
  if (!usage.priced) return <div className="model-cost-cell unpriced"><div><strong>未定价</strong><PriceLine pricing={effectivePricing} /></div><span>{compact(usage.totalTokens)} token · {usage.requests.toLocaleString('zh-CN')} 次</span></div>
  return <div className="model-cost-cell">
    <PriceLine pricing={effectivePricing} />
    <div className="model-cost-total"><span>总花费</span><strong>{money(usage.totalCostUsd)}</strong></div>
    <div className="model-cost-parts">
      <span title={`${compact(usage.newInputTokens)} 新输入 token`}>输入 <strong>{money(usage.inputCostUsd)}</strong></span>
      <span title={`${compact(usage.outputTokens)} 输出 token`}>输出 <strong>{money(usage.outputCostUsd)}</strong></span>
      <span title={`${compact(usage.cacheTokens)} 缓存读 token`}>缓存读 <strong>{money(usage.cacheCostUsd)}</strong></span>
      <span title={`${compact(usage.cacheWriteTokens)} 缓存写 token`}>缓存写 <strong>{money(usage.cacheWriteCostUsd)}</strong></span>
    </div>
  </div>
}

export function ModelsPage({ data, usage, keys, days, setDays, keyId, setKeyId, loading, onRefresh, onNotify }: {
  data: ModelIndexData | null
  usage: UsageBreakdownData | null
  keys: ApiKeyItem[]
  days: number
  setDays: (days: number) => void
  keyId: string
  setKeyId: (keyId: string) => void
  loading: boolean
  onRefresh: () => Promise<void>
  onNotify: (message: string) => void
}) {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')

  const models = useMemo(() => data?.models || [], [data])
  const usageByModel = useMemo(() => aggregateModelCosts(usage?.models || []), [usage])
  const currentModelIds = useMemo(() => new Set(models.map((model) => model.id)), [models])
  const historicalOnlyCount = useMemo(() => [...usageByModel.keys()].filter((model) => !currentModelIds.has(model)).length, [usageByModel, currentModelIds])
  const contestedCount = models.filter((model) => model.contested).length

  const filtered = useMemo(() => models.filter((model) => {
    if (filter === 'contested' && !model.contested) return false
    if (filter === 'off' && model.enabledSources > 0) return false
    if (!query.trim()) return true
    const haystack = `${model.id} ${model.sources.map((source) => source.channel).join(' ')}`.toLowerCase()
    return haystack.includes(query.trim().toLowerCase())
  }), [models, filter, query])

  const toggle = async (model: ModelEntry, source: ModelSource) => {
    const token = `${model.id}@${source.channel}`
    setBusy(token); setError('')
    try {
      await api.setModelSourceEnabled(model.id, source.channel, source.kind, !source.enabled)
      await onRefresh()
      onNotify(`${model.id} 在「${source.channel}」已${source.enabled ? '停用' : '启用'}`)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '操作失败')
    } finally { setBusy('') }
  }

  const filters: Array<{ id: Filter; label: string }> = [
    { id: 'all', label: `全部 ${models.length}` },
    { id: 'contested', label: `多渠道 ${contestedCount}` },
    { id: 'off', label: '已全部停用' },
  ]

  const totals = usage?.totals
  const summary = [
    { label: '总花费', value: money(totals?.totalCostUsd ?? 0), icon: Coins },
    { label: '输入', value: money(totals?.inputCostUsd ?? 0), icon: Cpu },
    { label: '输出', value: money(totals?.outputCostUsd ?? 0), icon: RefreshCw },
    { label: '缓存', value: money(totals?.cacheCostUsd ?? 0), icon: Database },
  ]

  return <div className="page-stack">
    <section className="page-heading">
      <div><p className="eyebrow">MODELS</p><h1>模型总览</h1><p>查看实时渠道状态、每百万 token 单价，以及输入、输出、缓存的实际用量与花费。图片模型按网关返回的图像 token 计价。</p></div>
      <div className="heading-filters">
        <Select ariaLabel="选择 API Key" value={keyId} onChange={setKeyId} options={[{ value: '', label: '全部 API Key' }, ...keys.map((key) => ({ value: key.id, label: key.name }))]} />
        <Select ariaLabel="选择费用周期" value={String(days)} onChange={(value) => setDays(Number(value))} options={[{ value: '1', label: '最近 24 小时' }, { value: '7', label: '最近 7 天' }, { value: '30', label: '最近 30 天' }, { value: '90', label: '最近 90 天' }]} />
        <button
          type="button"
          className="secondary-button"
          onClick={async () => {
            try {
              const res = await api.syncUpstreamModels()
              onNotify(`同步成功：新增 ${res.result.addedModels.length} 个模型，现共 ${res.result.totalModels} 个`)
              await onRefresh()
            } catch {
              onNotify('同步上游模型失败，请检查上游连接')
            }
          }}
          disabled={loading}
          title="检测上游模型提供商及共享目录更新并同步最新模型"
        >
          <RefreshCw size={16} />
          同步最新模型
        </button>
        <button type="button" className="secondary-button" onClick={() => void onRefresh()} disabled={loading}><RefreshCw size={16} className={loading ? 'spin' : ''} />刷新</button>
      </div>
    </section>

    {error && <div className="warning-strip"><ShieldCheck size={16} />{error}</div>}

    {contestedCount > 0 && <div className="notice-strip">
      <AlertTriangle size={16} />
      <span>有 {contestedCount} 个模型名同时由多个渠道提供。请求会在启用渠道间路由；只选择其中一个渠道的 Key 不会使用另一个渠道。</span>
    </div>}

    <section className="model-cost-overview">
      {summary.map(({ label, value, icon: Icon }) => <div key={label}><Icon size={15} /><span>{label}</span><strong>{value}</strong></div>)}
      <p>{compact(totals?.totalTokens || 0)} token · {(totals?.requests || 0).toLocaleString('zh-CN')} 次请求 · 近 {days} 天{historicalOnlyCount ? ` · 含 ${historicalOnlyCount} 个已下线模型的历史用量` : ''}</p>
    </section>

    {usage?.unpricedModels.length ? <div className="warning-strip subtle"><AlertTriangle size={16} /><span title={usage.unpricedModels.join('、')}>{usage.unpricedModels.slice(0, 4).join('、')}{usage.unpricedModels.length > 4 ? ` 等 ${usage.unpricedModels.length} 个模型` : ''}尚无公开定价，未计入总花费。</span></div> : null}

    <section className="panel table-panel fill">
      <div className="table-toolbar">
        <div className="search-box"><Search size={17} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索模型名或渠道" /></div>
        <div className="filter-tabs">{filters.map((item) => <button type="button" key={item.id} className={filter === item.id ? 'filter-tab active' : 'filter-tab'} onClick={() => setFilter(item.id)}>{item.label}</button>)}</div>
      </div>

      {!filtered.length && !loading && <div className="empty-state"><Cpu size={28} /><h3>没有匹配的模型</h3><p>调整搜索条件或筛选后再试。</p></div>}

      <div className="model-index-list scroll-area">
        {filtered.map((model) => <div className={model.enabledSources ? 'model-index-row with-cost' : 'model-index-row with-cost off'} key={model.id}>
          <div className="model-index-name">
            <strong>{model.id}</strong>
            <small>{model.enabledSources ? `${model.enabledSources}/${model.sources.length} 个渠道启用` : '全部渠道已停用'}</small>
          </div>
          {model.contested && <span className="contested-badge" title="同一模型名由多个渠道提供"><AlertTriangle size={12} />多渠道</span>}
          <div className="source-chips">
            {model.sources.map((source) => <button
              key={`${source.channel}:${source.kind}`}
              type="button"
              className={source.enabled ? 'source-chip active' : 'source-chip'}
              disabled={busy === `${model.id}@${source.channel}` || (!source.channelEnabled && !source.enabled)}
              title={`${kindLabel[source.kind] || source.kind}${source.channelEnabled ? '' : '（渠道不可用）'}`}
              onClick={() => void toggle(model, source)}
            >
              <span className="source-dot" />
              {source.channel}
              {source.upstreams > 1 && <em>×{source.upstreams}</em>}
            </button>)}
          </div>
          <ModelCostCell usage={usageByModel.get(model.id)} pricing={model.pricing} days={days} />
        </div>)}
      </div>
    </section>
  </div>
}
