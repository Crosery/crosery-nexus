import { Check, ChevronRight, Copy, ExternalLink, KeyRound, LoaderCircle, ShieldAlert, Sparkles } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import type { OAuthStartResult } from '../types'
import { Modal } from './Modal'

type ProviderOption = {
  id: string
  name: string
  label: string
  desc: string
  badge?: string
}

const PROVIDERS: ProviderOption[] = [
  { id: 'codex', name: 'OpenAI Codex', label: 'Codex / ChatGPT', desc: '登录 OpenAI / ChatGPT 账号，获取 Codex 模型调用权限' },
  { id: 'claude', name: 'Claude', label: 'Claude / Anthropic', desc: '登录 Claude Pro / Team / Enterprise 账号' },
  { id: 'antigravity', name: 'Google Antigravity', label: 'Google', desc: '登录 Google 账号，接入 Gemini / Antigravity 渠道' },
  { id: 'kimi', name: 'Kimi', label: 'Moonshot Kimi', desc: '通过设备码授权登录 Kimi Code 账号' },
  { id: 'xai', name: 'xAI Grok', label: 'xAI', desc: '通过设备码授权登录 xAI / Grok 账号' },
  { id: 'devin', name: 'Devin', label: 'Cognition Devin', desc: '登录 Devin AI 平台账号' },
  { id: 'meta', name: 'Meta AI', label: 'Meta', desc: '登录 Meta 账号' },
]

export function OAuthLoginDialog({
  onClose,
  onSuccess,
}: {
  onClose: () => void
  onSuccess: (provider: string) => Promise<void>
}) {
  const [selectedProvider, setSelectedProvider] = useState<string>('codex')
  const [starting, setStarting] = useState(false)
  const [session, setSession] = useState<OAuthStartResult | null>(null)
  const [status, setStatus] = useState<'idle' | 'waiting' | 'success' | 'error'>('idle')
  const [errorMessage, setErrorMessage] = useState('')
  const [copiedCode, setCopiedCode] = useState(false)
  const [copiedUrl, setCopiedUrl] = useState(false)
  const [showManualCallback, setShowManualCallback] = useState(false)
  const [callbackUrl, setCallbackUrl] = useState('')
  const [submittingCallback, setSubmittingCallback] = useState(false)

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

  const handleStart = async (providerId: string) => {
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
            setTimeout(() => {
              onClose()
            }, 1600)
          } else if (check.status === 'error') {
            stopPolling()
            setStatus('error')
            setErrorMessage(check.error || '授权失败或会话已过期')
          }
        } catch (err) {
          // 轮询中的偶发网络错误不直接中断，除非返回 4xx
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
    } catch {
      // 剪贴板不可用时忽略
    }
  }

  const handleOpenAuthUrl = () => {
    if (!session?.url) return
    if (session.user_code) {
      handleCopy(session.user_code, 'code')
    }
    window.open(session.url, '_blank', 'noopener,noreferrer')
  }

  const handleSubmitManualCallback = async () => {
    if (!session || !callbackUrl.trim()) return
    setSubmittingCallback(true)
    setErrorMessage('')
    try {
      await api.submitOAuthCallback(session.provider, callbackUrl.trim())
      stopPolling()
      setStatus('success')
      await onSuccess(session.provider)
      setTimeout(() => {
        onClose()
      }, 1600)
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : '提交回调失败')
    } finally {
      setSubmittingCallback(false)
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
    setShowManualCallback(false)
    setCallbackUrl('')
  }

  return (
    <Modal
      title="CPA 账号授权登录"
      subtitle="通过官方 OAuth / Device Code 授权连接 AI 提供商账号，凭证直接由网关安全接管"
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
                        <KeyRound size={18} />
                      </span>
                      <strong>{provider.name}</strong>
                    </div>
                    <p>{provider.desc}</p>
                    <div className="oauth-provider-card-foot">
                      <span className="oauth-provider-tag">{provider.label}</span>
                      <ChevronRight size={16} />
                    </div>
                  </button>
                )
              })}
            </div>
            <div className="modal-actions">
              <button type="button" className="secondary-button" onClick={onClose}>
                取消
              </button>
              <button
                type="button"
                className="primary-button"
                disabled={starting}
                onClick={() => handleStart(selectedProvider)}
              >
                {starting ? <LoaderCircle size={16} className="spin" /> : <Sparkles size={16} />}
                {starting ? '正在初始化授权...' : '下一步：发起登录'}
              </button>
            </div>
          </div>
        ) : (
          <div className="oauth-session-view">
            {status === 'success' ? (
              <div className="oauth-success-banner">
                <div className="success-icon-wrap">
                  <Check size={36} />
                </div>
                <h3>账号授权成功！</h3>
                <p>网关已获取并妥善保存访问凭据，正在同步渠道模型与可用配额...</p>
              </div>
            ) : (
              <div className="oauth-pending-view">
                <div className="oauth-session-header">
                  <span className="oauth-active-provider-badge">
                    {PROVIDERS.find((p) => p.id === session?.provider)?.name || session?.provider}
                  </span>
                  <span className="status-chip success">会话已就绪</span>
                </div>

                {session?.user_code && (
                  <div className="oauth-device-code-box">
                    <span className="device-code-label">设备授权码（User Code）</span>
                    <div className="device-code-row">
                      <strong className="device-code-val">{session.user_code}</strong>
                      <button
                        type="button"
                        className="secondary-button tiny"
                        onClick={() => session.user_code && handleCopy(session.user_code, 'code')}
                      >
                        {copiedCode ? <Check size={14} /> : <Copy size={14} />}
                        {copiedCode ? '已复制' : '复制验证码'}
                      </button>
                    </div>
                    <p className="device-code-hint">在打开的授权网页中输入此验证码以确认绑定</p>
                  </div>
                )}

                <div className="oauth-action-box">
                  <p>请点击下方按钮在浏览器中打开授权链接完成账号登录：</p>
                  <div className="oauth-link-buttons">
                    <button
                      type="button"
                      className="primary-button oauth-open-btn"
                      onClick={handleOpenAuthUrl}
                    >
                      <ExternalLink size={16} />
                      在浏览器中打开授权页面
                    </button>
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => session?.url && handleCopy(session.url, 'url')}
                    >
                      {copiedUrl ? <Check size={14} /> : <Copy size={14} />}
                      {copiedUrl ? '已复制链接' : '复制授权链接'}
                    </button>
                  </div>
                </div>

                <div className="oauth-polling-status">
                  <LoaderCircle size={18} className="spin" />
                  <span>正在等待浏览器端完成授权（每 2 秒检测一次状态）...</span>
                </div>

                {errorMessage && (
                  <div className="warning-strip danger">
                    <ShieldAlert size={16} />
                    <span>{errorMessage}</span>
                  </div>
                )}

                <div className="oauth-manual-toggle">
                  <button
                    type="button"
                    className="link-button"
                    onClick={() => setShowManualCallback(!showManualCallback)}
                  >
                    {showManualCallback ? '收起手动提交' : '回调遇到网络问题？手动粘贴回调 URL'}
                  </button>
                </div>

                {showManualCallback && (
                  <div className="oauth-manual-callback-box">
                    <label htmlFor="callback-url-input">浏览器授权跳转后的完整 URL：</label>
                    <div className="manual-callback-row">
                      <input
                        id="callback-url-input"
                        type="text"
                        placeholder="http://localhost:.../v0/management/oauth-callback?code=...&state=..."
                        value={callbackUrl}
                        onChange={(e) => setCallbackUrl(e.target.value)}
                      />
                      <button
                        type="button"
                        className="primary-button"
                        disabled={submittingCallback || !callbackUrl.trim()}
                        onClick={handleSubmitManualCallback}
                      >
                        {submittingCallback ? <LoaderCircle size={14} className="spin" /> : '完成授权'}
                      </button>
                    </div>
                  </div>
                )}

                <div className="modal-actions">
                  <button type="button" className="secondary-button" onClick={handleCancel}>
                    返回重新选择
                  </button>
                  <button type="button" className="secondary-button" onClick={onClose}>
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
