import { Activity, Coins, Database, KeyRound } from 'lucide-react'
import { useState } from 'react'
import { Select } from './Select'
import type { ApiKeyItem, UsageBreakdownData } from '../types'

const tokens = (value: number) => new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 }).format(value || 0)
const money = (value: number) => value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`

export function UsageQueryDialog({ keys, data, days, onDaysChange, keyId, onKeyChange, loading }: {
  keys: ApiKeyItem[]
  data: UsageBreakdownData | null
  days: number
  onDaysChange: (days: number) => void
  keyId: string
  onKeyChange: (keyId: string) => void
  loading: boolean
}) {
  const [open, setOpen] = useState(false)
  const selectedName = keys.find((key) => key.id === keyId)?.name || '全部 API Key'
  return <>
    <button type="button" className="icon-button" title="查询 API Key 用量" onClick={() => setOpen(true)}><Activity size={17}/></button>
    {open && <div className="popover-backdrop">
      <button type="button" className="popover-dismiss" aria-label="关闭用量查询" onClick={() => setOpen(false)} />
      <aside className="usage-query-drawer" role="dialog" aria-modal="true" aria-label="API Key 用量查询">
        <div className="usage-query-head"><div><KeyRound size={18}/><span><strong>用量查询</strong><small>{selectedName}</small></span></div><button type="button" className="icon-button" onClick={() => setOpen(false)}>×</button></div>
        <div className="usage-query-filters">
          <Select ariaLabel="选择 API Key" value={keyId} onChange={onKeyChange} options={[{ value: '', label: '全部 API Key' }, ...keys.map((key) => ({ value: key.id, label: key.name }))]} />
          <Select ariaLabel="选择统计周期" value={String(days)} onChange={(value) => onDaysChange(Number(value))} options={[{ value: '1', label: '最近 24 小时' }, { value: '7', label: '最近 7 天' }, { value: '30', label: '最近 30 天' }, { value: '90', label: '最近 90 天' }]} />
        </div>
        {loading ? <div className="empty-state compact"><Activity className="spin" size={24}/><h3>正在查询</h3></div> : <>
          <div className="usage-query-summary">
            <div><Activity size={14}/><span>请求</span><strong>{(data?.totals.requests || 0).toLocaleString('zh-CN')}</strong></div>
            <div><Database size={14}/><span>token</span><strong>{tokens(data?.totals.totalTokens || 0)}</strong></div>
            <div><Coins size={14}/><span>花费</span><strong>{money(data?.totals.totalCostUsd || 0)}{data?.unpricedModels.length ? '+' : ''}</strong></div>
          </div>
          <div className="usage-query-models scroll-area">
            {(data?.models || []).map((model) => <div key={model.model}>
              <span><strong>{model.model}</strong><small>{tokens(model.totalTokens)} token · {model.requests} 次</small></span>
              <b>{model.totalCostUsd === null ? '未定价' : money(model.totalCostUsd)}</b>
            </div>)}
            {!data?.models.length && <div className="empty-state compact"><Database size={24}/><h3>当前周期没有用量</h3></div>}
          </div>
        </>}
      </aside>
    </div>}
  </>
}
