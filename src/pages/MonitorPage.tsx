import { Activity, Cloud, Crown, RefreshCw, RotateCcw, ShieldCheck, TriangleAlert, Users } from 'lucide-react'
import { useState } from 'react'
import { api } from '../api'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { ResultDialog } from '../components/ResultDialog'
import type { AccountQuota, MonitorData, QuotaShareWindow, QuotaWindow } from '../types'

const PROVIDERS: Record<string, { label: string; logo: string; className: string }> = {
  claude: { label: 'Claude', logo: 'AI', className: 'claude' },
  codex: { label: 'Codex', logo: 'O', className: 'codex' },
  antigravity: { label: 'AntiGravity', logo: 'AG', className: 'antigravity' },
}

const PROVIDER_ORDER = ['antigravity', 'claude', 'codex']

const expiryClock = (value: string) => {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

/** 剩余时间用「还有 2 天 3 小时」这种粗粒度描述，比精确到分钟更符合看额度的场景。 */
function untilReset(resetsAt: string | null): string {
  if (!resetsAt) return ''
  const target = new Date(resetsAt).getTime()
  if (Number.isNaN(target)) return ''
  const minutes = Math.round((target - Date.now()) / 60000)
  if (minutes <= 0) return '即将重置'
  if (minutes < 60) return `还有 ${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `还有 ${hours} 小时${minutes % 60 ? ` ${minutes % 60} 分钟` : ''}`
  const days = Math.floor(hours / 24)
  return `还有 ${days} 天${hours % 24 ? ` ${hours % 24} 小时` : ''}`
}

const resetClock = (resetsAt: string | null) => {
  if (!resetsAt) return ''
  const date = new Date(resetsAt)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

const compactTokens = (value: number) => {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return value.toLocaleString('zh-CN')
}

const windowStartClock = (windowStart: number) => {
  const date = new Date(windowStart)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

/**
 * 「本窗口各 Key 消耗占比」。套餐额度不按美元计量、缓存读同样吃额度，
 * 所以这里只按 token 体量（输入 + 缓存 + 输出）算相对占比，回答「额度被谁用掉了」。
 */
function QuotaShareList({ share }: { share: QuotaShareWindow | undefined | null }) {
  if (!share) return null
  const since = windowStartClock(share.windowStart)
  const rows = share.keys.slice(0, 12)
  const rest = share.keys.length - rows.length
  return <section className="quota-share" aria-label="本窗口各 Key 消耗占比">
    <div className="quota-share-head">
      <h3><Users size={13} /> 本窗口各 Key 消耗占比</h3>
      <span>{since ? `自 ${since} 起` : ''} · 按 token 体量（输入 + 缓存 + 输出）</span>
    </div>
    {rows.length === 0
      ? <p className="quota-share-empty">本窗口内还没有成功请求</p>
      : <div className="quota-share-list">
        {rows.map((key, index) => <div className={index === 0 ? 'quota-share-row top' : 'quota-share-row'} key={key.keyId || key.keyName}>
          <strong title={`${key.requests.toLocaleString('zh-CN')} 次请求 · 提示 ${compactTokens(key.promptTokens)} · 输出 ${compactTokens(key.outputTokens)}`}>{key.keyName}</strong>
          <div className="progress-track"><span style={{ width: `${Math.max(1, Math.round(key.share * 100))}%` }} /></div>
          <em>{(key.share * 100).toFixed(1)}%</em>
        </div>)}
        {rest > 0 && <p className="quota-share-empty">还有 {rest} 个 Key 占比更低，未展开</p>}
      </div>}
  </section>
}

function QuotaRow({ window }: { window: QuotaWindow }) {
  const remaining = Math.max(0, 100 - window.usedPercent)
  const clock = resetClock(window.resetsAt)
  const countdown = untilReset(window.resetsAt)
  return <div className={`quota-row sev-${window.severity}`}>
    <div className="quota-head">
      <strong>{window.label}</strong>
      <div className="quota-value"><strong>{Math.round(remaining)}%</strong><span>剩余</span></div>
    </div>
    <div className="progress-track"><span style={{ width: `${remaining}%` }} /></div>
    <div className="quota-foot">
      {clock ? <span className="reset-at" title={new Date(window.resetsAt as string).toLocaleString('zh-CN')}>{clock} 重置</span> : <span className="reset-at muted">滚动窗口</span>}
      {countdown && <span className="reset-countdown">{countdown}</span>}
    </div>
  </div>
}

function AccountCard({ account, onRefresh }: { account: Record<string, any>; onRefresh: () => void }) {
  const [confirming, setConfirming] = useState(false)
  const [resetting, setResetting] = useState(false)
  const [result, setResult] = useState<{ tone: 'success' | 'error'; title: string; description?: string; detail?: string } | null>(null)
  const provider = PROVIDERS[String(account.type)] || { label: String(account.type || '未知渠道'), logo: '?', className: 'unknown' }
  const accountName = String(account.email || account.name || account.auth_index)

  // Claude 的 banked reset 与 Codex 的主动重置是同一套交互，仅端点与文案按渠道切换。
  const resetProvider = account.type === 'claude' ? 'claude' : account.type === 'codex' ? 'codex' : null
  const resetLabel = resetProvider === 'claude' ? 'Claude' : 'Codex'

  const runReset = async () => {
    setResetting(true)
    try {
      const outcome = resetProvider === 'claude'
        ? await api.resetClaudeQuota(String(account.auth_index))
        : await api.resetCodexQuota(String(account.auth_index))
      setConfirming(false)
      setResult(outcome.cooldownCleared
        ? { tone: 'success', title: '重置成功', description: `已重置「${accountName}」的 ${resetLabel} 额度并清除网关侧冷却，消耗 1 次主动重置次数。` }
        : { tone: 'error', title: '额度已重置，但网关冷却未清除', description: `「${accountName}」的额度已在上游重置，但网关本地冷却清除失败，请求可能仍被挡到原重置时间点；请稍后重试或重启 cli-proxy-api。` })
      onRefresh()
    } catch (error) {
      setConfirming(false)
      setResult({
        tone: 'error',
        title: '重置失败',
        description: `「${accountName}」的 ${resetLabel} 额度未被重置，主动重置次数未消耗。`,
        detail: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setResetting(false)
    }
  }
  const quota: AccountQuota = account.normalizedQuota || { plan: '', tier: '', resetCredits: null, windows: [], error: null }
  const worst = quota.windows.reduce<QuotaWindow | null>(
    (peak, window) => (!peak || window.usedPercent > peak.usedPercent ? window : peak),
    null,
  )
  return <article className={`account-card ${provider.className}`}>
    <header>
      <div className="account-logo">{provider.logo}</div>
      <div><span className="provider-name">{provider.label}</span><h2>{account.email || account.account || account.name}</h2></div>
      <span className={account.disabled ? 'status-chip' : 'status-chip success'}>{account.disabled ? '已停用' : '运行中'}</span>
    </header>
    <div className="account-meta">
      <span><ShieldCheck size={15} />OAuth 已连接</span>
      <span><Activity size={15} />{String(account.status || 'ready')}</span>
      {quota.plan && <span className="plan-chip">{quota.plan}</span>}
      {quota.tier && <span className="tier-chip"><Crown size={12} />{quota.tier}</span>}
      {worst && worst.severity !== 'normal' && <span className={`sev-chip ${worst.severity}`}><TriangleAlert size={13} />{worst.severity === 'critical' ? '额度紧张' : '接近上限'}</span>}
    </div>
    {quota.resetCredits && <div className="reset-credits">
      <div className="reset-credits-head">
        <RotateCcw size={14} />
        <span>主动重置次数 <strong>{quota.resetCredits.available}</strong></span>
        <button
          className="secondary-button tiny"
          disabled={resetting || quota.resetCredits.available <= 0}
          onClick={() => setConfirming(true)}
        ><RotateCcw size={13} className={resetting ? 'spin' : ''} />{resetting ? '重置中' : '重置额度'}</button>
      </div>
      {quota.resetCredits.entries.length > 0 && <div className="reset-credit-list">
        {quota.resetCredits.entries.map((entry, index) => <div key={entry.id || index}>
          <span>第 {index + 1} 次</span><strong>{expiryClock(entry.expiresAt)} 过期</strong>
        </div>)}
      </div>}
    </div>}
    <div className="quota-stack">{quota.windows.map((window) => <QuotaRow key={window.id} window={window} />)}</div>
    {quota.error && <p className="quota-error"><TriangleAlert size={14} />{quota.error}</p>}
    {!quota.error && !quota.windows.length && <p className="quota-empty">上游未返回额度窗口</p>}
    {confirming && resetProvider && <ConfirmDialog
      title={`重置 ${resetLabel} 额度`}
      description={<>将消耗 <strong>1 次</strong>主动重置次数来重置该账号的 {resetLabel} 额度。此操作不可撤销。</>}
      target={accountName}
      confirmLabel="确认重置"
      busyLabel="重置中…"
      busy={resetting}
      onConfirm={runReset}
      onCancel={() => setConfirming(false)}
    />}
    {result && <ResultDialog {...result} onClose={() => setResult(null)} />}
  </article>
}

export function MonitorPage({ data, loading, onRefresh }: { data: MonitorData | null; loading: boolean; onRefresh: () => void }) {
  const accounts = data?.accounts || []
  const quotaShare = data?.quotaShare || null
  const groups = PROVIDER_ORDER
    .map((type) => ({ type, accounts: accounts.filter((account) => account.type === type) }))
    .filter((group) => group.accounts.length > 0)

  return <div className="page-stack">
    <section className="page-heading">
      <div><p className="eyebrow">UPSTREAM ACCOUNTS</p><h1>账号监控</h1><p>按渠道查看 AntiGravity、Claude 与 Codex OAuth 账号状态和额度重置时间。</p></div>
      <button className="secondary-button" onClick={onRefresh} disabled={loading}><RefreshCw size={16} className={loading ? 'spin' : ''} />刷新状态</button>
    </section>
    {groups.length > 0 && <section className="monitor-groups scroll-area fill" aria-label="上游账号分组">
      {groups.map((group) => <section className="monitor-provider-group" key={group.type} aria-labelledby={`monitor-group-${group.type}`}>
        <header className="monitor-group-head">
          <div><span className={`provider-orb ${group.type}`} /><h2 id={`monitor-group-${group.type}`}>{PROVIDERS[group.type].label}</h2></div>
          <span>{group.accounts.length} 个账号</span>
        </header>
        <div className="monitor-grid">{group.accounts.map((account) => <AccountCard key={String(account.id || account.auth_index || account.name)} account={account} onRefresh={onRefresh} />)}</div>
        <QuotaShareList share={quotaShare?.[group.type as 'codex' | 'claude' | 'antigravity']} />
      </section>)}
    </section>}
    {!accounts.length && <section className="panel empty-state"><Cloud size={30} /><h3>暂未读取到账号</h3><p>确认 CPA 中已导入 AntiGravity、Claude 或 Codex OAuth 凭据。</p></section>}
  </div>
}
