import { Activity, ArrowUpRight, Clock3, KeyRound, Server, TriangleAlert } from 'lucide-react'
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import type { AnalyticsData, ApiKeyItem } from '../types'

const compact = (value: number) => new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 }).format(value || 0)

export function DashboardPage({ analytics, keys, onOpenKeys }: { analytics: AnalyticsData | null; keys: ApiKeyItem[]; onOpenKeys: () => void }) {
  const summary = analytics?.summary
  const activeKeys = keys.filter((key) => key.enabled).length
  const cards = [
    { label: '请求总量', value: compact(summary?.requests || 0), meta: '所选统计周期', icon: Activity, tone: 'mint' },
    { label: 'Token 消耗', value: compact(summary?.tokens || 0), meta: '输入与输出合计', icon: ArrowUpRight, tone: 'blue' },
    { label: '活跃 API Key', value: String(activeKeys), meta: `共 ${keys.length} 个密钥`, icon: KeyRound, tone: 'purple' },
    { label: '平均延迟', value: `${Math.round(summary?.avgLatency || 0)} ms`, meta: '端到端响应时间', icon: Clock3, tone: 'amber' },
  ]
  return <div className="page-stack">
    <section className="hero-panel">
      <div><p className="eyebrow">CONTROL CENTER</p><h1>运行概览</h1><p>从一张图掌握请求、消耗、密钥和上游账号状态。</p></div>
      <div className="hero-health"><span className="live-dot" /><div><strong>网关运行正常</strong><small>CPA 数据通道已连接</small></div></div>
    </section>
    <section className="metric-grid">{cards.map(({ label, value, meta, icon: Icon, tone }) => <article className="metric-card" key={label}>
      <div className={`metric-icon ${tone}`}><Icon size={19} /></div><p>{label}</p><strong>{value}</strong><span>{meta}</span>
    </article>)}</section>
    <section className="dashboard-grid">
      <article className="panel chart-panel">
        <div className="panel-title"><div><h2>请求趋势</h2><p>按小时聚合成功请求与错误</p></div><span className="soft-badge">实时同步</span></div>
        <div className="chart-wrap"><ResponsiveContainer width="100%" height="100%"><AreaChart data={analytics?.trend || []}>
          <defs><linearGradient id="requestFill" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#6ee7b7" stopOpacity={0.35}/><stop offset="95%" stopColor="#6ee7b7" stopOpacity={0}/></linearGradient></defs>
          <CartesianGrid stroke="rgba(148,163,184,.12)" vertical={false}/><XAxis dataKey="bucket" tickFormatter={(value) => String(value).slice(11)} stroke="#64748b" tickLine={false} axisLine={false}/><YAxis stroke="#64748b" tickLine={false} axisLine={false}/><Tooltip contentStyle={{ background: '#111b29', border: '1px solid #263449', borderRadius: 14 }}/><Area type="monotone" dataKey="requests" stroke="#6ee7b7" strokeWidth={2.4} fill="url(#requestFill)"/></AreaChart></ResponsiveContainer></div>
      </article>
      <article className="panel quick-panel">
        <div className="panel-title"><div><h2>密钥健康度</h2><p>按最近使用情况排序</p></div><button className="text-button" onClick={onOpenKeys}>查看全部</button></div>
        <div className="quick-list">{keys.slice(0, 5).map((key) => <div className="quick-row" key={key.id}><div className={key.enabled ? 'status-orb online' : 'status-orb'} /><div><strong>{key.name}</strong><span>{key.lastUsedAt ? `最近调用 ${new Date(key.lastUsedAt).toLocaleString('zh-CN')}` : '尚无调用记录'}</span></div><span className={key.enabled ? 'status-chip success' : 'status-chip'}>{key.enabled ? '启用' : '停用'}</span></div>)}{!keys.length && <div className="empty-compact"><Server size={22}/><span>还没有 API Key</span></div>}</div>
      </article>
    </section>
    {(summary?.errorRate || 0) > .1 && <div className="warning-strip"><TriangleAlert size={18}/><span>当前错误率为 {((summary?.errorRate || 0) * 100).toFixed(1)}%，建议检查账号监控页。</span></div>}
  </div>
}
