import { Check, ChevronRight, Copy, ExternalLink, Globe, KeyRound, LoaderCircle, ShieldAlert, Sparkles, Terminal } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import type { OAuthStartResult } from '../types'
import { Modal } from './Modal'

type ProviderOption = {
  id: string
  name: string
  label: string
  desc: string
  supportsApiKey?: boolean
}

const PROVIDERS: ProviderOption[] = [
  { id: 'codex', name: 'OpenAI Codex', label: 'Codex / ChatGPT', desc: '支持 OAuth 网页授权、跳转回调 URL、授权码或 OpenAI API Key 接入', supportsApiKey: true },
  { id: 'claude', name: 'Claude', label: 'Claude / Anthropic', desc: '支持 Claude Pro / Team 授权、页面授权码直接提交，或 Claude API Key 录入', supportsApiKey: true },
  { id: 'antigravity', name: 'Google Antigravity', label: 'Google', desc: '登录 Google 账号，接入 Gemini / Antigravity 渠道', supportsApiKey: true },
  { id: 'kimi', name: 'Kimi', label: 'Moonshot Kimi', desc: '通过设备码授权登录 Kimi Code 账号' },
  { id: 'xai', name: 'xAI Grok', label: 'xAI', desc: '通过设备码授权登录 xAI / Grok 账号', supportsApiKey: true },
  { id: 'devin', name: 'Devin', label: 'Cognition Devin', desc: '登录 Devin AI 平台账号' },
  { id: 'meta', name: 'Meta AI', label: 'Meta', desc: '登录 Meta 账号' },
]

type LoginMode = 'oauth' | 'code' | 'apikey'

export function OAuthLoginDialog({
  onClose,
  onSuccess,
}: {
  onClose: () => void
  onSuccess: (provider: string) => Promise<void>
}) {
  const [selectedProvider, setSelectedProvider] = useState<string>('codex')
  const [mode, setMode] = useState<LoginMode>('oauth')
  const [starting, setStarting] = useState(false)
  const [session, setSession] = useState<OAuthStartResult | null>(null)
  const [status, setStatus] = useState<'idle' | 'waiting' | 'success' | 'error'>('idle')
  const [errorMessage, setErrorMessage] = useState('')
  const [copiedCode, setCopiedCode] = useState(false)
  const [copiedUrl, setCopiedUrl] = useState(false)

  // 授权码 / 回调 URL 提交
  const [authCodeInput, setAuthCodeInput] = useState('')
  const [submittingCode, setSubmittingCode] = useState(false)

  // API Key 直接录入
  const [apiKeyInput, setApiKeyInput] = useState('')
  const [submittingApiKey, setSubmittingApiKey] = useState(false)

  const pollTimerRef = useRef<number | null>(null)
  const sessionRef = useRef<OAuthStartResult | null>(null)
  sessionRef.current = session

  const stopPolling = () => {
    if (pollTimerRef.current !== null) {
      window.clearInterval(pollTimerRef.current)
      pollTimerRef.current = null
    }
  }

  useEffect(() => {
    return () => {
      stopPolling()
      const current = sessionRef.current
      if (current?.state) {
        api.cancelOAuth(current.state).catch(() => {})
      }
    }
  }, [])

  const currentProviderConfig = PROVIDERS.find((p) => p.id === selectedProvider)

  const handleStartOAuth = async (providerId: string) => {
    stopPolling()
    setStarting(true)
    setErrorMessage('')
    setStatus('waiting')
    try {
      const result = await api.startOAuth(providerId)
      setSession(result)
      pollTimerRef.current = window.setInterval(async () => {
        try {
          const check = await api.getOAuthStatus(result.state)
          if (check.status === 'ok') {
            stopPolling()
            setStatus('success')
            await onSuccess(result.provider)
            setTimeout(() => onClose(), 1500)
          } else if (check.status === 'error') {
            stopPolling()
            setStatus('error')
            setErrorMessage(check.error || '授权失败或会话已过期')
          }
        } catch (err) {
          if (err instanceof Error && err.message.includes('40')) {
            stopPolling()
            setStatus('error')
            setErrorMessage(err.message)
          }
        }
      }, 2000)
    } catch (err) {
      setStatus('error')
      setErrorMessage(err instanceof Error ? err.message : '发起授权失败')
    } finally {
      setStarting(false)
    }
  }

  const handleCopy = async (text: string, type: 'code' | 'url') => {
    try {
      await navigator.clipboard.writeText(text)
      if (type === 'code') {
        setCopiedCode(true)
        setTimeout(() => setCopiedCode(false), 2000)
      } else {
        setCopiedUrl(true)
        setTimeout(() => setCopiedUrl(false), 2000)
      }
    } catch {}
  }

  const handleOpenAuthUrl = () => {
    if (!session?.url) return
    if (session.user_code) {
      handleCopy(session.user_code, 'code')
    }
    window.open(session.url, '_blank', 'noopener,noreferrer')
  }

  const handleSubmitAuthCode = async () => {
    const raw = authCodeInput.trim()
    if (!raw) return
    setSubmittingCode(true)
    setErrorMessage('')
    try {
      const provider = session?.provider || selectedProvider
      const state = session?.state || ''
      await api.submitOAuthCallback(provider, raw, state)
      stopPolling()
      setStatus('success')
      await onSuccess(provider)
      setTimeout(() => onClose(), 1500)
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : '提交授权码或回调失败')
    } finally {
      setSubmittingCode(false)
    }
  }

  const handleSubmitApiKey = async () => {
    const key = apiKeyInput.trim()
    if (!key) return
    setSubmittingApiKey(true)
    setErrorMessage('')
    try {
      await api.addApiKey(selectedProvider, key)
      setStatus('success')
      await onSuccess(selectedProvider)
      setTimeout(() => onClose(), 1500)
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : '保存 API Key 失败')
    } finally {
      setSubmittingApiKey(false)
    }
  }

  const handleCancel = async () => {
    stopPolling()
    if (session?.state) {
      await api.cancelOAuth(session.state).catch(() => {})
    }
    setSession(null)
    setStatus('idle')
    setErrorMessage('')
    setAuthCodeInput('')
    setApiKeyInput('')
  }

  return (
    <Modal
      title="CPA 账号授权与接入"
      subtitle="支持浏览器官方 OAuth、页面授权码/回调回填及 API Key 直接录入，凭据由网关安全接管"
      onClose={onClose}
      wide
    >
      <div className="oauth-dialog-body">
        {status === 'idle' ? (
          <div className="oauth-provider-selection">
            <p className="section-instruction">请选择要接入的上游账号平台：</p>
            <div className="oauth-provider-grid">
              {PROVIDERS.map((provider) => {
                const selected = selectedProvider === provider.id
                return (
                  <button
                    key={provider.id}
                    type="button"
                    className={`oauth-provider-card ${selected ? 'selected' : ''}`}
                    onClick={() => setSelectedProvider(provider.id)}
                  >
                    <div className="oauth-provider-card-head">
                      <span className="oauth-provider-icon">
                        <KeyRound size={16} />
                      </span>
                      <strong>{provider.name}</strong>
                    </div>
                    <p>{provider.desc}</p>
                    <div className="oauth-provider-card-foot">
                      <span className="oauth-provider-tag">{provider.label}</span>
                      <ChevronRight size={14} />
                    </div>
                  </button>
                )
              })}
            </div>
            <div className="modal-actions-bar">
              <button type="button" className="action-btn secondary" onClick={onClose}>
                取消
              </button>
              <button
                type="button"
                className="action-btn primary"
                disabled={starting}
                onClick={() => {
                  handleStartOAuth(selectedProvider)
                }}
              >
                {starting ? <LoaderCircle size={14} className="spin" /> : <Sparkles size={14} />}
                <span>{starting ? '正在初始化...' : '下一步：开始接入'}</span>
              </button>
            </div>
          </div>
        ) : (
          <div className="oauth-session-view">
            {status === 'success' ? (
              <div className="oauth-success-banner">
                <div className="success-icon-wrap">
                  <Check size={28} />
                </div>
                <h3>账号接入成功！</h3>
                <p>网关已获取并保存凭证，正在同步渠道模型与可用配额...</p>
              </div>
            ) : (
              <div className="oauth-pending-view">
                {/* 顶部 Provider 标识与多模式切换 Tab */}
                <div className="oauth-mode-header">
                  <div className="provider-pill">
                    <span className="provider-name">{currentProviderConfig?.name || selectedProvider}</span>
                    <span className="status-badge live">会话已就绪</span>
                  </div>

                  <div className="login-mode-tabs">
                    <button
                      type="button"
                      className={`mode-tab ${mode === 'oauth' ? 'active' : ''}`}
                      onClick={() => setMode('oauth')}
                    >
                      <Globe size={13} />
                      <span>浏览器 OAuth</span>
                    </button>
                    <button
                      type="button"
                      className={`mode-tab ${mode === 'code' ? 'active' : ''}`}
                      onClick={() => setMode('code')}
                    >
                      <Terminal size={13} />
                      <span>输入授权码 / 回调</span>
                    </button>
                    {currentProviderConfig?.supportsApiKey && (
                      <button
                        type="button"
                        className={`mode-tab ${mode === 'apikey' ? 'active' : ''}`}
                        onClick={() => setMode('apikey')}
                      >
                        <KeyRound size={13} />
                        <span>API Key 录入</span>
                      </button>
                    )}
                  </div>
                </div>

                {/* 模式 1：标准浏览器 OAuth */}
                {mode === 'oauth' && (
                  <div className="oauth-tab-pane">
                    {session?.user_code && (
                      <div className="oauth-device-code-box">
                        <span className="device-code-label">设备授权码（User Code）</span>
                        <div className="device-code-row">
                          <strong className="device-code-val">{session.user_code}</strong>
                          <button
                            type="button"
                            className="action-btn secondary compact"
                            onClick={() => session.user_code && handleCopy(session.user_code, 'code')}
                          >
                            {copiedCode ? <Check size={13} /> : <Copy size={13} />}
                            <span>{copiedCode ? '已复制' : '复制设备码'}</span>
                          </button>
                        </div>
                        <p className="device-code-hint">在打开的授权网页中输入此验证码以确认绑定</p>
                      </div>
                    )}

                    <div className="oauth-action-box">
                      <p>点击下方按钮在浏览器中打开官方授权页完成验证：</p>
                      <div className="oauth-link-buttons">
                        <button
                          type="button"
                          className="action-btn primary compact"
                          onClick={handleOpenAuthUrl}
                        >
                          <ExternalLink size={13} />
                          <span>在浏览器中打开授权页面</span>
                        </button>
                        <button
                          type="button"
                          className="action-btn secondary compact"
                          onClick={() => session?.url && handleCopy(session.url, 'url')}
                        >
                          {copiedUrl ? <Check size={13} /> : <Copy size={13} />}
                          <span>{copiedUrl ? '已复制链接' : '复制授权链接'}</span>
                        </button>
                      </div>
                    </div>

                    <div className="oauth-polling-status">
                      <LoaderCircle size={14} className="spin" />
                      <span>正在等待你在浏览器端完成授权（每 2 秒检测一次状态）...</span>
                    </div>
                  </div>
                )}

                {/* 模式 2：授权码 / 回调 URL 回填 */}
                {mode === 'code' && (
                  <div className="oauth-tab-pane">
                    <div className="input-group-box">
                      <label htmlFor="auth-code-input">
                        <strong>粘贴授权码或完整回调 URL</strong>
                        <small>适用于本地无法接收重定向、无头终端，或 Claude / Codex 网页给出的授权 Code</small>
                      </label>
                      <div className="compact-input-row">
                        <input
                          id="auth-code-input"
                          type="text"
                          className="text-input"
                          placeholder={
                            selectedProvider === 'claude'
                              ? '粘贴形如 http://localhost:54545/... 的跳转链接或 Claude 授权码'
                              : '粘贴形如 http://localhost:.../oauth-callback?code=... 的完整链接或 code'
                          }
                          value={authCodeInput}
                          onChange={(e) => setAuthCodeInput(e.target.value)}
                        />
                        <button
                          type="button"
                          className="action-btn primary compact"
                          disabled={submittingCode || !authCodeInput.trim()}
                          onClick={handleSubmitAuthCode}
                        >
                          {submittingCode ? <LoaderCircle size={13} className="spin" /> : <Check size={13} />}
                          <span>提交绑定</span>
                        </button>
                      </div>
                      <p className="input-tip-note">
                        提示：当在外部浏览器授权后页面显示「无法访问此网站（localhost）」时，直接复制地址栏的全部内容粘贴到此处即可。
                      </p>
                    </div>
                  </div>
                )}

                {/* 模式 3：直接录入 API Key */}
                {mode === 'apikey' && (
                  <div className="oauth-tab-pane">
                    <div className="input-group-box">
                      <label htmlFor="api-key-input">
                        <strong>{currentProviderConfig?.name} 官方 API Key</strong>
                        <small>直接将已有 API 密钥托管至网关，自动纳管至对应渠道</small>
                      </label>
                      <div className="compact-input-row">
                        <input
                          id="api-key-input"
                          type="password"
                          className="text-input"
                          placeholder={
                            selectedProvider === 'claude'
                              ? 'sk-ant-api03-...'
                              : selectedProvider === 'codex'
                              ? 'sk-...'
                              : '请输入有效的 API Key'
                          }
                          value={apiKeyInput}
                          onChange={(e) => setApiKeyInput(e.target.value)}
                        />
                        <button
                          type="button"
                          className="action-btn primary compact"
                          disabled={submittingApiKey || !apiKeyInput.trim()}
                          onClick={handleSubmitApiKey}
                        >
                          {submittingApiKey ? <LoaderCircle size={13} className="spin" /> : <Check size={13} />}
                          <span>保存接入</span>
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                {errorMessage && (
                  <div className="warning-strip danger compact">
                    <ShieldAlert size={14} />
                    <span>{errorMessage}</span>
                  </div>
                )}

                <div className="modal-actions-bar">
                  <button type="button" className="action-btn secondary" onClick={handleCancel}>
                    返回选择平台
                  </button>
                  <button type="button" className="action-btn secondary" onClick={onClose}>
                    后台等待并关闭
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  )
}
