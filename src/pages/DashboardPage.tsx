import { Activity, ArrowUpRight, Clock3, KeyRound, Server, TriangleAlert } from 'lucide-react'
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { Select } from '../components/Select'
import { emptyKeyListCopy, gatewayStatusCopy, type DashboardState, type GatewayState } from '../gatewayStatus'
import type { ApiKeyItem, DashboardData } from '../types'

const compact = (value: number) => new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 }).format(value || 0)

export function DashboardPage({ analytics, keys, keyId, setKeyId, gatewayState, gatewayEngine, dashboardState, onOpenKeys }: { analytics: DashboardData | null; keys: ApiKeyItem[]; keyId: string; setKeyId: (id: string) => void; gatewayState: GatewayState; gatewayEngine?: 'cpa' | 'magpie'; dashboardState: DashboardState; onOpenKeys: () => void }) {
  const summary = analytics?.summary
  const activeKeys = keys.filter((key) => key.enabled).length
  const selectedKey = keys.find((key) => key.id === keyId)
  const scope = selectedKey ? `仅 ${selectedKey.name}` : '全部 API Key'
  const gatewayCopy = gatewayStatusCopy(gatewayState, gatewayEngine)
  const analyticsMeta = dashboardState === 'loading' ? '正在读取数据' : '数据暂时不可用'
  const keysAvailable = gatewayState === 'online' || keys.length > 0
  const emptyKeysCopy = emptyKeyListCopy(gatewayState, keys.length)
  const cards = [
    { label: '请求总量', value: analytics ? compact(summary?.requests || 0) : '—', meta: analytics ? scope : analyticsMeta, icon: Activity, tone: 'mint' },
    { label: 'Token 消耗', value: analytics ? compact(summary?.tokens || 0) : '—', meta: analytics ? '输入与输出合计' : analyticsMeta, icon: ArrowUpRight, tone: 'blue' },
    { label: '活跃 API Key', value: keysAvailable ? String(activeKeys) : '—', meta: keysAvailable ? `共 ${keys.length} 个密钥` : '密钥数据暂时不可用', icon: KeyRound, tone: 'purple' },
    { label: '平均延迟', value: analytics ? `${Math.round(summary?.avgLatency || 0)} ms` : '—', meta: analytics ? '端到端响应时间' : analyticsMeta, icon: Clock3, tone: 'amber' },
  ]
  return <div className="page-stack">
    <section className="hero-panel">
      <div><p className="eyebrow">CONTROL CENTER</p><h1>运行概览</h1><p>从一张图掌握请求、消耗、密钥和上游账号状态。</p></div>
      <div className="hero-tools">
        <Select ariaLabel="选择 API Key" value={keyId} onChange={setKeyId} options={[{ value: '', label: '全部 API Key' }, ...keys.map((key) => ({ value: key.id, label: key.name }))]} />
        <div className={`hero-health ${gatewayState}`} role="status"><span className={`live-dot ${gatewayState}`} /><div><strong>{gatewayCopy.title}</strong><small>{gatewayCopy.detail}</small></div></div>
      </div>
    </section>
    {dashboardState === 'unavailable' && <div className="warning-strip" role="alert"><TriangleAlert size={18}/><span>{analytics ? '实时数据刷新失败，当前保留上次成功结果。' : '控制台暂时无法读取网关统计数据。'}</span></div>}
    <section className="metric-grid">{cards.map(({ label, value, meta, icon: Icon, tone }) => <article className="metric-card" key={label}>
      <div className={`metric-icon ${tone}`}><Icon size={19} /></div><p>{label}</p><strong>{value}</strong><span>{meta}</span>
    </article>)}</section>
    <section className="dashboard-grid fill">
      <article className="panel chart-panel">
        <div className="panel-title"><div><h2>请求趋势</h2><p>按小时聚合成功请求与错误</p></div><span className="soft-badge">{dashboardState === 'ready' ? analytics?.stale ? '后台更新' : analytics?.source === 'data-plane' ? '高速快照' : '实时同步' : dashboardState === 'loading' ? '读取中' : '不可用'}</span></div>
        <div className="chart-wrap">{analytics ? <ResponsiveContainer width="100%" height="100%"><AreaChart data={analytics.trend || []}>
          <defs><linearGradient id="requestFill" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#6ee7b7" stopOpacity={0.35}/><stop offset="95%" stopColor="#6ee7b7" stopOpacity={0}/></linearGradient></defs>
          <CartesianGrid stroke="rgba(148,163,184,.12)" vertical={false}/><XAxis dataKey="bucket" tickFormatter={(value) => String(value).slice(11)} stroke="#64748b" tickLine={false} axisLine={false}/><YAxis stroke="#64748b" tickLine={false} axisLine={false}/><Tooltip contentStyle={{ background: '#111b29', border: '1px solid #263449', borderRadius: 14 }}/><Area type="monotone" dataKey="requests" stroke="#6ee7b7" strokeWidth={2.4} fill="url(#requestFill)"/></AreaChart></ResponsiveContainer>
          : <div className="dashboard-data-state" role="status"><Activity size={21}/><span>{dashboardState === 'loading' ? '正在读取请求趋势' : '请求趋势暂时不可用'}</span></div>}</div>
      </article>
      <article className="panel quick-panel">
        <div className="panel-title"><div><h2>密钥健康度</h2><p>按最近使用情况排序</p></div><button className="text-button" onClick={onOpenKeys}>查看全部</button></div>
        <div className="quick-list">{keys.slice(0, 5).map((key) => <div className="quick-row" key={key.id}><div className={key.enabled ? 'status-orb online' : 'status-orb'} /><div><strong>{key.name}</strong><span>{key.lastUsedAt ? `最近调用 ${new Date(key.lastUsedAt).toLocaleString('zh-CN')}` : '尚无调用记录'}</span></div><span className={key.enabled ? 'status-chip success' : 'status-chip'}>{key.enabled ? '启用' : '停用'}</span></div>)}{emptyKeysCopy && <div className="empty-compact" role="status"><Server size={22}/><span>{emptyKeysCopy}</span></div>}</div>
      </article>
    </section>
    {(summary?.errorRate || 0) > .1 && <div className="warning-strip"><TriangleAlert size={18}/><span>当前错误率为 {((summary?.errorRate || 0) * 100).toFixed(1)}%，建议检查账号监控页。</span></div>}
  </div>
}
