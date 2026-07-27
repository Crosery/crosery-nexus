import { ArrowRight, KeyRound, ShieldCheck, Sparkles } from 'lucide-react'
import { useState } from 'react'
import { api } from '../api'

export function LoginPage({ onSuccess }: { onSuccess: () => void }) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); setLoading(true); setError('')
    try { await api.login(password); onSuccess() } catch (reason) { setError(reason instanceof Error ? reason.message : '登录失败') } finally { setLoading(false) }
  }
  return <main className="login-page">
    <div className="login-orb orb-one" /><div className="login-orb orb-two" />
    <section className="login-card">
      <div className="brand-mark"><Sparkles size={21} /></div>
      <p className="eyebrow">CROSERY API CONSOLE</p>
      <h1>欢迎回来</h1>
      <p className="login-copy">统一管理访问密钥、调用趋势与账号额度。控制台操作不会在浏览器中暴露 CPA 管理凭据。</p>
      <form onSubmit={submit}>
        <label className="field-label" htmlFor="password">管理密码</label>
        <div className="input-shell"><KeyRound size={18} /><input id="password" autoFocus type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="输入控制台密码" /></div>
        {error && <p className="form-error">{error}</p>}
        <button className="primary-button login-button" disabled={!password || loading}>{loading ? '正在验证' : '进入控制台'}<ArrowRight size={17} /></button>
      </form>
      <div className="login-security"><ShieldCheck size={16} /><span>12 小时安全会话 · HTTPS Only</span></div>
    </section>
  </main>
}
