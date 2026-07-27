import { Activity, Cloud, RefreshCw, ShieldCheck } from 'lucide-react'

const percent = (value: unknown) => typeof value === 'number' ? Math.max(0, Math.min(100, 100 - value)) : null

export function MonitorPage({ data, loading, onRefresh }: { data: { accounts?: Array<Record<string, any>> } | null; loading: boolean; onRefresh: () => void }) {
  return <div className="page-stack">
    <section className="page-heading"><div><p className="eyebrow">UPSTREAM ACCOUNTS</p><h1>账号监控</h1><p>查看 Claude 与 Codex OAuth 账号状态、套餐和滚动额度窗口。</p></div><button className="secondary-button" onClick={onRefresh} disabled={loading}><RefreshCw size={16} className={loading ? 'spin' : ''}/>刷新状态</button></section>
    <section className="monitor-grid">{data?.accounts?.map((account) => <AccountCard key={String(account.id || account.name)} account={account}/>)}</section>
    {!data?.accounts?.length && <section className="panel empty-state"><Cloud size={30}/><h3>暂未读取到账号</h3><p>确认 CPA 中已导入 Claude 或 Codex OAuth 凭据。</p></section>}
  </div>
}

function AccountCard({ account }: { account: Record<string, any> }) {
  const quota = account.quota || {}
  const isClaude = account.type === 'claude'
  const windows = isClaude ? [
    { label: '5 小时额度', data: quota.five_hour },
    { label: '7 天额度', data: quota.seven_day },
    { label: '7 天 Sonnet', data: quota.seven_day_sonnet },
  ] : [
    { label: '主要窗口', data: quota.rate_limit?.primary_window },
    { label: '次要窗口', data: quota.rate_limit?.secondary_window },
  ]
  return <article className={`account-card ${isClaude ? 'claude' : 'codex'}`}>
    <header><div className="account-logo">{isClaude ? 'AI' : 'O'}</div><div><span className="provider-name">{isClaude ? 'Claude' : 'Codex'}</span><h2>{account.email || account.account || account.name}</h2></div><span className={account.disabled ? 'status-chip' : 'status-chip success'}>{account.disabled ? '已停用' : '运行中'}</span></header>
    <div className="account-meta"><span><ShieldCheck size={15}/>OAuth 已连接</span><span><Activity size={15}/>{String(account.status || 'ready')}</span></div>
    <div className="quota-stack">{windows.filter((window) => window.data).map((window) => { const remaining = percent(window.data?.utilization ?? window.data?.used_percent); return <div className="quota-row" key={window.label}><div><strong>{window.label}</strong><span>{window.data?.resets_at ? `重置于 ${new Date(window.data.resets_at).toLocaleString('zh-CN')}` : '滚动窗口'}</span></div><div className="quota-value"><strong>{remaining === null ? '--' : `${Math.round(remaining)}%`}</strong><span>剩余</span></div><div className="progress-track"><span style={{ width: `${remaining ?? 0}%` }}/></div></div> })}</div>
    {quota.error && <p className="form-error">{quota.error}</p>}
  </article>
}
