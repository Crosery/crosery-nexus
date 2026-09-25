import { Coins, Gauge, Radio, RefreshCw, Zap } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { Select } from '../components/Select'
import { CLIENT_LABELS } from '../clientLabels'
import { AXIS, STATUS } from '../chartTheme'
import { api } from '../api'
import { channelLabel } from '../channelLabels'
import type { ApiKeyItem, CacheTrendData, CacheTrendProvider, LiveUsageEvent } from '../types'

const tokens = (value: number) => {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return value.toLocaleString('zh-CN')
}

/** 单请求金额通常是几分钱，固定两位小数会全变成 $0.00，所以小额保留更多位。 */
const money = (value: number | null) => {
  if (value === null) return 'n/a'
  if (value === 0) return '$0'
  if (value < 0.01) return `$${value.toFixed(5)}`
  if (value < 1) return `$${value.toFixed(4)}`
  return `$${value.toFixed(2)}`
}

const percent = (value: number | null) => (value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`)

const hitTone = (rate: number | null) => {
  if (rate === null) return 'na'
  if (rate >= 0.9) return 'good'
  if (rate >= 0.7) return 'warn'
  return 'bad'
}

const clock = (iso: string) => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime())
    ? iso
    : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
}

const bucketLabel = (iso: string, bucketSeconds: number) => {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return bucketSeconds >= 86_400 ? `${d.getMonth() + 1}/${d.getDate()}` : hm
}

function TrendTooltip({ active, payload, bucketSeconds }: { active?: boolean; payload?: Array<{ payload: CacheTrendData['points'][number] }>; bucketSeconds: number }) {
  if (!active || !payload?.length) return null
  const p = payload[0].payload
  const d = new Date(p.bucket)
  return (
    <div className="chart-tip">
      <strong>{Number.isNaN(d.getTime()) ? p.bucket : d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</strong>
      <span>命中率 <b className={`hit-${hitTone(p.hitRate)}`}>{percent(p.hitRate)}</b></span>
      <span>请求 {p.requests.toLocaleString('zh-CN')} 次</span>
      <span>成本 {money(p.costUsd)}</span>
      <span>新输入 {tokens(p.freshInputTokens)}</span>
      <span>缓存读 {tokens(p.cacheReadTokens)}</span>
      <span>缓存写入 {tokens(p.cacheWriteTokens || 0)}</span>
      <span className="chart-tip-foot">{bucketSeconds >= 3600 ? `${bucketSeconds / 3600} 小时` : `${bucketSeconds / 60} 分钟`}一档</span>
    </div>
  )
}

export function CachePage({
  trend,
  loading,
  hours,
  model,
  models,
  client,
  clients,
  keys,
  keyId,
  onKey,
  providers,
  provider,
  onProvider,
  onClient,
  onHours,
  onModel,
  onRefresh,
}: {
  trend: CacheTrendData | null
  loading: boolean
  hours: number
  model: string
  models: string[]
  client: string
  clients: Array<{ type: string; label: string; requests: number }>
  /** bootstrap.keys：按 Key 看命中率时的选项来源 */
  keys: ApiKeyItem[]
  keyId: string
  onKey: (keyId: string) => void
  /** 趋势接口返回的各渠道请求量 */
  providers: CacheTrendProvider[]
  provider: string
  onProvider: (provider: string) => void
  onClient: (client: string) => void
  onHours: (hours: number) => void
  onModel: (model: string) => void
  onRefresh: () => void
}) {
  const [live, setLive] = useState<LiveUsageEvent[]>([])
  const [connected, setConnected] = useState(false)

  // SSE 长连接：首帧回放历史，之后接收增量。断线由浏览器按 retry 自动重连。
  // 依赖全部筛选条件：切换时重建连接，让实时流与上方趋势图保持同一口径。
  useEffect(() => {
    setLive([])
    const source = new EventSource(api.cacheLiveUrl(60, model, client, keyId, provider))
    source.addEventListener('open', () => setConnected(true))
    source.addEventListener('history', (event) => {
      const rows = JSON.parse((event as MessageEvent).data) as LiveUsageEvent[]
      setConnected(true)
      setLive(rows.slice(-200).reverse())
    })
    source.addEventListener('usage', (event) => {
      const rows = JSON.parse((event as MessageEvent).data) as LiveUsageEvent[]
      // 上限 200 条：无上限会让长时间挂着的页面越来越卡
      setLive((prev) => [...rows.reverse(), ...prev].slice(0, 200))
    })
    source.addEventListener('error', () => setConnected(false))
    return () => source.close()
  }, [model, client, keyId, provider])

  const points = trend?.points ?? []
  // 分母必须含缓存写入段，否则首次写缓存的请求会被算成满命中，
  // claude 系列会恒显示 100.0%（与服务端 hitRate() 口径保持一致）。
  const totalHit = points.length
    ? points.reduce((s, p) => s + p.cacheReadTokens, 0) /
      Math.max(1, points.reduce((s, p) => s + p.cacheReadTokens + p.freshInputTokens + (p.cacheWriteTokens || 0), 0))
    : null
  const totalCost = points.reduce((s, p) => s + (p.costUsd ?? 0), 0)
  const totalReq = points.reduce((s, p) => s + p.requests, 0)
  const liveCost = live.reduce((s, e) => s + (e.costUsd ?? 0), 0)

  const chartData = points.map((p) => ({ ...p, label: bucketLabel(p.bucket, trend?.bucketSeconds ?? 900), pct: p.hitRate === null ? null : p.hitRate * 100 }))
  const modelOptions = model && !models.includes(model) ? [model, ...models] : models
  const clientOptions = client && !clients.some((item) => item.type === client)
    ? [{ type: client, label: CLIENT_LABELS[client] || client, requests: 0 }, ...clients]
    : clients
  const keyOptions = keyId && !keys.some((item) => item.id === keyId)
    ? [{ id: keyId, name: `已删除 Key ${keyId.slice(0, 8)}` }, ...keys]
    : keys
  const providerOptions = provider && !providers.some((item) => item.id === provider)
    ? [{ id: provider, label: channelLabel(provider), requests: 0 }, ...providers]
    : providers

  const cards = [
    { label: '区间总命中率', value: percent(totalHit), meta: `${totalReq.toLocaleString('zh-CN')} 次请求`, icon: Gauge, tone: 'mint', strongClass: `hit-${hitTone(totalHit)}` },
    { label: '区间总成本', value: money(totalCost), meta: `最近 ${hours} 小时`, icon: Coins, tone: 'blue' },
    { label: '实时流成本', value: money(liveCost), meta: `当前 ${live.length} 条`, icon: Zap, tone: 'amber' },
  ]

  return (
    <div className="page-stack">
      <section className="page-heading">
        <div>
          <p className="eyebrow">CACHE PERFORMANCE</p>
          <h1>缓存命中率</h1>
          <p>各时间段的总命中率趋势，以及每一次请求的实时命中率与花费。</p>
        </div>
        <div className="heading-filters">
          <Select ariaLabel="选择模型" value={model} onChange={onModel}
            options={[{ value: '', label: '全部模型' }, ...modelOptions.map((m) => ({ value: m, label: m }))]} />
          <Select ariaLabel="选择客户端" value={client} onChange={onClient}
            options={[{ value: '', label: '全部客户端' }, ...clientOptions.map((item) => ({ value: item.type, label: `${item.label} · ${tokens(item.requests)}` }))]} />
          <Select ariaLabel="选择 API Key" value={keyId} onChange={onKey}
            options={[{ value: '', label: '全部 Key' }, ...keyOptions.map((item) => ({ value: item.id, label: item.name }))]} />
          <Select ariaLabel="选择渠道" value={provider} onChange={onProvider}
            options={[{ value: '', label: '全部渠道' }, ...providerOptions.map((item) => ({ value: item.id, label: `${item.label} · ${tokens(item.requests)}` }))]} />
          <Select ariaLabel="选择时间范围" value={String(hours)} onChange={(v) => onHours(Number(v))}
            options={[
              { value: '1', label: '最近 1 小时' },
              { value: '6', label: '最近 6 小时' },
              { value: '24', label: '最近 24 小时' },
              { value: '72', label: '最近 3 天' },
              { value: '168', label: '最近 7 天' },
              { value: '336', label: '最近 14 天' },
              { value: '720', label: '最近 30 天' },
              { value: '2160', label: '最近 90 天' },
            ]} />
          <button type="button" className="icon-button" onClick={onRefresh} title="刷新">
            <RefreshCw size={17} className={loading ? 'spin' : ''} />
          </button>
        </div>
      </section>

      <section className="metric-grid metric-grid-3">
        {cards.map(({ label, value, meta, icon: Icon, tone, strongClass }) => (
          <article className="metric-card" key={label}>
            <div className={`metric-icon ${tone}`}><Icon size={19} /></div>
            <p>{label}</p><strong className={strongClass}>{value}</strong><span>{meta}</span>
          </article>
        ))}
      </section>

      <article className="panel">
        <div className="panel-title">
          <div><h2>命中率趋势</h2><p>每档时间区间的总命中率，用于定位命中率下滑的时段</p></div>
          <span className="soft-badge">{trend ? (trend.bucketSeconds >= 3600 ? `${trend.bucketSeconds / 3600}h/档` : `${trend.bucketSeconds / 60}min/档`) : '—'}</span>
        </div>
        <div className="trend-wrap">
          {chartData.length === 0 ? (
            <p className="cache-empty">{loading ? '加载中…' : '该区间没有请求'}</p>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData} margin={{ top: 6, right: 12, bottom: 0, left: 0 }}>
                <defs>
                  <linearGradient id="hitFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={STATUS.good} stopOpacity={0.28} />
                    <stop offset="100%" stopColor={STATUS.good} stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke={AXIS.grid} vertical={false} />
                <XAxis dataKey="label" tick={{ fill: AXIS.tick, fontSize: 11 }} tickLine={false} axisLine={false} minTickGap={28} />
                <YAxis domain={[0, 100]} unit="%" tick={{ fill: AXIS.tick, fontSize: 11 }} tickLine={false} axisLine={false} width={44} />
                <Tooltip content={<TrendTooltip bucketSeconds={trend?.bucketSeconds ?? 900} />} />
                <Area type="monotone" dataKey="pct" stroke={STATUS.good} strokeWidth={2} fill="url(#hitFill)" connectNulls={false} dot={false} isAnimationActive={false} />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>
      </article>

      <article className="panel">
        <div className="panel-title">
          <div>
            <h2>实时请求流</h2>
            <p>每一次请求的命中率与花费，新请求自动出现在最上方</p>
          </div>
          <span className={`live-dot-badge ${connected ? 'on' : 'off'}`}>
            <Radio size={13} />{connected ? '实时' : '重连中'}
          </span>
        </div>
        {live.length === 0 ? (
          <p className="cache-empty">等待请求…发一条请求即可看到它出现在这里。</p>
        ) : (
          <div className="cache-table scroll-area live-table">
            <div className="cache-row live-row cache-head">
              <span>时间</span><span>模型</span><span>Key</span><span>客户端</span><span className="num">输入</span><span className="num">输出</span>
              <span className="num">上下文</span><span className="num">缓存读</span><span className="num">缓存写</span><span>命中率</span><span className="num">花费</span><span className="num">耗时</span>
            </div>
            {live.map((e) => (
              <div className={`cache-row live-row${e.overCeiling ? ' alert' : ''}${e.success ? '' : ' failed'}`} key={e.requestId}>
                <span className="req-time">{clock(e.timestamp)}</span>
                <strong title={`${e.model} · ${channelLabel(e.provider || '')} · ${e.endpoint}`}>{e.model}</strong>
                {/* 直接显示 Key 名，才能一眼看出是谁的请求在拖低命中率。 */}
                <span className="req-key" title={e.keyName || e.source || '未关联 Key'}>{e.keyName || e.source || '—'}</span>
                <span className="req-client" title={e.userAgent || '未上报'}>{CLIENT_LABELS[e.clientType || 'unknown'] || '未知'}</span>
                <span className="num">{tokens(e.inputTokens || 0)}</span>
                <span className="num">{tokens(e.outputTokens || 0)}</span>
                <span className="num">
                  {tokens(e.promptTokens)}
                  {e.overCeiling && <em className="over-pill inline">超限</em>}
                </span>
                {/* 缓存写入比「新输入」更有诊断价值：Anthropic 的新输入恒为个位数，
                    真正花钱的是反复重建的缓存写入段。 */}
                <span className="num">{tokens(e.cacheReadTokens || 0)}</span>
                <span className="num">{tokens(e.cacheWriteTokens || 0)}</span>
                <span className={`hit-chip ${hitTone(e.hitRate)}`}>{percent(e.hitRate)}</span>
                <span className="num money">{money(e.costUsd)}</span>
                <span className="num">{(e.latencyMs / 1000).toFixed(1)}s</span>
              </div>
            ))}
          </div>
        )}
      </article>
    </div>
  )
}
