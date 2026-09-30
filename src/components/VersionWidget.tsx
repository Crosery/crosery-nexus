import { ChevronDown, Info, RefreshCw, Sparkles, Terminal, Zap } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { api } from '../api'
import type { VersionsData } from '../types'

export function VersionWidget({
  initialVersions,
  onRefresh,
}: {
  initialVersions?: VersionsData
  onRefresh?: () => void
}) {
  const [open, setOpen] = useState(false)
  const [checking, setChecking] = useState(false)
  const [syncingModels, setSyncingModels] = useState(false)
  const [syncNotice, setSyncNotice] = useState('')
  const [versions, setVersions] = useState<VersionsData | undefined>(initialVersions)
  const [checkError, setCheckError] = useState('')
  const popoverRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popoverId = useId()

  useEffect(() => {
    if (initialVersions) setVersions(initialVersions)
  }, [initialVersions])

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false)
        triggerRef.current?.focus()
      }
    }
    if (open) {
      document.addEventListener('mousedown', handleClickOutside)
      document.addEventListener('keydown', handleEscape)
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [open])

  const checkLatestVersion = async () => {
    setChecking(true)
    setCheckError('')
    try {
      const data = await api.version()
      setVersions(data)
      if (onRefresh) onRefresh()
    } catch {
      setCheckError('无法读取版本与检测结果，请稍后重试。')
    } finally {
      setChecking(false)
    }
  }

  const handleSyncModels = async () => {
    setSyncingModels(true)
    setSyncNotice('')
    try {
      const res = await api.syncUpstreamModels()
      if (res.ok) {
        setSyncNotice(`同步成功：新增 ${res.result.addedModels.length} 个模型，现共 ${res.result.totalModels} 个`)
        if (onRefresh) onRefresh()
      }
    } catch {
      setSyncNotice('同步失败，请检查上游网关连接')
    } finally {
      setSyncingModels(false)
    }
  }

  const cpa = versions?.cpa
  const consoleVer = versions?.console
  const engineName = cpa?.engine === 'magpie' ? 'Magpie' : 'CPA'
  const kernelUnavailable = cpa?.engine === 'magpie' && cpa.version === 'offline'
  const upstream = cpa?.upstream

  const cpaShort = cpa?.version ? cpa.version.split('-')[0].replace(/^v/, '') : '未知'
  const hasUpdate = Boolean(cpa?.hasUpdate)

  return (
    <div className="version-widget-wrap" ref={popoverRef}>
      <button
        type="button"
        ref={triggerRef}
        className={`version-widget-trigger ${hasUpdate ? 'has-update' : ''}`}
        onClick={() => setOpen(!open)}
        title={`查看 ${engineName} 网关与管理端系统版本`}
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
      >
        <span className="version-trigger-tag">
          <Terminal size={13} />
          <span>{engineName} {cpa?.engine === 'magpie' ? cpa?.version : `v${cpaShort}`}</span>
          {hasUpdate && <span className="version-dot-pulse" title={`上游发现新版本 ${cpa?.latestVersion}`} />}
        </span>
        <span className="version-trigger-divider">/</span>
        <span className="version-trigger-tag">
          <Sparkles size={13} />
          <span>v{consoleVer?.version || '0.1.0'}</span>
        </span>
        <ChevronDown size={13} className={open ? 'chevron open' : 'chevron'} />
      </button>

      {open && (
        <div className="version-popover" id={popoverId} role="dialog" aria-label="系统与网关版本详情">
          <div className="version-popover-head">
            <div>
              <h3>系统版本与健康监控</h3>
              <p>{engineName} 内核与 Crosery 管理端运行版本</p>
            </div>
            <button
              type="button"
              className="icon-button"
              onClick={checkLatestVersion}
              disabled={checking}
              title="刷新版本与上游检测结果"
              aria-label="刷新版本与上游检测结果"
            >
              <RefreshCw size={14} className={checking ? 'spin' : ''} />
            </button>
          </div>
          {checkError && <p className="form-error" role="status">{checkError}</p>}

          <div className="version-sections">
            <div className="version-card">
              <div className="version-card-title">
                <div className="title-left">
                  <Terminal size={15} />
                  <strong>{engineName} 网关核心</strong>
                </div>
                {kernelUnavailable ? (
                  <span className="status-chip warning">内核不可用</span>
                ) : hasUpdate ? (
                  <span className="status-chip warning">发现新版本</span>
                ) : (
                  <span className="status-chip success">正常运行</span>
                )}
              </div>
              <div className="version-props">
                <div className="prop-row">
                  <span>当前运行版本</span>
                  <code>{cpa?.version || '未知'}</code>
                </div>
                {cpa?.commit && (
                  <div className="prop-row">
                    <span>Git Commit</span>
                    <code>{cpa.commit}</code>
                  </div>
                )}
                {cpa?.buildDate && (
                  <div className="prop-row">
                    <span>构建时间</span>
                    <small>{new Date(cpa.buildDate).toLocaleString('zh-CN')}</small>
                  </div>
                )}
                <div className="prop-row">
                  <span>{cpa?.engine === 'magpie' ? '上游检测' : '上游最新 Release'}</span>
                  <strong>{cpa?.engine === 'magpie' ? ({
                    not_checked: '尚未检测', unchanged: '契约无版本变化', review_required: '候选契约已生成',
                    error: '检测失败，保留当前版本', baseline_mismatch: '运行版本与契约不一致',
                  }[upstream?.status || 'not_checked']) : cpa?.latestVersion || '已是最新'}</strong>
                </div>
                <div className="prop-row">
                  <span>OAuth 适配</span>
                  <span className="status-chip success" style={{ padding: '1px 6px', fontSize: '11px' }}>已适配接入</span>
                </div>
                <div className="prop-row">
                  <span>RTK 适配</span>
                  <span className="status-chip success" style={{ padding: '1px 6px', fontSize: '11px' }}>
                    {cpa?.rtk?.connected ? `已接通 (v${cpa.rtk.version})` : '已适配接入'}
                  </span>
                </div>
                {cpa?.rtk?.gain && cpa.rtk.gain.commands > 0 && (
                  <div className="prop-row">
                    <span>RTK Token 节省</span>
                    <strong>节省 {cpa.rtk.gain.pct.toFixed(1)}% ({cpa.rtk.gain.saved.toLocaleString()} tokens)</strong>
                  </div>
                )}
              </div>

              <div style={{ marginTop: '10px', paddingTop: '10px', borderTop: '1px solid var(--line)' }}>
                <button
                  type="button"
                  className="button secondary"
                  style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px', fontSize: '12px', padding: '6px 10px' }}
                  onClick={handleSyncModels}
                  disabled={syncingModels}
                >
                  <RefreshCw size={13} className={syncingModels ? 'spin' : ''} />
                  <span>{syncingModels ? '正在同步上游模型...' : '动态同步上游最新模型'}</span>
                </button>
                {syncNotice && <small style={{ display: 'block', marginTop: '4px', textAlign: 'center', color: 'var(--muted)' }}>{syncNotice}</small>}
              </div>

              {hasUpdate && cpa?.latestVersion && (
                <div className="version-update-banner" style={{ marginTop: '10px' }}>
                  <Info size={14} />
                  <span>{cpa?.engine === 'magpie' ? '上游候选待适配验证：' : '可更新至上游 '}<strong>{cpa.latestVersion}</strong></span>
                </div>
              )}
              {upstream && (
                <div className="upstream-contract-status">
                  <p>自动解析上游接口并生成代码契约；尚未替换运行内核。</p>
                  <dl>
                    <div><dt>源码路由</dt><dd>推理 {upstream.routes.inference} / 管理 {upstream.routes.management}</dd></div>
                    <div><dt>登录 / RTK</dt><dd>{upstream.loginAgents.length} 种登录 / {upstream.routes.rtk} 个 RTK 接口</dd></div>
                    <div><dt>上次检测</dt><dd>{upstream.checkedAt ? new Date(upstream.checkedAt).toLocaleString('zh-CN') : '未检测'}</dd></div>
                    {upstream.rtkRelease && <div><dt>RTK 上游版本</dt><dd>{upstream.rtkRelease}</dd></div>}
                  </dl>
                  <p style={{ color: 'var(--mint)', display: 'flex', alignItems: 'center', gap: '4px' }}>
                    <Zap size={13} />
                    <span>OAuth 登录与 RTK Token 压缩管理已成功接通本中转站。</span>
                  </p>
                  {upstream.candidateRevision && (
                    <details>
                      <summary>查看上游变化：新增 {upstream.changes.addedRoutes.length} / 移除 {upstream.changes.removedRoutes.length} / 接口变化 {upstream.changes.changedRoutes.length}</summary>
                      <p>类型变化 {upstream.changes.schemaCount} 项；实现文件变化 {upstream.changes.implementationFileCount} 个。</p>
                      {upstream.changes.addedLoginAgents.length > 0 && <p>新增登录类型：{upstream.changes.addedLoginAgents.join('、')}</p>}
                      {upstream.changes.removedLoginAgents.length > 0 && <p>上游移除登录类型：{upstream.changes.removedLoginAgents.join('、')}。本地账号未被改动。</p>}
                      <code className="upstream-revision">{upstream.candidateRevision}</code>
                      <ul>{[
                        ...upstream.changes.addedRoutes.map(route => ['新增', route]),
                        ...upstream.changes.removedRoutes.map(route => ['移除', route]),
                        ...upstream.changes.changedRoutes.map(route => ['变化', route]),
                      ].map(([kind, route]) => <li key={`${kind}:${route}`}><span>{kind}</span> <code>{route}</code></li>)}</ul>
                    </details>
                  )}
                </div>
              )}
            </div>

            <div className="version-card">
              <div className="version-card-title">
                <div className="title-left">
                  <Sparkles size={15} />
                  <strong>Console 管理端</strong>
                </div>
                <span className="status-chip success">v{consoleVer?.version || '0.1.0'}</span>
              </div>
              <div className="version-props">
                <div className="prop-row">
                  <span>软件版本</span>
                  <code>v{consoleVer?.version || '0.1.0'}</code>
                </div>
                {consoleVer?.releaseId && (
                  <div className="prop-row">
                    <span>Release ID</span>
                    <code>{consoleVer.releaseId}</code>
                  </div>
                )}
                {consoleVer?.releaseDate && (
                  <div className="prop-row">
                    <span>发布时间</span>
                    <small>{new Date(consoleVer.releaseDate).toLocaleString('zh-CN')}</small>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
