import { Activity, BarChart3, KeyRound, LayoutDashboard, LogOut, RefreshCw, ShieldCheck, Sparkles } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import './App.css'
import { api } from './api'
import { AnalyticsPage } from './pages/AnalyticsPage'
import { DashboardPage } from './pages/DashboardPage'
import { KeysPage } from './pages/KeysPage'
import { LoginPage } from './pages/LoginPage'
import { MonitorPage } from './pages/MonitorPage'
import type { AnalyticsData, ApiKeyItem, BootstrapData } from './types'

type Page = 'dashboard' | 'keys' | 'analytics' | 'monitor'

export default function App() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null)
  const [page, setPage] = useState<Page>('dashboard')
  const [bootstrap, setBootstrap] = useState<BootstrapData | null>(null)
  const [analytics, setAnalytics] = useState<AnalyticsData | null>(null)
  const [monitor, setMonitor] = useState<any>(null)
  const [days, setDays] = useState(7)
  const [keyId, setKeyId] = useState('')
  const [loading, setLoading] = useState(false)
  const [toast, setToast] = useState('')

  useEffect(() => { api.session().then((result) => setAuthenticated(result.authenticated)).catch(() => setAuthenticated(false)) }, [])
  const loadBootstrap = useCallback(async () => setBootstrap(await api.bootstrap<BootstrapData>()), [])
  const loadAnalytics = useCallback(async () => setAnalytics(await api.analytics<AnalyticsData>(days, keyId)), [days, keyId])
  const loadMonitor = useCallback(async () => { setLoading(true); try { setMonitor(await api.monitor()) } finally { setLoading(false) } }, [])
  useEffect(() => { if (authenticated) { void loadBootstrap(); void loadAnalytics() } }, [authenticated, loadBootstrap, loadAnalytics])
  useEffect(() => { if (authenticated && page === 'monitor') void loadMonitor() }, [authenticated, page, loadMonitor])
  useEffect(() => { if (authenticated) void loadAnalytics() }, [authenticated, loadAnalytics])

  if (authenticated === null) return <div className="splash"><Sparkles/><span>正在载入控制台</span></div>
  if (!authenticated) return <LoginPage onSuccess={() => setAuthenticated(true)} />

  const navigate = (next: Page) => setPage(next)
  const selectKey = (key: ApiKeyItem) => { setKeyId(key.id); setPage('analytics') }
  const refresh = async () => { await Promise.all([loadBootstrap(), loadAnalytics()]); setToast('数据已刷新'); setTimeout(() => setToast(''), 1800) }
  const nav = [
    { id: 'dashboard' as const, label: '运行概览', icon: LayoutDashboard },
    { id: 'keys' as const, label: 'API Key', icon: KeyRound },
    { id: 'analytics' as const, label: '使用统计', icon: BarChart3 },
    { id: 'monitor' as const, label: '账号监控', icon: Activity },
  ]
  return <div className="app-shell">
    <aside className="sidebar">
      <div className="sidebar-brand"><div className="brand-mark small"><Sparkles size={17}/></div><div><strong>Crosery</strong><span>API Console</span></div></div>
      <nav>{nav.map(({ id, label, icon: Icon }) => <button key={id} className={page === id ? 'nav-item active' : 'nav-item'} onClick={() => navigate(id)}><Icon size={18}/><span>{label}</span></button>)}</nav>
      <div className="sidebar-foot"><div className="gateway-status"><span className="live-dot"/><div><strong>CPA Gateway</strong><small>在线</small></div></div><button className="nav-item logout" onClick={async () => { await api.logout(); setAuthenticated(false) }}><LogOut size={17}/><span>退出登录</span></button></div>
    </aside>
    <main className="main-content">
      <header className="topbar"><div className="crumb"><ShieldCheck size={16}/><span>console.ai.crosery.com</span></div><button className="icon-button top-refresh" onClick={refresh} title="刷新"><RefreshCw size={17}/></button></header>
      <div className="page-content">
        {page === 'dashboard' && <DashboardPage analytics={analytics} keys={bootstrap?.keys || []} onOpenKeys={() => navigate('keys')}/>} 
        {page === 'keys' && <KeysPage keys={bootstrap?.keys || []} groups={bootstrap?.groups || []} onRefresh={refresh} onSelectKey={selectKey}/>} 
        {page === 'analytics' && <AnalyticsPage analytics={analytics} keys={bootstrap?.keys || []} groups={bootstrap?.groups || []} days={days} setDays={setDays} keyId={keyId} setKeyId={setKeyId}/>} 
        {page === 'monitor' && <MonitorPage data={monitor} loading={loading} onRefresh={loadMonitor}/>} 
      </div>
    </main>
    {toast && <div className="toast"><ShieldCheck size={16}/>{toast}</div>}
  </div>
}
