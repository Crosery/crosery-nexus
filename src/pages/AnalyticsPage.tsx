import { BarChart3, CircleGauge, KeyRound, Timer, Waypoints } from 'lucide-react'
import { useState } from 'react'
import { Area, AreaChart, Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { RequestDetail } from '../components/RequestDetail'
import { Select } from '../components/Select'
import type { AnalyticsData, ApiKeyItem, Group } from '../types'

const compact = (value: number) => new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 }).format(value || 0)

export function AnalyticsPage({ analytics, keys, groups, days, setDays, keyId, setKeyId }: { analytics: AnalyticsData | null; keys: ApiKeyItem[]; groups: Group[]; days: number; setDays: (days: number) => void; keyId: string; setKeyId: (id: string) => void }) {
  const [selectedRequest, setSelectedRequest] = useState<AnalyticsData['requests'][number] | null>(null)
  const summary = analytics?.summary
  const cards = [
    { label: '请求量', value: compact(summary?.requests || 0), icon: Waypoints },
    { label: 'Token', value: compact(summary?.tokens || 0), icon: BarChart3 },
    { label: '错误率', value: `${((summary?.errorRate || 0) * 100).toFixed(1)}%`, icon: CircleGauge },
    { label: '平均延迟', value: `${Math.round(summary?.avgLatency || 0)} ms`, icon: Timer },
  ]
  return <div className="page-stack">
    <section className="page-heading"><div><p className="eyebrow">OBSERVABILITY</p><h1>使用统计</h1><p>按 API Key、渠道和模型分析调用量、Token 与错误趋势。</p></div><div className="heading-filters"><Select ariaLabel="选择 API Key" value={keyId} onChange={setKeyId} options={[{ value: '', label: '全部 API Key' }, ...keys.map((key) => ({ value: key.id, label: key.name }))]}/><Select ariaLabel="选择统计周期" value={String(days)} onChange={(value) => setDays(Number(value))} options={[{ value: '1', label: '最近 24 小时' }, { value: '7', label: '最近 7 天' }, { value: '30', label: '最近 30 天' }, { value: '90', label: '最近 90 天' }]}/></div></section>
    <section className="metric-grid analytics-metrics">{cards.map(({ label, value, icon: Icon }) => <article className="metric-card compact" key={label}><div className="metric-icon blue"><Icon size={18}/></div><p>{label}</p><strong>{value}</strong></article>)}</section>
    <section className="analytics-grid">
      <article className="panel chart-panel wide-chart"><div className="panel-title"><div><h2>请求与错误趋势</h2><p>每小时请求总量与失败请求</p></div></div><div className="chart-wrap tall"><ResponsiveContainer width="100%" height="100%"><AreaChart data={analytics?.trend || []}><defs><linearGradient id="a" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#60a5fa" stopOpacity=".35"/><stop offset="1" stopColor="#60a5fa" stopOpacity="0"/></linearGradient></defs><CartesianGrid stroke="rgba(148,163,184,.12)" vertical={false}/><XAxis dataKey="bucket" tickFormatter={(value) => String(value).slice(5, 13)} stroke="#64748b" tickLine={false} axisLine={false}/><YAxis stroke="#64748b" tickLine={false} axisLine={false}/><Tooltip contentStyle={{ background: '#111b29', border: '1px solid #263449', borderRadius: 14 }}/><Area dataKey="requests" stroke="#60a5fa" strokeWidth={2.2} fill="url(#a)"/><Area dataKey="errors" stroke="#fb7185" strokeWidth={1.8} fill="transparent"/></AreaChart></ResponsiveContainer></div></article>
      <article className="panel chart-panel"><div className="panel-title"><div><h2>渠道分布</h2><p>按请求量排序</p></div></div><div className="chart-wrap tall"><ResponsiveContainer width="100%" height="100%"><BarChart data={analytics?.groups || []} layout="vertical"><CartesianGrid stroke="rgba(148,163,184,.10)" horizontal={false}/><XAxis type="number" hide/><YAxis type="category" dataKey="name" tickFormatter={(id) => groups.find((group) => group.id === id)?.name || id} width={64} stroke="#94a3b8" tickLine={false} axisLine={false}/><Tooltip contentStyle={{ background: '#111b29', border: '1px solid #263449', borderRadius: 14 }}/><Bar dataKey="requests" fill="#6ee7b7" radius={[0,8,8,0]}/></BarChart></ResponsiveContainer></div></article>
    </section>
    <section className="panel ranking-panel"><div className="panel-title"><div><h2>API Key 使用排行</h2><p>快速定位高频调用方与异常错误率</p></div><KeyRound size={20}/></div><div className="ranking-list">{analytics?.keyUsage.map((item, index) => <div className="ranking-row" key={item.id}><span className="rank">{String(index + 1).padStart(2, '0')}</span><strong>{item.name}</strong><div className="ranking-bar"><span style={{ width: `${Math.min(100, item.requests / Math.max(1, analytics.keyUsage[0]?.requests) * 100)}%` }}/></div><span>{compact(item.requests)} 请求</span><span className={item.errorRate > .1 ? 'danger-text' : 'muted'}>{(item.errorRate * 100).toFixed(1)}% 错误</span></div>)}</div></section>
    <section className="panel request-panel"><div className="panel-title"><div><h2>请求明细</h2><p>显示最近 200 条请求；点击一行查看状态、耗时、Token、错误正文和上游请求 ID。</p></div></div><div className="request-table"><div className="request-row request-head"><span>时间</span><span>模型</span><span>状态</span><span>耗时</span><span>Token</span><span>请求 ID</span></div>{analytics?.requests?.map((request) => <button type="button" className="request-row" key={`${request.requestId}-${request.timestamp}`} onClick={() => setSelectedRequest(request)}><span>{new Date(request.timestamp).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span><strong>{request.model}</strong><span className={request.success ? 'request-status success' : 'request-status failure'}>{request.success ? request.statusCode : `失败 ${request.statusCode}`}</span><span>{Math.round(request.latencyMs / 1000)}s</span><span>{compact(request.totalTokens)}</span><code>{request.requestId}</code></button>)}</div></section>
    {selectedRequest && <RequestDetail request={selectedRequest} onClose={() => setSelectedRequest(null)} />}
  </div>
}
