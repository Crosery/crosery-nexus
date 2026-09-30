import { Activity, BarChart3, CircleHelp, Cpu, Gauge, Globe, KeyRound, LayoutDashboard, Layers, LogOut, RefreshCw, ShieldCheck, Sparkles, Table2, TriangleAlert } from 'lucide-react'
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import './App.css'
import { api } from './api'
import { analyticsScopeKey, dataForScope, gatewayStatusCopy, type DashboardState, type GatewayState } from './gatewayStatus'
import type { CacheTrendData, AnalyticsData, ApiKeyItem, BootstrapData, ChannelsData, ChartsData, DashboardData, ModelIndexData, MonitorData, UsageBreakdownData, UsageKeySummariesData, UsagePageCoreData, UsagePageData } from './types'

const AnalyticsPage = lazy(() => import('./pages/AnalyticsPage').then((module) => ({ default: module.AnalyticsPage })))
const ChannelsPage = lazy(() => import('./pages/ChannelsPage').then((module) => ({ default: module.ChannelsPage })))
const ModelsPage = lazy(() => import('./pages/ModelsPage').then((module) => ({ default: module.ModelsPage })))
const ChartsPage = lazy(() => import('./pages/ChartsPage').then((module) => ({ default: module.ChartsPage })))
const DashboardPage = lazy(() => import('./pages/DashboardPage').then((module) => ({ default: module.DashboardPage })))
const HelpPage = lazy(() => import('./pages/HelpPage').then((module) => ({ default: module.HelpPage })))
const KeysPage = lazy(() => import('./pages/KeysPage').then((module) => ({ default: module.KeysPage })))
const LoginPage = lazy(() => import('./pages/LoginPage').then((module) => ({ default: module.LoginPage })))
const MonitorPage = lazy(() => import('./pages/MonitorPage').then((module) => ({ default: module.MonitorPage })))
const UsagePage = lazy(() => import('./pages/UsagePage').then((module) => ({ default: module.UsagePage })))
const CachePage = lazy(() => import('./pages/CachePage').then((module) => ({ default: module.CachePage })))
const OAuthPage = lazy(() => import('./pages/OAuthPage').then((module) => ({ default: module.OAuthPage })))
import { VersionWidget } from './components/VersionWidget'

type Page = 'dashboard' | 'keys' | 'channels' | 'oauth' | 'models' | 'charts' | 'analytics' | 'usage' | 'cache' | 'monitor' | 'help'
type ProgressiveState = 'idle' | 'loading' | 'ready' | 'error'

export default function App() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null)
  const [page, setPage] = useState<Page>('dashboard')
  const [bootstrap, setBootstrap] = useState<BootstrapData | null>(null)
  const [dashboard, setDashboard] = useState<DashboardData | null>(null)
  const [dashboardScope, setDashboardScope] = useState('')
  const [analytics, setAnalytics] = useState<AnalyticsData | null>(null)
  const [analyticsScope, setAnalyticsScope] = useState('')
  const [charts, setCharts] = useState<ChartsData | null>(null)
  const [chartsScope, setChartsScope] = useState('')
  const [chartsLatencyState, setChartsLatencyState] = useState<ProgressiveState>('idle')
  const [gatewayState, setGatewayState] = useState<GatewayState>('checking')
  const [dashboardState, setDashboardState] = useState<DashboardState>('loading')
  const [monitor, setMonitor] = useState<MonitorData | null>(null)
  const [channels, setChannels] = useState<ChannelsData | null>(null)
  const [channelsLoading, setChannelsLoading] = useState(false)
  const [modelIndex, setModelIndex] = useState<ModelIndexData | null>(null)
  const [modelsLoading, setModelsLoading] = useState(false)
  const [usage, setUsage] = useState<UsagePageData | null>(null)
  const [usageScope, setUsageScope] = useState('')
  const [usageBreakdown, setUsageBreakdown] = useState<UsageBreakdownData | null>(null)
  const [usageBreakdownScope, setUsageBreakdownScope] = useState('')
  const [usageKeySummariesState, setUsageKeySummariesState] = useState<ProgressiveState>('idle')
  const [usageLoading, setUsageLoading] = useState(false)
  const [breakdownLoading, setBreakdownLoading] = useState(false)
  const [cacheTrend, setCacheTrend] = useState<CacheTrendData | null>(null)
  const [cacheScope, setCacheScope] = useState('')
  const [cacheLoading, setCacheLoading] = useState(false)
  const [cacheHours, setCacheHours] = useState(24)
  const [cacheModel, setCacheModel] = useState('')
  const [cacheClient, setCacheClient] = useState('')
  const [cacheKeyId, setCacheKeyId] = useState('')
  const [cacheProvider, setCacheProvider] = useState('')
  const [days, setDays] = useState(7)
  const [keyId, setKeyId] = useState('')
  const [loading, setLoading] = useState(false)
  const [toast, setToast] = useState('')
  const analyticsRequest = useRef(0)
  const analyticsScopeRef = useRef('')
  const dashboardRequest = useRef(0)
  const dashboardScopeRef = useRef('')
  const chartsRequest = useRef(0)
  const chartsScopeRef = useRef('')
  const usageRequest = useRef(0)
  const usageScopeRef = useRef('')
  const breakdownRequest = useRef(0)
  const cacheRequest = useRef(0)
  const cacheScopeRef = useRef('')

  useEffect(() => { api.session().then((result) => setAuthenticated(result.authenticated)).catch(() => setAuthenticated(false)) }, [])
  /**
   * silent：轮询时静默刷新 Key 与额度条，不把网关状态翻回「检查中」。
   * bootstrap 在控制面故障时会降级返回（degraded），Key/额度仍来自本地库，
   * 此时网关状态按不可用显示，但列表不会因此被清空或停留在旧值。
   */
  const loadBootstrap = useCallback(async (silent = false) => {
    if (!silent) setGatewayState((current) => current === 'online' ? current : 'checking')
    try {
      const result = await api.bootstrap<BootstrapData>()
      setBootstrap(result)
      setGatewayState(result.degraded || (result.versions?.cpa?.engine === 'magpie' && result.versions.cpa.version === 'offline') ? 'unavailable' : 'online')
      return !result.degraded
    } catch {
      setGatewayState('unavailable')
      return false
    }
  }, [])
  const loadAnalytics = useCallback(async () => {
    const scope = analyticsScopeKey(days, keyId)
    const request = ++analyticsRequest.current
    try {
      const result = await api.analytics<AnalyticsData>(days, keyId)
      if (request !== analyticsRequest.current) return null
      analyticsScopeRef.current = scope
      setAnalytics(result)
      setAnalyticsScope(scope)
      return true
    } catch {
      return request !== analyticsRequest.current ? null : false
    }
  }, [days, keyId])
  const loadCharts = useCallback(async () => {
    const scope = analyticsScopeKey(days, keyId)
    const request = ++chartsRequest.current
    setChartsLatencyState('loading')
    try {
      const result = await api.charts<ChartsData>(days, keyId)
      if (request !== chartsRequest.current) return null
      const keepLatency = chartsScopeRef.current === scope
      chartsScopeRef.current = scope
      setCharts((current) => ({
        ...result,
        latency: keepLatency ? current?.latency || [] : [],
      }))
      setChartsScope(scope)
      const latencyResult = await api.chartsLatency<Pick<ChartsData, 'days' | 'latency'>>(days, keyId)
      if (request !== chartsRequest.current || chartsScopeRef.current !== scope) return null
      if (latencyResult.days !== result.days) {
        setChartsLatencyState('error')
        return false
      }
      setCharts((current) => current ? { ...current, latency: latencyResult.latency } : current)
      setChartsLatencyState('ready')
      return true
    } catch {
      if (request === chartsRequest.current) setChartsLatencyState('error')
      return request !== chartsRequest.current ? null : false
    }
  }, [days, keyId])
  const loadDashboard = useCallback(async () => {
    const scope = analyticsScopeKey(days, keyId)
    const request = ++dashboardRequest.current
    if (dashboardScopeRef.current !== scope) setDashboardState('loading')
    try {
      const result = await api.dashboard<DashboardData>(days, keyId)
      if (request !== dashboardRequest.current) return null
      dashboardScopeRef.current = scope
      setDashboard(result)
      setDashboardScope(scope)
      setDashboardState('ready')
      return true
    } catch {
      if (request !== dashboardRequest.current) return null
      setDashboardState('unavailable')
      return false
    }
  }, [days, keyId])
  const loadMonitor = useCallback(async (silent = false) => { if (!silent) setLoading(true); try { setMonitor(await api.monitor<MonitorData>()) } finally { if (!silent) setLoading(false) } }, [])
  useEffect(() => { if (authenticated) void loadBootstrap() }, [authenticated, loadBootstrap])
  // 刷新按钮带 fresh：先丢掉服务端网关快照，CPA 官方面板里的改动才不会滞后；进入页面时沿用短期快照即可。
  const loadChannels = useCallback(async (fresh = false, silent = false) => { if (!silent) setChannelsLoading(true); try { setChannels(await api.channels<ChannelsData>(fresh)) } catch { if (!silent) throw new Error('渠道读取失败') } finally { if (!silent) setChannelsLoading(false) } }, [])
  useEffect(() => { if (authenticated && page === 'monitor') void loadMonitor() }, [authenticated, page, loadMonitor])
  const loadUsageBreakdown = useCallback(async (silent = false) => {
    const scope = analyticsScopeKey(days, keyId)
    const request = ++breakdownRequest.current
    if (!silent) setBreakdownLoading(true)
    try {
      const result = await api.usageBreakdown<UsageBreakdownData>(days, keyId)
      if (request !== breakdownRequest.current) return null
      setUsageBreakdown(result)
      setUsageBreakdownScope(scope)
      return true
    } catch {
      return request !== breakdownRequest.current ? null : false
    } finally {
      if (request === breakdownRequest.current) setBreakdownLoading(false)
    }
  }, [days, keyId])
  const loadModelIndex = useCallback(async (fresh = false, silent = false) => { if (!silent) setModelsLoading(true); try { await Promise.all([api.modelIndex<ModelIndexData>(fresh).then(setModelIndex), loadUsageBreakdown(silent)]) } catch { if (!silent) throw new Error('模型总览读取失败') } finally { if (!silent) setModelsLoading(false) } }, [loadUsageBreakdown])
  useEffect(() => { if (authenticated && page === 'channels') void loadChannels() }, [authenticated, page, loadChannels])
  useEffect(() => { if (authenticated && (page === 'models' || page === 'help')) void loadModelIndex() }, [authenticated, page, loadModelIndex])
  useEffect(() => { if (authenticated && page === 'keys') void loadUsageBreakdown() }, [authenticated, page, loadUsageBreakdown])
  const loadUsage = useCallback(async (silent = false) => {
    const scope = analyticsScopeKey(days, keyId)
    const request = ++usageRequest.current
    const core = api.usagePage<UsagePageCoreData>(days, keyId)
    const keySummaries = keyId
      ? null
      : api.usageKeySummaries<UsageKeySummariesData>(days)
          .then((value) => ({ ok: true as const, value }))
          .catch(() => ({ ok: false as const }))
    setUsageKeySummariesState(keySummaries ? 'loading' : 'idle')
    if (!silent) setUsageLoading(true)
    try {
      const result = await core
      if (request !== usageRequest.current) return null
      const keepKeySummaries = usageScopeRef.current === scope
      usageScopeRef.current = scope
      setUsage((current) => ({
        ...result,
        keySummaries: keepKeySummaries ? current?.keySummaries ?? [] : [],
      }))
      setUsageScope(scope)
      if (keySummaries) {
        const mergeKeySummaries = async (): Promise<boolean | null> => {
          const outcome = await keySummaries
          if (request !== usageRequest.current || usageScopeRef.current !== scope) return null
          if (!outcome.ok || outcome.value.days !== result.days) {
            setUsageKeySummariesState('error')
            return false
          }
          setUsage((current) => current ? { ...current, keySummaries: outcome.value.keySummaries } : current)
          setUsageKeySummariesState('ready')
          return true
        }
        if (silent) {
          void mergeKeySummaries()
          return true
        }
        return await mergeKeySummaries()
      }
      return true
    } catch {
      if (request === usageRequest.current) setUsageKeySummariesState('error')
      return request !== usageRequest.current ? null : false
    } finally {
      if (!silent && request === usageRequest.current) setUsageLoading(false)
    }
  }, [days, keyId])
  useEffect(() => { if (authenticated && page === 'usage') void loadUsage() }, [authenticated, page, loadUsage])
  const loadCacheTrend = useCallback(async (silent = false) => {
    const scope = JSON.stringify([cacheHours, cacheModel, cacheClient, cacheKeyId, cacheProvider])
    const request = ++cacheRequest.current
    if (!silent) setCacheLoading(true)
    try {
      const result = await api.cacheTrend<CacheTrendData>(cacheHours, cacheModel, cacheClient, cacheKeyId, cacheProvider)
      if (request !== cacheRequest.current) return null
      cacheScopeRef.current = scope
      setCacheTrend(result)
      setCacheScope(scope)
      return true
    } catch {
      return request !== cacheRequest.current ? null : false
    } finally {
      if (!silent && request === cacheRequest.current) setCacheLoading(false)
    }
  }, [cacheHours, cacheModel, cacheClient, cacheKeyId, cacheProvider])
  useEffect(() => { if (authenticated && page === 'cache') void loadCacheTrend() }, [authenticated, page, loadCacheTrend])
  useEffect(() => {
    if (!authenticated) return
    if (page === 'dashboard') void loadDashboard()
    else if (page === 'analytics') void loadAnalytics()
    else if (page === 'charts') void loadCharts()
  }, [authenticated, page, loadAnalytics, loadCharts, loadDashboard])

  // Warm the three reporting views after the dashboard paints. Server-side
  // coalescing means an immediate navigation joins the same calculation.
  useEffect(() => {
    if (!authenticated || page !== 'dashboard') return
    const timer = setTimeout(() => {
      void loadUsage(true)
      void loadCharts()
      void loadCacheTrend(true)
    }, 300)
    return () => clearTimeout(timer)
  }, [authenticated, page, loadCacheTrend, loadCharts, loadUsage])

  /**
   * 明细类页面自动刷新。
   * 只刷当前所在页，避免后台页面产生无谓请求；缓存命中率页走 SSE 推送，不在此列。
   * 15 秒一轮：统计查询会扫描所选窗口，即使已有索引也不需要秒级轮询。
   * 每页只允许一个轮询入口，避免首屏加载与定时器重复并发。
   */
  useEffect(() => {
    if (!authenticated) return
    const refreshCurrent = () => {
      if (page === 'dashboard') void loadDashboard()
      else if (page === 'analytics') void loadAnalytics()
      else if (page === 'charts') void loadCharts()
      else if (page === 'usage') void loadUsage(true)
      // Key 页的额度条来自 bootstrap，不只刷花费明细，否则额度要等人工刷新才会动。
      else if (page === 'keys') { void loadUsageBreakdown(true); void loadBootstrap(true) }
      else if (page === 'monitor') void loadMonitor(true)
      else if (page === 'cache') void loadCacheTrend(true)
      // 渠道/模型页读的是同一份网关快照，静默轮询让别处（官方面板、其他终端）的改动自动反映。
      else if (page === 'channels') void loadChannels(false, true)
      else if (page === 'models' || page === 'help') void loadModelIndex(false, true)
    }
    // OAuth quota endpoints are upstream control-plane APIs. The server also caches
    // them, but a slower page poll prevents needless monitor requests and makes the
    // UI follow the same low-frequency contract as the backend cache.
    const timer = setInterval(refreshCurrent, page === 'monitor' ? 60_000 : page === 'cache' || page === 'channels' || page === 'models' || page === 'help' ? 30_000 : 15_000)
    return () => clearInterval(timer)
  }, [authenticated, page, loadAnalytics, loadBootstrap, loadCharts, loadDashboard, loadUsage, loadUsageBreakdown, loadMonitor, loadCacheTrend, loadChannels, loadModelIndex])

  if (authenticated === null) return <div className="splash"><Sparkles/><span>正在载入控制台</span></div>
  if (!authenticated) return <Suspense fallback={<div className="splash"><Sparkles/><span>正在载入登录页面</span></div>}><LoginPage onSuccess={() => setAuthenticated(true)} /></Suspense>

  const navigate = (next: Page) => setPage(next)
  const selectKey = (key: ApiKeyItem) => { setKeyId(key.id); setPage('analytics') }
  const refresh = async () => {
    const pageRefresh = (() => {
      switch (page) {
        case 'dashboard': return loadDashboard()
        case 'keys': return loadUsageBreakdown()
        case 'channels': return loadChannels(true)
        case 'models':
        case 'help': return loadModelIndex(true)
        case 'charts': return loadCharts()
        case 'analytics': return loadAnalytics()
        case 'usage': return loadUsage()
        case 'cache': return loadCacheTrend()
        case 'monitor': return loadMonitor()
      }
    })()
    const [bootstrapResult, pageResult] = await Promise.allSettled([loadBootstrap(), pageRefresh])
    if (pageResult.status === 'fulfilled' && pageResult.value === null) return
    const refreshed = bootstrapResult.status === 'fulfilled' && bootstrapResult.value
      && pageResult.status === 'fulfilled' && pageResult.value !== false
    setToast(refreshed ? '数据已刷新' : '部分数据暂时不可用')
    setTimeout(() => setToast(''), 1800)
  }
  const navSections = [
    { title: '总览', items: [{ id: 'dashboard' as const, label: '运行概览', icon: LayoutDashboard }] },
    {
      title: '接入管理',
      items: [
        { id: 'keys' as const, label: 'API Key', icon: KeyRound },
        { id: 'channels' as const, label: '渠道账号', icon: Layers },
        { id: 'oauth' as const, label: 'OAuth 登录', icon: Globe },
        { id: 'models' as const, label: '模型总览', icon: Cpu },
      ],
    },
    {
      title: '用量分析',
      items: [
        { id: 'usage' as const, label: '统计和使用情况', icon: Gauge },
        { id: 'charts' as const, label: '图表分析', icon: BarChart3 },
        { id: 'analytics' as const, label: '请求明细', icon: Table2 },
        { id: 'cache' as const, label: '缓存命中率', icon: Layers },
      ],
    },
    {
      title: '运行监控',
      items: [
        { id: 'monitor' as const, label: '账号监控', icon: Activity },
      ],
    },
    { title: '帮助', items: [{ id: 'help' as const, label: '接入帮助', icon: CircleHelp }] },
  ]
  const gatewayEngine = bootstrap?.versions?.cpa?.engine || 'cpa'
  const gatewayCopy = gatewayStatusCopy(gatewayState, gatewayEngine)
  const currentAnalyticsScope = analyticsScopeKey(days, keyId)
  const currentCacheScope = JSON.stringify([cacheHours, cacheModel, cacheClient, cacheKeyId, cacheProvider])
  const degradedNotice = bootstrap?.degraded ? (bootstrap.degradedReason || 'CPA 控制面暂不可用，分组与模型目录沿用上次结果') : ''
  const currentDashboard = dataForScope(dashboard, dashboardScope, currentAnalyticsScope)
  const currentAnalytics = dataForScope(analytics, analyticsScope, currentAnalyticsScope)
  const currentCharts = dataForScope(charts, chartsScope, currentAnalyticsScope)
  const currentUsage = dataForScope(usage, usageScope, currentAnalyticsScope)
  const currentUsageBreakdown = dataForScope(usageBreakdown, usageBreakdownScope, currentAnalyticsScope)
  const currentCacheTrend = dataForScope(cacheTrend, cacheScope, currentCacheScope)
  return <div className="app-shell">
    <div className="top-gradient-blur" aria-hidden="true" />
    <aside className="sidebar">
      <div className="sidebar-brand"><div className="brand-mark small"><Sparkles size={17}/></div><div><strong>Crosery</strong><span>API Console</span></div></div>
      <nav>{navSections.map((section) => <div className="nav-section" key={section.title}>
        <p className="nav-section-title">{section.title}</p>
        {section.items.map(({ id, label, icon: Icon }) => <button type="button" key={id} className={page === id ? 'nav-item active' : 'nav-item'} onClick={() => navigate(id)}><Icon size={18}/><span>{label}</span></button>)}
      </div>)}</nav>
      <div className="sidebar-foot">
        <div className={`gateway-status ${gatewayState}`} role="status">
          <span className={`live-dot ${gatewayState}`}/>
          <div>
            <strong>{gatewayEngine === 'magpie' ? 'Magpie Kernel' : 'CPA Gateway'}</strong>
            <small>
              {gatewayCopy.short}
              {bootstrap?.versions?.cpa?.version && bootstrap.versions.cpa.version !== 'unknown' && ` · v${bootstrap.versions.cpa.version.split('-')[0].replace(/^v/, '')}`}
            </small>
          </div>
        </div>
        <div className="sidebar-version-tag">
          <small>Console v{bootstrap?.versions?.console?.version || '0.1.0'}</small>
        </div>
        <button type="button" className="nav-item logout" onClick={async () => { await api.logout(); setBootstrap(null); setDashboard(null); setDashboardScope(''); dashboardScopeRef.current = ''; setAnalytics(null); setAnalyticsScope(''); analyticsScopeRef.current = ''; setCharts(null); setChartsScope(''); chartsScopeRef.current = ''; setChartsLatencyState('idle'); setUsage(null); setUsageScope(''); usageScopeRef.current = ''; setUsageKeySummariesState('idle'); setUsageBreakdown(null); setUsageBreakdownScope(''); breakdownRequest.current += 1; setCacheTrend(null); setCacheScope(''); cacheScopeRef.current = ''; setMonitor(null); setGatewayState('checking'); setDashboardState('loading'); setAuthenticated(false) }}><LogOut size={17}/><span>退出登录</span></button>
      </div>
    </aside>
    <main className="main-content">
      <header className="topbar">
        <div className="crumb"><ShieldCheck size={16}/><span>console.ai.crosery.com</span></div>
        <div className="topbar-actions">
          <VersionWidget initialVersions={bootstrap?.versions} onRefresh={loadBootstrap} />
          <button type="button" className="icon-button top-refresh" onClick={refresh} title="刷新"><RefreshCw size={17}/></button>
        </div>
      </header>
      <div className="page-content">
        <div key={page} className="page-motion-layer">
          <Suspense fallback={<div className="empty-state" role="status"><RefreshCw className="spin" size={20}/><p>正在加载页面</p></div>}>
            {page === 'dashboard' && <DashboardPage analytics={currentDashboard} keys={bootstrap?.keys || []} keyId={keyId} setKeyId={setKeyId} gatewayState={gatewayState} gatewayEngine={gatewayEngine} dashboardState={dashboardState} onOpenKeys={() => navigate('keys')}/>}
            {page === 'keys' && degradedNotice && <div className="warning-strip subtle degraded-notice" role="status"><TriangleAlert size={16} /><span>{degradedNotice}。Key 列表与额度仍为本地最新数据。</span></div>}
            {page === 'keys' && <KeysPage keys={bootstrap?.keys || []} groups={bootstrap?.groups || []} quotaTimeZone={bootstrap?.quotaTimeZone || ''} gatewayModelAccess={bootstrap?.gatewayModelAccess || 'unknown'} usage={currentUsageBreakdown} usageLoading={breakdownLoading} usageDays={days} onUsageDaysChange={setDays} usageKeyId={keyId} onUsageKeyChange={setKeyId} onRefresh={refresh} onSelectKey={selectKey} onNotify={(message) => { setToast(message); setTimeout(() => setToast(''), 2200) }}/>}
            {page === 'channels' && <ChannelsPage data={channels} loading={channelsLoading} onRefresh={() => loadChannels(true)} onNotify={(message) => { setToast(message); setTimeout(() => setToast(''), 2200) }} onOpenOAuth={() => navigate('oauth')}/>}
            {page === 'oauth' && <OAuthPage onNavigateChannels={() => navigate('channels')} onNotify={(message) => { setToast(message); setTimeout(() => setToast(''), 2200) }}/>}
            {page === 'models' && <ModelsPage data={modelIndex} usage={currentUsageBreakdown} keys={bootstrap?.keys || []} days={days} setDays={setDays} keyId={keyId} setKeyId={setKeyId} loading={modelsLoading} onRefresh={() => loadModelIndex(true)} onNotify={(message) => { setToast(message); setTimeout(() => setToast(''), 2200) }}/>}
            {page === 'charts' && <ChartsPage analytics={currentCharts} latencyState={chartsLatencyState} keys={bootstrap?.keys || []} groups={bootstrap?.groups || []} days={days} setDays={setDays} keyId={keyId} setKeyId={setKeyId}/>}
            {page === 'analytics' && <AnalyticsPage analytics={currentAnalytics} keys={bootstrap?.keys || []} days={days} setDays={setDays} keyId={keyId} setKeyId={setKeyId}/>}
            {page === 'cache' && <CachePage trend={currentCacheTrend} loading={cacheLoading} hours={cacheHours} model={cacheModel} models={cacheTrend?.models || []} client={cacheClient} clients={cacheTrend?.clients || []} keys={bootstrap?.keys || []} keyId={cacheKeyId} onKey={setCacheKeyId} providers={cacheTrend?.providers || []} provider={cacheProvider} onProvider={setCacheProvider} onClient={setCacheClient} onHours={setCacheHours} onModel={setCacheModel} onRefresh={loadCacheTrend}/>}
            {page === 'usage' && <UsagePage data={currentUsage} keySummariesState={usageKeySummariesState} keys={bootstrap?.keys || []} days={days} setDays={setDays} keyId={keyId} setKeyId={setKeyId} onRefresh={loadUsage} loading={usageLoading}/>}
            {page === 'monitor' && <MonitorPage data={monitor} loading={loading} onRefresh={loadMonitor}/>}
            {page === 'help' && <HelpPage modelIndex={modelIndex}/>}
          </Suspense>
        </div>
      </div>
    </main>
    {toast && <div className="toast"><ShieldCheck size={16}/>{toast}</div>}
  </div>
}
