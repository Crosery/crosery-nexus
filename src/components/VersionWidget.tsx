import { ChevronDown, Info, RefreshCw, Sparkles, Terminal } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
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
  const [versions, setVersions] = useState<VersionsData | undefined>(initialVersions)
  const popoverRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (initialVersions) setVersions(initialVersions)
  }, [initialVersions])

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    if (open) {
      document.addEventListener('mousedown', handleClickOutside)
    }
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [open])

  const checkLatestVersion = async () => {
    setChecking(true)
    try {
      const data = await api.version()
      setVersions(data)
      if (onRefresh) onRefresh()
    } catch {
      // 忽略检查失败
    } finally {
      setChecking(false)
    }
  }

  const cpa = versions?.cpa
  const consoleVer = versions?.console

  const cpaShort = cpa?.version ? cpa.version.split('-')[0].replace(/^v/, '') : '未知'
  const hasUpdate = Boolean(cpa?.hasUpdate)

  return (
    <div className="version-widget-wrap" ref={popoverRef}>
      <button
        type="button"
        className={`version-widget-trigger ${hasUpdate ? 'has-update' : ''}`}
        onClick={() => setOpen(!open)}
        title="查看 CPA 网关与管理端系统版本"
      >
        <span className="version-trigger-tag">
          <Terminal size={13} />
          <span>CPA v{cpaShort}</span>
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
        <div className="version-popover" role="dialog" aria-label="系统与网关版本详情">
          <div className="version-popover-head">
            <div>
              <h3>系统版本与健康监控</h3>
              <p>小鸡云 CPA 核心网关与管理端运行版本</p>
            </div>
            <button
              type="button"
              className="icon-button"
              onClick={checkLatestVersion}
              disabled={checking}
              title="重新检查版本"
            >
              <RefreshCw size={14} className={checking ? 'spin' : ''} />
            </button>
          </div>

          <div className="version-sections">
            <div className="version-card">
              <div className="version-card-title">
                <div className="title-left">
                  <Terminal size={15} />
                  <strong>CPA Gateway 网关核心</strong>
                </div>
                {hasUpdate ? (
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
                  <span>上游最新 Release</span>
                  <strong>{cpa?.latestVersion || '已是最新'}</strong>
                </div>
              </div>
              {hasUpdate && cpa?.latestVersion && (
                <div className="version-update-banner">
                  <Info size={14} />
                  <span>可更新至上游 <strong>{cpa.latestVersion}</strong></span>
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
