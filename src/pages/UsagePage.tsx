import { Activity, CalendarDays, Coins, Database, KeyRound, RefreshCw, Sparkles, TriangleAlert } from 'lucide-react'
import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Select } from '../components/Select'
import type { ApiKeyItem, UsageDailyPoint, UsageOverviewData, UsagePageData } from '../types'

const tokens = (value: number) => {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return value.toLocaleString('zh-CN')
}

const cost = (value: number | null) => (value === null ? 'n/a' : value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`)

const percent = (value: number | null) => (value === null ? 'n/a' : `${Math.round(value * 100)}%`)

const dayLabel = (day: string) => {
  const parsed = new Date(`${day}T12:00:00`)
  return Number.isNaN(parsed.getTime()) ? day : `${parsed.getMonth() + 1}月${parsed.getDate()}日`
}

function DayDetail({ point, anchor }: { point: UsageDailyPoint; anchor: DOMRect | null }) {
  const mix = [
    { label: '新输入', value: point.newInputTokens },
    { label: '输出', value: point.outputTokens },
    { label: '缓存读', value: point.cacheTokens },
    { label: '缓存写', value: point.cacheWriteTokens },
  ]
  const width = anchor ? Math.max(anchor.width, 260) : undefined
  const left = anchor ? Math.max(12, Math.min(anchor.left, window.innerWidth - (width || 260) - 12)) : undefined
  const top = anchor ? Math.min(anchor.bottom + 10, window.innerHeight - 220) : undefined
  const style = anchor ? { position: 'fixed' as const, left, top, width } : { position: 'fixed' as const, left: -9999, top: 0 }
  return createPortal(<div className="day-detail" style={style}>
    <div className="day-detail-head">
      <strong>{dayLabel(point.day)}</strong>
      <span>{tokens(point.totalTokens)} token</span>
    </div>
    {point.totalTokens > 0 ? <>
      <div className="day-detail-grid">
        <div><span>请求</span><strong>{point.requests.toLocaleString('zh-CN')}</strong></div>
        <div><span>成本</span><strong>{cost(point.estimatedCostUsd)}</strong></div>
        <div><span>失败</span><strong>{point.errors.toLocaleString('zh-CN')}</strong></div>
      </div>
      <div className="day-detail-mix">{mix.map((entry) => <span key={entry.label}>{entry.label} {tokens(entry.value)}</span>)}</div>
      {point.topModels.length > 0 && <div className="day-detail-models">
        {point.topModels.map((entry) => <div key={entry.model}>
          <span title={entry.model}>{entry.model}</span><strong>{tokens(entry.totalTokens)}</strong>
        </div>)}
      </div>}
    </> : <p className="day-detail-empty">当天无调用</p>}
  </div>, document.body)
}

function DailyIntensity({ daily, bestDay }: { daily: UsageDailyPoint[]; bestDay: UsageDailyPoint | null }) {
  const [active, setActive] = useState<UsageDailyPoint | null>(null)
  const [anchor, setAnchor] = useState<DOMRect | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const updateAnchor = useCallback(() => {
    const rect = wrapRef.current?.getBoundingClientRect()
    setAnchor(rect ?? null)
  }, [])
  useLayoutEffect(() => {
    if (!active) return
    updateAnchor()
    window.addEventListener('scroll', updateAnchor, true)
    window.addEventListener('resize', updateAnchor)
    return () => {
      window.removeEventListener('scroll', updateAnchor, true)
      window.removeEventListener('resize', updateAnchor)
    }
  }, [active, updateAnchor])
  return <article className="panel usage-block">
    <div className="panel-title">
      <div><h2>每日强度</h2><p>悬浮某一天查看当天详细用量</p></div>
      {bestDay && <span className="soft-badge">最高 {dayLabel(bestDay.day)}</span>}
    </div>
    <div className="heatmap-wrap" ref={wrapRef}>
      <div className="heatmap" role="img" aria-label="近期 token 活动热力图" onMouseLeave={() => setActive(null)}>
        {daily.map((point) => <button
          type="button"
          key={point.day}
          className={`heat-cell level-${point.intensity}${active?.day === point.day ? ' active' : ''}`}
          aria-label={`${point.day}：${point.totalTokens.toLocaleString('zh-CN')} token`}
          onMouseEnter={() => setActive(point)}
          onFocus={() => setActive(point)}
        />)}
      </div>
      {active && <DayDetail point={active} anchor={anchor} />}
    </div>
    <div className="heatmap-legend">
      <span>{dayLabel(daily[0]?.day ?? '')}</span>
      <div className="legend-scale"><span>少</span>{[0, 1, 2, 3, 4].map((level) => <span key={level} className={`heat-cell level-${level}`} aria-hidden />)}<span>多</span></div>
      <span>{dayLabel(daily.at(-1)?.day ?? '')}</span>
    </div>
  </article>
}

function TokenMix({ data }: { data: UsageOverviewData }) {
  const segments = [
    { key: 'input', label: '新输入', value: data.newInputTokens, tone: 'strong' },
    { key: 'output', label: '输出', value: data.outputTokens, tone: 'mid' },
    { key: 'cache', label: '缓存读', value: data.cacheTokens, tone: 'soft' },
    { key: 'cache-write', label: '缓存写', value: data.cacheWriteTokens || 0, tone: 'mid' },
  ]
  const total = segments.reduce((sum, segment) => sum + segment.value, 0)
  return <article className="panel usage-block">
    <div className="panel-title">
      <div><h2>token 分布</h2><p>汇总各渠道的输入、输出与缓存 token</p></div>
      {data.reasoningTokens > 0 && <span className="soft-badge">{tokens(data.reasoningTokens)} 推理</span>}
    </div>
    <div className="mix-bar">
      {total > 0 ? segments.filter((segment) => segment.value > 0).map((segment) =>
        <span key={segment.key} className={`mix-seg ${segment.tone}`} style={{ width: `${(segment.value / total) * 100}%` }} />) : <span className="mix-seg empty" />}
    </div>
    <div className="mix-legend">{segments.map((segment) => <div key={segment.key}><span className={`mix-dot ${segment.tone}`} />{segment.label}：{tokens(segment.value)}</div>)}</div>
  </article>
}

export function UsagePage({ data, keySummariesState, keys, days, setDays, keyId, setKeyId, onRefresh, loading }: {
  data: UsagePageData | null
  keySummariesState: 'idle' | 'loading' | 'ready' | 'error'
  keys: ApiKeyItem[]
  days: number
  setDays: (days: number) => void
  keyId: string
  setKeyId: (id: string) => void
  onRefresh: () => void
  loading: boolean
}) {
  const cards = [
    { label: 'token 总数', value: tokens(data?.totalTokens || 0), meta: `${(data?.requests || 0).toLocaleString('zh-CN')} 次请求`, icon: Sparkles, tone: 'mint' },
    { label: '预计成本', value: cost(data?.estimatedCostUsd ?? null), meta: data?.hasPartialCost ? '部分模型未定价' : '按模型单价估算', icon: Coins, tone: 'blue' },
    { label: '活跃天数', value: String(data?.activeDays || 0), meta: `共 ${data?.days || 0} 天区间`, icon: CalendarDays, tone: 'purple' },
    { label: '缓存占比', value: percent(data?.cacheShare ?? null), meta: `${tokens(data?.cacheTokens || 0)} 缓存 token`, icon: Database, tone: 'amber' },
  ]
  return <div className="page-stack">
    <section className="page-heading">
      <div>
        <p className="eyebrow">STATS &amp; USAGE</p>
        <h1>统计和使用情况</h1>
        <p>网关全渠道的 token 消耗、成本估算与各上游用量分布。{data?.trackingSince ? ` 自 ${new Date(data.trackingSince).toLocaleDateString('zh-CN')} 起统计。` : ''}</p>
      </div>
      <div className="heading-filters">
        <Select ariaLabel="选择 API Key" value={keyId} onChange={setKeyId} options={[{ value: '', label: '全部 API Key' }, ...keys.map((key) => ({ value: key.id, label: key.name }))]} />
        <Select ariaLabel="选择统计周期" value={String(days)} onChange={(value) => setDays(Number(value))} options={[{ value: '1', label: '最近 24 小时' }, { value: '7', label: '最近 7 天' }, { value: '30', label: '最近 30 天' }, { value: '90', label: '最近 90 天' }]} />
        <button type="button" className="icon-button" onClick={onRefresh} title="刷新"><RefreshCw size={17} className={loading ? 'spin' : ''} /></button>
      </div>
    </section>

    <section className="metric-grid">{cards.map(({ label, value, meta, icon: Icon, tone }) => <article className="metric-card" key={label}>
      <div className={`metric-icon ${tone}`}><Icon size={19} /></div><p>{label}</p><strong>{value}</strong><span>{meta}</span>
    </article>)}</section>

    {data?.hasPartialCost && <div className="warning-strip subtle"><TriangleAlert size={17} />
      <span title={data.unpricedModels.join('、')}>
        {`${data.unpricedModels.slice(0, 4).join('、')}${data.unpricedModels.length > 4 ? ` 等 ${data.unpricedModels.length} 个模型` : ''} 尚无定价，未计入成本估算。`}
      </span>
    </div>}

    <section className="usage-grid">
      <DailyIntensity daily={data?.daily || []} bestDay={data?.bestDay ?? null} />
      <TokenMix data={data ?? { newInputTokens: 0, outputTokens: 0, cacheTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } as UsageOverviewData} />
    </section>

    {!keyId && <section className="panel usage-key-breakdown">
      <div className="panel-title">
        <div><h2>按 API Key 查询</h2><p>每把 Key 在当前周期内的请求、token 与估算费用</p></div>
        <span className="soft-badge"><Activity size={12} /> {keySummariesState === 'loading' ? '正在加载' : keySummariesState === 'error' ? '更新失败' : `${data?.keySummaries.length || 0} 把 Key 有用量`}</span>
      </div>
      <div className="usage-key-table scroll-area">
        <div className="usage-key-row usage-key-head"><span>API Key</span><span>请求</span><span>输入</span><span>输出</span><span>缓存</span><span>总花费</span></div>
        {(data?.keySummaries || []).map((entry) => <button type="button" className="usage-key-row" key={entry.id} onClick={() => setKeyId(entry.id)} title={`查看 ${entry.name} 的详细用量`}>
          <strong>{entry.name}</strong>
          <span>{entry.totals.requests.toLocaleString('zh-CN')}</span>
          <span>{tokens(entry.totals.newInputTokens)}</span>
          <span>{tokens(entry.totals.outputTokens)}</span>
          <span>{tokens(entry.totals.cacheTokens)}</span>
          <span className="usage-key-cost">{cost(entry.totals.totalCostUsd)}{entry.hasUnpricedModels ? '+' : ''}</span>
        </button>)}
        {!data?.keySummaries.length && <div className="empty-state compact"><KeyRound size={25}/><h3>{keySummariesState === 'loading' ? '正在加载 Key 用量' : keySummariesState === 'error' ? 'Key 用量暂时不可用' : '当前周期没有 Key 用量'}</h3></div>}
      </div>
    </section>}

    {keyId && <section className="panel usage-key-breakdown">
      <div className="panel-title">
        <div><h2>当前 Key 的模型明细</h2><p>按请求实际使用的模型与渠道展示，切换 Key 后仍保留明细区域。</p></div>
        <button type="button" className="secondary-button tiny" onClick={() => setKeyId('')}>查看全部 Key</button>
      </div>
      <div className="usage-key-table scroll-area">
        <div className="usage-key-row usage-key-head"><span>模型</span><span>渠道</span><span>请求</span><span>新输入</span><span>缓存</span><span>成本</span></div>
        {(data?.models || []).map((entry) => <div className="usage-key-row" key={`${entry.provider}:${entry.model}`}>
          <strong title={entry.model}>{entry.model}</strong>
          <span>{entry.provider}</span>
          <span>{entry.requests.toLocaleString('zh-CN')}</span>
          <span>{tokens(entry.newInputTokens)}</span>
          <span>{tokens(entry.cacheTokens)}</span>
          <span className="usage-key-cost">{cost(entry.costUsd ?? null)}{data?.hasPartialCost ? '+' : ''}</span>
        </div>)}
        {!data?.models?.length && <div className="empty-state compact"><KeyRound size={25}/><h3>{loading ? '正在加载当前 Key 用量' : '当前周期没有模型用量'}</h3></div>}
      </div>
    </section>}

  </div>
}
