import { Boxes, ChevronDown, Cpu, Globe, KeyRound, Layers, Plus, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { api } from '../api'
import { ChannelCreateDialog } from '../components/ChannelCreateDialog'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { Modal } from '../components/Modal'
import { OAuthLoginDialog } from '../components/OAuthLoginDialog'
import type { ChannelItem, ChannelsData, CredentialItem, ProxyPreset } from '../types'

const credentialLabel: Record<string, string> = { codex: 'OpenAI Codex', claude: 'Claude', xai: 'xAI Grok', gemini: 'Gemini' }

/** 账号分组标签的展示顺序；未列出的 provider 按字母序排在后面。 */
const credentialTypeOrder = ['codex', 'claude', 'xai', 'gemini']

/** 与 CPA 的 proxy_url 语义一一对应：'' 继承全局、'direct' 强制直连、其余为专用代理。 */
const proxyText = (proxyUrl: string, presets: ProxyPreset[], globalProxy: string) => {
  if (!proxyUrl) return globalProxy ? `继承全局 · ${globalProxy}` : '继承全局 · 未设置'
  if (proxyUrl === 'direct') return '强制直连'
  return presets.find((preset) => preset.url === proxyUrl)?.label || proxyUrl
}

export function ChannelsPage({ data, loading, onRefresh, onNotify }: { data: ChannelsData | null; loading: boolean; onRefresh: () => Promise<void>; onNotify: (message: string) => void }) {
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [expanded, setExpanded] = useState<string>('')
  const [removing, setRemoving] = useState<ChannelItem | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [editingProxy, setEditingProxy] = useState<CredentialItem | null>(null)
  const [creatingChannel, setCreatingChannel] = useState(false)
  const [credentialTab, setCredentialTab] = useState('all')
  const [removingCredential, setRemovingCredential] = useState<CredentialItem | null>(null)
  const [deletingCredential, setDeletingCredential] = useState(false)
  const [loggingInOAuth, setLoggingInOAuth] = useState(false)

  const run = async (token: string, action: () => Promise<unknown>, message: string) => {
    setBusy(token); setError('')
    try {
      await action()
      await onRefresh()
      onNotify(message)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '操作失败')
    } finally { setBusy('') }
  }

  const pruneStale = () =>
    run('prune', async () => {
      const result = await api.pruneStaleChannels()
      if (!result.removed.length) throw new Error('没有需要清理的残留渠道')
    }, '已清理残留渠道')

  const toggleChannel = (channel: ChannelItem) =>
    run(`channel:${channel.name}`, () => api.setChannelEnabled(channel.name, !channel.enabled), `渠道“${channel.name}”已${channel.enabled ? '停用' : '启用'}`)

  const toggleModel = (channel: ChannelItem, model: string, enabled: boolean) =>
    run(`model:${channel.name}:${model}`, () => api.setModelEnabled(channel.name, model, !enabled), `模型“${model}”已${enabled ? '停用' : '启用'}`)

  const toggleCredential = (item: CredentialItem) =>
    run(`cred:${item.name}`, () => api.setCredentialEnabled(item.name, item.disabled), `凭据“${item.name}”已${item.disabled ? '启用' : '停用'}`)

  const removeChannel = async () => {
    if (!removing) return
    setDeleting(true); setError('')
    try {
      await api.deleteChannel(removing.name)
      onNotify(`渠道“${removing.name}”已删除`)
      setRemoving(null)
      await onRefresh()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '删除失败')
    } finally { setDeleting(false) }
  }

  const removeCredential = async () => {
    if (!removingCredential) return
    setDeletingCredential(true); setError('')
    try {
      await api.deleteCredential(removingCredential.name)
      onNotify(`账号“${removingCredential.label || removingCredential.name}”已删除`)
      setRemovingCredential(null)
      await onRefresh()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '删除失败')
    } finally { setDeletingCredential(false) }
  }

  const editProxy = async (item: CredentialItem) => {
    const token = `proxy:${item.name}`
    setBusy(token); setError('')
    try {
      const { proxyUrl } = await api.credentialProxy(item.name)
      setEditingProxy({ ...item, proxyUrl })
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '读取代理失败')
    } finally { setBusy('') }
  }

  const channels = data?.channels || []
  const credentials = data?.credentials || []
  const proxyPresets = data?.proxyPresets || []
  const globalProxy = data?.globalProxy || ''

  const credentialCounts = new Map<string, number>()
  for (const item of credentials) credentialCounts.set(item.type, (credentialCounts.get(item.type) || 0) + 1)
  const credentialRank = (type: string) => { const index = credentialTypeOrder.indexOf(type); return index < 0 ? credentialTypeOrder.length : index }
  const credentialTabs = [
    { id: 'all', label: '全部', count: credentials.length },
    ...[...credentialCounts.keys()]
      .sort((a, b) => credentialRank(a) - credentialRank(b) || a.localeCompare(b))
      .map((type) => ({ id: type, label: credentialLabel[type] || type || '未知', count: credentialCounts.get(type) || 0 })),
  ]

  const visibleCredentials = credentialTab === 'all' ? credentials : credentials.filter((item) => item.type === credentialTab)

  return <div className="page-stack">
    <section className="page-heading">
      <div><p className="eyebrow">ROUTING</p><h1>渠道与模型</h1><p>控制上游渠道、渠道内模型以及 OAuth 凭据的启用状态。</p></div>
      <div className="heading-actions">
        <button className="primary-button" onClick={() => { setError(''); setCreatingChannel(true) }}><Plus size={16} />添加渠道</button>
        <button className="secondary-button" onClick={() => void onRefresh()} disabled={loading}><RefreshCw size={16} className={loading ? 'spin' : ''} />刷新</button>
      </div>
    </section>

    {error && <div className="warning-strip"><ShieldCheck size={16} />{error}</div>}

    <section className="panel fill">
      <div className="panel-title"><div><h2>上游渠道</h2><p>停用会从网关移除该渠道，配置保留在控制台，可随时启用回来。</p></div><div className="channel-head-actions">
        {channels.some((item) => item.stale) && <button className="secondary-button tiny" disabled={busy === 'prune'} onClick={() => void pruneStale()}><Trash2 size={13} />清理残留 {channels.filter((item) => item.stale).length}</button>}
        <span className="soft-badge">{channels.filter((item) => item.enabled).length}/{channels.length} 启用</span>
      </div></div>
      {!channels.length && !loading && <div className="empty-compact"><Layers size={26} /><p>没有配置任何 OpenAI 兼容渠道</p></div>}
      <div className="channel-list scroll-area">
        {channels.map((channel) => {
          const open = expanded === channel.name
          const activeModels = channel.models.filter((model) => model.enabled).length
          return <div className={channel.enabled ? 'channel-card' : 'channel-card off'} key={channel.name}>
            <div className="channel-main">
              <button className="channel-toggle-area" onClick={() => setExpanded(open ? '' : channel.name)}>
                <span className="channel-icon"><Boxes size={17} /></span>
                <span className="channel-text">
                  <strong>{channel.name}</strong>
                  <small>{channel.baseUrl || '—'}</small>
                </span>
                <span className="channel-meta">
                  <span><KeyRound size={13} />{channel.keyCount} Key</span>
                  <span><Cpu size={13} />{activeModels}/{channel.models.length} 模型</span>
                </span>
                <ChevronDown size={17} className={open ? 'chevron open' : 'chevron'} />
              </button>
              <div className="channel-actions">
                <span className={channel.enabled ? 'status-chip success' : channel.stale ? 'status-chip danger' : 'status-chip'} title={channel.stale ? '网关中已不存在该渠道，仅剩控制台残留记录' : undefined}>{channel.enabled ? '启用' : channel.stale ? '网关已移除' : '停用'}</span>
                {!channel.stale && <button type="button" className={channel.enabled ? 'switch active' : 'switch'} disabled={busy === `channel:${channel.name}`} onClick={() => void toggleChannel(channel)} aria-label={`切换渠道 ${channel.name}`}><span /></button>}
                <button className="icon-button" title="删除渠道" onClick={() => { setError(''); setRemoving(channel) }}><Trash2 size={16} /></button>
              </div>
            </div>
            {open && <div className="model-panel">
              {channel.stale
                ? <p className="model-hint danger">该渠道已在网关侧被删除，这里只剩控制台的历史记录。点击右上角「清理残留」可移除。</p>
                : !channel.enabled && <p className="model-hint">渠道已停用，启用后才能单独调整模型。</p>}
              {!channel.models.length && <p className="model-hint">该渠道没有配置模型。</p>}
              <div className="model-grid scroll-area">
                {channel.models.map((model) => <button
                  key={model.id}
                  type="button"
                  className={model.enabled ? 'model-chip active' : 'model-chip'}
                  disabled={!channel.enabled || busy === `model:${channel.name}:${model.id}`}
                  onClick={() => void toggleModel(channel, model.id, model.enabled)}
                >
                  <span className="model-dot" />{model.id}
                  {model.upstreams > 1 && <em className="model-upstreams" title={`${model.upstreams} 条上游轮询同一模型名`}>×{model.upstreams}</em>}
                </button>)}
              </div>
            </div>}
          </div>
        })}
      </div>
    </section>

    <section className="panel fill">
      <div className="panel-title">
        <div><h2>账号管理</h2><p>OAuth 账号池（Codex / Claude / Grok 等）。停用后该账号不再参与调度，模型随之下线；出口代理按账号单独设置。</p></div>
        <div className="channel-head-actions">
          <button type="button" className="channel-login-btn" onClick={() => { setError(''); setLoggingInOAuth(true) }} title="通过 OAuth / Device Code 授权登录新账号"><KeyRound size={12} /><span>账号登录</span></button>
          <span className="soft-badge">{visibleCredentials.filter((item) => !item.disabled).length}/{visibleCredentials.length} 可用</span>
        </div>
      </div>
      <div className="filter-tabs credential-tabs">{credentialTabs.map((tab) => <button
        type="button"
        key={tab.id}
        className={credentialTab === tab.id ? 'filter-tab active' : 'filter-tab'}
        onClick={() => setCredentialTab(tab.id)}
      >{tab.label} <em className="tab-count">{tab.count}</em></button>)}</div>
      {!visibleCredentials.length && !loading && <div className="empty-compact"><ShieldCheck size={26} /><p>{credentials.length ? '该渠道下没有账号' : '没有 OAuth 账号'}</p></div>}
      <div className="credential-list scroll-area">
        {visibleCredentials.map((item) => <div className={item.disabled ? 'credential-row off' : 'credential-row'} key={item.name}>
          <span className="credential-avatar">{(credentialLabel[item.type] || item.type || '?').slice(0, 1).toUpperCase()}</span>
          <span className="credential-name">
            <strong title={item.name}>{item.label || item.name}</strong>
            <small>{credentialLabel[item.type] || item.type}{item.disabled ? '' : ` · ${item.modelCount} 个模型`}</small>
          </span>
          <button
            type="button"
            className="proxy-chip"
            disabled={busy === `proxy:${item.name}`}
            onClick={() => void editProxy(item)}
            title="查看或设置出口代理"
          ><Globe size={12} />出口代理</button>
          <span className={item.disabled ? 'status-chip' : 'status-chip success'}>{item.disabled ? '已停用' : '可用'}</span>
          <button type="button" className={item.disabled ? 'switch' : 'switch active'} disabled={busy === `cred:${item.name}`} onClick={() => void toggleCredential(item)} aria-label={`切换账号 ${item.name}`}><span /></button>
          <button type="button" className="icon-button" title="删除账号" onClick={() => { setError(''); setRemovingCredential(item) }}><Trash2 size={16} /></button>
        </div>)}
      </div>
    </section>

    {creatingChannel && <ChannelCreateDialog
      onClose={() => setCreatingChannel(false)}
      onCreated={async (channelName) => {
        setCreatingChannel(false)
        await onRefresh()
        setExpanded(channelName)
        onNotify(`渠道“${channelName}”已创建并同步到网关`)
      }}
    />}

    {editingProxy && <ProxyDialog
      credential={editingProxy}
      presets={proxyPresets}
      globalProxy={globalProxy}
      onClose={() => setEditingProxy(null)}
      onSaved={async (proxyUrl) => {
        setEditingProxy(null)
        await onRefresh()
        onNotify(`“${editingProxy.label || editingProxy.name}”的出口代理已改为 ${proxyText(proxyUrl, proxyPresets, globalProxy)}`)
      }}
    />}

    {removing && <ConfirmDialog
      title="删除渠道"
      description="删除后该渠道及其模型将从网关移除，控制台里的停用备份也会一并清除。此操作不可恢复。"
      target={`${removing.name}${removing.baseUrl ? ` · ${removing.baseUrl}` : ''}`}
      confirmLabel="永久删除"
      busyLabel="删除中…"
      busy={deleting}
      error={error}
      onConfirm={removeChannel}
      onCancel={() => { setRemoving(null); setError('') }}
    />}

    {removingCredential && <ConfirmDialog
      title="删除账号"
      description="删除后网关会移除该 OAuth 凭据文件，账号需重新授权才能加回。此操作不可恢复。"
      target={`${removingCredential.label || removingCredential.name} · ${credentialLabel[removingCredential.type] || removingCredential.type}`}
      confirmLabel="永久删除"
      busyLabel="删除中…"
      busy={deletingCredential}
      error={error}
      onConfirm={removeCredential}
      onCancel={() => { setRemovingCredential(null); setError('') }}
    />}

    {loggingInOAuth && <OAuthLoginDialog
      onClose={() => setLoggingInOAuth(false)}
      onSuccess={async (provider) => {
        await onRefresh()
        onNotify(`账号授权成功，已同步接入 ${provider} 凭据`)
      }}
    />}
  </div>
}

function ProxyDialog({ credential, presets, globalProxy, onClose, onSaved }: {
  credential: CredentialItem
  presets: ProxyPreset[]
  globalProxy: string
  onClose: () => void
  onSaved: (proxyUrl: string) => Promise<void>
}) {
  const isPreset = credential.proxyUrl !== '' && credential.proxyUrl !== 'direct' && presets.some((preset) => preset.url === credential.proxyUrl)
  const [choice, setChoice] = useState(!credential.proxyUrl || credential.proxyUrl === 'direct' || isPreset ? credential.proxyUrl : 'custom')
  const [custom, setCustom] = useState(isPreset || credential.proxyUrl === 'direct' ? '' : credential.proxyUrl)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const target = choice === 'custom' ? custom.trim() : choice
  const save = async () => {
    setSaving(true); setError('')
    try {
      const result = await api.setCredentialProxy(credential.name, target)
      await onSaved(result.proxyUrl)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '保存失败')
      setSaving(false)
    }
  }

  const option = (value: string, title: string, hint: string) => <button
    type="button"
    key={value}
    className={choice === value ? 'proxy-option active' : 'proxy-option'}
    onClick={() => setChoice(value)}
  ><strong>{title}</strong><small>{hint}</small></button>

  return <Modal
    title="出口代理"
    subtitle={`${credential.label || credential.name} 请求上游时使用的出口。改动即时生效，无需重启网关。`}
    onClose={onClose}
  >
    <div className="proxy-options">
      {option('', '继承全局', globalProxy ? `跟随网关 proxy-url：${globalProxy}` : '网关未设置全局代理，等同直连')}
      {option('direct', '强制直连', '忽略全局代理，从网关本机出口')}
      {presets.map((preset) => option(preset.url, preset.label, preset.url))}
      {option('custom', '自定义地址', '手动填写 http / https / socks5 代理')}
    </div>
    {choice === 'custom' && <label className="field-label">代理地址
      <input className="text-input" value={custom} onChange={(event) => setCustom(event.target.value)} placeholder="http://127.0.0.1:7890" autoFocus />
      <small className="field-hint">支持 http、https、socks5、socks5h。预设列表由服务端 PROXY_PRESETS 配置。</small>
    </label>}
    {error && <p className="form-error modal-error">{error}</p>}
    <footer className="modal-footer"><span />
      <div>
        <button className="secondary-button" onClick={onClose}>取消</button>
        <button className="primary-button" disabled={saving || (choice === 'custom' && !custom.trim())} onClick={() => void save()}>{saving ? '保存中' : '保存'}</button>
      </div>
    </footer>
  </Modal>
}
