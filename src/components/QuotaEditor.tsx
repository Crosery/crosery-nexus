import { Infinity as InfinityIcon, RotateCcw } from 'lucide-react'
import { useState } from 'react'
import { api } from '../api'
import { ConfirmDialog } from './ConfirmDialog'
import { Modal } from './Modal'
import type { ApiKeyItem, QuotaWindowState } from '../types'

const money = (value: number) => `$${value.toFixed(2)}`

const WINDOW_META = {
  total: { label: '总额度', hint: '累计消耗上限，不会自动刷新' },
  daily: { label: '日额度', hint: '每天服务器本地 00:00 自动刷新' },
  weekly: { label: '周额度', hint: '每周一服务器本地 00:00 自动刷新' },
} as const

const WINDOWS = (Object.entries(WINDOW_META) as Array<[keyof typeof WINDOW_META, typeof WINDOW_META[keyof typeof WINDOW_META]]>)
  .map(([id, meta]) => ({ id, ...meta }))

const formattedReset = (resetsAt: string, timeZone: string) => new Intl.DateTimeFormat('zh-CN', {
  timeZone: timeZone || undefined,
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
}).format(new Date(resetsAt))

const refreshText = (resetsAt: string | null, timeZone: string) => resetsAt
  ? `下次自动刷新：${formattedReset(resetsAt, timeZone)}${timeZone ? `（${timeZone}）` : ''}`
  : '不自动刷新，仅可手动重置'

const shortRefreshText = (resetsAt: string | null, timeZone: string) => resetsAt
  ? `刷新 ${formattedReset(resetsAt, timeZone)}`
  : '手动重置'

export function QuotaBar({ label, state, quotaTimeZone = '' }: { label: string; state: QuotaWindowState; quotaTimeZone?: string }) {
  if (!(state.limitUsd > 0)) return null
  const ratio = Math.min(1, state.ratio ?? 0)
  const tone = state.exceeded ? 'critical' : ratio >= 0.75 ? 'warning' : 'normal'
  return <div className={`quota-mini sev-${tone}`} title={refreshText(state.resetsAt, quotaTimeZone)}>
    <div><span>{label}</span><strong>{money(state.spentUsd)} / {money(state.limitUsd)}</strong></div>
    <div className="quota-mini-track"><span style={{ width: `${ratio * 100}%` }} /></div>
    <small>{shortRefreshText(state.resetsAt, quotaTimeZone)}</small>
  </div>
}

export function QuotaEditor({ item, quotaTimeZone, onClose, onSaved }: { item: ApiKeyItem; quotaTimeZone: string; onClose: () => void; onSaved: () => void }) {
  const [unlimited, setUnlimited] = useState(item.quotaState.unlimited)
  const [values, setValues] = useState({
    total: String(item.quota.totalUsd || ''),
    daily: String(item.quota.dailyUsd || ''),
    weekly: String(item.quota.weeklyUsd || ''),
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [resetting, setResetting] = useState<'total' | 'daily' | 'weekly' | null>(null)

  const save = async () => {
    setBusy(true)
    setError('')
    try {
      await api.updateQuota(item.id, {
        totalUsd: unlimited ? 0 : Number(values.total) || 0,
        dailyUsd: unlimited ? 0 : Number(values.daily) || 0,
        weeklyUsd: unlimited ? 0 : Number(values.weekly) || 0,
      })
      onSaved()
      onClose()
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : '保存失败')
    } finally {
      setBusy(false)
    }
  }

  return <Modal title="额度限制" subtitle={`为「${item.name}」设置消耗上限，超出后自动停用，额度恢复后自动启用。${quotaTimeZone ? ` 日/周按服务器时区 ${quotaTimeZone} 结算。` : ''}`} onClose={onClose}>
    <div className="policy-section">
      <div className="policy-heading">
        <div><h3>不限额</h3><p>关闭全部额度限制，该 Key 不会因消耗被停用。</p></div>
        <button type="button" className={unlimited ? 'switch active' : 'switch'} onClick={() => setUnlimited(!unlimited)} aria-label="切换不限额"><span /></button>
      </div>
      {unlimited ? <div className="unlimited-summary"><InfinityIcon size={15} />不限额</div> : <>
        <div className="policy-divider" />
        <div className="quota-fields">
          {WINDOWS.map((window) => {
            const state = item.quotaState[window.id]
            return <div className="quota-field" key={window.id}>
              <div className="quota-field-head">
                <div><strong>{window.label}</strong><small>{window.hint}</small></div>
                <div className="quota-input"><span>$</span><input
                  type="text"
                  inputMode="decimal"
                  placeholder="不限"
                  value={values[window.id]}
                  onChange={(event) => setValues({ ...values, [window.id]: event.target.value.replace(/[^\d.]/g, '') })}
                /></div>
              </div>
              <div className="quota-field-foot">
                <span>已用 {money(state.spentUsd)}{state.limitUsd > 0 ? ` / ${money(state.limitUsd)}` : ''}</span>
                <span className="quota-refresh-at">{refreshText(state.resetsAt, quotaTimeZone)}</span>
                <button type="button" className="text-button quota-reset-button" onClick={() => setResetting(window.id)}><RotateCcw size={12} />手动重置</button>
              </div>
            </div>
          })}
        </div>
        <p className="help-note">留空或填 0 表示该窗口不限额。日额度每天服务器本地 00:00 自动刷新，周额度每周一服务器本地 00:00 自动刷新；总额度不会自动刷新。三个窗口独立生效，任一超限即停用。</p>
      </>}
    </div>
    {error && <p className="form-error">{error}</p>}
    <footer className="modal-footer"><span />
      <div>
        <button type="button" className="secondary-button" onClick={onClose} disabled={busy}>取消</button>
        <button type="button" className="primary-button" onClick={save} disabled={busy}>{busy ? '保存中…' : '保存'}</button>
      </div>
    </footer>
    {resetting && <ConfirmDialog
      title={`重置${WINDOWS.find((window) => window.id === resetting)?.label}已用`}
      description="该窗口的已用金额归零，此前的消耗不再计入。历史用量统计不受影响。"
      target={item.name}
      confirmLabel="确认重置"
      busyLabel="重置中…"
      onConfirm={async () => {
        await api.resetQuota(item.id, resetting)
        setResetting(null)
        onSaved()
        onClose()
      }}
      onCancel={() => setResetting(null)}
    />}
  </Modal>
}
