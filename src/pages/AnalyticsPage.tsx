import { BarChart3, CircleGauge, Timer, Waypoints } from 'lucide-react'
import { useState } from 'react'
import { RequestDetail } from '../components/RequestDetail'
import { Select } from '../components/Select'
import { CLIENT_LABELS } from '../clientLabels'
import { compact, ms, PRIMARY, STATUS } from '../chartTheme'
import type { AnalyticsData, ApiKeyItem } from '../types'

export function AnalyticsPage({ analytics, keys, days, setDays, keyId, setKeyId }: { analytics: AnalyticsData | null; keys: ApiKeyItem[]; days: number; setDays: (days: number) => void; keyId: string; setKeyId: (id: string) => void }) {
  const [selectedRequest, setSelectedRequest] = useState<AnalyticsData['requests'][number] | null>(null)
  const summary = analytics?.summary
  const keyUsage = analytics?.keyUsage ?? []
  const clients = analytics?.clients ?? []

  const cards = [
    { label: '请求量', value: compact(summary?.requests || 0), icon: Waypoints, tone: 'blue' },
    { label: 'Token', value: compact(summary?.tokens || 0), icon: BarChart3, tone: 'mint' },
    { label: '错误率', value: `${((summary?.errorRate || 0) * 100).toFixed(1)}%`, icon: CircleGauge, tone: (summary?.errorRate || 0) > 0.05 ? 'amber' : 'mint' },
    { label: '平均延迟', value: ms(summary?.avgLatency || 0), icon: Timer, tone: 'purple' },
  ]


  return <div className="page-stack">
    <section className="page-heading">
      <div><p className="eyebrow">OBSERVABILITY</p><h1>使用统计</h1><p>按 API Key、渠道和模型分析调用量、Token 与错误趋势。</p></div>
      <div className="heading-filters">
        <Select ariaLabel="选择 API Key" value={keyId} onChange={setKeyId} options={[{ value: '', label: '全部 API Key' }, ...keys.map((key) => ({ value: key.id, label: key.name }))]} />
        <Select ariaLabel="选择统计周期" value={String(days)} onChange={(value) => setDays(Number(value))} options={[{ value: '1', label: '最近 24 小时' }, { value: '7', label: '最近 7 天' }, { value: '30', label: '最近 30 天' }, { value: '90', label: '最近 90 天' }]} />
      </div>
    </section>

    <section className="metric-grid analytics-metrics">
      {cards.map(({ label, value, icon: Icon, tone }) => <article className="metric-card compact" key={label}>
        <div className={`metric-icon ${tone}`}><Icon size={18} /></div><p>{label}</p><strong>{value}</strong>
      </article>)}
    </section>

    <section className="analytics-bottom fill">
      <article className="panel ranking-panel fill">
        <div className="panel-title"><div><h2>API Key 使用排行</h2><p>高频调用方与异常错误率</p></div><span className="soft-badge">{analytics?.keyUsage?.length || 0} 个 Key</span></div>
        <div className="ranking-list scroll-area">
          {keyUsage.map((item, index) => {
            const top = Math.max(1, keyUsage[0]?.requests || 1)
            const bad = item.errorRate > 0.1
            return <div className="ranking-row" key={item.id}>
              <span className="rank">{String(index + 1).padStart(2, '0')}</span>
              <strong title={item.name}>{item.name}</strong>
              <div className="ranking-bar"><span style={{ width: `${Math.max(2, Math.min(100, item.requests / top * 100))}%`, background: bad ? STATUS.danger : PRIMARY }} /></div>
              <span className="ranking-value">{compact(item.requests)}</span>
              <span className={bad ? 'ranking-err bad' : 'ranking-err'}>{(item.errorRate * 100).toFixed(1)}%</span>
            </div>
          })}
        </div>

        {/* 调用方分布：同一把 Key 可能同时被 Pi、Claude Code 和脚本使用，
            只看 Key 排行看不出到底是哪个客户端在消耗额度。 */}
        <div className="panel-title client-split"><div><h2>调用客户端</h2><p>按客户端统计请求频率与 Token</p></div><span className="soft-badge">{clients.length} 类</span></div>
        <div className="ranking-list scroll-area">
          {clients.length === 0 && <p className="muted">区间内没有记录到调用方信息。</p>}
          {clients.map((item, index) => {
            const top = Math.max(1, clients[0]?.requests || 1)
            const bad = item.errorRate > 0.1
            return <div className="ranking-row" key={item.type}>
              <span className="rank">{String(index + 1).padStart(2, '0')}</span>
              <strong title={item.label}>{item.label}</strong>
              <div className="ranking-bar"><span style={{ width: `${Math.max(2, Math.min(100, item.requests / top * 100))}%`, background: bad ? STATUS.danger : PRIMARY }} /></div>
              <span className="ranking-value">{compact(item.requests)}</span>
              <span className={bad ? 'ranking-err bad' : 'ranking-err'}>{(item.errorRate * 100).toFixed(1)}%</span>
            </div>
          })}
        </div>
      </article>

      <article className="panel request-panel fill">
        <div className="panel-title"><div><h2>请求明细</h2><p>点击一行查看耗时、Token、错误正文与上游请求 ID</p></div><span className="soft-badge">{analytics?.requests?.length || 0} 条</span></div>
        <div className="request-table scroll-area">
          <div className="request-row request-head"><span>时间</span><span>模型</span><span>客户端</span><span>状态</span><span>耗时</span><span>Token</span><span>请求 ID</span></div>
          {analytics?.requests?.map((request) => <button type="button" className={request.success ? 'request-row' : 'request-row failed'} key={`${request.requestId}-${request.timestamp}`} onClick={() => setSelectedRequest(request)}>
            <span className="req-time">{new Date(request.timestamp).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
            <strong title={request.model}>{request.model}</strong>
            <span className="req-client" title={request.userAgent || '未上报'}>{CLIENT_LABELS[request.clientType || 'unknown'] || '未知'}</span>
            <span className={request.success ? 'request-status success' : 'request-status failure'}>{request.success ? (request.statusCode ?? '—') : `失败 ${request.statusCode ?? '—'}`}</span>
            <span className="req-num">{ms(request.latencyMs)}</span>
            <span className="req-num">{compact(request.totalTokens ?? 0)}</span>
            <code>{request.requestId}</code>
          </button>)}
        </div>
      </article>
    </section>
    {selectedRequest && <RequestDetail request={selectedRequest} onClose={() => setSelectedRequest(null)} />}
  </div>
}
