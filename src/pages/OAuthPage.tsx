import { Check, Copy, ExternalLink, Globe, KeyRound, LoaderCircle, ShieldAlert, Sparkles, Terminal } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import type { OAuthStartResult } from '../types'

type ProviderItem = {
  id: string
  name: string
  label: string
  desc: string
  hint: string
  placeholder: string
  isDeviceFlow?: boolean
}

const PROVIDERS: ProviderItem[] = [
  {
    id: 'codex',
    name: 'OpenAI Codex',
    label: 'OpenAI / Codex',
    desc: '通过 OAuth 流程登录 Codex 服务，自动获取并保存认证文件。',
    hint: '远程服务器模式：在浏览器授权后页面会跳转到 http://localhost:1455/auth/callback?code=...（显示无法访问是正常的），请从地址栏复制完整 URL 或单独提取 code 粘贴提交。',
    placeholder: 'http://localhost:1455/auth/callback?code=...&state=...',
  },
  {
    id: 'claude',
    name: 'Anthropic (Claude)',
    label: 'Claude Pro / Team',
    desc: '通过 OAuth 流程登录 Anthropic (Claude) 服务，自动获取并保存认证文件。',
    hint: '远程服务器模式：在浏览器授权后页面会跳转到 http://localhost:54545/callback?code=...（显示无法访问是正常的），请从地址栏复制完整 URL 或提取 code 粘贴提交。',
    placeholder: 'http://localhost:54545/callback?code=...&state=...',
  },
  {
    id: 'antigravity',
    name: 'Google Antigravity',
    label: 'Google Gemini',
    desc: '通过 OAuth 流程登录 Antigravity（Google 账号）服务，自动获取并保存认证文件。',
    hint: '远程服务器模式：在浏览器授权后页面会跳转到 http://localhost:51121/oauth-callback?code=...，请从地址栏复制完整 URL 粘贴提交。',
    placeholder: 'http://localhost:51121/oauth-callback?code=...&state=...',
  },
  {
    id: 'kimi',
    name: 'Kimi 国内站（kimi.com）',
    label: 'Moonshot Kimi',
    desc: '通过设备授权登录 kimi.com 国内站，自动获取并保存认证文件。国内站与国际站账号不互通。',
    hint: '打开授权链接并在页面中输入设备码确认授权即可，无需手动提交回调。',
    placeholder: '',
    isDeviceFlow: true,
  },
  {
    id: 'kimi-ai',
    name: 'Kimi 国际站（kimi.ai）',
    label: 'Kimi Global',
    desc: '通过设备授权登录 kimi.ai 国际站，自动保存独立的 kimi-ai 认证文件。',
    hint: '打开授权链接并在页面中输入设备码确认授权即可，无需手动提交回调。',
    placeholder: '',
    isDeviceFlow: true,
  },
  {
    id: 'xai',
    name: 'xAI (Grok)',
    label: 'xAI Grok',
    desc: '通过设备授权或 OAuth 流程登录 xAI Grok 服务，自动获取并保存认证文件。',
    hint: '若显示设备码，请在打开的网页中输入确认；若跳转回环地址，可将地址栏完整 URL 粘贴提交。',
    placeholder: 'http://localhost:... 或输入页面 code',
    isDeviceFlow: true,
  },
  {
    id: 'devin',
    name: 'Cognition Devin',
    label: 'Devin AI',
    desc: '通过浏览器 OAuth 登录 Devin / Cognition，自动保存认证文件。请在 5 分钟内完成授权。',
    hint: '远程服务器模式：复制最终的完整 /callback?code=...&state=... URL 粘贴提交。',
    placeholder: 'http://127.0.0.1:8317/callback?code=...&state=...',
  },
  {
    id: 'meta',
    name: 'Meta AI (Muse)',
    label: 'Meta Muse',
    desc: '打开授权链接，如有提示请输入设备码。授权完成后将自动获取并保存认证文件。',
    hint: '打开授权链接并在页面中输入设备码确认授权。',
    placeholder: '',
    isDeviceFlow: true,
  },
]

type SessionState = {
  session: OAuthStartResult | null
  status: 'idle' | 'waiting' | 'success' | 'error'
  error?: string
  callbackUrl: string
  submittingCallback: boolean
  callbackStatus?: 'success' | 'error'
  copiedUrl?: boolean
  copiedCode?: boolean
}

export function OAuthPage({
  onNavigateChannels,
  onNotify,
}: {
  onNavigateChannels: () => void
  onNotify: (message: string) => void
}) {
  const [sessions, setSessions] = useState<Record<string, SessionState>>({})
  const pollTimers = useRef<Record<string, number>>({})

  const clearTimer = (provider: string) => {
    if (pollTimers.current[provider]) {
      window.clearInterval(pollTimers.current[provider])
      delete pollTimers.current[provider]
    }
  }

  useEffect(() => {
    return () => {
      // 清除所有轮询器
      Object.keys(pollTimers.current).forEach((p) => {
        window.clearInterval(pollTimers.current[p])
      })
      pollTimers.current = {}
    }
  }, [])

  const startLogin = async (item: ProviderItem) => {
    clearTimer(item.id)
    setSessions((prev) => ({
      ...prev,
      [item.id]: {
        session: null,
        status: 'waiting',
        callbackUrl: '',
        submittingCallback: false,
      },
    }))

    try {
      const result = await api.startOAuth(item.id)
      setSessions((prev) => ({
        ...prev,
        [item.id]: {
          ...(prev[item.id] || {}),
          session: result,
          status: 'waiting',
          error: undefined,
        },
      }))

      // 启动 2.5 秒一次的状态轮询
      pollTimers.current[item.id] = window.setInterval(async () => {
        try {
          const check = await api.getOAuthStatus(result.state)
          if (check.status === 'ok') {
            clearTimer(item.id)
            setSessions((prev) => ({
              ...prev,
              [item.id]: {
                ...(prev[item.id] || {}),
                status: 'success',
                error: undefined,
              },
            }))
            onNotify(`${item.name} 认证成功！凭证已保存至网关。`)
          } else if (check.status === 'error') {
            clearTimer(item.id)
            setSessions((prev) => ({
              ...prev,
              [item.id]: {
                ...(prev[item.id] || {}),
                status: 'error',
                error: check.error || '认证失败或会话已过期',
              },
            }))
          }
        } catch {
          // 偶发网络抖动忽略
        }
      }, 2500)
    } catch (err) {
      setSessions((prev) => ({
        ...prev,
        [item.id]: {
          session: null,
          status: 'error',
          error: err instanceof Error ? err.message : '发起授权失败',
          callbackUrl: '',
          submittingCallback: false,
        },
      }))
    }
  }

  const submitCallback = async (item: ProviderItem) => {
    const s = sessions[item.id]
    const raw = (s?.callbackUrl || '').trim()
    if (!raw) return
    setSessions((prev) => ({
      ...prev,
      [item.id]: { ...(prev[item.id] || {}), submittingCallback: true },
    }))

    try {
      await api.submitOAuthCallback(item.id, raw, s?.session?.state)
      setSessions((prev) => ({
        ...prev,
        [item.id]: {
          ...(prev[item.id] || {}),
          submittingCallback: false,
          callbackStatus: 'success',
        },
      }))
      onNotify('已提交回调，网关正在向上游验证并换取凭证...')
    } catch (err) {
      setSessions((prev) => ({
        ...prev,
        [item.id]: {
          ...(prev[item.id] || {}),
          submittingCallback: false,
          callbackStatus: 'error',
          error: err instanceof Error ? err.message : '提交回调失败',
        },
      }))
    }
  }

  const cancelLogin = async (item: ProviderItem) => {
    clearTimer(item.id)
    const state = sessions[item.id]?.session?.state
    if (state) {
      api.cancelOAuth(state).catch(() => {})
    }
    setSessions((prev) => ({
      ...prev,
      [item.id]: {
        session: null,
        status: 'idle',
        callbackUrl: '',
        submittingCallback: false,
      },
    }))
  }

  const copyText = async (item: ProviderItem, text: string, type: 'url' | 'code') => {
    try {
      await navigator.clipboard.writeText(text)
      setSessions((prev) => ({
        ...prev,
        [item.id]: {
          ...(prev[item.id] || {}),
          [type === 'url' ? 'copiedUrl' : 'copiedCode']: true,
        },
      }))
      setTimeout(() => {
        setSessions((prev) => ({
          ...prev,
          [item.id]: {
            ...(prev[item.id] || {}),
            [type === 'url' ? 'copiedUrl' : 'copiedCode']: false,
          },
        }))
      }, 1800)
    } catch {}
  }

  return (
    <div className="page-stack oauth-page">
      <section className="page-heading">
        <div>
          <p className="eyebrow">AUTHENTICATION</p>
          <h1>OAuth 授权登录</h1>
          <p>
            通过官方 OAuth 流程或设备码将上游提供商账号连接至小鸡云 CPA，凭据直接由网关安全接管并自动上线模型。
          </p>
        </div>
        <button type="button" className="secondary-button" onClick={onNavigateChannels}>
          <Globe size={16} />
          查看渠道与账号池
        </button>
      </section>

      <section className="panel fill">
        <div className="panel-title">
          <div>
            <h2>AI 提供商登录池</h2>
            <p>支持浏览器授权、回调链接回填与设备码确认；每个账号均可独立配置出口代理与模型开关。</p>
          </div>
          <span className="soft-badge">支持 {PROVIDERS.length} 种认证方式</span>
        </div>

        <div className="oauth-grid scroll-area">
          {PROVIDERS.map((item) => {
            const s = sessions[item.id] || { status: 'idle', callbackUrl: '', submittingCallback: false }
            const isWaiting = s.status === 'waiting'
            const isSuccess = s.status === 'success'
            const isError = s.status === 'error'

            return (
              <div
                className={`oauth-card ${isWaiting ? 'waiting' : ''} ${isSuccess ? 'success' : ''}`}
                key={item.id}
              >
                <div className="oauth-card-header">
                  <div className="header-left">
                    <span className="card-icon">
                      <KeyRound size={16} />
                    </span>
                    <strong>{item.name}</strong>
                  </div>
                  <span className="oauth-tag">{item.label}</span>
                </div>

                <p className="oauth-card-desc">{item.desc}</p>

                {/* 初始状态：显示开始登录按钮 */}
                {s.status === 'idle' && (
                  <div className="oauth-card-foot">
                    <button
                      type="button"
                      className="primary-button tiny"
                      onClick={() => startLogin(item)}
                    >
                      <Sparkles size={13} />
                      <span>开始登录</span>
                    </button>
                  </div>
                )}

                {/* 活跃会话状态（等待中、输入回调、错误重试） */}
                {s.status !== 'idle' && (
                  <div className="oauth-active-box">
                    {/* 状态徽标 */}
                    <div className="active-status-row">
                      {isWaiting && (
                        <div className="status-chip live-wait">
                          <LoaderCircle size={13} className="spin" />
                          <span>等待认证中...</span>
                        </div>
                      )}
                      {isSuccess && (
                        <div className="status-chip success">
                          <Check size={13} />
                          <span>认证成功！</span>
                        </div>
                      )}
                      {isError && (
                        <div className="status-chip danger">
                          <ShieldAlert size={13} />
                          <span>认证失败</span>
                        </div>
                      )}
                    </div>

                    {/* 设备码展示 */}
                    {s.session?.user_code && (
                      <div className="device-code-card">
                        <span className="code-label">设备授权码</span>
                        <div className="code-row">
                          <code className="code-val">{s.session.user_code}</code>
                          <button
                            type="button"
                            className="secondary-button tiny"
                            onClick={() => s.session?.user_code && copyText(item, s.session.user_code, 'code')}
                          >
                            {s.copiedCode ? <Check size={12} /> : <Copy size={12} />}
                            <span>{s.copiedCode ? '已复制' : '复制设备码'}</span>
                          </button>
                        </div>
                      </div>
                    )}

                    {/* 授权链接 */}
                    {s.session?.url && (
                      <div className="auth-url-card">
                        <div className="auth-url-actions">
                          <button
                            type="button"
                            className="primary-button tiny"
                            onClick={() => window.open(s.session?.url, '_blank', 'noopener,noreferrer')}
                          >
                            <ExternalLink size={13} />
                            <span>在浏览器中打开授权</span>
                          </button>
                          <button
                            type="button"
                            className="secondary-button tiny"
                            onClick={() => s.session?.url && copyText(item, s.session.url, 'url')}
                          >
                            {s.copiedUrl ? <Check size={12} /> : <Copy size={12} />}
                            <span>{s.copiedUrl ? '已复制' : '复制链接'}</span>
                          </button>
                        </div>
                      </div>
                    )}

                    {/* 回调 URL / 授权码输入区（对于需要重定向的提供商恒常展开） */}
                    {!item.isDeviceFlow && isWaiting && (
                      <div className="callback-section">
                        <div className="callback-label-row">
                          <strong>回调 URL 或授权码</strong>
                        </div>
                        <p className="callback-hint">{item.hint}</p>
                        <div className="callback-input-row">
                          <input
                            type="text"
                            className="callback-input"
                            placeholder={item.placeholder}
                            value={s.callbackUrl}
                            onChange={(e) =>
                              setSessions((prev) => ({
                                ...prev,
                                [item.id]: { ...(prev[item.id] || {}), callbackUrl: e.target.value },
                              }))
                            }
                          />
                          <button
                            type="button"
                            className="primary-button tiny"
                            disabled={s.submittingCallback || !s.callbackUrl.trim()}
                            onClick={() => submitCallback(item)}
                          >
                            {s.submittingCallback ? <LoaderCircle size={12} className="spin" /> : <Terminal size={12} />}
                            <span>提交回调</span>
                          </button>
                        </div>
                        {s.callbackStatus === 'success' && (
                          <small className="callback-success-text">✓ 回调已提交，请等待网关完成认证...</small>
                        )}
                      </div>
                    )}

                    {/* 错误提示 */}
                    {s.error && (
                      <div className="error-strip">
                        <ShieldAlert size={14} />
                        <span>{s.error}</span>
                      </div>
                    )}

                    {/* 底部按钮 */}
                    <div className="active-card-foot">
                      {isSuccess ? (
                        <>
                          <button type="button" className="primary-button tiny" onClick={onNavigateChannels}>
                            查看渠道账号
                          </button>
                          <button type="button" className="secondary-button tiny" onClick={() => cancelLogin(item)}>
                            登录另一个账号
                          </button>
                        </>
                      ) : (
                        <button type="button" className="secondary-button tiny" onClick={() => cancelLogin(item)}>
                          取消 / 重新开始
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </section>
    </div>
  )
}
